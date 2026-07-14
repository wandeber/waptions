import { describe, expect, it, vi } from 'vitest';
import type { AudioSample } from 'mediabunny';
import type { EditorDocumentV3 } from '@/types/video';
import { buildAudioMixPlan } from './audio-mix-plan';
import { renderAudioMixWindow } from './audio-dsp';
import {
    TimelineAudioRenderer,
    type TimelineAudioDecoder,
} from './timeline-audio-renderer';

const fakeFile = {} as File;

function makeDocument(sampleCount = 10, linked = true): EditorDocumentV3 {
    return {
        version: 3,
        revision: 1,
        audioGraphRevision: 1,
        renderProfile: {
            fps: { numerator: 48_000, denominator: 1 },
            width: 16,
            height: 16,
            audioSampleRate: 48_000,
            isFrameRateLocked: true,
            isCanvasSizeLocked: true,
        },
        subtitleTracks: [],
        videoSources: [{
            id: 'video', originalName: 'video.mp4', mimeType: 'video/mp4', size: 1,
            lastModified: 1, fingerprint: 'video-fingerprint', duration: 1, fps: 30,
            width: 16, height: 16, bitrate: 1_000_000, hasAudio: true, file: fakeFile,
        }],
        videoClips: [{
            id: 'clip', sourceId: 'video', sourceStart: 0, sourceEnd: sampleCount / 48_000,
            audio: {
                linkState: linked ? 'linked' : 'detached',
                muted: false,
                gainDb: 0,
                fadeInFrames: 0,
                fadeOutFrames: 0,
            },
        }],
        audioSources: [],
        audioTracks: [],
        activeSubtitleTrackId: null,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
    };
}

function makeDecoder(values: Float32Array) {
    const decoder: TimelineAudioDecoder = {
        setDocument: vi.fn(),
        decode: vi.fn(async () => ({
            sampleRate: 48_000,
            startSample: 0,
            channels: [values, values],
        })),
        dispose: vi.fn(),
    };
    return decoder;
}

function makeCollectingSource() {
    const heldSamples: AudioSample[] = [];
    const chunks: Array<{ timestamp: number; left: Float32Array; right: Float32Array }> = [];
    return {
        heldSamples,
        chunks,
        source: {
            add: vi.fn(async (sample: AudioSample) => {
                heldSamples.push(sample);
                const left = new Float32Array(sample.numberOfFrames);
                const right = new Float32Array(sample.numberOfFrames);
                sample.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
                sample.copyTo(right, { planeIndex: 1, format: 'f32-planar' });
                chunks.push({ timestamp: sample.timestamp, left, right });
            }),
        },
    };
}

function flatten(chunks: readonly Float32Array[]): Float32Array {
    const result = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let cursor = 0;
    chunks.forEach((chunk) => {
        result.set(chunk, cursor);
        cursor += chunk.length;
    });
    return result;
}

describe('TimelineAudioRenderer', () => {
    it('matches the runtime DSP sample-for-sample and emits an exact final partial window', async () => {
        const document = makeDocument();
        const values = Float32Array.from({ length: 10 }, (_, index) => (index + 1) / 20);
        const runtime = await renderAudioMixWindow(
            buildAudioMixPlan(document),
            async () => ({ sampleRate: 48_000, startSample: 0, channels: [values, values] }),
            { startSample: 0, endSample: 10 },
        );
        const decoder = makeDecoder(values);
        const output = makeCollectingSource();

        await new TimelineAudioRenderer(document, output.source, {
            createDecoder: () => decoder,
        }).render({ outputEndSample: 10, windowSampleCount: 4 });

        expect(output.chunks.map((chunk) => chunk.left.length)).toEqual([4, 4, 2]);
        expect(output.chunks.map((chunk) => chunk.timestamp)).toEqual([0, 4 / 48_000, 8 / 48_000]);
        expect(flatten(output.chunks.map((chunk) => chunk.left))).toEqual(runtime.channels[0]);
        expect(flatten(output.chunks.map((chunk) => chunk.right))).toEqual(runtime.channels[1]);
        expect(decoder.dispose).toHaveBeenCalledTimes(1);
        output.heldSamples.forEach((sample) => {
            expect(() => sample.copyTo(new Float32Array(1), {
                planeIndex: 0,
                format: 'f32-planar',
                frameCount: 1,
            })).toThrow();
        });
    });

    it('pads a content tail with exact silence and emits silence when there are no contributors', async () => {
        const document = makeDocument(3);
        const values = new Float32Array([0.25, 0.5, 0.75]);
        const decoder = makeDecoder(values);
        const output = makeCollectingSource();
        await new TimelineAudioRenderer(document, output.source, {
            createDecoder: () => decoder,
        }).render({ outputEndSample: 7, windowSampleCount: 4 });

        expect(flatten(output.chunks.map((chunk) => chunk.left))).toEqual(new Float32Array([
            0.25, 0.5, 0.75, 0, 0, 0, 0,
        ]));

        const silentDocument = makeDocument(5, false);
        const silentDecoder = makeDecoder(values);
        const silentOutput = makeCollectingSource();
        await new TimelineAudioRenderer(silentDocument, silentOutput.source, {
            createDecoder: () => silentDecoder,
        }).render({ outputEndSample: 5, windowSampleCount: 3 });
        expect(flatten(silentOutput.chunks.map((chunk) => chunk.left))).toEqual(new Float32Array(5));
        expect(silentDecoder.decode).not.toHaveBeenCalled();
    });

    it('disposes decoding and rejects a rendered stale window before emitting it on cancellation', async () => {
        const document = makeDocument(4);
        const decoder = makeDecoder(new Float32Array([0.1, 0.2, 0.3, 0.4]));
        const output = makeCollectingSource();
        let cancelled = false;
        const renderer = new TimelineAudioRenderer(document, output.source, {
            createDecoder: () => decoder,
            renderWindow: async (...args) => {
                const rendered = await renderAudioMixWindow(...args);
                cancelled = true;
                return rendered;
            },
        });

        await expect(renderer.render({
            outputEndSample: 4,
            shouldCancel: () => cancelled,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(output.source.add).not.toHaveBeenCalled();
        expect(decoder.dispose).toHaveBeenCalledTimes(1);
    });

    it('closes the current sample and decoder when the encoder rejects a window', async () => {
        const document = makeDocument(2);
        const decoder = makeDecoder(new Float32Array([0.25, 0.5]));
        let heldSample: AudioSample | null = null;
        const source = {
            add: vi.fn(async (sample: AudioSample) => {
                heldSample = sample;
                throw new Error('encoder failed');
            }),
        };
        const renderer = new TimelineAudioRenderer(document, source, {
            createDecoder: () => decoder,
        });

        await expect(renderer.render({ outputEndSample: 2 })).rejects.toThrow('encoder failed');
        expect(decoder.dispose).toHaveBeenCalledTimes(1);
        expect(heldSample).not.toBeNull();
        expect(() => heldSample!.copyTo(new Float32Array(1), {
            planeIndex: 0,
            format: 'f32-planar',
            frameCount: 1,
        })).toThrow();
    });
});
