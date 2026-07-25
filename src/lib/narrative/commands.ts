import {
    type GlobalEditingMode,
    type MarginBoundaryPolicyV1,
    type MaterializedBoundaryPolicyV1,
    type NarrativeBlockV1,
    type NarrativeBlockCommonV1,
    type NarrativeBoundaryRefinementOriginV1,
    type NarrativeDocumentV1,
    type ResolvedEditorialTranscriptMapV1,
    type Sha256Digest,
} from '@/types/editorial';
import type {
    EditorDocumentV4,
    TransientMediaSelectionV4,
    VideoClipAudioSettings,
    VideoClipV4,
    VideoSourceDescriptorV3,
} from '@/types/video';
import { isSafeEditorId } from '../editor-document-v3';
import {
    buildVideoTrackPlacementsV4,
    getVideoClipDurationFramesV4,
    getVideoClipPlacementV4,
} from '../video-placement-v4';
import {
    classifyActivationIntervals,
    planOrdinaryTrackIntervals,
    type ActivationIntervalExclusion,
    type HalfOpenInterval,
    type OrdinaryIntervalAction,
    type OrdinaryIntervalPlanResult,
    type TrackIntervalItem,
} from './interval-algebra';
import {
    getOrderedWordSelectionRange,
    requireHydratedTranscriptBody,
} from './source-atoms';
import {
    clampVideoClipAudioSettings,
    getDeterministicSourceEndFrame,
    materializationToSourceCrop,
    materializeActivationRange,
    mergeNarrativeOccurrences,
    rematerializeNarrativeBlock,
    sliceNarrativeOccurrence,
    sourceFrameRangeToTranscriptSamples,
    sourceSampleToVideoFrame,
    splitNarrativeOccurrence,
} from './materializer';

export type NarrativeIdKind =
    | 'narrative'
    | 'block'
    | 'clip'
    | 'instance'
    | 'lineage'
    | 'source-interval'
    | 'partition-seam';

/** Callers inject cryptographically safe IDs; tests inject deterministic seeded factories. */
export type NarrativeIdFactory = (kind: NarrativeIdKind) => string;

export interface NarrativeCommandGuard {
    expectedDocumentRevision: number;
    expectedMode: GlobalEditingMode;
    expectedNarrativeRevision?: number;
}

export type NarrativeCommandErrorCode =
    | 'stale-document'
    | 'stale-mode'
    | 'stale-narrative'
    | 'missing-narrative'
    | 'missing-block'
    | 'missing-clip'
    | 'missing-source'
    | 'missing-transcript'
    | 'invalid-selection'
    | 'invalid-id'
    | 'locked-track'
    | 'source-bounds'
    | 'minimum-duration'
    | 'collision'
    | 'incompatible-merge'
    | 'invalid-proposal';

export interface NarrativeCommandError {
    code: NarrativeCommandErrorCode;
    message: string;
    ids: string[];
}

export type NarrativeAnchorTransform =
    | { kind: 'created'; blockId: string }
    | { kind: 'deleted'; blockId: string }
    | { kind: 'translated'; blockId: string; deltaFrames: number }
    | { kind: 'split'; oldBlockId: string; leftBlockId: string; rightBlockId: string; splitSample: number }
    | { kind: 'merged'; leftBlockId: string; rightBlockId: string; mergedBlockId: string }
    | { kind: 'trimmed'; oldBlockId: string; newBlockIds: string[]; retainedRanges: HalfOpenInterval[] };

export interface NarrativePatchProjection {
    revision: number;
    audioGraphRevision: number;
    narrative: NarrativeDocumentV1 | null;
    videoClips: VideoClipV4[];
    transientSelection: TransientMediaSelectionV4;
    globalEditingMode: GlobalEditingMode;
}

export interface NarrativeHistoryHint {
    createEntry: boolean;
    label: string | null;
    mergeKey: string | null;
}

export interface NarrativePlayheadRecommendation {
    kind: 'keep' | 'seek';
    frame?: number;
    reason: 'non-structural' | 'absolute-gap' | 'deletion-start' | 'follow-selection' | 'clamp';
}

export interface NarrativeActivationReport {
    acceptedClipIds: string[];
    exclusions: ActivationIntervalExclusion[];
}

export type NarrativeActivationCandidatePreflightResult =
    | ({ kind: 'success' } & NarrativeActivationReport)
    | ({ kind: 'noop'; code: 'no-accepted-candidates' } & NarrativeActivationReport)
    | { kind: 'error'; error: NarrativeCommandError };

export interface NarrativeCommandSuccess {
    kind: 'success';
    command: string;
    document: EditorDocumentV4;
    forward: NarrativePatchProjection;
    inverse: NarrativePatchProjection;
    history: NarrativeHistoryHint;
    persistence: { enqueue: true };
    impact: { content: true; audioGraph: boolean };
    pinDelta: { addRecordIds: Sha256Digest[]; removeRecordIds: Sha256Digest[] };
    anchorTransforms: NarrativeAnchorTransform[];
    playhead: NarrativePlayheadRecommendation;
    activationReport?: NarrativeActivationReport;
    silenceDeletionReport?: {
        scope: 'document' | { trackId: string };
        count: number;
        durationFrames: number;
        consequence: GlobalEditingMode;
    };
}

export interface NarrativeCommandNoop {
    kind: 'noop';
    code: 'unchanged' | 'no-eligible-silence' | 'same-order' | 'no-accepted-candidates';
    history: NarrativeHistoryHint;
    persistence: { enqueue: false };
    activationReport?: NarrativeActivationReport;
}

export type NarrativeCommandResult =
    | NarrativeCommandSuccess
    | NarrativeCommandNoop
    | { kind: 'error'; error: NarrativeCommandError };

interface CommandContext {
    document: EditorDocumentV4;
    narrative: NarrativeDocumentV1;
    nextDocumentRevision: number;
    nextNarrativeRevision: number;
}

/**
 * Resolves the exact activation acquisition set without reading transcript descriptors or bodies.
 *
 * WP6 calls this before acquisition, then `planActivateNarrative` reruns the same function after
 * acquisition under a revision/mode guard. This prevents the pre-acquisition request set and the
 * atomic publication command from implementing subtly different overlap or crop rules.
 */
export function preflightNarrativeActivationCandidates(input: {
    document: EditorDocumentV4;
    selectedTrackIds: readonly string[];
}): NarrativeActivationCandidatePreflightResult {
    if (input.selectedTrackIds.length === 0) {
        return commandError('invalid-selection', 'Activation requires at least one selected track.', []);
    }
    const selected = new Set(input.selectedTrackIds);
    if (selected.size !== input.selectedTrackIds.length
        || input.selectedTrackIds.some(trackId => !isSafeEditorId(trackId))) {
        return commandError('invalid-selection', 'Selected track identities must be unique and safe.', [
            ...input.selectedTrackIds,
        ]);
    }
    const trackById = new Map(input.document.videoTracks
        .map((track, index) => [track.id, { track, index }]));
    const missingTracks = input.selectedTrackIds.filter(trackId => !trackById.has(trackId));
    if (missingTracks.length > 0) {
        return commandError('invalid-selection', 'Selected track does not exist.', missingTracks);
    }
    const lockedTracks = input.selectedTrackIds
        .filter(trackId => trackById.get(trackId)!.track.locked);
    if (lockedTracks.length > 0) {
        return commandError('locked-track', 'Selected controlled track is locked.', lockedTracks);
    }

    const ownedClipIds = new Set(Object.values(input.document.narrative?.blocks ?? {})
        .map(block => block.clipId));
    const sourceById = new Map(input.document.videoSources.map(source => [source.id, source]));
    const candidateClips = input.document.videoClips
        .filter(clip => selected.has(clip.trackId) && !ownedClipIds.has(clip.id));
    // Validate every prospective crop before classification so an invalid occurrence cannot be
    // hidden merely because another candidate would exclude its overlap-connected component.
    for (const clip of candidateClips) {
        const source = sourceById.get(clip.sourceId);
        if (!source) return commandError('missing-source', 'Activation source is missing.', [clip.sourceId]);
        if (!exactClipSourceFrameRange(clip, source)) {
            return commandError('source-bounds', 'Clip crop is not aligned to source video frames.', [clip.id]);
        }
    }
    const invariantError = validateOwnedProposal(input.document, {
        requireTranscriptDescriptors: false,
    });
    if (invariantError) return invariantError;
    const candidates = candidateClips.map(clip => {
        const placement = getVideoClipPlacementV4(input.document, clip);
        return {
            id: clip.id,
            trackId: clip.trackId,
            trackOrder: trackById.get(clip.trackId)!.index,
            start: placement.startFrame,
            end: placement.endFrame,
        };
    });
    const existingControlled = input.document.narrative?.blockIds.map(blockId => {
        const block = input.document.narrative!.blocks[blockId];
        const placement = getVideoClipPlacementV4(input.document, block.clipId);
        return { id: block.clipId, start: placement.startFrame, end: placement.endFrame };
    }) ?? [];
    const classification = classifyActivationIntervals(candidates, existingControlled);
    const report: NarrativeActivationReport = {
        acceptedClipIds: classification.accepted.map(candidate => candidate.id),
        exclusions: classification.excluded,
    };
    return report.acceptedClipIds.length > 0
        ? { kind: 'success', ...report }
        : { kind: 'noop', code: 'no-accepted-candidates', ...report };
}

/**
 * Activates only isolated source-backed candidates and materializes them into one global sequence.
 * Transcript acquisition and CAS pin publication intentionally happen before/after this pure plan.
 */
export function planActivateNarrative(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    selectedTrackIds: readonly string[];
    recordIdBySourceId: Readonly<Record<string, Sha256Digest>>;
    bodies: ResolvedEditorialTranscriptMapV1;
    idFactory: NarrativeIdFactory;
    nowIso: string;
    splitOnSpeakerChange?: boolean;
}): NarrativeCommandResult {
    const guardError = preflightGuard(input.document, input.guard, false);
    if (guardError) return guardError;
    if (!isValidIso(input.nowIso)) {
        return commandError('invalid-selection', 'Activation requires an ISO timestamp.', []);
    }
    const candidatePreflight = preflightNarrativeActivationCandidates({
        document: input.document,
        selectedTrackIds: input.selectedTrackIds,
    });
    if (candidatePreflight.kind === 'error') return candidatePreflight;
    if (candidatePreflight.kind === 'noop') {
        return {
            ...noop(candidatePreflight.code),
            activationReport: {
                acceptedClipIds: candidatePreflight.acceptedClipIds,
                exclusions: candidatePreflight.exclusions,
            },
        };
    }
    // The public acquisition preflight intentionally ignores descriptor state. Publication still
    // validates the complete current ownership graph after acquisition has hydrated those inputs.
    const invariantError = validateOwnedProposal(input.document);
    if (invariantError) return invariantError;
    const sourceById = new Map(input.document.videoSources.map(source => [source.id, source]));
    const clipById = new Map(input.document.videoClips.map(clip => [clip.id, clip]));

    const allocator = createIdAllocator(input.document, input.idFactory);
    const existing = input.document.narrative;
    const nextNarrativeRevision = (existing?.revision ?? input.document.revision) + 1;
    const createdBlocks: NarrativeBlockV1[] = [];
    const replacementClips = new Map<string, VideoClipV4[]>();
    const usedRecordIds: Sha256Digest[] = [];

    for (const candidateId of candidatePreflight.acceptedClipIds) {
        const clip = clipById.get(candidateId)!;
        const source = sourceById.get(clip.sourceId);
        if (!source) return commandError('missing-source', 'Activation source is missing.', [clip.sourceId]);
        const recordId = input.recordIdBySourceId[clip.sourceId];
        if (!recordId) return commandError('missing-transcript', 'Activation transcript descriptor is missing.', [clip.sourceId]);
        let body;
        try {
            body = requireHydratedTranscriptBody(input.bodies, recordId);
        } catch {
            return commandError('missing-transcript', 'Activation transcript body is not hydrated.', [recordId]);
        }
        const descriptor = findTranscriptDescriptor(input.document, recordId, clip.sourceId);
        if (!descriptor || descriptor.sampleCount !== body.sampleCount) {
            return commandError('missing-transcript', 'Activation descriptor does not match its source body.', [recordId]);
        }
        const crop = exactClipSourceFrameRange(clip, source);
        if (!crop) return commandError('source-bounds', 'Clip crop is not aligned to source video frames.', [clip.id]);
        let coreRange: HalfOpenInterval;
        try {
            coreRange = sourceFrameRangeToTranscriptSamples(
                crop.start,
                crop.end,
                source.fps,
                body.sampleCount,
            );
        } catch {
            return commandError('source-bounds', 'Clip crop is outside the transcript source duration.', [clip.id]);
        }
        const materialized = materializeActivationRange({
            body,
            coreRange,
            sourceStartFrame: crop.start,
            sourceEndFrame: crop.end,
            timelineStartFrame: clip.timelineStartFrame,
            sourceFps: source.fps,
            sourceDuration: source.duration,
            projectFps: input.document.renderProfile.fps,
            createSeamId: () => allocator('partition-seam'),
            splitOnSpeakerChange: input.splitOnSpeakerChange,
            outerPreBoundary: existing && existing.settings.globalPreMarginSamples > 0
                ? { kind: 'margin', mode: 'explicit', requestedSamples: 0 }
                : undefined,
            outerPostBoundary: existing && existing.settings.globalPostMarginSamples > 0
                ? { kind: 'margin', mode: 'explicit', requestedSamples: 0 }
                : undefined,
        });
        if (materialized.kind === 'error') {
            return commandError(materializerCode(materialized.code), materialized.message, [clip.id]);
        }
        const lineageRootId = allocator('lineage');
        const clips: VideoClipV4[] = [];
        materialized.value.forEach((fragment, index) => {
            const blockId = allocator('block');
            const clipId = index === 0 ? clip.id : allocator('clip');
            const common = {
                id: blockId,
                instanceId: allocator('instance'),
                lineageRootId,
                parentInstanceIds: [],
                clipId,
                trackId: clip.trackId,
                sourceId: clip.sourceId,
                transcriptRecordId: recordId,
                sourceIntervalId: allocator('source-interval'),
                coreStartSample: fragment.atom.start,
                coreEndSample: fragment.atom.end,
                materialization: {
                    sourceStartFrame: fragment.sourceStartFrame,
                    sourceEndFrame: fragment.sourceEndFrame,
                    preBoundary: fragment.preBoundary,
                    postBoundary: fragment.postBoundary,
                },
                timelineStartFrame: fragment.timelineStartFrame,
                startBoundaryRefinement: null,
                endBoundaryRefinement: null,
                revision: nextNarrativeRevision,
            };
            const block: NarrativeBlockV1 = fragment.atom.kind === 'speech'
                ? {
                    ...common,
                    kind: 'speech',
                    sourceWordIds: [...fragment.atom.sourceWordIds],
                    wordTextOverrides: {},
                    speakerOverrides: {},
                }
                : {
                    ...common,
                    kind: 'silence',
                    sourceWordIds: [],
                    evidence: fragment.atom.evidence,
                };
            const sourceCrop = materializationToSourceCrop(block.materialization, source);
            const fragmentDuration = fragment.timelineEndFrame - fragment.timelineStartFrame;
            const audio = clip.audio
                ? {
                    ...clip.audio,
                    fadeInFrames: index === 0 ? clip.audio.fadeInFrames : 0,
                    fadeOutFrames: index === materialized.value.length - 1 ? clip.audio.fadeOutFrames : 0,
                }
                : null;
            clips.push({
                ...clip,
                id: clipId,
                timelineStartFrame: fragment.timelineStartFrame,
                ...sourceCrop,
                audio: clampVideoClipAudioSettings(audio, fragmentDuration),
            });
            createdBlocks.push(block);
        });
        replacementClips.set(clip.id, clips);
        usedRecordIds.push(recordId);
    }

    const videoClips = input.document.videoClips.flatMap(clip => replacementClips.get(clip.id) ?? [clip]);
    const blocks = { ...(existing?.blocks ?? {}) };
    createdBlocks.forEach(block => { blocks[block.id] = block; });
    const controlledTrackSet = new Set(existing?.controlledTrackIds ?? []);
    createdBlocks.forEach(block => controlledTrackSet.add(block.trackId));
    const controlledTrackIds = input.document.videoTracks
        .filter(track => controlledTrackSet.has(track.id))
        .map(track => track.id);
    const sourceRecordIds = [...(existing?.sourceRecordIds ?? [])];
    usedRecordIds.forEach(recordId => {
        if (!sourceRecordIds.includes(recordId)) sourceRecordIds.push(recordId);
    });
    const narrative: NarrativeDocumentV1 = {
        version: 1,
        id: existing?.id ?? allocator('narrative'),
        revision: nextNarrativeRevision,
        controlledTrackIds,
        blockIds: sortBlockIdsByProjectTime(
            [...(existing?.blockIds ?? []), ...createdBlocks.map(block => block.id)],
            blocks,
            videoClips,
            input.document,
        ),
        blocks,
        sourceRecordIds,
        settings: existing?.settings ?? {
            globalPreMarginSamples: 0,
            globalPostMarginSamples: 0,
            boundaryRefinementEnabled: true,
            showSpeakers: false,
        },
        createdAt: existing?.createdAt ?? input.nowIso,
        updatedAt: input.nowIso,
    };
    const firstCreated = createdBlocks[0];
    const selection: TransientMediaSelectionV4 = {
        kind: 'narrative',
        trackId: firstCreated.trackId,
        blockId: firstCreated.id,
        sourceWordIds: [...firstCreated.sourceWordIds],
        boundary: null,
    };
    const result = finalizePlan({
        command: existing ? 'add-controlled-tracks' : 'enable-text-editing',
        label: existing ? 'Add controlled tracks' : 'Enable text editing',
        before: input.document,
        narrative,
        videoClips,
        selection,
        audioGraph: true,
        anchorTransforms: createdBlocks.map(block => ({ kind: 'created', blockId: block.id })),
        playhead: { kind: 'seek', frame: firstCreated.timelineStartFrame, reason: 'follow-selection' },
    });
    if (result.kind !== 'success') return result;
    result.activationReport = {
        acceptedClipIds: candidatePreflight.acceptedClipIds,
        exclusions: candidatePreflight.exclusions,
    };
    return result;
}

/**
 * Releases narrative authority while preserving every owned clip as ordinary V4 media in place.
 *
 * A release is deliberately represented as anchor deletion, not media deletion: WP5 removes the
 * corresponding links/bindings and applies follow policy, while WP6 publishes the unchanged clip
 * graph together with this narrative projection as one history command.
 */
export function planReleaseNarrativeTracks(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    trackIds: readonly string[];
    nowIso: string;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    if (input.trackIds.length === 0
        || new Set(input.trackIds).size !== input.trackIds.length
        || input.trackIds.some(trackId => !isSafeEditorId(trackId))) {
        return commandError('invalid-selection', 'Released track identities must be unique and safe.', [
            ...input.trackIds,
        ]);
    }
    const controlled = new Set(context.narrative.controlledTrackIds);
    const uncontrolledIds = input.trackIds.filter(trackId => !controlled.has(trackId));
    if (uncontrolledIds.length > 0) {
        return commandError('invalid-selection', 'Released track is not currently controlled.', uncontrolledIds);
    }
    const releasedTracks = new Set(input.trackIds);
    const releasedBlockIds = context.narrative.blockIds
        .filter(blockId => releasedTracks.has(context.narrative.blocks[blockId].trackId));
    const controlledTrackIds = context.narrative.controlledTrackIds
        .filter(trackId => !releasedTracks.has(trackId));
    let narrative: NarrativeDocumentV1 | null;
    let selection: TransientMediaSelectionV4;
    if (controlledTrackIds.length === 0) {
        narrative = null;
        selection = input.document.transientSelection.kind === 'narrative'
            ? { kind: 'none' }
            : input.document.transientSelection;
    } else {
        const blocks = cloneBlockMap(context.narrative.blocks);
        releasedBlockIds.forEach(blockId => { delete blocks[blockId]; });
        const blockIds = context.narrative.blockIds
            .filter(blockId => !releasedTracks.has(context.narrative.blocks[blockId].trackId));
        narrative = reviseNarrative(context, { blocks, blockIds, controlledTrackIds }, input.nowIso);
        selection = repairSelection(input.document.transientSelection, narrative);
    }
    const result = finalizePlan({
        command: 'release-controlled-tracks',
        label: 'Release controlled tracks',
        before: input.document,
        narrative,
        videoClips: input.document.videoClips,
        selection,
        audioGraph: false,
        anchorTransforms: releasedBlockIds.map(blockId => ({ kind: 'deleted', blockId })),
        playhead: { kind: 'keep', reason: 'non-structural' },
    });
    if (result.kind === 'success') {
        // The inverse history projection still references every released record. Pin release is a
        // later history-pruning concern, never part of the authority-release transaction itself.
        result.pinDelta = { addRecordIds: [], removeRecordIds: [] };
    }
    return result;
}

export function planSplitNarrativeBlock(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    bodies: ResolvedEditorialTranscriptMapV1;
    blockId: string;
    splitSample: number;
    idFactory: NarrativeIdFactory;
    nowIso: string;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    const block = context.narrative.blocks[input.blockId];
    if (!block) return commandError('missing-block', 'Split block does not exist.', [input.blockId]);
    const clip = input.document.videoClips.find(value => value.id === block.clipId);
    const source = input.document.videoSources.find(value => value.id === block.sourceId);
    if (!clip) return commandError('missing-clip', 'Split block clip does not exist.', [block.clipId]);
    if (!source) return commandError('missing-source', 'Split source does not exist.', [block.sourceId]);
    const locked = preflightLockedTracks(input.document, [block.trackId]);
    if (locked) return locked;
    let body;
    try {
        body = requireHydratedTranscriptBody(input.bodies, block.transcriptRecordId);
    } catch {
        return commandError('missing-transcript', 'Split transcript body is not hydrated.', [block.transcriptRecordId]);
    }
    const allocate = createIdAllocator(input.document, input.idFactory);
    const split = splitNarrativeOccurrence({
        block,
        clip,
        body,
        source,
        projectFps: input.document.renderProfile.fps,
        splitSample: input.splitSample,
        revision: context.nextNarrativeRevision,
        ids: {
            seamId: allocate('partition-seam'),
            leftInstanceId: allocate('instance'),
            rightInstanceId: allocate('instance'),
            leftSourceIntervalId: allocate('source-interval'),
            rightSourceIntervalId: allocate('source-interval'),
            rightBlockId: allocate('block'),
            rightClipId: allocate('clip'),
        },
    });
    if (split.kind === 'error') {
        return commandError(materializerCode(split.code), split.message, [block.id]);
    }
    const blocks = { ...context.narrative.blocks, [block.id]: split.value.leftBlock };
    blocks[split.value.rightBlock.id] = split.value.rightBlock;
    const index = context.narrative.blockIds.indexOf(block.id);
    const blockIds = [...context.narrative.blockIds];
    blockIds.splice(index, 1, split.value.leftBlock.id, split.value.rightBlock.id);
    const videoClips = input.document.videoClips.flatMap(value => value.id === clip.id
        ? [split.value.leftClip, split.value.rightClip]
        : [value]);
    const narrative = reviseNarrative(context, { blocks, blockIds }, input.nowIso);
    const selection = selectionForBlock(split.value.rightBlock);
    return finalizePlan({
        command: 'split-text-block',
        label: 'Split text block',
        before: input.document,
        narrative,
        videoClips,
        selection,
        audioGraph: true,
        anchorTransforms: [{
            kind: 'split',
            oldBlockId: block.id,
            leftBlockId: split.value.leftBlock.id,
            rightBlockId: split.value.rightBlock.id,
            splitSample: input.splitSample,
        }],
        playhead: { kind: 'seek', frame: split.value.rightBlock.timelineStartFrame, reason: 'follow-selection' },
    });
}

export function planMergeNarrativeBlocks(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    leftBlockId: string;
    rightBlockId: string;
    idFactory: NarrativeIdFactory;
    nowIso: string;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    const leftIndex = context.narrative.blockIds.indexOf(input.leftBlockId);
    if (leftIndex < 0 || context.narrative.blockIds[leftIndex + 1] !== input.rightBlockId) {
        return commandError('incompatible-merge', 'Merge blocks must be adjacent in narrative order.', [
            input.leftBlockId,
            input.rightBlockId,
        ]);
    }
    const left = context.narrative.blocks[input.leftBlockId];
    const right = context.narrative.blocks[input.rightBlockId];
    const leftClip = input.document.videoClips.find(clip => clip.id === left.clipId);
    const rightClip = input.document.videoClips.find(clip => clip.id === right.clipId);
    const source = input.document.videoSources.find(value => value.id === left.sourceId);
    if (!leftClip || !rightClip) return commandError('missing-clip', 'Merge clip does not exist.', [left.clipId, right.clipId]);
    if (!source) return commandError('missing-source', 'Merge source does not exist.', [left.sourceId]);
    const locked = preflightLockedTracks(input.document, [left.trackId, right.trackId]);
    if (locked) return locked;
    const allocate = createIdAllocator(input.document, input.idFactory);
    const merged = mergeNarrativeOccurrences({
        leftBlock: left,
        rightBlock: right,
        leftClip,
        rightClip,
        source,
        projectFps: input.document.renderProfile.fps,
        revision: context.nextNarrativeRevision,
        mergedInstanceId: allocate('instance'),
        mergedSourceIntervalId: allocate('source-interval'),
    });
    if (merged.kind === 'error') {
        return commandError('incompatible-merge', merged.message, [left.id, right.id]);
    }
    const blocks = { ...context.narrative.blocks, [left.id]: merged.value.block };
    delete blocks[right.id];
    const blockIds = context.narrative.blockIds.filter(id => id !== right.id);
    const videoClips = input.document.videoClips
        .filter(clip => clip.id !== rightClip.id)
        .map(clip => clip.id === leftClip.id ? merged.value.clip : clip);
    const narrative = reviseNarrative(context, { blocks, blockIds }, input.nowIso);
    return finalizePlan({
        command: 'merge-text-blocks',
        label: 'Merge text blocks',
        before: input.document,
        narrative,
        videoClips,
        selection: selectionForBlock(merged.value.block),
        audioGraph: true,
        anchorTransforms: [{
            kind: 'merged',
            leftBlockId: left.id,
            rightBlockId: right.id,
            mergedBlockId: merged.value.block.id,
        }],
        playhead: { kind: 'seek', frame: merged.value.block.timelineStartFrame, reason: 'follow-selection' },
    });
}

export interface NarrativeRangeSelection {
    start: { blockId: string; sample: number };
    end: { blockId: string; sample: number };
}

export function planDeleteNarrativeWords(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    bodies: ResolvedEditorialTranscriptMapV1;
    firstBlockId: string;
    firstWordId: string;
    lastBlockId: string;
    lastWordId: string;
    idFactory: NarrativeIdFactory;
    nowIso: string;
    currentPlayheadFrame?: number;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    const first = context.narrative.blocks[input.firstBlockId];
    const last = context.narrative.blocks[input.lastBlockId];
    if (!first || !last) return commandError('missing-block', 'Word selection block does not exist.', [
        input.firstBlockId,
        input.lastBlockId,
    ]);
    let firstBody;
    let lastBody;
    try {
        firstBody = requireHydratedTranscriptBody(input.bodies, first.transcriptRecordId);
        lastBody = requireHydratedTranscriptBody(input.bodies, last.transcriptRecordId);
    } catch {
        return commandError('missing-transcript', 'Word selection transcript body is not hydrated.', []);
    }
    const firstRange = getOrderedWordSelectionRange(firstBody, input.firstWordId, input.firstWordId);
    const lastRange = getOrderedWordSelectionRange(lastBody, input.lastWordId, input.lastWordId);
    if (!firstRange || !lastRange) return commandError('invalid-selection', 'Selected source word does not exist.', [
        input.firstWordId,
        input.lastWordId,
    ]);
    return planDeleteNarrativeRange({
        ...input,
        selection: {
            start: { blockId: input.firstBlockId, sample: firstRange.start },
            end: { blockId: input.lastBlockId, sample: lastRange.end },
        },
    });
}

export function planDeleteNarrativeRange(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    bodies: ResolvedEditorialTranscriptMapV1;
    selection: NarrativeRangeSelection;
    idFactory: NarrativeIdFactory;
    nowIso: string;
    currentPlayheadFrame?: number;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    const startIndex = context.narrative.blockIds.indexOf(input.selection.start.blockId);
    const endIndex = context.narrative.blockIds.indexOf(input.selection.end.blockId);
    if (startIndex < 0 || endIndex < startIndex) {
        return commandError('invalid-selection', 'Range endpoints must follow narrative order.', [
            input.selection.start.blockId,
            input.selection.end.blockId,
        ]);
    }
    const startBlock = context.narrative.blocks[input.selection.start.blockId];
    const endBlock = context.narrative.blocks[input.selection.end.blockId];
    if (input.selection.start.sample < startBlock.coreStartSample
        || input.selection.start.sample >= startBlock.coreEndSample
        || input.selection.end.sample <= endBlock.coreStartSample
        || input.selection.end.sample > endBlock.coreEndSample
        || (startIndex === endIndex && input.selection.start.sample >= input.selection.end.sample)) {
        return commandError('source-bounds', 'Delete range must be non-empty and inside selected cores.', []);
    }
    const affectedIds = context.narrative.blockIds.slice(startIndex, endIndex + 1);
    const bodies = new Map<string, ReturnType<typeof requireHydratedTranscriptBody>>();
    for (const blockId of affectedIds) {
        const block = context.narrative.blocks[blockId];
        try {
            bodies.set(blockId, requireHydratedTranscriptBody(input.bodies, block.transcriptRecordId));
        } catch {
            return commandError('missing-transcript', 'Delete range transcript body is not hydrated.', [block.transcriptRecordId]);
        }
    }
    if (!isWordBoundary(bodies.get(startBlock.id)!, input.selection.start.sample)
        || !isWordBoundary(bodies.get(endBlock.id)!, input.selection.end.sample)) {
        return commandError('invalid-selection', 'Delete range cannot cut through an immutable source word.', []);
    }
    const tracksThatMove = input.document.globalEditingMode === 'ripple'
        ? context.narrative.blockIds.slice(startIndex).map(id => context.narrative.blocks[id].trackId)
        : affectedIds.map(id => context.narrative.blocks[id].trackId);
    const locked = preflightLockedTracks(input.document, tracksThatMove);
    if (locked) return locked;
    return planRangeRemoval({
        context,
        bodies,
        selection: input.selection,
        startIndex,
        endIndex,
        idFactory: input.idFactory,
        nowIso: input.nowIso,
        label: 'Delete text selection',
        command: 'delete-text-selection',
        currentPlayheadFrame: input.currentPlayheadFrame,
    });
}

export function planTrimNarrativeBlock(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    bodies: ResolvedEditorialTranscriptMapV1;
    blockId: string;
    side: 'start' | 'end';
    sample: number;
    idFactory: NarrativeIdFactory;
    nowIso: string;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    const block = context.narrative.blocks[input.blockId];
    if (!block) return commandError('missing-block', 'Trim block does not exist.', [input.blockId]);
    if ((input.side === 'start' && input.sample === block.coreStartSample)
        || (input.side === 'end' && input.sample === block.coreEndSample)) return noop('unchanged');
    if (input.side === 'start' && input.sample > block.coreStartSample
        || input.side === 'end' && input.sample < block.coreEndSample) {
        const selection: NarrativeRangeSelection = input.side === 'start'
            ? {
                start: { blockId: block.id, sample: block.coreStartSample },
                end: { blockId: block.id, sample: input.sample },
            }
            : {
                start: { blockId: block.id, sample: input.sample },
                end: { blockId: block.id, sample: block.coreEndSample },
            };
        const result = planDeleteNarrativeRange({ ...input, selection });
        if (result.kind === 'success') {
            result.command = 'trim-text-block';
            result.history.label = 'Trim text block';
        }
        return result;
    }
    return planExtendNarrativeBlock({
        ...input,
        newStartSample: input.side === 'start' ? input.sample : block.coreStartSample,
        newEndSample: input.side === 'end' ? input.sample : block.coreEndSample,
        historyLabel: 'Trim text block',
        command: 'trim-text-block',
    });
}

export function planReorderNarrativeBlocks(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    blockIds: readonly string[];
    targetIndex?: number;
    targetStartFrame?: number;
    nowIso: string;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    if (input.blockIds.length === 0 || new Set(input.blockIds).size !== input.blockIds.length) {
        return commandError('invalid-selection', 'Reorder selection must contain unique blocks.', [...input.blockIds]);
    }
    const firstIndex = context.narrative.blockIds.indexOf(input.blockIds[0]);
    if (firstIndex < 0 || input.blockIds.some((id, offset) => context.narrative.blockIds[firstIndex + offset] !== id)) {
        return commandError('invalid-selection', 'Reorder selection must be consecutive.', [...input.blockIds]);
    }
    const selectedSet = new Set(input.blockIds);
    const remaining = context.narrative.blockIds.filter(id => !selectedSet.has(id));
    const clipsById = new Map(input.document.videoClips.map(clip => [clip.id, clip]));
    const blocks = cloneBlockMap(context.narrative.blocks);
    let blockIds: string[];
    if (input.document.globalEditingMode === 'ripple') {
        if (!Number.isSafeInteger(input.targetIndex)
            || input.targetIndex! < 0
            || input.targetIndex! > remaining.length) {
            return commandError('invalid-selection', 'Ripple reorder target index is invalid.', []);
        }
        blockIds = [...remaining];
        blockIds.splice(input.targetIndex!, 0, ...input.blockIds);
        if (blockIds.every((id, index) => id === context.narrative.blockIds[index])) return noop('same-order');
        const oldIntervals = getOrderedBlockIntervals(context.narrative, input.document.videoClips, input.document);
        const gaps = oldIntervals.map((interval, index) => index === 0
            ? interval.start
            : interval.start - oldIntervals[index - 1].end);
        let cursor = 0;
        blockIds.forEach((blockId, index) => {
            cursor += gaps[index];
            if (blocks[blockId].timelineStartFrame !== cursor) {
                blocks[blockId] = {
                    ...blocks[blockId],
                    timelineStartFrame: cursor,
                    revision: context.nextNarrativeRevision,
                };
            }
            const clip = clipsById.get(blocks[blockId].clipId)!;
            cursor += getVideoClipDurationFramesV4(clip, input.document.renderProfile);
        });
    } else {
        if (!Number.isSafeInteger(input.targetStartFrame) || input.targetStartFrame! < 0) {
            return commandError('invalid-selection', 'Absolute reorder requires a safe destination frame.', []);
        }
        const selectedBlocks = input.blockIds.map(id => context.narrative.blocks[id]);
        const selectedIntervals = selectedBlocks.map(block => {
            const clip = clipsById.get(block.clipId)!;
            return {
                start: block.timelineStartFrame,
                end: block.timelineStartFrame + getVideoClipDurationFramesV4(clip, input.document.renderProfile),
            };
        });
        const origin = selectedIntervals[0].start;
        selectedBlocks.forEach((block, index) => {
            blocks[block.id] = {
                ...block,
                timelineStartFrame: input.targetStartFrame! + selectedIntervals[index].start - origin,
                revision: context.nextNarrativeRevision,
            };
        });
        blockIds = sortBlockIdsByProjectTime(
            context.narrative.blockIds,
            blocks,
            input.document.videoClips.map(clip => {
                const block = Object.values(blocks).find(value => value.clipId === clip.id);
                return block ? { ...clip, timelineStartFrame: block.timelineStartFrame } : clip;
            }),
            input.document,
        );
    }
    const movedBlockIds = blockIds
        .filter(id => blocks[id].timelineStartFrame !== context.narrative.blocks[id].timelineStartFrame)
    if (movedBlockIds.length === 0
        && blockIds.every((id, index) => id === context.narrative.blockIds[index])) return noop('same-order');
    const tracks = movedBlockIds.map(id => blocks[id].trackId);
    const locked = preflightLockedTracks(input.document, tracks);
    if (locked) return locked;
    const videoClips = input.document.videoClips.map(clip => {
        const block = Object.values(blocks).find(value => value.clipId === clip.id);
        return block ? { ...clip, timelineStartFrame: block.timelineStartFrame } : clip;
    });
    const narrative = reviseNarrative(context, { blocks, blockIds }, input.nowIso);
    return finalizePlan({
        command: 'reorder-narrative',
        label: 'Reorder narrative',
        before: input.document,
        narrative,
        videoClips,
        selection: selectionForBlock(blocks[input.blockIds[0]]),
        audioGraph: true,
        anchorTransforms: translatedBlockTransforms(context.narrative.blocks, blocks, movedBlockIds),
        playhead: { kind: 'seek', frame: blocks[input.blockIds[0]].timelineStartFrame, reason: 'follow-selection' },
    });
}

export function planInsertSourceRange(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    bodies: ResolvedEditorialTranscriptMapV1;
    recordId: Sha256Digest;
    sourceId: string;
    sourceRange: HalfOpenInterval;
    destinationTrackId: string;
    targetIndex?: number;
    timelineStartFrame?: number;
    clipAudio: VideoClipAudioSettings | null;
    idFactory: NarrativeIdFactory;
    nowIso: string;
    command?: 'insert-source-range' | 'recover-source-range' | 'extend-source-range';
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    if (!context.narrative.controlledTrackIds.includes(input.destinationTrackId)) {
        return commandError('invalid-selection', 'Insertion destination must be a controlled track.', [input.destinationTrackId]);
    }
    const locked = preflightLockedTracks(input.document, [input.destinationTrackId]);
    if (locked) return locked;
    const source = input.document.videoSources.find(value => value.id === input.sourceId);
    const descriptor = findTranscriptDescriptor(input.document, input.recordId, input.sourceId);
    if (!source) return commandError('missing-source', 'Insertion source does not exist.', [input.sourceId]);
    if (!descriptor) {
        return commandError('missing-transcript', 'Insertion descriptor does not match the source.', [input.recordId]);
    }
    let body;
    try {
        body = requireHydratedTranscriptBody(input.bodies, input.recordId);
    } catch {
        return commandError('missing-transcript', 'Insertion transcript body is not hydrated.', [input.recordId]);
    }
    if (input.sourceRange.start < 0
        || input.sourceRange.end <= input.sourceRange.start
        || input.sourceRange.end > body.sampleCount) {
        return commandError('source-bounds', 'Insertion range is outside the immutable source body.', []);
    }
    const mode = input.document.globalEditingMode;
    const targetIndex = mode === 'ripple' ? input.targetIndex : undefined;
    if (mode === 'ripple' && (!Number.isSafeInteger(targetIndex)
        || targetIndex! < 0 || targetIndex! > context.narrative.blockIds.length)) {
        return commandError('invalid-selection', 'Ripple insertion target index is invalid.', []);
    }
    if (mode === 'absolute' && (!Number.isSafeInteger(input.timelineStartFrame) || input.timelineStartFrame! < 0)) {
        return commandError('invalid-selection', 'Absolute insertion requires a safe project frame.', []);
    }
    const preSamples = context.narrative.settings.globalPreMarginSamples;
    const postSamples = context.narrative.settings.globalPostMarginSamples;
    const sourceStartFrame = sourceSampleToVideoFrame(
        Math.max(0, input.sourceRange.start - preSamples),
        source.fps,
        'floor',
    );
    const sourceEndFrame = Math.min(
        getDeterministicSourceEndFrame(source),
        sourceSampleToVideoFrame(
            Math.min(body.sampleCount, input.sourceRange.end + postSamples),
            source.fps,
            'ceil',
        ),
    );
    const insertStart = mode === 'absolute'
        ? input.timelineStartFrame!
        : targetIndex! < context.narrative.blockIds.length
            ? context.narrative.blocks[context.narrative.blockIds[targetIndex!]].timelineStartFrame
            : contentEndFrame(context.narrative, input.document.videoClips, input.document);
    const allocate = createIdAllocator(input.document, input.idFactory);
    const materialized = materializeActivationRange({
        body,
        coreRange: input.sourceRange,
        sourceStartFrame,
        sourceEndFrame,
        timelineStartFrame: insertStart,
        sourceFps: source.fps,
        sourceDuration: source.duration,
        projectFps: input.document.renderProfile.fps,
        createSeamId: () => allocate('partition-seam'),
    });
    if (materialized.kind === 'error') {
        return commandError(materializerCode(materialized.code), materialized.message, []);
    }
    const lineageRootId = allocate('lineage');
    const createdBlocks: NarrativeBlockV1[] = [];
    const createdClips: VideoClipV4[] = [];
    materialized.value.forEach(fragment => {
        const blockId = allocate('block');
        const clipId = allocate('clip');
        const common = {
            id: blockId,
            instanceId: allocate('instance'),
            lineageRootId,
            parentInstanceIds: [],
            clipId,
            trackId: input.destinationTrackId,
            sourceId: input.sourceId,
            transcriptRecordId: input.recordId,
            sourceIntervalId: allocate('source-interval'),
            coreStartSample: fragment.atom.start,
            coreEndSample: fragment.atom.end,
            materialization: {
                sourceStartFrame: fragment.sourceStartFrame,
                sourceEndFrame: fragment.sourceEndFrame,
                preBoundary: fragment.preBoundary,
                postBoundary: fragment.postBoundary,
            },
            timelineStartFrame: fragment.timelineStartFrame,
            startBoundaryRefinement: null,
            endBoundaryRefinement: null,
            revision: context.nextNarrativeRevision,
        };
        const block: NarrativeBlockV1 = fragment.atom.kind === 'speech'
            ? { ...common, kind: 'speech', sourceWordIds: [...fragment.atom.sourceWordIds], wordTextOverrides: {}, speakerOverrides: {} }
            : { ...common, kind: 'silence', sourceWordIds: [], evidence: fragment.atom.evidence };
        createdBlocks.push(block);
        createdClips.push({
            id: clipId,
            sourceId: input.sourceId,
            trackId: input.destinationTrackId,
            timelineStartFrame: fragment.timelineStartFrame,
            ...materializationToSourceCrop(block.materialization, source),
            audio: clampVideoClipAudioSettings(input.clipAudio
                ? {
                    ...input.clipAudio,
                    fadeInFrames: fragment === materialized.value[0] ? input.clipAudio.fadeInFrames : 0,
                    fadeOutFrames: fragment === materialized.value.at(-1) ? input.clipAudio.fadeOutFrames : 0,
                }
                : null, fragment.timelineEndFrame - fragment.timelineStartFrame),
        });
    });
    const insertedDuration = materialized.value.at(-1)!.timelineEndFrame - insertStart;
    const blocks = cloneBlockMap(context.narrative.blocks);
    let videoClips = input.document.videoClips.map(clip => ({ ...clip }));
    let shiftedIds: string[] = [];
    if (mode === 'ripple') {
        shiftedIds = context.narrative.blockIds.slice(targetIndex!);
        const shiftLocked = preflightLockedTracks(input.document, shiftedIds.map(id => blocks[id].trackId));
        if (shiftLocked) return shiftLocked;
        shiftedIds.forEach(id => {
            blocks[id] = {
                ...blocks[id],
                timelineStartFrame: blocks[id].timelineStartFrame + insertedDuration,
                revision: context.nextNarrativeRevision,
            };
        });
        videoClips = videoClips.map(clip => {
            const block = Object.values(blocks).find(value => value.clipId === clip.id);
            return block ? { ...clip, timelineStartFrame: block.timelineStartFrame } : clip;
        });
    }
    createdBlocks.forEach(block => { blocks[block.id] = block; });
    videoClips.push(...createdClips);
    const blockIds = mode === 'ripple'
        ? [...context.narrative.blockIds.slice(0, targetIndex!), ...createdBlocks.map(block => block.id),
            ...context.narrative.blockIds.slice(targetIndex!)]
        : sortBlockIdsByProjectTime(
            [...context.narrative.blockIds, ...createdBlocks.map(block => block.id)],
            blocks,
            videoClips,
            input.document,
        );
    const sourceRecordIds = [...context.narrative.sourceRecordIds];
    if (!sourceRecordIds.includes(input.recordId)) sourceRecordIds.push(input.recordId);
    const narrative = reviseNarrative(context, { blocks, blockIds, sourceRecordIds }, input.nowIso);
    const command = input.command ?? 'insert-source-range';
    return finalizePlan({
        command,
        label: command === 'extend-source-range'
            ? 'Extend source range'
            : command === 'recover-source-range'
                ? 'Recover source range'
                : 'Insert source range',
        before: input.document,
        narrative,
        videoClips,
        selection: selectionForBlock(createdBlocks[0]),
        audioGraph: true,
        anchorTransforms: [
            ...createdBlocks.map(block => ({ kind: 'created' as const, blockId: block.id })),
            ...translatedBlockTransforms(context.narrative.blocks, blocks, shiftedIds),
        ],
        playhead: { kind: 'seek', frame: createdBlocks[0].timelineStartFrame, reason: 'follow-selection' },
    });
}

/** Recovery is an insertion of a fresh occurrence; equal source ranges are intentionally allowed. */
export function planRecoverSourceRange(
    input: Parameters<typeof planInsertSourceRange>[0],
): NarrativeCommandResult {
    return planInsertSourceRange({ ...input, command: 'recover-source-range' });
}

export function planExtendNarrativeBlock(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    bodies: ResolvedEditorialTranscriptMapV1;
    blockId: string;
    newStartSample: number;
    newEndSample: number;
    idFactory: NarrativeIdFactory;
    nowIso: string;
    historyLabel?: string;
    command?: string;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    const block = context.narrative.blocks[input.blockId];
    if (!block) return commandError('missing-block', 'Extended block does not exist.', [input.blockId]);
    if (block.coreStartSample === input.newStartSample && block.coreEndSample === input.newEndSample) {
        return noop('unchanged');
    }
    const clip = input.document.videoClips.find(value => value.id === block.clipId);
    const source = input.document.videoSources.find(value => value.id === block.sourceId);
    if (!clip) return commandError('missing-clip', 'Extended block clip does not exist.', [block.clipId]);
    if (!source) return commandError('missing-source', 'Extended block source does not exist.', [block.sourceId]);
    let body;
    try {
        body = requireHydratedTranscriptBody(input.bodies, block.transcriptRecordId);
    } catch {
        return commandError('missing-transcript', 'Extended block transcript is not hydrated.', [block.transcriptRecordId]);
    }
    if (!isWordBoundary(body, input.newStartSample) || !isWordBoundary(body, input.newEndSample)) {
        return commandError('invalid-selection', 'Extended core cannot cut through an immutable source word.', []);
    }
    const blockIndex = context.narrative.blockIds.indexOf(block.id);
    const locked = preflightLockedTracks(input.document, input.document.globalEditingMode === 'ripple'
        ? context.narrative.blockIds.slice(blockIndex).map(id => context.narrative.blocks[id].trackId)
        : [block.trackId]);
    if (locked) return locked;
    const allocate = createIdAllocator(input.document, input.idFactory);
    const oldEnd = block.timelineStartFrame + getVideoClipDurationFramesV4(clip, input.document.renderProfile);
    const initialStart = input.document.globalEditingMode === 'absolute'
        && input.newStartSample !== block.coreStartSample
        ? 0
        : block.timelineStartFrame;
    const sliced = sliceNarrativeOccurrence({
        original: block,
        clip,
        body,
        source,
        projectFps: input.document.renderProfile.fps,
        coreRange: { start: input.newStartSample, end: input.newEndSample },
        timelineStartFrame: initialStart,
        revision: context.nextNarrativeRevision,
        ids: {
            blockId: block.id,
            clipId: clip.id,
            instanceId: allocate('instance'),
            sourceIntervalId: allocate('source-interval'),
        },
    });
    if (sliced.kind === 'error') return commandError(materializerCode(sliced.code), sliced.message, [block.id]);
    const newDuration = getVideoClipDurationFramesV4(sliced.value.clip, input.document.renderProfile);
    const oldDuration = getVideoClipDurationFramesV4(clip, input.document.renderProfile);
    const timelineStartFrame = input.document.globalEditingMode === 'absolute'
        && input.newStartSample !== block.coreStartSample
        ? oldEnd - newDuration
        : block.timelineStartFrame;
    if (timelineStartFrame < 0) return commandError('source-bounds', 'Absolute extension would start before project zero.', [block.id]);
    const replacementBlock = { ...sliced.value.block, timelineStartFrame };
    const replacementClip = { ...sliced.value.clip, timelineStartFrame };
    const blocks = cloneBlockMap(context.narrative.blocks);
    blocks[block.id] = replacementBlock;
    if (input.document.globalEditingMode === 'ripple') {
        const delta = newDuration - oldDuration;
        const index = context.narrative.blockIds.indexOf(block.id);
        context.narrative.blockIds.slice(index + 1).forEach(id => {
            blocks[id] = {
                ...blocks[id],
                timelineStartFrame: blocks[id].timelineStartFrame + delta,
                revision: context.nextNarrativeRevision,
            };
        });
    }
    const videoClips = input.document.videoClips.map(value => {
        if (value.id === replacementClip.id) return replacementClip;
        const moved = Object.values(blocks).find(candidate => candidate.clipId === value.id);
        return moved ? { ...value, timelineStartFrame: moved.timelineStartFrame } : value;
    });
    const narrative = reviseNarrative(context, { blocks }, input.nowIso);
    const translatedIds = context.narrative.blockIds
        .filter(id => id !== block.id);
    return finalizePlan({
        command: input.command ?? 'extend-source-range',
        label: input.historyLabel ?? 'Extend source range',
        before: input.document,
        narrative,
        videoClips,
        selection: selectionForBlock(replacementBlock),
        audioGraph: true,
        anchorTransforms: [
            {
                kind: 'trimmed',
                oldBlockId: block.id,
                newBlockIds: [replacementBlock.id],
                retainedRanges: [{ start: replacementBlock.coreStartSample, end: replacementBlock.coreEndSample }],
            },
            ...translatedBlockTransforms(context.narrative.blocks, blocks, translatedIds),
        ],
        playhead: { kind: 'seek', frame: replacementBlock.timelineStartFrame, reason: 'follow-selection' },
    });
}

/** Applies or resets one instance-local correction without touching immutable transcript bytes. */
export function planSetNarrativeWordText(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    bodies: ResolvedEditorialTranscriptMapV1;
    blockId: string;
    wordId: string;
    text: string | null;
    nowIso: string;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    const block = context.narrative.blocks[input.blockId];
    if (!block) return commandError('missing-block', 'Corrected block does not exist.', [input.blockId]);
    if (block.kind !== 'speech' || !block.sourceWordIds.includes(input.wordId)) {
        return commandError('invalid-selection', 'Correction requires a retained word occurrence.', [input.wordId]);
    }
    let body;
    try {
        body = requireHydratedTranscriptBody(input.bodies, block.transcriptRecordId);
    } catch {
        return commandError('missing-transcript', 'Correction transcript body is not hydrated.', [block.transcriptRecordId]);
    }
    const sourceWord = body.words.find(word => word.id === input.wordId);
    if (!sourceWord) return commandError('invalid-selection', 'Corrected source word does not exist.', [input.wordId]);
    if (input.text !== null && typeof input.text !== 'string') {
        return commandError('invalid-selection', 'Correction text must be a string or reset.', [input.wordId]);
    }
    const normalized = input.text?.trim() ?? null;
    if (input.text !== null && normalized === '') {
        // Empty typing is never interpreted as structural deletion. The caller must dispatch the
        // explicit range-delete command when media should be removed.
        return commandError('invalid-selection', 'Correction text cannot be empty.', [input.wordId]);
    }
    const nextOverride = normalized === null || normalized === sourceWord.text
        ? undefined
        : normalized;
    if (block.wordTextOverrides[input.wordId] === nextOverride) return noop('unchanged');
    const wordTextOverrides = { ...block.wordTextOverrides };
    if (nextOverride === undefined) delete wordTextOverrides[input.wordId];
    else wordTextOverrides[input.wordId] = nextOverride;
    const changed = {
        ...block,
        wordTextOverrides,
        revision: context.nextNarrativeRevision,
    };
    const blocks = { ...context.narrative.blocks, [block.id]: changed };
    const narrative = reviseNarrative(context, { blocks }, input.nowIso);
    return finalizePlan({
        command: nextOverride === undefined ? 'reset-word-correction' : 'correct-word-text',
        label: nextOverride === undefined ? 'Reset word correction' : 'Correct word text',
        before: input.document,
        narrative,
        videoClips: input.document.videoClips,
        selection: selectionForWord(changed, input.wordId),
        audioGraph: false,
        anchorTransforms: [],
        playhead: { kind: 'keep', reason: 'non-structural' },
    });
}

/** Reassigns display grouping to another immutable speaker identity, or resets the override. */
export function planSetNarrativeWordSpeaker(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    bodies: ResolvedEditorialTranscriptMapV1;
    blockId: string;
    wordId: string;
    speakerId: string | null;
    nowIso: string;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    const block = context.narrative.blocks[input.blockId];
    if (!block) return commandError('missing-block', 'Speaker block does not exist.', [input.blockId]);
    if (block.kind !== 'speech' || !block.sourceWordIds.includes(input.wordId)) {
        return commandError('invalid-selection', 'Speaker assignment requires a retained word occurrence.', [input.wordId]);
    }
    let body;
    try {
        body = requireHydratedTranscriptBody(input.bodies, block.transcriptRecordId);
    } catch {
        return commandError('missing-transcript', 'Speaker transcript body is not hydrated.', [block.transcriptRecordId]);
    }
    const sourceWord = body.words.find(word => word.id === input.wordId);
    if (!sourceWord) return commandError('invalid-selection', 'Speaker source word does not exist.', [input.wordId]);
    if (input.speakerId !== null && !body.speakers.some(speaker => speaker.id === input.speakerId)) {
        return commandError('invalid-selection', 'Speaker assignment must reference source speaker evidence.', [input.speakerId]);
    }
    const nextOverride = input.speakerId === null || input.speakerId === sourceWord.speakerId
        ? undefined
        : input.speakerId;
    if (block.speakerOverrides[input.wordId] === nextOverride) return noop('unchanged');
    const speakerOverrides = { ...block.speakerOverrides };
    if (nextOverride === undefined) delete speakerOverrides[input.wordId];
    else speakerOverrides[input.wordId] = nextOverride;
    const changed = {
        ...block,
        speakerOverrides,
        revision: context.nextNarrativeRevision,
    };
    const blocks = { ...context.narrative.blocks, [block.id]: changed };
    const narrative = reviseNarrative(context, { blocks }, input.nowIso);
    return finalizePlan({
        command: nextOverride === undefined ? 'reset-word-speaker' : 'assign-word-speaker',
        label: nextOverride === undefined ? 'Reset word speaker' : 'Assign word speaker',
        before: input.document,
        narrative,
        videoClips: input.document.videoClips,
        selection: selectionForWord(changed, input.wordId),
        audioGraph: false,
        anchorTransforms: [],
        playhead: { kind: 'keep', reason: 'non-structural' },
    });
}

/** Show/hide is durable presentation state and never regenerates or rematerializes media. */
export function planSetNarrativeSpeakerVisibility(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    showSpeakers: boolean;
    nowIso: string;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    if (typeof input.showSpeakers !== 'boolean') {
        return commandError('invalid-selection', 'Speaker visibility must be boolean.', []);
    }
    if (context.narrative.settings.showSpeakers === input.showSpeakers) return noop('unchanged');
    const settings = { ...context.narrative.settings, showSpeakers: input.showSpeakers };
    const narrative = reviseNarrative(context, { settings }, input.nowIso);
    return finalizePlan({
        command: input.showSpeakers ? 'show-narrative-speakers' : 'hide-narrative-speakers',
        label: input.showSpeakers ? 'Show speakers' : 'Hide speakers',
        before: input.document,
        narrative,
        videoClips: input.document.videoClips,
        selection: repairSelection(input.document.transientSelection, narrative),
        audioGraph: false,
        anchorTransforms: [],
        playhead: { kind: 'keep', reason: 'non-structural' },
    });
}

export function planChangeBlockMargin(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    blockId: string;
    side: 'pre' | 'post';
    policy: MarginBoundaryPolicyV1;
    nowIso: string;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    const block = context.narrative.blocks[input.blockId];
    if (!block) return commandError('missing-block', 'Margin block does not exist.', [input.blockId]);
    if (!validBoundaryPolicy(input.policy)) return commandError('source-bounds', 'Margin policy is invalid.', [block.id]);
    const current = input.side === 'pre' ? block.materialization.preBoundary : block.materialization.postBoundary;
    if (JSON.stringify(current) === JSON.stringify(input.policy)) return noop('unchanged');
    const source = input.document.videoSources.find(value => value.id === block.sourceId);
    const descriptor = findTranscriptDescriptor(
        input.document,
        block.transcriptRecordId,
        block.sourceId,
    );
    const clip = input.document.videoClips.find(value => value.id === block.clipId);
    if (!source) return commandError('missing-source', 'Margin source does not exist.', [block.sourceId]);
    if (!descriptor) return commandError('missing-transcript', 'Margin descriptor does not exist.', [block.transcriptRecordId]);
    if (!clip) return commandError('missing-clip', 'Margin clip does not exist.', [block.clipId]);
    const changed = {
        ...block,
        materialization: {
            ...block.materialization,
            [input.side === 'pre' ? 'preBoundary' : 'postBoundary']: cloneBoundary(input.policy),
        },
        revision: context.nextNarrativeRevision,
    };
    const rematerialized = rematerializeNarrativeBlock({
        block: changed,
        settings: context.narrative.settings,
        source,
        sampleCount: descriptor.sampleCount,
    });
    if (rematerialized.kind === 'error') return commandError(materializerCode(rematerialized.code), rematerialized.message, [block.id]);
    changed.materialization = rematerialized.value;
    return planSingleBlockDurationChange({
        context,
        block,
        changed,
        clip,
        source,
        nowIso: input.nowIso,
        command: 'change-block-margins',
        label: 'Change block margins',
    });
}

export function planChangeGlobalMargins(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    preSamples: number;
    postSamples: number;
    nowIso: string;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    if (!isNonNegativeSafeInteger(input.preSamples) || !isNonNegativeSafeInteger(input.postSamples)) {
        return commandError('source-bounds', 'Global margins must be safe non-negative samples.', []);
    }
    if (context.narrative.settings.globalPreMarginSamples === input.preSamples
        && context.narrative.settings.globalPostMarginSamples === input.postSamples) return noop('unchanged');
    const settings = {
        ...context.narrative.settings,
        globalPreMarginSamples: input.preSamples,
        globalPostMarginSamples: input.postSamples,
    };
    const blocks = cloneBlockMap(context.narrative.blocks);
    const clipsById = new Map(input.document.videoClips.map(clip => [clip.id, { ...clip }]));
    let cumulativeDelta = 0;
    for (const blockId of context.narrative.blockIds) {
        const old = context.narrative.blocks[blockId];
        const source = input.document.videoSources.find(value => value.id === old.sourceId);
        const descriptor = findTranscriptDescriptor(
            input.document,
            old.transcriptRecordId,
            old.sourceId,
        );
        const clip = clipsById.get(old.clipId);
        if (!source || !descriptor || !clip) return commandError('invalid-proposal', 'Global margin dependency is missing.', [blockId]);
        const rematerialized = rematerializeNarrativeBlock({ block: old, settings, source, sampleCount: descriptor.sampleCount });
        if (rematerialized.kind === 'error') return commandError(materializerCode(rematerialized.code), rematerialized.message, [blockId]);
        const crop = materializationToSourceCrop(rematerialized.value, source);
        let changedClip = { ...clip, ...crop };
        const oldDuration = getVideoClipDurationFramesV4(clip, input.document.renderProfile);
        const newDuration = getVideoClipDurationFramesV4(changedClip, input.document.renderProfile);
        changedClip = {
            ...changedClip,
            audio: clampVideoClipAudioSettings(changedClip.audio, newDuration),
        };
        const timelineStartFrame = input.document.globalEditingMode === 'ripple'
            ? old.timelineStartFrame + cumulativeDelta
            : old.timelineStartFrame;
        blocks[blockId] = {
            ...old,
            materialization: rematerialized.value,
            timelineStartFrame,
            revision: context.nextNarrativeRevision,
        };
        clipsById.set(old.clipId, { ...changedClip, timelineStartFrame });
        if (input.document.globalEditingMode === 'ripple') cumulativeDelta += newDuration - oldDuration;
    }
    const changedTracks = context.narrative.blockIds
        .filter(id => blocks[id].timelineStartFrame !== context.narrative.blocks[id].timelineStartFrame
            || blocks[id].materialization.sourceStartFrame !== context.narrative.blocks[id].materialization.sourceStartFrame
            || blocks[id].materialization.sourceEndFrame !== context.narrative.blocks[id].materialization.sourceEndFrame)
        .map(id => blocks[id].trackId);
    const locked = preflightLockedTracks(input.document, changedTracks);
    if (locked) return locked;
    const narrative = reviseNarrative(context, { blocks, settings }, input.nowIso);
    const anchorTransforms: NarrativeAnchorTransform[] = [];
    for (const blockId of context.narrative.blockIds) {
        const oldBlock = context.narrative.blocks[blockId];
        const changedBlock = blocks[blockId];
        const materializationChanged = oldBlock.materialization.sourceStartFrame
            !== changedBlock.materialization.sourceStartFrame
            || oldBlock.materialization.sourceEndFrame !== changedBlock.materialization.sourceEndFrame;
        if (materializationChanged) {
            // A rematerialized occurrence is a geometric trim/expansion even when its semantic
            // core is unchanged. WP5 can derive the exact active-fragment and follower delta from
            // the old/new projections without treating it as a pure timeline translation.
            anchorTransforms.push({
                kind: 'trimmed',
                oldBlockId: blockId,
                newBlockIds: [blockId],
                retainedRanges: [{ start: changedBlock.coreStartSample, end: changedBlock.coreEndSample }],
            });
        } else if (oldBlock.timelineStartFrame !== changedBlock.timelineStartFrame) {
            anchorTransforms.push({
                kind: 'translated',
                blockId,
                deltaFrames: changedBlock.timelineStartFrame - oldBlock.timelineStartFrame,
            });
        }
    }
    return finalizePlan({
        command: 'change-global-text-margins',
        label: 'Change global text margins',
        before: input.document,
        narrative,
        videoClips: input.document.videoClips.map(clip => clipsById.get(clip.id) ?? clip),
        selection: repairSelection(input.document.transientSelection, narrative),
        audioGraph: true,
        anchorTransforms,
        playhead: { kind: 'keep', reason: 'non-structural' },
    });
}

export function planRefineNarrativeBoundary(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    bodies: ResolvedEditorialTranscriptMapV1;
    blockId: string;
    side: 'start' | 'end';
    chosenSample: number;
    algorithmVersion: number;
    origin: NarrativeBoundaryRefinementOriginV1;
    idFactory: NarrativeIdFactory;
    nowIso: string;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    if (!Number.isSafeInteger(input.algorithmVersion) || input.algorithmVersion <= 0) {
        return commandError('source-bounds', 'Boundary refinement algorithm version must be positive.', []);
    }
    const block = context.narrative.blocks[input.blockId];
    if (!block) return commandError('missing-block', 'Refinement block does not exist.', [input.blockId]);
    const originalSample = input.side === 'start' ? block.coreStartSample : block.coreEndSample;
    const result = planExtendNarrativeBlock({
        ...input,
        newStartSample: input.side === 'start' ? input.chosenSample : block.coreStartSample,
        newEndSample: input.side === 'end' ? input.chosenSample : block.coreEndSample,
        historyLabel: 'Refine text boundary',
        command: 'refine-text-boundary',
    });
    if (result.kind !== 'success') return result;
    const refined = result.document.narrative!.blocks[input.blockId];
    const refinement = {
        originalSample,
        chosenSample: input.chosenSample,
        algorithmVersion: input.algorithmVersion,
        origin: input.origin,
    };
    result.document.narrative!.blocks[input.blockId] = input.side === 'start'
        ? { ...refined, startBoundaryRefinement: refinement }
        : { ...refined, endBoundaryRefinement: refinement };
    result.forward.narrative = result.document.narrative;
    return result;
}

export function planDeleteAllSilences(input: {
    document: EditorDocumentV4;
    guard: NarrativeCommandGuard;
    scope?: { kind: 'document' } | { kind: 'track'; trackId: string };
    nowIso: string;
    currentPlayheadFrame?: number;
}): NarrativeCommandResult {
    const context = preflightNarrative(input.document, input.guard, input.nowIso);
    if ('kind' in context) return context;
    const scope = input.scope ?? { kind: 'document' as const };
    if (scope.kind === 'track' && !context.narrative.controlledTrackIds.includes(scope.trackId)) {
        return commandError('invalid-selection', 'Silence scope track is not controlled.', [scope.trackId]);
    }
    const deletedIds = context.narrative.blockIds.filter(blockId => {
        const block = context.narrative.blocks[blockId];
        return block.kind === 'silence' && (scope.kind === 'document' || block.trackId === scope.trackId);
    });
    if (deletedIds.length === 0) return noop('no-eligible-silence');
    const deleted = new Set(deletedIds);
    const tracksThatMove = input.document.globalEditingMode === 'ripple'
        ? context.narrative.blockIds.slice(context.narrative.blockIds.indexOf(deletedIds[0]))
            .map(id => context.narrative.blocks[id].trackId)
        : deletedIds.map(id => context.narrative.blocks[id].trackId);
    const locked = preflightLockedTracks(input.document, tracksThatMove);
    if (locked) return locked;
    const blocks = cloneBlockMap(context.narrative.blocks);
    const clipsById = new Map(input.document.videoClips.map(clip => [clip.id, clip]));
    let removedDuration = 0;
    for (const blockId of context.narrative.blockIds) {
        const block = blocks[blockId];
        const clip = clipsById.get(block.clipId)!;
        if (deleted.has(blockId)) {
            removedDuration += getVideoClipDurationFramesV4(clip, input.document.renderProfile);
            delete blocks[blockId];
        } else if (input.document.globalEditingMode === 'ripple' && removedDuration > 0) {
            blocks[blockId] = {
                ...block,
                timelineStartFrame: block.timelineStartFrame - removedDuration,
                revision: context.nextNarrativeRevision,
            };
        }
    }
    const blockIds = context.narrative.blockIds.filter(id => !deleted.has(id));
    const deletedClipIds = new Set(deletedIds.map(id => context.narrative.blocks[id].clipId));
    const videoClips = input.document.videoClips
        .filter(clip => !deletedClipIds.has(clip.id))
        .map(clip => {
            const block = Object.values(blocks).find(value => value.clipId === clip.id);
            return block ? { ...clip, timelineStartFrame: block.timelineStartFrame } : clip;
        });
    const narrative = reviseNarrative(context, { blocks, blockIds }, input.nowIso);
    const firstDeletedIndex = Math.min(...deletedIds.map(id => context.narrative.blockIds.indexOf(id)));
    const preferred = blockIds[firstDeletedIndex] ?? blockIds[firstDeletedIndex - 1];
    const selection = preferred ? selectionForBlock(blocks[preferred]) : { kind: 'none' as const };
    const deletionStart = Math.min(...deletedIds.map(id => context.narrative.blocks[id].timelineStartFrame));
    const result = finalizePlan({
        command: 'delete-all-silences',
        label: 'Delete all silences',
        before: input.document,
        narrative,
        videoClips,
        selection,
        audioGraph: true,
        anchorTransforms: [
            ...deletedIds.map(blockId => ({ kind: 'deleted' as const, blockId })),
            ...translatedBlockTransforms(
                context.narrative.blocks,
                blocks,
                blockIds,
            ),
        ],
        playhead: input.document.globalEditingMode === 'ripple'
            ? { kind: 'seek', frame: deletionStart, reason: 'deletion-start' }
            : { kind: 'keep', reason: 'absolute-gap' },
    });
    if (result.kind === 'success') {
        result.silenceDeletionReport = {
            scope: scope.kind === 'document' ? 'document' : { trackId: scope.trackId },
            count: deletedIds.length,
            durationFrames: removedDuration,
            consequence: input.document.globalEditingMode,
        };
    }
    return result;
}

/** Switching the single global mode is a history mutation but never moves media. */
export function planChangeGlobalEditingMode(input: {
    document: EditorDocumentV4;
    expectedDocumentRevision: number;
    mode: GlobalEditingMode;
}): NarrativeCommandResult {
    if (input.document.revision !== input.expectedDocumentRevision) {
        return commandError('stale-document', 'Document revision changed before mode switch.', []);
    }
    if (input.document.globalEditingMode === input.mode) return noop('unchanged');
    const after: EditorDocumentV4 = {
        ...input.document,
        revision: input.document.revision + 1,
        globalEditingMode: input.mode,
    };
    return successResult({
        command: input.mode === 'ripple' ? 'use-ripple-editing' : 'use-absolute-editing',
        label: input.mode === 'ripple' ? 'Use ripple editing' : 'Use absolute editing',
        before: input.document,
        after,
        audioGraph: false,
        anchorTransforms: [],
        playhead: { kind: 'keep', reason: 'non-structural' },
    });
}

/** Public project-level ordinary-mode entry point for WP6 media adapters. */
export function planOrdinaryProjectIntervals(input: {
    document: Pick<EditorDocumentV4, 'revision' | 'globalEditingMode'>;
    expectedDocumentRevision: number;
    expectedMode: GlobalEditingMode;
    items: readonly TrackIntervalItem[];
    action: OrdinaryIntervalAction;
    lockedTrackIds?: readonly string[];
    overlapAllowedTrackIds?: readonly string[];
}): OrdinaryIntervalPlanResult | { kind: 'error'; code: 'stale-document' | 'stale-mode'; itemIds: string[] } {
    if (input.document.revision !== input.expectedDocumentRevision) {
        return { kind: 'error', code: 'stale-document', itemIds: [] };
    }
    if (input.document.globalEditingMode !== input.expectedMode) {
        return { kind: 'error', code: 'stale-mode', itemIds: [] };
    }
    return planOrdinaryTrackIntervals({
        mode: input.expectedMode,
        items: input.items,
        action: input.action,
        lockedTrackIds: input.lockedTrackIds,
        overlapAllowedTrackIds: input.overlapAllowedTrackIds,
    });
}

function planRangeRemoval(input: {
    context: CommandContext;
    bodies: Map<string, ReturnType<typeof requireHydratedTranscriptBody>>;
    selection: NarrativeRangeSelection;
    startIndex: number;
    endIndex: number;
    idFactory: NarrativeIdFactory;
    nowIso: string;
    command: string;
    label: string;
    currentPlayheadFrame?: number;
}): NarrativeCommandResult {
    const { context } = input;
    const allocate = createIdAllocator(context.document, input.idFactory);
    const blocks = cloneBlockMap(context.narrative.blocks);
    const clipById = new Map(context.document.videoClips.map(clip => [clip.id, clip]));
    const replacementsByBlockId = new Map<string, Array<{ block: NarrativeBlockV1; clip: VideoClipV4 }>>();
    const removedDurations = new Map<string, number>();
    const transforms: NarrativeAnchorTransform[] = [];
    for (let index = input.startIndex; index <= input.endIndex; index += 1) {
        const blockId = context.narrative.blockIds[index];
        const block = context.narrative.blocks[blockId];
        const clip = clipById.get(block.clipId)!;
        const source = context.document.videoSources.find(value => value.id === block.sourceId)!;
        const retain: HalfOpenInterval[] = [];
        if (index === input.startIndex && input.selection.start.sample > block.coreStartSample) {
            retain.push({ start: block.coreStartSample, end: input.selection.start.sample });
        }
        if (index === input.endIndex && input.selection.end.sample < block.coreEndSample) {
            retain.push({ start: input.selection.end.sample, end: block.coreEndSample });
        }
        const occurrences: Array<{ block: NarrativeBlockV1; clip: VideoClipV4 }> = [];
        for (let retainIndex = 0; retainIndex < retain.length; retainIndex += 1) {
            const range = retain[retainIndex];
            const blockIdForSlice = retainIndex === 0 ? block.id : allocate('block');
            const clipId = retainIndex === 0 ? clip.id : allocate('clip');
            const sliced = sliceNarrativeOccurrence({
                original: block,
                clip,
                body: input.bodies.get(block.id)!,
                source,
                projectFps: context.document.renderProfile.fps,
                coreRange: range,
                timelineStartFrame: 0,
                revision: context.nextNarrativeRevision,
                ids: {
                    blockId: blockIdForSlice,
                    clipId,
                    instanceId: allocate('instance'),
                    sourceIntervalId: allocate('source-interval'),
                },
                audioBoundaryMode: retain.length > 1 ? 'partition' : 'trim',
            });
            if (sliced.kind === 'error') return commandError(materializerCode(sliced.code), sliced.message, [block.id]);
            occurrences.push(sliced.value);
        }
        const oldDuration = getVideoClipDurationFramesV4(clip, context.document.renderProfile);
        const retainedDuration = occurrences.reduce(
            (sum, occurrence) => sum + getVideoClipDurationFramesV4(occurrence.clip, context.document.renderProfile),
            0,
        );
        const removedDuration = oldDuration - retainedDuration;
        if (removedDuration <= 0) {
            return commandError(
                'minimum-duration',
                'Selected source range does not remove a representable output frame.',
                [block.id],
            );
        }
        removedDurations.set(block.id, removedDuration);
        replacementsByBlockId.set(block.id, occurrences);
        transforms.push(occurrences.length === 0
            ? { kind: 'deleted', blockId: block.id }
            : {
                kind: 'trimmed',
                oldBlockId: block.id,
                newBlockIds: occurrences.map(value => value.block.id),
                retainedRanges: retain,
            });
    }

    const newBlockIds: string[] = [];
    let cumulativeRemoved = 0;
    for (const blockId of context.narrative.blockIds) {
        const oldBlock = context.narrative.blocks[blockId];
        const replacements = replacementsByBlockId.get(blockId);
        if (!replacements) {
            if (context.document.globalEditingMode === 'ripple' && cumulativeRemoved > 0) {
                blocks[blockId] = {
                    ...blocks[blockId],
                    timelineStartFrame: blocks[blockId].timelineStartFrame - cumulativeRemoved,
                    revision: context.nextNarrativeRevision,
                };
            }
            newBlockIds.push(blockId);
            continue;
        }
        delete blocks[blockId];
        let projectCursor = oldBlock.timelineStartFrame - (context.document.globalEditingMode === 'ripple' ? cumulativeRemoved : 0);
        const oldClip = clipById.get(oldBlock.clipId)!;
        const oldEnd = oldBlock.timelineStartFrame
            + getVideoClipDurationFramesV4(oldClip, context.document.renderProfile);
        replacements.forEach((occurrence, replacementIndex) => {
            const duration = getVideoClipDurationFramesV4(occurrence.clip, context.document.renderProfile);
            const start = context.document.globalEditingMode === 'ripple'
                ? projectCursor
                : replacementIndex === replacements.length - 1
                    && occurrence.block.coreEndSample === oldBlock.coreEndSample
                    ? oldEnd - duration
                    : oldBlock.timelineStartFrame;
            occurrence.block = { ...occurrence.block, timelineStartFrame: start };
            occurrence.clip = { ...occurrence.clip, timelineStartFrame: start };
            projectCursor += duration;
            blocks[occurrence.block.id] = occurrence.block;
            newBlockIds.push(occurrence.block.id);
        });
        cumulativeRemoved += removedDurations.get(blockId)!;
    }
    const replacedOldClipIds = new Set(replacementsByBlockId.keys().map(blockId => context.narrative.blocks[blockId].clipId));
    const videoClips = context.document.videoClips.flatMap(clip => {
        if (replacedOldClipIds.has(clip.id)) {
            const oldBlock = Object.values(context.narrative.blocks).find(block => block.clipId === clip.id)!;
            return replacementsByBlockId.get(oldBlock.id)!.map(value => value.clip);
        }
        const moved = Object.values(blocks).find(block => block.clipId === clip.id);
        return moved ? [{ ...clip, timelineStartFrame: moved.timelineStartFrame }] : [clip];
    });
    const narrative = reviseNarrative(context, { blocks, blockIds: newBlockIds }, input.nowIso);
    const unaffectedIds = context.narrative.blockIds
        .filter(blockId => !replacementsByBlockId.has(blockId));
    transforms.push(...translatedBlockTransforms(context.narrative.blocks, blocks, unaffectedIds));
    const preferredIndex = Math.min(input.startIndex, newBlockIds.length - 1);
    const preferred = preferredIndex >= 0 ? blocks[newBlockIds[preferredIndex]] : null;
    const selection = preferred ? selectionForBlock(preferred) : { kind: 'none' as const };
    const deletionStart = context.narrative.blocks[input.selection.start.blockId].timelineStartFrame;
    return finalizePlan({
        command: input.command,
        label: input.label,
        before: context.document,
        narrative,
        videoClips,
        selection,
        audioGraph: true,
        anchorTransforms: transforms,
        playhead: context.document.globalEditingMode === 'ripple'
            ? { kind: 'seek', frame: deletionStart, reason: 'deletion-start' }
            : { kind: 'keep', reason: 'absolute-gap' },
    });
}

function planSingleBlockDurationChange(input: {
    context: CommandContext;
    block: NarrativeBlockV1;
    changed: NarrativeBlockV1;
    clip: VideoClipV4;
    source: Pick<VideoSourceDescriptorV3, 'duration' | 'fps'>;
    nowIso: string;
    command: string;
    label: string;
}): NarrativeCommandResult {
    const crop = materializationToSourceCrop(input.changed.materialization, input.source);
    let changedClip = { ...input.clip, ...crop };
    const oldDuration = getVideoClipDurationFramesV4(input.clip, input.context.document.renderProfile);
    const newDuration = getVideoClipDurationFramesV4(changedClip, input.context.document.renderProfile);
    changedClip = {
        ...changedClip,
        audio: clampVideoClipAudioSettings(changedClip.audio, newDuration),
    };
    const blocks = cloneBlockMap(input.context.narrative.blocks);
    blocks[input.block.id] = input.changed;
    const index = input.context.narrative.blockIds.indexOf(input.block.id);
    if (input.context.document.globalEditingMode === 'ripple') {
        const delta = newDuration - oldDuration;
        input.context.narrative.blockIds.slice(index + 1).forEach(id => {
            blocks[id] = {
                ...blocks[id],
                timelineStartFrame: blocks[id].timelineStartFrame + delta,
                revision: input.context.nextNarrativeRevision,
            };
        });
    }
    const locked = preflightLockedTracks(
        input.context.document,
        input.context.document.globalEditingMode === 'ripple'
            ? input.context.narrative.blockIds.slice(index).map(id => blocks[id].trackId)
            : [input.block.trackId],
    );
    if (locked) return locked;
    const videoClips = input.context.document.videoClips.map(clip => {
        if (clip.id === changedClip.id) return changedClip;
        const moved = Object.values(blocks).find(block => block.clipId === clip.id);
        return moved ? { ...clip, timelineStartFrame: moved.timelineStartFrame } : clip;
    });
    const narrative = reviseNarrative(input.context, { blocks }, input.nowIso);
    const translatedIds = input.context.narrative.blockIds.filter(id => id !== input.block.id);
    return finalizePlan({
        command: input.command,
        label: input.label,
        before: input.context.document,
        narrative,
        videoClips,
        selection: selectionForBlock(input.changed),
        audioGraph: true,
        anchorTransforms: [
            {
                kind: 'trimmed',
                oldBlockId: input.block.id,
                newBlockIds: [input.changed.id],
                retainedRanges: [{ start: input.changed.coreStartSample, end: input.changed.coreEndSample }],
            },
            ...translatedBlockTransforms(input.context.narrative.blocks, blocks, translatedIds),
        ],
        playhead: { kind: 'seek', frame: input.changed.timelineStartFrame, reason: 'follow-selection' },
    });
}

function preflightGuard(
    document: EditorDocumentV4,
    guard: NarrativeCommandGuard,
    requireNarrative: boolean,
): NarrativeCommandResult | null {
    if (document.revision !== guard.expectedDocumentRevision) {
        return commandError('stale-document', 'Document revision changed before command planning.', []);
    }
    if (document.globalEditingMode !== guard.expectedMode) {
        return commandError('stale-mode', 'Global editing mode changed before command planning.', []);
    }
    if (requireNarrative && !document.narrative) {
        return commandError('missing-narrative', 'Text editing is not active.', []);
    }
    if (document.narrative && guard.expectedNarrativeRevision !== undefined
        && document.narrative.revision !== guard.expectedNarrativeRevision) {
        return commandError('stale-narrative', 'Narrative revision changed before command planning.', []);
    }
    return null;
}

function preflightNarrative(
    document: EditorDocumentV4,
    guard: NarrativeCommandGuard,
    nowIso: string,
): CommandContext | NarrativeCommandResult {
    const error = preflightGuard(document, guard, true);
    if (error) return error;
    if (!isValidIso(nowIso)) {
        return commandError('invalid-selection', 'Narrative command timestamp must be valid ISO time.', []);
    }
    const invariantError = validateOwnedProposal(document);
    if (invariantError) return invariantError;
    return {
        document,
        narrative: document.narrative!,
        nextDocumentRevision: document.revision + 1,
        nextNarrativeRevision: document.narrative!.revision + 1,
    };
}

function preflightLockedTracks(
    document: EditorDocumentV4,
    trackIds: readonly string[],
): NarrativeCommandResult | null {
    const requested = new Set(trackIds);
    const locked = document.videoTracks.filter(track => requested.has(track.id) && track.locked).map(track => track.id);
    return locked.length > 0
        ? commandError('locked-track', 'Command requires mutation on a locked track.', locked)
        : null;
}

function finalizePlan(input: {
    command: string;
    label: string;
    before: EditorDocumentV4;
    narrative: NarrativeDocumentV1 | null;
    videoClips: VideoClipV4[];
    selection: TransientMediaSelectionV4;
    audioGraph: boolean;
    anchorTransforms: NarrativeAnchorTransform[];
    playhead: NarrativePlayheadRecommendation;
}): NarrativeCommandResult {
    const after: EditorDocumentV4 = {
        ...input.before,
        revision: input.before.revision + 1,
        audioGraphRevision: input.audioGraph
            ? input.before.audioGraphRevision + 1
            : input.before.audioGraphRevision,
        narrative: input.narrative,
        videoClips: input.videoClips,
        transientSelection: input.selection,
    };
    const proposalError = validateOwnedProposal(after);
    if (proposalError) return proposalError;
    return successResult({
        command: input.command,
        label: input.label,
        before: input.before,
        after,
        audioGraph: input.audioGraph,
        anchorTransforms: input.anchorTransforms,
        playhead: input.playhead,
    });
}

function successResult(input: {
    command: string;
    label: string;
    before: EditorDocumentV4;
    after: EditorDocumentV4;
    audioGraph: boolean;
    anchorTransforms: NarrativeAnchorTransform[];
    playhead: NarrativePlayheadRecommendation;
}): NarrativeCommandSuccess {
    const beforeIds = new Set(input.before.narrative?.sourceRecordIds ?? []);
    const afterIds = new Set(input.after.narrative?.sourceRecordIds ?? []);
    return {
        kind: 'success',
        command: input.command,
        document: input.after,
        forward: projection(input.after),
        inverse: projection(input.before),
        history: { createEntry: true, label: input.label, mergeKey: null },
        persistence: { enqueue: true },
        impact: { content: true, audioGraph: input.audioGraph },
        pinDelta: {
            addRecordIds: Array.from(afterIds).filter(id => !beforeIds.has(id)),
            removeRecordIds: Array.from(beforeIds).filter(id => !afterIds.has(id)),
        },
        anchorTransforms: input.anchorTransforms,
        playhead: input.playhead,
    };
}

function validateOwnedProposal(
    document: EditorDocumentV4,
    options: { requireTranscriptDescriptors?: boolean } = {},
): { kind: 'error'; error: NarrativeCommandError } | null {
    const requireTranscriptDescriptors = options.requireTranscriptDescriptors ?? true;
    try {
        buildVideoTrackPlacementsV4(document);
    } catch {
        return commandError('collision', 'Planned video clips collide or have invalid bounds.', []);
    }
    const narrative = document.narrative;
    if (!narrative) return null;
    const clipById = new Map(document.videoClips.map(clip => [clip.id, clip]));
    const sourceById = new Map(document.videoSources.map(source => [source.id, source]));
    const trackIds = new Set(document.videoTracks.map(track => track.id));
    if (new Set(narrative.blockIds).size !== narrative.blockIds.length
        || Object.keys(narrative.blocks).length !== narrative.blockIds.length
        || Object.keys(narrative.blocks).some(id => !narrative.blockIds.includes(id))) {
        return commandError('invalid-proposal', 'Narrative block order and block map disagree.', []);
    }
    if (new Set(narrative.controlledTrackIds).size !== narrative.controlledTrackIds.length
        || narrative.controlledTrackIds.some(trackId => !trackIds.has(trackId))
        || new Set(narrative.sourceRecordIds).size !== narrative.sourceRecordIds.length) {
        return commandError('invalid-proposal', 'Narrative track or source catalogs are inconsistent.', []);
    }
    let previousEnd = 0;
    const instanceIds = new Set<string>();
    const sourceIntervalIds = new Set<string>();
    const ownedClipIds = new Set<string>();
    for (let index = 0; index < narrative.blockIds.length; index += 1) {
        const block = narrative.blocks[narrative.blockIds[index]];
        const clip = block ? clipById.get(block.clipId) : undefined;
        const source = block ? sourceById.get(block.sourceId) : undefined;
        const descriptor = block
            ? findTranscriptDescriptor(document, block.transcriptRecordId, block.sourceId)
            : undefined;
        const exactCrop = clip && source ? exactClipSourceFrameRange(clip, source) : null;
        const transcriptDescriptorInvalid = requireTranscriptDescriptors
            && (!block
                || !descriptor
                || block.coreEndSample > descriptor.sampleCount);
        if (!block || !clip
            || block.id !== narrative.blockIds[index]
            || clip.trackId !== block.trackId
            || clip.sourceId !== block.sourceId
            || clip.timelineStartFrame !== block.timelineStartFrame
            || !source
            || transcriptDescriptorInvalid
            || !narrative.sourceRecordIds.includes(block.transcriptRecordId)
            || !isNonNegativeSafeInteger(block.coreStartSample)
            || !Number.isSafeInteger(block.coreEndSample)
            || block.coreEndSample <= block.coreStartSample
            || !exactCrop
            || exactCrop.start !== block.materialization.sourceStartFrame
            || exactCrop.end !== block.materialization.sourceEndFrame
            || !validBoundaryPolicy(block.materialization.preBoundary)
            || !validBoundaryPolicy(block.materialization.postBoundary)
            || instanceIds.has(block.instanceId)
            || sourceIntervalIds.has(block.sourceIntervalId)
            || ownedClipIds.has(block.clipId)
            || !narrative.controlledTrackIds.includes(block.trackId)) {
            return commandError('invalid-proposal', 'Planned narrative ownership is inconsistent.', [narrative.blockIds[index]]);
        }
        instanceIds.add(block.instanceId);
        sourceIntervalIds.add(block.sourceIntervalId);
        ownedClipIds.add(block.clipId);
        const end = block.timelineStartFrame + getVideoClipDurationFramesV4(clip, document.renderProfile);
        if (index > 0 && block.timelineStartFrame < previousEnd) {
            return commandError('collision', 'Planned controlled blocks overlap globally.', [block.id]);
        }
        previousEnd = end;
    }
    return null;
}

function reviseNarrative(
    context: CommandContext,
    changes: Partial<Pick<
        NarrativeDocumentV1,
        'controlledTrackIds' | 'blocks' | 'blockIds' | 'sourceRecordIds' | 'settings'
    >>,
    nowIso: string,
): NarrativeDocumentV1 {
    return {
        ...context.narrative,
        ...changes,
        revision: context.nextNarrativeRevision,
        updatedAt: nowIso,
    };
}

function projection(document: EditorDocumentV4): NarrativePatchProjection {
    return {
        revision: document.revision,
        audioGraphRevision: document.audioGraphRevision,
        narrative: document.narrative,
        videoClips: document.videoClips,
        transientSelection: document.transientSelection,
        globalEditingMode: document.globalEditingMode,
    };
}

function noop(code: NarrativeCommandNoop['code']): NarrativeCommandNoop {
    return {
        kind: 'noop',
        code,
        history: { createEntry: false, label: null, mergeKey: null },
        persistence: { enqueue: false },
    };
}

function commandError(
    code: NarrativeCommandErrorCode,
    message: string,
    ids: readonly string[],
): { kind: 'error'; error: NarrativeCommandError } {
    return { kind: 'error', error: { code, message, ids: [...ids] } };
}

function selectionForBlock(block: NarrativeBlockV1): TransientMediaSelectionV4 {
    return {
        kind: 'narrative',
        trackId: block.trackId,
        blockId: block.id,
        sourceWordIds: [...block.sourceWordIds],
        boundary: null,
    };
}

function selectionForWord(block: NarrativeBlockV1, wordId: string): TransientMediaSelectionV4 {
    return {
        kind: 'narrative',
        trackId: block.trackId,
        blockId: block.id,
        sourceWordIds: [wordId],
        boundary: null,
    };
}

/** Repairs stable narrative selection without inventing a source-word occurrence. */
export function repairSelection(
    selection: TransientMediaSelectionV4,
    narrative: NarrativeDocumentV1,
    preferredBlockId?: string,
): TransientMediaSelectionV4 {
    if (selection.kind === 'narrative') {
        const block = narrative.blocks[selection.blockId];
        if (block) {
            const blockWordIds: readonly string[] = block.sourceWordIds;
            const retainedWords = selection.sourceWordIds.filter(id => blockWordIds.includes(id));
            return {
                kind: 'narrative',
                trackId: block.trackId,
                blockId: block.id,
                sourceWordIds: retainedWords,
                boundary: selection.boundary,
            };
        }
    } else if (selection.kind !== 'none') {
        return selection;
    }
    const preferred = preferredBlockId ? narrative.blocks[preferredBlockId] : undefined;
    const fallback = preferred ?? narrative.blocks[narrative.blockIds[0]];
    return fallback ? selectionForBlock(fallback) : { kind: 'none' };
}

function createIdAllocator(document: EditorDocumentV4, factory: NarrativeIdFactory): NarrativeIdFactory {
    const used = new Set<string>([
        ...(document.narrative ? [document.narrative.id] : []),
        ...document.videoTracks.map(track => track.id),
        ...document.videoClips.map(clip => clip.id),
        ...(document.narrative?.blockIds ?? []),
        ...Object.values(document.narrative?.blocks ?? {}).flatMap(block => [
            block.instanceId,
            block.lineageRootId,
            block.sourceIntervalId,
            ...(block.materialization.preBoundary.kind === 'partition-seam'
                ? [block.materialization.preBoundary.seamId]
                : []),
            ...(block.materialization.postBoundary.kind === 'partition-seam'
                ? [block.materialization.postBoundary.seamId]
                : []),
        ]),
    ]);
    return (kind) => {
        const id = factory(kind);
        if (!isSafeEditorId(id) || used.has(id)) {
            throw new Error(`Injected ${kind} ID is unsafe or already used.`);
        }
        used.add(id);
        return id;
    };
}

export function exactClipSourceFrameRange(
    clip: VideoClipV4,
    source: Pick<VideoSourceDescriptorV3, 'duration' | 'fps'>,
): HalfOpenInterval | null {
    if (!Number.isFinite(source.duration) || source.duration <= 0
        || !Number.isFinite(source.fps) || source.fps <= 0
        || !Number.isFinite(clip.sourceStart) || clip.sourceStart < 0
        || !Number.isFinite(clip.sourceEnd) || clip.sourceEnd <= clip.sourceStart) return null;
    const tolerance = Math.max(NUMBER_EPSILON, 1 / source.fps * 1e-7);
    if (clip.sourceEnd > source.duration + tolerance) return null;
    let sourceTail: number;
    try {
        sourceTail = getDeterministicSourceEndFrame(source);
    } catch {
        return null;
    }
    const start = Math.round(clip.sourceStart * source.fps);
    // The final native frame may be partial. Its durable crop is clamped to source.duration, so
    // an exact tail crop must invert to the deterministic ceil frame rather than Math.round.
    const end = Math.abs(clip.sourceEnd - source.duration) <= tolerance
        ? sourceTail
        : Math.round(clip.sourceEnd * source.fps);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end <= start || end > sourceTail) return null;
    if (Math.abs(clip.sourceStart - start / source.fps) > tolerance
        || Math.abs(clip.sourceEnd - Math.min(source.duration, end / source.fps)) > tolerance
    ) return null;
    return { start, end };
}

function sortBlockIdsByProjectTime(
    blockIds: readonly string[],
    blocks: Record<string, NarrativeBlockV1>,
    videoClips: readonly VideoClipV4[],
    document: Pick<EditorDocumentV4, 'renderProfile' | 'videoTracks'>,
): string[] {
    const clips = new Map(videoClips.map(clip => [clip.id, clip]));
    const trackOrder = new Map(document.videoTracks.map((track, index) => [track.id, index]));
    return [...blockIds].sort((leftId, rightId) => {
        const left = blocks[leftId];
        const right = blocks[rightId];
        const leftClip = clips.get(left.clipId)!;
        const rightClip = clips.get(right.clipId)!;
        const leftEnd = left.timelineStartFrame + getVideoClipDurationFramesV4(leftClip, document.renderProfile);
        const rightEnd = right.timelineStartFrame + getVideoClipDurationFramesV4(rightClip, document.renderProfile);
        return left.timelineStartFrame - right.timelineStartFrame
            || leftEnd - rightEnd
            || (trackOrder.get(left.trackId) ?? 0) - (trackOrder.get(right.trackId) ?? 0)
            || compareIds(left.id, right.id);
    });
}

function getOrderedBlockIntervals(
    narrative: NarrativeDocumentV1,
    videoClips: readonly VideoClipV4[],
    document: Pick<EditorDocumentV4, 'renderProfile'>,
): Array<HalfOpenInterval & { id: string }> {
    const clips = new Map(videoClips.map(clip => [clip.id, clip]));
    return narrative.blockIds.map(id => {
        const block = narrative.blocks[id];
        const clip = clips.get(block.clipId)!;
        return {
            id,
            start: block.timelineStartFrame,
            end: block.timelineStartFrame + getVideoClipDurationFramesV4(clip, document.renderProfile),
        };
    });
}

function contentEndFrame(
    narrative: NarrativeDocumentV1,
    clips: readonly VideoClipV4[],
    document: Pick<EditorDocumentV4, 'renderProfile'>,
): number {
    return getOrderedBlockIntervals(narrative, clips, document).at(-1)?.end ?? 0;
}

function cloneBlockMap(blocks: Record<string, NarrativeBlockV1>): Record<string, NarrativeBlockV1> {
    return Object.fromEntries(Object.entries(blocks).map(([id, block]) => {
        const common: NarrativeBlockCommonV1 = {
            id: block.id,
            instanceId: block.instanceId,
            lineageRootId: block.lineageRootId,
            parentInstanceIds: [...block.parentInstanceIds],
            clipId: block.clipId,
            trackId: block.trackId,
            sourceId: block.sourceId,
            transcriptRecordId: block.transcriptRecordId,
            sourceIntervalId: block.sourceIntervalId,
            coreStartSample: block.coreStartSample,
            coreEndSample: block.coreEndSample,
            materialization: {
                ...block.materialization,
                preBoundary: cloneBoundary(block.materialization.preBoundary),
                postBoundary: cloneBoundary(block.materialization.postBoundary),
            },
            timelineStartFrame: block.timelineStartFrame,
            startBoundaryRefinement: block.startBoundaryRefinement
                ? { ...block.startBoundaryRefinement }
                : null,
            endBoundaryRefinement: block.endBoundaryRefinement
                ? { ...block.endBoundaryRefinement }
                : null,
            revision: block.revision,
        };
        const clone: NarrativeBlockV1 = block.kind === 'speech'
            ? {
                ...common,
                kind: 'speech',
                sourceWordIds: [...block.sourceWordIds],
                wordTextOverrides: { ...block.wordTextOverrides },
                speakerOverrides: { ...block.speakerOverrides },
            }
            : {
                ...common,
                kind: 'silence',
                sourceWordIds: [],
                evidence: block.evidence,
            };
        return [id, clone];
    }));
}

/** Emits pure translations only for surviving blocks whose source geometry stayed unchanged. */
function translatedBlockTransforms(
    before: Readonly<Record<string, NarrativeBlockV1>>,
    after: Readonly<Record<string, NarrativeBlockV1>>,
    blockIds: readonly string[],
): NarrativeAnchorTransform[] {
    return blockIds.flatMap(blockId => {
        const oldBlock = before[blockId];
        const changedBlock = after[blockId];
        if (!oldBlock || !changedBlock || oldBlock.timelineStartFrame === changedBlock.timelineStartFrame) return [];
        return [{
            kind: 'translated' as const,
            blockId,
            deltaFrames: changedBlock.timelineStartFrame - oldBlock.timelineStartFrame,
        }];
    });
}

function cloneBoundary(boundary: MaterializedBoundaryPolicyV1): MaterializedBoundaryPolicyV1 {
    return boundary.kind === 'partition-seam'
        ? { kind: 'partition-seam', seamId: boundary.seamId }
        : { kind: 'margin', mode: boundary.mode, requestedSamples: boundary.requestedSamples };
}

function validBoundaryPolicy(policy: MaterializedBoundaryPolicyV1): boolean {
    return policy.kind === 'partition-seam'
        ? isSafeEditorId(policy.seamId)
        : policy.mode === 'inherit-global'
            ? policy.requestedSamples === null
            : isNonNegativeSafeInteger(policy.requestedSamples);
}

function isWordBoundary(
    body: ReturnType<typeof requireHydratedTranscriptBody>,
    sample: number,
): boolean {
    return Number.isSafeInteger(sample)
        && sample >= 0
        && sample <= body.sampleCount
        && !body.words.some(word => word.editableStartSample < sample && sample < word.editableEndSample);
}

function materializerCode(code: string): NarrativeCommandErrorCode {
    if (code === 'minimum-duration') return 'minimum-duration';
    if (code === 'incompatible-merge') return 'incompatible-merge';
    if (code === 'word-boundary') return 'invalid-selection';
    return 'source-bounds';
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isValidIso(value: string): boolean {
    return value.length > 0 && !Number.isNaN(Date.parse(value));
}

function findTranscriptDescriptor(
    document: EditorDocumentV4,
    recordId: Sha256Digest,
    sourceId: string,
) {
    return document.editorialTranscriptDescriptors.find(descriptor =>
        descriptor.recordId === recordId && descriptor.sourceId === sourceId);
}

function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

const NUMBER_EPSILON = 1e-9;
