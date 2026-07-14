import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    TIMELINE_AUDIO_MAX_QUEUED_BLOCKS,
    TIMELINE_AUDIO_WORKLET_PROCESSOR,
    TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
} from './timeline-audio-worklet';

interface ArtifactProcessor {
    port: {
        onmessage: ((event: { data: Record<string, unknown> }) => void) | null;
        postMessage: ReturnType<typeof vi.fn>;
    };
    blocks: Array<{ startSample: number; left: Float32Array; right: Float32Array }>;
    process(inputs: unknown[], outputs: Float32Array[][]): boolean;
}

function loadDeployedProcessor(): { processor: ArtifactProcessor; source: string } {
    const source = readFileSync(
        new URL('../../public/worklets/timeline-audio-worklet.js', import.meta.url),
        'utf8',
    );
    let Processor: (new () => ArtifactProcessor) | null = null;
    class AudioWorkletProcessorStub {
        port = { onmessage: null, postMessage: vi.fn() };
    }
    runInNewContext(source, {
        AudioWorkletProcessor: AudioWorkletProcessorStub,
        Float32Array,
        Number,
        Math,
        sampleRate: 48_000,
        registerProcessor: (name: string, implementation: new () => ArtifactProcessor) => {
            expect(name).toBe(TIMELINE_AUDIO_WORKLET_PROCESSOR);
            Processor = implementation;
        },
    });
    if (!Processor) throw new Error('The deployed worklet did not register its processor.');
    const RegisteredProcessor = Processor as unknown as new () => ArtifactProcessor;
    return { processor: new RegisteredProcessor(), source };
}

function message(
    processor: ArtifactProcessor,
    data: Record<string, unknown>,
): void {
    processor.port.onmessage?.({ data: {
        version: TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
        generation: 1,
        ...data,
    } });
}

describe('deployed timeline AudioWorklet artifact', () => {
    it('executes the exact public artifact with a bounded queue and allocation-free hot-loop shape', () => {
        const { processor, source } = loadDeployedProcessor();
        message(processor, { type: 'reset', outputSample: 0, contentEndSample: 100 });
        for (let index = 0; index < TIMELINE_AUDIO_MAX_QUEUED_BLOCKS + 4; index += 1) {
            message(processor, {
                type: 'queue',
                startSample: index,
                left: Float32Array.of(index),
                right: Float32Array.of(-index),
            });
        }

        expect(processor.blocks).toHaveLength(TIMELINE_AUDIO_MAX_QUEUED_BLOCKS);
        expect(source).not.toContain('this.blocks.filter(');
        expect(source).not.toContain('return [block.left');
    });

    it('emits no clocks while paused and acknowledges before the context can be suspended', () => {
        const { processor } = loadDeployedProcessor();
        message(processor, { type: 'reset', outputSample: 0, contentEndSample: 8 });
        message(processor, { type: 'pause', requestId: 7 });
        processor.process([], [[new Float32Array(128), new Float32Array(128)]]);

        expect(processor.port.postMessage).toHaveBeenCalledTimes(1);
        expect(processor.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'paused', outputSample: 0, requestId: 7,
        }));
    });

    it('publishes ended at the exact content boundary without a false terminal underrun', () => {
        const { processor } = loadDeployedProcessor();
        message(processor, { type: 'reset', outputSample: 0, contentEndSample: 2 });
        message(processor, {
            type: 'queue', startSample: 0,
            left: Float32Array.of(0.25, 0.5), right: Float32Array.of(-0.25, -0.5),
        });
        message(processor, { type: 'play' });
        const left = new Float32Array(128);
        const right = new Float32Array(128);
        processor.process([], [[left, right]]);

        const events = processor.port.postMessage.mock.calls.map(([event]) => event);
        expect(Array.from(left.slice(0, 2))).toEqual([0.25, 0.5]);
        expect(events).toContainEqual(expect.objectContaining({ type: 'ended', outputSample: 2 }));
        expect(events).not.toContainEqual(expect.objectContaining({ type: 'underrun' }));
    });

    it('publishes an active clock frequently enough to drive smooth video frames', () => {
        const { processor } = loadDeployedProcessor();
        const samples = new Float32Array(2_000);
        message(processor, { type: 'reset', outputSample: 0, contentEndSample: samples.length });
        message(processor, {
            type: 'queue', startSample: 0, left: samples, right: samples.slice(),
        });
        message(processor, { type: 'play' });
        for (let quantum = 0; quantum < 8; quantum += 1) {
            processor.process([], [[new Float32Array(128), new Float32Array(128)]]);
        }

        const clockEvents = processor.port.postMessage.mock.calls
            .map(([event]) => event)
            .filter((event) => event.type === 'clock');
        expect(clockEvents).toHaveLength(2);
    });

    it('trims a shortened tail so re-expansion restores one contiguous non-duplicated queue', () => {
        const { processor } = loadDeployedProcessor();
        message(processor, { type: 'reset', outputSample: 0, contentEndSample: 48_000 });
        for (let startSample = 0; startSample < 48_000; startSample += 4_096) {
            const length = Math.min(4_096, 48_000 - startSample);
            message(processor, {
                type: 'queue', startSample,
                left: new Float32Array(length), right: new Float32Array(length),
            });
        }

        message(processor, { type: 'set-content-end', contentEndSample: 8_000 });
        expect(processor.blocks.map((block) => [block.startSample, block.left.length]))
            .toEqual([[0, 4_096], [4_096, 3_904]]);

        message(processor, { type: 'set-content-end', contentEndSample: 48_000 });
        for (let startSample = 8_000; startSample < 48_000; startSample += 4_096) {
            const length = Math.min(4_096, 48_000 - startSample);
            message(processor, {
                type: 'queue', startSample,
                left: new Float32Array(length), right: new Float32Array(length),
            });
        }
        let coverageCursor = 0;
        processor.blocks.forEach((block) => {
            expect(block.startSample).toBe(coverageCursor);
            coverageCursor += block.left.length;
        });
        expect(coverageCursor).toBe(48_000);

        message(processor, { type: 'play' });
        for (let quantum = 0; quantum < 375; quantum += 1) {
            processor.process([], [[new Float32Array(128), new Float32Array(128)]]);
        }
        const events = processor.port.postMessage.mock.calls.map(([event]) => event);
        expect(events).toContainEqual(expect.objectContaining({ type: 'ended', outputSample: 48_000 }));
        expect(events).not.toContainEqual(expect.objectContaining({ type: 'underrun' }));
    });
});
