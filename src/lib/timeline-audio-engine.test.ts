import { describe, expect, it, vi } from 'vitest';
import { BrowserTimelineAudioEngine } from './timeline-audio-engine';
import { TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION } from './timeline-audio-worklet';
import type { TimelineAudioEngineSnapshot } from '@/types/timeline-audio-engine';
import type { EditorDocumentV3 } from '@/types/video';

function makeDocument(): EditorDocumentV3 {
    return {
        version: 3,
        revision: 1,
        audioGraphRevision: 1,
        renderProfile: {
            fps: { numerator: 30, denominator: 1 }, width: 1920, height: 1080,
            audioSampleRate: 48_000, isFrameRateLocked: true, isCanvasSizeLocked: true,
        },
        subtitleTracks: [], videoSources: [], videoClips: [], audioSources: [], audioTracks: [],
        activeSubtitleTrackId: null, transientSelection: { kind: 'none' }, transcriptionByTrackId: {},
    };
}

function makeSnapshot(revision = 1): TimelineAudioEngineSnapshot {
    const document = makeDocument();
    document.revision = revision;
    document.audioGraphRevision = revision;
    return {
        documentRevision: revision,
        audioGraphRevision: revision,
        document,
        contentEndSample: 8,
        mixPlan: {
            sampleRate: 48_000,
            totalSampleCount: 8,
            videoSampleCount: 8,
            contributors: [{
                id: 'embedded-video:clip', kind: 'embedded-video', trackId: null,
                source: { kind: 'video-source-audio', videoSourceId: 'video' },
                outputStartSample: 0, outputEndSample: 8,
                sourceRange: { domain: 'seconds', startSeconds: 0, endSeconds: 8 / 48_000 },
                fadeInSamples: 0, fadeOutSamples: 0, gainLinear: 1,
            }],
        },
    };
}

function createHarness() {
    const messages: Array<Record<string, unknown>> = [];
    const port = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: vi.fn((message: unknown) => {
            messages.push(message as Record<string, unknown>);
        }),
    };
    const node = {
        port,
        connect: vi.fn(),
        disconnect: vi.fn(),
    };
    const gain = {
        gain: { value: 1 },
        connect: vi.fn(),
        disconnect: vi.fn(),
    };
    const context = {
        state: 'suspended',
        destination: {},
        audioWorklet: { addModule: vi.fn(async () => undefined) },
        createGain: vi.fn(() => gain),
        resume: vi.fn(async () => { context.state = 'running'; }),
        close: vi.fn(async () => { context.state = 'closed'; }),
    };
    const decoder = {
        setDocument: vi.fn(),
        decode: vi.fn(async (_contributor, request) => ({
            sampleRate: 48_000,
            startSample: 0,
            channels: [new Float32Array(request.outputEndSample), new Float32Array(request.outputEndSample)],
        })),
        dispose: vi.fn(),
    };
    const callbacks = {
        onClock: vi.fn(),
        onUnderrun: vi.fn(),
        onError: vi.fn(),
    };
    const engine = new BrowserTimelineAudioEngine(callbacks, {
        createAudioContext: () => context,
        createWorkletNode: () => node,
        createDecoder: () => decoder,
        origin: () => 'https://waptions.example',
    });
    return { engine, messages, port, node, gain, context, decoder, callbacks };
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe('BrowserTimelineAudioEngine', () => {
    it('creates Web Audio only on play and sends 0.1x, 1x, and 2x rate messages', async () => {
        const harness = createHarness();
        harness.engine.setSnapshot(makeSnapshot());
        harness.engine.setPlaybackRate(0.1);
        expect(harness.context.audioWorklet.addModule).not.toHaveBeenCalled();
        await harness.engine.play();
        harness.engine.setPlaybackRate(1);
        harness.engine.setPlaybackRate(2);

        expect(harness.context.audioWorklet.addModule).toHaveBeenCalledWith(
            'https://waptions.example/worklets/timeline-audio-worklet.js?v=2',
        );
        expect(harness.messages.filter((message) => message.type === 'set-rate')
            .map((message) => message.playbackRate)).toEqual([0.1, 1, 2]);
        expect(harness.messages.some((message) => message.type === 'queue')).toBe(true);
    });

    it('applies master mute/unmute without rebuilding the decoder graph', async () => {
        const harness = createHarness();
        harness.engine.setSnapshot(makeSnapshot());
        harness.engine.setMasterGain(0);
        await harness.engine.play();
        expect(harness.gain.gain.value).toBe(0);
        const setDocumentCalls = harness.decoder.setDocument.mock.calls.length;
        harness.engine.setMasterGain(0.75);
        expect(harness.gain.gain.value).toBe(0.75);
        expect(harness.decoder.setDocument).toHaveBeenCalledTimes(setDocumentCalls);
        expect(harness.engine.hasAudibleContributors()).toBe(true);
    });

    it('does not restart playback when pause wins during AudioWorklet setup', async () => {
        const harness = createHarness();
        const moduleSetup = createDeferred<undefined>();
        harness.context.audioWorklet.addModule.mockImplementation(() => moduleSetup.promise);
        harness.engine.setSnapshot(makeSnapshot());

        const pendingPlay = harness.engine.play();
        await vi.waitFor(() => {
            expect(harness.context.audioWorklet.addModule).toHaveBeenCalledOnce();
        });
        harness.engine.pause();
        moduleSetup.resolve(undefined);
        await pendingPlay;

        expect(harness.messages.filter((message) => message.type === 'play')).toHaveLength(0);
        expect(harness.context.resume).not.toHaveBeenCalled();
    });

    it('closes a partially created AudioContext when AudioWorklet setup fails', async () => {
        const harness = createHarness();
        const setupError = new Error('worklet module failed');
        harness.context.audioWorklet.addModule.mockRejectedValueOnce(setupError);
        harness.engine.setSnapshot(makeSnapshot());

        await expect(harness.engine.play()).rejects.toBe(setupError);

        expect(harness.context.close).toHaveBeenCalledOnce();
        expect(harness.node.connect).not.toHaveBeenCalled();
        expect(harness.messages.filter((message) => message.type === 'play')).toHaveLength(0);
    });

    it('does not restart playback when pause wins while AudioContext resume is pending', async () => {
        const harness = createHarness();
        const contextResume = createDeferred<undefined>();
        harness.context.resume.mockImplementation(() => contextResume.promise);
        harness.engine.setSnapshot(makeSnapshot());

        const pendingPlay = harness.engine.play();
        await vi.waitFor(() => {
            expect(harness.context.resume).toHaveBeenCalledOnce();
        });
        harness.engine.pause();
        contextResume.resolve(undefined);
        await pendingPlay;

        expect(harness.messages.filter((message) => message.type === 'play')).toHaveLength(0);
        expect(harness.decoder.decode).not.toHaveBeenCalled();
    });

    it('does not restart playback when pause wins during scheduler priming', async () => {
        const harness = createHarness();
        const decodedBlock = createDeferred<{
            sampleRate: number;
            startSample: number;
            channels: Float32Array[];
        }>();
        harness.decoder.decode.mockImplementation(() => decodedBlock.promise);
        harness.engine.setSnapshot(makeSnapshot());

        const pendingPlay = harness.engine.play();
        await vi.waitFor(() => {
            expect(harness.decoder.decode).toHaveBeenCalledOnce();
        });
        harness.engine.pause();
        decodedBlock.resolve({
            sampleRate: 48_000,
            startSample: 0,
            channels: [new Float32Array(8), new Float32Array(8)],
        });
        await pendingPlay;

        expect(harness.messages.filter((message) => message.type === 'play')).toHaveLength(0);
        expect(harness.messages.at(-1)).toMatchObject({ type: 'queue' });
    });

    it('rolls transport back after scheduler failure and retries only on explicit play', async () => {
        const harness = createHarness();
        const schedulingError = new Error('decoder failed');
        harness.decoder.decode.mockRejectedValueOnce(schedulingError);
        harness.engine.setSnapshot(makeSnapshot());

        await expect(harness.engine.play()).rejects.toBe(schedulingError);
        expect(harness.messages.at(-1)).toMatchObject({ type: 'pause' });

        const playMessagesAfterFailure = harness.messages
            .filter((message) => message.type === 'play').length;
        harness.engine.setSnapshot(makeSnapshot(2));
        await Promise.resolve();
        expect(harness.messages.filter((message) => message.type === 'play'))
            .toHaveLength(playMessagesAfterFailure);

        harness.decoder.decode.mockResolvedValue({
            sampleRate: 48_000,
            startSample: 0,
            channels: [new Float32Array(8), new Float32Array(8)],
        });
        await harness.engine.play();
        expect(harness.messages.filter((message) => message.type === 'play')).toHaveLength(1);
    });

    it('rolls transport back when an active edit-triggered reschedule fails', async () => {
        const harness = createHarness();
        harness.engine.setSnapshot(makeSnapshot());
        await harness.engine.play();
        harness.decoder.decode.mockRejectedValueOnce(new Error('replacement decode failed'));

        harness.engine.seek(0);
        await vi.waitFor(() => {
            expect(harness.callbacks.onError).toHaveBeenCalledWith(
                expect.objectContaining({ message: 'replacement decode failed' }),
            );
        });

        expect(harness.messages.at(-1)).toMatchObject({ type: 'pause' });
    });

    it('invalidates generations for seek/edit and filters stale clock callbacks', async () => {
        const harness = createHarness();
        harness.engine.setSnapshot(makeSnapshot(1));
        await harness.engine.play();
        const firstGeneration = Math.max(...harness.messages
            .filter((message) => message.type === 'reset')
            .map((message) => message.generation as number));
        harness.engine.seek(4);
        harness.engine.setSnapshot(makeSnapshot(2));
        const currentGeneration = Math.max(...harness.messages
            .filter((message) => message.type === 'reset')
            .map((message) => message.generation as number));
        expect(currentGeneration).toBeGreaterThan(firstGeneration);

        harness.port.onmessage?.({ data: {
            version: TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
            type: 'clock', generation: firstGeneration, outputSample: 7,
            timeSeconds: 7 / 48_000, playing: true, playbackRate: 1,
        } } as MessageEvent);
        expect(harness.callbacks.onClock).not.toHaveBeenCalled();
        harness.port.onmessage?.({ data: {
            version: TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
            type: 'clock', generation: currentGeneration, outputSample: 4,
            timeSeconds: 4 / 48_000, playing: true, playbackRate: 1,
        } } as MessageEvent);
        expect(harness.callbacks.onClock).toHaveBeenCalledOnce();
        expect(harness.decoder.setDocument).toHaveBeenLastCalledWith(
            expect.objectContaining({ revision: 2 }),
            currentGeneration,
        );
    });

    it('reports underrun and refills from the frozen absolute output sample', async () => {
        const harness = createHarness();
        harness.engine.setSnapshot(makeSnapshot());
        await harness.engine.play();
        const generation = Math.max(...harness.messages
            .filter((message) => message.type === 'reset')
            .map((message) => message.generation as number));
        harness.port.onmessage?.({ data: {
            version: TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
            type: 'underrun', generation, outputSample: 3,
            missingStartSample: 3, missingEndSample: 5,
        } } as MessageEvent);
        await Promise.resolve();
        await Promise.resolve();
        expect(harness.callbacks.onUnderrun).toHaveBeenCalledWith({
            generation, outputSample: 3, missingSampleCount: 2,
        });
        expect(harness.decoder.decode).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ outputStartSample: 3 }),
        );
    });

    it('destroys decoder, node, gain, and context exactly once', async () => {
        const harness = createHarness();
        harness.engine.setSnapshot(makeSnapshot());
        await harness.engine.play();
        await harness.engine.destroy();
        await harness.engine.destroy();
        expect(harness.decoder.dispose).toHaveBeenCalledOnce();
        expect(harness.node.disconnect).toHaveBeenCalledOnce();
        expect(harness.gain.disconnect).toHaveBeenCalledOnce();
        expect(harness.context.close).toHaveBeenCalledOnce();
    });
});
