import type { AnimationStyle, SubtitleTrackV4 } from '@/types/timeline';
import type {
    AudioSourceDescriptor,
    EditorManifestV4,
    VideoSourceDescriptorV3,
} from '@/types/video';
import type {
    HeadlessMediaIdentity,
    HeadlessRenderSnapshotV1,
} from '../render-plan';

export const TEST_SUBTITLE_STYLE: AnimationStyle = {
    fadeInDuration: 0,
    fadeOutDuration: 0,
    initialScale: 1,
    bounceStrength: 0,
    useElasticEffect: false,
    fontSize: 48,
    textColor: '#ffffff',
    strokeWidth: 0,
    strokeColor: '#000000',
    fontWeight: 700,
    textCase: 'normal',
    textAlign: 'center',
    hidePunctuation: false,
    punctuationChars: '.,',
    removeAccents: false,
    fontFamily: 'Arial',
    numberOfLines: 2,
    position: { x: 50, y: 80 },
    backgroundColor: '#000000',
    backgroundOpacity: 0,
    backgroundBorderColor: '#000000',
    backgroundBorderWidth: 0,
    backgroundMarginVertical: 8,
    backgroundMarginHorizontal: 16,
    backgroundBorderRadius: 0,
    backgroundOffsetX: 0,
    backgroundOffsetY: 0,
};

export function createHeadlessRenderSnapshotFixture(
    overrides: Partial<EditorManifestV4> = {},
): HeadlessRenderSnapshotV1 {
    const red = videoSource({
        id: 'video-red',
        originalName: 'red.webm',
        fingerprint: 'sha256:red',
        duration: 4,
        width: 320,
        height: 180,
        hasAudio: true,
    });
    const blue = videoSource({
        id: 'video-blue',
        originalName: 'blue.webm',
        fingerprint: 'sha256:blue',
        duration: 4,
        width: 180,
        height: 320,
        hasAudio: false,
    });
    const imported = audioSource();
    const manifest: EditorManifestV4 = {
        version: 4,
        revision: 7,
        audioGraphRevision: 3,
        renderProfile: {
            fps: { numerator: 30, denominator: 1 },
            width: 320,
            height: 180,
            audioSampleRate: 48_000,
            isFrameRateLocked: true,
            isCanvasSizeLocked: true,
        },
        subtitleTracks: [
            subtitleTrack({
                id: 'visible-subtitles',
                subtitles: [{ id: 'subtitle-visible', startTime: 2.4, endTime: 3, text: 'Visible' }],
            }),
            subtitleTrack({
                id: 'hidden-subtitles',
                isVisible: false,
                subtitles: [{ id: 'subtitle-hidden', startTime: 3.5, endTime: 4, text: 'Hidden tail' }],
            }),
        ],
        videoSourceDescriptors: [red, blue],
        videoClips: [
            {
                id: 'red-lower',
                sourceId: red.id,
                trackId: 'lower',
                timelineStartFrame: 0,
                sourceStart: 0,
                sourceEnd: 1,
                audio: {
                    linkState: 'linked',
                    muted: false,
                    gainDb: -2,
                    fadeInFrames: 2,
                    fadeOutFrames: 2,
                },
            },
            {
                id: 'red-top',
                sourceId: red.id,
                trackId: 'top',
                timelineStartFrame: 10,
                sourceStart: 1,
                sourceEnd: 1.5,
                audio: {
                    linkState: 'linked',
                    muted: false,
                    gainDb: 0,
                    fadeInFrames: 0,
                    fadeOutFrames: 0,
                },
            },
            {
                id: 'blue-lower',
                sourceId: blue.id,
                trackId: 'lower',
                timelineStartFrame: 45,
                sourceStart: 0,
                sourceEnd: 1,
                audio: null,
            },
        ],
        videoTracks: [
            { id: 'top', name: 'Top', visible: true, locked: true },
            { id: 'lower', name: 'Lower', visible: true, locked: false },
        ],
        audioSourceDescriptors: [imported],
        audioTracks: [{
            id: 'audio-main',
            name: 'Audio',
            muted: false,
            solo: false,
            locked: false,
            gainDb: -1,
            clips: [{
                id: 'imported-tail',
                source: { kind: 'audio-source', audioSourceId: imported.id },
                timelineStartFrame: 80,
                sourceStartSample: 0,
                sourceEndSample: 16_000,
                timelineDurationSamples: 48_000,
                muted: false,
                gainDb: -3,
                fadeInSamples: 1_000,
                fadeOutSamples: 2_000,
            }],
        }],
        activeSubtitleTrackId: 'visible-subtitles',
        transcriptionByTrackId: {},
        globalEditingMode: 'ripple',
        editorialTranscriptDescriptors: [],
        narrative: null,
        dependentLinks: [],
        ...overrides,
    };
    return {
        version: 1,
        snapshotId: 'sha256:test-render-snapshot',
        manifest,
        sourceIdentities: [
            identity('video', red),
            identity('video', blue),
            identity('audio', imported),
        ],
    };
}

export function createEmptyDiagnostics() {
    return {
        peakDecodedPixelBytes: 0,
        peakAudioMixBytes: 0,
        peakVideoDecoderSessions: 0,
        canvasFrames: 0,
    };
}

function subtitleTrack(overrides: Partial<SubtitleTrackV4>): SubtitleTrackV4 {
    return {
        id: 'subtitles',
        name: 'Subtitles',
        style: { ...TEST_SUBTITLE_STYLE },
        subtitles: [],
        isVisible: true,
        isLocked: false,
        unlinkedVideoEditResponse: 'stay-absolute',
        ...overrides,
    };
}

function videoSource(
    overrides: Partial<VideoSourceDescriptorV3>,
): VideoSourceDescriptorV3 {
    return {
        id: 'video',
        originalName: 'video.webm',
        mimeType: 'video/webm',
        size: 1_024,
        lastModified: 1_700_000_000_000,
        fingerprint: 'sha256:video',
        duration: 4,
        fps: 30,
        width: 320,
        height: 180,
        bitrate: 1_000_000,
        hasAudio: true,
        ...overrides,
    };
}

function audioSource(): AudioSourceDescriptor {
    return {
        id: 'audio-imported',
        originalName: 'imported.wav',
        mimeType: 'audio/wav',
        size: 32_044,
        lastModified: 1_700_000_000_000,
        fingerprint: 'sha256:audio',
        duration: 1,
        nativeSampleRate: 16_000,
        nativeSampleCount: 16_000,
        nativeChannelCount: 1,
        bitrate: 256_000,
        codec: 'pcm_s16le',
    };
}

function identity(
    kind: HeadlessMediaIdentity['kind'],
    source: {
        id: string;
        fingerprint: string;
        size: number;
        lastModified: number;
    },
): HeadlessMediaIdentity {
    return {
        kind,
        sourceId: source.id,
        byteSourceCapabilityId: `media-capability:${source.id}`,
        fingerprint: source.fingerprint,
        size: source.size,
        lastModified: source.lastModified,
    };
}
