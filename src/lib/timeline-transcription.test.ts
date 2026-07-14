import { describe, expect, it } from 'vitest';
import type { Subtitle } from '@/types/timeline';
import type { EditorDocumentV3, VideoClip, VideoSourceAsset } from '@/types/video';
import { buildAudioTranscriptionPlan } from './audio-transcription-plan';
import { createDefaultRenderProfile } from './render-profile';
import {
    getUsedAudibleSources,
    mapAudioTranscriptionPlanToProject,
    mapPremiumAudioTranscriptionPlanToProject,
    mapPremiumTranscriptionToProject,
    mapSourceWordsToProject,
} from './timeline-transcription';

const source = (id: string, hasAudio: boolean): VideoSourceAsset => ({
    id,
    originalName: `${id}.mp4`,
    mimeType: 'video/mp4',
    size: 1,
    lastModified: 1,
    fingerprint: `${id}:fingerprint`,
    duration: 10,
    fps: 30,
    width: 1920,
    height: 1080,
    bitrate: null,
    hasAudio,
    file: {} as File,
});

const clip = (id: string, sourceId: string, sourceStart: number, sourceEnd: number): VideoClip => ({
    id,
    sourceId,
    sourceStart,
    sourceEnd,
});

const word = (id: string, startTime: number, endTime: number): Subtitle => ({
    id,
    text: id,
    startTime,
    endTime,
});

describe('timeline transcription mapping', () => {
    it('uses identical crop and placement timing for canonical standard and premium paths', () => {
        const v3Document: EditorDocumentV3 = {
            version: 3,
            revision: 1,
            audioGraphRevision: 1,
            renderProfile: createDefaultRenderProfile(),
            subtitleTracks: [],
            videoSources: [source('source', true)],
            videoClips: [{
                id: 'linked_clip',
                sourceId: 'source',
                sourceStart: 0.5,
                sourceEnd: 1.5,
                audio: {
                    linkState: 'linked',
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
        const plan = buildAudioTranscriptionPlan(v3Document);
        const providerWords = [
            word('left-crossing', 0.25, 0.75),
            word('right-crossing', 1.25, 1.75),
        ];
        const standard = mapAudioTranscriptionPlanToProject(plan, new Map([
            ['video-source-audio:source', providerWords],
        ]));
        const premium = mapPremiumAudioTranscriptionPlanToProject(plan, new Map([
            ['video-source-audio:source', {
                raw: [],
                groups: [{ id: 'corrected', words: providerWords }],
            }],
        ]));

        expect(standard.map(({ startTime, endTime }) => ({ startTime, endTime }))).toEqual(
            premium.raw.map(({ startTime, endTime }) => ({ startTime, endTime })),
        );
        expect(standard.map(({ startTime, endTime }) => ({ startTime, endTime }))).toEqual([
            { startTime: 0, endTime: 0.25 },
            { startTime: 0.75, endTime: 1 },
        ]);
        expect(premium.timelineSubtitles).toEqual([
            expect.objectContaining({ text: 'left-crossing right-crossing', startTime: 0, endTime: 1 }),
        ]);

        // Plan-owned IDs are stable across a pure rerun, but every project placement still receives
        // an identity distinct from the provider word and from other placement occurrences.
        expect(mapAudioTranscriptionPlanToProject(plan, new Map([
            ['video-source-audio:source', providerWords],
        ])).map((item) => item.id)).toEqual(standard.map((item) => item.id));
        expect(standard.every((item) => !providerWords.some((sourceWord) => sourceWord.id === item.id))).toBe(true);
    });

    it('returns empty canonical premium state when the audible plan has no contributors', () => {
        const plan = buildAudioTranscriptionPlan({
            version: 3,
            revision: 1,
            audioGraphRevision: 1,
            renderProfile: createDefaultRenderProfile(),
            subtitleTracks: [],
            videoSources: [source('source', true)],
            videoClips: [{
                id: 'muted_clip',
                sourceId: 'source',
                sourceStart: 0,
                sourceEnd: 1,
                audio: {
                    linkState: 'linked',
                    muted: true,
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
        });

        expect(mapPremiumAudioTranscriptionPlanToProject(plan, new Map())).toEqual({
            raw: [],
            groups: {},
            containerIds: [],
            timelineSubtitles: [],
        });
    });

    it('returns each used audible source once in first-use order', () => {
        const audible = source('audible', true);
        const silent = source('silent', false);
        expect(getUsedAudibleSources(
            [silent, audible],
            [clip('c1', 'audible', 0, 1), clip('c2', 'silent', 0, 1), clip('c3', 'audible', 1, 2)],
        )).toEqual([audible]);
    });

    it('clips and remaps words for every reused source interval with fresh IDs', () => {
        const words = new Map<string, Subtitle[]>([
            ['source', [word('crossing', 0.5, 2.5), word('outside', 5, 6)]],
        ]);
        let id = 0;
        const result = mapSourceWordsToProject(
            words,
            [clip('first', 'source', 1, 2), clip('second', 'source', 2, 3)],
            () => `mapped-${++id}`,
        );

        expect(result).toEqual([
            expect.objectContaining({ id: 'mapped-1', text: 'crossing', startTime: 0, endTime: 1 }),
            expect.objectContaining({ id: 'mapped-2', text: 'crossing', startTime: 1, endTime: 1.5 }),
        ]);
    });

    it('preserves corrected premium groups through trimming and source reuse', () => {
        let id = 0;
        const result = mapPremiumTranscriptionToProject(
            new Map([['source', {
                raw: [word('stale', 0.5, 2.5)],
                groups: [{
                    id: 'speaker-a',
                    words: [
                        { ...word('corrected', 0.5, 1.5), text: 'Corrected' },
                        { ...word('boundary', 1.5, 2.5), text: 'boundary' },
                    ],
                }],
            }]]),
            [clip('first', 'source', 1, 2), clip('reused', 'source', 1.5, 2.5)],
            30,
            () => `mapped-${++id}`,
        );

        expect(result.timelineSubtitles).toEqual([
            expect.objectContaining({ text: 'Corrected boundary', startTime: 0, endTime: 1 }),
            expect.objectContaining({ text: 'boundary', startTime: 1, endTime: 2 }),
        ]);
        expect(result.containerIds).toHaveLength(2);
        expect(new Set(result.containerIds).size).toBe(2);
        expect(result.raw.map((item) => item.text)).not.toContain('stale');
        expect(result.raw.map((item) => item.id)).toEqual(
            result.containerIds.flatMap((containerId) => result.groups[containerId].map((item) => item.id)),
        );
        expect(new Set(result.raw.map((item) => item.id)).size).toBe(result.raw.length);
    });

    it('falls back to raw premium words and keeps empty responses empty', () => {
        let id = 0;
        const fallback = mapPremiumTranscriptionToProject(
            new Map([['source', { raw: [word('raw', 0, 1)], groups: [] }]]),
            [clip('clip', 'source', 0, 1)],
            30,
            () => `fallback-${++id}`,
        );
        expect(fallback.timelineSubtitles).toEqual([
            expect.objectContaining({ text: 'raw', startTime: 0, endTime: 1 }),
        ]);
        expect(fallback.raw.map((item) => item.id)).toEqual(
            fallback.groups[fallback.containerIds[0]].map((item) => item.id),
        );

        expect(mapPremiumTranscriptionToProject(
            new Map([['source', { raw: [], groups: [] }]]),
            [clip('clip', 'source', 0, 1)],
            30,
            () => 'unused',
        )).toEqual({ raw: [], groups: {}, containerIds: [], timelineSubtitles: [] });
    });

    it('snaps premium provider timestamps consistently across every provenance layer', () => {
        let id = 0;
        const result = mapPremiumTranscriptionToProject(
            new Map([['source', {
                raw: [],
                groups: [{
                    id: 'precise-provider-group',
                    words: [
                        word('retained', 1.017, 1.051),
                        word('collapsed', 1.001, 1.015),
                    ],
                }],
            }]]),
            [clip('clip', 'source', 0, 2)],
            30,
            () => `snapped-${++id}`,
        );

        const frameDuration = 1 / 30;
        const expectedTimes = { startTime: 31 * frameDuration, endTime: 32 * frameDuration };
        expect(result.raw).toEqual([expect.objectContaining({ text: 'retained', ...expectedTimes })]);
        expect(result.groups[result.containerIds[0]]).toEqual([
            expect.objectContaining({ text: 'retained', ...expectedTimes }),
        ]);
        expect(result.timelineSubtitles).toEqual([
            expect.objectContaining({ text: 'retained', ...expectedTimes }),
        ]);
        expect(result.groups[result.containerIds[0]][0]).toEqual(result.raw[0]);
    });
});
