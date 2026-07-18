import { describe, expect, it, vi } from 'vitest';
import type {
    AudioCodec,
    AudioSample,
    AudioSampleSource,
    BufferTarget,
    Output,
} from 'mediabunny';
import type { EditorDocumentV3 } from '@/types/video';
import { buildAudioMixPlan } from './audio-mix-plan';
import {
    TimelineAudioRenderer,
    type TimelineAudioDecoder,
} from './timeline-audio-renderer';
import {
    encodeTimelineAudioForDiarization,
    createTimelineDiarizationAudioSnapshot,
    TimelineDiarizationAudioError,
    TimelineDiarizationNoAudioError,
    type TimelineDiarizationAudioDependencies,
    type TimelineDiarizationAudioSnapshot,
} from './timeline-diarization-audio';

const videoFile = new File(['video'], 'video.mp4', { type: 'video/mp4' });
const audioFile = new File(['audio'], 'voice.wav', { type: 'audio/wav' });

function makeDocument(): EditorDocumentV3 {
    return {
        version: 3,
        revision: 1,
        audioGraphRevision: 1,
        renderProfile: {
            fps: { numerator: 30, denominator: 1 },
            width: 1920,
            height: 1080,
            audioSampleRate: 48_000,
            isFrameRateLocked: true,
            isCanvasSizeLocked: true,
        },
        subtitleTracks: [],
        videoSources: [{
            id: 'video',
            originalName: videoFile.name,
            mimeType: videoFile.type,
            size: videoFile.size,
            lastModified: videoFile.lastModified,
            fingerprint: 'video-fingerprint',
            duration: 5,
            fps: 30,
            width: 1920,
            height: 1080,
            bitrate: 1_000_000,
            hasAudio: true,
            file: videoFile,
        }],
        videoClips: [{
            id: 'audible-video',
            sourceId: 'video',
            sourceStart: 0.5,
            sourceEnd: 1.5,
            audio: {
                linkState: 'linked',
                muted: false,
                gainDb: -3,
                fadeInFrames: 3,
                fadeOutFrames: 3,
            },
        }, {
            // This clip extends the visual program to five seconds but contributes no audio.
            id: 'silent-video-tail',
            sourceId: 'video',
            sourceStart: 1,
            sourceEnd: 5,
            audio: null,
        }],
        videoTracks: [{
            id: 'video-track',
            name: 'Video 1',
            clipIds: ['audible-video', 'silent-video-tail'],
        }],
        audioSources: [{
            id: 'voice',
            originalName: audioFile.name,
            mimeType: audioFile.type,
            size: audioFile.size,
            lastModified: audioFile.lastModified,
            fingerprint: 'voice-fingerprint',
            duration: 10,
            nativeSampleRate: 48_000,
            nativeSampleCount: 480_000,
            nativeChannelCount: 1,
            bitrate: null,
            codec: 'pcm',
            file: audioFile,
        }],
        audioTracks: [{
            id: 'voice-track',
            name: 'Voice',
            muted: false,
            solo: false,
            locked: false,
            gainDb: -2,
            clips: [{
                // Two seconds of leading project time and a one-second native crop are retained.
                id: 'voice-clip',
                source: { kind: 'audio-source', audioSourceId: 'voice' },
                timelineStartFrame: 60,
                sourceStartSample: 48_000,
                sourceEndSample: 96_000,
                timelineDurationSamples: 48_000,
                muted: false,
                gainDb: -4,
                fadeInSamples: 4_800,
                fadeOutSamples: 9_600,
            }],
        }, {
            id: 'muted-tail-track',
            name: 'Muted tail',
            muted: true,
            solo: false,
            locked: false,
            gainDb: 0,
            clips: [{
                // The canonical plan sees this occupancy but excludes it from audible contributors.
                id: 'muted-tail',
                source: { kind: 'audio-source', audioSourceId: 'voice' },
                timelineStartFrame: 150,
                sourceStartSample: 0,
                sourceEndSample: 48_000,
                timelineDurationSamples: 48_000,
                muted: false,
                gainDb: 0,
                fadeInSamples: 0,
                fadeOutSamples: 0,
            }],
        }],
        activeSubtitleTrackId: null,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
    };
}

interface HarnessOptions {
    selectedCodecs?: Array<AudioCodec | null | Error>;
    targetBuffer?: ArrayBuffer | null;
    startError?: Error;
    finalizeError?: Error;
    renderError?: Error;
    sourceAdd?: (sample: AudioSample) => Promise<void>;
    onCancel?: () => Promise<void>;
    render?: TimelineDiarizationAudioDependencies['render'];
}

function createHarness(options: HarnessOptions = {}) {
    let outputState: Output['state'] = 'pending';
    const target = {
        buffer: options.targetBuffer === undefined
            ? Uint8Array.from([1, 2, 3]).buffer
            : options.targetBuffer,
    } as BufferTarget;
    const source = {
        add: vi.fn(options.sourceAdd ?? (async () => undefined)),
        close: vi.fn(),
    } as unknown as Pick<AudioSampleSource, 'add' | 'close'>;
    const output = {
        get state() { return outputState; },
        addAudioTrack: vi.fn(),
        start: vi.fn(async () => {
            if (options.startError) throw options.startError;
            outputState = 'started';
        }),
        finalize: vi.fn(async () => {
            outputState = 'finalizing';
            if (options.finalizeError) throw options.finalizeError;
            outputState = 'finalized';
        }),
        cancel: vi.fn(async () => {
            outputState = 'canceled';
            await options.onCancel?.();
        }),
    } as unknown as Pick<Output, 'state' | 'addAudioTrack' | 'start' | 'finalize' | 'cancel'>;
    const codecResults = [...(options.selectedCodecs ?? ['aac'])];
    const selectedContainers: Array<'mp4' | 'webm'> = [];
    const renderSnapshots: EditorDocumentV3[] = [];
    const renderPlans: ReturnType<typeof buildAudioMixPlan>[] = [];
    const renderOptions: Array<{ outputEndSample: number; signal?: AbortSignal }> = [];

    const dependencies: TimelineDiarizationAudioDependencies = {
        buildPlan: vi.fn(buildAudioMixPlan),
        selectCodec: vi.fn(async () => {
            const result = codecResults.shift() ?? null;
            if (result instanceof Error) throw result;
            return result;
        }),
        createTarget: vi.fn(() => target),
        createOutput: vi.fn((_target, container) => {
            selectedContainers.push(container);
            return output;
        }),
        createSource: vi.fn(() => source),
        render: vi.fn(async (document, encodingSource, plan, renderOptionsValue) => {
            renderSnapshots.push(document);
            renderPlans.push(plan);
            renderOptions.push(renderOptionsValue);
            if (options.renderError) throw options.renderError;
            if (options.render) {
                await options.render(document, encodingSource, plan, renderOptionsValue);
                return;
            }
            await encodingSource.add({} as AudioSample);
        }),
    };

    return {
        dependencies,
        output,
        source,
        target,
        selectedContainers,
        renderSnapshots,
        renderPlans,
        renderOptions,
    };
}

describe('encodeTimelineAudioForDiarization', () => {
    it('reuses one explicitly captured snapshot for guard and encoding without cloning it again', async () => {
        const document = makeDocument();
        const snapshot = createTimelineDiarizationAudioSnapshot(document);
        const harness = createHarness();

        await encodeTimelineAudioForDiarization(snapshot, {
            signal: new AbortController().signal,
        }, harness.dependencies);

        expect(harness.dependencies.buildPlan).toHaveBeenCalledWith(snapshot);
        expect(harness.renderSnapshots[0]).toBe(snapshot);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.audioTracks[0].clips[0])).toBe(true);
    });

    it('does not let an unregistered branded cast bypass the defensive snapshot', async () => {
        const liveDocument = makeDocument();
        const forgedSnapshot = liveDocument as TimelineDiarizationAudioSnapshot;
        const harness = createHarness();

        await encodeTimelineAudioForDiarization(forgedSnapshot, {
            signal: new AbortController().signal,
        }, harness.dependencies);

        const encodedSnapshot = harness.renderSnapshots[0];
        expect(encodedSnapshot).not.toBe(liveDocument);
        expect(Object.isFrozen(encodedSnapshot)).toBe(true);
        expect(Object.isFrozen(encodedSnapshot.audioTracks[0].clips[0])).toBe(true);
        expect(Object.isFrozen(liveDocument)).toBe(false);
    });

    it('freezes one canonical mixed snapshot and excludes silent and muted tails from the boundary', async () => {
        const document = makeDocument();
        const harness = createHarness();
        const stages = vi.fn();
        const operation = encodeTimelineAudioForDiarization(document, {
            signal: new AbortController().signal,
            onStage: stages,
        }, harness.dependencies);

        // Mutating the editor immediately after the call cannot revise the already-captured graph.
        document.videoClips[0].sourceEnd = 4;
        document.audioTracks[0].clips[0].timelineStartFrame = 0;
        const result = await operation;

        expect(harness.dependencies.buildPlan).toHaveBeenCalledTimes(1);
        expect(harness.renderSnapshots).toHaveLength(1);
        const snapshot = harness.renderSnapshots[0];
        expect(snapshot).not.toBe(document);
        expect(snapshot.videoSources[0].file).toBe(videoFile);
        expect(snapshot.audioSources[0].file).toBe(audioFile);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.videoClips[0].audio)).toBe(true);

        const plan = harness.renderPlans[0];
        expect(plan.totalSampleCount).toBe(288_000);
        expect(plan.contributors).toHaveLength(2);
        expect(plan.contributors[0]).toMatchObject({
            kind: 'embedded-video',
            outputStartSample: 0,
            outputEndSample: 48_000,
            sourceRange: { domain: 'seconds', startSeconds: 0.5, endSeconds: 1.5 },
        });
        expect(plan.contributors[1]).toMatchObject({
            kind: 'independent-audio',
            outputStartSample: 96_000,
            outputEndSample: 144_000,
            sourceRange: {
                domain: 'native-samples',
                startSample: 48_000,
                endSample: 96_000,
            },
            fadeInSamples: 4_800,
            fadeOutSamples: 9_600,
        });
        expect(harness.renderOptions[0].outputEndSample).toBe(144_000);
        expect(result).toMatchObject({
            filename: 'timeline-diarization.m4a',
            durationSeconds: 3,
            outputEndSample: 144_000,
        });
        expect(result.blob.type).toBe('audio/mp4');
        expect(await result.blob.arrayBuffer()).toEqual(Uint8Array.from([1, 2, 3]).buffer);
        expect(stages.mock.calls.map(([stage]) => stage)).toEqual([
            'rendering-project-mix',
            'encoding-project-mix',
        ]);
        expect(harness.source.close).toHaveBeenCalledTimes(1);
        expect(harness.output.finalize).toHaveBeenCalledTimes(1);
        expect(harness.output.cancel).not.toHaveBeenCalled();
    });

    it('retains sample-zero leading silence when solo filtering leaves a later audio contributor', async () => {
        const document = makeDocument();
        document.audioTracks[0].solo = true;
        const harness = createHarness();

        const result = await encodeTimelineAudioForDiarization(document, {
            signal: new AbortController().signal,
        }, harness.dependencies);

        expect(harness.renderPlans[0].contributors).toHaveLength(1);
        expect(harness.renderPlans[0].contributors[0]).toMatchObject({
            id: 'independent-audio:voice-track:voice-clip',
            outputStartSample: 96_000,
            outputEndSample: 144_000,
        });
        // TimelineAudioRenderer always begins at zero; passing the exclusive three-second end
        // therefore retains two seconds of leading silence before this soloed clip.
        expect(harness.renderOptions[0].outputEndSample).toBe(144_000);
        expect(result.durationSeconds).toBe(3);
    });

    it('returns a typed no-audio condition before probing codecs or allocating output resources', async () => {
        const document = makeDocument();
        document.videoClips[0].audio!.muted = true;
        document.audioTracks[0].muted = true;
        const harness = createHarness();

        await expect(encodeTimelineAudioForDiarization(document, {
            signal: new AbortController().signal,
        }, harness.dependencies)).rejects.toBeInstanceOf(TimelineDiarizationNoAudioError);

        expect(harness.dependencies.selectCodec).not.toHaveBeenCalled();
        expect(harness.dependencies.createTarget).not.toHaveBeenCalled();
        expect(harness.dependencies.render).not.toHaveBeenCalled();
    });

    it('falls back from unavailable AAC/MP4 to Opus/WebM with matching metadata', async () => {
        const harness = createHarness({ selectedCodecs: [null, 'opus'] });

        const result = await encodeTimelineAudioForDiarization(makeDocument(), {
            signal: new AbortController().signal,
        }, harness.dependencies);

        expect(harness.dependencies.selectCodec).toHaveBeenNthCalledWith(1, ['aac']);
        expect(harness.dependencies.selectCodec).toHaveBeenNthCalledWith(2, ['opus']);
        expect(harness.dependencies.createSource).toHaveBeenCalledWith('opus');
        expect(harness.selectedContainers).toEqual(['webm']);
        expect(result.filename).toBe('timeline-diarization.webm');
        expect(result.blob.type).toBe('audio/webm');
    });

    it('closes the source and cancels a started output after a render failure', async () => {
        const harness = createHarness({ renderError: new Error('decoder failed') });

        await expect(encodeTimelineAudioForDiarization(makeDocument(), {
            signal: new AbortController().signal,
        }, harness.dependencies)).rejects.toMatchObject({
            name: 'TimelineDiarizationAudioError',
            stage: 'rendering',
            message: 'Could not render the project audio mix for diarization.',
        });

        expect(harness.source.close).not.toHaveBeenCalled();
        expect(harness.output.cancel).toHaveBeenCalledTimes(1);
        expect(harness.output.finalize).not.toHaveBeenCalled();
    });

    it('classifies encoder rejection separately and never returns a partial Blob', async () => {
        const harness = createHarness({
            sourceAdd: async () => { throw new Error('codec failed'); },
        });

        await expect(encodeTimelineAudioForDiarization(makeDocument(), {
            signal: new AbortController().signal,
        }, harness.dependencies)).rejects.toEqual(expect.objectContaining({
            name: 'TimelineDiarizationAudioError',
            stage: 'encoding',
            message: 'Could not encode the project audio for diarization.',
        }));

        expect(harness.source.close).not.toHaveBeenCalled();
        expect(harness.output.cancel).toHaveBeenCalledTimes(1);
        expect(harness.output.finalize).not.toHaveBeenCalled();
    });

    it('rejects a missing finalized buffer without attempting an illegal post-finalize cancel', async () => {
        const harness = createHarness({ targetBuffer: null });

        await expect(encodeTimelineAudioForDiarization(makeDocument(), {
            signal: new AbortController().signal,
        }, harness.dependencies)).rejects.toMatchObject({
            name: 'TimelineDiarizationAudioError',
            stage: 'encoding',
            message: 'Audio encoding completed without an output buffer.',
        });

        expect(harness.source.close).toHaveBeenCalledTimes(1);
        expect(harness.output.finalize).toHaveBeenCalledTimes(1);
        expect(harness.output.cancel).not.toHaveBeenCalled();
    });

    it('aborts during encoder backpressure and releases the source and output exactly once', async () => {
        const controller = new AbortController();
        const harness = createHarness({
            sourceAdd: async () => { controller.abort(); },
        });

        await expect(encodeTimelineAudioForDiarization(makeDocument(), {
            signal: controller.signal,
        }, harness.dependencies)).rejects.toMatchObject({ name: 'AbortError' });

        expect(harness.source.close).not.toHaveBeenCalled();
        expect(harness.output.cancel).toHaveBeenCalledTimes(1);
        expect(harness.output.finalize).not.toHaveBeenCalled();
    });

    it('cancels an allocated pending output when startup fails', async () => {
        const harness = createHarness({ startError: new Error('muxer start failed') });

        await expect(encodeTimelineAudioForDiarization(makeDocument(), {
            signal: new AbortController().signal,
        }, harness.dependencies)).rejects.toBeInstanceOf(TimelineDiarizationAudioError);

        expect(harness.source.close).not.toHaveBeenCalled();
        expect(harness.output.cancel).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.render).not.toHaveBeenCalled();
    });

    it('keeps the first sample alive until forced cancel settles the in-flight encoder add', async () => {
        const controller = new AbortController();
        const addStarted = createDeferred<void>();
        const addSettlement = createDeferred<void>();
        const cancelStarted = createDeferred<void>();
        const events: string[] = [];
        let heldSample: AudioSample | null = null;
        const decoder: TimelineAudioDecoder = {
            setDocument: vi.fn(),
            decode: vi.fn(async () => { throw new Error('The injected render window does not decode.'); }),
            dispose: vi.fn(),
        };
        const harness = createHarness({
            sourceAdd: async (sample) => {
                heldSample = sample;
                events.push('add-start');
                addStarted.resolve(undefined);
                await addSettlement.promise;
                events.push('add-settle');
            },
            onCancel: async () => {
                events.push('cancel-start');
                cancelStarted.resolve(undefined);
                // The fake mirrors Mediabunny's forced source close: Output.cancel cannot finish
                // until the encoder's currently owned AudioSample add reaches settlement.
                await addSettlement.promise;
                events.push('cancel-end');
            },
            render: async (document, source, plan, renderOptions) => {
                const renderer = new TimelineAudioRenderer(document, source, {
                    createDecoder: () => decoder,
                    buildPlan: () => plan,
                    renderWindow: async (_plan, _decode, window) => {
                        const startSample = window?.startSample ?? 0;
                        const endSample = window?.endSample ?? startSample + 16;
                        const frameCount = endSample - startSample;
                        return {
                            sampleRate: 48_000,
                            startSample,
                            endSample,
                            channels: [new Float32Array(frameCount), new Float32Array(frameCount)],
                        };
                    },
                });
                await renderer.render({ ...renderOptions, windowSampleCount: 16 });
            },
        });

        const firstRun = encodeTimelineAudioForDiarization(makeDocument(), {
            signal: controller.signal,
        }, harness.dependencies);
        let firstRunSettled = false;
        void firstRun.then(
            () => { firstRunSettled = true; },
            () => { firstRunSettled = true; },
        );

        await addStarted.promise;
        controller.abort();
        await cancelStarted.promise;

        expect(events).toEqual(['add-start', 'cancel-start']);
        expect(firstRunSettled).toBe(false);
        expect(heldSample).not.toBeNull();
        // The renderer must not close a sample while WebCodecs still owns its add operation.
        expect(() => heldSample!.copyTo(new Float32Array(1), {
            planeIndex: 0,
            format: 'f32-planar',
            frameCount: 1,
        })).not.toThrow();

        addSettlement.resolve(undefined);
        await expect(firstRun).rejects.toMatchObject({ name: 'AbortError' });

        expect(events).toEqual(['add-start', 'cancel-start', 'add-settle', 'cancel-end']);
        expect(harness.output.cancel).toHaveBeenCalledTimes(1);
        expect(harness.source.close).not.toHaveBeenCalled();
        expect(decoder.dispose).toHaveBeenCalledTimes(1);
        expect(() => heldSample!.copyTo(new Float32Array(1), {
            planeIndex: 0,
            format: 'f32-planar',
            frameCount: 1,
        })).toThrow();

        // A subsequent job starts only after every first-run encoder/cancel continuation settled.
        events.push('second-run-start');
        const secondHarness = createHarness();
        await encodeTimelineAudioForDiarization(makeDocument(), {
            signal: new AbortController().signal,
        }, secondHarness.dependencies);
        events.push('second-run-end');
        expect(events).toEqual([
            'add-start',
            'cancel-start',
            'add-settle',
            'cancel-end',
            'second-run-start',
            'second-run-end',
        ]);
    });

    it('reports unavailable browser encoders before allocating any media resources', async () => {
        const harness = createHarness({ selectedCodecs: [null, null] });

        await expect(encodeTimelineAudioForDiarization(makeDocument(), {
            signal: new AbortController().signal,
        }, harness.dependencies)).rejects.toMatchObject({
            name: 'TimelineDiarizationAudioError',
            stage: 'encoding',
            message: 'AAC and Opus audio encoding are unavailable in this browser.',
        });

        expect(harness.dependencies.createTarget).not.toHaveBeenCalled();
        expect(harness.dependencies.createOutput).not.toHaveBeenCalled();
        expect(harness.dependencies.createSource).not.toHaveBeenCalled();
    });
});

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}
