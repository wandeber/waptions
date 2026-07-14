import { describe, expect, it } from 'vitest';
import type { Subtitle } from '@/types/timeline';
import type {
    AudioSourceAsset,
    AudioTrack,
    EditorDocumentV3,
    VideoClipV3,
    VideoSourceAssetV3,
} from '@/types/video';
import { createDefaultRenderProfile } from './render-profile';
import {
    buildAudioTranscriptionPlan,
    mapAudioTranscriptionWords,
} from './audio-transcription-plan';

const fakeFile = {} as File;

const videoSource = (id = 'shared'): VideoSourceAssetV3 => ({
    id,
    originalName: `${id}.mp4`,
    mimeType: 'video/mp4',
    size: 1,
    lastModified: 1,
    fingerprint: `video:${id}`,
    duration: 4,
    fps: 30,
    width: 1920,
    height: 1080,
    bitrate: null,
    hasAudio: true,
    file: fakeFile,
});

const audioSource = (id = 'shared'): AudioSourceAsset => ({
    id,
    originalName: `${id}.wav`,
    mimeType: 'audio/wav',
    size: 1,
    lastModified: 1,
    fingerprint: `audio:${id}`,
    duration: 4,
    nativeSampleRate: 44_100,
    nativeSampleCount: 176_400,
    nativeChannelCount: 1,
    bitrate: null,
    codec: 'pcm',
    file: fakeFile,
});

const linkedVideoClip = (overrides: Partial<VideoClipV3> = {}): VideoClipV3 => ({
    id: 'linked_video',
    sourceId: 'shared',
    sourceStart: 1,
    sourceEnd: 2,
    audio: {
        linkState: 'linked',
        muted: false,
        gainDb: -12,
        fadeInFrames: 5,
        fadeOutFrames: 5,
    },
    ...overrides,
});

const importedTrack = (overrides: Partial<AudioTrack> = {}): AudioTrack => ({
    id: 'imported_track',
    name: 'Imported',
    muted: false,
    solo: false,
    locked: false,
    gainDb: -6,
    clips: [{
        id: 'imported_clip',
        source: { kind: 'audio-source', audioSourceId: 'shared' },
        timelineStartFrame: 15,
        sourceStartSample: 22_050,
        sourceEndSample: 66_150,
        muted: false,
        gainDb: -18,
        fadeInSamples: 2_205,
        fadeOutSamples: 2_205,
    }],
    ...overrides,
});

function document(overrides: Partial<EditorDocumentV3> = {}): EditorDocumentV3 {
    return {
        version: 3,
        revision: 7,
        audioGraphRevision: 3,
        renderProfile: createDefaultRenderProfile(),
        subtitleTracks: [],
        videoSources: [videoSource()],
        videoClips: [linkedVideoClip()],
        audioSources: [audioSource()],
        audioTracks: [importedTrack()],
        activeSubtitleTrackId: null,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
        ...overrides,
    };
}

const word = (id: string, startTime: number, endTime: number): Subtitle => ({
    id,
    text: id,
    startTime,
    endTime,
});

describe('buildAudioTranscriptionPlan', () => {
    it('represents linked video once and detached video only through its independent audio clip', () => {
        const plan = buildAudioTranscriptionPlan(document({
            videoClips: [
                linkedVideoClip(),
                linkedVideoClip({
                    id: 'detached_video',
                    sourceStart: 2,
                    sourceEnd: 3,
                    audio: {
                        linkState: 'detached',
                        muted: false,
                        gainDb: 0,
                        fadeInFrames: 0,
                        fadeOutFrames: 0,
                    },
                }),
            ],
            audioTracks: [{
                id: 'detached_track',
                name: 'Detached audio',
                muted: false,
                solo: false,
                locked: false,
                gainDb: 0,
                clips: [{
                    id: 'detached_clip',
                    source: { kind: 'video-source-audio', videoSourceId: 'shared' },
                    timelineStartFrame: 30,
                    sourceStart: 2,
                    sourceEnd: 3,
                    muted: false,
                    gainDb: 0,
                    fadeInFrames: 0,
                    fadeOutFrames: 0,
                }],
            }],
        }));

        expect(plan.placements.map((placement) => placement.id)).toEqual([
            'embedded-video:linked_video',
            'independent-audio:detached_track:detached_clip',
        ]);
        expect(plan.sourceJobs).toHaveLength(1);
        expect(plan.sourceJobs[0]).toMatchObject({
            sourceKey: 'video-source-audio:shared',
            placements: [{ contributorKind: 'embedded-video' }, { contributorKind: 'independent-audio' }],
        });
        expect(plan.placements.some((placement) => placement.id.includes('detached_video'))).toBe(false);
    });

    it('keeps same-ID video and imported audio in separate typed jobs', () => {
        const plan = buildAudioTranscriptionPlan(document());

        expect(plan.sourceKeys).toEqual([
            'video-source-audio:shared',
            'audio-source:shared',
        ]);
        expect(plan.sourceJobs).toHaveLength(2);
        expect(plan.sourceJobs[0].source).toEqual({ kind: 'video-source-audio', videoSourceId: 'shared' });
        expect(plan.sourceJobs[1].source).toEqual({ kind: 'audio-source', audioSourceId: 'shared' });
    });

    it('inherits clip mute, track mute, and effective solo from the immutable mix plan', () => {
        const mutedClip = importedTrack({
            id: 'muted_clip_track',
            clips: [{ ...importedTrack().clips[0], id: 'muted_clip', muted: true }],
        });
        const mutedTrack = importedTrack({ id: 'muted_track', muted: true });
        const soloTrack = importedTrack({ id: 'solo_track', solo: true });
        const plan = buildAudioTranscriptionPlan(document({
            audioTracks: [mutedClip, mutedTrack, soloTrack],
        }));

        expect(plan.placements.map((placement) => placement.id)).toEqual([
            'independent-audio:solo_track:imported_clip',
        ]);
    });

    it('does not let gain or fades remove otherwise audible transcription placements', () => {
        const plan = buildAudioTranscriptionPlan(document());

        expect(plan.placements).toHaveLength(2);
        expect(plan.placements.map((placement) => placement.sourceKey)).toEqual([
            'video-source-audio:shared',
            'audio-source:shared',
        ]);
    });

    it('returns an empty stable graph when there are no audible contributors', () => {
        const plan = buildAudioTranscriptionPlan(document({
            videoClips: [linkedVideoClip({
                audio: { ...linkedVideoClip().audio!, muted: true },
            })],
            audioTracks: [importedTrack({ muted: true })],
        }));

        expect(plan.placements).toEqual([]);
        expect(plan.sourceJobs).toEqual([]);
        expect(plan.sourceKeys).toEqual([]);
        expect(plan.signature).toMatch(/^audio-transcription-v1:/);
    });
});

describe('mapAudioTranscriptionWords', () => {
    it('transcribes a reused source once and expands it through overlapping placements', () => {
        const first = importedTrack();
        const second = importedTrack({
            id: 'second_track',
            clips: [{
                ...importedTrack().clips[0],
                id: 'second_clip',
                timelineStartFrame: 20,
            }],
        });
        const plan = buildAudioTranscriptionPlan(document({
            videoClips: [],
            audioTracks: [first, second],
        }));
        const sourceWords = new Map([
            ['audio-source:shared' as const, [word('provider-word', 0.75, 1.25)]],
        ]);

        const firstMapping = mapAudioTranscriptionWords(plan, sourceWords);
        const repeatedMapping = mapAudioTranscriptionWords(plan, sourceWords);

        expect(plan.sourceJobs).toHaveLength(1);
        expect(firstMapping).toHaveLength(2);
        expect(firstMapping[0].startTime).toBe(0.75);
        expect(firstMapping[1].startTime).toBeCloseTo(11 / 12, 12);
        expect(new Set(firstMapping.map((item) => item.id)).size).toBe(2);
        expect(firstMapping.map((item) => item.id)).toEqual(repeatedMapping.map((item) => item.id));
        expect(firstMapping.every((item) => item.id !== 'provider-word')).toBe(true);
    });

    it('maps native-sample crops and clips words at both source and project boundaries', () => {
        const plan = buildAudioTranscriptionPlan(document({ videoClips: [] }));
        const result = mapAudioTranscriptionWords(plan, new Map([
            ['audio-source:shared', [
                word('left-crossing', 0.25, 0.75),
                word('inside', 0.75, 1.25),
                word('right-crossing', 1.25, 1.75),
                word('outside', 2, 3),
            ]],
        ]));

        expect(result).toEqual([
            expect.objectContaining({ text: 'left-crossing', startTime: 0.5, endTime: 0.75 }),
            expect.objectContaining({ text: 'inside', startTime: 0.75, endTime: 1.25 }),
            expect.objectContaining({ text: 'right-crossing', startTime: 1.25, endTime: 1.5 }),
        ]);
        expect(plan.placements[0]).toMatchObject({
            projectStartFrame: 15,
            projectEndFrame: 45,
            sourceRange: {
                domain: 'native-samples',
                startSample: 22_050,
                endSample: 66_150,
                sampleRate: 44_100,
            },
        });
    });
});
