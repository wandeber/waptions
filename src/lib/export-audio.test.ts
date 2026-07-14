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
    audioRenders: [] as Array<{ document: EditorDocumentV3; options: { outputEndSample: number } }>,
    rejectVideoFrame: false,
    rejectAudioRender: false,
}));

vi.mock('mediabunny', () => {
    class BufferTarget {
        buffer: ArrayBuffer | null = new ArrayBuffer(8);
    }
    class Mp4OutputFormat {}
    class WebMOutputFormat {}
    class Output {
        state = 'pending';
        videoTracks: unknown[] = [];
        audioTracks: unknown[] = [];
        target: BufferTarget;
        start = vi.fn(async () => { this.state = 'started'; });
        finalize = vi.fn(async () => { this.state = 'finalized'; });
        cancel = vi.fn(async () => { this.state = 'canceled'; });
        constructor(options: { target: BufferTarget }) {
            this.target = options.target;
            harness.outputs.push(this);
        }
        addVideoTrack(source: unknown): void { this.videoTracks.push(source); }
        addAudioTrack(source: unknown): void { this.audioTracks.push(source); }
    }
    class CanvasSource {
        add = vi.fn(async () => {
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
        BufferTarget,
        CanvasSource,
        Mp4OutputFormat,
        Output,
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
        async render(options: { outputEndSample: number }): Promise<void> {
            harness.audioRenders.push({ document: this.document, options });
            if (harness.rejectAudioRender) throw new Error('audio renderer failed');
        }
    },
}));

vi.mock('./fonts/google-fonts', () => ({ waitForFonts: vi.fn(async () => undefined) }));
vi.mock('./subtitle-renderer', () => ({ renderSubtitles: vi.fn() }));
vi.mock('./video-cache', () => ({
    videoCache: {
        setTargetResolution: vi.fn(),
        getFrameAt: vi.fn(async () => null),
        clearVideo: vi.fn(),
    },
}));

import {
    exportProject,
    getExportContentEndFrame,
    resolveExportVideoPlacement,
} from './export';

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
        audioSources: [],
        audioTracks: [],
        activeSubtitleTrackId: 'subtitles',
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
    };
}

beforeEach(() => {
    harness.outputs.length = 0;
    harness.videoSources.length = 0;
    harness.audioSources.length = 0;
    harness.audioRenders.length = 0;
    harness.rejectVideoFrame = false;
    harness.rejectAudioRender = false;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            createElement: vi.fn(() => ({
                width: 0,
                height: 0,
                getContext: vi.fn(() => ({
                    fillStyle: '',
                    fillRect: vi.fn(),
                    drawImage: vi.fn(),
                })),
            })),
        },
    });
});

describe('v3 export timeline boundaries', () => {
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
            options: { format: 'mp4', quality: 'high', includeAudio: false },
        });

        expect(result.success).toBe(true);
        expect(harness.outputs[0].audioTracks).toHaveLength(0);
        expect(harness.audioSources).toHaveLength(0);
        expect(harness.audioRenders).toHaveLength(0);
        expect(harness.videoSources[0].add).toHaveBeenCalledTimes(3);
        expect(harness.videoSources[0].close).toHaveBeenCalledTimes(1);
    });

    it('always adds requested audio and renders through the exact exclusive content sample', async () => {
        const document = makeDocument();
        const result = await exportProject({
            document,
            options: { format: 'mp4', quality: 'high', includeAudio: true },
        });

        expect(result.success).toBe(true);
        expect(harness.outputs[0].audioTracks).toHaveLength(1);
        expect(harness.audioRenders[0].options.outputEndSample).toBe(72_000);
        expect(harness.audioSources[0].close).toHaveBeenCalledTimes(1);
        expect(harness.outputs[0].finalize).toHaveBeenCalledTimes(1);
    });

    it('closes sources and cancels the output when frame or audio rendering fails', async () => {
        harness.rejectVideoFrame = true;
        const videoFailure = await exportProject({
            document: makeDocument(),
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
            options: { format: 'mp4', quality: 'high', includeAudio: true },
        });
        expect(audioFailure).toMatchObject({ success: false, error: 'audio renderer failed' });
        expect(harness.videoSources[1].close).toHaveBeenCalledTimes(1);
        expect(harness.audioSources[1].close).toHaveBeenCalledTimes(1);
        expect(harness.outputs[1].cancel).toHaveBeenCalledTimes(1);
    });

    it('returns the cancellation contract and closes active encoder resources', async () => {
        let checks = 0;
        const result = await exportProject({
            document: makeDocument(),
            options: {
                format: 'mp4',
                quality: 'high',
                includeAudio: true,
                // The first check happens before encoder setup; the second cancels immediately
                // before the first frame, after both requested track sources exist.
                onCancel: () => ++checks >= 2,
            },
        });

        expect(result).toEqual({ success: false, cancelled: true });
        expect(harness.videoSources[0].close).toHaveBeenCalledTimes(1);
        expect(harness.audioSources[0].close).toHaveBeenCalledTimes(1);
        expect(harness.outputs[0].cancel).toHaveBeenCalledTimes(1);
        expect(harness.outputs[0].finalize).not.toHaveBeenCalled();
    });
});
