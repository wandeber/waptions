import { describe, expect, it } from 'vitest';
import type { Subtitle, SubtitleTrack } from '@/types/timeline';
import type {
    AudioSourceDescriptor,
    AudioTrack,
    EditorDocumentV2,
    RetainedIntervalMapping,
    VideoClip,
    VideoSourceAsset,
} from '@/types/video';
import {
    appendVideoClips,
    applyMediaEditToTimeline,
    buildClipPlacements,
    cleanSubtitleSelection,
    createImmutableVideoSourceFingerprint,
    createLegacySourceUpgradeFingerprint,
    createVideoSourceFingerprint,
    deleteVideoClip,
    getImportedSourceEnd,
    getSourceFrameAtOrBefore,
    getTimelineDurations,
    getTimelineContentEndFrame,
    reorderVideoClips,
    resolveClipAtProjectTime,
    snapProjectTime,
    splitVideoClip,
    transformSubtitleTracks,
    trimVideoClip,
    validateEditorDocument,
} from './video-timeline';
import { createDefaultRenderProfile } from './render-profile';

const makeFile = (name = 'video.mp4', type = 'video/mp4', size = 1_024, lastModified = 123): File => ({
    name,
    type,
    size,
    lastModified,
} as File);

const source = (overrides: Partial<VideoSourceAsset> = {}): VideoSourceAsset => {
    const file = overrides.file ?? makeFile();
    return {
        id: 'source_a',
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: createVideoSourceFingerprint(file),
        duration: 10,
        fps: 30,
        width: 1920,
        height: 1080,
        bitrate: null,
        hasAudio: true,
        ...overrides,
        file,
    };
};

const clip = (
    id: string,
    sourceId: string,
    sourceStart: number,
    sourceEnd: number,
): VideoClip => ({ id, sourceId, sourceStart, sourceEnd });

const subtitle = (id: string, startTime: number, endTime: number): Subtitle => ({
    id,
    startTime,
    endTime,
    text: id,
});

const track = (id: string, subtitles: Subtitle[], isVisible = true): SubtitleTrack => ({
    id,
    name: id,
    style: {} as SubtitleTrack['style'],
    subtitles,
    isVisible,
    isLocked: false,
});

const documentWith = (overrides: Partial<EditorDocumentV2> = {}): EditorDocumentV2 => {
    const videoSource = source();
    const tracks = [track('track_a', [subtitle('subtitle_a', 0, 1)])];
    return {
        revision: 1,
        projectFps: 30,
        tracks,
        videoSources: [videoSource],
        videoClips: [clip('clip_a', videoSource.id, 0, 2)],
        activeTrackId: 'track_a',
        selectedSubtitleIds: ['subtitle_a'],
        selectedClipId: 'clip_a',
        transcriptionByTrackId: {},
        ...overrides,
    };
};

describe('video document validation', () => {
    it('accepts a complete source, clip, and track graph', () => {
        expect(validateEditorDocument(documentWith())).toEqual({ valid: true, issues: [] });
    });

    it('accepts nonce-bearing import fingerprints while retaining v1 compatibility', () => {
        const file = makeFile();
        const immutableSource = source({
            file,
            fingerprint: createImmutableVideoSourceFingerprint(file, 'import-a'),
        });

        expect(validateEditorDocument(documentWith({
            videoSources: [immutableSource],
            videoClips: [clip('clip_a', immutableSource.id, 0, 2)],
        }))).toEqual({ valid: true, issues: [] });
    });

    it('upgrades a legacy source to a stable project-scoped identity without metadata collisions', () => {
        const file = makeFile();
        const scope = { projectId: 'project_a', kind: 'video-source' as const, sourceId: 'source_a' };
        const upgraded = createLegacySourceUpgradeFingerprint(file, scope);

        expect(createLegacySourceUpgradeFingerprint(file, scope)).toBe(upgraded);
        expect(createLegacySourceUpgradeFingerprint(file, {
            ...scope,
            projectId: 'project_b',
        })).not.toBe(upgraded);
        expect(createLegacySourceUpgradeFingerprint(file, {
            ...scope,
            sourceId: 'source_b',
        })).not.toBe(upgraded);
        expect(createLegacySourceUpgradeFingerprint(file, {
            ...scope,
            kind: 'audio-source',
        })).not.toBe(upgraded);
        expect(upgraded).toMatch(/^v2_[0-9a-f]{16}_legacy_[0-9a-f]+$/);
    });

    it('allows two distinct source identities to share one durable file fingerprint', () => {
        const firstSource = source({ id: 'source_a' });
        const secondSource = source({ id: 'source_b' });
        const document = documentWith({
            videoSources: [firstSource, secondSource],
            videoClips: [
                clip('clip_a', firstSource.id, 0, 2),
                clip('clip_b', secondSource.id, 0, 2),
            ],
        });

        expect(firstSource.fingerprint).toBe(secondSource.fingerprint);
        expect(firstSource.id).not.toBe(secondSource.id);
        expect(validateEditorDocument(document)).toEqual({ valid: true, issues: [] });
    });

    it('reports duplicate IDs and missing source references', () => {
        const base = documentWith();
        const result = validateEditorDocument({
            ...base,
            videoClips: [base.videoClips[0], { ...base.videoClips[0], sourceId: 'missing' }],
        });

        expect(result.valid).toBe(false);
        expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
            'duplicate-id',
            'missing-source',
        ]));
    });

    it('requires positive revision and project FPS values', () => {
        const result = validateEditorDocument(documentWith({ revision: 0, projectFps: 0 }));
        expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
            'invalid-revision',
            'invalid-project-fps',
        ]));
    });

    it('rejects ordinary clip endpoints that are not on the project grid', () => {
        const base = documentWith();
        const result = validateEditorDocument({
            ...base,
            videoClips: [
                clip('off_start', 'source_a', 0.01, 2),
                clip('off_end', 'source_a', 0, 2.01),
            ],
            selectedClipId: 'off_start',
        });

        expect(result.issues.filter((issue) => issue.code === 'invalid-clip-bounds')).toHaveLength(2);
    });

    it('rejects unsafe and duplicate track/subtitle IDs plus invalid subtitle intervals', () => {
        const invalidTracks = [
            track('unsafe track', [
                subtitle('unsafe subtitle', -1, 0),
                subtitle('zero_length', 2, 2),
            ]),
            track('unsafe track', [subtitle('unsafe subtitle', 1, Number.NaN)]),
        ];
        const result = validateEditorDocument(documentWith({
            tracks: invalidTracks,
            activeTrackId: 'unsafe track',
            selectedSubtitleIds: ['unsafe subtitle'],
        }));

        expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
            'invalid-id',
            'duplicate-id',
            'invalid-subtitle-interval',
        ]));
        expect(result.issues.filter((issue) => issue.code === 'invalid-subtitle-interval')).toHaveLength(3);
    });

    it('accepts safe crypto-style IDs across the persisted graph', () => {
        const cryptoSource = source({ id: '019d13ce-50bf-7b42-a965-b57e0849a681' });
        const cryptoTrack = track(
            '019d13ce-50bf-7b42-a965-b57e0849a682',
            [subtitle('019d13ce-50bf-7b42-a965-b57e0849a683', 0, 1)],
        );
        const result = validateEditorDocument(documentWith({
            tracks: [cryptoTrack],
            videoSources: [cryptoSource],
            videoClips: [clip('019d13ce-50bf-7b42-a965-b57e0849a684', cryptoSource.id, 0, 2)],
            activeTrackId: cryptoTrack.id,
            selectedSubtitleIds: [cryptoTrack.subtitles[0].id],
            selectedClipId: '019d13ce-50bf-7b42-a965-b57e0849a684',
        }));

        expect(result).toEqual({ valid: true, issues: [] });
    });

    it('rejects descriptor/File mismatches and broken provenance references', () => {
        const mismatchedSource = source({
            file: makeFile('other.mp4'),
            originalName: 'video.mp4',
            fingerprint: createVideoSourceFingerprint(makeFile('video.mp4')),
        });
        const base = documentWith({
            videoSources: [mismatchedSource],
            videoClips: [clip('clip_a', mismatchedSource.id, 0, 2)],
            transcriptionByTrackId: {
                track_a: {
                    raw: [subtitle('raw_a', 0, 1)],
                    groups: { subtitle_a: [subtitle('not_raw', 0, 1)] },
                    containerIds: ['subtitle_a'],
                },
            },
        });

        const result = validateEditorDocument(base);
        expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
            'file-mismatch',
            'invalid-transcription-provenance',
        ]));
    });

    it('treats transcription container IDs as group keys rather than track subtitle IDs', () => {
        const raw = subtitle('raw_a', 0, 1);
        const result = validateEditorDocument(documentWith({
            transcriptionByTrackId: {
                track_a: {
                    raw: [raw],
                    groups: { container_a: [raw] },
                    containerIds: ['container_a'],
                },
            },
        }));

        expect(result).toEqual({ valid: true, issues: [] });
    });

    it('allows a whole source shorter than one project frame but rejects other undersized clips', () => {
        const shortSource = source({ id: 'short', duration: 0.02 });
        const valid = documentWith({
            videoSources: [shortSource],
            videoClips: [clip('whole', 'short', 0, 0.02)],
            selectedClipId: 'whole',
        });
        expect(validateEditorDocument(valid).valid).toBe(true);

        expect(validateEditorDocument({
            ...valid,
            videoClips: [clip('partial', 'short', 0.005, 0.02)],
            selectedClipId: 'partial',
        }).issues.some((issue) => issue.code === 'invalid-clip-bounds')).toBe(true);
    });
});

describe('video timeline timing', () => {
    it('uses half-open clip boundaries and resolves the exact media end to null', () => {
        const placements = buildClipPlacements([
            clip('a', 'same_source', 0, 1),
            clip('b', 'same_source', 2, 4),
        ]);

        expect(resolveClipAtProjectTime(placements, 0.999)?.clip.id).toBe('a');
        expect(resolveClipAtProjectTime(placements, 1)?.clip.id).toBe('b');
        expect(resolveClipAtProjectTime(placements, 3)).toBeNull();
        expect(placements.map((placement) => placement.projectStart)).toEqual([0, 1]);
    });

    it('floors imported tails without exceeding the source and keeps a short source exact', () => {
        expect(getImportedSourceEnd(1.01, 30)).toBeCloseTo(1);
        expect(getImportedSourceEnd(0.02, 30)).toBe(0.02);
        expect(getImportedSourceEnd(1, 30)).toBeLessThanOrEqual(1);
    });

    it('snaps playhead and edit times to the nearest project frame', () => {
        expect(snapProjectTime(1.011, 30)).toBe(1);
        expect(snapProjectTime(1.02, 30)).toBeCloseTo(31 / 30);
        expect(snapProjectTime(2, 30, 1.5)).toBe(1.5);
    });

    it.each([24, 30, 60])('samples %ifps CFR sources at or before the requested time', (fps) => {
        expect(getSourceFrameAtOrBefore(0.51, fps, 1)).toEqual({
            index: Math.floor(0.51 * fps),
            time: Math.floor(0.51 * fps) / fps,
        });
        expect(getSourceFrameAtOrBefore(1, fps, 1).index).toBe(fps - 1);
    });

    it('counts subtitles on hidden tracks when deriving content and view duration', () => {
        expect(getTimelineDurations(
            [clip('a', 'source', 0, 2)],
            [track('hidden', [subtitle('late', 3, 8)], false)],
        )).toEqual({ mediaDuration: 2, contentDuration: 8, viewDuration: 68 });
    });
});

describe('immutable media edits and retained intervals', () => {
    const clips = [clip('a', 'source_a', 0, 2), clip('b', 'source_b', 0, 3)];
    const sources = [source({ id: 'source_a' }), source({ id: 'source_b' })];

    it('appends media before the old black tail', () => {
        const result = appendVideoClips(clips, [clip('c', 'source_a', 4, 5)], 8);
        expect(result.videoClips.map((item) => item.id)).toEqual(['a', 'b', 'c']);
        expect(result.retainedIntervals).toEqual([
            { oldStart: 0, oldEnd: 5, newStart: 0, newEnd: 5, kind: 'media' },
            { oldStart: 5, oldEnd: 8, newStart: 6, newEnd: 9, kind: 'black-tail' },
        ]);
        expect(clips).toHaveLength(2);
    });

    it('splits on the project grid while preserving the left ID and timeline timing', () => {
        const result = splitVideoClip(clips, 'a', 1.01, 'a_right', 30);
        expect(result.videoClips.map((item) => item.id)).toEqual(['a', 'a_right', 'b']);
        expect(result.leftClip.sourceEnd).toBe(1);
        expect(result.rightClip.sourceStart).toBe(1);
        expect(buildClipPlacements(result.videoClips).at(-1)?.projectEnd).toBe(5);
    });

    it('trims inward and shifts later media plus the black tail', () => {
        const result = trimVideoClip(clips, 'a', 1, 2, sources, 30, 8);
        expect(result.newMediaDuration).toBe(4);
        expect(result.retainedIntervals).toEqual([
            { oldStart: 1, oldEnd: 5, newStart: 0, newEnd: 4, kind: 'media' },
            { oldStart: 5, oldEnd: 8, newStart: 4, newEnd: 7, kind: 'black-tail' },
        ]);
    });

    it('supports outward trim but creates no retained caption interval for inserted media', () => {
        const initial = [clip('a', 'source_a', 1, 3), clip('b', 'source_b', 0, 1)];
        const result = trimVideoClip(initial, 'a', 0, 4, sources, 30, 5);
        expect(result.newMediaDuration).toBe(5);
        expect(result.retainedIntervals).toEqual([
            { oldStart: 0, oldEnd: 2, newStart: 1, newEnd: 3, kind: 'media' },
            { oldStart: 2, oldEnd: 3, newStart: 4, newEnd: 5, kind: 'media' },
            { oldStart: 3, oldEnd: 5, newStart: 5, newEnd: 7, kind: 'black-tail' },
        ]);
    });

    it('snaps fractional trim handles and clamps them to the deterministic source tail', () => {
        const limitedSource = source({ id: 'source_a', duration: 4.02 });
        const result = trimVideoClip(
            [clip('a', 'source_a', 1, 3)],
            'a',
            0.514,
            4.019,
            [limitedSource],
            30,
            3,
        );

        expect(result.videoClips[0].sourceStart).toBe(0.5);
        expect(result.videoClips[0].sourceEnd).toBe(4);
        expect(result.videoClips[0].sourceEnd).toBeLessThanOrEqual(limitedSource.duration);
    });

    it('deletes one clip and maps the black tail directly after retained media', () => {
        const result = deleteVideoClip(clips, 'a', 8);
        expect(result.videoClips.map((item) => item.id)).toEqual(['b']);
        expect(result.retainedIntervals).toEqual([
            { oldStart: 2, oldEnd: 5, newStart: 0, newEnd: 3, kind: 'media' },
            { oldStart: 5, oldEnd: 8, newStart: 3, newEnd: 6, kind: 'black-tail' },
        ]);
    });

    it('maps the old black tail to zero when the last clip is deleted', () => {
        const result = deleteVideoClip([clip('only', 'source_a', 0, 2)], 'only', 4);
        expect(result.videoClips).toEqual([]);
        expect(result.retainedIntervals).toEqual([
            { oldStart: 2, oldEnd: 4, newStart: 0, newEnd: 2, kind: 'black-tail' },
        ]);
    });

    it('reorders repeated source uses without changing total duration or the black tail start', () => {
        const repeatedSources = [clip('a', 'source_a', 0, 2), clip('b', 'source_a', 4, 7)];
        const result = reorderVideoClips(repeatedSources, ['b', 'a'], 7);
        expect(result.newMediaDuration).toBe(5);
        expect(result.retainedIntervals).toEqual([
            { oldStart: 0, oldEnd: 2, newStart: 3, newEnd: 5, kind: 'media' },
            { oldStart: 2, oldEnd: 5, newStart: 0, newEnd: 3, kind: 'media' },
            { oldStart: 5, oldEnd: 7, newStart: 5, newEnd: 7, kind: 'black-tail' },
        ]);
    });
});

describe('V3 frame-domain content duration', () => {
    const renderProfile = createDefaultRenderProfile({
        fps: { numerator: 30_000, denominator: 1_001 },
        isFrameRateLocked: true,
        isCanvasSizeLocked: true,
    });
    const importedAudio: AudioSourceDescriptor = {
        id: 'audio_source',
        originalName: 'music.wav',
        mimeType: 'audio/wav',
        size: 1,
        lastModified: 1,
        fingerprint: 'audio_fingerprint',
        duration: 2,
        nativeSampleRate: 44_100,
        nativeSampleCount: 88_200,
        nativeChannelCount: 2,
        bitrate: null,
        codec: 'pcm_s16le',
    };
    const audioTracks: AudioTrack[] = [{
        id: 'audio_track',
        name: 'Music',
        muted: true,
        solo: false,
        locked: false,
        gainDb: 0,
        clips: [{
            id: 'audio_clip',
            source: { kind: 'audio-source', audioSourceId: importedAudio.id },
            timelineStartFrame: 90,
            sourceStartSample: 0,
            sourceEndSample: importedAudio.nativeSampleCount,
            muted: false,
            gainDb: 0,
            fadeInSamples: 0,
            fadeOutSamples: 0,
        }],
    }];
    const context = {
        audioTracks,
        videoSources: [] as VideoSourceAsset[],
        audioSources: [importedAudio],
        renderProfile,
    };

    it('includes muted independent audio tails even after every video clip is deleted', () => {
        const endFrame = getTimelineContentEndFrame([], [], context);
        expect(endFrame).toBeGreaterThan(90);
        expect(getTimelineDurations([], [], context)).toMatchObject({
            mediaDuration: 0,
            contentDuration: endFrame * 1_001 / 30_000,
        });
    });

    it('ceil-snaps subtitle ends and accumulates video durations by nearest integer frame', () => {
        const clips = [
            clip('a', 'source', 0, 1.001),
            clip('b', 'source', 0, 1.001),
        ];
        const captions = [track('captions', [subtitle('late', 0, 2.011)])];
        const withoutAudio = { ...context, audioTracks: [], audioSources: [] };

        expect(buildClipPlacements(clips, renderProfile.fps).at(-1)?.projectEnd)
            .toBe(60 * 1_001 / 30_000);
        expect(getTimelineContentEndFrame(clips, captions, withoutAudio)).toBe(61);
    });
});

describe('subtitle transforms', () => {
    const idFactory = (() => {
        let counter = 0;
        return () => `fresh_${counter += 1}`;
    })();

    it('preserves an ID for one complete moved fragment and removes deleted selection', () => {
        const mappings: RetainedIntervalMapping[] = [
            { oldStart: 2, oldEnd: 5, newStart: 0, newEnd: 3, kind: 'media' },
        ];
        const tracks = [track('visible', [subtitle('kept', 2.5, 3.5), subtitle('removed', 0, 1)])];
        const transformed = transformSubtitleTracks(tracks, mappings, idFactory);

        expect(transformed[0].subtitles).toEqual([subtitle('kept', 0.5, 1.5)]);
        expect(cleanSubtitleSelection(['kept', 'removed'], transformed)).toEqual(['kept']);
    });

    it('splits cross-boundary captions with fresh IDs on every fragment, including hidden tracks', () => {
        const mappings: RetainedIntervalMapping[] = [
            { oldStart: 0, oldEnd: 2, newStart: 3, newEnd: 5, kind: 'media' },
            { oldStart: 2, oldEnd: 5, newStart: 0, newEnd: 3, kind: 'media' },
        ];
        const tracks = [track('hidden', [subtitle('crossing', 1, 4)], false)];
        const transformed = transformSubtitleTracks(tracks, mappings, idFactory);

        expect(transformed[0].isVisible).toBe(false);
        expect(transformed[0].subtitles).toEqual([
            { ...subtitle('fresh_2', 0, 2), text: 'crossing' },
            { ...subtitle('fresh_1', 4, 5), text: 'crossing' },
        ]);
        expect(cleanSubtitleSelection(['crossing'], transformed)).toEqual([]);
    });

    it('moves captions in the old black tail after appended media', () => {
        const edit = appendVideoClips(
            [clip('a', 'source', 0, 2)],
            [clip('b', 'source', 2, 3)],
            5,
        );
        const result = applyMediaEditToTimeline(
            [track('track', [subtitle('tail', 3, 4)])],
            ['tail'],
            edit,
            idFactory,
        );

        expect(result.tracks[0].subtitles).toEqual([subtitle('tail', 4, 5)]);
        expect(result.selectedSubtitleIds).toEqual(['tail']);
    });
});
