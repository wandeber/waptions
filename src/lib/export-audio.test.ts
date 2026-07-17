import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorDocumentV3 } from '@/types/video';

const harness = vi.hoisted(() => ({
    outputs: [] as Array<{
        state: string;
        videoTracks: unknown[];
        audioTracks: unknown[];
        start: ReturnType<typeof vi.fn>;
        finalize: ReturnType<typeof vi.fn>;
        cancel: ReturnType<typeof vi.fn>;
    }>,
    videoSources: [] as Array<{
        add: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    }>,
    audioSources: [] as Array<{
        add: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    }>,
    audioRenders: [] as Array<{
        document: EditorDocumentV3;
        options: { outputEndSample: number; signal?: AbortSignal; onProgress?: (value: number) => void };
    }>,
    videoSessions: [] as Array<{
        request: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
    }>,
    rejectVideoFrame: false,
    rejectAudioRender: false,
    onVideoAdd: null as (() => void) | null,
    onFontWait: null as (() => void) | null,
    onOutputStart: null as (() => void) | null,
    onAudioRender: null as (() => void) | null,
    onFinalize: null as (() => void) | null,
    returnDecodedFrame: false,
    drawImage: vi.fn(),
    contextAvailable: true,
}));

const previewCache = vi.hoisted(() => ({
    getFrameAt: vi.fn(),
    setTargetResolution: vi.fn(),
    clearVideo: vi.fn(),
}));

const destinationHarness = vi.hoisted(() => ({
    failMemoryMaterialization: false,
    memoryMaterializations: 0,
    abortReasons: [] as unknown[],
}));

vi.mock('mediabunny', () => {
    class StreamTarget {
        constructor(
            readonly writable: WritableStream<{
                type: 'write'; data: Uint8Array<ArrayBuffer>; position: number;
            }>,
        ) {}
    }
    class Mp4OutputFormat {}
    class WebMOutputFormat {}
    class Output {
        state = 'pending';
        videoTracks: unknown[] = [];
        audioTracks: unknown[] = [];
        target: StreamTarget;
        start = vi.fn(async () => {
            this.state = 'started';
            harness.onOutputStart?.();
        });
        finalize = vi.fn(async () => {
            this.state = 'finalizing';
            harness.onFinalize?.();
            await Promise.resolve();
            if (this.target instanceof StreamTarget) {
                const writer = this.target.writable.getWriter();
                await writer.write({
                    type: 'write', data: new Uint8Array([1, 2, 3]), position: 4,
                });
                await writer.close();
            }
            this.state = 'finalized';
        });
        cancel = vi.fn(async () => {
            // Before start, Mediabunny has not acquired StreamTarget's writer and Output.cancel()
            // cannot close it. The export destination's independent cleanup owns that gap.
            if (this.target instanceof StreamTarget && this.state === 'started') {
                await this.target.writable.getWriter().close();
            }
            this.state = 'canceled';
        });
        constructor(options: { target: StreamTarget }) {
            this.target = options.target;
            harness.outputs.push(this);
        }
        addVideoTrack(source: unknown): void { this.videoTracks.push(source); }
        addAudioTrack(source: unknown): void { this.audioTracks.push(source); }
    }
    class CanvasSource {
        add = vi.fn(async () => {
            harness.onVideoAdd?.();
            if (harness.rejectVideoFrame) throw new Error('video encoder failed');
        });
        close = vi.fn();
        constructor() { harness.videoSources.push(this); }
    }
    class AudioSampleSource {
        add = vi.fn(async () => undefined);
        close = vi.fn();
        constructor() { harness.audioSources.push(this); }
    }
    return {
        AudioSampleSource,
        CanvasSource,
        Mp4OutputFormat,
        Output,
        StreamTarget,
        WebMOutputFormat,
        getFirstEncodableAudioCodec: vi.fn(async () => 'aac'),
    };
});

vi.mock('./timeline-audio-renderer', () => ({
    TimelineAudioRenderer: class {
        constructor(
            private readonly document: EditorDocumentV3,
            source: unknown,
        ) { void source; }
        async render(options: {
            outputEndSample: number;
            signal?: AbortSignal;
            onProgress?: (value: number) => void;
        }): Promise<void> {
            harness.audioRenders.push({ document: this.document, options });
            harness.onAudioRender?.();
            if (options.signal?.aborted) {
                const error = new Error('cancelled');
                error.name = 'AbortError';
                throw error;
            }
            if (harness.rejectAudioRender) throw new Error('audio renderer failed');
            options.onProgress?.(1);
        }
    },
}));

vi.mock('./video-frame-session', () => ({
    VideoFrameSession: {
        open: vi.fn(async () => {
            const session = {
                request: vi.fn(async () => harness.returnDecodedFrame ? ({
                    canvas: {} as HTMLCanvasElement,
                    timestamp: 0,
                    duration: 0.5,
                }) : null),
                dispose: vi.fn(async () => undefined),
            };
            harness.videoSessions.push(session);
            return session;
        }),
    },
}));

vi.mock('./video-cache', () => ({ videoCache: previewCache }));
vi.mock('./fonts/google-fonts', () => ({
    waitForFonts: vi.fn(async () => { harness.onFontWait?.(); }),
}));
vi.mock('./subtitle-renderer', () => ({ renderSubtitles: vi.fn() }));
vi.mock('./export-destination', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./export-destination')>();
    return {
        ...actual,
        createExportDestinationRuntime: (
            ...args: Parameters<typeof actual.createExportDestinationRuntime>
        ) => {
            const runtime = actual.createExportDestinationRuntime(...args);
            if (!destinationHarness.failMemoryMaterialization || runtime.kind !== 'memory') {
                return runtime;
            }
            return {
                ...runtime,
                getMemoryBuffer: () => {
                    destinationHarness.memoryMaterializations += 1;
                    throw new Error('final materialization failed');
                },
                abort: async (reason?: unknown) => {
                    destinationHarness.abortReasons.push(reason);
                    await runtime.abort(reason);
                },
            };
        },
    };
});
import {
    exportProject,
    getExportContentEndFrame,
    resolveExportVideoPlacement,
} from './export';
import { runtimeDiagnostics } from './runtime-diagnostics';

const fakeFile = {} as File;

function subtitleStyle() {
    return {
        fadeInDuration: 0, fadeOutDuration: 0, initialScale: 1, bounceStrength: 0,
        useElasticEffect: false, fontSize: 24, textColor: '#fff', strokeWidth: 0,
        strokeColor: '#000', fontWeight: 400, textCase: 'normal' as const,
        textAlign: 'center' as const, hidePunctuation: false, punctuationChars: '',
        removeAccents: false, fontFamily: 'Arial', numberOfLines: 1,
        position: { x: 50, y: 80 }, backgroundColor: '#000', backgroundOpacity: 0,
        backgroundBorderColor: '#000', backgroundBorderWidth: 0,
        backgroundMarginVertical: 0, backgroundMarginHorizontal: 0,
        backgroundBorderRadius: 0, backgroundOffsetX: 0, backgroundOffsetY: 0,
    };
}

function makeDocument(): EditorDocumentV3 {
    return {
        version: 3,
        revision: 1,
        audioGraphRevision: 1,
        renderProfile: {
            fps: { numerator: 2, denominator: 1 }, width: 16, height: 16,
            audioSampleRate: 48_000, isFrameRateLocked: true, isCanvasSizeLocked: true,
        },
        subtitleTracks: [{
            id: 'subtitles', name: 'Subtitles', style: subtitleStyle(), isVisible: true,
            isLocked: false, timingDomain: 'absolute',
            subtitles: [{ id: 'subtitle', startTime: 0.5, endTime: 1.5, text: 'Tail' }],
        }],
        videoSources: [{
            id: 'video', originalName: 'video.mp4', mimeType: 'video/mp4', size: 1,
            lastModified: 1, fingerprint: 'video-fingerprint', duration: 1, fps: 2,
            width: 16, height: 16, bitrate: 1_000_000, hasAudio: false, file: fakeFile,
        }],
        videoClips: [{ id: 'clip', sourceId: 'video', sourceStart: 0, sourceEnd: 0.5, audio: null }],
        videoTracks: [{ id: 'video_track_1', name: 'Video 1', clipIds: ['clip'] }],
        audioSources: [],
        audioTracks: [],
        activeSubtitleTrackId: 'subtitles',
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
    };
}

beforeEach(() => {
    runtimeDiagnostics.reset();
    harness.outputs.length = 0;
    harness.videoSources.length = 0;
    harness.audioSources.length = 0;
    harness.audioRenders.length = 0;
    harness.videoSessions.length = 0;
    harness.rejectVideoFrame = false;
    harness.rejectAudioRender = false;
    harness.onVideoAdd = null;
    harness.onFontWait = null;
    harness.onOutputStart = null;
    harness.onAudioRender = null;
    harness.onFinalize = null;
    harness.returnDecodedFrame = false;
    harness.drawImage.mockClear();
    harness.contextAvailable = true;
    destinationHarness.failMemoryMaterialization = false;
    destinationHarness.memoryMaterializations = 0;
    destinationHarness.abortReasons.length = 0;
    previewCache.getFrameAt.mockClear();
    previewCache.setTargetResolution.mockClear();
    previewCache.clearVideo.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            createElement: vi.fn(() => ({
                width: 0,
                height: 0,
                getContext: vi.fn(() => harness.contextAvailable ? ({
                    fillStyle: '',
                    fillRect: vi.fn(),
                    drawImage: harness.drawImage,
                }) : null),
            })),
        },
    });
});

describe('v3 export timeline boundaries', () => {
    const memoryDestination = () => ({
        kind: 'memory' as const,
        estimatedBytes: 8,
        maximumBytes: 16 * 1024 * 1024,
        memoryAllowanceBytes: 32 * 1024 * 1024,
    });

    it('uses the maximum video/subtitle/independent-audio frame and selects black visual tail frames', () => {
        const document = makeDocument();
        expect(getExportContentEndFrame(document)).toBe(3);
        expect(resolveExportVideoPlacement(document, 0)?.clip.id).toBe('clip');
        expect(resolveExportVideoPlacement(document, 1)).toBeNull();
        expect(resolveExportVideoPlacement(document, 2)).toBeNull();

        document.subtitleTracks[0].subtitles = [];
        document.renderProfile.fps = { numerator: 30, denominator: 1 };
        document.videoClips[0].sourceEnd = 1 / 30;
        document.audioSources = [{
            id: 'audio', originalName: 'tail.wav', mimeType: 'audio/wav', size: 1,
            lastModified: 1, fingerprint: 'audio-fingerprint', duration: 1,
            nativeSampleRate: 48_000, nativeSampleCount: 48_000, nativeChannelCount: 1,
            bitrate: null, codec: 'pcm', file: fakeFile,
        }];
        document.audioTracks = [{
            id: 'audio-track', name: 'Audio', muted: false, solo: false, locked: false,
            gainDb: 0,
            clips: [{
                id: 'audio-clip', source: { kind: 'audio-source', audioSourceId: 'audio' },
                timelineStartFrame: 4, sourceStartSample: 0, sourceEndSample: 1,
                muted: false, gainDb: 0, fadeInSamples: 0, fadeOutSamples: 0,
            }],
        }];
        expect(getExportContentEndFrame(document)).toBe(5);
    });

    it('omits the audio track completely when includeAudio is false', async () => {
        const result = await exportProject({
            document: makeDocument(),
            destination: memoryDestination(),
            options: { format: 'mp4', quality: 'high', includeAudio: false },
        });

        expect(result.success).toBe(true);
        expect(harness.outputs[0].audioTracks).toHaveLength(0);
        expect(harness.audioSources).toHaveLength(0);
        expect(harness.audioRenders).toHaveLength(0);
        expect(harness.videoSources[0].add).toHaveBeenCalledTimes(3);
        expect(harness.videoSources[0].close).toHaveBeenCalledTimes(1);
    });

    it('returns streamed completion without allocating a downloadable artifact', async () => {
        const write = vi.fn(async () => undefined);
        const close = vi.fn(async () => undefined);
        const result = await exportProject({
            document: makeDocument(),
            destination: {
                kind: 'stream',
                writable: new WritableStream({ write, close }),
            },
            options: { format: 'mp4', quality: 'high', includeAudio: false },
        });

        expect(result).toEqual({ success: true, delivery: 'streamed', bytesWritten: 7 });
        expect(write).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
        expect('buffer' in result).toBe(false);
    });

    it('keeps failure ownership when final memory materialization throws', async () => {
        destinationHarness.failMemoryMaterialization = true;

        const result = await exportProject({
            document: makeDocument(),
            destination: memoryDestination(),
            options: { format: 'mp4', quality: 'high', includeAudio: false },
        });

        expect(result).toEqual({ success: false, error: 'final materialization failed' });
        expect(destinationHarness.memoryMaterializations).toBe(1);
        expect(destinationHarness.abortReasons).toHaveLength(1);
        expect(destinationHarness.abortReasons[0]).toMatchObject({
            message: 'final materialization failed',
        });
        expect(harness.outputs[0].finalize).toHaveBeenCalledTimes(1);
        expect(harness.outputs[0].cancel).not.toHaveBeenCalled();
        expect(harness.videoSources[0].close).toHaveBeenCalledTimes(1);
        expect(runtimeDiagnostics.snapshot().counters.export).toMatchObject({
            started: 1,
            completed: 0,
            failed: 1,
            aborted: 0,
            streamed: 0,
            memoryFallback: 0,
        });
    });

    it('aborts an authorized stream when setup fails before Output.start owns its writer', async () => {
        harness.contextAvailable = false;
        const abort = vi.fn(async () => undefined);
        const result = await exportProject({
            document: makeDocument(),
            destination: {
                kind: 'stream',
                writable: new WritableStream({ abort }),
            },
            options: { format: 'mp4', quality: 'high', includeAudio: false },
        });

        expect(result).toMatchObject({
            success: false,
            error: 'Failed to create canvas context.',
        });
        expect(harness.outputs[0].start).not.toHaveBeenCalled();
        expect(harness.outputs[0].cancel).toHaveBeenCalledTimes(1);
        expect(abort).toHaveBeenCalledTimes(1);
        expect(runtimeDiagnostics.snapshot().counters.export.streamed).toBe(0);
    });

    it.each([
        'pre-aborted signal',
        'empty timeline',
        'missing source',
        'snapshot failure',
        'font cancellation',
    ] as const)('terminally aborts an authorized writer during %s', async (scenario) => {
        const controller = new AbortController();
        const document = makeDocument();
        if (scenario === 'pre-aborted signal') controller.abort();
        if (scenario === 'empty timeline') document.videoClips = [];
        if (scenario === 'missing source') document.videoClips[0].sourceId = 'missing';
        if (scenario === 'snapshot failure') {
            Object.defineProperty(document, 'videoClips', {
                configurable: true,
                enumerable: true,
                get: () => { throw new Error('snapshot failed'); },
            });
        }
        if (scenario === 'font cancellation') harness.onFontWait = () => controller.abort();
        const abort = vi.fn(async () => undefined);
        const close = vi.fn(async () => undefined);

        const result = await exportProject({
            document,
            destination: {
                kind: 'stream',
                writable: new WritableStream({ abort, close }),
            },
            options: {
                format: 'mp4', quality: 'high', includeAudio: false, signal: controller.signal,
            },
        });

        expect(result.success).toBe(false);
        expect(harness.outputs).toHaveLength(0);
        expect(abort).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });

    it('uses one source-aspect export session at a time and contains each active frame once', async () => {
        const document = makeDocument();
        harness.returnDecodedFrame = true;
        document.videoSources.push({
            ...document.videoSources[0],
            id: 'video-two',
            fingerprint: 'video-two-fingerprint',
            originalName: 'video-two.mp4',
        });
        document.videoClips.push({
            id: 'clip-two', sourceId: 'video-two', sourceStart: 0, sourceEnd: 0.5, audio: null,
        });

        const result = await exportProject({
            document,
            destination: memoryDestination(),
            options: { format: 'mp4', quality: 'high', includeAudio: false },
        });

        expect(result.success).toBe(true);
        expect(harness.videoSessions).toHaveLength(2);
        harness.videoSessions.forEach((session) => {
            expect(session.request).toHaveBeenCalledTimes(1);
            expect(session.dispose).toHaveBeenCalledTimes(1);
        });
        expect(harness.drawImage).toHaveBeenCalledTimes(2);
        expect(previewCache.getFrameAt).not.toHaveBeenCalled();
    });

    it('always adds requested audio and renders through the exact exclusive content sample', async () => {
        const document = makeDocument();
        const result = await exportProject({
            document,
            destination: memoryDestination(),
            options: { format: 'mp4', quality: 'high', includeAudio: true },
        });

        expect(result.success).toBe(true);
        expect(harness.outputs[0].audioTracks).toHaveLength(1);
        expect(harness.audioRenders[0].options.outputEndSample).toBe(72_000);
        expect(harness.audioSources[0].close).toHaveBeenCalledTimes(1);
        expect(harness.outputs[0].finalize).toHaveBeenCalledTimes(1);
        expect(runtimeDiagnostics.snapshot()).toMatchObject({
            counters: {
                export: {
                    started: 1,
                    completed: 1,
                    memoryFallback: 1,
                    framesRendered: 3,
                    audioBlocksRendered: 1,
                },
            },
            gauges: { export: { bufferedBytes: 0 } },
        });
    });

    it('passes the full linked, detached, and imported audio graph without touching preview cache', async () => {
        const document = makeDocument();
        document.videoSources[0].hasAudio = true;
        document.videoClips[0].audio = {
            linkState: 'linked', muted: false, gainDb: -2, fadeInFrames: 1, fadeOutFrames: 1,
        };
        document.audioSources = [{
            id: 'audio', originalName: 'music.wav', mimeType: 'audio/wav', size: 1,
            lastModified: 1, fingerprint: 'audio-fingerprint', duration: 1,
            nativeSampleRate: 48_000, nativeSampleCount: 48_000, nativeChannelCount: 2,
            bitrate: 128_000, codec: 'pcm', file: fakeFile,
        }];
        document.audioTracks = [{
            id: 'mix', name: 'Mix', muted: false, solo: false, locked: false, gainDb: -1,
            clips: [{
                id: 'detached', source: { kind: 'video-source-audio', videoSourceId: 'video' },
                timelineStartFrame: 0, sourceStart: 0, sourceEnd: 0.5, muted: false, gainDb: 0,
                fadeInFrames: 0, fadeOutFrames: 0,
            }, {
                id: 'music', source: { kind: 'audio-source', audioSourceId: 'audio' },
                timelineStartFrame: 0, sourceStartSample: 0, sourceEndSample: 1, muted: false,
                gainDb: -3, fadeInSamples: 0, fadeOutSamples: 0,
            }],
        }];

        const result = await exportProject({
            document,
            destination: memoryDestination(),
            options: { format: 'mp4', quality: 'high', includeAudio: true },
        });

        expect(result.success).toBe(true);
        expect(harness.audioRenders[0].document.videoClips[0].audio?.linkState).toBe('linked');
        expect(harness.audioRenders[0].document.audioTracks[0].clips).toHaveLength(2);
        expect(previewCache.getFrameAt).not.toHaveBeenCalled();
        expect(previewCache.setTargetResolution).not.toHaveBeenCalled();
        expect(previewCache.clearVideo).not.toHaveBeenCalled();
    });

    it('closes sources and cancels the output when frame or audio rendering fails', async () => {
        harness.rejectVideoFrame = true;
        const videoFailure = await exportProject({
            document: makeDocument(),
            destination: memoryDestination(),
            options: { format: 'mp4', quality: 'high', includeAudio: true },
        });
        expect(videoFailure).toMatchObject({ success: false, error: 'video encoder failed' });
        expect(harness.videoSources[0].close).toHaveBeenCalledTimes(1);
        expect(harness.audioSources[0].close).toHaveBeenCalledTimes(1);
        expect(harness.outputs[0].cancel).toHaveBeenCalledTimes(1);

        harness.rejectVideoFrame = false;
        harness.rejectAudioRender = true;
        const audioFailure = await exportProject({
            document: makeDocument(),
            destination: memoryDestination(),
            options: { format: 'mp4', quality: 'high', includeAudio: true },
        });
        expect(audioFailure).toMatchObject({ success: false, error: 'audio renderer failed' });
        expect(harness.videoSources[1].close).toHaveBeenCalledTimes(1);
        expect(harness.audioSources[1].close).toHaveBeenCalledTimes(1);
        expect(harness.outputs[1].cancel).toHaveBeenCalledTimes(1);
    });

    it('returns the cancellation contract and closes active encoder resources', async () => {
        const controller = new AbortController();
        harness.onVideoAdd = () => controller.abort();
        const result = await exportProject({
            document: makeDocument(),
            destination: memoryDestination(),
            options: {
                format: 'mp4',
                quality: 'high',
                includeAudio: true,
                signal: controller.signal,
            },
        });

        expect(result).toEqual({ success: false, cancelled: true });
        expect(harness.videoSources[0].close).toHaveBeenCalledTimes(1);
        expect(harness.audioSources[0].close).toHaveBeenCalledTimes(1);
        expect(harness.outputs[0].cancel).toHaveBeenCalledTimes(1);
        expect(harness.outputs[0].finalize).not.toHaveBeenCalled();
        expect(runtimeDiagnostics.snapshot().counters.export.aborted).toBe(1);
    });

    it.each([
        ['font loading', 'onFontWait', 0],
        ['output startup', 'onOutputStart', 1],
        ['video encoding', 'onVideoAdd', 1],
        ['audio rendering', 'onAudioRender', 1],
        ['finalization', 'onFinalize', 1],
    ] as const)('propagates AbortSignal through %s and performs terminal cleanup', async (
        _label,
        hook,
        expectedOutputs,
    ) => {
        const controller = new AbortController();
        harness[hook] = () => controller.abort();

        const result = await exportProject({
            document: makeDocument(),
            destination: memoryDestination(),
            options: {
                format: 'mp4', quality: 'high', includeAudio: true, signal: controller.signal,
            },
        });

        expect(result).toEqual({ success: false, cancelled: true });
        expect(harness.outputs).toHaveLength(expectedOutputs);
        harness.videoSources.forEach((source) => expect(source.close).toHaveBeenCalledTimes(1));
        harness.audioSources.forEach((source) => expect(source.close).toHaveBeenCalledTimes(1));
        harness.videoSessions.forEach((session) => expect(session.dispose).toHaveBeenCalledTimes(1));
        harness.outputs.forEach((output) => {
            expect(output.finalize.mock.calls.length + output.cancel.mock.calls.length).toBe(1);
        });
    });
});
