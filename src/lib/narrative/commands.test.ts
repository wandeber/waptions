import { describe, expect, it } from 'vitest';
import type {
    EditorialTranscriptRecordBodyV1,
    NarrativeBlockV1,
    NarrativeDocumentV1,
    ResolvedEditorialTranscriptMapV1,
    Sha256Digest,
} from '@/types/editorial';
import {
    createEditorialTranscriptBodyFixture,
    createEditorialTranscriptDescriptorFixture,
    createVideoSourceAssetV4Fixture,
} from '@/types/editorial.test-fixtures';
import type { EditorDocumentV4, VideoClipV4 } from '@/types/video';
import { getVideoClipDurationFramesV4 } from '../video-placement-v4';
import {
    planActivateNarrative,
    planChangeBlockMargin,
    planChangeGlobalEditingMode,
    planDeleteAllSilences,
    planDeleteNarrativeWords,
    planExtendNarrativeBlock,
    planInsertSourceRange,
    planMergeNarrativeBlocks,
    planOrdinaryProjectIntervals,
    planRecoverSourceRange,
    planReleaseNarrativeTracks,
    planRefineNarrativeBoundary,
    planReorderNarrativeBlocks,
    planSplitNarrativeBlock,
    planSetNarrativeSpeakerVisibility,
    planSetNarrativeWordSpeaker,
    planSetNarrativeWordText,
    planTrimNarrativeBlock,
    preflightNarrativeActivationCandidates,
    type NarrativeIdFactory,
} from './commands';

const RECORD_ID = `sha256:${'1'.repeat(64)}` as Sha256Digest;
const NOW = '2026-07-22T12:00:00.000Z';

interface BlockSpec {
    id: string;
    kind: 'speech' | 'silence';
    trackId: string;
    timelineStartFrame: number;
    coreStartSample: number;
    coreEndSample: number;
    sourceWordIds?: string[];
}

function transcriptBody(
    overrides: Partial<EditorialTranscriptRecordBodyV1> = {},
): EditorialTranscriptRecordBodyV1 {
    return createEditorialTranscriptBodyFixture({
        sampleCount: 160_000,
        words: [{
            id: 'word_0',
            text: 'Zero',
            alignedStartSample: 0,
            alignedEndSample: 16_000,
            editableStartSample: 0,
            editableEndSample: 16_000,
            probability: 1,
            speakerId: null,
        }, {
            id: 'word_1',
            text: 'One',
            alignedStartSample: 16_000,
            alignedEndSample: 32_000,
            editableStartSample: 16_000,
            editableEndSample: 32_000,
            probability: 1,
            speakerId: null,
        }, {
            id: 'word_2',
            text: 'Two',
            alignedStartSample: 32_000,
            alignedEndSample: 48_000,
            editableStartSample: 32_000,
            editableEndSample: 48_000,
            probability: 1,
            speakerId: null,
        }, {
            id: 'word_3',
            text: 'Three',
            alignedStartSample: 48_000,
            alignedEndSample: 64_000,
            editableStartSample: 48_000,
            editableEndSample: 64_000,
            probability: 1,
            speakerId: null,
        }],
        speechRegions: [],
        editBoundaries: [],
        ...overrides,
    });
}

function bodies(body = transcriptBody()): ResolvedEditorialTranscriptMapV1 {
    return { [RECORD_ID]: body } as ResolvedEditorialTranscriptMapV1;
}

function makeDocument(
    specs: readonly BlockSpec[],
    options: {
        mode?: 'ripple' | 'absolute';
        lockedTrackIds?: readonly string[];
        body?: EditorialTranscriptRecordBodyV1;
    } = {},
): EditorDocumentV4 {
    const body = options.body ?? transcriptBody();
    const trackIds = Array.from(new Set(specs.map(spec => spec.trackId)));
    const blocks: Record<string, NarrativeBlockV1> = {};
    const clips: VideoClipV4[] = [];
    for (const spec of specs) {
        const sourceStartFrame = spec.coreStartSample / 16_000 * 30;
        const sourceEndFrame = spec.coreEndSample / 16_000 * 30;
        const common = {
            id: spec.id,
            instanceId: `instance_${spec.id}`,
            lineageRootId: `lineage_${spec.id}`,
            parentInstanceIds: [],
            clipId: `clip_${spec.id}`,
            trackId: spec.trackId,
            sourceId: 'source_main',
            transcriptRecordId: RECORD_ID,
            sourceIntervalId: `interval_${spec.id}`,
            coreStartSample: spec.coreStartSample,
            coreEndSample: spec.coreEndSample,
            materialization: {
                sourceStartFrame,
                sourceEndFrame,
                preBoundary: { kind: 'margin', mode: 'explicit', requestedSamples: 0 } as const,
                postBoundary: { kind: 'margin', mode: 'explicit', requestedSamples: 0 } as const,
            },
            timelineStartFrame: spec.timelineStartFrame,
            startBoundaryRefinement: null,
            endBoundaryRefinement: null,
            revision: 1,
        };
        blocks[spec.id] = spec.kind === 'speech'
            ? {
                ...common,
                kind: 'speech',
                sourceWordIds: spec.sourceWordIds ?? [],
                wordTextOverrides: {},
                speakerOverrides: {},
            }
            : {
                ...common,
                kind: 'silence',
                sourceWordIds: [],
                evidence: 'quiet',
            };
        clips.push({
            id: common.clipId,
            sourceId: common.sourceId,
            trackId: common.trackId,
            timelineStartFrame: common.timelineStartFrame,
            sourceStart: sourceStartFrame / 30,
            sourceEnd: sourceEndFrame / 30,
            audio: null,
        });
    }
    const narrative: NarrativeDocumentV1 = {
        version: 1,
        id: 'narrative_main',
        revision: 1,
        controlledTrackIds: trackIds,
        blockIds: specs.map(spec => spec.id),
        blocks,
        sourceRecordIds: [RECORD_ID],
        settings: {
            globalPreMarginSamples: 0,
            globalPostMarginSamples: 0,
            boundaryRefinementEnabled: true,
            showSpeakers: false,
        },
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
    };
    return {
        version: 4,
        revision: 1,
        audioGraphRevision: 0,
        renderProfile: {
            fps: { numerator: 30, denominator: 1 },
            width: 1_920,
            height: 1_080,
            audioSampleRate: 48_000,
            isFrameRateLocked: true,
            isCanvasSizeLocked: true,
        },
        renderBackgroundColor: '#000000',
        subtitleTracks: [],
        videoSources: [createVideoSourceAssetV4Fixture({
            id: 'source_main',
            duration: 10,
            fps: 30,
            fingerprint: body.sourceFingerprint,
        })],
        videoClips: clips,
        videoTracks: trackIds.map(trackId => ({
            id: trackId,
            name: trackId,
            visible: true,
            locked: options.lockedTrackIds?.includes(trackId) ?? false,
        })),
        audioSources: [],
        audioTracks: [],
        activeSubtitleTrackId: null,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
        globalEditingMode: options.mode ?? 'ripple',
        editorialTranscriptDescriptors: [createEditorialTranscriptDescriptorFixture({
            recordId: RECORD_ID,
            sourceId: 'source_main',
            sourceFingerprint: body.sourceFingerprint,
            sampleCount: body.sampleCount,
        })],
        narrative,
        dependentLinks: [],
    };
}

function idFactory(): NarrativeIdFactory {
    let ordinal = 0;
    return kind => `${kind.replaceAll('-', '_')}_${ordinal += 1}`;
}

function guard(document: EditorDocumentV4) {
    return {
        expectedDocumentRevision: document.revision,
        expectedNarrativeRevision: document.narrative?.revision,
        expectedMode: document.globalEditingMode,
    };
}

describe('pure narrative commands', () => {
    it('activates isolated clips into one global order and reports whole overlap components', () => {
        const body = transcriptBody({ sampleCount: 64_000 });
        const document = makeDocument([], { body });
        document.narrative = null;
        document.videoTracks = ['track_1', 'track_2', 'track_3', 'track_4'].map(id => ({
            id,
            name: id,
            visible: true,
            locked: false,
        }));
        document.videoClips = [{
            id: 'candidate_1', sourceId: 'source_main', trackId: 'track_1', timelineStartFrame: 0,
            sourceStart: 0, sourceEnd: 1, audio: null,
        }, {
            id: 'candidate_2', sourceId: 'source_main', trackId: 'track_2', timelineStartFrame: 30,
            sourceStart: 1, sourceEnd: 2, audio: null,
        }, {
            id: 'candidate_3', sourceId: 'source_main', trackId: 'track_3', timelineStartFrame: 60,
            sourceStart: 2, sourceEnd: 3, audio: null,
        }, {
            id: 'candidate_4', sourceId: 'source_main', trackId: 'track_4', timelineStartFrame: 75,
            sourceStart: 3, sourceEnd: 4, audio: null,
        }];

        expect(preflightNarrativeActivationCandidates({
            document,
            selectedTrackIds: document.videoTracks.map(track => track.id),
        })).toMatchObject({
            kind: 'success',
            acceptedClipIds: ['candidate_1', 'candidate_2'],
            exclusions: [{ candidateId: 'candidate_3' }, { candidateId: 'candidate_4' }],
        });

        const result = planActivateNarrative({
            document,
            guard: guard(document),
            selectedTrackIds: document.videoTracks.map(track => track.id),
            recordIdBySourceId: { source_main: RECORD_ID },
            bodies: bodies(body),
            idFactory: idFactory(),
            nowIso: NOW,
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.activationReport).toEqual({
            acceptedClipIds: ['candidate_1', 'candidate_2'],
            exclusions: [{
                candidateId: 'candidate_3',
                trackId: 'track_3',
                interval: { start: 60, end: 90 },
                conflictingIds: ['candidate_4'],
            }, {
                candidateId: 'candidate_4',
                trackId: 'track_4',
                interval: { start: 75, end: 105 },
                conflictingIds: ['candidate_3'],
            }],
        });
        expect(result.document.narrative?.controlledTrackIds).toEqual(['track_1', 'track_2']);
        expect(result.document.narrative?.blockIds).toHaveLength(2);
        expect(result.document.narrative?.blockIds.map(id => result.document.narrative!.blocks[id].trackId))
            .toEqual(['track_1', 'track_2']);
        expect(result.history).toEqual({ createEntry: true, label: 'Enable text editing', mergeKey: null });
        expect(result.inverse.narrative).toBeNull();
    });

    it('resolves a shared transcript record by its exact source descriptor', () => {
        const body = transcriptBody({ sampleCount: 64_000 });
        const document = makeDocument([], { body });
        document.narrative = null;
        document.videoSources.push(createVideoSourceAssetV4Fixture({
            id: 'source_copy',
            duration: 10,
            fps: 30,
            fingerprint: body.sourceFingerprint,
        }));
        document.videoTracks = [{
            id: 'track_copy',
            name: 'Copy',
            visible: true,
            locked: false,
        }];
        document.videoClips = [{
            id: 'candidate_copy',
            sourceId: 'source_copy',
            trackId: 'track_copy',
            timelineStartFrame: 0,
            sourceStart: 0,
            sourceEnd: 1,
            audio: null,
        }];
        document.editorialTranscriptDescriptors.push(createEditorialTranscriptDescriptorFixture({
            recordId: RECORD_ID,
            sourceId: 'source_copy',
            sourceFingerprint: body.sourceFingerprint,
            sampleCount: body.sampleCount,
        }));

        const result = planActivateNarrative({
            document,
            guard: guard(document),
            selectedTrackIds: ['track_copy'],
            recordIdBySourceId: { source_copy: RECORD_ID },
            bodies: bodies(body),
            idFactory: idFactory(),
            nowIso: NOW,
        });

        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        const narrative = result.document.narrative!;
        const block = narrative.blocks[narrative.blockIds[0]];
        expect(block).toMatchObject({
            sourceId: 'source_copy',
            transcriptRecordId: RECORD_ID,
        });
    });

    it('preflights added tracks against existing controlled blocks without transcript bodies', () => {
        const document = makeDocument([{
            id: 'existing', kind: 'speech', trackId: 'track_existing', timelineStartFrame: 0,
            coreStartSample: 0, coreEndSample: 16_000, sourceWordIds: ['word_0'],
        }]);
        document.videoTracks.push({
            id: 'track_conflict', name: 'track_conflict', visible: true, locked: false,
        }, {
            id: 'track_isolated', name: 'track_isolated', visible: true, locked: false,
        });
        document.videoClips.push({
            id: 'candidate_conflict', sourceId: 'source_main', trackId: 'track_conflict',
            timelineStartFrame: 15, sourceStart: 1, sourceEnd: 2, audio: null,
        }, {
            id: 'candidate_isolated', sourceId: 'source_main', trackId: 'track_isolated',
            timelineStartFrame: 60, sourceStart: 2, sourceEnd: 3, audio: null,
        });
        // Descriptor state belongs to acquisition/publication, not candidate discovery.
        document.editorialTranscriptDescriptors = [];

        expect(preflightNarrativeActivationCandidates({
            document,
            selectedTrackIds: ['track_conflict', 'track_isolated'],
        })).toEqual({
            kind: 'success',
            acceptedClipIds: ['candidate_isolated'],
            exclusions: [{
                candidateId: 'candidate_conflict',
                trackId: 'track_conflict',
                interval: { start: 15, end: 45 },
                conflictingIds: ['clip_existing'],
            }],
        });
    });

    it('preflights every activation crop before an overlap component can exclude it', () => {
        const body = transcriptBody({ sampleCount: 64_000 });
        const document = makeDocument([], { body });
        document.narrative = null;
        document.videoTracks = ['track_valid', 'track_invalid'].map(id => ({
            id,
            name: id,
            visible: true,
            locked: false,
        }));
        document.videoClips = [{
            id: 'candidate_valid', sourceId: 'source_main', trackId: 'track_valid', timelineStartFrame: 0,
            sourceStart: 0, sourceEnd: 1, audio: null,
        }, {
            id: 'candidate_invalid', sourceId: 'source_main', trackId: 'track_invalid', timelineStartFrame: 0,
            sourceStart: -1, sourceEnd: 1, audio: null,
        }];

        const result = planActivateNarrative({
            document,
            guard: guard(document),
            selectedTrackIds: document.videoTracks.map(track => track.id),
            recordIdBySourceId: { source_main: RECORD_ID },
            bodies: bodies(body),
            idFactory: idFactory(),
            nowIso: NOW,
        });
        expect(result).toEqual({
            kind: 'error',
            error: {
                code: 'source-bounds',
                message: 'Clip crop is not aligned to source video frames.',
                ids: ['candidate_invalid'],
            },
        });
    });

    it('returns typed activation blockers for locked and invalid selected tracks', () => {
        const locked = makeDocument([]);
        locked.narrative = null;
        locked.videoTracks = [{
            id: 'track_locked', name: 'track_locked', visible: true, locked: true,
        }];
        expect(preflightNarrativeActivationCandidates({
            document: locked,
            selectedTrackIds: ['track_locked'],
        })).toEqual({
            kind: 'error',
            error: {
                code: 'locked-track',
                message: 'Selected controlled track is locked.',
                ids: ['track_locked'],
            },
        });
        expect(preflightNarrativeActivationCandidates({
            document: locked,
            selectedTrackIds: ['track_missing'],
        })).toMatchObject({
            kind: 'error',
            error: { code: 'invalid-selection', ids: ['track_missing'] },
        });
    });

    it('returns the complete exclusion report when activation has no accepted candidate', () => {
        const document = makeDocument([]);
        document.narrative = null;
        document.videoTracks = ['track_left', 'track_right'].map(id => ({
            id,
            name: id,
            visible: true,
            locked: false,
        }));
        document.videoClips = [{
            id: 'candidate_left', sourceId: 'source_main', trackId: 'track_left', timelineStartFrame: 0,
            sourceStart: 0, sourceEnd: 1, audio: null,
        }, {
            id: 'candidate_right', sourceId: 'source_main', trackId: 'track_right', timelineStartFrame: 15,
            sourceStart: 1, sourceEnd: 2, audio: null,
        }];

        expect(preflightNarrativeActivationCandidates({
            document,
            selectedTrackIds: document.videoTracks.map(track => track.id),
        })).toMatchObject({
            kind: 'noop',
            code: 'no-accepted-candidates',
            acceptedClipIds: [],
            exclusions: [{ candidateId: 'candidate_left' }, { candidateId: 'candidate_right' }],
        });

        const result = planActivateNarrative({
            document,
            guard: guard(document),
            selectedTrackIds: document.videoTracks.map(track => track.id),
            recordIdBySourceId: {},
            bodies: {},
            idFactory: idFactory(),
            nowIso: NOW,
        });
        expect(result.kind).toBe('noop');
        if (result.kind !== 'noop') return;
        expect(result.code).toBe('no-accepted-candidates');
        expect(result.activationReport?.acceptedClipIds).toEqual([]);
        expect(result.activationReport?.exclusions.map(exclusion => exclusion.candidateId))
            .toEqual(['candidate_left', 'candidate_right']);
        expect(result.persistence.enqueue).toBe(false);
    });

    it('preserves an exact partial source tail through its deterministic ceil frame', () => {
        const body = transcriptBody({ sampleCount: 160_160 });
        const document = makeDocument([], { body });
        document.narrative = null;
        document.videoSources = [{ ...document.videoSources[0], duration: 10.01, fps: 30 }];
        document.videoTracks = [{
            id: 'track_tail',
            name: 'track_tail',
            visible: true,
            locked: false,
        }];
        document.videoClips = [{
            id: 'candidate_tail',
            sourceId: 'source_main',
            trackId: 'track_tail',
            timelineStartFrame: 0,
            sourceStart: 0,
            sourceEnd: 10.01,
            audio: null,
        }];

        const result = planActivateNarrative({
            document,
            guard: guard(document),
            selectedTrackIds: ['track_tail'],
            recordIdBySourceId: { source_main: RECORD_ID },
            bodies: bodies(body),
            idFactory: idFactory(),
            nowIso: NOW,
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        const narrative = result.document.narrative!;
        const lastBlock = narrative.blocks[narrative.blockIds.at(-1)!];
        const lastClip = result.document.videoClips.find(clip => clip.id === lastBlock.clipId)!;
        expect(lastBlock.materialization.sourceEndFrame).toBe(301);
        expect(lastClip.sourceEnd).toBe(10.01);
        expect(lastBlock.timelineStartFrame
            + getVideoClipDurationFramesV4(lastClip, result.document.renderProfile)).toBe(300);
    });

    it('uses explicit zero outer margins when adding a crop under nonzero globals', () => {
        const document = makeDocument([{
            id: 'existing_block', kind: 'speech', trackId: 'track_existing', timelineStartFrame: 0,
            coreStartSample: 0, coreEndSample: 16_000, sourceWordIds: ['word_0'],
        }]);
        document.narrative!.settings.globalPreMarginSamples = 8_000;
        document.narrative!.settings.globalPostMarginSamples = 4_000;
        document.videoTracks.push({
            id: 'track_added',
            name: 'track_added',
            visible: true,
            locked: false,
        });
        document.videoClips.push({
            id: 'candidate_added',
            sourceId: 'source_main',
            trackId: 'track_added',
            timelineStartFrame: 30,
            sourceStart: 1,
            sourceEnd: 2,
            audio: null,
        });

        const result = planActivateNarrative({
            document,
            guard: guard(document),
            selectedTrackIds: ['track_added'],
            recordIdBySourceId: { source_main: RECORD_ID },
            bodies: bodies(),
            idFactory: idFactory(),
            nowIso: NOW,
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        const createdId = result.document.narrative!.blockIds.find(id => id !== 'existing_block')!;
        const created = result.document.narrative!.blocks[createdId];
        expect(created.materialization.preBoundary).toEqual({
            kind: 'margin', mode: 'explicit', requestedSamples: 0,
        });
        expect(created.materialization.postBoundary).toEqual({
            kind: 'margin', mode: 'explicit', requestedSamples: 0,
        });
        expect(created.materialization).toMatchObject({ sourceStartFrame: 30, sourceEndFrame: 60 });
    });

    it('releases multiple and final controlled tracks without moving or unpinning media', () => {
        const specs: BlockSpec[] = [{
            id: 'release_0', kind: 'speech', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 0, coreEndSample: 16_000, sourceWordIds: ['word_0'],
        }, {
            id: 'retain_1', kind: 'speech', trackId: 'track_2', timelineStartFrame: 40,
            coreStartSample: 16_000, coreEndSample: 32_000, sourceWordIds: ['word_1'],
        }, {
            id: 'release_2', kind: 'speech', trackId: 'track_3', timelineStartFrame: 80,
            coreStartSample: 32_000, coreEndSample: 48_000, sourceWordIds: ['word_2'],
        }];
        for (const mode of ['ripple', 'absolute'] as const) {
            const document = makeDocument(specs, { mode });
            const beforePlacements = document.videoClips.map(clip => ({
                id: clip.id,
                trackId: clip.trackId,
                timelineStartFrame: clip.timelineStartFrame,
                sourceStart: clip.sourceStart,
                sourceEnd: clip.sourceEnd,
            }));
            const released = planReleaseNarrativeTracks({
                document,
                guard: guard(document),
                trackIds: ['track_1', 'track_3'],
                nowIso: NOW,
            });
            expect(released.kind).toBe('success');
            if (released.kind !== 'success') continue;
            expect(released.document.narrative?.controlledTrackIds).toEqual(['track_2']);
            expect(released.document.narrative?.blockIds).toEqual(['retain_1']);
            expect(released.document.narrative?.sourceRecordIds).toEqual([RECORD_ID]);
            expect(released.document.videoClips).toBe(document.videoClips);
            expect(released.document.videoClips.map(clip => ({
                id: clip.id,
                trackId: clip.trackId,
                timelineStartFrame: clip.timelineStartFrame,
                sourceStart: clip.sourceStart,
                sourceEnd: clip.sourceEnd,
            }))).toEqual(beforePlacements);
            expect(released.anchorTransforms).toEqual([
                { kind: 'deleted', blockId: 'release_0' },
                { kind: 'deleted', blockId: 'release_2' },
            ]);
            expect(released.history).toEqual({
                createEntry: true,
                label: 'Release controlled tracks',
                mergeKey: null,
            });
            expect(released.pinDelta).toEqual({ addRecordIds: [], removeRecordIds: [] });
            expect(released.impact.audioGraph).toBe(false);
            expect(released.document.audioGraphRevision).toBe(document.audioGraphRevision);
            expect(released.inverse.narrative?.blockIds).toEqual([
                'release_0', 'retain_1', 'release_2',
            ]);
        }

        const document = makeDocument(specs);
        const partial = planReleaseNarrativeTracks({
            document,
            guard: guard(document),
            trackIds: ['track_1', 'track_3'],
            nowIso: NOW,
        });
        expect(partial.kind).toBe('success');
        if (partial.kind !== 'success') return;
        partial.document.transientSelection = {
            kind: 'narrative',
            trackId: 'track_2',
            blockId: 'retain_1',
            sourceWordIds: ['word_1'],
            boundary: null,
        };
        const final = planReleaseNarrativeTracks({
            document: partial.document,
            guard: guard(partial.document),
            trackIds: ['track_2'],
            nowIso: NOW,
        });
        expect(final.kind).toBe('success');
        if (final.kind !== 'success') return;
        expect(final.document.narrative).toBeNull();
        expect(final.forward.narrative).toBeNull();
        expect(final.inverse.narrative?.blockIds).toEqual(['retain_1']);
        expect(final.document.videoClips).toBe(document.videoClips);
        expect(final.document.transientSelection).toEqual({ kind: 'none' });
        expect(final.anchorTransforms).toEqual([{ kind: 'deleted', blockId: 'retain_1' }]);
        expect(final.pinDelta).toEqual({ addRecordIds: [], removeRecordIds: [] });
    });

    it('deletes all source-backed silences in ripple or absolute mode as one history plan', () => {
        const specs: BlockSpec[] = [{
            id: 'speech_0', kind: 'speech', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 0, coreEndSample: 16_000, sourceWordIds: ['word_0'],
        }, {
            id: 'silence_1', kind: 'silence', trackId: 'track_2', timelineStartFrame: 30,
            coreStartSample: 16_000, coreEndSample: 32_000,
        }, {
            id: 'speech_2', kind: 'speech', trackId: 'track_1', timelineStartFrame: 60,
            coreStartSample: 32_000, coreEndSample: 48_000, sourceWordIds: ['word_2'],
        }];
        const ripple = makeDocument(specs);
        const rippleResult = planDeleteAllSilences({ document: ripple, guard: guard(ripple), nowIso: NOW });
        expect(rippleResult.kind).toBe('success');
        if (rippleResult.kind !== 'success') return;
        expect(rippleResult.document.narrative?.blockIds).toEqual(['speech_0', 'speech_2']);
        expect(rippleResult.document.narrative?.blocks.speech_2.timelineStartFrame).toBe(30);
        expect(rippleResult.history.label).toBe('Delete all silences');
        expect(rippleResult.anchorTransforms).toContainEqual({ kind: 'deleted', blockId: 'silence_1' });
        expect(rippleResult.anchorTransforms).toContainEqual({
            kind: 'translated',
            blockId: 'speech_2',
            deltaFrames: -30,
        });

        const absolute = makeDocument(specs, { mode: 'absolute' });
        const absoluteResult = planDeleteAllSilences({ document: absolute, guard: guard(absolute), nowIso: NOW });
        expect(absoluteResult.kind).toBe('success');
        if (absoluteResult.kind !== 'success') return;
        expect(absoluteResult.document.narrative?.blocks.speech_2.timelineStartFrame).toBe(60);
        expect(absoluteResult.playhead).toEqual({ kind: 'keep', reason: 'absolute-gap' });
    });

    it('retains recovery catalog after an all-silence deletion and emits typed no-op hints', () => {
        const allSilence = makeDocument([{
            id: 'silence_only', kind: 'silence', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 16_000, coreEndSample: 32_000,
        }]);
        const deleted = planDeleteAllSilences({ document: allSilence, guard: guard(allSilence), nowIso: NOW });
        expect(deleted.kind).toBe('success');
        if (deleted.kind !== 'success') return;
        expect(deleted.document.narrative?.blockIds).toEqual([]);
        expect(deleted.document.narrative?.sourceRecordIds).toEqual([RECORD_ID]);
        expect(deleted.document.narrative?.controlledTrackIds).toEqual(['track_1']);

        const speechOnly = makeDocument([{
            id: 'speech_only', kind: 'speech', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 0, coreEndSample: 16_000, sourceWordIds: ['word_0'],
        }]);
        expect(planDeleteAllSilences({ document: speechOnly, guard: guard(speechOnly), nowIso: NOW }))
            .toEqual({
                kind: 'noop',
                code: 'no-eligible-silence',
                history: { createEntry: false, label: null, mergeKey: null },
                persistence: { enqueue: false },
            });
    });

    it('deletes a cross-word range including its intervening no-word source coverage', () => {
        const body = transcriptBody({
            words: [transcriptBody().words[0], transcriptBody().words[2]],
        });
        const document = makeDocument([{
            id: 'speech_range', kind: 'speech', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 0, coreEndSample: 48_000, sourceWordIds: ['word_0', 'word_2'],
        }], { body });
        const result = planDeleteNarrativeWords({
            document,
            guard: guard(document),
            bodies: bodies(body),
            firstBlockId: 'speech_range',
            firstWordId: 'word_0',
            lastBlockId: 'speech_range',
            lastWordId: 'word_2',
            idFactory: idFactory(),
            nowIso: NOW,
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.document.narrative?.blockIds).toEqual([]);
        expect(result.document.videoClips).toEqual([]);
        expect(result.inverse.narrative?.blockIds).toEqual(['speech_range']);
        expect(result.history.label).toBe('Delete text selection');
    });

    it('inserts equal source ranges as distinct occurrences without deduplicating source words', () => {
        const document = makeDocument([{
            id: 'speech_original', kind: 'speech', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 0, coreEndSample: 16_000, sourceWordIds: ['word_0'],
        }]);
        const result = planInsertSourceRange({
            document,
            guard: guard(document),
            bodies: bodies(),
            recordId: RECORD_ID,
            sourceId: 'source_main',
            sourceRange: { start: 0, end: 16_000 },
            destinationTrackId: 'track_1',
            targetIndex: 1,
            clipAudio: null,
            idFactory: idFactory(),
            nowIso: NOW,
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        const narrative = result.document.narrative!;
        expect(narrative.blockIds).toHaveLength(2);
        expect(new Set(narrative.blockIds).size).toBe(2);
        expect(narrative.blockIds.map(id => narrative.blocks[id].sourceWordIds)).toEqual([
            ['word_0'],
            ['word_0'],
        ]);
        expect(new Set(narrative.blockIds.map(id => narrative.blocks[id].instanceId)).size).toBe(2);
        expect(narrative.blocks[narrative.blockIds[1]].timelineStartFrame).toBe(30);
    });

    it('uses complete inverse-friendly patch plans for split, merge, trim, and extension', () => {
        const document = makeDocument([{
            id: 'editable', kind: 'speech', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 0, coreEndSample: 32_000, sourceWordIds: ['word_0', 'word_1'],
        }]);
        const ids = idFactory();
        const split = planSplitNarrativeBlock({
            document,
            guard: guard(document),
            bodies: bodies(),
            blockId: 'editable',
            splitSample: 16_000,
            idFactory: ids,
            nowIso: NOW,
        });
        expect(split.kind).toBe('success');
        if (split.kind !== 'success') return;
        expect(split.document.narrative?.blockIds).toHaveLength(2);
        expect(split.document.audioGraphRevision).toBe(document.audioGraphRevision + 1);
        expect(split.inverse.audioGraphRevision).toBe(document.audioGraphRevision);
        const [leftId, rightId] = split.document.narrative!.blockIds;
        expect(split.document.narrative!.blocks[leftId].materialization.postBoundary)
            .toEqual(split.document.narrative!.blocks[rightId].materialization.preBoundary);
        expect(split.inverse.narrative?.blockIds).toEqual(['editable']);

        const merged = planMergeNarrativeBlocks({
            document: split.document,
            guard: guard(split.document),
            leftBlockId: leftId,
            rightBlockId: rightId,
            idFactory: ids,
            nowIso: NOW,
        });
        expect(merged.kind).toBe('success');
        if (merged.kind !== 'success') return;
        expect(merged.document.narrative?.blockIds).toEqual(['editable']);
        expect(merged.document.narrative?.blocks.editable.sourceWordIds).toEqual(['word_0', 'word_1']);
        expect(merged.inverse.narrative?.blockIds).toEqual([leftId, rightId]);

        const trimmed = planTrimNarrativeBlock({
            document: merged.document,
            guard: guard(merged.document),
            bodies: bodies(),
            blockId: 'editable',
            side: 'end',
            sample: 16_000,
            idFactory: ids,
            nowIso: NOW,
        });
        expect(trimmed.kind).toBe('success');
        if (trimmed.kind !== 'success') return;
        expect(trimmed.document.narrative?.blocks.editable.sourceWordIds).toEqual(['word_0']);
        expect(trimmed.history.label).toBe('Trim text block');

        const extended = planExtendNarrativeBlock({
            document: trimmed.document,
            guard: guard(trimmed.document),
            bodies: bodies(),
            blockId: 'editable',
            newStartSample: 0,
            newEndSample: 32_000,
            idFactory: ids,
            nowIso: NOW,
        });
        expect(extended.kind).toBe('success');
        if (extended.kind !== 'success') return;
        expect(extended.document.narrative?.blocks.editable.sourceWordIds).toEqual(['word_0', 'word_1']);
        expect(extended.history.label).toBe('Extend source range');
    });

    it('supports all-silence recovery and absolute insertion collision preflights', () => {
        const allSilence = makeDocument([{
            id: 'silence_only', kind: 'silence', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 64_000, coreEndSample: 80_000,
        }]);
        const deleted = planDeleteAllSilences({ document: allSilence, guard: guard(allSilence), nowIso: NOW });
        expect(deleted.kind).toBe('success');
        if (deleted.kind !== 'success') return;
        const recovered = planRecoverSourceRange({
            document: deleted.document,
            guard: guard(deleted.document),
            bodies: bodies(),
            recordId: RECORD_ID,
            sourceId: 'source_main',
            sourceRange: { start: 0, end: 16_000 },
            destinationTrackId: 'track_1',
            targetIndex: 0,
            clipAudio: null,
            idFactory: idFactory(),
            nowIso: NOW,
        });
        expect(recovered.kind).toBe('success');
        if (recovered.kind !== 'success') return;
        expect(recovered.command).toBe('recover-source-range');
        expect(recovered.history.label).toBe('Recover source range');
        expect(recovered.document.narrative?.blockIds).toHaveLength(1);
        expect(recovered.document.narrative?.sourceRecordIds).toEqual([RECORD_ID]);

        const absolute = makeDocument([{
            id: 'absolute_original', kind: 'speech', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 0, coreEndSample: 16_000, sourceWordIds: ['word_0'],
        }], { mode: 'absolute' });
        expect(planInsertSourceRange({
            document: absolute,
            guard: guard(absolute),
            bodies: bodies(),
            recordId: RECORD_ID,
            sourceId: 'source_main',
            sourceRange: { start: 16_000, end: 32_000 },
            destinationTrackId: 'track_1',
            timelineStartFrame: 10,
            clipAudio: null,
            idFactory: idFactory(),
            nowIso: NOW,
        })).toMatchObject({ kind: 'error', error: { code: 'collision' } });
    });

    it('records boundary refinement provenance and mode changes without a hidden media move', () => {
        const noWords = transcriptBody({ words: [] });
        const document = makeDocument([{
            id: 'refinable', kind: 'silence', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 64_000, coreEndSample: 80_000,
        }], { body: noWords });
        const refined = planRefineNarrativeBoundary({
            document,
            guard: guard(document),
            bodies: bodies(noWords),
            blockId: 'refinable',
            side: 'start',
            chosenSample: 62_000,
            algorithmVersion: 1,
            origin: 'quiet-assisted',
            idFactory: idFactory(),
            nowIso: NOW,
        });
        expect(refined.kind).toBe('success');
        if (refined.kind !== 'success') return;
        expect(refined.document.narrative?.blocks.refinable.startBoundaryRefinement).toEqual({
            originalSample: 64_000,
            chosenSample: 62_000,
            algorithmVersion: 1,
            origin: 'quiet-assisted',
        });
        const beforeStarts = refined.document.videoClips.map(clip => clip.timelineStartFrame);
        const mode = planChangeGlobalEditingMode({
            document: refined.document,
            expectedDocumentRevision: refined.document.revision,
            mode: 'absolute',
        });
        expect(mode.kind).toBe('success');
        if (mode.kind !== 'success') return;
        expect(mode.document.videoClips.map(clip => clip.timelineStartFrame)).toEqual(beforeStarts);
        expect(mode.impact.audioGraph).toBe(false);
        expect(mode.history.label).toBe('Use absolute editing');
    });

    it('keeps text, speaker, and presentation overrides non-structural and instance-local', () => {
        const base = transcriptBody();
        const speakerBody = transcriptBody({
            speakerMode: 'diarized',
            words: base.words.map(word => ({ ...word, speakerId: 'speaker_source' })),
            speakers: [{
                id: 'speaker_source',
                label: 'Speaker source',
                segments: [{ startSample: 0, endSample: 80_000 }],
            }, {
                id: 'speaker_override',
                label: 'Speaker override',
                segments: [{ startSample: 80_000, endSample: 160_000 }],
            }],
        });
        const document = makeDocument([{
            id: 'corrected', kind: 'speech', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 0, coreEndSample: 16_000, sourceWordIds: ['word_0'],
        }], { body: speakerBody });
        const beforeClips = document.videoClips;
        const corrected = planSetNarrativeWordText({
            document,
            guard: guard(document),
            bodies: bodies(speakerBody),
            blockId: 'corrected',
            wordId: 'word_0',
            text: '  Corrected phrase  ',
            nowIso: NOW,
        });
        expect(corrected.kind).toBe('success');
        if (corrected.kind !== 'success') return;
        expect(corrected.document.narrative?.blocks.corrected.wordTextOverrides)
            .toEqual({ word_0: 'Corrected phrase' });
        expect(corrected.document.videoClips).toBe(beforeClips);
        expect(corrected.document.audioGraphRevision).toBe(document.audioGraphRevision);
        expect(corrected.anchorTransforms).toEqual([]);

        const assigned = planSetNarrativeWordSpeaker({
            document: corrected.document,
            guard: guard(corrected.document),
            bodies: bodies(speakerBody),
            blockId: 'corrected',
            wordId: 'word_0',
            speakerId: 'speaker_override',
            nowIso: NOW,
        });
        expect(assigned.kind).toBe('success');
        if (assigned.kind !== 'success') return;
        expect(assigned.document.narrative?.blocks.corrected.speakerOverrides)
            .toEqual({ word_0: 'speaker_override' });

        const shown = planSetNarrativeSpeakerVisibility({
            document: assigned.document,
            guard: guard(assigned.document),
            showSpeakers: true,
            nowIso: NOW,
        });
        expect(shown.kind).toBe('success');
        if (shown.kind !== 'success') return;
        expect(shown.document.narrative?.settings.showSpeakers).toBe(true);
        expect(shown.impact.audioGraph).toBe(false);
    });

    it('reorders consecutive blocks across tracks while preserving track identity and gaps', () => {
        const document = makeDocument([{
            id: 'block_0', kind: 'speech', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 0, coreEndSample: 16_000, sourceWordIds: ['word_0'],
        }, {
            id: 'block_1', kind: 'speech', trackId: 'track_2', timelineStartFrame: 40,
            coreStartSample: 16_000, coreEndSample: 32_000, sourceWordIds: ['word_1'],
        }, {
            id: 'block_2', kind: 'speech', trackId: 'track_1', timelineStartFrame: 80,
            coreStartSample: 32_000, coreEndSample: 48_000, sourceWordIds: ['word_2'],
        }]);
        const result = planReorderNarrativeBlocks({
            document,
            guard: guard(document),
            blockIds: ['block_1'],
            targetIndex: 0,
            nowIso: NOW,
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        const narrative = result.document.narrative!;
        expect(narrative.blockIds).toEqual(['block_1', 'block_0', 'block_2']);
        expect(narrative.blockIds.map(id => narrative.blocks[id].timelineStartFrame)).toEqual([0, 40, 80]);
        expect(narrative.blocks.block_1.trackId).toBe('track_2');
        expect(narrative.blocks.block_0.trackId).toBe('track_1');
        expect(result.anchorTransforms).toEqual([{
            kind: 'translated', blockId: 'block_1', deltaFrames: -40,
        }, {
            kind: 'translated', blockId: 'block_0', deltaFrames: 40,
        }]);
        expect(result.playhead).toEqual({ kind: 'seek', frame: 0, reason: 'follow-selection' });
    });

    it('rematerializes one margin and shifts later unified blocks only in ripple mode', () => {
        const document = makeDocument([{
            id: 'margin_block', kind: 'speech', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 16_000, coreEndSample: 32_000, sourceWordIds: ['word_1'],
        }, {
            id: 'later_block', kind: 'speech', trackId: 'track_2', timelineStartFrame: 30,
            coreStartSample: 32_000, coreEndSample: 48_000, sourceWordIds: ['word_2'],
        }]);
        const result = planChangeBlockMargin({
            document,
            guard: guard(document),
            blockId: 'margin_block',
            side: 'pre',
            policy: { kind: 'margin', mode: 'explicit', requestedSamples: 8_000 },
            nowIso: NOW,
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.document.narrative?.blocks.margin_block.materialization.sourceStartFrame).toBe(15);
        expect(result.document.narrative?.blocks.later_block.timelineStartFrame).toBe(45);
        expect(result.anchorTransforms).toEqual([{
            kind: 'trimmed',
            oldBlockId: 'margin_block',
            newBlockIds: ['margin_block'],
            retainedRanges: [{ start: 16_000, end: 32_000 }],
        }, {
            kind: 'translated',
            blockId: 'later_block',
            deltaFrames: 15,
        }]);
    });

    it('returns typed stale, lock, collision, and ordinary-mode preflight results', () => {
        const locked = makeDocument([{
            id: 'silence_locked', kind: 'silence', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 16_000, coreEndSample: 32_000,
        }], { lockedTrackIds: ['track_1'] });
        expect(planDeleteAllSilences({ document: locked, guard: guard(locked), nowIso: NOW }))
            .toMatchObject({ kind: 'error', error: { code: 'locked-track', ids: ['track_1'] } });
        expect(planDeleteAllSilences({
            document: locked,
            guard: { ...guard(locked), expectedDocumentRevision: 0 },
            nowIso: NOW,
        })).toMatchObject({ kind: 'error', error: { code: 'stale-document' } });

        const collision = makeDocument([{
            id: 'speech_0', kind: 'speech', trackId: 'track_1', timelineStartFrame: 0,
            coreStartSample: 0, coreEndSample: 16_000, sourceWordIds: ['word_0'],
        }, {
            id: 'silence_1', kind: 'silence', trackId: 'track_2', timelineStartFrame: 30,
            coreStartSample: 16_000, coreEndSample: 32_000,
        }, {
            id: 'speech_2', kind: 'speech', trackId: 'track_1', timelineStartFrame: 60,
            coreStartSample: 32_000, coreEndSample: 48_000, sourceWordIds: ['word_2'],
        }]);
        collision.videoClips.push({
            id: 'uncontrolled_collision',
            sourceId: 'source_main',
            trackId: 'track_1',
            timelineStartFrame: 30,
            sourceStart: 3,
            sourceEnd: 4,
            audio: null,
        });
        expect(planDeleteAllSilences({ document: collision, guard: guard(collision), nowIso: NOW }))
            .toMatchObject({ kind: 'error', error: { code: 'collision' } });

        expect(planOrdinaryProjectIntervals({
            document: collision,
            expectedDocumentRevision: collision.revision,
            expectedMode: 'absolute',
            items: [{ id: 'item', trackId: 'track_1', start: 0, end: 10 }],
            action: { kind: 'delete', itemId: 'item' },
        })).toEqual({ kind: 'error', code: 'stale-mode', itemIds: [] });
    });
});
