import {
    clampSampleFades,
    cloneAudioTracks,
    findAudioClip,
    getAudioClipOutputInterval,
    splitAudioClipInTracks,
    trimAudioClipInTracks,
} from '@/lib/audio-timeline';
import {
    frameToOutputSample,
    nativeBoundaryToOutputSample,
    outputSampleToCoveringFrame,
    outputSampleToNearestNativeBoundary,
} from '@/lib/audio-timebase';
import {
    exactClipSourceFrameRange,
    planOrdinaryProjectIntervals,
} from '@/lib/narrative/commands';
import { sourceFrameSpanToProjectFrames } from '@/lib/narrative/materializer';
import {
    getEditorialTargetInterval,
    getEditorialTargetKey,
    type EditorialDirectTargetTransform,
} from '@/lib/editorial-links';
import { framesToSeconds } from '@/lib/render-profile';
import {
    getVideoClipPlacementV4,
} from '@/lib/video-placement-v4';
import type { EditorialDependentTargetV1 } from '@/types/editorial';
import type { Subtitle, SubtitleTrackV4 } from '@/types/timeline';
import type {
    AudioClip,
    EditorDocumentV4,
    ImportedAudioClip,
    TransientMediaSelectionV4,
    VideoClipV4,
} from '@/types/video';
import type { TimelineOrdinaryCommand, TimelineCommandError } from './timeline-v4-command-types';

export interface TimelineOrdinaryPlanSuccess {
    kind: 'success';
    command: string;
    label: string;
    document: EditorDocumentV4;
    targetTransforms: EditorialDirectTargetTransform[];
    audioGraph: boolean;
    playhead: {
        kind: 'keep' | 'seek';
        frame?: number;
        reason: 'non-structural' | 'absolute-gap' | 'deletion-start' | 'follow-selection' | 'clamp';
    };
}

export type TimelineOrdinaryPlanResult = TimelineOrdinaryPlanSuccess
    | { kind: 'noop'; code: 'unchanged' }
    | { kind: 'error'; error: TimelineCommandError };

/**
 * Adapts all uncontrolled V4 target kinds to WP4's one global interval-mode matrix.
 *
 * The returned document deliberately carries the speculative next revision required by WP5. The
 * Timeline store discards that number and owns the sole durable revision finalization after link
 * transforms have been integrated.
 */
export function planTimelineOrdinaryV4Command(
    document: EditorDocumentV4,
    request: TimelineOrdinaryCommand,
): TimelineOrdinaryPlanResult {
    if (request.target.kind === 'video-clip') {
        return planVideoCommand(document, { ...request, target: request.target });
    }
    if (request.target.kind === 'audio-clip') {
        return planAudioCommand(document, { ...request, target: request.target });
    }
    return planSubtitleCommand(document, { ...request, target: request.target });
}

/**
 * Plans a multi-target UI gesture against one captured revision/mode and returns one proposal.
 * Intermediate speculative revisions are collapsed before WP5 sees the complete transform ledger.
 */
export function planTimelineOrdinaryV4BatchCommand(
    document: EditorDocumentV4,
    requests: readonly TimelineOrdinaryCommand[],
    options: {
        command: string;
        label: string;
        transientSelection?: TransientMediaSelectionV4;
        activeSubtitleTrackId?: string | null;
    },
): TimelineOrdinaryPlanResult {
    let current = document;
    const targetTransforms: EditorialDirectTargetTransform[] = [];
    let audioGraph = false;
    let playhead: TimelineOrdinaryPlanSuccess['playhead'] = {
        kind: 'keep',
        reason: 'non-structural',
    };
    let changed = false;
    for (const request of requests) {
        const planned = planTimelineOrdinaryV4Command(current, request);
        if (planned.kind === 'error') return planned;
        if (planned.kind === 'noop') continue;
        current = planned.document;
        targetTransforms.push(...planned.targetTransforms);
        audioGraph ||= planned.audioGraph;
        playhead = planned.playhead;
        changed = true;
    }
    if (!changed) return { kind: 'noop', code: 'unchanged' };
    return {
        kind: 'success',
        command: options.command,
        label: options.label,
        document: {
            ...current,
            revision: document.revision + 1,
            ...(Object.prototype.hasOwnProperty.call(options, 'activeSubtitleTrackId')
                ? { activeSubtitleTrackId: options.activeSubtitleTrackId ?? null }
                : {}),
            ...(options.transientSelection
                ? { transientSelection: structuredClone(options.transientSelection) }
                : {}),
        },
        targetTransforms,
        audioGraph,
        playhead,
    };
}

/** Maps the legacy left/right reorder buttons onto the canonical V4 move planner. */
export function planTimelineVideoReorderV4Command(
    document: EditorDocumentV4,
    orderedClipIds: readonly string[],
    selectedClipId: string | null,
): TimelineOrdinaryPlanResult {
    const currentIds = document.videoClips.map((clip) => clip.id);
    if (orderedClipIds.length !== currentIds.length
        || new Set(orderedClipIds).size !== currentIds.length
        || orderedClipIds.some((id) => !currentIds.includes(id))) {
        return error('invalid-reorder', 'Video reorder must be a complete unique permutation.', [...orderedClipIds]);
    }
    if (orderedClipIds.every((id, index) => id === currentIds[index])) {
        return { kind: 'noop', code: 'unchanged' };
    }
    const movedId = selectedClipId && currentIds.includes(selectedClipId)
        && orderedClipIds.indexOf(selectedClipId) !== currentIds.indexOf(selectedClipId)
        ? selectedClipId
        : orderedClipIds.find((id, index) => id !== currentIds[index]) ?? null;
    if (!movedId) return { kind: 'noop', code: 'unchanged' };
    const moved = document.videoClips.find((clip) => clip.id === movedId)!;
    if (Object.values(document.narrative?.blocks ?? {}).some((block) => block.clipId === moved.id)) {
        return error('owned-target', 'Narrative-owned video must use a text command.', [moved.id]);
    }
    const track = document.videoTracks.find((value) => value.id === moved.trackId);
    if (!track) return error('missing-target', 'Video reorder track is unavailable.', [moved.trackId]);
    if (track.locked) return error('locked-target', 'Ordinary video track is locked.', [track.id]);
    const currentTrackIds = currentIds.filter((id) => (
        document.videoClips.find((clip) => clip.id === id)?.trackId === moved.trackId
    ));
    const orderedTrackIds = orderedClipIds.filter((id) => (
        document.videoClips.find((clip) => clip.id === id)?.trackId === moved.trackId
    ));
    const oldIndex = currentTrackIds.indexOf(movedId);
    const nextIndex = orderedTrackIds.indexOf(movedId);
    const byCurrentId = new Map(document.videoClips.map((clip) => [clip.id, clip]));
    if (oldIndex === nextIndex) {
        return {
            kind: 'success',
            command: 'reorder-video-clip',
            label: 'Reorder video clips',
            document: withVideoSelection({
                ...document,
                revision: document.revision + 1,
                videoClips: orderedClipIds.map((id) => byCurrentId.get(id)!),
            }, moved.id),
            targetTransforms: [{ kind: 'moved', target: { kind: 'video-clip', clipId: moved.id } }],
            audioGraph: false,
            playhead: { kind: 'keep', reason: 'non-structural' },
        };
    }
    const movedPlacement = getVideoClipPlacementV4(document, moved);
    const movingLeft = nextIndex < oldIndex;
    const neighborId = movingLeft ? orderedTrackIds[nextIndex + 1] : orderedTrackIds[nextIndex - 1];
    const neighbor = document.videoClips.find((clip) => clip.id === neighborId);
    if (!neighbor) return error('invalid-reorder', 'Video reorder neighbor is unavailable.', [movedId]);
    const neighborPlacement = getVideoClipPlacementV4(document, neighbor);
    const duration = movedPlacement.endFrame - movedPlacement.startFrame;
    const targetStart = movingLeft
        ? neighborPlacement.startFrame
        : neighborPlacement.endFrame - (neighbor.trackId === moved.trackId ? duration : 0);
    const planned = planTimelineOrdinaryV4Command(document, {
        target: { kind: 'video-clip', clipId: moved.id },
        action: {
            kind: 'move',
            targetTrackId: moved.trackId,
            targetStart,
        },
    });
    if (planned.kind !== 'success') return planned;
    const byId = new Map(planned.document.videoClips.map((clip) => [clip.id, clip]));
    return {
        ...planned,
        command: 'reorder-video-clip',
        label: 'Reorder video clips',
        document: {
            ...planned.document,
            videoClips: orderedClipIds.map((id) => byId.get(id)!),
        },
    };
}

export interface TimelineSubtitleReplacementRequest {
    subtitleTracks: SubtitleTrackV4[];
    activeSubtitleTrackId: string | null;
    transientSelection: TransientMediaSelectionV4;
    label: string;
}

/**
 * Converts the legacy full-track subtitle callback into canonical target commands. The callback is
 * still used by list split/merge/delete and Timeline drag code, but it no longer owns a structural
 * mutation boundary or a hidden editing mode.
 */
export function planTimelineSubtitleReplacementV4Command(
    document: EditorDocumentV4,
    request: TimelineSubtitleReplacementRequest,
): TimelineOrdinaryPlanResult {
    const beforeTrackIds = document.subtitleTracks.map((track) => track.id);
    const requestedTrackIds = request.subtitleTracks.map((track) => track.id);
    if (beforeTrackIds.length !== requestedTrackIds.length
        || requestedTrackIds.some((id, index) => id !== beforeTrackIds[index])) {
        return error(
            'subtitle-track-catalog-changed',
            'Subtitle cue replacement cannot add, remove, or reorder tracks.',
            requestedTrackIds,
        );
    }
    const before = indexSubtitles(document.subtitleTracks);
    const desired = indexSubtitles(request.subtitleTracks);
    if (!before || !desired) {
        return error('duplicate-subtitle-id', 'Subtitle IDs must be unique across tracks.', []);
    }
    const deleted = Array.from(before.values()).filter((entry) => !desired.has(entry.subtitle.id));
    const added = Array.from(desired.values()).filter((entry) => !before.has(entry.subtitle.id));
    const structural = Array.from(before.values()).filter((entry) => {
        const next = desired.get(entry.subtitle.id);
        return next && !sameSubtitleInterval(entry, next);
    });

    const merge = detectRepresentationalSubtitleMerge(deleted, added, structural, desired);
    if (merge) {
        const track = document.subtitleTracks.find((value) => value.id === merge.trackId)!;
        if (track.isLocked) return error('locked-target', 'Subtitle track is locked.', [track.id]);
        const mergedDocument: EditorDocumentV4 = {
            ...document,
            revision: document.revision + 1,
            subtitleTracks: structuredClone(request.subtitleTracks),
            activeSubtitleTrackId: merge.trackId,
            transientSelection: {
                kind: 'subtitles',
                trackId: merge.trackId,
                subtitleIds: [merge.survivorId],
            },
        };
        return {
            kind: 'success',
            command: 'merge-subtitles',
            label: request.label,
            document: mergedDocument,
            targetTransforms: [{
                kind: 'trimmed',
                target: { kind: 'subtitle', trackId: merge.trackId, subtitleId: merge.survivorId },
            }, {
                kind: 'deleted',
                target: { kind: 'subtitle', trackId: merge.trackId, subtitleId: merge.deletedId },
            }],
            audioGraph: false,
            playhead: {
                kind: 'seek',
                frame: outputSampleToCoveringFrame(
                    secondsToOutputSample(desired.get(merge.survivorId)!.subtitle.startTime),
                    document.renderProfile.fps,
                ),
                reason: 'follow-selection',
            },
        };
    }

    const unsupportedCombinedMoveAndResize = structural.filter((entry) => {
        const next = desired.get(entry.subtitle.id)!;
        const beforeDuration = secondsToOutputSample(entry.subtitle.endTime)
            - secondsToOutputSample(entry.subtitle.startTime);
        const nextDuration = secondsToOutputSample(next.subtitle.endTime)
            - secondsToOutputSample(next.subtitle.startTime);
        return entry.trackId !== next.trackId && beforeDuration !== nextDuration;
    });
    if (unsupportedCombinedMoveAndResize.length > 0) {
        return error(
            'unsupported-subtitle-gesture',
            'A subtitle cannot change track and duration in the same ordinary gesture.',
            unsupportedCombinedMoveAndResize.map((entry) => entry.subtitle.id),
        );
    }

    const handledAdded = new Set<string>();
    const handledStructural = new Set<string>();
    const commands: TimelineOrdinaryCommand[] = [];
    added.sort(compareLocatedSubtitles).forEach((entry) => {
        const parent = structural.find((candidate) => isExactSubtitleSplit(candidate, entry, desired));
        if (!parent) return;
        commands.push({
            target: {
                kind: 'subtitle',
                trackId: parent.trackId,
                subtitleId: parent.subtitle.id,
            },
            action: {
                kind: 'split',
                at: secondsToOutputSample(entry.subtitle.startTime),
                childId: entry.subtitle.id,
            },
        });
        handledAdded.add(entry.subtitle.id);
        handledStructural.add(parent.subtitle.id);
    });
    deleted.sort(compareLocatedSubtitles).forEach((entry) => commands.push({
        target: { kind: 'subtitle', trackId: entry.trackId, subtitleId: entry.subtitle.id },
        action: { kind: 'delete' },
    }));
    structural
        .filter((entry) => !handledStructural.has(entry.subtitle.id))
        .sort((left, right) => compareLocatedSubtitles(desired.get(left.subtitle.id)!, desired.get(right.subtitle.id)!))
        .forEach((entry) => {
            const next = desired.get(entry.subtitle.id)!;
            const beforeDuration = secondsToOutputSample(entry.subtitle.endTime)
                - secondsToOutputSample(entry.subtitle.startTime);
            const nextDuration = secondsToOutputSample(next.subtitle.endTime)
                - secondsToOutputSample(next.subtitle.startTime);
            if (beforeDuration === nextDuration) {
                commands.push({
                    target: { kind: 'subtitle', trackId: entry.trackId, subtitleId: entry.subtitle.id },
                    action: {
                        kind: 'move',
                        targetTrackId: next.trackId,
                        targetStart: secondsToOutputSample(next.subtitle.startTime),
                    },
                });
                return;
            }
            commands.push({
                target: { kind: 'subtitle', trackId: entry.trackId, subtitleId: entry.subtitle.id },
                action: {
                    kind: 'resize',
                    start: secondsToOutputSample(next.subtitle.startTime),
                    end: secondsToOutputSample(next.subtitle.endTime),
                },
            });
        });
    const batch = planTimelineOrdinaryV4BatchCommand(document, commands, {
        command: 'replace-subtitles',
        label: request.label,
        activeSubtitleTrackId: request.activeSubtitleTrackId,
        ...(handledAdded.size === 0 ? { transientSelection: request.transientSelection } : {}),
    });
    if (batch.kind === 'error') return batch;
    const plannedDocument = batch.kind === 'success' ? batch.document : document;
    const unmatchedAdded = added.filter((entry) => !handledAdded.has(entry.subtitle.id));
    const lockedAdditions = unmatchedAdded
        .filter((entry) => document.subtitleTracks.find((track) => track.id === entry.trackId)?.isLocked)
        .map((entry) => entry.trackId);
    if (lockedAdditions.length > 0) {
        return error('locked-target', 'Subtitle track is locked.', Array.from(new Set(lockedAdditions)).sort());
    }
    const computed = indexSubtitles(plannedDocument.subtitleTracks);
    if (!computed) return error('invalid-proposal', 'Subtitle command produced duplicate IDs.', []);
    unmatchedAdded.forEach((entry) => computed.set(entry.subtitle.id, structuredClone(entry)));
    const subtitleTracks = request.subtitleTracks.map((requestedTrack) => {
        const metadata = { ...structuredClone(requestedTrack), subtitles: [] as Subtitle[] };
        metadata.subtitles = Array.from(computed.values())
            .filter((entry) => entry.trackId === requestedTrack.id && desired.has(entry.subtitle.id))
            .map((entry) => ({
                ...entry.subtitle,
                text: desired.get(entry.subtitle.id)?.subtitle.text ?? entry.subtitle.text,
            }))
            .sort(compareSubtitles);
        return metadata;
    });
    const finalDocument: EditorDocumentV4 = {
        ...plannedDocument,
        revision: document.revision + 1,
        subtitleTracks,
        activeSubtitleTrackId: handledAdded.size > 0
            ? plannedDocument.activeSubtitleTrackId
            : request.activeSubtitleTrackId,
        transientSelection: handledAdded.size > 0
            ? repairRequestedSelection(plannedDocument.transientSelection, subtitleTracks)
            : repairRequestedSelection(request.transientSelection, subtitleTracks),
    };
    if (sameTargets(document, finalDocument)
        && document.activeSubtitleTrackId === finalDocument.activeSubtitleTrackId) {
        return { kind: 'noop', code: 'unchanged' };
    }
    return {
        kind: 'success',
        command: 'replace-subtitles',
        label: request.label,
        document: finalDocument,
        targetTransforms: batch.kind === 'success' ? batch.targetTransforms : [],
        audioGraph: false,
        playhead: batch.kind === 'success'
            ? batch.playhead
            : { kind: 'keep', reason: 'non-structural' },
    };
}

function planVideoCommand(
    document: EditorDocumentV4,
    request: TimelineOrdinaryCommand & { target: Extract<EditorialDependentTargetV1, { kind: 'video-clip' }> },
): TimelineOrdinaryPlanResult {
    const target = request.target;
    const clip = document.videoClips.find((value) => value.id === target.clipId);
    if (!clip) return error('missing-target', 'Ordinary video target does not exist.', [target.clipId]);
    if (Object.values(document.narrative?.blocks ?? {}).some((block) => block.clipId === clip.id)) {
        return error('owned-target', 'Narrative-owned video must use a text command.', [clip.id]);
    }
    if (request.action.kind === 'split') return splitVideo(document, target, request.action.at, request.action.childId);
    const placements = document.videoClips.map((value) => {
        const placement = getVideoClipPlacementV4(document, value);
        return { id: value.id, trackId: value.trackId, start: placement.startFrame, end: placement.endFrame };
    });
    const before = placements.find((value) => value.id === clip.id)!;
    // Pointer-up can legitimately report the clip's original placement after snapping or a
    // cancelled horizontal draft. This must stop before track locks, ripple followers, links,
    // selection, history, or persistence observe a command at all.
    if (request.action.kind === 'move'
        && request.action.targetTrackId === before.trackId
        && request.action.targetStart === before.start) {
        return { kind: 'noop', code: 'unchanged' };
    }
    const destinationTrackId = request.action.kind === 'move'
        ? request.action.targetTrackId
        : null;
    if (destinationTrackId
        && !document.videoTracks.some((track) => track.id === destinationTrackId)) {
        return error(
            'missing-target',
            'Video destination track does not exist.',
            [destinationTrackId],
        );
    }
    const requestedDuration = request.action.kind === 'resize'
        ? request.action.end - request.action.start
        : null;
    const action = request.action.kind === 'delete'
        ? { kind: 'delete' as const, itemId: clip.id }
        : request.action.kind === 'resize'
            ? {
                kind: 'resize' as const,
                itemId: clip.id,
                // Ripple start trims retain the occurrence insertion point and compact only the
                // duration delta. Absolute mode moves the visible edge exactly as requested.
                start: document.globalEditingMode === 'ripple' ? before.start : request.action.start,
                end: document.globalEditingMode === 'ripple'
                    ? before.start + requestedDuration!
                    : request.action.end,
            }
            : {
                kind: 'move' as const,
                itemId: clip.id,
                targetTrackId: request.action.targetTrackId,
                targetStart: request.action.targetStart,
            };
    const planned = planOrdinaryProjectIntervals({
        document,
        expectedDocumentRevision: document.revision,
        expectedMode: document.globalEditingMode,
        items: placements,
        action,
        lockedTrackIds: document.videoTracks.filter((track) => track.locked).map((track) => track.id),
    });
    if (planned.kind === 'error') return intervalError(planned.code, planned.itemIds);
    const afterById = new Map(planned.after.map((value) => [value.id, value]));
    const afterTarget = afterById.get(clip.id);
    const videoClips = document.videoClips.flatMap((value): VideoClipV4[] => {
        const placement = afterById.get(value.id);
        if (!placement) return [];
        if (value.id !== clip.id || request.action.kind !== 'resize') {
            return [{ ...value, trackId: placement.trackId, timelineStartFrame: placement.start }];
        }
        const sourceStart = value.sourceStart
            + frameDeltaToSeconds(request.action.start - before.start, document);
        const sourceEnd = value.sourceEnd
            + frameDeltaToSeconds(request.action.end - before.end, document);
        const durationFrames = placement.end - placement.start;
        const audio = value.audio ? clampVideoFades(value.audio, durationFrames) : null;
        return [{
            ...value,
            trackId: placement.trackId,
            timelineStartFrame: placement.start,
            sourceStart,
            sourceEnd,
            audio,
        }];
    });
    // Moving the final occurrence out of a lane has the same membership consequence as deleting
    // that occurrence: the now-empty source lane must disappear in the command transaction. New
    // destination lanes remain because their moved occurrence is already present in `videoClips`.
    const videoTracks = request.action.kind === 'delete' || request.action.kind === 'move'
        ? pruneEmptyVideoTracks(document.videoTracks, videoClips)
        : document.videoTracks;
    let transformedDocument = withVideoSelection({
        ...document,
        revision: document.revision + 1,
        videoClips,
        videoTracks,
    }, afterTarget ? clip.id : null);
    const subtitleResponse = applyUnlinkedSubtitleVideoResponse({
        before: document,
        after: transformedDocument,
        request,
        beforeTarget: before,
        afterTarget: afterTarget ?? null,
    });
    if (subtitleResponse.kind === 'error') return subtitleResponse;
    transformedDocument = subtitleResponse.document;
    if (sameTargets(document, transformedDocument)) return { kind: 'noop', code: 'unchanged' };
    const transform: EditorialDirectTargetTransform = request.action.kind === 'delete'
        ? { kind: 'deleted', target }
        : request.action.kind === 'resize'
            ? { kind: 'trimmed', target }
            : { kind: 'moved', target };
    return success({
        before: document,
        document: transformedDocument,
        request,
        transform,
        audioGraph: true,
        selectedStart: afterTarget?.start ?? before.start,
    });
}

function splitVideo(
    document: EditorDocumentV4,
    target: Extract<EditorialDependentTargetV1, { kind: 'video-clip' }>,
    splitFrame: number,
    childId: string,
): TimelineOrdinaryPlanResult {
    const clip = document.videoClips.find((value) => value.id === target.clipId)!;
    const placement = getVideoClipPlacementV4(document, clip);
    const track = document.videoTracks.find((value) => value.id === clip.trackId)!;
    if (track.locked) return error('locked-target', 'Ordinary video track is locked.', [track.id]);
    if (!Number.isSafeInteger(splitFrame)
        || splitFrame <= placement.startFrame
        || splitFrame >= placement.endFrame) {
        return error('invalid-interval', 'Video split must be inside the target frame interval.', [clip.id]);
    }
    if (document.videoClips.some((value) => value.id === childId)) {
        return error('collision', 'Video split child ID already exists.', [childId]);
    }
    const leftDuration = splitFrame - placement.startFrame;
    const rightDuration = placement.endFrame - splitFrame;
    const source = document.videoSources.find((value) => value.id === clip.sourceId);
    if (!source) return error('missing-target', 'Video split source is unavailable.', [clip.sourceId]);
    const crop = exactClipSourceFrameRange(clip, source);
    if (!crop) return error('invalid-interval', 'Video split source crop is not frame-aligned.', [clip.id]);
    const seamFrame = findExactSourceSplitFrame({
        crop,
        source,
        projectFps: document.renderProfile.fps,
        leftDuration,
        rightDuration,
    });
    if (seamFrame === null) {
        return error(
            'invalid-interval',
            'Video split is not exactly representable at a native source-frame boundary.',
            [clip.id],
        );
    }
    const sourceSplit = seamFrame / source.fps;
    const left: VideoClipV4 = {
        ...clip,
        sourceEnd: sourceSplit,
        audio: clip.audio ? clampVideoFades({ ...clip.audio, fadeOutFrames: 0 }, leftDuration) : null,
    };
    const right: VideoClipV4 = {
        ...clip,
        id: childId,
        timelineStartFrame: splitFrame,
        sourceStart: sourceSplit,
        audio: clip.audio ? clampVideoFades({ ...clip.audio, fadeInFrames: 0 }, rightDuration) : null,
    };
    const videoClips = document.videoClips.flatMap((value) => value.id === clip.id ? [left, right] : [value]);
    const transformedDocument = withVideoSelection({
        ...document,
        revision: document.revision + 1,
        videoClips,
    }, childId);
    return success({
        before: document,
        document: transformedDocument,
        request: { target, action: { kind: 'split', at: splitFrame, childId } },
        transform: {
            kind: 'split',
            target,
            childTargets: [{ kind: 'video-clip', clipId: clip.id }, { kind: 'video-clip', clipId: childId }],
        },
        audioGraph: true,
        selectedStart: splitFrame,
    });
}

/**
 * Finds the nearest native-frame seam that preserves both requested output-frame durations.
 * Project and source rates can differ (for example 30 versus 29.97), so adding project seconds to
 * a crop would create a non-native source boundary that later Text activation must reject.
 */
function findExactSourceSplitFrame(input: {
    crop: { start: number; end: number };
    source: EditorDocumentV4['videoSources'][number];
    projectFps: EditorDocumentV4['renderProfile']['fps'];
    leftDuration: number;
    rightDuration: number;
}): number | null {
    const projectRate = input.projectFps.numerator / input.projectFps.denominator;
    const ideal = input.crop.start + input.leftDuration * input.source.fps / projectRate;
    // One project frame may span several native frames at high source rates. Searching one full
    // source/project ratio on either side covers every candidate that can round to this duration.
    const radius = Math.max(4, Math.ceil(input.source.fps / projectRate) + 2);
    const minimum = Math.max(input.crop.start + 1, Math.floor(ideal) - radius);
    const maximum = Math.min(input.crop.end - 1, Math.ceil(ideal) + radius);
    let best: number | null = null;
    for (let frame = minimum; frame <= maximum; frame += 1) {
        const left = sourceFrameSpanToProjectFrames(
            input.crop.start,
            frame,
            input.source.fps,
            input.projectFps,
            input.source.duration,
        );
        const right = sourceFrameSpanToProjectFrames(
            frame,
            input.crop.end,
            input.source.fps,
            input.projectFps,
            input.source.duration,
        );
        if (left !== input.leftDuration || right !== input.rightDuration) continue;
        if (best === null || Math.abs(frame - ideal) < Math.abs(best - ideal)) best = frame;
    }
    return best;
}

function planAudioCommand(
    document: EditorDocumentV4,
    request: TimelineOrdinaryCommand & { target: Extract<EditorialDependentTargetV1, { kind: 'audio-clip' }> },
): TimelineOrdinaryPlanResult {
    const sources = { videoSources: document.videoSources, audioSources: document.audioSources };
    const located = findAudioClip(document.audioTracks, sources, request.target.clipId);
    if (!located || located.track.id !== request.target.trackId) {
        return error('missing-target', 'Ordinary audio target does not exist.', [request.target.clipId]);
    }
    const interval = getAudioClipOutputInterval(located.clip, located.source, document.renderProfile);
    if (request.action.kind === 'move'
        && request.action.targetTrackId === located.track.id
        && request.action.targetStart === interval.startSample) {
        return { kind: 'noop', code: 'unchanged' };
    }
    const audioDestinationTrackId = request.action.kind === 'move'
        ? request.action.targetTrackId
        : null;
    if (audioDestinationTrackId
        && !document.audioTracks.some((track) => track.id === audioDestinationTrackId)) {
        return error(
            'missing-target',
            'Audio destination track does not exist.',
            [audioDestinationTrackId],
        );
    }
    if (request.action.kind === 'split') {
        const splitFrame = exactOutputSampleFrame(request.action.at, document);
        if (splitFrame === null) {
            return error('invalid-interval', 'Audio split must map to an exact output-frame boundary.', [located.clip.id]);
        }
        const tracks = splitAudioClipInTracks(
            document.audioTracks,
            sources,
            document.renderProfile,
            located.clip.id,
            splitFrame,
            request.action.childId,
        );
        if (!tracks) return error('collision', 'Audio split is outside bounds, locked, or colliding.', [located.clip.id]);
        const transformedDocument = withAudioSelection({
            ...document,
            revision: document.revision + 1,
            audioTracks: tracks,
        }, located.track.id, request.action.childId);
        return success({
            before: document,
            document: transformedDocument,
            request,
            transform: {
                kind: 'split',
                target: request.target,
                childTargets: [
                    { ...request.target },
                    { kind: 'audio-clip', trackId: located.track.id, clipId: request.action.childId },
                ],
            },
            audioGraph: true,
            selectedStart: splitFrame,
        });
    }
    const items = document.audioTracks.flatMap((track) => track.clips.map((clip) => {
        const resolved = findAudioClip(document.audioTracks, sources, clip.id)!;
        const value = getAudioClipOutputInterval(clip, resolved.source, document.renderProfile);
        return { id: clip.id, trackId: track.id, start: value.startSample, end: value.endSample };
    }));
    const action = request.action.kind === 'delete'
        ? { kind: 'delete' as const, itemId: located.clip.id }
        : request.action.kind === 'resize'
            ? {
                kind: 'resize' as const,
                itemId: located.clip.id,
                start: document.globalEditingMode === 'ripple'
                    ? interval.startSample
                    : request.action.start,
                end: document.globalEditingMode === 'ripple'
                    ? interval.startSample + request.action.end - request.action.start
                    : request.action.end,
            }
            : {
                kind: 'move' as const,
                itemId: located.clip.id,
                targetTrackId: request.action.targetTrackId,
                targetStart: request.action.targetStart,
            };
    const planned = planOrdinaryProjectIntervals({
        document,
        expectedDocumentRevision: document.revision,
        expectedMode: document.globalEditingMode,
        items,
        action,
        lockedTrackIds: document.audioTracks.filter((track) => track.locked).map((track) => track.id),
    });
    if (planned.kind === 'error') return intervalError(planned.code, planned.itemIds);
    const afterById = new Map(planned.after.map((value) => [value.id, value]));
    let resizedTracks = cloneAudioTracks(document.audioTracks);
    if (request.action.kind === 'resize') {
        const leftFrame = exactOutputSampleFrame(request.action.start, document);
        if (leftFrame === null) {
            return error('invalid-interval', 'Audio placement must start on an exact output frame.', [located.clip.id]);
        }
        if (isImportedAudioClip(located.clip) && located.source.kind === 'audio-source') {
            const resized = resizeImportedAudioClipExact({
                clip: located.clip,
                nativeSampleRate: located.source.descriptor.nativeSampleRate,
                interval,
                nextStartSample: request.action.start,
                nextEndSample: request.action.end,
                nextStartFrame: leftFrame,
            });
            if (!resized) {
                return error(
                    'invalid-interval',
                    'Imported-audio trim is outside the retained source crop.',
                    [located.clip.id],
                );
            }
            resizedTracks = resizedTracks.map((track) => track.id === located.track.id
                ? {
                    ...track,
                    clips: track.clips.map((clip) => clip.id === located.clip.id ? resized : clip),
                }
                : track);
        } else {
            const rightFrame = exactOutputSampleFrame(request.action.end, document);
            if (rightFrame === null) {
                return error(
                    'invalid-interval',
                    'Detached-video audio trim boundaries must map to exact output frames.',
                    [located.clip.id],
                );
            }
            if (request.action.start !== interval.startSample) {
                const next = trimAudioClipInTracks(
                    resizedTracks,
                    sources,
                    document.renderProfile,
                    located.clip.id,
                    'left',
                    leftFrame,
                );
                if (!next) {
                    return error('invalid-interval', 'Audio start trim is outside the source crop.', [located.clip.id]);
                }
                resizedTracks = next;
            }
            if (request.action.end !== interval.endSample) {
                const next = trimAudioClipInTracks(
                    resizedTracks,
                    sources,
                    document.renderProfile,
                    located.clip.id,
                    'right',
                    rightFrame,
                );
                if (!next) {
                    return error('invalid-interval', 'Audio end trim is outside the source crop.', [located.clip.id]);
                }
                resizedTracks = next;
            }
        }
    }
    const clips = resizedTracks.flatMap((track) => track.clips.map((clip) => ({ trackId: track.id, clip })));
    const byTargetTrack = new Map(document.audioTracks.map((track) => [track.id, [] as AudioClip[]]));
    for (const entry of clips) {
        const placement = afterById.get(entry.clip.id);
        if (!placement) continue;
        const timelineStartFrame = exactOutputSampleFrame(placement.start, document);
        if (timelineStartFrame === null) {
            return error('invalid-interval', 'Audio placement must start on an exact output frame.', [entry.clip.id]);
        }
        const destination = byTargetTrack.get(placement.trackId);
        if (!destination) return error('missing-target', 'Audio destination track does not exist.', [placement.trackId]);
        destination.push({ ...entry.clip, timelineStartFrame });
    }
    const audioTracks = document.audioTracks.map((track) => ({
        ...track,
        clips: (byTargetTrack.get(track.id) ?? []).sort(compareAudioClips),
    }));
    const afterTarget = afterById.get(located.clip.id);
    const afterTargetIdentity = afterTarget
        ? { kind: 'audio-clip' as const, trackId: afterTarget.trackId, clipId: located.clip.id }
        : null;
    const transformedDocument = withAudioSelection({
        ...document,
        revision: document.revision + 1,
        audioTracks,
    }, afterTargetIdentity?.trackId ?? null, afterTargetIdentity?.clipId ?? null);
    if (sameTargets(document, transformedDocument)) return { kind: 'noop', code: 'unchanged' };
    const transform: EditorialDirectTargetTransform = request.action.kind === 'delete'
        ? { kind: 'deleted', target: request.target }
        : request.action.kind === 'resize'
            ? { kind: 'trimmed', target: request.target }
            : { kind: 'moved', target: request.target, afterTarget: afterTargetIdentity ?? undefined };
    return success({
        before: document,
        document: transformedDocument,
        request,
        transform,
        audioGraph: true,
        selectedStart: afterTarget ? outputSampleToCoveringFrame(afterTarget.start, document.renderProfile.fps) : located.clip.timelineStartFrame,
    });
}

function planSubtitleCommand(
    document: EditorDocumentV4,
    request: TimelineOrdinaryCommand & { target: Extract<EditorialDependentTargetV1, { kind: 'subtitle' }> },
): TimelineOrdinaryPlanResult {
    const track = document.subtitleTracks.find((value) => value.id === request.target.trackId);
    const subtitle = track?.subtitles.find((value) => value.id === request.target.subtitleId);
    if (!track || !subtitle) {
        return error('missing-target', 'Ordinary subtitle target does not exist.', [request.target.subtitleId]);
    }
    const start = secondsToOutputSample(subtitle.startTime);
    const end = secondsToOutputSample(subtitle.endTime);
    if (request.action.kind === 'move'
        && request.action.targetTrackId === track.id
        && request.action.targetStart === start) {
        return { kind: 'noop', code: 'unchanged' };
    }
    const subtitleDestinationTrackId = request.action.kind === 'move'
        ? request.action.targetTrackId
        : null;
    if (subtitleDestinationTrackId
        && !document.subtitleTracks.some((candidate) => candidate.id === subtitleDestinationTrackId)) {
        return error(
            'missing-target',
            'Subtitle destination track does not exist.',
            [subtitleDestinationTrackId],
        );
    }
    if (request.action.kind === 'split') {
        const childId = request.action.childId;
        if (track.isLocked) return error('locked-target', 'Subtitle track is locked.', [track.id]);
        if (!Number.isSafeInteger(request.action.at) || request.action.at <= start || request.action.at >= end) {
            return error('invalid-interval', 'Subtitle split must be inside the cue interval.', [subtitle.id]);
        }
        if (document.subtitleTracks.some((value) => value.subtitles.some((cue) => cue.id === childId))) {
            return error('collision', 'Subtitle split child ID already exists.', [childId]);
        }
        const splitTime = request.action.at / 48_000;
        const subtitleTracks = document.subtitleTracks.map((value) => value.id === track.id
            ? {
                ...value,
                subtitles: value.subtitles.flatMap((cue) => cue.id === subtitle.id
                    ? [{ ...cue, endTime: splitTime }, { ...cue, id: childId, startTime: splitTime }]
                    : [cue]),
            }
            : value);
        const transformedDocument = withSubtitleSelection({
            ...document,
            revision: document.revision + 1,
            subtitleTracks,
        }, track.id, childId);
        return success({
            before: document,
            document: transformedDocument,
            request,
            transform: {
                kind: 'split',
                target: request.target,
                childTargets: [
                    { ...request.target },
                    { kind: 'subtitle', trackId: track.id, subtitleId: childId },
                ],
            },
            audioGraph: false,
            selectedStart: outputSampleToCoveringFrame(request.action.at, document.renderProfile.fps),
        });
    }
    const items = document.subtitleTracks.flatMap((value) => value.subtitles.map((cue) => ({
        id: cue.id,
        trackId: value.id,
        start: secondsToOutputSample(cue.startTime),
        end: secondsToOutputSample(cue.endTime),
    })));
    const action = request.action.kind === 'delete'
        ? { kind: 'delete' as const, itemId: subtitle.id }
        : request.action.kind === 'resize'
            ? { kind: 'resize' as const, itemId: subtitle.id, start: request.action.start, end: request.action.end }
            : {
                kind: 'move' as const,
                itemId: subtitle.id,
                targetTrackId: request.action.targetTrackId,
                targetStart: request.action.targetStart,
            };
    const planned = planOrdinaryProjectIntervals({
        document,
        expectedDocumentRevision: document.revision,
        expectedMode: document.globalEditingMode,
        items,
        action,
        lockedTrackIds: document.subtitleTracks.filter((value) => value.isLocked).map((value) => value.id),
        overlapAllowedTrackIds: document.subtitleTracks.map((value) => value.id),
    });
    if (planned.kind === 'error') return intervalError(planned.code, planned.itemIds);
    const afterById = new Map(planned.after.map((value) => [value.id, value]));
    const subtitlesByTrack = new Map(document.subtitleTracks.map((value) => [value.id, [] as typeof value.subtitles]));
    document.subtitleTracks.forEach((value) => value.subtitles.forEach((cue) => {
        const placement = afterById.get(cue.id);
        if (!placement) return;
        subtitlesByTrack.get(placement.trackId)?.push({
            ...cue,
            startTime: placement.start / 48_000,
            endTime: placement.end / 48_000,
        });
    }));
    const subtitleTracks = document.subtitleTracks.map((value) => ({
        ...value,
        subtitles: (subtitlesByTrack.get(value.id) ?? []).sort(compareSubtitles),
    }));
    const afterTarget = afterById.get(subtitle.id);
    const afterTargetIdentity = afterTarget
        ? { kind: 'subtitle' as const, trackId: afterTarget.trackId, subtitleId: subtitle.id }
        : null;
    const transformedDocument = withSubtitleSelection({
        ...document,
        revision: document.revision + 1,
        subtitleTracks,
    }, afterTargetIdentity?.trackId ?? null, afterTargetIdentity?.subtitleId ?? null);
    if (sameTargets(document, transformedDocument)) return { kind: 'noop', code: 'unchanged' };
    const transform: EditorialDirectTargetTransform = request.action.kind === 'delete'
        ? { kind: 'deleted', target: request.target }
        : request.action.kind === 'resize'
            ? { kind: 'trimmed', target: request.target }
            : { kind: 'moved', target: request.target, afterTarget: afterTargetIdentity ?? undefined };
    return success({
        before: document,
        document: transformedDocument,
        request,
        transform,
        audioGraph: false,
        selectedStart: afterTarget
            ? outputSampleToCoveringFrame(afterTarget.start, document.renderProfile.fps)
            : outputSampleToCoveringFrame(start, document.renderProfile.fps),
    });
}

function success(input: {
    before: EditorDocumentV4;
    document: EditorDocumentV4;
    request: TimelineOrdinaryCommand;
    transform: EditorialDirectTargetTransform;
    audioGraph: boolean;
    selectedStart: number;
}): TimelineOrdinaryPlanSuccess {
    const noun = input.request.target.kind === 'video-clip'
        ? 'video clip'
        : input.request.target.kind === 'audio-clip' ? 'audio clip' : 'subtitle';
    const verb = input.request.action.kind === 'delete'
        ? 'Delete'
        : input.request.action.kind === 'resize' ? 'Trim'
            : input.request.action.kind === 'move' ? 'Move' : 'Split';
    const deleted = input.request.action.kind === 'delete';
    return {
        kind: 'success',
        command: `${input.request.action.kind}-${input.request.target.kind}`,
        label: `${verb} ${noun}`,
        document: input.document,
        targetTransforms: completeTargetTransformLedger(
            input.before,
            input.document,
            input.transform,
        ),
        audioGraph: input.audioGraph,
        playhead: deleted
            ? { kind: 'seek', frame: input.selectedStart, reason: 'deletion-start' }
            : { kind: 'seek', frame: input.selectedStart, reason: 'follow-selection' },
    };
}

/**
 * Completes the direct-edit ledger with every target that the ordinary ripple planner translated.
 *
 * WP5 intentionally refuses to infer linked-target movement from the proposed document. Keeping
 * this diff here makes the ordinary command auditable and also covers unlinked subtitle followers
 * moved by the explicit video-response policy. The primary transform remains authoritative for
 * split semantics and any same-identity trim selected by the caller.
 */
function completeTargetTransformLedger(
    before: EditorDocumentV4,
    after: EditorDocumentV4,
    primary: EditorialDirectTargetTransform,
): EditorialDirectTargetTransform[] {
    const transforms: EditorialDirectTargetTransform[] = [primary];
    const covered = new Set([getEditorialTargetKey(primary.target)]);

    for (const target of listEditorialTargets(before)) {
        const key = getEditorialTargetKey(target);
        if (covered.has(key)) continue;
        const afterTarget = findEditorialTargetOccurrence(after, target);
        if (!afterTarget) {
            transforms.push({ kind: 'deleted', target });
            covered.add(key);
            continue;
        }

        const oldInterval = getEditorialTargetInterval(before, target);
        const newInterval = getEditorialTargetInterval(after, afterTarget);
        if (oldInterval.kind === 'error' || newInterval.kind === 'error') continue;
        const oldTrackId = getEditorialTargetTrackId(before, target);
        const newTrackId = getEditorialTargetTrackId(after, afterTarget);
        const intervalChanged = oldInterval.interval.start !== newInterval.interval.start
            || oldInterval.interval.end !== newInterval.interval.end;
        if (!intervalChanged && oldTrackId === newTrackId) continue;

        const oldDuration = oldInterval.interval.end - oldInterval.interval.start;
        const newDuration = newInterval.interval.end - newInterval.interval.start;
        if (oldDuration === newDuration) {
            transforms.push({
                kind: 'moved',
                target,
                ...(getEditorialTargetKey(afterTarget) === key ? {} : { afterTarget }),
            });
            covered.add(key);
            continue;
        }
        if (oldTrackId === newTrackId
            && newInterval.interval.start >= oldInterval.interval.start
            && newInterval.interval.end <= oldInterval.interval.end
            && newInterval.interval.start < newInterval.interval.end) {
            transforms.push({ kind: 'trimmed', target });
            covered.add(key);
        }
    }
    return transforms;
}

function listEditorialTargets(document: EditorDocumentV4): EditorialDependentTargetV1[] {
    return [
        ...document.videoClips.map((clip) => ({
            kind: 'video-clip' as const,
            clipId: clip.id,
        })),
        ...document.audioTracks.flatMap((track) => track.clips.map((clip) => ({
            kind: 'audio-clip' as const,
            trackId: track.id,
            clipId: clip.id,
        }))),
        ...document.subtitleTracks.flatMap((track) => track.subtitles.map((subtitle) => ({
            kind: 'subtitle' as const,
            trackId: track.id,
            subtitleId: subtitle.id,
        }))),
    ];
}

/** Resolves persisted occurrence identity even when audio/subtitle track identity changes. */
function findEditorialTargetOccurrence(
    document: EditorDocumentV4,
    target: EditorialDependentTargetV1,
): EditorialDependentTargetV1 | null {
    if (target.kind === 'video-clip') {
        return document.videoClips.some((clip) => clip.id === target.clipId) ? target : null;
    }
    if (target.kind === 'audio-clip') {
        const track = document.audioTracks.find((candidate) => (
            candidate.clips.some((clip) => clip.id === target.clipId)
        ));
        return track
            ? { kind: 'audio-clip', trackId: track.id, clipId: target.clipId }
            : null;
    }
    const track = document.subtitleTracks.find((candidate) => (
        candidate.subtitles.some((subtitle) => subtitle.id === target.subtitleId)
    ));
    return track
        ? { kind: 'subtitle', trackId: track.id, subtitleId: target.subtitleId }
        : null;
}

function getEditorialTargetTrackId(
    document: EditorDocumentV4,
    target: EditorialDependentTargetV1,
): string | null {
    if (target.kind === 'video-clip') {
        return document.videoClips.find((clip) => clip.id === target.clipId)?.trackId ?? null;
    }
    return target.trackId;
}

function intervalError(code: string, ids: string[]): TimelineOrdinaryPlanResult {
    return error(code, `Ordinary interval command failed: ${code}.`, ids);
}

function error(code: string, message: string, ids: string[]): TimelineOrdinaryPlanResult {
    return { kind: 'error', error: { code, message, ids: [...ids] } };
}

function exactOutputSampleFrame(sample: number, document: EditorDocumentV4): number | null {
    if (!Number.isSafeInteger(sample) || sample < 0) return null;
    const frame = outputSampleToCoveringFrame(sample, document.renderProfile.fps);
    return frameToOutputSample(frame, document.renderProfile.fps) === sample ? frame : null;
}

/** Frame deltas may be negative when a trim extends an edge; boundary converters forbid that. */
function frameDeltaToSeconds(deltaFrames: number, document: EditorDocumentV4): number {
    if (!Number.isSafeInteger(deltaFrames)) throw new RangeError('Video frame delta must be a safe integer.');
    return deltaFrames
        * document.renderProfile.fps.denominator
        / document.renderProfile.fps.numerator;
}

function isImportedAudioClip(clip: AudioClip): clip is ImportedAudioClip {
    return clip.source.kind === 'audio-source';
}

interface LocatedSubtitle {
    trackId: string;
    subtitle: Subtitle;
}

function indexSubtitles(
    tracks: readonly SubtitleTrackV4[],
): Map<string, LocatedSubtitle> | null {
    const result = new Map<string, LocatedSubtitle>();
    for (const track of tracks) {
        for (const subtitle of track.subtitles) {
            if (result.has(subtitle.id)) return null;
            result.set(subtitle.id, { trackId: track.id, subtitle: structuredClone(subtitle) });
        }
    }
    return result;
}

function sameSubtitleInterval(left: LocatedSubtitle, right: LocatedSubtitle): boolean {
    return left.trackId === right.trackId
        && secondsToOutputSample(left.subtitle.startTime) === secondsToOutputSample(right.subtitle.startTime)
        && secondsToOutputSample(left.subtitle.endTime) === secondsToOutputSample(right.subtitle.endTime);
}

function compareLocatedSubtitles(left: LocatedSubtitle, right: LocatedSubtitle): number {
    return secondsToOutputSample(left.subtitle.startTime) - secondsToOutputSample(right.subtitle.startTime)
        || secondsToOutputSample(left.subtitle.endTime) - secondsToOutputSample(right.subtitle.endTime)
        || left.trackId.localeCompare(right.trackId)
        || left.subtitle.id.localeCompare(right.subtitle.id);
}

function isExactSubtitleSplit(
    beforeParent: LocatedSubtitle,
    addedChild: LocatedSubtitle,
    desired: ReadonlyMap<string, LocatedSubtitle>,
): boolean {
    const nextParent = desired.get(beforeParent.subtitle.id);
    if (!nextParent || nextParent.trackId !== beforeParent.trackId
        || addedChild.trackId !== beforeParent.trackId) return false;
    const oldStart = secondsToOutputSample(beforeParent.subtitle.startTime);
    const oldEnd = secondsToOutputSample(beforeParent.subtitle.endTime);
    const parentStart = secondsToOutputSample(nextParent.subtitle.startTime);
    const parentEnd = secondsToOutputSample(nextParent.subtitle.endTime);
    const childStart = secondsToOutputSample(addedChild.subtitle.startTime);
    const childEnd = secondsToOutputSample(addedChild.subtitle.endTime);
    return parentStart === oldStart
        && parentEnd === childStart
        && childEnd === oldEnd
        && parentEnd > parentStart;
}

function detectRepresentationalSubtitleMerge(
    deleted: readonly LocatedSubtitle[],
    added: readonly LocatedSubtitle[],
    structural: readonly LocatedSubtitle[],
    desired: ReadonlyMap<string, LocatedSubtitle>,
): { trackId: string; survivorId: string; deletedId: string } | null {
    if (deleted.length !== 1 || added.length !== 0 || structural.length !== 1) return null;
    const removed = deleted[0];
    const survivor = structural[0];
    const next = desired.get(survivor.subtitle.id);
    if (!next || removed.trackId !== survivor.trackId || next.trackId !== survivor.trackId) return null;
    const removedStart = secondsToOutputSample(removed.subtitle.startTime);
    const removedEnd = secondsToOutputSample(removed.subtitle.endTime);
    const survivorStart = secondsToOutputSample(survivor.subtitle.startTime);
    const survivorEnd = secondsToOutputSample(survivor.subtitle.endTime);
    const nextStart = secondsToOutputSample(next.subtitle.startTime);
    const nextEnd = secondsToOutputSample(next.subtitle.endTime);
    const adjacentBefore = removedEnd === survivorStart
        && nextStart === removedStart
        && nextEnd === survivorEnd;
    const adjacentAfter = survivorEnd === removedStart
        && nextStart === survivorStart
        && nextEnd === removedEnd;
    return adjacentBefore || adjacentAfter
        ? { trackId: survivor.trackId, survivorId: survivor.subtitle.id, deletedId: removed.subtitle.id }
        : null;
}

function repairRequestedSelection(
    selection: TransientMediaSelectionV4,
    tracks: readonly SubtitleTrackV4[],
): TransientMediaSelectionV4 {
    if (selection.kind !== 'subtitles') return structuredClone(selection);
    const valid = new Set(tracks.flatMap((track) => track.subtitles.map((subtitle) => subtitle.id)));
    const subtitleIds = selection.subtitleIds.filter((id) => valid.has(id));
    const trackId = tracks.some((track) => track.id === selection.trackId)
        ? selection.trackId
        : tracks.find((track) => track.subtitles.some((subtitle) => subtitleIds.includes(subtitle.id)))?.id;
    return trackId && subtitleIds.length > 0
        ? { kind: 'subtitles', trackId, subtitleIds }
        : { kind: 'none' };
}

/**
 * Keeps imported-audio duration in its native V4 48 kHz domain while choosing the nearest legal
 * native crop boundaries. Only the visible start needs a frame boundary because AudioClip stores
 * `timelineStartFrame`; its persisted `timelineDurationSamples` keeps an arbitrary exact end.
 */
function resizeImportedAudioClipExact(input: {
    clip: ImportedAudioClip;
    nativeSampleRate: number;
    interval: { startSample: number; endSample: number };
    nextStartSample: number;
    nextEndSample: number;
    nextStartFrame: number;
}): ImportedAudioClip | null {
    if (input.nextStartSample < input.interval.startSample
        || input.nextEndSample > input.interval.endSample
        || input.nextEndSample <= input.nextStartSample) return null;
    const removedFromStart = input.nextStartSample - input.interval.startSample;
    const sourceStartOutput = nativeBoundaryToOutputSample(
        input.clip.sourceStartSample,
        input.nativeSampleRate,
    ) + removedFromStart;
    const sourceStartSample = Math.min(
        input.clip.sourceEndSample - 1,
        Math.max(
            input.clip.sourceStartSample,
            outputSampleToNearestNativeBoundary(sourceStartOutput, input.nativeSampleRate),
        ),
    );
    const durationSamples = input.nextEndSample - input.nextStartSample;
    const sourceEndOutput = nativeBoundaryToOutputSample(sourceStartSample, input.nativeSampleRate)
        + durationSamples;
    const sourceEndSample = Math.max(
        sourceStartSample + 1,
        Math.min(
            input.clip.sourceEndSample,
            outputSampleToNearestNativeBoundary(sourceEndOutput, input.nativeSampleRate),
        ),
    );
    const naturalDuration = nativeBoundaryToOutputSample(sourceEndSample, input.nativeSampleRate)
        - nativeBoundaryToOutputSample(sourceStartSample, input.nativeSampleRate);
    const maximumBoundaryDrift = Math.max(0, Math.ceil(48_000 / input.nativeSampleRate) - 1);
    if (Math.abs(naturalDuration - durationSamples) > maximumBoundaryDrift) return null;
    return clampSampleFades({
        ...input.clip,
        timelineStartFrame: input.nextStartFrame,
        sourceStartSample,
        sourceEndSample,
        timelineDurationSamples: durationSamples,
    }, sourceEndSample - sourceStartSample);
}

function secondsToOutputSample(seconds: number): number {
    return Math.round(seconds * 48_000);
}

function withVideoSelection(document: EditorDocumentV4, clipId: string | null): EditorDocumentV4 {
    return { ...document, transientSelection: clipId ? { kind: 'video-clip', clipId } : { kind: 'none' } };
}

function withAudioSelection(
    document: EditorDocumentV4,
    trackId: string | null,
    clipId: string | null,
): EditorDocumentV4 {
    return {
        ...document,
        transientSelection: trackId && clipId ? { kind: 'audio-clip', trackId, clipId } : { kind: 'none' },
    };
}

function withSubtitleSelection(
    document: EditorDocumentV4,
    trackId: string | null,
    subtitleId: string | null,
): EditorDocumentV4 {
    return {
        ...document,
        activeSubtitleTrackId: trackId ?? document.activeSubtitleTrackId,
        transientSelection: trackId && subtitleId
            ? { kind: 'subtitles', trackId, subtitleIds: [subtitleId] }
            : { kind: 'none' },
    };
}

function clampVideoFades<T extends NonNullable<VideoClipV4['audio']>>(audio: T, duration: number): T {
    let fadeInFrames = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(audio.fadeInFrames)));
    let fadeOutFrames = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(audio.fadeOutFrames)));
    if (fadeInFrames + fadeOutFrames > duration) {
        const ratio = duration / (fadeInFrames + fadeOutFrames);
        fadeInFrames = Math.floor(fadeInFrames * ratio);
        fadeOutFrames = duration - fadeInFrames;
    }
    return { ...audio, fadeInFrames, fadeOutFrames };
}

function pruneEmptyVideoTracks(
    tracks: EditorDocumentV4['videoTracks'],
    clips: readonly VideoClipV4[],
): EditorDocumentV4['videoTracks'] {
    const occupied = new Set(clips.map((clip) => clip.trackId));
    const retained = tracks.filter((track) => occupied.has(track.id));
    if (retained.length > 0) return retained;
    // The editor keeps one insertion lane when the final clip is deleted.
    return tracks.length > 0 ? [tracks[0]] : [];
}

type SubtitleTimelineEdit =
    | { kind: 'delete'; startFrame: number; endFrame: number }
    | { kind: 'insert'; atFrame: number; durationFrames: number };

function applyUnlinkedSubtitleVideoResponse(input: {
    before: EditorDocumentV4;
    after: EditorDocumentV4;
    request: TimelineOrdinaryCommand & {
        target: Extract<EditorialDependentTargetV1, { kind: 'video-clip' }>;
    };
    beforeTarget: { start: number; end: number };
    afterTarget: { start: number; end: number } | null;
}): { kind: 'success'; document: EditorDocumentV4 } | { kind: 'error'; error: TimelineCommandError } {
    if (input.before.globalEditingMode !== 'ripple' || input.request.action.kind === 'split') {
        return { kind: 'success', document: input.after };
    }
    const movedVideo = input.request.action.kind === 'move' && input.afterTarget
        ? {
            before: input.beforeTarget,
            after: input.afterTarget,
        }
        : null;
    // A vertical lane change preserves project time. It is a real video move for link/history
    // purposes, but it must not manufacture a delete+insert subtitle edit at the same boundary.
    if (movedVideo && movedVideo.before.start === movedVideo.after.start) {
        return { kind: 'success', document: input.after };
    }
    const edits: SubtitleTimelineEdit[] = [];
    if (input.request.action.kind === 'delete') {
        edits.push({
            kind: 'delete',
            startFrame: input.beforeTarget.start,
            endFrame: input.beforeTarget.end,
        });
    } else if (input.request.action.kind === 'resize') {
        const oldDuration = input.beforeTarget.end - input.beforeTarget.start;
        const newDuration = input.afterTarget
            ? input.afterTarget.end - input.afterTarget.start
            : oldDuration;
        if (newDuration < oldDuration) {
            edits.push({
                kind: 'delete',
                startFrame: input.beforeTarget.start + newDuration,
                endFrame: input.beforeTarget.end,
            });
        } else if (newDuration > oldDuration) {
            edits.push({
                kind: 'insert',
                atFrame: input.beforeTarget.end,
                durationFrames: newDuration - oldDuration,
            });
        }
    } else if (!movedVideo) {
        return { kind: 'success', document: input.after };
    }
    if (!movedVideo && edits.length === 0) return { kind: 'success', document: input.after };

    const explicitlyLinked = new Set(input.before.dependentLinks.flatMap((link) => (
        link.target.kind === 'subtitle'
            ? [`${link.target.trackId}\u0000${link.target.subtitleId}`]
            : []
    )));
    const lockedChangedTracks: string[] = [];
    const subtitleTracks = input.before.subtitleTracks.map((track) => {
        if (track.unlinkedVideoEditResponse === 'stay-absolute') return track;
        const subtitles = track.subtitles.flatMap((subtitle) => {
            if (explicitlyLinked.has(`${track.id}\u0000${subtitle.id}`)) return [subtitle];
            if (track.unlinkedVideoEditResponse === 'remove-with-deleted-video-range') {
                return edits.some((edit) => (
                    edit.kind === 'delete'
                    && subtitleOverlapsDeletedVideoRange(subtitle, edit, input.before)
                ))
                    ? []
                    : [subtitle];
            }
            if (movedVideo) {
                return [applySubtitleVideoMove(subtitle, movedVideo.before, movedVideo.after, input.before)];
            }
            return edits.reduce(
                (fragments, edit) => fragments.flatMap((fragment) => applySubtitleTimelineEdit(
                    fragment,
                    edit,
                    input.before,
                )),
                [subtitle],
            );
        }).sort(compareSubtitles);
        if (track.isLocked && JSON.stringify(subtitles) !== JSON.stringify(track.subtitles)) {
            lockedChangedTracks.push(track.id);
        }
        return { ...track, subtitles };
    });
    if (lockedChangedTracks.length > 0) {
        return {
            kind: 'error',
            error: {
                code: 'locked-target',
                message: 'A locked subtitle track cannot apply its video-edit response.',
                ids: lockedChangedTracks.sort(),
            },
        };
    }
    return {
        kind: 'success',
        document: { ...input.after, subtitleTracks },
    };
}

function subtitleOverlapsDeletedVideoRange(
    subtitle: Subtitle,
    edit: Extract<SubtitleTimelineEdit, { kind: 'delete' }>,
    document: EditorDocumentV4,
): boolean {
    const start = framesToSeconds(edit.startFrame, document.renderProfile.fps);
    const end = framesToSeconds(edit.endFrame, document.renderProfile.fps);
    return subtitle.startTime < end && subtitle.endTime > start;
}

/**
 * Applies one cut-and-paste video move without ever treating overlapping cue content as deleted.
 *
 * A cue overlapping the picked-up video interval travels with that video and keeps its complete
 * duration/identity. Other cues follow the same start-boundary ripple rule as ordinary media:
 * closing the source gap shifts cues beginning after it, then opening the destination gap shifts
 * cues beginning at or after that insertion point. A cue spanning either edit boundary stays
 * whole, which avoids fabricating subtitle fragments that cannot be represented as one atomic
 * direct-target transform.
 */
function applySubtitleVideoMove(
    subtitle: Subtitle,
    before: { start: number; end: number },
    after: { start: number; end: number },
    document: EditorDocumentV4,
): Subtitle {
    const sourceStart = framesToSeconds(before.start, document.renderProfile.fps);
    const sourceEnd = framesToSeconds(before.end, document.renderProfile.fps);
    const destinationStart = framesToSeconds(after.start, document.renderProfile.fps);
    const duration = sourceEnd - sourceStart;
    const overlapsMovedVideo = subtitle.startTime < sourceEnd && subtitle.endTime > sourceStart;
    if (overlapsMovedVideo) {
        const delta = destinationStart - sourceStart;
        return delta === 0
            ? subtitle
            : {
                ...subtitle,
                startTime: subtitle.startTime + delta,
                endTime: subtitle.endTime + delta,
            };
    }

    let delta = 0;
    if (subtitle.startTime >= sourceEnd) delta -= duration;
    if (subtitle.startTime + delta >= destinationStart) delta += duration;
    return delta === 0
        ? subtitle
        : {
            ...subtitle,
            startTime: subtitle.startTime + delta,
            endTime: subtitle.endTime + delta,
        };
}

function applySubtitleTimelineEdit(
    subtitle: Subtitle,
    edit: SubtitleTimelineEdit,
    document: EditorDocumentV4,
): Subtitle[] {
    const toSeconds = (frame: number) => framesToSeconds(frame, document.renderProfile.fps);
    if (edit.kind === 'insert') {
        const at = toSeconds(edit.atFrame);
        const duration = toSeconds(edit.durationFrames);
        if (subtitle.endTime <= at) return [subtitle];
        if (subtitle.startTime >= at) {
            return [{ ...subtitle, startTime: subtitle.startTime + duration, endTime: subtitle.endTime + duration }];
        }
        return [{ ...subtitle, endTime: at }, {
            ...subtitle,
            id: `subtitle-fragment-${crypto.randomUUID()}`,
            startTime: at + duration,
            endTime: subtitle.endTime + duration,
        }];
    }
    const start = toSeconds(edit.startFrame);
    const end = toSeconds(edit.endFrame);
    const duration = end - start;
    const fragments: Subtitle[] = [];
    if (subtitle.startTime < start) {
        fragments.push({ ...subtitle, endTime: Math.min(subtitle.endTime, start) });
    }
    if (subtitle.endTime > end) {
        fragments.push({
            ...subtitle,
            id: fragments.length === 0 ? subtitle.id : `subtitle-fragment-${crypto.randomUUID()}`,
            startTime: Math.max(subtitle.startTime, end) - duration,
            endTime: subtitle.endTime - duration,
        });
    }
    return fragments.filter((fragment) => fragment.endTime > fragment.startTime);
}

function compareAudioClips(left: AudioClip, right: AudioClip): number {
    return left.timelineStartFrame - right.timelineStartFrame || left.id.localeCompare(right.id);
}

function compareSubtitles(left: { id: string; startTime: number; endTime: number }, right: { id: string; startTime: number; endTime: number }): number {
    return left.startTime - right.startTime || left.endTime - right.endTime || left.id.localeCompare(right.id);
}

function sameTargets(left: EditorDocumentV4, right: EditorDocumentV4): boolean {
    return JSON.stringify({
        videoClips: left.videoClips,
        audioTracks: left.audioTracks,
        subtitleTracks: left.subtitleTracks,
        transientSelection: left.transientSelection,
    }) === JSON.stringify({
        videoClips: right.videoClips,
        audioTracks: right.audioTracks,
        subtitleTracks: right.subtitleTracks,
        transientSelection: right.transientSelection,
    });
}
