import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createEditorDocumentV4Fixture,
    createEditorialDependentLinkFixture,
    createEditorialTranscriptBodyFixture,
    createSubtitleTrackV4Fixture,
    EDITORIAL_TEST_RECORD_ID,
} from '@/types/editorial.test-fixtures';
import type { EditorManifestV4 } from '@/types/video';
import type { EditorialTranscriptRepository } from '@/lib/storage/editorial-transcript-repository';
import type { EditorialTranscriptionCoordinator } from '@/lib/editorial-transcription/orchestrator';
import { DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES } from '@/lib/editorial-transcription/preferences';
import {
    EditorialTranscriptionRequestError,
    type EditorialTranscriptionFailureCode,
} from '@/lib/editorial-transcription/request';
import {
    setTimelinePersistenceBinding,
    useTimelineStore,
} from './timeline-store';
import { timelineEditorialRuntime } from './timeline-editorial-runtime';
import type {
    TimelineNarrativeActivationProgress,
    TimelineV4CommandResult,
} from './timeline-v4-command-types';

const originalTranscriptRepository = timelineEditorialRuntime.getRepository();
const originalTranscriptionCoordinator = timelineEditorialRuntime.getCoordinator();

const emptyHistory = {
    history: [],
    redoStack: [],
    historySequence: 0,
    historyBytes: 0,
};

const editorialWordId = `sha256:${'1'.repeat(64)}`;
const editorialSecondWordId = `sha256:${'5'.repeat(64)}`;
const editorialRegionId = `sha256:${'2'.repeat(64)}`;
const editorialStartBoundaryId = `sha256:${'3'.repeat(64)}`;
const editorialEndBoundaryId = `sha256:${'4'.repeat(64)}`;

const createHydratedNarrativeFixture = () => {
    const document = createEditorDocumentV4Fixture();
    const block = document.narrative!.blocks.narrative_block_1;
    if (block.kind !== 'speech') throw new Error('The narrative test fixture must contain speech.');
    document.narrative!.blocks.narrative_block_1 = {
        ...block,
        sourceWordIds: [editorialWordId],
    };
    const fixtureBody = createEditorialTranscriptBodyFixture();
    const body = createEditorialTranscriptBodyFixture({
        words: [{ ...fixtureBody.words[0], id: editorialWordId }],
        speechRegions: [{ ...fixtureBody.speechRegions[0], id: editorialRegionId }],
        editBoundaries: [{
            ...fixtureBody.editBoundaries[0],
            id: editorialStartBoundaryId,
            regionId: editorialRegionId,
        }, {
            ...fixtureBody.editBoundaries[1],
            id: editorialEndBoundaryId,
            regionId: editorialRegionId,
        }],
    });
    return { document, body };
};

const createTwoWordNarrativeFixture = () => {
    const { document, body } = createHydratedNarrativeFixture();
    const firstWord = body.words[0];
    body.words = [{
        ...firstWord,
        alignedEndSample: 8_000,
        editableEndSample: 8_000,
    }, {
        ...firstWord,
        id: editorialSecondWordId,
        text: 'World',
        alignedStartSample: 8_000,
        alignedEndSample: 16_000,
        editableStartSample: 8_000,
        editableEndSample: 16_000,
    }];
    body.speechRegions = body.speechRegions.map((region) => ({
        ...region,
        wordEndIndex: 2,
    }));
    const block = document.narrative!.blocks.narrative_block_1;
    if (block.kind !== 'speech') throw new Error('The narrative test fixture must contain speech.');
    document.narrative!.blocks.narrative_block_1 = {
        ...block,
        sourceWordIds: [editorialWordId, editorialSecondWordId],
    };
    return { document, body };
};

describe('Timeline store V4 command boundary', () => {
    beforeEach(async () => {
        setTimelinePersistenceBinding(null);
        await timelineEditorialRuntime.detachProject();
        timelineEditorialRuntime.configure({ quietWindowDecoder: null });
        useTimelineStore.getState().resetEditorDocument();
        useTimelineStore.setState(emptyHistory);
    });

    afterEach(async () => {
        setTimelinePersistenceBinding(null);
        await timelineEditorialRuntime.detachProject();
        timelineEditorialRuntime.configure({
            repository: originalTranscriptRepository,
            coordinator: originalTranscriptionCoordinator,
        });
    });

    it.each(['ripple', 'absolute'] as const)(
        'publishes one ordinary %s video deletion with exact placement, history, persistence, and audio revision',
        (mode) => {
            const fixture = createEditorDocumentV4Fixture();
            const secondClip = {
                ...fixture.videoClips[0],
                id: 'video_clip_second',
                timelineStartFrame: 30,
                sourceStart: 1,
                sourceEnd: 2,
            };
            useTimelineStore.getState().hydrateEditorDocument({
                ...fixture,
                globalEditingMode: mode,
                editorialTranscriptDescriptors: [],
                narrative: null,
                dependentLinks: [],
                videoClips: [fixture.videoClips[0], secondClip],
                transientSelection: { kind: 'video-clip', clipId: fixture.videoClips[0].id },
            }, emptyHistory);
            const enqueueV4 = vi.fn();
            setTimelinePersistenceBinding({
                projectId: 'project_v4_ordinary',
                generation: 1,
                enqueue: vi.fn(),
                enqueueV4,
            });
            const before = useTimelineStore.getState();

            const result = before.executeOrdinaryV4Command({
                target: { kind: 'video-clip', clipId: fixture.videoClips[0].id },
                action: { kind: 'delete' },
            });

            expect(result.kind).toBe('success');
            expect(useTimelineStore.getState()).toMatchObject({
                revision: before.revision + 1,
                audioGraphRevision: before.audioGraphRevision + 1,
                historySequence: before.historySequence + 1,
                transientSelection: { kind: 'none' },
            });
            expect(useTimelineStore.getState().history).toHaveLength(1);
            expect(useTimelineStore.getState().videoClips).toEqual([
                expect.objectContaining({
                    id: secondClip.id,
                    timelineStartFrame: mode === 'ripple' ? 0 : 30,
                }),
            ]);
            expect(enqueueV4).toHaveBeenCalledTimes(1);
        },
    );

    it('splits ordinary 29.97 fps media on an exact native frame before Text activation', () => {
        const fixture = createEditorDocumentV4Fixture();
        const duration = 2.000333;
        useTimelineStore.getState().hydrateEditorDocument({
            ...fixture,
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
            videoSources: [{ ...fixture.videoSources[0], duration, fps: 29.97 }],
            videoClips: [{ ...fixture.videoClips[0], sourceEnd: duration }],
        }, emptyHistory);

        const result = useTimelineStore.getState().executeOrdinaryV4Command({
            target: { kind: 'video-clip', clipId: fixture.videoClips[0].id },
            action: { kind: 'split', at: 24, childId: 'video_clip_native_right' },
        });

        expect(result.kind).toBe('success');
        expect(useTimelineStore.getState().videoClips).toEqual([
            expect.objectContaining({ sourceStart: 0, sourceEnd: 24 / 29.97 }),
            expect.objectContaining({
                id: 'video_clip_native_right',
                timelineStartFrame: 24,
                sourceStart: 24 / 29.97,
                sourceEnd: duration,
            }),
        ]);
    });

    it('prunes the source video lane when its final ordinary clip moves to another lane', async () => {
        const fixture = createEditorDocumentV4Fixture();
        const destinationTrackId = fixture.videoTracks[0].id;
        const sourceTrackId = 'video_track_source_lane';
        const movedClip = {
            ...fixture.videoClips[0],
            id: 'video_clip_source_lane',
            trackId: sourceTrackId,
            timelineStartFrame: 30,
            sourceStart: 1,
            sourceEnd: 2,
        };
        useTimelineStore.getState().hydrateEditorDocument({
            ...fixture,
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
            videoClips: [fixture.videoClips[0], movedClip],
            videoTracks: [...fixture.videoTracks, {
                id: sourceTrackId,
                name: 'Source lane',
                visible: true,
                locked: false,
            }],
        }, emptyHistory);

        const before = useTimelineStore.getState();
        before.moveVideoClipToTrack(movedClip.id, destinationTrackId);

        expect(useTimelineStore.getState().videoTracks.map((track) => track.id)).toEqual([
            destinationTrackId,
        ]);
        expect(useTimelineStore.getState().videoClips.find((clip) => clip.id === movedClip.id))
            .toMatchObject({ trackId: destinationTrackId, timelineStartFrame: 30 });
        expect(useTimelineStore.getState().history).toHaveLength(1);

        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState().videoTracks.map((track) => track.id)).toEqual([
            destinationTrackId,
            sourceTrackId,
        ]);
        expect(useTimelineStore.getState().videoClips.find((clip) => clip.id === movedClip.id))
            .toMatchObject({ trackId: sourceTrackId, timelineStartFrame: 30 });
    });

    it('synchronizes canonical narrative selection between Text and owned Timeline clips', () => {
        const { document: baseDocument, body } = createHydratedNarrativeFixture();
        const ordinaryClip = {
            ...baseDocument.videoClips[0],
            id: 'video_clip_ordinary',
            trackId: 'video_track_ordinary',
            timelineStartFrame: 30,
            sourceStart: 1,
            sourceEnd: 2,
        };
        const document = {
            ...baseDocument,
            videoClips: [...baseDocument.videoClips, ordinaryClip],
            videoTracks: [...baseDocument.videoTracks, {
                id: 'video_track_ordinary',
                name: 'Ordinary video',
                visible: true,
                locked: false,
            }],
        };
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        useTimelineStore.getState().hydrateEditorDocument(document, emptyHistory);

        expect(useTimelineStore.getState().selectNarrativeRange(
            'narrative_block_1',
            [editorialWordId],
            { boundaryId: editorialStartBoundaryId, side: 'start' },
        )).toBe(true);
        expect(useTimelineStore.getState()).toMatchObject({
            transientSelection: {
                kind: 'narrative',
                trackId: 'video_track_editorial',
                blockId: 'narrative_block_1',
                sourceWordIds: [editorialWordId],
                boundary: { boundaryId: editorialStartBoundaryId, side: 'start' },
            },
            selectedClipId: 'video_clip_editorial',
            selectedSubtitleIds: [],
            lastSelectedId: null,
            isVideoSelected: true,
        });

        useTimelineStore.getState().selectClip(ordinaryClip.id);
        expect(useTimelineStore.getState().transientSelection).toEqual({
            kind: 'video-clip',
            clipId: ordinaryClip.id,
        });

        useTimelineStore.getState().selectClip('video_clip_editorial');
        expect(useTimelineStore.getState().transientSelection).toEqual({
            kind: 'narrative',
            trackId: 'video_track_editorial',
            blockId: 'narrative_block_1',
            sourceWordIds: [],
            boundary: null,
        });
        expect(useTimelineStore.getState().selectNarrativeRange(
            'narrative_block_1',
            [editorialWordId],
        )).toBe(true);
        useTimelineStore.getState().selectClip('video_clip_editorial');
        expect(useTimelineStore.getState().transientSelection).toMatchObject({
            kind: 'narrative',
            sourceWordIds: [editorialWordId],
        });

        useTimelineStore.getState().clearSelection();
        expect(useTimelineStore.getState()).toMatchObject({
            transientSelection: { kind: 'none' },
            selectedClipId: null,
            selectedSubtitleIds: [],
            lastSelectedId: null,
            isVideoSelected: false,
        });
    });

    it('rejects stale, duplicate, reversed, and out-of-block narrative identities without mutation', () => {
        const { document, body } = createTwoWordNarrativeFixture();
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        useTimelineStore.getState().hydrateEditorDocument(document, emptyHistory);
        expect(useTimelineStore.getState().selectNarrativeRange(
            'narrative_block_1',
            [editorialWordId, editorialSecondWordId],
        )).toBe(true);
        const before = useTimelineStore.getState();
        const selectionReference = before.transientSelection;

        expect(before.selectNarrativeRange(
            'narrative_block_1',
            [editorialSecondWordId, editorialWordId],
        )).toBe(false);
        expect(before.selectNarrativeRange(
            'narrative_block_1',
            [editorialWordId, editorialWordId],
        )).toBe(false);
        expect(before.selectNarrativeRange(
            'narrative_block_1',
            [`sha256:${'8'.repeat(64)}`],
        )).toBe(false);
        expect(before.selectNarrativeRange('narrative_block_stale', [])).toBe(false);
        expect(before.selectNarrativeRange(
            'narrative_block_1',
            [editorialWordId],
            { boundaryId: `sha256:${'9'.repeat(64)}`, side: 'end' },
        )).toBe(false);

        const after = useTimelineStore.getState();
        expect(after.transientSelection).toBe(selectionReference);
        expect(after.selectedClipId).toBe(before.selectedClipId);
        expect(after.revision).toBe(before.revision);
        expect(after.history).toEqual(before.history);
    });

    it('repairs split selection and restores exact Text/Timeline selection through Undo and Redo', async () => {
        const { document, body } = createTwoWordNarrativeFixture();
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        timelineEditorialRuntime.configure({
            repository: { getRecord: vi.fn(async () => body) } as unknown as EditorialTranscriptRepository,
        });
        useTimelineStore.getState().hydrateEditorDocument(document, emptyHistory);
        expect(useTimelineStore.getState().selectNarrativeRange(
            'narrative_block_1',
            [editorialWordId],
        )).toBe(true);

        const result = await useTimelineStore.getState().executeNarrativeCommand({
            type: 'split-block',
            blockId: 'narrative_block_1',
            splitSample: 8_000,
        });
        expect(result.kind).toBe('success');
        const split = useTimelineStore.getState();
        expect(split.transientSelection.kind).toBe('narrative');
        if (split.transientSelection.kind !== 'narrative') throw new Error('Expected narrative selection.');
        const selectedSplitBlock = split.narrative?.blocks[split.transientSelection.blockId];
        expect(split.transientSelection.sourceWordIds).toEqual([editorialSecondWordId]);
        expect(split.selectedClipId).toBe(selectedSplitBlock?.clipId);
        const splitSelection = structuredClone(split.transientSelection);
        const splitClipId = split.selectedClipId;

        await split.undo();
        expect(useTimelineStore.getState()).toMatchObject({
            transientSelection: {
                kind: 'narrative',
                blockId: 'narrative_block_1',
                sourceWordIds: [editorialWordId],
            },
            selectedClipId: 'video_clip_editorial',
            isVideoSelected: true,
        });

        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState().transientSelection).toEqual(splitSelection);
        expect(useTimelineStore.getState().selectedClipId).toBe(splitClipId);
        expect(useTimelineStore.getState().isVideoSelected).toBe(true);
    });

    it('clears a deleted narrative selection and restores it exactly through Undo and Redo', async () => {
        const { document, body } = createHydratedNarrativeFixture();
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        timelineEditorialRuntime.configure({
            repository: { getRecord: vi.fn(async () => body) } as unknown as EditorialTranscriptRepository,
        });
        useTimelineStore.getState().hydrateEditorDocument(document, emptyHistory);
        expect(useTimelineStore.getState().selectNarrativeRange(
            'narrative_block_1',
            [editorialWordId],
        )).toBe(true);

        const result = await useTimelineStore.getState().executeNarrativeCommand({
            type: 'delete-words',
            firstBlockId: 'narrative_block_1',
            firstWordId: editorialWordId,
            lastBlockId: 'narrative_block_1',
            lastWordId: editorialWordId,
        });
        expect(result.kind).toBe('success');
        expect(useTimelineStore.getState()).toMatchObject({
            transientSelection: { kind: 'none' },
            selectedClipId: null,
            isVideoSelected: false,
        });

        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState()).toMatchObject({
            transientSelection: {
                kind: 'narrative',
                trackId: 'video_track_editorial',
                blockId: 'narrative_block_1',
                sourceWordIds: [editorialWordId],
            },
            selectedClipId: 'video_clip_editorial',
            isVideoSelected: true,
        });

        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState()).toMatchObject({
            transientSelection: { kind: 'none' },
            selectedClipId: null,
            isVideoSelected: false,
        });
    });

    it.each(['ripple', 'absolute'] as const)(
        'routes the legacy subtitle delete action through %s mode and removes its dependent link atomically',
        (mode) => {
            const { document: baseDocument, body } = createHydratedNarrativeFixture();
            const subtitleTrack = createSubtitleTrackV4Fixture({
                subtitles: [
                    { id: 'subtitle_1', startTime: 0, endTime: 1, text: 'Delete' },
                    { id: 'subtitle_2', startTime: 2, endTime: 3, text: 'Later' },
                ],
            });
            const document = {
                ...baseDocument,
                globalEditingMode: mode,
                subtitleTracks: [subtitleTrack],
                activeSubtitleTrackId: subtitleTrack.id,
                dependentLinks: [createEditorialDependentLinkFixture()],
            };
            timelineEditorialRuntime.injectResolvedBodies({
                [EDITORIAL_TEST_RECORD_ID]: body,
            });
            useTimelineStore.getState().hydrateEditorDocument(document, emptyHistory);
            const enqueueV4 = vi.fn();
            setTimelinePersistenceBinding({
                projectId: `project_legacy_subtitle_delete_${mode}`,
                generation: 1,
                enqueue: vi.fn(),
                enqueueV4,
            });
            const before = useTimelineStore.getState();

            before.removeSubtitleFromTrack(subtitleTrack.id, 'subtitle_1');

            const after = useTimelineStore.getState();
            expect(after.tracks[0].subtitles).toEqual([{
                id: 'subtitle_2',
                startTime: mode === 'ripple' ? 1 : 2,
                endTime: mode === 'ripple' ? 2 : 3,
                text: 'Later',
            }]);
            expect(after.dependentLinks).toEqual([]);
            expect(after.revision).toBe(before.revision + 1);
            expect(after.history).toHaveLength(1);
            expect(enqueueV4).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['ripple', 'absolute'] as const)(
        'finalizes the legacy subtitle resize drag once under %s mode and refreshes its link',
        (mode) => {
            const { document: baseDocument, body } = createHydratedNarrativeFixture();
            const subtitleTrack = createSubtitleTrackV4Fixture({
                subtitles: [
                    { id: 'subtitle_1', startTime: 0, endTime: 1, text: 'Resize' },
                    { id: 'subtitle_2', startTime: 2, endTime: 3, text: 'Later' },
                ],
            });
            const document = {
                ...baseDocument,
                globalEditingMode: mode,
                subtitleTracks: [subtitleTrack],
                activeSubtitleTrackId: subtitleTrack.id,
                transientSelection: {
                    kind: 'subtitles' as const,
                    trackId: subtitleTrack.id,
                    subtitleIds: ['subtitle_1'],
                },
                dependentLinks: [createEditorialDependentLinkFixture({
                    association: { kind: 'overlap', origin: 'manual' },
                })],
            };
            timelineEditorialRuntime.injectResolvedBodies({
                [EDITORIAL_TEST_RECORD_ID]: body,
            });
            useTimelineStore.getState().hydrateEditorDocument(document, emptyHistory);
            const enqueueV4 = vi.fn();
            setTimelinePersistenceBinding({
                projectId: `project_legacy_subtitle_drag_${mode}`,
                generation: 1,
                enqueue: vi.fn(),
                enqueueV4,
            });
            const before = useTimelineStore.getState();

            before.setIsDragging(true, { label: 'Resize subtitle' });
            useTimelineStore.getState().updateSubtitleInTrack(
                subtitleTrack.id,
                'subtitle_1',
                { endTime: 0.5 },
                { skipHistory: true },
            );
            useTimelineStore.getState().setIsDragging(false);

            const after = useTimelineStore.getState();
            expect(after.tracks[0].subtitles).toEqual([
                { id: 'subtitle_1', startTime: 0, endTime: 0.5, text: 'Resize' },
                {
                    id: 'subtitle_2',
                    startTime: mode === 'ripple' ? 1.5 : 2,
                    endTime: mode === 'ripple' ? 2.5 : 3,
                    text: 'Later',
                },
            ]);
            expect(after.dependentLinks).toHaveLength(1);
            expect(after.dependentLinks[0].target).toEqual({
                kind: 'subtitle',
                trackId: subtitleTrack.id,
                subtitleId: 'subtitle_1',
            });
            expect(after.revision).toBe(before.revision + 1);
            expect(after.history).toHaveLength(1);
            expect(enqueueV4).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['ripple', 'absolute'] as const)(
        'routes the legacy trim-at-playhead action through %s mode and refreshes its link',
        (mode) => {
            const { document: baseDocument, body } = createHydratedNarrativeFixture();
            const subtitleTrack = createSubtitleTrackV4Fixture({
                subtitles: [
                    { id: 'subtitle_1', startTime: 0, endTime: 1, text: 'Trim' },
                    { id: 'subtitle_2', startTime: 2, endTime: 3, text: 'Later' },
                ],
            });
            timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
            useTimelineStore.getState().hydrateEditorDocument({
                ...baseDocument,
                globalEditingMode: mode,
                subtitleTracks: [subtitleTrack],
                activeSubtitleTrackId: subtitleTrack.id,
                dependentLinks: [createEditorialDependentLinkFixture({
                    association: { kind: 'overlap', origin: 'manual' },
                })],
            }, emptyHistory);
            const enqueueV4 = vi.fn();
            setTimelinePersistenceBinding({
                projectId: `project_legacy_subtitle_trim_${mode}`,
                generation: 1,
                enqueue: vi.fn(),
                enqueueV4,
            });
            const before = useTimelineStore.getState();

            before.trimSubtitleAtTime(0.5, 'end');

            const after = useTimelineStore.getState();
            expect(after.tracks[0].subtitles).toEqual([
                { id: 'subtitle_1', startTime: 0, endTime: 0.5, text: 'Trim' },
                {
                    id: 'subtitle_2',
                    startTime: mode === 'ripple' ? 1.5 : 2,
                    endTime: mode === 'ripple' ? 2.5 : 3,
                    text: 'Later',
                },
            ]);
            expect(after.dependentLinks).toHaveLength(1);
            expect(after.revision).toBe(before.revision + 1);
            expect(after.history).toHaveLength(1);
            expect(enqueueV4).toHaveBeenCalledTimes(1);
        },
    );

    it('updates a dependent-link identity when the legacy subtitle move action changes tracks', () => {
        const { document: baseDocument, body } = createHydratedNarrativeFixture();
        const sourceTrack = createSubtitleTrackV4Fixture({
            subtitles: [{ id: 'subtitle_1', startTime: 0, endTime: 1, text: 'Move' }],
        });
        const targetTrack = createSubtitleTrackV4Fixture({
            id: 'subtitle_track_target',
            name: 'Target subtitles',
        });
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        useTimelineStore.getState().hydrateEditorDocument({
            ...baseDocument,
            subtitleTracks: [sourceTrack, targetTrack],
            activeSubtitleTrackId: sourceTrack.id,
            transientSelection: {
                kind: 'subtitles',
                trackId: sourceTrack.id,
                subtitleIds: ['subtitle_1'],
            },
            dependentLinks: [createEditorialDependentLinkFixture()],
        }, emptyHistory);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_legacy_subtitle_track_move',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const before = useTimelineStore.getState();

        before.moveSubtitleToTrack('subtitle_1', sourceTrack.id, targetTrack.id);

        const after = useTimelineStore.getState();
        expect(after.tracks[0].subtitles).toEqual([]);
        expect(after.tracks[1].subtitles).toEqual([
            { id: 'subtitle_1', startTime: 0, endTime: 1, text: 'Move' },
        ]);
        expect(after.dependentLinks[0].target).toEqual({
            kind: 'subtitle',
            trackId: targetTrack.id,
            subtitleId: 'subtitle_1',
        });
        expect(after.revision).toBe(before.revision + 1);
        expect(after.history).toHaveLength(1);
        expect(enqueueV4).toHaveBeenCalledTimes(1);
    });

    it('finalizes a legacy vertical subtitle drag and its link in one V4 transaction', () => {
        const { document: baseDocument, body } = createHydratedNarrativeFixture();
        const sourceTrack = createSubtitleTrackV4Fixture({
            subtitles: [{ id: 'subtitle_1', startTime: 0, endTime: 1, text: 'Move' }],
        });
        const targetTrack = createSubtitleTrackV4Fixture({
            id: 'subtitle_track_target',
            name: 'Target subtitles',
        });
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        useTimelineStore.getState().hydrateEditorDocument({
            ...baseDocument,
            subtitleTracks: [sourceTrack, targetTrack],
            activeSubtitleTrackId: sourceTrack.id,
            transientSelection: {
                kind: 'subtitles',
                trackId: sourceTrack.id,
                subtitleIds: ['subtitle_1'],
            },
            dependentLinks: [createEditorialDependentLinkFixture()],
        }, emptyHistory);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_legacy_subtitle_vertical_drag',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const before = useTimelineStore.getState();

        before.setIsDragging(true, { label: 'Move subtitles between tracks' });
        useTimelineStore.getState().moveSubtitlesToTrack(['subtitle_1'], 1, { skipHistory: true });
        useTimelineStore.getState().setIsDragging(false);

        const after = useTimelineStore.getState();
        expect(after.tracks[0].subtitles).toEqual([]);
        expect(after.tracks[1].subtitles).toEqual([
            { id: 'subtitle_1', startTime: 0, endTime: 1, text: 'Move' },
        ]);
        expect(after.dependentLinks[0].target).toEqual({
            kind: 'subtitle',
            trackId: targetTrack.id,
            subtitleId: 'subtitle_1',
        });
        expect(after.revision).toBe(before.revision + 1);
        expect(after.history).toHaveLength(1);
        expect(enqueueV4).toHaveBeenCalledTimes(1);
    });

    it('applies unlinked subtitle video-ripple policy while an explicit link takes precedence', () => {
        const { document: baseDocument, body } = createHydratedNarrativeFixture();
        const uncontrolledClip = {
            ...baseDocument.videoClips[0],
            id: 'video_clip_uncontrolled',
            timelineStartFrame: 30,
            sourceStart: 1,
            sourceEnd: 2,
        };
        const subtitleTrack = createSubtitleTrackV4Fixture({
            unlinkedVideoEditResponse: 'follow-project-ripple',
            subtitles: [
                { id: 'subtitle_1', startTime: 2, endTime: 3, text: 'Linked' },
                { id: 'subtitle_unlinked', startTime: 3, endTime: 4, text: 'Follow' },
            ],
        });
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        useTimelineStore.getState().hydrateEditorDocument({
            ...baseDocument,
            subtitleTracks: [subtitleTrack],
            activeSubtitleTrackId: subtitleTrack.id,
            videoClips: [...baseDocument.videoClips, uncontrolledClip],
            dependentLinks: [createEditorialDependentLinkFixture({
                relativeStartOutputSample: 96_000,
                relativeEndOutputSample: 144_000,
            })],
        }, emptyHistory);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_unlinked_subtitle_response',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const before = useTimelineStore.getState();

        before.deleteVideoClip(uncontrolledClip.id);

        const after = useTimelineStore.getState();
        expect(after.tracks[0].subtitles).toEqual([
            { id: 'subtitle_1', startTime: 2, endTime: 3, text: 'Linked' },
            { id: 'subtitle_unlinked', startTime: 2, endTime: 3, text: 'Follow' },
        ]);
        expect(after.dependentLinks).toHaveLength(1);
        expect(after.revision).toBe(before.revision + 1);
        expect(after.history).toHaveLength(1);
        expect(enqueueV4).toHaveBeenCalledTimes(1);
    });

    it('treats an identical video placement as a strict no-op before subtitle ripple processing', () => {
        const fixture = createEditorDocumentV4Fixture();
        const subtitleTrack = createSubtitleTrackV4Fixture({
            unlinkedVideoEditResponse: 'follow-project-ripple',
            subtitles: [{ id: 'subtitle_drag_noop', startTime: 0, endTime: 1, text: 'Keep me' }],
        });
        useTimelineStore.getState().hydrateEditorDocument({
            ...fixture,
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
            subtitleTracks: [subtitleTrack],
            activeSubtitleTrackId: subtitleTrack.id,
            transientSelection: {
                kind: 'subtitles',
                trackId: subtitleTrack.id,
                subtitleIds: ['subtitle_drag_noop'],
            },
        }, emptyHistory);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_video_drag_noop',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const before = useTimelineStore.getState();

        const result = before.executeOrdinaryV4Command({
            target: { kind: 'video-clip', clipId: fixture.videoClips[0].id },
            action: {
                kind: 'move',
                targetTrackId: fixture.videoTracks[0].id,
                targetStart: fixture.videoClips[0].timelineStartFrame,
            },
        });

        expect(result.kind).toBe('noop');
        const after = useTimelineStore.getState();
        expect(after.tracks).toEqual(before.tracks);
        expect(after.transientSelection).toEqual(before.transientSelection);
        expect(after.revision).toBe(before.revision);
        expect(after.history).toEqual(before.history);
        expect(enqueueV4).not.toHaveBeenCalled();
    });

    it('moves video vertically without removing follow-project-ripple cues and restores it atomically', async () => {
        const fixture = createEditorDocumentV4Fixture();
        const destinationTrack = {
            id: 'video_track_drag_destination',
            name: 'Destination',
            visible: true,
            locked: false,
        };
        const subtitleTrack = createSubtitleTrackV4Fixture({
            unlinkedVideoEditResponse: 'follow-project-ripple',
            subtitles: [{ id: 'subtitle_vertical_drag', startTime: 0, endTime: 1, text: 'Keep me' }],
        });
        useTimelineStore.getState().hydrateEditorDocument({
            ...fixture,
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
            videoTracks: [...fixture.videoTracks, destinationTrack],
            subtitleTracks: [subtitleTrack],
            activeSubtitleTrackId: subtitleTrack.id,
        }, emptyHistory);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_video_vertical_drag',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const before = useTimelineStore.getState();

        const result = before.executeOrdinaryV4Command({
            target: { kind: 'video-clip', clipId: fixture.videoClips[0].id },
            action: {
                kind: 'move',
                targetTrackId: destinationTrack.id,
                targetStart: fixture.videoClips[0].timelineStartFrame,
            },
        });

        expect(result.kind).toBe('success');
        const after = useTimelineStore.getState();
        expect(after.videoClips[0]).toMatchObject({
            trackId: destinationTrack.id,
            timelineStartFrame: fixture.videoClips[0].timelineStartFrame,
        });
        expect(after.tracks[0].subtitles).toEqual(subtitleTrack.subtitles);
        expect(after.history).toHaveLength(1);
        expect(enqueueV4).toHaveBeenCalledTimes(1);

        await after.undo();
        expect(useTimelineStore.getState().videoClips[0].trackId).toBe(fixture.videoTracks[0].id);
        expect(useTimelineStore.getState().tracks[0].subtitles).toEqual(subtitleTrack.subtitles);
        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState().videoClips[0].trackId).toBe(destinationTrack.id);
        expect(useTimelineStore.getState().tracks[0].subtitles).toEqual(subtitleTrack.subtitles);
    });

    it('keeps an active subtitle preview intact when a colliding video drop is rejected', () => {
        const fixture = createEditorDocumentV4Fixture();
        const secondClip = {
            ...fixture.videoClips[0],
            id: 'video_clip_collision',
            timelineStartFrame: 30,
            sourceStart: 1,
            sourceEnd: 2,
        };
        const subtitleTrack = createSubtitleTrackV4Fixture({
            subtitles: [{ id: 'subtitle_preview_collision', startTime: 0, endTime: 1, text: 'Preview' }],
        });
        useTimelineStore.getState().hydrateEditorDocument({
            ...fixture,
            globalEditingMode: 'absolute',
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
            videoClips: [fixture.videoClips[0], secondClip],
            subtitleTracks: [subtitleTrack],
            activeSubtitleTrackId: subtitleTrack.id,
        }, emptyHistory);
        useTimelineStore.getState().setIsDragging(true, { label: 'Preview subtitle drag' });
        useTimelineStore.getState().updateSubtitleInTrack(
            subtitleTrack.id,
            'subtitle_preview_collision',
            { endTime: 1.5 },
            { skipHistory: true },
        );
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_video_collision_preview',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const beforeDrop = useTimelineStore.getState();

        const result = beforeDrop.executeOrdinaryV4Command({
            target: { kind: 'video-clip', clipId: fixture.videoClips[0].id },
            action: {
                kind: 'move',
                targetTrackId: fixture.videoTracks[0].id,
                targetStart: secondClip.timelineStartFrame,
            },
        });

        expect(result).toMatchObject({ kind: 'error', error: { code: 'collision' } });
        const afterDrop = useTimelineStore.getState();
        expect(afterDrop.tracks).toEqual(beforeDrop.tracks);
        expect(afterDrop.transientSelection).toEqual(beforeDrop.transientSelection);
        expect(afterDrop.isDragging).toBe(true);
        expect(afterDrop.revision).toBe(beforeDrop.revision);
        expect(afterDrop.contentBoundaryRevision).toBe(beforeDrop.contentBoundaryRevision);
        expect(afterDrop.history).toEqual(beforeDrop.history);
        expect(enqueueV4).not.toHaveBeenCalled();
    });

    it('moves overlapping ripple-follow cues with a horizontal video drag and restores one transaction', async () => {
        const { document: fixture, body } = createHydratedNarrativeFixture();
        const movedClip = {
            ...fixture.videoClips[0],
            id: 'video_clip_subtitle_cargo',
            timelineStartFrame: 30,
            sourceStart: 1,
            sourceEnd: 2,
        };
        const followTrack = createSubtitleTrackV4Fixture({
            unlinkedVideoEditResponse: 'follow-project-ripple',
            subtitles: [{ id: 'subtitle_video_cargo', startTime: 1.2, endTime: 1.8, text: 'Cargo' }],
        });
        const absoluteTrack = createSubtitleTrackV4Fixture({
            id: 'subtitle_track_absolute',
            name: 'Absolute subtitles',
            unlinkedVideoEditResponse: 'stay-absolute',
            subtitles: [{ id: 'subtitle_absolute', startTime: 1.2, endTime: 1.8, text: 'Stay' }],
        });
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        timelineEditorialRuntime.configure({
            repository: { getRecord: vi.fn(async () => body) } as unknown as EditorialTranscriptRepository,
        });
        useTimelineStore.getState().hydrateEditorDocument({
            ...fixture,
            dependentLinks: [],
            videoClips: [...fixture.videoClips, movedClip],
            subtitleTracks: [followTrack, absoluteTrack],
            activeSubtitleTrackId: followTrack.id,
        }, emptyHistory);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_video_horizontal_drag',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const before = useTimelineStore.getState();

        const result = before.moveVideoClip(
            movedClip.id,
            fixture.videoTracks[0].id,
            60,
        );

        expect(result).toMatchObject({
            kind: 'success',
            targetTransforms: expect.arrayContaining([{
                kind: 'moved',
                target: {
                    kind: 'subtitle',
                    trackId: followTrack.id,
                    subtitleId: 'subtitle_video_cargo',
                },
            }]),
        });
        const moved = useTimelineStore.getState();
        expect(moved.videoClips.find((clip) => clip.id === movedClip.id)?.timelineStartFrame).toBe(60);
        expect(moved.tracks[0].subtitles).toEqual([
            { id: 'subtitle_video_cargo', startTime: 2.2, endTime: 2.8, text: 'Cargo' },
        ]);
        expect(moved.tracks[1].subtitles).toEqual(absoluteTrack.subtitles);
        expect(moved.history).toHaveLength(1);
        expect(enqueueV4).toHaveBeenCalledTimes(1);

        await moved.undo();
        expect(useTimelineStore.getState().videoClips.find((clip) => clip.id === movedClip.id)?.timelineStartFrame)
            .toBe(30);
        expect(useTimelineStore.getState().tracks[0].subtitles).toEqual(followTrack.subtitles);
        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState().videoClips.find((clip) => clip.id === movedClip.id)?.timelineStartFrame)
            .toBe(60);
        expect(useTimelineStore.getState().tracks[0].subtitles[0]).toMatchObject({
            startTime: 2.2,
            endTime: 2.8,
        });
    });

    it('records a ripple-shifted linked video peer in the direct-target ledger', () => {
        const { document: fixture, body } = createHydratedNarrativeFixture();
        const movedClip = {
            ...fixture.videoClips[0],
            id: 'video_clip_drag_source',
            timelineStartFrame: 30,
            sourceStart: 1,
            sourceEnd: 2,
        };
        const linkedPeer = {
            ...fixture.videoClips[0],
            id: 'video_clip_linked_peer',
            timelineStartFrame: 60,
            sourceStart: 2,
            sourceEnd: 3,
        };
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        useTimelineStore.getState().hydrateEditorDocument({
            ...fixture,
            videoClips: [...fixture.videoClips, movedClip, linkedPeer],
            dependentLinks: [createEditorialDependentLinkFixture({
                target: { kind: 'video-clip', clipId: linkedPeer.id },
                association: { kind: 'overlap', origin: 'manual' },
                relativeStartOutputSample: 96_000,
                relativeEndOutputSample: 144_000,
            })],
        }, emptyHistory);

        const result = useTimelineStore.getState().moveVideoClip(
            movedClip.id,
            fixture.videoTracks[0].id,
            60,
        );

        expect(result).toMatchObject({
            kind: 'success',
            targetTransforms: expect.arrayContaining([{
                kind: 'moved',
                target: { kind: 'video-clip', clipId: linkedPeer.id },
            }]),
        });
        const after = useTimelineStore.getState();
        expect(after.videoClips.find((clip) => clip.id === linkedPeer.id)?.timelineStartFrame).toBe(30);
        expect(after.dependentLinks[0]).toMatchObject({
            target: { kind: 'video-clip', clipId: linkedPeer.id },
            relativeStartOutputSample: 48_000,
            relativeEndOutputSample: 96_000,
        });
        expect(after.history).toHaveLength(1);
    });

    it('creates a destination lane and applies its horizontal video drop in one atomic command', async () => {
        const fixture = createEditorDocumentV4Fixture();
        useTimelineStore.getState().hydrateEditorDocument({
            ...fixture,
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
        }, emptyHistory);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_video_new_lane_drag',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const before = useTimelineStore.getState();

        const result = before.moveVideoClipToNewTrackAtFrame(
            fixture.videoClips[0].id,
            1,
            60,
            'video_track_drop_target',
            'Drop target',
        );

        expect(result.kind).toBe('success');
        const after = useTimelineStore.getState();
        expect(after.videoTracks).toEqual([{
            id: 'video_track_drop_target',
            name: 'Drop target',
            visible: true,
            locked: false,
            clipIds: [fixture.videoClips[0].id],
        }]);
        expect(after.videoClips[0]).toMatchObject({
            trackId: 'video_track_drop_target',
            timelineStartFrame: 60,
        });
        expect(after.revision).toBe(before.revision + 1);
        expect(after.history).toHaveLength(1);
        expect(enqueueV4).toHaveBeenCalledTimes(1);

        await after.undo();
        expect(useTimelineStore.getState().videoTracks.map((track) => track.id)).toEqual([
            fixture.videoTracks[0].id,
        ]);
        expect(useTimelineStore.getState().videoClips[0]).toMatchObject({
            trackId: fixture.videoTracks[0].id,
            timelineStartFrame: 0,
        });
    });

    it('rejects an invalid atomic insertion drop without publishing a lane, history, or persistence', () => {
        const fixture = createEditorDocumentV4Fixture();
        useTimelineStore.getState().hydrateEditorDocument({
            ...fixture,
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
        }, emptyHistory);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_video_invalid_new_lane_drag',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const before = useTimelineStore.getState();

        const result = before.moveVideoClipToNewTrackAtFrame(
            fixture.videoClips[0].id,
            1,
            -1,
            'video_track_invalid_drop',
        );

        expect(result).toMatchObject({ kind: 'error', error: { code: 'invalid-interval' } });
        const after = useTimelineStore.getState();
        expect(after.videoTracks).toEqual(before.videoTracks);
        expect(after.videoClips).toEqual(before.videoClips);
        expect(after.revision).toBe(before.revision);
        expect(after.history).toEqual(before.history);
        expect(enqueueV4).not.toHaveBeenCalled();
    });

    it('changes the visible V4 subtitle response policy once and restores it through Undo and Redo', async () => {
        const subtitleTrack = createSubtitleTrackV4Fixture({
            unlinkedVideoEditResponse: 'stay-absolute',
        });
        useTimelineStore.getState().hydrateEditorDocument(createEditorDocumentV4Fixture({
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
            subtitleTracks: [subtitleTrack],
            activeSubtitleTrackId: subtitleTrack.id,
        }), emptyHistory);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_v4_subtitle_response_policy',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const before = useTimelineStore.getState();

        before.setSubtitleTrackUnlinkedVideoEditResponse(
            subtitleTrack.id,
            'follow-project-ripple',
        );

        const changed = useTimelineStore.getState();
        expect(changed.tracks[0]).toMatchObject({
            unlinkedVideoEditResponse: 'follow-project-ripple',
            timingDomain: 'video-ripple',
        });
        expect(changed.revision).toBe(before.revision + 1);
        expect(changed.history).toHaveLength(1);
        expect(enqueueV4).toHaveBeenCalledTimes(1);

        await changed.undo();
        expect(useTimelineStore.getState().tracks[0]).toMatchObject({
            unlinkedVideoEditResponse: 'stay-absolute',
            timingDomain: 'absolute',
        });
        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState().tracks[0]).toMatchObject({
            unlinkedVideoEditResponse: 'follow-project-ripple',
            timingDomain: 'video-ripple',
        });
        expect(enqueueV4).toHaveBeenCalledTimes(3);

        const afterRedo = useTimelineStore.getState();
        afterRedo.setSubtitleTrackTimingDomain(subtitleTrack.id, 'absolute');
        afterRedo.setSubtitleTrackUnlinkedVideoEditResponse(subtitleTrack.id, 'invalid-policy' as never);
        expect(useTimelineStore.getState().revision).toBe(afterRedo.revision);
        expect(useTimelineStore.getState().tracks[0].unlinkedVideoEditResponse).toBe('follow-project-ripple');

        useTimelineStore.setState({
            tracks: afterRedo.tracks.map((track) => ({ ...track, isLocked: true })),
        });
        const locked = useTimelineStore.getState();
        locked.setSubtitleTrackUnlinkedVideoEditResponse(subtitleTrack.id, 'stay-absolute');
        expect(useTimelineStore.getState().revision).toBe(locked.revision);
        expect(useTimelineStore.getState().tracks[0].unlinkedVideoEditResponse).toBe('follow-project-ripple');
    });

    it('keeps the hidden timing-domain adapter restricted to an actual V3 store projection', () => {
        const legacyTrack = createSubtitleTrackV4Fixture() as ReturnType<typeof createSubtitleTrackV4Fixture>
            & { timingDomain?: 'video-ripple' | 'absolute' };
        delete (legacyTrack as Partial<typeof legacyTrack>).unlinkedVideoEditResponse;
        legacyTrack.timingDomain = 'video-ripple';
        useTimelineStore.setState({
            globalEditingMode: undefined as never,
            tracks: [legacyTrack],
            history: [],
            redoStack: [],
        });
        const before = useTimelineStore.getState();

        before.setSubtitleTrackTimingDomain(legacyTrack.id, 'absolute');

        const after = useTimelineStore.getState();
        expect(after.tracks[0]).toMatchObject({
            timingDomain: 'absolute',
            unlinkedVideoEditResponse: 'stay-absolute',
        });
        expect(after.revision).toBe(before.revision + 1);
        expect(after.history).toHaveLength(1);
    });

    it('routes legacy full-track subtitle split and merge callbacks through one V4 transaction each', () => {
        const subtitleTrack = createSubtitleTrackV4Fixture({
            subtitles: [{ id: 'subtitle_parent', startTime: 0, endTime: 1, text: 'One two' }],
        });
        useTimelineStore.getState().hydrateEditorDocument(createEditorDocumentV4Fixture({
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
            subtitleTracks: [subtitleTrack],
            activeSubtitleTrackId: subtitleTrack.id,
        }), emptyHistory);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_legacy_subtitle_split_merge',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const before = useTimelineStore.getState();

        before.setTracks([{ ...before.tracks[0], subtitles: [
            { id: 'subtitle_parent', startTime: 0, endTime: 0.5, text: 'One' },
            { id: 'subtitle_child', startTime: 0.5, endTime: 1, text: 'two' },
        ] }]);
        const split = useTimelineStore.getState();
        expect(split.tracks[0].subtitles).toEqual([
            { id: 'subtitle_parent', startTime: 0, endTime: 0.5, text: 'One' },
            { id: 'subtitle_child', startTime: 0.5, endTime: 1, text: 'two' },
        ]);
        expect(split.revision).toBe(before.revision + 1);
        expect(split.history).toHaveLength(1);
        expect(enqueueV4).toHaveBeenCalledTimes(1);

        split.setTracks([{ ...split.tracks[0], subtitles: [
            { id: 'subtitle_parent', startTime: 0, endTime: 1, text: 'One two' },
        ] }]);
        const merged = useTimelineStore.getState();
        expect(merged.tracks[0].subtitles).toEqual([
            { id: 'subtitle_parent', startTime: 0, endTime: 1, text: 'One two' },
        ]);
        expect(merged.revision).toBe(split.revision + 1);
        expect(merged.history).toHaveLength(2);
        expect(enqueueV4).toHaveBeenCalledTimes(2);
    });

    it.each(['ripple', 'absolute'] as const)(
        'routes the legacy video reorder action through %s mode without a structural bypass',
        (mode) => {
            const fixture = createEditorDocumentV4Fixture();
            const secondClip = {
                ...fixture.videoClips[0],
                id: 'video_clip_second',
                timelineStartFrame: 30,
                sourceStart: 1,
                sourceEnd: 2,
            };
            useTimelineStore.getState().hydrateEditorDocument({
                ...fixture,
                globalEditingMode: mode,
                editorialTranscriptDescriptors: [],
                narrative: null,
                dependentLinks: [],
                videoClips: [fixture.videoClips[0], secondClip],
            }, emptyHistory);
            useTimelineStore.getState().selectClip(secondClip.id);
            const enqueueV4 = vi.fn();
            setTimelinePersistenceBinding({
                projectId: `project_legacy_reorder_${mode}`,
                generation: 1,
                enqueue: vi.fn(),
                enqueueV4,
            });
            const before = useTimelineStore.getState();

            before.reorderVideoClips([secondClip.id, fixture.videoClips[0].id]);

            const after = useTimelineStore.getState();
            if (mode === 'ripple') {
                expect(after.videoClips.map((clip) => [clip.id, clip.timelineStartFrame])).toEqual([
                    [secondClip.id, 0],
                    [fixture.videoClips[0].id, 30],
                ]);
                expect(after.revision).toBe(before.revision + 1);
                expect(after.history).toHaveLength(1);
                expect(enqueueV4).toHaveBeenCalledTimes(1);
            } else {
                expect(after.revision).toBe(before.revision);
                expect(after.videoClips).toEqual(before.videoClips);
                expect(after.history).toEqual(before.history);
                expect(enqueueV4).not.toHaveBeenCalled();
            }
        },
    );

    it('rejects legacy video reorder when the selected clip is narrative-owned', () => {
        const { document, body } = createHydratedNarrativeFixture();
        const secondClip = {
            ...document.videoClips[0],
            id: 'video_clip_uncontrolled',
            timelineStartFrame: 30,
            sourceStart: 1,
            sourceEnd: 2,
        };
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        useTimelineStore.getState().hydrateEditorDocument({
            ...document,
            videoClips: [...document.videoClips, secondClip],
        }, emptyHistory);
        useTimelineStore.getState().selectClip(document.videoClips[0].id);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_controlled_reorder_guard',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const before = useTimelineStore.getState();

        before.reorderVideoClips([secondClip.id, document.videoClips[0].id]);

        const after = useTimelineStore.getState();
        expect(after.revision).toBe(before.revision);
        expect(after.videoClips).toEqual(before.videoClips);
        expect(after.history).toEqual(before.history);
        expect(enqueueV4).not.toHaveBeenCalled();
    });

    it.each(['ripple', 'absolute'] as const)(
        'keeps the selected insertion rule for a legacy %s video start trim',
        (mode) => {
            const fixture = createEditorDocumentV4Fixture();
            const secondClip = {
                ...fixture.videoClips[0],
                id: 'video_clip_second',
                timelineStartFrame: 30,
                sourceStart: 1,
                sourceEnd: 2,
            };
            useTimelineStore.getState().hydrateEditorDocument({
                ...fixture,
                globalEditingMode: mode,
                editorialTranscriptDescriptors: [],
                narrative: null,
                dependentLinks: [],
                videoClips: [fixture.videoClips[0], secondClip],
            }, emptyHistory);
            const enqueueV4 = vi.fn();
            setTimelinePersistenceBinding({
                projectId: `project_legacy_video_start_trim_${mode}`,
                generation: 1,
                enqueue: vi.fn(),
                enqueueV4,
            });
            const before = useTimelineStore.getState();

            before.trimVideoClip(fixture.videoClips[0].id, 0.5, 1);

            const after = useTimelineStore.getState();
            expect(after.videoClips).toEqual([
                expect.objectContaining({
                    id: fixture.videoClips[0].id,
                    timelineStartFrame: mode === 'ripple' ? 0 : 15,
                    sourceStart: 0.5,
                    sourceEnd: 1,
                }),
                expect.objectContaining({
                    id: secondClip.id,
                    timelineStartFrame: mode === 'ripple' ? 15 : 30,
                }),
            ]);
            expect(after.revision).toBe(before.revision + 1);
            expect(after.history).toHaveLength(1);
            expect(enqueueV4).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['ripple', 'absolute'] as const)(
        'keeps the selected insertion rule for a legacy %s imported-audio start trim',
        (mode) => {
            const fixture = createEditorDocumentV4Fixture();
            const audioFile = {
                name: 'trim-audio.wav',
                type: 'audio/wav',
                size: 192_000,
                lastModified: 1_700_000_000_000,
            } as File;
            const audioSource = {
                id: 'audio_source_trim',
                originalName: audioFile.name,
                mimeType: audioFile.type,
                size: audioFile.size,
                lastModified: audioFile.lastModified,
                fingerprint: 'trim-audio-fingerprint',
                duration: 2,
                nativeSampleRate: 48_000,
                nativeSampleCount: 96_000,
                nativeChannelCount: 1,
                bitrate: 768_000,
                codec: 'pcm_s16le',
                file: audioFile,
            };
            const makeClip = (id: string, timelineStartFrame: number, sourceStartSample: number) => ({
                id,
                source: { kind: 'audio-source' as const, audioSourceId: audioSource.id },
                timelineStartFrame,
                sourceStartSample,
                sourceEndSample: sourceStartSample + 48_000,
                muted: false,
                gainDb: 0,
                fadeInSamples: 0,
                fadeOutSamples: 0,
            });
            useTimelineStore.getState().hydrateEditorDocument({
                ...fixture,
                globalEditingMode: mode,
                editorialTranscriptDescriptors: [],
                narrative: null,
                dependentLinks: [],
                audioSources: [audioSource],
                audioTracks: [{
                    id: 'audio_track_trim',
                    name: 'Trim audio',
                    muted: false,
                    solo: false,
                    locked: false,
                    gainDb: 0,
                    clips: [makeClip('audio_clip_first', 0, 0), makeClip('audio_clip_second', 30, 48_000)],
                }],
            }, emptyHistory);
            const enqueueV4 = vi.fn();
            setTimelinePersistenceBinding({
                projectId: `project_legacy_audio_start_trim_${mode}`,
                generation: 1,
                enqueue: vi.fn(),
                enqueueV4,
            });
            const before = useTimelineStore.getState();

            before.trimAudioClip('audio_clip_first', 'left', 15);

            const after = useTimelineStore.getState();
            expect(after.audioTracks[0].clips).toEqual([
                expect.objectContaining({
                    id: 'audio_clip_first',
                    timelineStartFrame: mode === 'ripple' ? 0 : 15,
                    sourceStartSample: 24_000,
                    sourceEndSample: 48_000,
                    timelineDurationSamples: 24_000,
                }),
                expect.objectContaining({
                    id: 'audio_clip_second',
                    timelineStartFrame: mode === 'ripple' ? 15 : 30,
                }),
            ]);
            expect(after.revision).toBe(before.revision + 1);
            expect(after.history).toHaveLength(1);
            expect(enqueueV4).toHaveBeenCalledTimes(1);
        },
    );

    it('keeps transcript bodies runtime-only while a word correction commits exactly once', async () => {
        const { document, body } = createHydratedNarrativeFixture();
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        useTimelineStore.getState().hydrateEditorDocument(document, emptyHistory);
        const manifests: EditorManifestV4[] = [];
        setTimelinePersistenceBinding({
            projectId: 'project_v4_text',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4: (manifest) => manifests.push(manifest),
        });
        const before = useTimelineStore.getState();

        const result = await before.executeNarrativeCommand({
            type: 'set-word-text',
            blockId: 'narrative_block_1',
            wordId: editorialWordId,
            text: 'Corrected',
        });

        if (result.kind !== 'success') throw new Error(JSON.stringify(result));
        const after = useTimelineStore.getState();
        expect(after.revision).toBe(before.revision + 1);
        expect(after.audioGraphRevision).toBe(before.audioGraphRevision);
        expect(after.history).toHaveLength(1);
        expect(after.narrative?.blocks.narrative_block_1).toMatchObject({
            wordTextOverrides: { [editorialWordId]: 'Corrected' },
        });
        expect(after.transientSelection).toEqual({
            kind: 'narrative',
            trackId: 'video_track_editorial',
            blockId: 'narrative_block_1',
            sourceWordIds: [editorialWordId],
            boundary: null,
        });
        expect(timelineEditorialRuntime.getResolvedBodies()[EDITORIAL_TEST_RECORD_ID]).toBe(body);
        expect(manifests).toHaveLength(1);
        expect(manifests[0].editorialTranscriptDescriptors).toHaveLength(1);
        expect(JSON.stringify(manifests[0])).not.toContain('"words"');
        expect(JSON.stringify(manifests[0])).not.toContain('"speechRegions"');
    });

    it('acquires, hydrates, and activates one narrative through a single guarded transaction', async () => {
        const { document: hydratedFixture, body } = createHydratedNarrativeFixture();
        const descriptor = hydratedFixture.editorialTranscriptDescriptors[0];
        const activationEvents: string[] = [];
        const progress: TimelineNarrativeActivationProgress[] = [];
        const document = createEditorDocumentV4Fixture({
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
            transientSelection: { kind: 'none' },
        });
        const acquireSources = vi.fn(async (...input: [unknown]) => {
            void input;
            return [descriptor];
        });
        const releaseSessionPins = vi.fn(async () => {});
        const coordinator = {
            acquireSources,
            releaseSessionPins,
        } as unknown as EditorialTranscriptionCoordinator;
        const getRecord = vi.fn(async () => {
            activationEvents.push('hydrated');
            return body;
        });
        timelineEditorialRuntime.configure({
            repository: { getRecord } as unknown as EditorialTranscriptRepository,
            coordinator,
        });
        timelineEditorialRuntime.attachProject({
            projectId: 'project_v4_activation',
            persistenceGeneration: 4,
            sessionId: 'session_v4_activation',
        });
        useTimelineStore.getState().hydrateEditorDocument(document, emptyHistory);
        const enqueueV4 = vi.fn(() => {
            activationEvents.push('committed');
        });
        setTimelinePersistenceBinding({
            projectId: 'project_v4_activation',
            generation: 4,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const before = useTimelineStore.getState();

        const result = await before.activateNarrative({
            selectedTrackIds: ['video_track_editorial'],
            preferences: DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
            declaredDurationBySourceId: {
                video_source_editorial: { numerator: 10, denominator: 1 },
            },
            onProgress: (value) => {
                progress.push(value);
                if (value.stage === 'building-text-edit') activationEvents.push(value.stage);
            },
        });

        expect(result.kind).toBe('success');
        expect(acquireSources).toHaveBeenCalledTimes(1);
        expect(acquireSources.mock.calls[0][0]).toMatchObject({
            sources: [{
                sourceId: 'video_source_editorial',
                declaredDuration: { numerator: 10, denominator: 1 },
            }],
            guard: {
                projectId: 'project_v4_activation',
                persistenceGeneration: 4,
                documentRevision: before.revision,
                sessionId: 'session_v4_activation',
            },
        });
        expect(getRecord).toHaveBeenCalledWith(EDITORIAL_TEST_RECORD_ID, {
            descriptor,
            referenced: true,
        });
        const after = useTimelineStore.getState();
        expect(after.revision).toBe(before.revision + 1);
        expect(after.audioGraphRevision).toBe(before.audioGraphRevision);
        expect(after.history).toHaveLength(1);
        expect(after.editorialTranscriptDescriptors).toEqual([descriptor]);
        expect(after.narrative).not.toBeNull();
        expect(enqueueV4).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(after.buildEditorManifestV4())).not.toContain('"words"');
        expect(progress.filter((value) => value.stage === 'building-text-edit')).toEqual([{
            stage: 'building-text-edit',
            sourceCount: 1,
        }]);
        expect(activationEvents).toEqual(['hydrated', 'building-text-edit', 'committed']);
    });

    it.each([
        [
            'network-unreachable',
            'browser',
            'Could not reach the transcription endpoint from this browser. Check that the service is running and allows CORS requests from this Waptions origin.',
        ],
        [
            'network-unreachable',
            'server',
            'Could not reach the transcription endpoint from the Waptions server. Check that the service is running and reachable from the server.',
        ],
        [
            'provider-unauthorized',
            'server',
            'The transcription provider rejected the API key. Enter a valid API key, or leave it empty if this endpoint does not require one.',
        ],
        [
            'provider-forbidden',
            'server',
            'The transcription provider denied access. Check the API key permissions and endpoint access.',
        ],
        [
            'provider-not-found',
            'server',
            'The transcription endpoint was not found. Check the configured endpoint path.',
        ],
        [
            'provider-rate-limited',
            'server',
            'The transcription provider is rate limiting requests. Wait and try again.',
        ],
        [
            'provider-rejected',
            'server',
            'The transcription provider rejected the request. Check that it supports the required OpenAI-compatible transcription request.',
        ],
        [
            'provider-unavailable',
            'server',
            'The transcription provider is unavailable. Check the service and try again.',
        ],
        [
            'provider-timeout',
            'server',
            'The transcription provider took too long to respond. Check that the service is still running, then try again.',
        ],
    ] as const)(
        'returns an actionable safe activation error for %s in %s mode',
        async (failureCode, requestMode, message) => {
            const document = createEditorDocumentV4Fixture({
                editorialTranscriptDescriptors: [],
                narrative: null,
                dependentLinks: [],
                transientSelection: { kind: 'none' },
            });
            const acquireSources = vi.fn(async () => {
                throw new EditorialTranscriptionRequestError(
                    failureCode as EditorialTranscriptionFailureCode,
                );
            });
            const releaseSessionPins = vi.fn(async () => {});
            timelineEditorialRuntime.configure({
                coordinator: {
                    acquireSources,
                    releaseSessionPins,
                } as unknown as EditorialTranscriptionCoordinator,
            });
            timelineEditorialRuntime.attachProject({
                projectId: `project_v4_activation_${failureCode}_${requestMode}`,
                persistenceGeneration: 1,
                sessionId: 'session_v4_activation_failure',
            });
            useTimelineStore.getState().hydrateEditorDocument(document, emptyHistory);
            const enqueueV4 = vi.fn();
            setTimelinePersistenceBinding({
                projectId: 'project_v4_activation_failure',
                generation: 1,
                enqueue: vi.fn(),
                enqueueV4,
            });
            const before = useTimelineStore.getState();

            const result = await before.activateNarrative({
                selectedTrackIds: ['video_track_editorial'],
                preferences: {
                    ...DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
                    requestMode,
                },
                apiKey: 'sentinel-key',
            });

            expect(result).toMatchObject({
                kind: 'error',
                error: {
                    code: `editorial-transcription-${failureCode}`,
                    message,
                    ids: [],
                },
            });
            expect(JSON.stringify(result)).not.toContain('sentinel-key');
            expect(useTimelineStore.getState().revision).toBe(before.revision);
            expect(useTimelineStore.getState().history).toEqual(before.history);
            expect(enqueueV4).not.toHaveBeenCalled();
            expect(releaseSessionPins).toHaveBeenCalledTimes(1);
        },
    );

    it('keeps unknown acquisition and parser failures generic and redacted', async () => {
        const document = createEditorDocumentV4Fixture({
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
            transientSelection: { kind: 'none' },
        });
        const releaseSessionPins = vi.fn(async () => {});
        timelineEditorialRuntime.configure({
            coordinator: {
                acquireSources: vi.fn(async () => {
                    throw new Error('sentinel-key https://provider.example/source.wav transcript text');
                }),
                releaseSessionPins,
            } as unknown as EditorialTranscriptionCoordinator,
        });
        timelineEditorialRuntime.attachProject({
            projectId: 'project_v4_activation_unknown_failure',
            persistenceGeneration: 1,
            sessionId: 'session_v4_activation_unknown_failure',
        });
        useTimelineStore.getState().hydrateEditorDocument(document, emptyHistory);
        const before = useTimelineStore.getState();

        const result = await before.activateNarrative({
            selectedTrackIds: ['video_track_editorial'],
            preferences: DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
            apiKey: 'sentinel-key',
        });

        expect(result).toMatchObject({
            kind: 'error',
            error: {
                code: 'transcript-acquisition-failed',
                message: 'Editorial transcript acquisition failed before publication.',
            },
        });
        expect(JSON.stringify(result)).not.toContain('sentinel-key');
        expect(JSON.stringify(result)).not.toContain('provider.example');
        expect(JSON.stringify(result)).not.toContain('source.wav');
        expect(JSON.stringify(result)).not.toContain('transcript text');
        expect(useTimelineStore.getState().revision).toBe(before.revision);
        expect(useTimelineStore.getState().history).toEqual(before.history);
        expect(releaseSessionPins).toHaveBeenCalledTimes(1);
    });

    it('returns overlap exclusions in the typed activationReport for no accepted candidates', async () => {
        const { document: baseDocument, body } = createHydratedNarrativeFixture();
        const overlappingClip = {
            ...baseDocument.videoClips[0],
            id: 'video_clip_overlapping_candidate',
            trackId: 'video_track_candidate',
        };
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        useTimelineStore.getState().hydrateEditorDocument({
            ...baseDocument,
            videoClips: [...baseDocument.videoClips, overlappingClip],
            videoTracks: [...baseDocument.videoTracks, {
                id: 'video_track_candidate',
                name: 'Candidate video',
                visible: true,
                locked: false,
            }],
        }, emptyHistory);
        const before = useTimelineStore.getState();

        const result: TimelineV4CommandResult = await before.activateNarrative({
            selectedTrackIds: ['video_track_candidate'],
            preferences: DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
        });

        expect(result).toEqual({
            kind: 'noop',
            code: 'no-accepted-candidates',
            history: { createEntry: false, label: null, mergeKey: null },
            persistence: { enqueue: false },
            activationReport: {
                acceptedClipIds: [],
                exclusions: [{
                    candidateId: overlappingClip.id,
                    trackId: 'video_track_candidate',
                    interval: { start: 0, end: 30 },
                    conflictingIds: ['video_clip_editorial'],
                }],
            },
        });
        expect('acceptedClipIds' in result).toBe(false);
        expect('exclusions' in result).toBe(false);
        expect(useTimelineStore.getState().revision).toBe(before.revision);
        expect(useTimelineStore.getState().history).toEqual(before.history);
    });

    it('preserves an imported-audio end trim at an exact non-frame output sample', () => {
        const fixture = createEditorDocumentV4Fixture();
        const audioFile = {
            name: 'exact-audio.wav',
            type: 'audio/wav',
            size: 88_200,
            lastModified: 1_700_000_000_000,
        } as File;
        useTimelineStore.getState().hydrateEditorDocument({
            ...fixture,
            globalEditingMode: 'absolute',
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
            audioSources: [{
                id: 'audio_source_exact',
                originalName: audioFile.name,
                mimeType: audioFile.type,
                size: audioFile.size,
                lastModified: audioFile.lastModified,
                fingerprint: 'exact-audio-fingerprint',
                duration: 1,
                nativeSampleRate: 44_100,
                nativeSampleCount: 44_100,
                nativeChannelCount: 1,
                bitrate: 705_600,
                codec: 'pcm_s16le',
                file: audioFile,
            }],
            audioTracks: [{
                id: 'audio_track_exact',
                name: 'Exact audio',
                muted: false,
                solo: false,
                locked: false,
                gainDb: 0,
                clips: [{
                    id: 'audio_clip_exact',
                    source: { kind: 'audio-source', audioSourceId: 'audio_source_exact' },
                    timelineStartFrame: 0,
                    sourceStartSample: 0,
                    sourceEndSample: 44_100,
                    timelineDurationSamples: 48_000,
                    muted: false,
                    gainDb: 0,
                    fadeInSamples: 0,
                    fadeOutSamples: 0,
                }],
            }],
        }, emptyHistory);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_v4_exact_audio',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const before = useTimelineStore.getState();

        const result = before.executeOrdinaryV4Command({
            target: {
                kind: 'audio-clip',
                trackId: 'audio_track_exact',
                clipId: 'audio_clip_exact',
            },
            action: { kind: 'resize', start: 0, end: 47_999 },
        });

        expect(result.kind).toBe('success');
        expect(useTimelineStore.getState().audioTracks[0].clips[0]).toMatchObject({
            timelineStartFrame: 0,
            timelineDurationSamples: 47_999,
        });
        expect(useTimelineStore.getState().revision).toBe(before.revision + 1);
        expect(useTimelineStore.getState().audioGraphRevision).toBe(before.audioGraphRevision + 1);
        expect(useTimelineStore.getState().history).toHaveLength(1);
        expect(enqueueV4).toHaveBeenCalledTimes(1);
    });

    it('hydrates required CAS bodies before publishing Undo and Redo V4 projections', async () => {
        const { document, body } = createHydratedNarrativeFixture();
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        useTimelineStore.getState().hydrateEditorDocument(document, emptyHistory);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_v4_navigation',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const corrected = await useTimelineStore.getState().executeNarrativeCommand({
            type: 'set-word-text',
            blockId: 'narrative_block_1',
            wordId: editorialWordId,
            text: 'Corrected',
        });
        expect(corrected.kind).toBe('success');
        enqueueV4.mockClear();
        const getRecord = vi.fn(async () => body);
        timelineEditorialRuntime.configure({
            repository: { getRecord } as unknown as EditorialTranscriptRepository,
        });

        await timelineEditorialRuntime.detachProject();
        await useTimelineStore.getState().undo();

        expect(getRecord).toHaveBeenCalledTimes(1);
        expect(useTimelineStore.getState().narrative?.blocks.narrative_block_1).toMatchObject({
            wordTextOverrides: {},
        });
        expect(useTimelineStore.getState().history).toHaveLength(0);
        expect(useTimelineStore.getState().redoStack).toHaveLength(1);
        expect(enqueueV4).toHaveBeenCalledTimes(1);

        await timelineEditorialRuntime.detachProject();
        enqueueV4.mockClear();
        await useTimelineStore.getState().redo();

        expect(getRecord).toHaveBeenCalledTimes(2);
        expect(useTimelineStore.getState().narrative?.blocks.narrative_block_1).toMatchObject({
            wordTextOverrides: { [editorialWordId]: 'Corrected' },
        });
        expect(useTimelineStore.getState().history).toHaveLength(1);
        expect(useTimelineStore.getState().redoStack).toHaveLength(0);
        expect(enqueueV4).toHaveBeenCalledTimes(1);
    });

    it('does not publish a hydrated Undo projection over a newer durable command', async () => {
        const { document, body } = createHydratedNarrativeFixture();
        const subtitleTrack = createSubtitleTrackV4Fixture();
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        useTimelineStore.getState().hydrateEditorDocument({
            ...document,
            subtitleTracks: [subtitleTrack],
            activeSubtitleTrackId: subtitleTrack.id,
        }, emptyHistory);
        const corrected = await useTimelineStore.getState().executeNarrativeCommand({
            type: 'set-word-text',
            blockId: 'narrative_block_1',
            wordId: editorialWordId,
            text: 'Corrected',
        });
        expect(corrected.kind).toBe('success');

        let resolveBody!: (value: typeof body) => void;
        const pendingBody = new Promise<typeof body>((resolve) => {
            resolveBody = resolve;
        });
        const getRecord = vi.fn(async () => pendingBody);
        timelineEditorialRuntime.configure({
            repository: { getRecord } as unknown as EditorialTranscriptRepository,
        });
        await timelineEditorialRuntime.detachProject();

        const undo = useTimelineStore.getState().undo();
        await vi.waitFor(() => expect(getRecord).toHaveBeenCalledTimes(1));
        useTimelineStore.getState().updateTrackName(subtitleTrack.id, 'Newer title');
        const newerBody = structuredClone(body);
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: newerBody });
        const newer = useTimelineStore.getState();
        resolveBody(body);
        await undo;

        const after = useTimelineStore.getState();
        expect(after.revision).toBe(newer.revision);
        expect(after.history).toEqual(newer.history);
        expect(after.redoStack).toEqual(newer.redoStack);
        expect(after.tracks[0].name).toBe('Newer title');
        expect(after.narrative?.blocks.narrative_block_1).toMatchObject({
            wordTextOverrides: { [editorialWordId]: 'Corrected' },
        });
        expect(timelineEditorialRuntime.getResolvedBodies()[EDITORIAL_TEST_RECORD_ID]).toBe(newerBody);
    });

    it('does not publish hydrated Redo bodies over a newer durable command', async () => {
        const { document, body } = createHydratedNarrativeFixture();
        const subtitleTrack = createSubtitleTrackV4Fixture();
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        useTimelineStore.getState().hydrateEditorDocument({
            ...document,
            subtitleTracks: [subtitleTrack],
            activeSubtitleTrackId: subtitleTrack.id,
        }, emptyHistory);
        const corrected = await useTimelineStore.getState().executeNarrativeCommand({
            type: 'set-word-text',
            blockId: 'narrative_block_1',
            wordId: editorialWordId,
            text: 'Corrected',
        });
        expect(corrected.kind).toBe('success');
        timelineEditorialRuntime.configure({
            repository: { getRecord: vi.fn(async () => body) } as unknown as EditorialTranscriptRepository,
        });
        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState().redoStack).toHaveLength(1);

        let resolveBody!: (value: typeof body) => void;
        const pendingBody = new Promise<typeof body>((resolve) => {
            resolveBody = resolve;
        });
        const getRecord = vi.fn(async () => pendingBody);
        timelineEditorialRuntime.configure({
            repository: { getRecord } as unknown as EditorialTranscriptRepository,
        });
        await timelineEditorialRuntime.detachProject();

        const redo = useTimelineStore.getState().redo();
        await vi.waitFor(() => expect(getRecord).toHaveBeenCalledTimes(1));
        useTimelineStore.getState().updateTrackName(subtitleTrack.id, 'Newer title');
        const newerBody = structuredClone(body);
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: newerBody });
        const newer = useTimelineStore.getState();
        resolveBody(body);
        await redo;

        const after = useTimelineStore.getState();
        expect(after.revision).toBe(newer.revision);
        expect(after.history).toEqual(newer.history);
        expect(after.redoStack).toEqual(newer.redoStack);
        expect(after.tracks[0].name).toBe('Newer title');
        expect(after.narrative?.blocks.narrative_block_1).toMatchObject({
            wordTextOverrides: {},
        });
        expect(timelineEditorialRuntime.getResolvedBodies()[EDITORIAL_TEST_RECORD_ID]).toBe(newerBody);
    });

    it('does not publish hydrated history-jump bodies over a newer durable command', async () => {
        const { document, body } = createHydratedNarrativeFixture();
        const subtitleTrack = createSubtitleTrackV4Fixture();
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        useTimelineStore.getState().hydrateEditorDocument({
            ...document,
            subtitleTracks: [subtitleTrack],
            activeSubtitleTrackId: subtitleTrack.id,
        }, emptyHistory);
        const corrected = await useTimelineStore.getState().executeNarrativeCommand({
            type: 'set-word-text',
            blockId: 'narrative_block_1',
            wordId: editorialWordId,
            text: 'Corrected',
        });
        expect(corrected.kind).toBe('success');

        let resolveBody!: (value: typeof body) => void;
        const pendingBody = new Promise<typeof body>((resolve) => {
            resolveBody = resolve;
        });
        const getRecord = vi.fn(async () => pendingBody);
        timelineEditorialRuntime.configure({
            repository: { getRecord } as unknown as EditorialTranscriptRepository,
        });
        await timelineEditorialRuntime.detachProject();

        const jump = useTimelineStore.getState().jumpToHistoryEntry(null);
        await vi.waitFor(() => expect(getRecord).toHaveBeenCalledTimes(1));
        useTimelineStore.getState().updateTrackName(subtitleTrack.id, 'Newer title');
        const newerBody = structuredClone(body);
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: newerBody });
        const newer = useTimelineStore.getState();
        resolveBody(body);
        await jump;

        const after = useTimelineStore.getState();
        expect(after.revision).toBe(newer.revision);
        expect(after.history).toEqual(newer.history);
        expect(after.redoStack).toEqual(newer.redoStack);
        expect(after.tracks[0].name).toBe('Newer title');
        expect(after.narrative?.blocks.narrative_block_1).toMatchObject({
            wordTextOverrides: { [editorialWordId]: 'Corrected' },
        });
        expect(timelineEditorialRuntime.getResolvedBodies()[EDITORIAL_TEST_RECORD_ID]).toBe(newerBody);
    });

    it('releases final narrative authority and removes its link without moving either target', async () => {
        const { document: fixture, body } = createHydratedNarrativeFixture();
        const subtitleTrack = createSubtitleTrackV4Fixture({
            subtitles: [{ id: 'subtitle_1', startTime: 0, endTime: 1, text: 'Keep me' }],
        });
        const document = {
            ...fixture,
            subtitleTracks: [subtitleTrack],
            activeSubtitleTrackId: subtitleTrack.id,
            dependentLinks: [createEditorialDependentLinkFixture({
                association: { kind: 'overlap', origin: 'manual' },
                followPolicy: 'none',
            })],
        };
        timelineEditorialRuntime.injectResolvedBodies({ [EDITORIAL_TEST_RECORD_ID]: body });
        timelineEditorialRuntime.configure({
            repository: { getRecord: vi.fn(async () => body) } as unknown as EditorialTranscriptRepository,
        });
        useTimelineStore.getState().hydrateEditorDocument(document, emptyHistory);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_v4_release',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        expect(useTimelineStore.getState().selectNarrativeRange(
            'narrative_block_1',
            [editorialWordId],
        )).toBe(true);
        const before = useTimelineStore.getState();
        const beforeClip = structuredClone(before.videoClips[0]);

        const result = await before.releaseNarrativeTracks(['video_track_editorial']);

        expect(result.kind).toBe('success');
        const after = useTimelineStore.getState();
        expect(after.narrative).toBeNull();
        expect(after.dependentLinks).toEqual([]);
        expect(after.videoClips).toEqual([beforeClip]);
        expect(after.tracks[0].subtitles).toEqual(subtitleTrack.subtitles);
        expect(after.revision).toBe(before.revision + 1);
        expect(after.audioGraphRevision).toBe(before.audioGraphRevision);
        expect(after.history).toHaveLength(1);
        expect(enqueueV4).toHaveBeenCalledTimes(1);

        await after.undo();
        expect(useTimelineStore.getState()).toMatchObject({
            transientSelection: {
                kind: 'narrative',
                blockId: 'narrative_block_1',
                sourceWordIds: [editorialWordId],
            },
            selectedClipId: 'video_clip_editorial',
            isVideoSelected: true,
        });
        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState()).toMatchObject({
            narrative: null,
            transientSelection: { kind: 'none' },
            selectedClipId: null,
            isVideoSelected: false,
        });
    });

    it('rejects quiet-assisted refinement without a real decoder and leaves durable state untouched', async () => {
        const document = createEditorDocumentV4Fixture();
        timelineEditorialRuntime.injectResolvedBodies({
            [EDITORIAL_TEST_RECORD_ID]: createEditorialTranscriptBodyFixture(),
        });
        useTimelineStore.getState().hydrateEditorDocument(document, emptyHistory);
        const enqueueV4 = vi.fn();
        setTimelinePersistenceBinding({
            projectId: 'project_v4_quiet',
            generation: 1,
            enqueue: vi.fn(),
            enqueueV4,
        });
        const before = useTimelineStore.getState();

        const result = await before.executeNarrativeCommand({
            type: 'refine-boundary',
            blockId: 'narrative_block_1',
            side: 'end',
            chosenSample: 15_500,
            algorithmVersion: 1,
            origin: 'quiet-assisted',
        });

        expect(result).toMatchObject({
            kind: 'error',
            error: { code: 'quiet-refinement-unavailable', ids: ['narrative_block_1'] },
        });
        expect(useTimelineStore.getState().revision).toBe(before.revision);
        expect(useTimelineStore.getState().audioGraphRevision).toBe(before.audioGraphRevision);
        expect(useTimelineStore.getState().history).toEqual(before.history);
        expect(enqueueV4).not.toHaveBeenCalled();
    });
});
