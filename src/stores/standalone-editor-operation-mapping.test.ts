import { describe, expect, it } from 'vitest';
import { EDITOR_OPERATION_TYPES } from '@/lib/editor-engine/editor-command';
import {
    createEditorDocumentV4Fixture,
    createSubtitleTrackV4Fixture,
} from '@/types/editorial.test-fixtures';
import {
    assertStandaloneOperationCompatibilityComplete,
    mapStandaloneLinkCommand,
    mapStandaloneNarrativeCommand,
    mapStandaloneOrdinaryCommand,
    mapStandaloneSubtitleOrderReplacement,
    mapStandaloneSubtitleReplacement,
    STANDALONE_EDITOR_OPERATION_COMPATIBILITY,
} from './standalone-editor-operation-mapping';
import type { TimelineOrdinaryPlanSuccess } from './timeline-ordinary-v4-command-adapter';

describe('standalone editor operation mapping', () => {
    it('exhaustively classifies Core frozen operation types', () => {
        expect(() => assertStandaloneOperationCompatibilityComplete()).not.toThrow();
        expect(Object.keys(STANDALONE_EDITOR_OPERATION_COMPATIBILITY).sort())
            .toEqual([...EDITOR_OPERATION_TYPES].sort());
    });

    it('maps an ordinary video move to the planned authoritative placement', () => {
        const before = createEditorDocumentV4Fixture({ narrative: null });
        const after = createEditorDocumentV4Fixture({
            narrative: null,
            revision: 2,
            videoClips: before.videoClips.map((clip) => ({
                ...clip,
                timelineStartFrame: 42,
            })),
        });
        const planned = ordinaryPlan(after);
        const mapped = mapStandaloneOrdinaryCommand({
            before,
            planned,
            request: {
                target: { kind: 'video-clip', clipId: 'video_clip_editorial' },
                action: {
                    kind: 'move',
                    targetTrackId: 'video_track_editorial',
                    targetStart: 42,
                },
            },
        });
        expect(Array.isArray(mapped) && mapped[0]).toMatchObject({
            type: 'video-clip.move',
            payload: {
                clipId: 'video_clip_editorial',
                targetTrackId: 'video_track_editorial',
                timelineStartFrame: 42,
            },
        });
    });

    it('fails closed when the standalone planner requires an unexpressed ripple cascade', () => {
        const before = createEditorDocumentV4Fixture({
            narrative: null,
            videoClips: [
                {
                    ...createEditorDocumentV4Fixture().videoClips[0],
                    id: 'video_a',
                    timelineStartFrame: 0,
                },
                {
                    ...createEditorDocumentV4Fixture().videoClips[0],
                    id: 'video_b',
                    timelineStartFrame: 30,
                },
            ],
        });
        const after = createEditorDocumentV4Fixture({
            narrative: null,
            revision: 2,
            videoClips: [{
                ...before.videoClips[1],
                timelineStartFrame: 0,
            }],
        });

        expect(mapStandaloneOrdinaryCommand({
            before,
            planned: ordinaryPlan(after),
            request: {
                target: { kind: 'video-clip', clipId: 'video_a' },
                action: { kind: 'delete' },
            },
        })).toMatchObject({
            kind: 'error',
            error: { code: 'unsupported-ripple-cascade', ids: ['video_a'] },
        });
    });

    it('fails closed for cross-track subtitle moves', () => {
        const first = createSubtitleTrackV4Fixture({
            id: 'subtitle_track_a',
            subtitles: [{ id: 'subtitle_a', startTime: 0, endTime: 1, text: 'A' }],
        });
        const second = createSubtitleTrackV4Fixture({
            id: 'subtitle_track_b',
            subtitles: [],
        });
        const before = createEditorDocumentV4Fixture({
            narrative: null,
            subtitleTracks: [first, second],
            activeSubtitleTrackId: first.id,
        });
        const after = createEditorDocumentV4Fixture({
            narrative: null,
            revision: 2,
            subtitleTracks: [
                { ...first, subtitles: [] },
                { ...second, subtitles: first.subtitles },
            ],
            activeSubtitleTrackId: first.id,
        });
        const mapped = mapStandaloneSubtitleReplacement({
            before,
            planned: ordinaryPlan(after),
        });
        expect(mapped).toMatchObject({
            kind: 'error',
            error: { code: 'unsupported-cross-track-subtitle-move', ids: ['subtitle_a'] },
        });
    });

    it('uses target-aware subtitle operations so Core can maintain dependent links', () => {
        const track = createSubtitleTrackV4Fixture({
            id: 'subtitle_track',
            subtitles: [{ id: 'subtitle_a', startTime: 0, endTime: 1, text: 'A' }],
        });
        const before = createEditorDocumentV4Fixture({
            narrative: null,
            subtitleTracks: [track],
            activeSubtitleTrackId: track.id,
        });
        const mapped = mapStandaloneSubtitleReplacement({
            before,
            planned: ordinaryPlan(createEditorDocumentV4Fixture({
                narrative: null,
                revision: 2,
                subtitleTracks: [{ ...track, subtitles: [] }],
                activeSubtitleTrackId: track.id,
            })),
        });

        expect(mapped).toMatchObject([{
            type: 'subtitle.delete',
            payload: { trackId: track.id, subtitleId: 'subtitle_a' },
        }]);
    });

    it('preserves the semantic split transform used to rebind linked subtitles', () => {
        const track = createSubtitleTrackV4Fixture({
            id: 'subtitle_track_editorial',
            subtitles: [{
                id: 'subtitle_1',
                startTime: 0,
                endTime: 2,
                text: 'Linked subtitle',
            }],
        });
        const before = createEditorDocumentV4Fixture({
            subtitleTracks: [track],
            activeSubtitleTrackId: track.id,
        });
        const afterTrack = {
            ...track,
            subtitles: [
                { ...track.subtitles[0], endTime: 1 },
                { ...track.subtitles[0], id: 'subtitle_right', startTime: 1 },
            ],
        };

        const mapped = mapStandaloneSubtitleReplacement({
            before,
            planned: ordinaryPlan(createEditorDocumentV4Fixture({
                revision: before.revision + 1,
                subtitleTracks: [afterTrack],
                activeSubtitleTrackId: track.id,
            })),
        });

        expect(mapped).toMatchObject([{
            type: 'subtitle.split',
            payload: {
                trackId: track.id,
                subtitleId: 'subtitle_1',
                atOutputSample: 48_000,
                rightSubtitleId: 'subtitle_right',
            },
        }]);
        expect(Array.isArray(mapped) ? mapped.map((value) => value.type) : []).not.toContain(
            'subtitle.insert',
        );
        expect(Array.isArray(mapped) ? mapped.map((value) => value.type) : []).not.toContain(
            'subtitle.trim',
        );
    });

    it('maps order-only subtitle replacements through the frozen ordering operation', () => {
        const first = { id: 'subtitle_a', startTime: 0, endTime: 1, text: 'A' };
        const second = { id: 'subtitle_b', startTime: 1, endTime: 2, text: 'B' };
        const track = createSubtitleTrackV4Fixture({
            id: 'subtitle_track',
            subtitles: [first, second],
        });
        const before = createEditorDocumentV4Fixture({
            narrative: null,
            subtitleTracks: [track],
            activeSubtitleTrackId: track.id,
        });

        const mapped = mapStandaloneSubtitleOrderReplacement(before, [{
            ...track,
            subtitles: [second, first],
        }]);

        expect(mapped).toMatchObject([{
            type: 'subtitle.set-order',
            payload: {
                trackId: track.id,
                subtitleId: 'subtitle_a',
                afterId: 'subtitle_b',
            },
        }]);
    });

    it('maps subtitle track state, style, policy, and cues without a manifest patch', () => {
        const beforeTrack = createSubtitleTrackV4Fixture({
            id: 'subtitle_track_a',
            subtitles: [{ id: 'subtitle_a', startTime: 0, endTime: 1, text: 'A' }],
        });
        const before = createEditorDocumentV4Fixture({
            narrative: null,
            subtitleTracks: [beforeTrack],
            activeSubtitleTrackId: beforeTrack.id,
        });
        const afterTrack = {
            ...beforeTrack,
            isVisible: false,
            isLocked: true,
            style: { ...beforeTrack.style, fontSize: 49 },
            unlinkedVideoEditResponse: 'remove-with-deleted-video-range' as const,
            subtitles: [{ ...beforeTrack.subtitles[0], text: 'After' }],
        };
        const mapped = mapStandaloneSubtitleReplacement({
            before,
            planned: ordinaryPlan(createEditorDocumentV4Fixture({
                narrative: null,
                revision: 2,
                subtitleTracks: [afterTrack],
                activeSubtitleTrackId: beforeTrack.id,
            })),
        });

        expect(Array.isArray(mapped) ? mapped.map((value) => value.type) : mapped).toEqual([
            'track.set-state',
            'subtitle.set-track-style',
            'subtitle-track.set-unlinked-video-policy',
            'subtitle.update',
            'track.set-state',
        ]);
        expect(Array.isArray(mapped) ? mapped.at(-1) : mapped).toMatchObject({
            type: 'track.set-state',
            payload: { trackId: beforeTrack.id, locked: true },
        });
    });

    it('maps narrative sample units and editorial link binding explicitly', () => {
        expect(mapStandaloneNarrativeCommand({
            type: 'trim-block',
            blockId: 'block_a',
            side: 'start',
            sample: 320,
        })[0]).toMatchObject({
            type: 'narrative.trim-block',
            payload: { blockId: 'block_a', side: 'start', sample16k: 320 },
        });
        expect(mapStandaloneLinkCommand({
            type: 'bind-target',
            target: { kind: 'video-clip', clipId: 'clip_a' },
            anchorBlockId: 'block_a',
            activeStartSample: 100,
            activeEndSample: 200,
        })[0]).toMatchObject({
            type: 'link.bind-target',
            payload: {
                activeStartSample16k: 100,
                activeEndSample16k: 200,
            },
        });
    });
});

function ordinaryPlan(
    document: ReturnType<typeof createEditorDocumentV4Fixture>,
): TimelineOrdinaryPlanSuccess {
    return {
        kind: 'success',
        command: 'test-command',
        label: 'Test command',
        document,
        targetTransforms: [],
        audioGraph: false,
        playhead: { kind: 'keep', reason: 'non-structural' },
    };
}
