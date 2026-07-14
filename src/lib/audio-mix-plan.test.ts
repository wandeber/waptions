import type { AudioSourceAsset, EditorDocumentV3, VideoSourceAssetV3 } from '@/types/video';
import { describe, expect, it } from 'vitest';
import { buildAudioMixPlan, decibelsToLinear, getAudioMixPlanDurationSeconds } from './audio-mix-plan';
import { createDefaultRenderProfile } from './render-profile';

const fakeFile = {} as File;

const videoSource: VideoSourceAssetV3 = {
    id: 'video_source',
    originalName: 'video.mp4',
    mimeType: 'video/mp4',
    size: 1,
    lastModified: 1,
    fingerprint: 'video_fingerprint',
    duration: 2,
    fps: 30,
    width: 1920,
    height: 1080,
    bitrate: null,
    hasAudio: true,
    file: fakeFile,
};

const audioSource: AudioSourceAsset = {
    id: 'audio_source',
    originalName: 'voice.wav',
    mimeType: 'audio/wav',
    size: 1,
    lastModified: 1,
    fingerprint: 'audio_fingerprint',
    duration: 2,
    nativeSampleRate: 44_100,
    nativeSampleCount: 88_200,
    nativeChannelCount: 1,
    bitrate: null,
    codec: 'pcm',
    file: fakeFile,
};

function makeDocument(overrides: Partial<EditorDocumentV3> = {}): EditorDocumentV3 {
    return {
        version: 3,
        revision: 1,
        audioGraphRevision: 1,
        renderProfile: createDefaultRenderProfile(),
        subtitleTracks: [],
        videoSources: [videoSource],
        videoClips: [{
            id: 'video_a',
            sourceId: videoSource.id,
            sourceStart: 0.25,
            sourceEnd: 0.75,
            audio: { linkState: 'linked', muted: false, gainDb: -6, fadeInFrames: 3, fadeOutFrames: 3 },
        }, {
            id: 'video_b',
            sourceId: videoSource.id,
            sourceStart: 1,
            sourceEnd: 1.5,
            audio: { linkState: 'detached', muted: false, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0 },
        }],
        audioSources: [audioSource],
        audioTracks: [{
            id: 'voice_track',
            name: 'Voice',
            muted: false,
            solo: false,
            locked: false,
            gainDb: -3,
            clips: [{
                id: 'voice_clip',
                source: { kind: 'audio-source', audioSourceId: audioSource.id },
                timelineStartFrame: 15,
                sourceStartSample: 0,
                sourceEndSample: 44_100,
                muted: false,
                gainDb: -12,
                fadeInSamples: 441,
                fadeOutSamples: 882,
            }],
        }, {
            id: 'detached_track',
            name: 'Detached',
            muted: false,
            solo: false,
            locked: false,
            gainDb: -2,
            clips: [{
                id: 'detached_clip',
                source: { kind: 'video-source-audio', videoSourceId: videoSource.id },
                timelineStartFrame: 30,
                sourceStart: 1,
                sourceEnd: 1.5,
                muted: false,
                gainDb: -1,
                fadeInFrames: 0,
                fadeOutFrames: 0,
            }],
        }],
        activeSubtitleTrackId: null,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
        ...overrides,
    };
}

describe('buildAudioMixPlan', () => {
    it('mixes linked video once and represents detached/imported audio with typed references', () => {
        const plan = buildAudioMixPlan(makeDocument());

        expect(plan.videoSampleCount).toBe(48_000);
        expect(plan.totalSampleCount).toBe(72_000);
        expect(getAudioMixPlanDurationSeconds(plan)).toBe(1.5);
        expect(plan.contributors).toHaveLength(3);
        expect(plan.contributors[0]).toMatchObject({
            kind: 'embedded-video',
            source: { kind: 'video-source-audio', videoSourceId: 'video_source' },
            outputStartSample: 0,
            outputEndSample: 24_000,
            sourceRange: { domain: 'seconds', startSeconds: 0.25, endSeconds: 0.75 },
            fadeInSamples: 4_800,
            fadeOutSamples: 4_800,
            gainLinear: decibelsToLinear(-6),
        });
        expect(plan.contributors[1]).toMatchObject({
            source: { kind: 'audio-source', audioSourceId: 'audio_source' },
            outputStartSample: 24_000,
            outputEndSample: 72_000,
            gainLinear: decibelsToLinear(-15),
        });
        expect(plan.contributors[2]).toMatchObject({
            source: { kind: 'video-source-audio', videoSourceId: 'video_source' },
            outputStartSample: 48_000,
            outputEndSample: 72_000,
            gainLinear: decibelsToLinear(-3),
        });
        expect(plan.contributors.filter((item) => item.id.includes('video_b'))).toEqual([]);
    });

    it('lets an effective track solo suppress linked video and every non-solo track', () => {
        const document = makeDocument();
        document.audioTracks[0].solo = true;
        expect(buildAudioMixPlan(document).contributors.map((item) => item.source.kind)).toEqual(['audio-source']);

        document.audioTracks[0].muted = true;
        expect(buildAudioMixPlan(document).contributors.map((item) => item.kind)).toEqual([
            'embedded-video',
            'independent-audio',
        ]);
    });

    it('applies track and clip gain exactly once', () => {
        const plan = buildAudioMixPlan(makeDocument());
        expect(plan.contributors.find((item) => item.id.includes('voice_clip'))?.gainLinear)
            .toBe(decibelsToLinear(-15));
        expect(plan.contributors.find((item) => item.id.includes('detached_clip'))?.gainLinear)
            .toBe(decibelsToLinear(-3));
    });

    it('rounds v3 video crops to the nearest canonical frame instead of ceiling them', () => {
        const document = makeDocument({
            videoClips: [{
                id: 'short_video',
                sourceId: videoSource.id,
                sourceStart: 0,
                sourceEnd: 1.4 / 30,
                audio: { linkState: 'linked', muted: false, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0 },
            }],
            audioTracks: [],
        });
        const plan = buildAudioMixPlan(document);
        expect(plan.videoSampleCount).toBe(1_600);
        expect(plan.contributors[0]).toMatchObject({ outputStartSample: 0, outputEndSample: 1_600 });
    });
});
