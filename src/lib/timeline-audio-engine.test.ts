import { describe, expect, it, vi } from 'vitest';
import { BrowserTimelineAudioEngine } from './timeline-audio-engine';
import { runtimeDiagnostics } from './runtime-diagnostics';
import {
    TimelineAudioQueueModel,
    TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
} from './timeline-audio-worklet';
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

function makeSnapshot(revision = 1, contentEndSample = 8): TimelineAudioEngineSnapshot {
    const document = makeDocument();
    document.revision = revision;
    document.audioGraphRevision = revision;
    return {
        document,
        sourceCatalogKey: 'sources-v1',
        audibleMixKey: `mix-v${revision}`,
        contentEndSample,
        mixPlan: {
            sampleRate: 48_000,
            totalSampleCount: contentEndSample,
            videoSampleCount: contentEndSample,
            contributors: [{
                id: 'embedded-video:clip', kind: 'embedded-video', trackId: null,
                source: { kind: 'video-source-audio', videoSourceId: 'video' },
                outputStartSample: 0, outputEndSample: contentEndSample,
                sourceRange: {
                    domain: 'seconds', startSeconds: 0,
                    endSeconds: contentEndSample / 48_000,
                },
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
        suspend: vi.fn(async () => { context.state = 'suspended'; }),
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
        harness.engine.applySnapshot(makeSnapshot(), 0);
        harness.engine.setPlaybackRate(0.1);
        expect(harness.context.audioWorklet.addModule).not.toHaveBeenCalled();
        await harness.engine.play();
        harness.engine.setPlaybackRate(1);
        harness.engine.setPlaybackRate(2);

        expect(harness.context.audioWorklet.addModule).toHaveBeenCalledWith(
            'https://waptions.example/worklets/timeline-audio-worklet.js?v=3',
        );
        expect(harness.messages.filter((message) => message.type === 'set-rate')
            .map((message) => message.playbackRate)).toEqual([0.1, 1, 2]);
        expect(harness.messages.some((message) => message.type === 'queue')).toBe(true);
    });

    it('starts after a low-water runway before filling the high-water queue in background', async () => {
        const harness = createHarness();
        harness.engine.applySnapshot(makeSnapshot(1, 96_000), 0);

        await harness.engine.play();

        const playIndex = harness.messages.findIndex((message) => message.type === 'play');
        expect(playIndex).toBeGreaterThan(0);
        expect(harness.messages.slice(0, playIndex)
            .filter((message) => message.type === 'queue')).toHaveLength(3);
        await harness.engine.destroy();
    });

    it('applies master mute/unmute without rebuilding the decoder graph', async () => {
        const harness = createHarness();
        harness.engine.applySnapshot(makeSnapshot(), 0);
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
        harness.engine.applySnapshot(makeSnapshot(), 0);

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

    it('replays pause when a running AudioContext is published after setup completes', async () => {
        const harness = createHarness();
        const moduleSetup = createDeferred<undefined>();
        harness.context.state = 'running';
        harness.context.audioWorklet.addModule.mockImplementation(() => moduleSetup.promise);
        harness.engine.applySnapshot(makeSnapshot(), 0);

        const pendingPlay = harness.engine.play();
        await vi.waitFor(() => expect(harness.context.audioWorklet.addModule).toHaveBeenCalledOnce());
        harness.engine.pause();
        moduleSetup.resolve(undefined);
        await pendingPlay;

        const pauseMessage = harness.messages.findLast((message) => message.type === 'pause');
        const resetMessage = harness.messages.findLast((message) => message.type === 'reset');
        expect(pauseMessage).toBeDefined();
        expect(harness.messages.filter((message) => message.type === 'play')).toHaveLength(0);
        harness.port.onmessage?.({ data: {
            version: TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
            type: 'paused',
            generation: resetMessage?.generation,
            outputSample: 0,
            requestId: pauseMessage?.requestId,
        } } as MessageEvent);
        await vi.waitFor(() => expect(harness.context.suspend).toHaveBeenCalledOnce());

        await harness.engine.play();
        expect(harness.context.resume).toHaveBeenCalledOnce();
        expect(harness.messages.filter((message) => message.type === 'play')).toHaveLength(1);
    });

    it('closes a partially created AudioContext when AudioWorklet setup fails', async () => {
        const harness = createHarness();
        const setupError = new Error('worklet module failed');
        harness.context.audioWorklet.addModule.mockRejectedValueOnce(setupError);
        harness.engine.applySnapshot(makeSnapshot(), 0);

        await expect(harness.engine.play()).rejects.toBe(setupError);

        expect(harness.context.close).toHaveBeenCalledOnce();
        expect(harness.node.connect).not.toHaveBeenCalled();
        expect(harness.messages.filter((message) => message.type === 'play')).toHaveLength(0);
    });

    it('does not restart playback when pause wins while AudioContext resume is pending', async () => {
        const harness = createHarness();
        const contextResume = createDeferred<undefined>();
        harness.context.resume.mockImplementation(() => contextResume.promise);
        harness.engine.applySnapshot(makeSnapshot(), 0);

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
        harness.engine.applySnapshot(makeSnapshot(), 0);

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
        harness.engine.applySnapshot(makeSnapshot(), 0);

        await expect(harness.engine.play()).rejects.toBe(schedulingError);
        expect(harness.messages.at(-1)).toMatchObject({ type: 'pause' });

        const playMessagesAfterFailure = harness.messages
            .filter((message) => message.type === 'play').length;
        harness.engine.applySnapshot(makeSnapshot(2), 0);
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
        harness.engine.applySnapshot(makeSnapshot(), 0);
        await harness.engine.play();
        harness.decoder.decode.mockRejectedValueOnce(new Error('replacement decode failed'));

        harness.engine.applySnapshot(makeSnapshot(2), 0);
        await vi.waitFor(() => {
            expect(harness.callbacks.onError).toHaveBeenCalledWith(
                expect.objectContaining({ message: 'replacement decode failed' }),
            );
        });

        expect(harness.messages.at(-1)).toMatchObject({ type: 'pause' });
    });

    it('invalidates generations for seek/edit and filters stale clock callbacks', async () => {
        const harness = createHarness();
        harness.engine.applySnapshot(makeSnapshot(1), 0);
        await harness.engine.play();
        const firstGeneration = Math.max(...harness.messages
            .filter((message) => message.type === 'reset')
            .map((message) => message.generation as number));
        harness.engine.seek(4);
        harness.engine.applySnapshot(makeSnapshot(2), 4);
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
        expect(harness.decoder.setDocument).toHaveBeenCalledOnce();
    });

    it('reports underrun and refills from the frozen absolute output sample', async () => {
        const harness = createHarness();
        harness.engine.applySnapshot(makeSnapshot(), 0);
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

    it('does no queue or session work for revision-only editor metadata changes', async () => {
        const harness = createHarness();
        const snapshot = makeSnapshot();
        harness.engine.applySnapshot(snapshot, 0);
        await harness.engine.play();
        const resetCount = harness.messages.filter((message) => message.type === 'reset').length;

        const metadataDocument = { ...snapshot.document, revision: 200 };
        harness.engine.applySnapshot({ ...snapshot, document: metadataDocument }, 4);

        expect(harness.messages.filter((message) => message.type === 'reset')).toHaveLength(resetCount);
        expect(harness.messages.filter((message) => message.type === 'set-content-end')).toHaveLength(0);
        expect(harness.decoder.setDocument).toHaveBeenCalledOnce();
    });

    it('updates a subtitle/content tail without resetting the queue or decoder sessions', async () => {
        const harness = createHarness();
        const snapshot = makeSnapshot();
        harness.engine.applySnapshot(snapshot, 0);
        await harness.engine.play();
        const resetCount = harness.messages.filter((message) => message.type === 'reset').length;

        harness.engine.applySnapshot({ ...snapshot, contentEndSample: 16 }, 4);

        expect(harness.messages.filter((message) => message.type === 'reset')).toHaveLength(resetCount);
        expect(harness.messages.filter((message) => message.type === 'set-content-end').at(-1))
            .toMatchObject({ contentEndSample: 16 });
        expect(harness.decoder.setDocument).toHaveBeenCalledOnce();
    });

    it('restarts at the retained boundary when shrink and extend overtake an in-flight block', async () => {
        const harness = createHarness();
        const secondBlock = createDeferred<{
            sampleRate: number;
            startSample: number;
            channels: Float32Array[];
        }>();
        let decodeCallCount = 0;
        harness.decoder.decode.mockImplementation(async (_contributor, request) => {
            decodeCallCount += 1;
            if (decodeCallCount === 2) return secondBlock.promise;
            return {
                sampleRate: 48_000,
                startSample: 0,
                channels: [
                    new Float32Array(request.outputEndSample),
                    new Float32Array(request.outputEndSample),
                ],
            };
        });
        const snapshot = makeSnapshot(1, 12_000);
        harness.engine.applySnapshot(snapshot, 0);
        const pendingPlay = harness.engine.play();
        await vi.waitFor(() => expect(harness.decoder.decode).toHaveBeenCalledTimes(2));

        harness.engine.applySnapshot({ ...snapshot, contentEndSample: 2_000 }, 0);
        harness.engine.applySnapshot({ ...snapshot, contentEndSample: 12_000 }, 0);
        const extensionMessageIndex = harness.messages.findLastIndex((message) => (
            message.type === 'set-content-end' && message.contentEndSample === 12_000
        ));
        secondBlock.resolve({
            sampleRate: 48_000,
            startSample: 0,
            channels: [new Float32Array(8_192), new Float32Array(8_192)],
        });
        await pendingPlay;
        await vi.waitFor(() => {
            const queued = harness.messages.slice(extensionMessageIndex + 1)
                .filter((message) => message.type === 'queue');
            expect(queued.at(-1)?.startSample as number
                + (queued.at(-1)?.left as Float32Array).length).toBe(12_000);
        });

        const refillMessages = harness.messages.slice(extensionMessageIndex + 1)
            .filter((message) => message.type === 'queue');
        let coverageEnd = 2_000;
        const queue = new TimelineAudioQueueModel(0);
        queue.queue({
            startSample: 0,
            left: new Float32Array(2_000),
            right: new Float32Array(2_000),
        });
        refillMessages.forEach((message) => {
            const left = message.left as Float32Array;
            const right = message.right as Float32Array;
            expect(message.startSample).toBe(coverageEnd);
            queue.queue({ startSample: message.startSample as number, left, right });
            coverageEnd += left.length;
        });
        expect(coverageEnd).toBe(12_000);
        for (let sample = 0; sample < 12_000; sample += 1) {
            expect(queue.renderFrame(1)).not.toBeNull();
        }
        expect(harness.callbacks.onUnderrun).not.toHaveBeenCalled();
    });

    it('reconciles an unused source catalog change without resetting the audible queue', async () => {
        const harness = createHarness();
        const snapshot = makeSnapshot();
        harness.engine.applySnapshot(snapshot, 0);
        await harness.engine.play();
        const resetCount = harness.messages.filter((message) => message.type === 'reset').length;

        harness.engine.applySnapshot({ ...snapshot, sourceCatalogKey: 'sources-v2' }, 4);

        expect(harness.decoder.setDocument).toHaveBeenCalledTimes(2);
        expect(harness.messages.filter((message) => message.type === 'reset')).toHaveLength(resetCount);
    });

    it('performs exactly one queue reset for a mix edit or seek and retains source sessions', async () => {
        const harness = createHarness();
        harness.engine.applySnapshot(makeSnapshot(1), 0);
        await harness.engine.play();
        const initialResetCount = harness.messages.filter((message) => message.type === 'reset').length;

        harness.engine.applySnapshot(makeSnapshot(2), 2);
        expect(harness.messages.filter((message) => message.type === 'reset'))
            .toHaveLength(initialResetCount + 1);
        expect(harness.decoder.setDocument).toHaveBeenCalledOnce();

        harness.engine.seek(3);
        expect(harness.messages.filter((message) => message.type === 'reset'))
            .toHaveLength(initialResetCount + 2);
        expect(harness.decoder.setDocument).toHaveBeenCalledOnce();
    });

    it('reuses cached mixed blocks after a seek in the same audible graph', async () => {
        const harness = createHarness();
        harness.engine.applySnapshot(makeSnapshot(), 0);
        await harness.engine.play();
        const decodeCalls = harness.decoder.decode.mock.calls.length;

        harness.engine.seek(0);
        await vi.waitFor(() => {
            expect(harness.messages.filter((message) => message.type === 'queue')).toHaveLength(2);
        });

        expect(harness.decoder.decode).toHaveBeenCalledTimes(decodeCalls);
    });

    it('publishes pull-based queue, decode, and cache diagnostics at block boundaries', async () => {
        runtimeDiagnostics.reset();
        const harness = createHarness();
        harness.engine.applySnapshot(makeSnapshot(), 0);
        await harness.engine.play();
        harness.engine.seek(0);
        await vi.waitFor(() => {
            expect(harness.messages.filter((message) => message.type === 'queue')).toHaveLength(2);
        });

        const diagnostics = runtimeDiagnostics.snapshot();
        expect(diagnostics.counters.audio.queueResets).toBe(2);
        expect(diagnostics.counters.audio.decodedBlocks).toBe(1);
        expect(diagnostics.counters.audio.cacheMisses).toBe(1);
        expect(diagnostics.counters.audio.cacheHits).toBe(1);
        expect(diagnostics.gauges.audio.queuedBlocks).toBeGreaterThan(0);
    });

    it('suspends the AudioContext only after the worklet acknowledges pause', async () => {
        const harness = createHarness();
        harness.engine.applySnapshot(makeSnapshot(), 0);
        await harness.engine.play();
        const generation = Math.max(...harness.messages
            .filter((message) => message.type === 'reset')
            .map((message) => message.generation as number));

        harness.engine.pause();
        const pauseRequestId = harness.messages.at(-1)?.requestId as number;
        expect(harness.context.suspend).not.toHaveBeenCalled();
        harness.port.onmessage?.({ data: {
            version: TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
            type: 'paused', generation, outputSample: 0, requestId: pauseRequestId,
        } } as MessageEvent);
        await vi.waitFor(() => expect(harness.context.suspend).toHaveBeenCalledOnce());
    });

    it.each(['seek', 'mix edit'] as const)(
        'honors a pause acknowledgement across an immediate %s reset',
        async (resetKind) => {
            const harness = createHarness();
            harness.engine.applySnapshot(makeSnapshot(), 0);
            await harness.engine.play();
            const pausedGeneration = Math.max(...harness.messages
                .filter((message) => message.type === 'reset')
                .map((message) => message.generation as number));

            harness.engine.pause();
            const pauseRequestId = harness.messages.at(-1)?.requestId as number;
            if (resetKind === 'seek') harness.engine.seek(2);
            else harness.engine.applySnapshot(makeSnapshot(2), 2);
            harness.port.onmessage?.({ data: {
                version: TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
                type: 'paused', generation: pausedGeneration, outputSample: 1,
                requestId: pauseRequestId,
            } } as MessageEvent);
            harness.port.onmessage?.({ data: {
                version: TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
                type: 'clock', generation: pausedGeneration, outputSample: 2,
                timeSeconds: 2 / 48_000, playing: false, playbackRate: 1,
            } } as MessageEvent);

            await vi.waitFor(() => expect(harness.context.suspend).toHaveBeenCalledOnce());
            expect(harness.callbacks.onClock).not.toHaveBeenCalled();
        },
    );

    it('ignores a late pause acknowledgement after a newer play request takes ownership', async () => {
        const harness = createHarness();
        harness.engine.applySnapshot(makeSnapshot(), 0);
        await harness.engine.play();
        const pausedGeneration = Math.max(...harness.messages
            .filter((message) => message.type === 'reset')
            .map((message) => message.generation as number));

        harness.engine.pause();
        const stalePauseRequestId = harness.messages.at(-1)?.requestId as number;
        await harness.engine.play();
        harness.port.onmessage?.({ data: {
            version: TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
            type: 'paused', generation: pausedGeneration, outputSample: 0,
            requestId: stalePauseRequestId,
        } } as MessageEvent);
        await Promise.resolve();

        expect(harness.context.suspend).not.toHaveBeenCalled();
    });

    it('serializes decoder ownership while an aborted generation unwinds', async () => {
        const harness = createHarness();
        const releaseFirstDecode = createDeferred<void>();
        let activeDecodes = 0;
        let maximumActiveDecodes = 0;
        let decodeCallCount = 0;
        harness.decoder.decode.mockImplementation(async (_contributor, request) => {
            decodeCallCount += 1;
            activeDecodes += 1;
            maximumActiveDecodes = Math.max(maximumActiveDecodes, activeDecodes);
            if (decodeCallCount === 1) await releaseFirstDecode.promise;
            activeDecodes -= 1;
            return {
                sampleRate: 48_000,
                startSample: 0,
                channels: [
                    new Float32Array(request.outputEndSample),
                    new Float32Array(request.outputEndSample),
                ],
            };
        });
        harness.engine.applySnapshot(makeSnapshot(), 0);
        const pendingPlay = harness.engine.play();
        await vi.waitFor(() => expect(harness.decoder.decode).toHaveBeenCalledOnce());

        harness.engine.applySnapshot(makeSnapshot(2), 0);
        await Promise.resolve();
        expect(harness.decoder.decode).toHaveBeenCalledOnce();
        releaseFirstDecode.resolve(undefined);
        await pendingPlay;
        await vi.waitFor(() => expect(harness.decoder.decode.mock.calls.length).toBeGreaterThan(1));

        expect(maximumActiveDecodes).toBe(1);
        await harness.engine.destroy();
    });

    it('publishes the exact terminal clock and suspends after a natural ended event', async () => {
        const harness = createHarness();
        harness.engine.applySnapshot(makeSnapshot(), 0);
        await harness.engine.play();
        const generation = Math.max(...harness.messages
            .filter((message) => message.type === 'reset')
            .map((message) => message.generation as number));

        harness.port.onmessage?.({ data: {
            version: TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
            type: 'ended', generation, outputSample: 8, timeSeconds: 8 / 48_000,
        } } as MessageEvent);

        expect(harness.callbacks.onClock).toHaveBeenCalledWith({
            generation, outputSample: 8, timeSeconds: 8 / 48_000,
            playing: true, playbackRate: 1,
        });
        expect(harness.callbacks.onUnderrun).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(harness.context.suspend).toHaveBeenCalledOnce());
    });

    it('waits for AudioWorklet setup ownership before destroy resolves', async () => {
        const harness = createHarness();
        const moduleSetup = createDeferred<undefined>();
        harness.context.audioWorklet.addModule.mockImplementation(() => moduleSetup.promise);
        harness.engine.applySnapshot(makeSnapshot(), 0);
        const play = harness.engine.play();
        await vi.waitFor(() => expect(harness.context.audioWorklet.addModule).toHaveBeenCalledOnce());

        const destroy = harness.engine.destroy();
        moduleSetup.resolve(undefined);
        await Promise.all([play, destroy]);

        expect(harness.context.close).toHaveBeenCalledOnce();
        expect(harness.node.connect).not.toHaveBeenCalled();
        expect(harness.decoder.dispose).toHaveBeenCalledOnce();
    });

    it('destroys decoder, node, gain, and context exactly once', async () => {
        const harness = createHarness();
        harness.engine.applySnapshot(makeSnapshot(), 0);
        await harness.engine.play();
        await harness.engine.destroy();
        await harness.engine.destroy();
        expect(harness.decoder.dispose).toHaveBeenCalledOnce();
        expect(harness.node.disconnect).toHaveBeenCalledOnce();
        expect(harness.gain.disconnect).toHaveBeenCalledOnce();
        expect(harness.context.close).toHaveBeenCalledOnce();
    });
});
