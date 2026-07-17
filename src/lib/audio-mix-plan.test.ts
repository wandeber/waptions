import type { AudioSourceAsset, EditorDocumentV3, VideoSourceAssetV3 } from '@/types/video';
import { describe, expect, it } from 'vitest';
import { buildAudioMixPlan, decibelsToLinear, getAudioMixPlanDurationSeconds } from './audio-mix-plan';
import { renderAudioMixPlan } from './audio-dsp';
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
        videoTracks: [{ id: 'video_track_1', name: 'Video 1', clipIds: ['video_a', 'video_b'] }],
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

    it('uses explicit imported-audio frame occupancy while preserving its native crop', () => {
        const document = makeDocument();
        document.renderProfile.fps = { numerator: 30_000, denominator: 1_001 };
        document.videoClips = [];
        document.audioTracks = [{
            id: 'trimmed_track',
            name: 'Trimmed',
            muted: false,
            solo: false,
            locked: false,
            gainDb: 0,
            clips: [{
                id: 'trimmed_clip',
                source: { kind: 'audio-source', audioSourceId: audioSource.id },
                timelineStartFrame: 4,
                timelineDurationSamples: 1_602,
                sourceStartSample: 5_885,
                sourceEndSample: 7_357,
                muted: false,
                gainDb: 0,
                fadeInSamples: 0,
                fadeOutSamples: 0,
            }],
        }];

        expect(buildAudioMixPlan(document).contributors[0]).toMatchObject({
            outputStartSample: 6_406,
            outputEndSample: 8_008,
            sourceRange: { domain: 'native-samples', startSample: 5_885, endSample: 7_357 },
        });
    });

    it('preserves total render duration and a contiguous seam after a broadcast-rate split', async () => {
        const original = makeDocument();
        original.renderProfile.fps = { numerator: 30_000, denominator: 1_001 };
        original.videoClips = [];
        original.audioTracks = [{
            id: 'original_track',
            name: 'Original',
            muted: false,
            solo: false,
            locked: false,
            gainDb: 0,
            clips: [{
                id: 'original_clip',
                source: { kind: 'audio-source', audioSourceId: audioSource.id },
                timelineStartFrame: 0,
                sourceStartSample: 0,
                sourceEndSample: 44_100,
                muted: false,
                gainDb: 0,
                fadeInSamples: 0,
                fadeOutSamples: 0,
            }],
        }];
        const originalPlan = buildAudioMixPlan(original);

        original.audioTracks[0].clips = [{
            ...original.audioTracks[0].clips[0],
            id: 'left',
            sourceEndSample: 5_885,
            timelineDurationSamples: 6_406,
        }, {
            ...original.audioTracks[0].clips[0],
            id: 'right',
            timelineStartFrame: 4,
            sourceStartSample: 5_885,
            timelineDurationSamples: 41_594,
        }];
        const splitPlan = buildAudioMixPlan(original);

        expect(originalPlan.totalSampleCount).toBe(48_000);
        expect(splitPlan.totalSampleCount).toBe(originalPlan.totalSampleCount);
        expect(splitPlan.contributors).toMatchObject([
            { outputStartSample: 0, outputEndSample: 6_406 },
            { outputStartSample: 6_406, outputEndSample: 48_000 },
        ]);

        const decoded = Float32Array.from({ length: 48_000 }, (_, index) => (
            0.25 + Math.sin(index / 19) * 0.1
        ));
        const decode = () => ({ sampleRate: 48_000, startSample: 0, channels: [decoded] });
        const [before, after] = await Promise.all([
            renderAudioMixPlan(originalPlan, decode),
            renderAudioMixPlan(splitPlan, decode),
        ]);
        let maximumDifference = 0;
        for (let index = 0; index < before.channels[0].length; index += 1) {
            maximumDifference = Math.max(
                maximumDifference,
                Math.abs(before.channels[0][index] - after.channels[0][index]),
            );
        }
        expect(after.channels[0]).toHaveLength(before.channels[0].length);
        expect(after.channels[0][6_405]).toBeGreaterThan(0.1);
        expect(after.channels[0][6_406]).toBeGreaterThan(0.1);
        expect(maximumDifference).toBeLessThan(0.01);
    });
});
