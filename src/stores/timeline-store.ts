import { create } from 'zustand';
import { AnimationStyle, Subtitle, type SubtitleTrack, type SubtitleTrackV4 } from '@/types/timeline';
import { useProjectStore } from './project-store';
import { useVideoStore } from './video-store';
import {
    findSubtitleAcrossTracks,
    generateDefaultGrouperState,
    generateTimelineSubtitles
} from '@/lib/timeline-utils';
import type {
    AudioClip,
    AudioTrack,
    RenderProfile,
    VideoClipAudioSettings,
    VideoClip,
    VideoClipV3,
    EditorDocumentV4,
    VideoSourceAsset,
    VideoTrack,
} from '@/types/video';
import type {
    ResolvedEditorialTranscriptMapV1,
    TransientNarrativeSelectionV1,
} from '@/types/editorial';
import type { EditorPersistentAsset } from '@/lib/storage/storage-service';
import {
    validateEditorDocumentV4,
    validateHydratedEditorDocumentV4,
} from '@/lib/editor-document-v4';
import { migrateLoadedEditorDocumentToV4 } from '@/lib/editor-document-v4-migration';
import {
    createTranscriptionJobGuard,
    getEditorAudioGraphSignature,
    isTranscriptionJobGuardCurrent,
    type AudioGraphMutationImpact,
} from '@/lib/audio-graph-signature';
import {
    createDiarizationProvenanceV1,
    DIARIZATION_PROVENANCE_EXTENSION_KEY,
    getDiarizationProvenanceV1,
    inspectDiarizationProvenance,
    isDiarizationJobGuardCurrent,
} from '@/lib/diarization-provenance';
import {
    DEFAULT_RENDER_BACKGROUND_COLOR,
    createDefaultRenderProfile,
    frameRateToNumber,
    framesToSeconds,
    normalizeFrameRate,
    secondsToFrames,
} from '@/lib/render-profile';
import {
    cloneAudioTracks,
    findAudioClip,
    getAudioClipOutputInterval,
    clampFrameFades,
    clampSampleFades,
} from '@/lib/audio-timeline';
import { frameToOutputSample } from '@/lib/audio-timebase';
import {
    appendVideoClips as appendClipsToTimeline,
    buildClipPlacements,
    cleanSubtitleSelection,
    getTimelineDurations,
    isSafeVideoId,
} from '@/lib/video-timeline';
import {
    applyVideoEditToSubtitleDomains,
    updateSubtitleCommand,
} from '@/lib/editor-commands';
import type {
    DiarizedSpeakerTrackInput,
    TimelinePersistenceBinding,
    TimelineStore,
    TimelineVideoClip,
} from './timeline-store-types';
import {
    DEFAULT_VIDEO_CLIP_AUDIO,
    buildEditorDocumentFromState,
    buildEditorManifestFromState,
    buildLegacyEditorDocumentFromState,
    buildLegacyEditorManifestFromState,
    cloneContainerIds,
    cloneRenderProfile,
    cloneSubtitleTracks as cloneTracks,
    cloneSubtitles,
    cloneTranscriptionByTrackId,
    cloneTranscriptionGroups,
    cloneVideoClips,
    cloneTransientSelection,
    finalizeDurableTimelinePatch as finalizeDurablePatch,
} from './timeline-store-snapshot';
import {
    getLegacyTranscriptionForTrack,
    getTrackTimingDomain,
    selectAudioTimelineSources as getAudioTimelineSources,
    selectTransientSubtitleSelection as transientSubtitleSelection,
} from './timeline-store-selectors';
import { prepareDurableTimelineMutation } from './timeline-store-mutation';
import { applySerializablePatches } from '@/lib/serializable-patch';
import { boundTimelineHistory } from './timeline-history';
import {
    projectTimelineHistory,
    restoreTimelineHistoryProjection,
    selectTimelineHistoryProjection,
    TIMELINE_HISTORY_ROOTS,
} from './timeline-history-projection';
import type { TimelineHistoryEntry, TimelineHistoryMetadata } from './timeline-store-types';
import {
    addVideoTrackMembership,
    canonicalizeVideoTrackClipOrder,
    createDefaultVideoTracks,
    moveVideoClipToNewTrackMembership,
    removeEmptyVideoTrackMembership,
} from '@/lib/video-tracks';
import {
    buildTimelineVideoTrackMirrors,
    normalizeTimelineVideoTrackMirrors,
    projectTransientSelectionMirrorsV4,
    projectVideoClipsV4,
    projectVideoTracksV4,
} from './timeline-v4-compat';
import { getVideoClipPlacementV4 } from '@/lib/video-placement-v4';
import {
    approximateSecondsAsRationalDuration,
    timelineEditorialRuntime,
} from './timeline-editorial-runtime';
import {
    planActivateNarrative,
    planChangeGlobalEditingMode,
    planReleaseNarrativeTracks,
    preflightNarrativeActivationCandidates,
} from '@/lib/narrative/commands';
import { planEditorialLinksForTargetTransforms } from '@/lib/editorial-links';
import {
    EditorialTranscriptionRequestError,
    type EditorialTranscriptionFailureCode,
} from '@/lib/editorial-transcription/request';
import {
    createEditorialLinkCommandGuard,
    createNarrativeCommandGuard,
    createTimelineNarrativeIdFactory,
    createTimelinePatchFromV4Document,
    integrateNarrativeCommandLinks,
    planTimelineEditorialLinkCommand,
    planTimelineNarrativeCommand,
    toTimelineCommandSuccess,
} from './timeline-v4-command-adapter';
import {
    planTimelineOrdinaryV4Command,
    planTimelineSubtitleReplacementV4Command,
    planTimelineVideoReorderV4Command,
    type TimelineOrdinaryPlanResult,
} from './timeline-ordinary-v4-command-adapter';
import type {
    ActivateNarrativeRequest,
    TimelineV4CommandResult,
} from './timeline-v4-command-types';

export type {
    AudioClipEditableSettings,
    DiarizedSpeakerTrackInput,
    MixedMediaCandidate,
    TimelinePersistenceBinding,
    TimelineStore,
    TimelineVideoClip,
} from './timeline-store-types';
export type { DiarizedTranscriptionMetadata } from './timeline-store-types';
export type { TimelineNarrativeActivationProgress } from './timeline-v4-command-types';

let timelinePersistenceBinding: TimelinePersistenceBinding | null = null;

export const createTimelinePersistencePayload = <Manifest extends import('@/types/video').EditorManifestV3 | import('@/types/video').EditorManifestV4 = import('@/types/video').EditorManifestV4>(
    timeline: TimelineStore,
    sourceAssets: readonly EditorPersistentAsset[] = [],
    buildManifest: (state: TimelineStore) => Manifest
        = buildEditorManifestFromState as unknown as (state: TimelineStore) => Manifest,
) => {
    const manifest = buildManifest(timeline);
    return {
        manifest,
        sourceAssets,
        history: {
            history: timeline.history,
            redoStack: timeline.redoStack,
            projection: projectTimelineHistory(timeline),
        },
    };
};

export function setTimelinePersistenceBinding(binding: TimelinePersistenceBinding | null): void {
    timelinePersistenceBinding = binding;
}

const persistEditorMutation = (
    sourceAssets: readonly EditorPersistentAsset[] = [],
    timeline = useTimelineStore.getState(),
) => {
    // Mutations enqueue one canonical V4 document after Zustand has committed the complete state.
    // The same manifest instance feeds dirty revision tracking and persistence, so a keystroke or
    // pointer commit never rebuilds and serializes the full editor graph merely to test dirtiness.
    const payload = createTimelinePersistencePayload(timeline, sourceAssets);
    useProjectStore.getState().checkDirty(payload.manifest.revision);
    if (timelinePersistenceBinding?.enqueueV4) {
        timelinePersistenceBinding.enqueueV4(payload.manifest, payload.sourceAssets, payload.history);
    } else if (timelinePersistenceBinding) {
        // Temporary V3 embedders receive the explicit compatibility projection. Never disguise a
        // descriptor-only V4 manifest as V3 merely to satisfy the legacy callback type.
        const legacy = createTimelinePersistencePayload(
            timeline,
            sourceAssets,
            buildLegacyEditorManifestFromState,
        );
        timelinePersistenceBinding.enqueue(legacy.manifest, legacy.sourceAssets, legacy.history);
    }
};

const persistLegacyEditorMutation = (
    sourceAssets: readonly EditorPersistentAsset[] = [],
    timeline = useTimelineStore.getState(),
) => {
    // This path is intentionally limited to the V3 compatibility adapter. Building the canonical
    // V4 payload first would reject a genuine V3 state before the legacy projection can be queued.
    const payload = createTimelinePersistencePayload(
        timeline,
        sourceAssets,
        buildLegacyEditorManifestFromState,
    );
    useProjectStore.getState().checkDirty(payload.manifest.revision);
    timelinePersistenceBinding?.enqueue(payload.manifest, payload.sourceAssets, payload.history);
};

const sourceFpsToRational = (fps: number) => {
    // Probe metadata is decimal, so recognize standard NTSC-derived rates before applying the
    // general rational approximation. This keeps 29.970029... as 30000/1001 rather than 2997/100.
    const broadcastNumerator = [24_000, 30_000, 60_000, 120_000]
        .find((numerator) => Math.abs(fps - numerator / 1_001) < 0.001);
    if (broadcastNumerator) return { numerator: broadcastNumerator, denominator: 1_001 };
    return normalizeFrameRate({ numerator: Math.max(1, Math.round(fps * 1_000)), denominator: 1_000 });
};

const renderProfileForFirstVideoSource = (source: VideoSourceAsset): RenderProfile => createDefaultRenderProfile({
    fps: sourceFpsToRational(source.fps),
    width: source.width,
    height: source.height,
    isFrameRateLocked: true,
    isCanvasSizeLocked: true,
});

const audioClipsEqual = (left: AudioClip, right: AudioClip): boolean => {
    if (left.id !== right.id
        || left.timelineStartFrame !== right.timelineStartFrame
        || left.muted !== right.muted
        || left.gainDb !== right.gainDb
        || left.source.kind !== right.source.kind) return false;

    if ('sourceStartSample' in left && 'sourceStartSample' in right) {
        return left.source.audioSourceId === right.source.audioSourceId
            && left.sourceStartSample === right.sourceStartSample
            && left.sourceEndSample === right.sourceEndSample
            && left.timelineDurationSamples === right.timelineDurationSamples
            && left.fadeInSamples === right.fadeInSamples
            && left.fadeOutSamples === right.fadeOutSamples;
    }
    if ('sourceStart' in left && 'sourceStart' in right) {
        return left.source.videoSourceId === right.source.videoSourceId
            && left.sourceStart === right.sourceStart
            && left.sourceEnd === right.sourceEnd
            && left.fadeInFrames === right.fadeInFrames
            && left.fadeOutFrames === right.fadeOutFrames;
    }
    return false;
};

type SubtitlePreviewField = 'startTime' | 'endTime' | 'text';

interface SubtitleDragPreviewSession {
    /** Latest durable lane graph after any commands that completed while the pointer was down. */
    durableTracks: SubtitleTrack[];
    /** Latest visual pointer result, used as an overlay and never persisted on its own. */
    previewTracks: SubtitleTrack[];
    touchedFields: Map<string, Set<SubtitlePreviewField>>;
    movedSubtitleIds: Set<string>;
    historyMetadata: TimelineHistoryMetadata;
}

const locateSubtitle = (tracks: readonly SubtitleTrack[], subtitleId: string) => {
    for (const track of tracks) {
        const subtitle = track.subtitles.find((entry) => entry.id === subtitleId);
        if (subtitle) return { trackId: track.id, subtitle };
    }
    return null;
};

const replaceSubtitleLocation = (
    tracks: readonly SubtitleTrack[],
    subtitleId: string,
    targetTrackId: string,
    subtitle: Subtitle,
): SubtitleTrack[] => tracks.map((track) => {
    const withoutSubtitle = track.subtitles.filter((entry) => entry.id !== subtitleId);
    if (track.id !== targetTrackId) {
        return withoutSubtitle.length === track.subtitles.length
            ? track
            : { ...track, subtitles: withoutSubtitle };
    }
    return {
        ...track,
        subtitles: [...withoutSubtitle, subtitle].sort((left, right) => left.startTime - right.startTime),
    };
});

/**
 * Removes only the active pointer overlay from a command's candidate tracks.
 *
 * Commands are allowed to complete while a subtitle is being dragged. They are calculated from
 * the visible graph, so this function compares their candidate with that visible graph to retain
 * real concurrent edits while restoring untouched preview fields from the durable graph.
 */
const removeSubtitlePreviewFromTracks = (
    candidateTracks: readonly SubtitleTrack[],
    visibleTracks: readonly SubtitleTrack[],
    session: SubtitleDragPreviewSession,
): SubtitleTrack[] => {
    let result = candidateTracks.map((track) => ({ ...track, subtitles: [...track.subtitles] }));
    const affectedIds = new Set([
        ...Array.from(session.touchedFields.keys()),
        ...Array.from(session.movedSubtitleIds),
    ]);

    affectedIds.forEach((subtitleId) => {
        const candidate = locateSubtitle(candidateTracks, subtitleId);
        const visible = locateSubtitle(visibleTracks, subtitleId);
        const durable = locateSubtitle(session.durableTracks, subtitleId);

        // A concurrent deletion is durable and must not be undone by the pointer overlay.
        if (!candidate) {
            result = result.map((track) => {
                const subtitles = track.subtitles.filter((entry) => entry.id !== subtitleId);
                return subtitles.length === track.subtitles.length ? track : { ...track, subtitles };
            });
            return;
        }
        if (!durable) return;

        const rebasedSubtitle = { ...candidate.subtitle };
        session.touchedFields.get(subtitleId)?.forEach((field) => {
            if (visible && Object.is(candidate.subtitle[field], visible.subtitle[field])) {
                Object.assign(rebasedSubtitle, { [field]: durable.subtitle[field] });
            }
        });
        const candidateMovedOutsidePreview = visible && candidate.trackId !== visible.trackId;
        const targetTrackId = session.movedSubtitleIds.has(subtitleId) && !candidateMovedOutsidePreview
            ? durable.trackId
            : candidate.trackId;
        if (result.some((track) => track.id === targetTrackId)) {
            result = replaceSubtitleLocation(result, subtitleId, targetTrackId, rebasedSubtitle);
        }
    });
    return result;
};

/** Applies the final pointer intent over the newest durable lane graph. */
const applySubtitlePreviewToDurableTracks = (
    session: SubtitleDragPreviewSession,
): SubtitleTrack[] => {
    let result = session.durableTracks.map((track) => ({ ...track, subtitles: [...track.subtitles] }));
    const affectedIds = new Set([
        ...Array.from(session.touchedFields.keys()),
        ...Array.from(session.movedSubtitleIds),
    ]);

    affectedIds.forEach((subtitleId) => {
        const preview = locateSubtitle(session.previewTracks, subtitleId);
        const durable = locateSubtitle(result, subtitleId);
        if (!preview || !durable) return;

        const finalSubtitle = { ...durable.subtitle };
        session.touchedFields.get(subtitleId)?.forEach((field) => {
            Object.assign(finalSubtitle, { [field]: preview.subtitle[field] });
        });
        const targetTrackId = session.movedSubtitleIds.has(subtitleId)
            ? preview.trackId
            : durable.trackId;
        if (result.some((track) => track.id === targetTrackId)) {
            result = replaceSubtitleLocation(result, subtitleId, targetTrackId, finalSubtitle);
        }
    });
    return result;
};

const subtitlePreviewChangesDurableTracks = (session: SubtitleDragPreviewSession): boolean => {
    for (const [subtitleId, fields] of Array.from(session.touchedFields.entries())) {
        const preview = locateSubtitle(session.previewTracks, subtitleId);
        const durable = locateSubtitle(session.durableTracks, subtitleId);
        if (!preview || !durable) continue;
        for (const field of Array.from(fields)) {
            if (!Object.is(preview.subtitle[field], durable.subtitle[field])) return true;
        }
    }
    for (const subtitleId of Array.from(session.movedSubtitleIds)) {
        const preview = locateSubtitle(session.previewTracks, subtitleId);
        const durable = locateSubtitle(session.durableTracks, subtitleId);
        if (preview && durable && preview.trackId !== durable.trackId) return true;
    }
    return false;
};

const subtitlePreviewRecalculatesContentBoundary = (
    session: SubtitleDragPreviewSession,
): boolean => Array.from(session.touchedFields.values()).some((fields) => (
    fields.has('startTime') || fields.has('endTime')
));

const subtitleUpdatesTiming = (updates: Partial<Subtitle>): boolean => (
    Object.prototype.hasOwnProperty.call(updates, 'startTime')
    || Object.prototype.hasOwnProperty.call(updates, 'endTime')
);

const isValidDiarizedSpeakerTrackInput = (speaker: DiarizedSpeakerTrackInput): boolean => (
    typeof speaker.sourceSpeakerLabel === 'string'
    && speaker.sourceSpeakerLabel.trim().length > 0
    && Array.isArray(speaker.subtitles)
    && Array.isArray(speaker.transcription.raw)
    && Array.isArray(speaker.transcription.containerIds)
    && typeof speaker.transcription.groups === 'object'
    && speaker.transcription.groups !== null
);

/** UUID collisions are vanishingly rare, but deterministic test doubles can intentionally expose them. */
const allocateUniqueEditorId = (reservedIds: ReadonlySet<string>): string => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = crypto.randomUUID();
        if (!reservedIds.has(candidate)) return candidate;
    }
    throw new Error('Unable to allocate a unique subtitle track ID.');
};

const timelineCommandError = (
    code: string,
    message: string,
    ids: string[],
): TimelineV4CommandResult => ({
    kind: 'error',
    error: { code, message, ids: [...ids] },
});

/**
 * Converts only the trusted request error class and its closed code vocabulary into UI copy.
 * Unknown acquisition/parser/internal exceptions deliberately bypass this mapper so their
 * potentially provider-controlled messages can never reach the command result.
 */
const editorialTranscriptionFailureMessage = (
    code: EditorialTranscriptionFailureCode,
    requestMode: ActivateNarrativeRequest['preferences']['requestMode'],
): string => {
    switch (code) {
        case 'network-unreachable':
            return requestMode === 'browser'
                ? 'Could not reach the transcription endpoint from this browser. Check that the service is running and allows CORS requests from this Waptions origin.'
                : 'Could not reach the transcription endpoint from the Waptions server. Check that the service is running and reachable from the server.';
        case 'provider-unauthorized':
            return 'The transcription provider rejected the API key. Enter a valid API key, or leave it empty if this endpoint does not require one.';
        case 'provider-forbidden':
            return 'The transcription provider denied access. Check the API key permissions and endpoint access.';
        case 'provider-not-found':
            return 'The transcription endpoint was not found. Check the configured endpoint path.';
        case 'provider-rate-limited':
            return 'The transcription provider is rate limiting requests. Wait and try again.';
        case 'provider-rejected':
            return 'The transcription provider rejected the request. Check that it supports the required OpenAI-compatible transcription request.';
        case 'provider-unavailable':
            return 'The transcription provider is unavailable. Check the service and try again.';
        case 'provider-timeout':
            return 'The transcription provider took too long to respond. Check that the service is still running, then try again.';
    }
};

const timelineEditorialTranscriptionError = (
    error: EditorialTranscriptionRequestError,
    requestMode: ActivateNarrativeRequest['preferences']['requestMode'],
): TimelineV4CommandResult => timelineCommandError(
    `editorial-transcription-${error.code}`,
    editorialTranscriptionFailureMessage(error.code, requestMode),
    [],
);

const timelineCommandNoop = (): TimelineV4CommandResult => ({
    kind: 'noop',
    code: 'unchanged',
    history: { createEntry: false, label: null, mergeKey: null },
    persistence: { enqueue: false },
});

/** Optional caller guards fail before acquisition, graph planning, pins, or persistence. */
const validateRequestedNarrativeGuard = (
    document: EditorDocumentV4,
    request: ActivateNarrativeRequest,
): TimelineV4CommandResult | null => {
    if (request.expectedDocumentRevision !== undefined
        && request.expectedDocumentRevision !== document.revision) {
        return timelineCommandError('stale-document', 'Document revision changed before activation.', []);
    }
    if (request.expectedMode !== undefined && request.expectedMode !== document.globalEditingMode) {
        return timelineCommandError('stale-mode', 'Global editing mode changed before activation.', []);
    }
    if (request.expectedNarrativeRevision !== undefined
        && request.expectedNarrativeRevision !== document.narrative?.revision) {
        return timelineCommandError('stale-narrative', 'Narrative revision changed before activation.', []);
    }
    return null;
};

/**
 * Compares only project-time coverage, not lane ownership or selection. A pure cross-track move
 * therefore keeps the content-boundary token stable, while every split/delete/trim/translation
 * still invalidates consumers that cache the terminal project interval.
 */
const timelineIntervalsEqual = (left: EditorDocumentV4, right: EditorDocumentV4): boolean => {
    const project = (document: EditorDocumentV4) => {
        const sources = {
            videoSources: document.videoSources,
            audioSources: document.audioSources,
        };
        return {
            video: document.videoClips.map((clip) => {
                const placement = getVideoClipPlacementV4(document, clip);
                return [clip.id, placement.startFrame, placement.endFrame] as const;
            }).sort(([leftId], [rightId]) => leftId.localeCompare(rightId)),
            audio: document.audioTracks.flatMap((track) => track.clips.map((clip) => {
                const located = findAudioClip(document.audioTracks, sources, clip.id);
                if (!located) throw new Error(`Audio clip "${clip.id}" cannot be projected.`);
                const interval = getAudioClipOutputInterval(clip, located.source, document.renderProfile);
                return [clip.id, interval.startSample, interval.endSample] as const;
            })).sort(([leftId], [rightId]) => leftId.localeCompare(rightId)),
            subtitles: document.subtitleTracks.flatMap((track) => track.subtitles.map((subtitle) => [
                subtitle.id,
                subtitle.startTime,
                subtitle.endTime,
            ] as const)).sort(([leftId], [rightId]) => leftId.localeCompare(rightId)),
        };
    };
    try {
        return JSON.stringify(project(left)) === JSON.stringify(project(right));
    } catch {
        return false;
    }
};

const projectSubtitleTracksV4 = (tracks: readonly SubtitleTrack[]): SubtitleTrackV4[] => (
    tracks.map((track) => {
        const candidate = track as SubtitleTrack & {
            timingDomain?: 'video-ripple' | 'absolute';
            unlinkedVideoEditResponse?: SubtitleTrackV4['unlinkedVideoEditResponse'];
        };
        const { timingDomain: _timingDomain, ...base } = candidate;
        void _timingDomain;
        return {
            ...structuredClone(base),
            unlinkedVideoEditResponse: candidate.unlinkedVideoEditResponse
                ?? (getTrackTimingDomain(track) === 'absolute'
                    ? 'stay-absolute'
                    : 'follow-project-ripple'),
        } as SubtitleTrackV4;
    })
);

/**
 * Builds a runtime-only narrative selection after proving every requested identity against the
 * current owned block and hydrated immutable transcript body. The caller receives `null` instead
 * of a partially repaired selection so stale Text events can never overwrite newer UI state.
 */
const createValidatedNarrativeSelection = (
    state: TimelineStore,
    blockId: string,
    sourceWordIds: readonly string[],
    boundary?: TransientNarrativeSelectionV1['boundary'],
): { selection: TransientNarrativeSelectionV1; clipId: string } | null => {
    if (!Array.isArray(sourceWordIds)) return null;
    const document = buildEditorDocumentFromState(state);
    const narrative = document.narrative;
    const block = narrative?.blocks[blockId];
    if (!block || !narrative.controlledTrackIds.includes(block.trackId)) return null;

    const wordIndexById = new Map(block.sourceWordIds.map((wordId, index) => [wordId, index]));
    let previousWordIndex = -1;
    for (const wordId of sourceWordIds) {
        const wordIndex = wordIndexById.get(wordId);
        if (wordIndex === undefined || wordIndex <= previousWordIndex) return null;
        previousWordIndex = wordIndex;
    }

    const requestedBoundary = boundary ?? null;
    const bodies = timelineEditorialRuntime.getResolvedBodies();
    if (requestedBoundary) {
        const body = bodies[block.transcriptRecordId];
        const selectedBoundary = body?.editBoundaries.find((value) => (
            value.id === requestedBoundary.boundaryId
        ));
        if (!selectedBoundary
            || selectedBoundary.sample < block.coreStartSample
            || selectedBoundary.sample > block.coreEndSample) return null;
    }
    const selection: TransientNarrativeSelectionV1 = {
        kind: 'narrative',
        trackId: block.trackId,
        blockId: block.id,
        sourceWordIds: [...sourceWordIds],
        boundary: requestedBoundary ? { ...requestedBoundary } : null,
    };
    const validation = validateHydratedEditorDocumentV4({
        ...document,
        transientSelection: selection,
    }, bodies);
    return validation.valid ? { selection, clipId: block.clipId } : null;
};

export const useTimelineStore = create<TimelineStore>((set, get) => {
    let subtitleDragPreview: SubtitleDragPreviewSession | null = null;

    const commitDurableMutation = (
        state: TimelineStore,
        patch: Partial<TimelineStore>,
        options: {
            impact?: AudioGraphMutationImpact;
            recordHistory?: boolean;
            history?: TimelineHistoryMetadata;
            sourceAssets?: readonly EditorPersistentAsset[];
            persist?: boolean;
            persistLegacyV3?: boolean;
            recalculateContentBoundary?: boolean;
        } = {},
    ): boolean => {
        const preview = subtitleDragPreview;
        const durableState = preview
            ? { ...state, tracks: preview.durableTracks }
            : state;
        const previewAdjustedPatch = preview && patch.tracks
            ? {
                ...patch,
                tracks: removeSubtitlePreviewFromTracks(patch.tracks, state.tracks, preview),
            }
            : patch;
        const subtitleNormalizedPatch = previewAdjustedPatch.tracks
            ? {
                ...previewAdjustedPatch,
                tracks: previewAdjustedPatch.tracks.map((track) => {
                    const unlinkedVideoEditResponse = ('unlinkedVideoEditResponse' in track
                        ? track.unlinkedVideoEditResponse
                        : undefined)
                        ?? (getTrackTimingDomain(track) === 'absolute'
                            ? 'stay-absolute'
                            : 'follow-project-ripple');
                    return {
                        ...track,
                        unlinkedVideoEditResponse,
                        timingDomain: unlinkedVideoEditResponse === 'follow-project-ripple'
                            ? 'video-ripple' as const
                            : 'absolute' as const,
                    };
                }),
            }
            : previewAdjustedPatch;
        const durablePatch = subtitleNormalizedPatch.videoTracks
            ? {
                ...subtitleNormalizedPatch,
                videoTracks: normalizeTimelineVideoTrackMirrors(subtitleNormalizedPatch.videoTracks),
            }
            : subtitleNormalizedPatch;
        const prepared = prepareDurableTimelineMutation(durableState, durablePatch, options);
        if (!prepared) return false;

        const committedDurableState = { ...durableState, ...prepared } as TimelineStore;
        if (preview) {
            preview.durableTracks = committedDurableState.tracks;
            const visibleTracks = applySubtitlePreviewToDurableTracks(preview);
            preview.previewTracks = visibleTracks;
            set({ ...prepared, tracks: visibleTracks });
        } else {
            set(prepared);
        }
        // Persistence reads the complete committed state. Keeping the enqueue after set prevents a
        // manifest from observing only one half of a linked video/audio or provenance mutation.
        if (options.persist !== false) {
            if (options.persistLegacyV3) {
                persistLegacyEditorMutation(options.sourceAssets, committedDurableState);
            } else {
                persistEditorMutation(options.sourceAssets, committedDurableState);
            }
        }
        return true;
    };

    /**
     * Removes an in-flight subtitle overlay before a history command reads the current state.
     *
     * Undo/redo snapshots must be built from the latest durable graph, never from pointer-only
     * timing. Clearing the closure-owned preview also makes the browser's eventual mouseup a
     * strict no-op instead of letting it reapply stale tracks over the restored history state.
     */
    const discardActiveDragPreview = (): TimelineStore => {
        const state = get();
        const preview = subtitleDragPreview;
        subtitleDragPreview = null;
        if (!preview && !state.isDragging) return state;

        const tracks = preview?.durableTracks ?? state.tracks;
        const recalculatesContentBoundary = preview
            ? subtitlePreviewRecalculatesContentBoundary(preview)
            : false;
        const transientSelection = state.transientSelection.kind === 'subtitles'
            ? transientSubtitleSelection(tracks, state.selectedSubtitleIds, state.activeTrackId)
            : state.transientSelection;
        const durableState = {
            ...state,
            tracks,
            transientSelection,
            isDragging: false,
            contentBoundaryRevision: recalculatesContentBoundary
                ? state.contentBoundaryRevision + 1
                : state.contentBoundaryRevision,
        } as TimelineStore;
        set({
            tracks,
            transientSelection,
            isDragging: false,
            ...(recalculatesContentBoundary
                ? { contentBoundaryRevision: durableState.contentBoundaryRevision }
                : {}),
        });
        return durableState;
    };

    /**
     * Ordinary commands preflight against the durable subtitle graph hidden underneath a pointer
     * preview. The visible state is still passed to the commit boundary so a successful unrelated
     * command can rebase that overlay, while an error/no-op leaves every preview byte untouched.
     */
    const getOrdinaryPlanningState = (state: TimelineStore): TimelineStore => (
        subtitleDragPreview
            ? { ...state, tracks: subtitleDragPreview.durableTracks } as TimelineStore
            : state
    );

    /**
     * Publishes a complete detached V4 proposal through the one existing durable transaction.
     * Planner-owned speculative revisions are intentionally ignored: prepareDurableTimelineMutation
     * remains the sole authority for revision, audioGraphRevision, history, and persistence enqueue.
     */
    const commitV4CommandDocument = (input: {
        state: TimelineStore;
        document: EditorDocumentV4;
        historyLabel: string;
        mergeKey?: string;
        audioGraph: boolean;
        recalculateContentBoundary: boolean;
    }): boolean => {
        const patch = createTimelinePatchFromV4Document(
            input.document,
            timelineEditorialRuntime.getResolvedBodies(),
        );
        return commitDurableMutation(input.state, patch, {
            impact: input.audioGraph ? 'invalidate-transcription' : 'preserve-transcription',
            history: {
                label: input.historyLabel,
                ...(input.mergeKey ? { mergeKey: input.mergeKey } : {}),
            },
            recalculateContentBoundary: input.recalculateContentBoundary,
        });
    };

    /** Integrates WP5 and publishes any ordinary V4 proposal through the sole durable boundary. */
    const commitOrdinaryPlan = (input: {
        state: TimelineStore;
        before: EditorDocumentV4;
        planned: TimelineOrdinaryPlanResult;
        history?: TimelineHistoryMetadata;
    }): TimelineV4CommandResult => {
        if (input.planned.kind === 'error') return input.planned;
        if (input.planned.kind === 'noop') return timelineCommandNoop();
        let document = input.planned.document;
        if (input.before.narrative) {
            const integrated = planEditorialLinksForTargetTransforms({
                before: input.before,
                afterTargetCommand: document,
                guard: createEditorialLinkCommandGuard(input.before),
                targetTransforms: input.planned.targetTransforms,
            });
            if (integrated.kind === 'error') return integrated;
            if (integrated.kind === 'success') document = integrated.document;
        }
        try {
            const committed = commitV4CommandDocument({
                state: input.state,
                document,
                historyLabel: input.history?.label ?? input.planned.label,
                ...(input.history?.mergeKey ? { mergeKey: input.history.mergeKey } : {}),
                audioGraph: input.planned.audioGraph,
                recalculateContentBoundary: !timelineIntervalsEqual(input.before, document),
            });
            return committed
                ? {
                    kind: 'success',
                    command: input.planned.command,
                    playhead: input.planned.playhead,
                    targetTransforms: structuredClone(input.planned.targetTransforms),
                }
                : timelineCommandNoop();
        } catch {
            return timelineCommandError('invalid-proposal', 'Ordinary command produced an invalid V4 graph.', []);
        }
    };

    const planAndCommitSubtitleReplacement = (input: {
        state: TimelineStore;
        tracks: SubtitleTrack[];
        activeTrackId: string | null;
        transientSelection: TimelineStore['transientSelection'];
        history: TimelineHistoryMetadata;
    }): TimelineV4CommandResult => {
        const before = buildEditorDocumentFromState(input.state);
        const planned = planTimelineSubtitleReplacementV4Command(before, {
            subtitleTracks: projectSubtitleTracksV4(input.tracks),
            activeSubtitleTrackId: input.activeTrackId,
            transientSelection: cloneTransientSelection(input.transientSelection),
            label: input.history.label,
        });
        return commitOrdinaryPlan({
            state: input.state,
            before,
            planned,
            history: input.history,
        });
    };

    return ({
    zoomLevel: 1,
    scrollLeft: 0,
    pixelsPerSecond: 100, // Base pixels per second at zoom 1
    tracks: [],
    activeTrackId: null,
    selectedSubtitleIds: [],
    selectedClipId: null,
    revision: 1,
    audioGraphRevision: 0,
    contentBoundaryRevision: 0,
    projectFps: 30,
    renderProfile: createDefaultRenderProfile(),
    renderBackgroundColor: DEFAULT_RENDER_BACKGROUND_COLOR,
    videoSources: [],
    videoClips: [],
    videoTracks: normalizeTimelineVideoTrackMirrors(createDefaultVideoTracks([])),
    audioSources: [],
    audioTracks: [],
    transientSelection: { kind: 'none' },
    transcriptionByTrackId: {},
    globalEditingMode: 'ripple',
    editorialTranscriptDescriptors: [],
    narrative: null,
    dependentLinks: [],
    lastSelectedId: null,
    snapEnabled: true,
    activeSnapTime: null,
    clipboard: null,
    requestEditSubtitleId: null,

    history: [],
    redoStack: [],
    historySequence: 0,
    historyBytes: 0,

    rawTranscription: null,
    transcriptionGroups: null,
    transcriptionContainerIds: null,

    cuts: [],
    detectionProgress: 0,
    isDetecting: false,
    isVideoSelected: false,
    isDragging: false,

    setZoom: (zoom) => set({ zoomLevel: Math.max(0.1, Math.min(10, zoom)) }),
    setScrollLeft: (scroll) => set({ scrollLeft: scroll }),

    undo: async () => {
        const state = discardActiveDragPreview();
        const { history, redoStack } = state;
        if (history.length === 0) return;

        const entry = history[history.length - 1];
        const projection = applySerializablePatches(
            selectTimelineHistoryProjection(state),
            entry.inversePatches,
            TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
        );
        const boundedHistory = boundTimelineHistory({
            history: history.slice(0, -1),
            redoStack: [...redoStack, entry],
            historySequence: state.historySequence,
            historyBytes: state.historyBytes,
        });
        const restored = restoreTimelineHistoryProjection(projection);
        const document = buildEditorDocumentFromState({ ...state, ...restored } as TimelineStore);
        const runtimeContext = timelineEditorialRuntime.getProjectContext();
        let bodies: ResolvedEditorialTranscriptMapV1;
        try {
            bodies = await timelineEditorialRuntime.resolveDocumentDetached(document);
        } catch {
            // Missing/corrupt CAS data leaves both the graph and history cursor untouched. The
            // Project store surfaces load/recovery failures; history UI intentionally has no
            // unhandled rejection because its actions are fire-and-forget.
            return;
        }
        // CAS reads are asynchronous. A normal durable command may finish while the target
        // projection is hydrating without changing the runtime resolver generation, so guard the
        // publication against the exact store revision captured above as well.
        if (get().revision !== state.revision) return;
        if (!timelineEditorialRuntime.publishResolvedDocument(
            document,
            bodies,
            runtimeContext,
            () => set({
                ...finalizeDurablePatch(
                    state,
                    restored,
                    entry.audioGraphMutationImpact,
                    entry.recalculatesContentBoundary,
                ),
                ...boundedHistory,
            }),
        )) return;
        persistEditorMutation();
    },

    redo: async () => {
        const state = discardActiveDragPreview();
        const { history, redoStack } = state;
        if (redoStack.length === 0) return;

        const entry = redoStack[redoStack.length - 1];
        const projection = applySerializablePatches(
            selectTimelineHistoryProjection(state),
            entry.patches,
            TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
        );
        const boundedHistory = boundTimelineHistory({
            history: [...history, entry],
            redoStack: redoStack.slice(0, -1),
            historySequence: state.historySequence,
            historyBytes: state.historyBytes,
        });
        const restored = restoreTimelineHistoryProjection(projection);
        const document = buildEditorDocumentFromState({ ...state, ...restored } as TimelineStore);
        const runtimeContext = timelineEditorialRuntime.getProjectContext();
        let bodies: ResolvedEditorialTranscriptMapV1;
        try {
            bodies = await timelineEditorialRuntime.resolveDocumentDetached(document);
        } catch {
            return;
        }
        if (get().revision !== state.revision) return;
        if (!timelineEditorialRuntime.publishResolvedDocument(
            document,
            bodies,
            runtimeContext,
            () => set({
                ...finalizeDurablePatch(
                    state,
                    restored,
                    entry.audioGraphMutationImpact,
                    entry.recalculatesContentBoundary,
                ),
                ...boundedHistory,
            }),
        )) return;
        persistEditorMutation();
    },

    jumpToHistoryEntry: async (entryId) => {
        const state = discardActiveDragPreview();
        const chronological = [...state.history, ...[...state.redoStack].reverse()];
        const targetCount = entryId === null
            ? 0
            : chronological.findIndex((entry) => entry.id === entryId) + 1;
        if (targetCount < 0 || (entryId !== null && targetCount === 0)) return;
        if (targetCount === state.history.length) return;

        let projection = selectTimelineHistoryProjection(state);
        let history: TimelineHistoryEntry[];
        let redoStack: TimelineHistoryEntry[];
        let affected: TimelineHistoryEntry[];
        if (targetCount < state.history.length) {
            affected = state.history.slice(targetCount);
            [...affected].reverse().forEach((entry) => {
                projection = applySerializablePatches(
                    projection,
                    entry.inversePatches,
                    TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
                );
            });
            history = state.history.slice(0, targetCount);
            redoStack = [...state.redoStack, ...[...affected].reverse()];
        } else {
            const count = targetCount - state.history.length;
            affected = state.redoStack.slice(-count).reverse();
            affected.forEach((entry) => {
                projection = applySerializablePatches(
                    projection,
                    entry.patches,
                    TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
                );
            });
            history = [...state.history, ...affected];
            redoStack = state.redoStack.slice(0, -count);
        }

        const impact = affected.some((entry) => entry.audioGraphMutationImpact === 'invalidate-transcription')
            ? 'invalidate-transcription'
            : 'preserve-transcription';
        const recalculatesContentBoundary = affected.some((entry) => entry.recalculatesContentBoundary);
        const bounded = boundTimelineHistory({
            history,
            redoStack,
            historySequence: state.historySequence,
            historyBytes: state.historyBytes,
        });
        const restored = restoreTimelineHistoryProjection(projection);
        const document = buildEditorDocumentFromState({ ...state, ...restored } as TimelineStore);
        const runtimeContext = timelineEditorialRuntime.getProjectContext();
        let bodies: ResolvedEditorialTranscriptMapV1;
        try {
            bodies = await timelineEditorialRuntime.resolveDocumentDetached(document);
        } catch {
            return;
        }
        if (get().revision !== state.revision) return;
        if (!timelineEditorialRuntime.publishResolvedDocument(
            document,
            bodies,
            runtimeContext,
            () => set({
                ...finalizeDurablePatch(
                    state,
                    restored,
                    impact,
                    recalculatesContentBoundary,
                ),
                ...bounded,
            }),
        )) return;
        persistEditorMutation();
    },

    addTrack: (name, style, options) => {
        const state = get();
        const id = crypto.randomUUID();
        const defaultStyle: AnimationStyle = style || {
            fadeInDuration: 0.2,
            fadeOutDuration: 0.2,
            initialScale: 1.5,
            bounceStrength: 1.7,
            useElasticEffect: true,
            fontSize: 48,
            textColor: '#FFF50B',
            strokeWidth: 6,
            strokeColor: '#000000',
            fontWeight: 800,
            textCase: 'uppercase',
            textAlign: 'center',
            hidePunctuation: false,
            punctuationChars: '¿?:-,.;¡!',
            removeAccents: false,
            fontFamily: 'Arial',
            numberOfLines: 1,
            position: { x: 50, y: 80 },
            backgroundColor: '#000000',
            backgroundOpacity: 0.5,
            backgroundBorderColor: '#FFF50B',
            backgroundBorderWidth: 2,
            backgroundMarginVertical: 8,
            backgroundMarginHorizontal: 16,
            backgroundBorderRadius: 8,
            backgroundOffsetX: 0,
            backgroundOffsetY: 0
        };

        commitDurableMutation(state, {
            tracks: [...state.tracks, {
                id,
                name: name || `Capa ${state.tracks.length + 1}`,
                style: defaultStyle,
                subtitles: [],
                isVisible: true,
                isLocked: false,
                // New subtitle lanes default to absolute response. Following an uncontrolled
                // video ripple is an explicit visible policy, never an implicit second mode.
                unlinkedVideoEditResponse: 'stay-absolute',
            }],
            activeTrackId: id,
        }, {
            recordHistory: !options?.skipHistory,
            history: { label: 'Add subtitle track' },
        });
        return id;
    },

    removeTrack: (id) => {
        const state = get();
        const removedTrack = state.tracks.find((track) => track.id === id);
        if (!removedTrack) return;
        const nextTracks = state.tracks.filter((track) => track.id !== id);
        const nextActiveId = state.activeTrackId === id
            ? nextTracks[0]?.id ?? null
            : state.activeTrackId;
        const transcriptionByTrackId = { ...state.transcriptionByTrackId };
        delete transcriptionByTrackId[id];
        const legacy = getLegacyTranscriptionForTrack(transcriptionByTrackId, nextActiveId);
        const selectedSubtitleIds = cleanSubtitleSelection(state.selectedSubtitleIds, nextTracks);

        commitDurableMutation(state, {
            tracks: nextTracks,
            activeTrackId: nextActiveId,
            selectedSubtitleIds,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(nextTracks, selectedSubtitleIds, nextActiveId)
                : state.transientSelection,
            transcriptionByTrackId,
            rawTranscription: cloneSubtitles(legacy?.raw ?? null),
            transcriptionGroups: cloneTranscriptionGroups(legacy?.groups ?? null),
            transcriptionContainerIds: cloneContainerIds(legacy?.containerIds ?? null),
        }, {
            history: { label: 'Remove subtitle track' },
            recalculateContentBoundary: removedTrack.subtitles.length > 0,
        });
    },

    updateTrackStyle: (id, styleUpdates) => {
        const state = get();
        const track = state.tracks.find((item) => item.id === id);
        if (!track || Object.entries(styleUpdates).every(([key, value]) => (
            Object.is(track.style[key as keyof AnimationStyle], value)
        ))) return;
        commitDurableMutation(state, {
            tracks: state.tracks.map((track) => track.id === id
                ? { ...track, style: { ...track.style, ...styleUpdates } }
                : track),
        }, { history: { label: 'Edit subtitle style' } });
    },

    updateTrackName: (id, name) => {
        const state = get();
        const track = state.tracks.find((item) => item.id === id);
        if (!track || track.name === name) return;
        commitDurableMutation(state, {
            tracks: state.tracks.map((track) => track.id === id ? { ...track, name } : track),
        }, { history: { label: 'Rename subtitle track', mergeKey: `subtitle-track-name:${id}` } });
    },

    addSubtitleToTrack: (trackId, subtitle) => {
        const newId = crypto.randomUUID();
        const state = get();
        const tracks = state.tracks.map((track) => track.id === trackId
                ? { ...track, subtitles: [...track.subtitles, { ...subtitle, id: newId }] }
                : track);
        const result = planAndCommitSubtitleReplacement({
            state,
            tracks,
            activeTrackId: state.activeTrackId,
            transientSelection: state.transientSelection,
            history: { label: 'Add subtitle' },
        });
        return result.kind === 'success' ? newId : '';
    },

    updateSubtitleInTrack: (trackId, subtitleId, updates, options) => {
        const state = get();
        const preview = subtitleDragPreview;
        if (options?.skipHistory && (!state.isDragging || !preview)) {
            // `skipHistory` belongs exclusively to the pointer-preview protocol. A history
            // command invalidates that protocol synchronously, so a late window mousemove must
            // not fall through into an untracked durable mutation after Undo or Redo.
            return;
        }
        const tracks = updateSubtitleCommand(state.tracks, trackId, subtitleId, updates);
        if (!tracks) return;
        if (options?.skipHistory && preview) {
            // Pointer movement is a visual preview. The terminal setIsDragging(false) call folds
            // every intermediate position into one revision and one persistence transaction.
            const touched = preview.touchedFields.get(subtitleId) ?? new Set();
            (['startTime', 'endTime', 'text'] as const).forEach((field) => {
                if (Object.prototype.hasOwnProperty.call(updates, field)) touched.add(field);
            });
            preview.touchedFields.set(subtitleId, touched);
            preview.previewTracks = tracks;
            set({
                tracks,
                // Preview timing is visible to the audio transport immediately. Incrementing the
                // token keeps its cached terminal frame exact without persisting pointer noise.
                ...(subtitleUpdatesTiming(updates)
                    ? { contentBoundaryRevision: state.contentBoundaryRevision + 1 }
                    : {}),
            });
            return;
        }
        planAndCommitSubtitleReplacement({
            state,
            tracks,
            activeTrackId: state.activeTrackId,
            transientSelection: state.transientSelection,
            history: {
                label: subtitleUpdatesTiming(updates) ? 'Edit subtitle timing' : 'Edit subtitle',
            },
        });
    },

    moveSubtitleToTrack: (subtitleId, sourceTrackId, targetTrackId) => {
        if (sourceTrackId === targetTrackId) return;

        const state = get();
        const sourceTrack = state.tracks.find(t => t.id === sourceTrackId);
        const targetTrack = state.tracks.find(t => t.id === targetTrackId);
        if (!sourceTrack || !targetTrack || !sourceTrack.subtitles.some(s => s.id === subtitleId)) return;

        let movedSubtitle: Subtitle | null = null;

        const tracksWithSourcedRemoved = state.tracks.map((track) => {
            if (track.id === sourceTrackId) {
                const subtitle = track.subtitles.find((item) => item.id === subtitleId);
                if (subtitle) movedSubtitle = { ...subtitle };
                return { ...track, subtitles: track.subtitles.filter((item) => item.id !== subtitleId) };
            }
            return track;
        });

        if (!movedSubtitle) return;

        const finalTracks = tracksWithSourcedRemoved.map((track) => track.id === targetTrackId
            ? {
                ...track,
                subtitles: [...track.subtitles, movedSubtitle!].sort((a, b) => a.startTime - b.startTime),
            }
            : track);

        planAndCommitSubtitleReplacement({
            state,
            tracks: finalTracks,
            activeTrackId: targetTrackId,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(finalTracks, state.selectedSubtitleIds, targetTrackId)
                : state.transientSelection,
            history: { label: 'Move subtitle to track' },
        });
    },

    moveSubtitlesToTrack: (subtitleIds, deltaTrackIndex, options) => {
        if (deltaTrackIndex === 0 || subtitleIds.length === 0) return;

        const state = get();
        const preview = subtitleDragPreview;
        if (options?.skipHistory && (!state.isDragging || !preview)) {
            // Vertical lane moves use the same preview-only contract as timing changes. Once
            // history cancellation clears the preview, stale pointer delivery is ignored rather
            // than persisted without a corresponding history entry.
            return;
        }

        const currentTracks = state.tracks;
        const trackIds = currentTracks.map(t => t.id);
        const subtitleTrackIndexes = subtitleIds.flatMap(subtitleId => {
            const currentTrackIndex = currentTracks.findIndex(track =>
                track.subtitles.some(subtitle => subtitle.id === subtitleId)
            );
            return currentTrackIndex === -1 ? [] : [currentTrackIndex];
        });

        if (
            subtitleTrackIndexes.length === 0 ||
            subtitleTrackIndexes.some(currentTrackIndex => {
                const targetIndex = currentTrackIndex + deltaTrackIndex;
                return targetIndex < 0 || targetIndex >= trackIds.length;
            })
        ) return;

        const currentTracksForMutation = state.tracks;
        const subtitleLocations = new Map<string, { trackId: string, subtitle: Subtitle }>();

        // 1. Locate all subtitles to move
        currentTracksForMutation.forEach(track => {
            track.subtitles.forEach(s => {
                if (subtitleIds.includes(s.id)) {
                    subtitleLocations.set(s.id, { trackId: track.id, subtitle: { ...s } });
                }
            });
        });

        // 2. Identify target tracks and check bounds
        const mutationTrackIds = currentTracksForMutation.map(t => t.id);
        const updates = new Map<string, string>(); // subtitleId -> newTrackId

        for (const [sId, loc] of Array.from(subtitleLocations.entries())) {
            const currentIdx = mutationTrackIds.indexOf(loc.trackId);
            const targetIdx = currentIdx + deltaTrackIndex;

            if (targetIdx < 0 || targetIdx >= trackIds.length) {
                // If any subtitle would leave the lane set, cancel the complete group command.
                return;
            }
            updates.set(sId, mutationTrackIds[targetIdx]);
        }

        // 3. Perform the move
        const newTracks = currentTracksForMutation.map(track => {
            // Remove subtitles that are moving OUT of this track
            let subtitles = track.subtitles.filter(s => !updates.has(s.id) || updates.get(s.id) === track.id);

            // Add subtitles that are moving IN to this track
            const movingIn = Array.from(updates.entries())
                .filter(([, tId]) => tId === track.id)
                .map(([sId]) => subtitleLocations.get(sId)!.subtitle);

            if (movingIn.length > 0) {
                subtitles = [...subtitles, ...movingIn].sort((a, b) => a.startTime - b.startTime);
            }

            return { ...track, subtitles };
        });

        if (options?.skipHistory && preview) {
            subtitleIds.forEach((subtitleId) => preview.movedSubtitleIds.add(subtitleId));
            preview.previewTracks = newTracks;
            set({
                tracks: newTracks,
                transientSelection: state.transientSelection.kind === 'subtitles'
                    ? transientSubtitleSelection(newTracks, state.selectedSubtitleIds, state.activeTrackId)
                    : state.transientSelection,
            });
            return;
        }

        planAndCommitSubtitleReplacement({
            state,
            tracks: newTracks,
            activeTrackId: state.activeTrackId,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(newTracks, state.selectedSubtitleIds, state.activeTrackId)
                : state.transientSelection,
            history: { label: 'Move subtitles between tracks' },
        });
    },

    removeSubtitleFromTrack: (trackId, subtitleId) => {
        const state = get();
        const track = state.tracks.find(t => t.id === trackId);
        if (!track?.subtitles.some(s => s.id === subtitleId)) return;
        const tracks = state.tracks.map(t => t.id === trackId
            ? { ...t, subtitles: t.subtitles.filter(s => s.id !== subtitleId) }
            : t);
        const selectedSubtitleIds = state.selectedSubtitleIds.filter(id => id !== subtitleId);
        planAndCommitSubtitleReplacement({
            state,
            tracks,
            activeTrackId: state.activeTrackId,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(tracks, selectedSubtitleIds, state.activeTrackId)
                : state.transientSelection,
            history: { label: 'Delete subtitle' },
        });
    },

    hydrateEditorDocument: (document, historyState) => {
        const migrated = migrateLoadedEditorDocumentToV4(document);
        const validation = validateEditorDocumentV4(migrated);
        if (!validation.valid) {
            throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
        }
        const provenance = cloneTranscriptionByTrackId(migrated.transcriptionByTrackId);
        const legacy = getLegacyTranscriptionForTrack(provenance, migrated.activeSubtitleTrackId);
        const projectFps = frameRateToNumber(migrated.renderProfile.fps);
        const tracks = cloneTracks(migrated.subtitleTracks);
        const contentBoundaryRevision = get().contentBoundaryRevision + 1;
        const transientSelection = cloneTransientSelection(migrated.transientSelection);
        const selectionMirrors = projectTransientSelectionMirrorsV4(
            transientSelection,
            migrated.narrative,
        );
        set({
            revision: migrated.revision,
            audioGraphRevision: migrated.audioGraphRevision,
            contentBoundaryRevision,
            projectFps,
            renderProfile: cloneRenderProfile(migrated.renderProfile),
            renderBackgroundColor: migrated.renderBackgroundColor,
            tracks,
            videoSources: migrated.videoSources.map((source) => ({ ...source })),
            videoClips: cloneVideoClips(migrated.videoClips),
            videoTracks: buildTimelineVideoTrackMirrors(migrated.videoTracks, migrated.videoClips),
            audioSources: migrated.audioSources.map((source) => ({ ...source })),
            audioTracks: cloneAudioTracks(migrated.audioTracks),
            // Durable manifests intentionally omit selection; direct runtime hydration accepts
            // a validated selection but keeps the legacy mirror fields synchronized with it.
            transientSelection,
            activeTrackId: migrated.activeSubtitleTrackId,
            ...selectionMirrors,
            transcriptionByTrackId: provenance,
            rawTranscription: cloneSubtitles(legacy?.raw ?? null),
            transcriptionGroups: cloneTranscriptionGroups(legacy?.groups ?? null),
            transcriptionContainerIds: cloneContainerIds(legacy?.containerIds ?? null),
            history: historyState?.history ?? [],
            redoStack: historyState?.redoStack ?? [],
            historySequence: historyState?.historySequence ?? 0,
            historyBytes: historyState?.historyBytes ?? 0,
            globalEditingMode: migrated.globalEditingMode,
            editorialTranscriptDescriptors: structuredClone(migrated.editorialTranscriptDescriptors),
            narrative: structuredClone(migrated.narrative),
            dependentLinks: structuredClone(migrated.dependentLinks),
            isDragging: false,
        });
        subtitleDragPreview = null;
        useVideoStore.getState().syncSourceCatalog(migrated.videoSources);
    },

    resetEditorDocument: () => {
        const contentBoundaryRevision = get().contentBoundaryRevision + 1;
        const renderProfile = createDefaultRenderProfile();
        set({
            revision: 1,
            audioGraphRevision: 0,
            contentBoundaryRevision,
            projectFps: frameRateToNumber(renderProfile.fps),
            renderProfile,
            renderBackgroundColor: DEFAULT_RENDER_BACKGROUND_COLOR,
            tracks: [],
            videoSources: [],
            videoClips: [],
            videoTracks: normalizeTimelineVideoTrackMirrors(createDefaultVideoTracks([])),
            audioSources: [],
            audioTracks: [],
            transientSelection: { kind: 'none' },
            activeTrackId: null,
            selectedSubtitleIds: [],
            selectedClipId: null,
            transcriptionByTrackId: {},
            globalEditingMode: 'ripple',
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
            rawTranscription: null,
            transcriptionGroups: null,
            transcriptionContainerIds: null,
            history: [],
            redoStack: [],
            historySequence: 0,
            historyBytes: 0,
            lastSelectedId: null,
            isVideoSelected: false,
            isDragging: false,
        });
        subtitleDragPreview = null;
        useVideoStore.getState().syncSourceCatalog([]);
    },

    appendVideoSourcesAndClips: (sources, clips) => {
        get().appendMixedMediaCandidate({ videoSources: sources, videoClips: clips });
    },

    appendAudioSourcesAndTracks: (sources, tracks) => {
        get().appendMixedMediaCandidate({ audioSources: sources, audioTracks: tracks });
    },

    appendMixedMediaCandidate: (candidate, requestedInsertionFrame) => {
        const videoSources = candidate.videoSources ?? [];
        const audioSources = candidate.audioSources ?? [];
        if (videoSources.length === 0 && (candidate.videoClips?.length ?? 0) === 0
            && audioSources.length === 0 && (candidate.audioTracks?.length ?? 0) === 0) {
            return;
        }

        const state = get();
        const firstCandidateVideoSource = videoSources[0]
            ?? state.videoSources.find((source) => source.id === candidate.videoClips?.[0]?.sourceId);
        const hasAudioInput = audioSources.length > 0 || (candidate.audioTracks?.length ?? 0) > 0;
        if (!firstCandidateVideoSource && hasAudioInput
            && (!state.renderProfile.isFrameRateLocked || !state.renderProfile.isCanvasSizeLocked)) {
            throw new Error('Import a video first to establish the project frame rate and canvas size.');
        }

        // A mixed batch is inspected before entering the store. Applying its videos first locks
        // the output contract, after which audio candidates can use the exact project frame grid.
        const nextRenderProfile = !state.renderProfile.isFrameRateLocked && firstCandidateVideoSource
            ? renderProfileForFirstVideoSource(firstCandidateVideoSource)
            : state.renderProfile;
        const nextVideoSources = [...state.videoSources];
        const videoSourceIds = new Set(nextVideoSources.map((source) => source.id));
        videoSources.forEach((source) => {
            if (!isSafeVideoId(source.id) || videoSourceIds.has(source.id)) {
                throw new Error(`Video source ID "${source.id}" must be safe and unique.`);
            }
            videoSourceIds.add(source.id);
            nextVideoSources.push(source);
        });

        const requestedVideoClips = candidate.videoClips?.length ? candidate.videoClips : videoSources.map((source): VideoClip => ({
            id: crypto.randomUUID(),
            sourceId: source.id,
            sourceStart: 0,
            sourceEnd: Math.min(
                source.duration,
                framesToSeconds(Math.max(1, secondsToFrames(source.duration, nextRenderProfile.fps, 'nearest')), nextRenderProfile.fps),
            ),
        }));
        const videoClipIds = new Set(state.videoClips.map((clip) => clip.id));
        const videoClips = requestedVideoClips.map((clip): TimelineVideoClip => {
            if (!isSafeVideoId(clip.id) || videoClipIds.has(clip.id) || !videoSourceIds.has(clip.sourceId)) {
                throw new Error(`Video clip "${clip.id}" must have a safe unique ID and known source.`);
            }
            videoClipIds.add(clip.id);
            const source = nextVideoSources.find((item) => item.id === clip.sourceId)!;
            const suppliedAudio: VideoClipAudioSettings | null | undefined = 'audio' in clip
                ? (clip as VideoClipV3).audio
                : undefined;
            return {
                ...clip,
                audio: source.hasAudio
                    ? { ...(suppliedAudio ?? DEFAULT_VIDEO_CLIP_AUDIO) }
                    : null,
            };
        });

        const nextAudioSources = [...state.audioSources];
        const audioSourceIds = new Set(nextAudioSources.map((source) => source.id));
        audioSources.forEach((source) => {
            if (!isSafeVideoId(source.id) || audioSourceIds.has(source.id)) {
                throw new Error(`Audio source ID "${source.id}" must be safe and unique.`);
            }
            audioSourceIds.add(source.id);
            nextAudioSources.push(source);
        });

        const insertionFrame = Math.max(0, Math.round(requestedInsertionFrame ?? candidate.insertionFrame ?? 0));
        const requestedAudioTracks = candidate.audioTracks?.length ? candidate.audioTracks : audioSources.map((source): AudioTrack => ({
            id: crypto.randomUUID(),
            name: source.originalName,
            muted: false,
            solo: false,
            locked: false,
            gainDb: 0,
            clips: [{
                id: crypto.randomUUID(),
                source: { kind: 'audio-source', audioSourceId: source.id },
                timelineStartFrame: insertionFrame,
                sourceStartSample: 0,
                sourceEndSample: source.nativeSampleCount,
                muted: false,
                gainDb: 0,
                fadeInSamples: 0,
                fadeOutSamples: 0,
            }],
        }));
        const trackIds = new Set(state.audioTracks.map((track) => track.id));
        const audioClipIds = new Set(state.audioTracks.flatMap((track) => track.clips.map((clip) => clip.id)));
        requestedAudioTracks.forEach((track) => {
            if (!isSafeVideoId(track.id) || trackIds.has(track.id)) {
                throw new Error(`Audio track ID "${track.id}" must be safe and unique.`);
            }
            trackIds.add(track.id);
            track.clips.forEach((clip) => {
                const sourceReference = clip.source;
                const sourceExists = 'audioSourceId' in sourceReference
                    ? nextAudioSources.some((item) => item.id === sourceReference.audioSourceId)
                    : nextVideoSources.some((item) => item.id === sourceReference.videoSourceId && item.hasAudio);
                if (!isSafeVideoId(clip.id) || audioClipIds.has(clip.id) || !sourceExists) {
                    throw new Error(`Audio clip "${clip.id}" must have a safe unique ID and known source.`);
                }
                audioClipIds.add(clip.id);
            });
        });

        let nextVideoClips: TimelineVideoClip[] = state.videoClips;
        let nextVideoTracks = state.videoTracks;
        let nextTracks = state.tracks;
        let nextSubtitleSelection = state.selectedSubtitleIds;
        if (videoClips.length > 0) {
            const edit = appendClipsToTimeline(
                state.videoClips,
                videoClips,
                getTimelineDurations(state.videoClips, state.tracks).contentDuration,
                nextRenderProfile.fps,
            );
            const transformed = applyVideoEditToSubtitleDomains(state.tracks, state.selectedSubtitleIds, edit);
            nextVideoClips = cloneVideoClips(edit.videoClips);
            const targetTrackId = state.videoTracks[0]?.id;
            if (!targetTrackId) throw new Error('At least one video track is required before importing media.');
            const importedIds = videoClips.map((clip) => clip.id);
            nextVideoTracks = canonicalizeVideoTrackClipOrder(
                state.videoTracks.map((track) => track.id === targetTrackId
                    ? { ...track, clipIds: [...track.clipIds, ...importedIds] }
                    : track),
                nextVideoClips,
            );
            // Import helpers still return the transitional V3 clip shape. Complete explicit V4
            // ownership/placement before the candidate enters state, history, or persistence.
            nextVideoClips = projectVideoClipsV4(
                nextVideoClips,
                nextVideoTracks,
                nextRenderProfile,
            );
            nextTracks = transformed.tracks;
            nextSubtitleSelection = transformed.selectedSubtitleIds;
        }
        const nextAudioTracks = [...state.audioTracks, ...cloneAudioTracks(requestedAudioTracks)];
        const hasHistoricalMutation = videoClips.length > 0
            || requestedAudioTracks.length > 0
            || nextRenderProfile !== state.renderProfile;

        const patch: Partial<TimelineStore> = {
            videoSources: nextVideoSources,
            videoClips: nextVideoClips,
            videoTracks: nextVideoTracks,
            audioSources: nextAudioSources,
            audioTracks: nextAudioTracks,
            tracks: nextTracks,
            selectedSubtitleIds: nextSubtitleSelection,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(nextTracks, nextSubtitleSelection, state.activeTrackId)
                : state.transientSelection,
            renderProfile: nextRenderProfile,
        };
        if (!hasHistoricalMutation) return;
        const validationPatch = finalizeDurablePatch(state, patch, 'invalidate-transcription');
        const validation = validateEditorDocumentV4(buildEditorDocumentFromState({ ...state, ...validationPatch } as TimelineStore));
        if (!validation.valid) {
            throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
        }

        commitDurableMutation(state, patch, {
            history: { label: 'Import media' },
            impact: 'invalidate-transcription',
            recalculateContentBoundary: true,
            sourceAssets: [
                ...videoSources.map((asset): EditorPersistentAsset => ({ kind: 'video-source', asset })),
                ...audioSources.map((asset): EditorPersistentAsset => ({ kind: 'audio-source', asset })),
            ],
        });
        if (videoSources.length > 0) useVideoStore.getState().syncSourceCatalog(nextVideoSources);
    },

    detachVideoClipAudio: (clipId, idsOrTrackId, requestedDetachedClipId) => {
        const state = get();
        const clip = state.videoClips.find((item) => item.id === clipId);
        const source = clip ? state.videoSources.find((item) => item.id === clip.sourceId) : undefined;
        // linkState remains detached even if the independent clip is later deleted. Repeating the
        // command therefore cannot duplicate audio or unexpectedly restore a deleted edit.
        if (!clip?.audio || clip.audio.linkState !== 'linked' || !source?.hasAudio) return;

        const trackId = typeof idsOrTrackId === 'string'
            ? idsOrTrackId
            : idsOrTrackId?.trackId ?? crypto.randomUUID();
        const detachedClipId = requestedDetachedClipId
            ?? (typeof idsOrTrackId === 'string' ? undefined : idsOrTrackId?.clipId)
            ?? crypto.randomUUID();
        if (!isSafeVideoId(trackId) || !isSafeVideoId(detachedClipId)
            || state.audioTracks.some((track) => track.id === trackId)
            || state.audioTracks.some((track) => track.clips.some((item) => item.id === detachedClipId))) {
            return;
        }
        const placement = buildClipPlacements(state.videoClips, state.renderProfile.fps)
            .find((item) => item.clip.id === clipId);
        if (!placement) return;

        const independentClip: AudioClip = {
            id: detachedClipId,
            source: { kind: 'video-source-audio', videoSourceId: source.id },
            timelineStartFrame: secondsToFrames(placement.projectStart, state.renderProfile.fps, 'nearest'),
            sourceStart: clip.sourceStart,
            sourceEnd: clip.sourceEnd,
            muted: clip.audio.muted,
            gainDb: clip.audio.gainDb,
            fadeInFrames: clip.audio.fadeInFrames,
            fadeOutFrames: clip.audio.fadeOutFrames,
        };
        const audioTrack: AudioTrack = {
            id: trackId,
            name: `Audio from ${source.originalName}`,
            muted: false,
            solo: false,
            locked: false,
            gainDb: 0,
            clips: [independentClip],
        };
        const patch: Partial<TimelineStore> = {
            videoClips: state.videoClips.map((item) => item.id === clipId
                ? { ...item, audio: item.audio ? { ...item.audio, linkState: 'detached' } : null }
                : item),
            audioTracks: [...state.audioTracks, audioTrack],
            transientSelection: { kind: 'audio-clip', trackId, clipId: detachedClipId },
            selectedClipId: null,
            selectedSubtitleIds: [],
            isVideoSelected: false,
        };
        commitDurableMutation(state, patch, {
            history: { label: 'Separate embedded audio' },
            impact: 'invalidate-transcription',
        });
    },

    splitVideoClip: (clipId, projectTime, rightClipId) => {
        const state = get();
        const splitFrame = secondsToFrames(projectTime, state.renderProfile.fps, 'nearest');
        state.executeOrdinaryV4Command({
            target: { kind: 'video-clip', clipId },
            action: { kind: 'split', at: splitFrame, childId: rightClipId },
        });
    },

    trimVideoClip: (clipId, sourceStart, sourceEnd) => {
        const state = get();
        const document = buildEditorDocumentFromState(state);
        const clip = document.videoClips.find((value) => value.id === clipId);
        if (!clip) return;
        const placement = getVideoClipPlacementV4(document, clip);
        const frameRate = document.renderProfile.fps.numerator / document.renderProfile.fps.denominator;
        const startDelta = Math.round((sourceStart - clip.sourceStart) * frameRate);
        const endDelta = Math.round((sourceEnd - clip.sourceEnd) * frameRate);
        state.executeOrdinaryV4Command({
            target: { kind: 'video-clip', clipId },
            action: {
                kind: 'resize',
                start: placement.startFrame + startDelta,
                end: placement.endFrame + endDelta,
            },
        });
    },

    deleteVideoClip: (clipId) => {
        get().executeOrdinaryV4Command({
            target: { kind: 'video-clip', clipId },
            action: { kind: 'delete' },
        });
    },

    reorderVideoClips: (orderedClipIds) => {
        const state = get();
        const planningState = getOrdinaryPlanningState(state);
        const before = buildEditorDocumentFromState(planningState);
        commitOrdinaryPlan({
            state,
            before,
            planned: planTimelineVideoReorderV4Command(
                before,
                orderedClipIds,
                planningState.selectedClipId,
            ),
        });
    },

    addVideoTrack: (name, requestedId, insertionIndex) => {
        const state = get();
        const id = requestedId ?? crypto.randomUUID();
        const track: VideoTrack = {
            id,
            name: name?.trim() || `Video ${state.videoTracks.length + 1}`,
            clipIds: [],
        };
        const result = addVideoTrackMembership(state.videoTracks, track, insertionIndex);
        if (!result.changed) return '';
        commitDurableMutation(state, { videoTracks: result.videoTracks }, {
            history: { label: 'Add video track' },
        });
        return id;
    },

    removeVideoTrack: (trackId) => {
        const state = get();
        const result = removeEmptyVideoTrackMembership(state.videoTracks, trackId);
        if (!result.changed) return;
        commitDurableMutation(state, { videoTracks: result.videoTracks }, {
            history: { label: 'Remove video track' },
        });
    },

    moveVideoClip: (clipId, targetTrackId, targetStartFrame) => (
        get().executeOrdinaryV4Command({
            target: { kind: 'video-clip', clipId },
            action: {
                kind: 'move',
                targetTrackId,
                targetStart: targetStartFrame,
            },
        })
    ),

    moveVideoClipToTrack: (clipId, targetTrackId) => {
        const state = get();
        const document = buildEditorDocumentFromState(getOrdinaryPlanningState(state));
        const clip = document.videoClips.find((value) => value.id === clipId);
        if (!clip) return;
        state.moveVideoClip(clipId, targetTrackId, clip.timelineStartFrame);
    },

    moveVideoClipToNewTrackAtFrame: (
        clipId,
        insertionIndex,
        targetStartFrame,
        requestedId,
        name,
    ) => {
        const state = get();
        const planningState = getOrdinaryPlanningState(state);
        const id = requestedId ?? crypto.randomUUID();
        const result = moveVideoClipToNewTrackMembership(
            planningState.videoTracks,
            planningState.videoClips,
            clipId,
            { id, name: name?.trim() || `Video ${planningState.videoTracks.length + 1}` },
            insertionIndex,
        );
        if (!result.changed) {
            return timelineCommandError(
                'invalid-destination',
                'Video destination lane could not be created.',
                [clipId, id],
            );
        }
        const before = buildEditorDocumentFromState(planningState);
        const clip = before.videoClips.find((value) => value.id === clipId);
        if (!clip) {
            return timelineCommandError('missing-target', 'Video clip does not exist.', [clipId]);
        }
        const planningTracks = projectVideoTracksV4(result.videoTracks);
        const sourceTrack = before.videoTracks.find((track) => track.id === clip.trackId);
        if (sourceTrack && !planningTracks.some((track) => track.id === sourceTrack.id)) {
            planningTracks.push(sourceTrack);
        }
        const planned = planTimelineOrdinaryV4Command({
            ...before,
            videoTracks: planningTracks,
        }, {
            target: { kind: 'video-clip', clipId },
            action: {
                kind: 'move',
                targetTrackId: id,
                targetStart: targetStartFrame,
            },
        });
        if (planned.kind === 'success') {
            const occupiedTrackIds = new Set(planned.document.videoClips.map((value) => value.trackId));
            planned.document.videoTracks = planned.document.videoTracks.filter((track) => (
                occupiedTrackIds.has(track.id)
            ));
        }
        return commitOrdinaryPlan({ state, before, planned });
    },

    moveVideoClipToNewTrack: (clipId, insertionIndex, requestedId, name) => {
        const state = get();
        const document = buildEditorDocumentFromState(getOrdinaryPlanningState(state));
        const clip = document.videoClips.find((value) => value.id === clipId);
        if (!clip) return '';
        const id = requestedId ?? crypto.randomUUID();
        const result = state.moveVideoClipToNewTrackAtFrame(
            clipId,
            insertionIndex,
            clip.timelineStartFrame,
            id,
            name,
        );
        return result.kind === 'success' ? id : '';
    },

    selectClip: (clipId) => {
        const state = get();
        const selectedClip = clipId
            ? state.videoClips.find((clip) => clip.id === clipId)
            : null;
        if (!selectedClip) {
            set({
                selectedClipId: null,
                selectedSubtitleIds: [],
                lastSelectedId: null,
                isVideoSelected: false,
                transientSelection: { kind: 'none' },
            });
            return;
        }

        const ownedBlock = Object.values(state.narrative?.blocks ?? {}).find((block) => (
            block.clipId === selectedClip.id
            && state.narrative?.controlledTrackIds.includes(block.trackId)
        ));
        if (ownedBlock) {
            const current = state.transientSelection.kind === 'narrative'
                && state.transientSelection.blockId === ownedBlock.id
                ? state.transientSelection
                : null;
            const retainedWordIds = current
                ? ownedBlock.sourceWordIds.filter((wordId) => current.sourceWordIds.includes(wordId))
                : [];
            let validated = createValidatedNarrativeSelection(
                state,
                ownedBlock.id,
                retainedWordIds,
                current?.boundary,
            );
            // A body refresh can retire a boundary while the owned occurrence and selected words
            // remain valid. Timeline selection keeps that valid range and drops only the stale handle.
            if (!validated && current?.boundary) {
                validated = createValidatedNarrativeSelection(state, ownedBlock.id, retainedWordIds);
            }
            if (!validated) return;
            set({
                transientSelection: validated.selection,
                ...projectTransientSelectionMirrorsV4(validated.selection, state.narrative),
            });
            return;
        }

        const transientSelection = { kind: 'video-clip' as const, clipId: selectedClip.id };
        set({
            transientSelection,
            ...projectTransientSelectionMirrorsV4(transientSelection, state.narrative),
        });
    },

    selectNarrativeRange: (blockId, sourceWordIds, boundary) => {
        const state = get();
        const validated = createValidatedNarrativeSelection(state, blockId, sourceWordIds, boundary);
        if (!validated) return false;
        set({
            transientSelection: validated.selection,
            ...projectTransientSelectionMirrorsV4(validated.selection, state.narrative),
        });
        return true;
    },

    selectAudioClip: (trackId, clipId) => set((state) => {
        const track = state.audioTracks.find((item) => item.id === trackId);
        if (!track?.clips.some((clip) => clip.id === clipId)) return state;
        return {
            transientSelection: { kind: 'audio-clip', trackId, clipId },
            selectedClipId: null,
            selectedSubtitleIds: [],
            lastSelectedId: null,
            isVideoSelected: false,
        };
    }),

    moveAudioClip: (clipId, targetTrackId, timelineStartFrame) => {
        const state = get();
        const located = findAudioClip(state.audioTracks, getAudioTimelineSources(state), clipId);
        if (!located) return;
        state.executeOrdinaryV4Command({
            target: { kind: 'audio-clip', trackId: located.track.id, clipId },
            action: {
                kind: 'move',
                targetTrackId,
                targetStart: frameToOutputSample(Math.round(timelineStartFrame), state.renderProfile.fps),
            },
        });
    },

    trimAudioClip: (clipId, side, timelineFrame) => {
        const state = get();
        const sources = getAudioTimelineSources(state);
        const located = findAudioClip(state.audioTracks, sources, clipId);
        if (!located) return;
        const interval = getAudioClipOutputInterval(located.clip, located.source, state.renderProfile);
        const boundary = frameToOutputSample(Math.round(timelineFrame), state.renderProfile.fps);
        state.executeOrdinaryV4Command({
            target: { kind: 'audio-clip', trackId: located.track.id, clipId },
            action: {
                kind: 'resize',
                start: side === 'left' ? boundary : interval.startSample,
                end: side === 'right' ? boundary : interval.endSample,
            },
        });
    },

    splitAudioClip: (clipId, timelineFrame, rightClipId) => {
        if (!isSafeVideoId(rightClipId)) return;
        const state = get();
        const located = findAudioClip(state.audioTracks, getAudioTimelineSources(state), clipId);
        if (!located) return;
        state.executeOrdinaryV4Command({
            target: { kind: 'audio-clip', trackId: located.track.id, clipId },
            action: {
                kind: 'split',
                at: frameToOutputSample(Math.round(timelineFrame), state.renderProfile.fps),
                childId: rightClipId,
            },
        });
    },

    deleteAudioClip: (clipId) => {
        const state = get();
        const located = findAudioClip(state.audioTracks, getAudioTimelineSources(state), clipId);
        if (!located) return;
        state.executeOrdinaryV4Command({
            target: { kind: 'audio-clip', trackId: located.track.id, clipId },
            action: { kind: 'delete' },
        });
    },

    addAudioTrack: (name, requestedId) => {
        const state = get();
        const id = requestedId ?? crypto.randomUUID();
        if (!isSafeVideoId(id) || state.audioTracks.some((track) => track.id === id)) return '';
        commitDurableMutation(state, {
            audioTracks: [...state.audioTracks, {
                id,
                name: name?.trim() || `Audio ${state.audioTracks.length + 1}`,
                muted: false,
                solo: false,
                locked: false,
                gainDb: 0,
                clips: [],
            }],
        }, { history: { label: 'Add audio track' } });
        return id;
    },

    removeAudioTrack: (trackId) => {
        const state = get();
        const track = state.audioTracks.find((item) => item.id === trackId);
        if (!track || track.locked) return;
        const impact: AudioGraphMutationImpact = track.clips.length > 0
            ? 'invalidate-transcription'
            : 'preserve-transcription';
        commitDurableMutation(state, {
            audioTracks: state.audioTracks.filter((item) => item.id !== trackId),
            transientSelection: state.transientSelection.kind === 'audio-clip'
                && state.transientSelection.trackId === trackId
                ? { kind: 'none' }
                : state.transientSelection,
        }, {
            history: { label: 'Remove audio track' },
            impact,
            recalculateContentBoundary: track.clips.length > 0,
        });
    },

    renameAudioTrack: (trackId, name) => {
        const state = get();
        const track = state.audioTracks.find((item) => item.id === trackId);
        const nextName = name.trim();
        if (!track || track.locked || !nextName || track.name === nextName) return;
        commitDurableMutation(state, {
            audioTracks: state.audioTracks.map((item) => item.id === trackId ? { ...item, name: nextName } : item),
        }, { history: { label: 'Rename audio track', mergeKey: `audio-track-name:${trackId}` } });
    },

    updateAudioClipMix: (clipId, updates) => {
        const state = get();
        const located = findAudioClip(state.audioTracks, getAudioTimelineSources(state), clipId);
        if (!located || located.track.locked) return;
        const gainDb = Math.min(12, Math.max(-60,
            Number.isFinite(updates.gainDb) ? updates.gainDb! : located.clip.gainDb));
        let candidateClip: AudioClip = {
            ...located.clip,
            muted: updates.muted ?? located.clip.muted,
            gainDb,
        };
        if ('sourceStartSample' in candidateClip) {
            candidateClip = clampSampleFades({
                ...candidateClip,
                fadeInSamples: Math.max(0, Math.round(updates.fadeInSamples ?? candidateClip.fadeInSamples)),
                fadeOutSamples: Math.max(0, Math.round(updates.fadeOutSamples ?? candidateClip.fadeOutSamples)),
            }, candidateClip.sourceEndSample - candidateClip.sourceStartSample);
        } else {
            const durationFrames = secondsToFrames(
                candidateClip.sourceEnd - candidateClip.sourceStart,
                state.renderProfile.fps,
                'nearest',
            );
            candidateClip = clampFrameFades({
                ...candidateClip,
                fadeInFrames: Math.max(0, Math.round(updates.fadeInFrames ?? candidateClip.fadeInFrames)),
                fadeOutFrames: Math.max(0, Math.round(updates.fadeOutFrames ?? candidateClip.fadeOutFrames)),
            }, durationFrames);
        }
        // Mix controls run continuously while sliders are dragged. Audio clips have a small,
        // discriminated scalar schema, so direct equality keeps no-op updates off the durable
        // mutation path without serializing objects on every pointer event.
        if (audioClipsEqual(candidateClip, located.clip)) return;
        const audioTracks = state.audioTracks.map((track) => track.id === located.track.id
            ? { ...track, clips: track.clips.map((clip) => clip.id === clipId ? candidateClip : clip) }
            : track);
        const impact: AudioGraphMutationImpact = candidateClip.muted !== located.clip.muted
            ? 'invalidate-transcription'
            : 'preserve-transcription';
        commitDurableMutation(state, { audioTracks }, {
            history: { label: 'Edit audio clip mix', mergeKey: `audio-clip-mix:${clipId}` },
            impact,
        });
    },

    updateAudioTrackMix: (trackId, updates) => {
        const state = get();
        const track = state.audioTracks.find((item) => item.id === trackId);
        if (!track || track.locked) return;
        const nextMuted = updates.muted ?? track.muted;
        const nextSolo = updates.solo ?? track.solo;
        const nextGainDb = Math.min(12, Math.max(-60,
            Number.isFinite(updates.gainDb) ? updates.gainDb! : track.gainDb));
        if (nextMuted === track.muted && nextSolo === track.solo && nextGainDb === track.gainDb) return;
        const impact: AudioGraphMutationImpact = nextMuted !== track.muted || nextSolo !== track.solo
            ? 'invalidate-transcription'
            : 'preserve-transcription';
        commitDurableMutation(state, {
            audioTracks: state.audioTracks.map((item) => item.id === trackId
                ? { ...item, muted: nextMuted, solo: nextSolo, gainDb: nextGainDb }
                : item),
        }, {
            history: { label: 'Edit audio track mix', mergeKey: `audio-track-mix:${trackId}` },
            impact,
        });
    },

    setAudioTrackLocked: (trackId, locked) => {
        const state = get();
        const track = state.audioTracks.find((item) => item.id === trackId);
        if (!track || track.locked === locked) return;
        commitDurableMutation(state, {
            audioTracks: state.audioTracks.map((item) => item.id === trackId ? { ...item, locked } : item),
        }, { history: { label: locked ? 'Lock audio track' : 'Unlock audio track' } });
    },

    updateVideoClipAudio: (clipId, updates) => {
        const state = get();
        const clipIndex = state.videoClips.findIndex((clip) => clip.id === clipId);
        if (clipIndex === -1) return;
        const clip = state.videoClips[clipIndex];
        if (!clip.audio) return;
        const durationFrames = Math.max(1, secondsToFrames(
            clip.sourceEnd - clip.sourceStart,
            state.renderProfile.fps,
            'nearest',
        ));
        const current = clip.audio;
        let fadeInFrames = Math.min(durationFrames, Math.max(0, Math.round(updates.fadeInFrames ?? current.fadeInFrames)));
        let fadeOutFrames = Math.min(durationFrames, Math.max(0, Math.round(updates.fadeOutFrames ?? current.fadeOutFrames)));
        if (fadeInFrames + fadeOutFrames > durationFrames) {
            const ratio = durationFrames / (fadeInFrames + fadeOutFrames);
            fadeInFrames = Math.floor(fadeInFrames * ratio);
            fadeOutFrames = durationFrames - fadeInFrames;
        }
        const audio: VideoClipAudioSettings = {
            linkState: current.linkState,
            muted: updates.muted ?? current.muted,
            gainDb: Math.min(12, Math.max(-60, Number.isFinite(updates.gainDb) ? updates.gainDb! : current.gainDb)),
            fadeInFrames,
            fadeOutFrames,
        };
        if (
            audio.muted === current.muted
            && audio.gainDb === current.gainDb
            && audio.fadeInFrames === current.fadeInFrames
            && audio.fadeOutFrames === current.fadeOutFrames
        ) return;
        const impact: AudioGraphMutationImpact = audio.muted !== current.muted
            ? 'invalidate-transcription'
            : 'preserve-transcription';
        commitDurableMutation(state, {
            videoClips: state.videoClips.map((item) => item.id === clipId ? { ...item, audio } : item),
        }, {
            history: { label: 'Edit embedded audio', mergeKey: `video-audio:${clipId}` },
            impact,
        });
    },

    setSubtitleTrackTimingDomain: (trackId, timingDomain) => {
        const state = get();
        // V4 exposes `unlinkedVideoEditResponse` directly. Keeping this adapter behind the actual
        // V3 discriminator prevents an old hidden timing-domain control from overriding that policy.
        if (state.globalEditingMode !== undefined) return;
        const track = state.tracks.find((item) => item.id === trackId);
        if (!track || getTrackTimingDomain(track) === timingDomain) return;
        commitDurableMutation(state, {
            tracks: state.tracks.map((item) => item.id === trackId ? { ...item, timingDomain } : item),
        }, {
            history: { label: 'Change subtitle timing domain' },
            persistLegacyV3: true,
        });
    },

    setSubtitleTrackUnlinkedVideoEditResponse: (trackId, policy) => {
        const state = get();
        if (state.globalEditingMode === undefined
            || (policy !== 'follow-project-ripple'
                && policy !== 'stay-absolute'
                && policy !== 'remove-with-deleted-video-range')) return;
        const track = state.tracks.find((item) => item.id === trackId);
        if (!track || track.isLocked || track.unlinkedVideoEditResponse === policy) return;
        commitDurableMutation(state, {
            tracks: state.tracks.map((item) => item.id === trackId
                ? {
                    ...item,
                    unlinkedVideoEditResponse: policy,
                    // The legacy mirror remains derived until WP8 removes its final readers.
                    timingDomain: policy === 'follow-project-ripple' ? 'video-ripple' : 'absolute',
                }
                : item),
        }, { history: { label: 'Change subtitle video edit response' } });
    },

    setTrackTranscriptionState: (trackId, provenance) => {
        const state = get();
        if (!state.tracks.some((track) => track.id === trackId)) return;
        const transcriptionByTrackId = { ...state.transcriptionByTrackId };
        if (provenance) {
            transcriptionByTrackId[trackId] = {
                ...cloneTranscriptionByTrackId({
                    value: {
                        ...provenance,
                        sourceDocumentRevision: state.revision + 1,
                        sourceAudioGraphRevision: state.audioGraphRevision,
                        sourceAudioGraphSignature: getEditorAudioGraphSignature(buildEditorDocumentFromState(state)),
                        stale: false,
                    },
                }).value,
            };
        } else {
            delete transcriptionByTrackId[trackId];
        }
        const legacy = getLegacyTranscriptionForTrack(transcriptionByTrackId, state.activeTrackId);
        commitDurableMutation(state, {
            transcriptionByTrackId,
            rawTranscription: cloneSubtitles(legacy?.raw ?? null),
            transcriptionGroups: cloneTranscriptionGroups(legacy?.groups ?? null),
            transcriptionContainerIds: cloneContainerIds(legacy?.containerIds ?? null),
        }, { history: { label: 'Update transcription state' } });
    },

    createTranscriptionGuard: (trackId) => {
        const state = get();
        const track = state.tracks.find((item) => item.id === trackId);
        return track ? createTranscriptionJobGuard(buildEditorDocumentFromState(state), track) : null;
    },

    replaceTrackWithTranscription: (trackId, subtitles, provenance, expectedRevision) => {
        const state = get();
        const track = state.tracks.find((item) => item.id === trackId);
        const guardIsCurrent = typeof expectedRevision === 'number'
            ? state.revision === expectedRevision
            : track !== undefined && isTranscriptionJobGuardCurrent(
                expectedRevision,
                buildEditorDocumentFromState(state),
                track,
            );
        if (!track || !guardIsCurrent) {
            return false;
        }

        const tracks = state.tracks.map((track) => (
                track.id === trackId ? { ...track, subtitles: cloneSubtitles(subtitles) ?? [] } : track
            ));
        const nextRevision = state.revision + 1;
        const transcriptionByTrackId = {
                ...state.transcriptionByTrackId,
                [trackId]: cloneTranscriptionByTrackId({
                    value: {
                        ...provenance,
                        sourceDocumentRevision: nextRevision,
                        sourceAudioGraphRevision: state.audioGraphRevision,
                        sourceAudioGraphSignature: getEditorAudioGraphSignature(buildEditorDocumentFromState(state)),
                        stale: false,
                    },
                }).value,
            };
        const legacy = getLegacyTranscriptionForTrack(transcriptionByTrackId, state.activeTrackId);
        const selectedSubtitleIds = cleanSubtitleSelection(state.selectedSubtitleIds, tracks);
        commitDurableMutation(state, {
            tracks,
            transcriptionByTrackId,
            rawTranscription: cloneSubtitles(legacy?.raw ?? null),
            transcriptionGroups: cloneTranscriptionGroups(legacy?.groups ?? null),
            transcriptionContainerIds: cloneContainerIds(legacy?.containerIds ?? null),
            selectedSubtitleIds,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(tracks, selectedSubtitleIds, state.activeTrackId)
                : state.transientSelection,
        }, {
            history: { label: 'Replace subtitles with transcription' },
            recalculateContentBoundary: true,
        });
        return true;
    },

    replaceTrackSetWithDiarizedTranscription: (targetTrackId, speakers, metadata, guard) => {
        const state = get();
        if (guard.targetTrackId !== targetTrackId
            || state.activeTrackId !== targetTrackId
            || speakers.length === 0
            || !metadata.provider.trim()
            || Number.isNaN(Date.parse(metadata.generatedAt))
            || speakers.some((speaker) => !isValidDiarizedSpeakerTrackInput(speaker))) {
            return false;
        }

        const currentDocument = buildLegacyEditorDocumentFromState(state);
        if (!isDiarizationJobGuardCurrent(guard, currentDocument)) return false;

        const targetTrack = state.tracks.find((track) => track.id === targetTrackId);
        if (!targetTrack) return false;
        const targetInspection = inspectDiarizationProvenance(state.transcriptionByTrackId[targetTrackId]);
        // The guard normally rejects this state before the command starts. Keep a second explicit
        // check at the mutation boundary so direct callers can never overwrite future metadata.
        if (targetInspection.kind === 'unsupported') return false;

        const previousIdentity = targetInspection.kind === 'v1'
            ? {
                setId: targetInspection.value.setId,
                targetTrackId: targetInspection.value.targetTrackId,
            }
            : null;
        const trackIndex = new Map(state.tracks.map((track, index) => [track.id, index]));
        const previousSiblings = previousIdentity
            ? state.tracks
                .filter((track) => {
                    if (track.id === targetTrackId) return false;
                    const extension = getDiarizationProvenanceV1(state.transcriptionByTrackId[track.id]);
                    return extension?.setId === previousIdentity.setId
                        && extension.targetTrackId === previousIdentity.targetTrackId;
                })
                .sort((left, right) => {
                    const leftOrdinal = getDiarizationProvenanceV1(
                        state.transcriptionByTrackId[left.id],
                    )?.speakerOrdinal ?? Number.MAX_SAFE_INTEGER;
                    const rightOrdinal = getDiarizationProvenanceV1(
                        state.transcriptionByTrackId[right.id],
                    )?.speakerOrdinal ?? Number.MAX_SAFE_INTEGER;
                    return leftOrdinal - rightOrdinal
                        || (trackIndex.get(left.id) ?? 0) - (trackIndex.get(right.id) ?? 0);
                })
            : [];

        // Identity allocation happens only after the complete async guard is known to be current.
        // This prevents a stale result from consuming IDs or exposing a partial generated set.
        const setId = previousIdentity?.setId ?? crypto.randomUUID();
        const reusableSiblings = previousSiblings.slice(0, Math.max(0, speakers.length - 1));
        const surplusSiblings = previousSiblings.slice(Math.max(0, speakers.length - 1));
        const usedTrackIds = new Set(state.tracks.map((track) => track.id));
        const memberTracks: SubtitleTrack[] = [targetTrack, ...reusableSiblings];
        while (memberTracks.length < speakers.length) {
            const ordinal = memberTracks.length;
            const id = allocateUniqueEditorId(usedTrackIds);
            usedTrackIds.add(id);
            const clonedTarget = cloneTracks([targetTrack])[0];
            memberTracks.push({
                ...clonedTarget,
                id,
                name: `Speaker ${ordinal + 1}`,
                subtitles: [],
            });
        }

        const previousMemberIds = new Set([targetTrackId, ...previousSiblings.map((track) => track.id)]);
        const unrelatedTracks = state.tracks.filter((track) => !previousMemberIds.has(track.id));
        const targetIndex = state.tracks.findIndex((track) => track.id === targetTrackId);
        const insertionIndex = state.tracks
            .slice(0, targetIndex)
            .filter((track) => !previousMemberIds.has(track.id))
            .length;
        const regeneratedTracks = memberTracks.map((track, ordinal) => ({
            ...track,
            subtitles: cloneSubtitles(speakers[ordinal].subtitles) ?? [],
        }));
        const tracks = [
            ...unrelatedTracks.slice(0, insertionIndex),
            ...regeneratedTracks,
            ...unrelatedTracks.slice(insertionIndex),
        ];

        const nextRevision = state.revision + 1;
        const sourceAudioGraphSignature = getEditorAudioGraphSignature(currentDocument);
        const transcriptionByTrackId = cloneTranscriptionByTrackId(state.transcriptionByTrackId);
        surplusSiblings.forEach((track) => delete transcriptionByTrackId[track.id]);
        regeneratedTracks.forEach((track, ordinal) => {
            const existing = transcriptionByTrackId[track.id];
            const extensions = {
                ...(existing?.extensions ?? {}),
                [DIARIZATION_PROVENANCE_EXTENSION_KEY]: createDiarizationProvenanceV1({
                    setId,
                    targetTrackId,
                    speakerOrdinal: ordinal,
                    sourceSpeakerLabel: speakers[ordinal].sourceSpeakerLabel,
                }),
            };
            transcriptionByTrackId[track.id] = cloneTranscriptionByTrackId({
                value: {
                    ...existing,
                    ...speakers[ordinal].transcription,
                    provider: metadata.provider,
                    // Assigning undefined intentionally clears a model retained by a previous run;
                    // the JSON clone below then omits that optional field from persisted metadata.
                    model: metadata.model,
                    generatedAt: metadata.generatedAt,
                    sourceDocumentRevision: nextRevision,
                    sourceAudioGraphRevision: state.audioGraphRevision,
                    sourceAudioGraphSignature,
                    stale: false,
                    extensions,
                },
            }).value;
        });

        const legacy = getLegacyTranscriptionForTrack(transcriptionByTrackId, targetTrackId);
        const selectedSubtitleIds = cleanSubtitleSelection(state.selectedSubtitleIds, tracks);
        const validSubtitleIds = new Set(tracks.flatMap((track) => track.subtitles.map((subtitle) => subtitle.id)));
        const lastSelectedId = state.lastSelectedId && validSubtitleIds.has(state.lastSelectedId)
            ? state.lastSelectedId
            : null;
        return commitDurableMutation(state, {
            tracks,
            activeTrackId: targetTrackId,
            transcriptionByTrackId,
            rawTranscription: cloneSubtitles(legacy?.raw ?? null),
            transcriptionGroups: cloneTranscriptionGroups(legacy?.groups ?? null),
            transcriptionContainerIds: cloneContainerIds(legacy?.containerIds ?? null),
            selectedSubtitleIds,
            lastSelectedId,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(tracks, selectedSubtitleIds, targetTrackId)
                : state.transientSelection,
        }, {
            history: { label: 'Replace subtitles with diarized transcription' },
            recalculateContentBoundary: true,
        });
    },

    getTrackTranscriptionState: (trackId) => {
        const provenance = get().transcriptionByTrackId[trackId];
        return provenance ? cloneTranscriptionByTrackId({ value: provenance }).value : null;
    },

    buildEditorDocument: () => buildLegacyEditorDocumentFromState(get()),
    buildEditorManifest: () => buildLegacyEditorManifestFromState(get()),
    buildEditorDocumentV4: () => buildEditorDocumentFromState(get()),
    buildEditorManifestV4: () => buildEditorManifestFromState(get()),

    activateNarrative: async (request) => {
        const state = discardActiveDragPreview();
        const before = buildEditorDocumentFromState(state);
        const explicitGuardError = validateRequestedNarrativeGuard(before, request);
        if (explicitGuardError) return explicitGuardError;
        const preflight = preflightNarrativeActivationCandidates({
            document: before,
            selectedTrackIds: request.selectedTrackIds,
        });
        if (preflight.kind === 'error') return preflight;
        if (preflight.kind === 'noop') {
            return {
                kind: 'noop',
                code: preflight.code,
                history: { createEntry: false, label: null, mergeKey: null },
                persistence: { enqueue: false },
                activationReport: {
                    acceptedClipIds: [...preflight.acceptedClipIds],
                    exclusions: structuredClone(preflight.exclusions),
                },
            };
        }
        const context = timelineEditorialRuntime.getProjectContext();
        if (!context) {
            return timelineCommandError(
                'project-context-unavailable',
                'Editorial acquisition requires an attached project session.',
                [],
            );
        }
        const accepted = new Set(preflight.acceptedClipIds);
        const sourceIds = Array.from(new Set(before.videoClips
            .filter((clip) => accepted.has(clip.id))
            .map((clip) => clip.sourceId)));
        const sources = sourceIds.map((sourceId) => {
            const source = before.videoSources.find((value) => value.id === sourceId);
            if (!source) throw new Error(`Activation source "${sourceId}" is unavailable.`);
            return {
                sourceId: source.id,
                sourceFingerprint: source.fingerprint,
                file: source.file,
                declaredDuration: request.declaredDurationBySourceId?.[source.id]
                    ?? approximateSecondsAsRationalDuration(source.duration),
            };
        });
        let acquired;
        try {
            acquired = await timelineEditorialRuntime.getCoordinator().acquireSources({
                sources,
                preferences: request.preferences,
                apiKey: request.apiKey,
                guard: {
                    projectId: context.projectId,
                    persistenceGeneration: context.persistenceGeneration,
                    documentRevision: before.revision,
                    sessionId: context.sessionId,
                },
                signal: request.signal,
                regenerate: request.regenerate,
                onProgress: request.onProgress,
                isGuardCurrent: (guard) => {
                    const currentContext = timelineEditorialRuntime.getProjectContext();
                    const current = get();
                    return currentContext?.projectId === guard.projectId
                        && currentContext.persistenceGeneration === guard.persistenceGeneration
                        && currentContext.sessionId === guard.sessionId
                        && current.revision === guard.documentRevision
                        && current.videoSources.some((source) => (
                            source.fingerprint === guard.sourceFingerprint
                            && sourceIds.includes(source.id)
                        ));
                },
            });
        } catch (error) {
            await timelineEditorialRuntime.releaseCurrentSessionPins().catch(() => undefined);
            const stale = error instanceof DOMException && error.name === 'AbortError';
            if (stale) {
                return timelineCommandError(
                    'stale-document',
                    'Editorial acquisition became stale before publication.',
                    sourceIds,
                );
            }
            if (error instanceof EditorialTranscriptionRequestError) {
                return timelineEditorialTranscriptionError(error, request.preferences.requestMode);
            }
            return timelineCommandError(
                'transcript-acquisition-failed',
                'Editorial transcript acquisition failed before publication.',
                sourceIds,
            );
        }
        if (get().revision !== before.revision) {
            await timelineEditorialRuntime.releaseCurrentSessionPins().catch(() => undefined);
            return timelineCommandError('stale-document', 'Document revision changed during acquisition.', []);
        }
        const descriptors = [...before.editorialTranscriptDescriptors];
        acquired.forEach((descriptor) => {
            if (!descriptors.some((value) => (
                value.recordId === descriptor.recordId && value.sourceId === descriptor.sourceId
            ))) descriptors.push(descriptor);
        });
        const acquisitionDocument: EditorDocumentV4 = {
            ...before,
            editorialTranscriptDescriptors: descriptors,
        };
        let bodies;
        try {
            bodies = await timelineEditorialRuntime.hydrateDocument(acquisitionDocument, context);
        } catch {
            await timelineEditorialRuntime.releaseCurrentSessionPins().catch(() => undefined);
            return timelineCommandError(
                'missing-transcript',
                'An acquired editorial transcript could not be verified from content-addressed storage.',
                acquired.map((descriptor) => descriptor.recordId),
            );
        }
        if (get().revision !== before.revision) {
            await timelineEditorialRuntime.releaseCurrentSessionPins().catch(() => undefined);
            return timelineCommandError('stale-document', 'Document revision changed during transcript hydration.', []);
        }
        const recordIdBySourceId = Object.fromEntries(acquired.map((descriptor) => [
            descriptor.sourceId,
            descriptor.recordId,
        ]));
        request.onProgress?.({
            stage: 'building-text-edit',
            sourceCount: sources.length,
        });
        const planned = planActivateNarrative({
            document: acquisitionDocument,
            guard: createNarrativeCommandGuard(acquisitionDocument),
            selectedTrackIds: request.selectedTrackIds,
            recordIdBySourceId,
            bodies,
            idFactory: createTimelineNarrativeIdFactory(),
            nowIso: new Date().toISOString(),
            splitOnSpeakerChange: request.splitOnSpeakerChange,
        });
        if (planned.kind !== 'success') {
            await timelineEditorialRuntime.releaseCurrentSessionPins().catch(() => undefined);
            return planned;
        }
        const integrated = integrateNarrativeCommandLinks({
            before: acquisitionDocument,
            narrativeResult: planned,
            discoverNewOverlaps: true,
        });
        if (integrated.kind !== 'success') {
            await timelineEditorialRuntime.releaseCurrentSessionPins().catch(() => undefined);
            return integrated;
        }
        try {
            const committed = commitV4CommandDocument({
                state,
                document: integrated.document,
                historyLabel: planned.history.label ?? 'Enable text editing',
                ...(planned.history.mergeKey ? { mergeKey: planned.history.mergeKey } : {}),
                audioGraph: planned.impact.audioGraph,
                recalculateContentBoundary: true,
            });
            if (!committed) {
                await timelineEditorialRuntime.releaseCurrentSessionPins().catch(() => undefined);
                return timelineCommandNoop();
            }
        } catch {
            await timelineEditorialRuntime.releaseCurrentSessionPins().catch(() => undefined);
            return timelineCommandError('invalid-proposal', 'Activation produced an invalid V4 graph.', []);
        }
        return toTimelineCommandSuccess(planned);
    },

    releaseNarrativeTracks: async (trackIds) => {
        const state = discardActiveDragPreview();
        const before = buildEditorDocumentFromState(state);
        const planned = planReleaseNarrativeTracks({
            document: before,
            guard: createNarrativeCommandGuard(before),
            trackIds,
            nowIso: new Date().toISOString(),
        });
        if (planned.kind !== 'success') return planned;
        const integrated = integrateNarrativeCommandLinks({
            before,
            narrativeResult: planned,
            discoverNewOverlaps: false,
        });
        if (integrated.kind !== 'success') return integrated;
        try {
            const committed = commitV4CommandDocument({
                state,
                document: integrated.document,
                historyLabel: planned.history.label ?? 'Release controlled tracks',
                audioGraph: planned.impact.audioGraph,
                recalculateContentBoundary: planned.impact.audioGraph,
            });
            return committed ? toTimelineCommandSuccess(planned) : timelineCommandNoop();
        } catch {
            return timelineCommandError('invalid-proposal', 'Release produced an invalid V4 graph.', trackIds);
        }
    },

    executeNarrativeCommand: async (request) => {
        const state = discardActiveDragPreview();
        const before = buildEditorDocumentFromState(state);
        if (request.type === 'refine-boundary'
            && request.origin === 'quiet-assisted'
            && !timelineEditorialRuntime.getQuietWindowDecoder()) {
            return timelineCommandError(
                'quiet-refinement-unavailable',
                'Quiet-assisted refinement requires a real bounded PCM decoder.',
                [request.blockId],
            );
        }
        const planned = planTimelineNarrativeCommand({
            document: before,
            bodies: timelineEditorialRuntime.getResolvedBodies(),
            request,
            nowIso: new Date().toISOString(),
        });
        if (planned.kind !== 'success') return planned;
        const integrated = integrateNarrativeCommandLinks({
            before,
            narrativeResult: planned,
            discoverNewOverlaps: false,
        });
        if (integrated.kind !== 'success') return integrated;
        try {
            const committed = commitV4CommandDocument({
                state,
                document: integrated.document,
                historyLabel: planned.history.label ?? planned.command,
                ...(planned.history.mergeKey ? { mergeKey: planned.history.mergeKey } : {}),
                audioGraph: planned.impact.audioGraph,
                recalculateContentBoundary: planned.impact.audioGraph,
            });
            return committed ? toTimelineCommandSuccess(planned) : timelineCommandNoop();
        } catch {
            return timelineCommandError('invalid-proposal', 'Narrative command produced an invalid V4 graph.', []);
        }
    },

    executeEditorialLinkCommand: (request) => {
        const state = discardActiveDragPreview();
        const before = buildEditorDocumentFromState(state);
        const planned = planTimelineEditorialLinkCommand({ document: before, request });
        if (planned.kind !== 'success') return planned;
        try {
            const committed = commitV4CommandDocument({
                state,
                document: planned.document,
                historyLabel: planned.history.label ?? planned.command,
                audioGraph: planned.impact.audioGraph,
                recalculateContentBoundary: planned.targetMutations.length > 0,
            });
            return committed
                ? {
                    kind: 'success',
                    command: planned.command,
                    playhead: { kind: 'keep', reason: 'non-structural' },
                }
                : timelineCommandNoop();
        } catch {
            return timelineCommandError('invalid-proposal', 'Link command produced an invalid V4 graph.', []);
        }
    },

    executeOrdinaryV4Command: (request) => {
        const state = get();
        const before = buildEditorDocumentFromState(getOrdinaryPlanningState(state));
        return commitOrdinaryPlan({
            state,
            before,
            planned: planTimelineOrdinaryV4Command(before, request),
        });
    },

    setGlobalEditingMode: (mode) => {
        const state = discardActiveDragPreview();
        const before = buildEditorDocumentFromState(state);
        const planned = planChangeGlobalEditingMode({
            document: before,
            expectedDocumentRevision: before.revision,
            mode,
        });
        if (planned.kind !== 'success') return planned;
        try {
            const committed = commitV4CommandDocument({
                state,
                document: planned.document,
                historyLabel: planned.history.label ?? 'Change editing mode',
                audioGraph: false,
                recalculateContentBoundary: false,
            });
            return committed ? toTimelineCommandSuccess(planned) : timelineCommandNoop();
        } catch {
            return timelineCommandError('invalid-proposal', 'Editing mode command produced an invalid V4 graph.', []);
        }
    },

    splitSelectedMediaAtFrame: (timelineFrame, requestedRightClipId) => {
        const state = get();
        if (state.transientSelection.kind === 'video-clip') {
            get().splitVideoClip(
                state.transientSelection.clipId,
                framesToSeconds(timelineFrame, state.renderProfile.fps),
                requestedRightClipId ?? crypto.randomUUID(),
            );
        } else if (state.transientSelection.kind === 'audio-clip') {
            get().splitAudioClip(
                state.transientSelection.clipId,
                timelineFrame,
                requestedRightClipId ?? crypto.randomUUID(),
            );
        }
    },

    deleteSelectedMedia: () => {
        const selection = get().transientSelection;
        if (selection.kind === 'video-clip') get().deleteVideoClip(selection.clipId);
        else if (selection.kind === 'audio-clip') get().deleteAudioClip(selection.clipId);
    },

    bumpRevision: () => {
        const revision = get().revision + 1;
        set({ revision });
        return revision;
    },

    ensureRevisionAtLeast: (revisionFloor) => {
        const currentRevision = get().revision;
        const revision = Math.max(currentRevision, Math.floor(revisionFloor));
        if (revision !== currentRevision) set({ revision });
        return revision;
    },

    setTracks: (tracks, options) => {
        const state = get();
        const normalizedTracks = cloneTracks(tracks);
        const isValidActive = normalizedTracks.some(t => t.id === state.activeTrackId);
        const activeTrackId = isValidActive ? state.activeTrackId : (normalizedTracks.length > 0 ? normalizedTracks[0].id : null);
        const trackIds = new Set(normalizedTracks.map((track) => track.id));
        const transcriptionByTrackId = Object.fromEntries(
            Object.entries(state.transcriptionByTrackId).filter(([trackId]) => trackIds.has(trackId)),
        );
        const legacy = getLegacyTranscriptionForTrack(transcriptionByTrackId, activeTrackId);
        const selectedSubtitleIds = cleanSubtitleSelection(state.selectedSubtitleIds, normalizedTracks);
        const transientSelection = state.transientSelection.kind === 'subtitles'
            ? transientSubtitleSelection(normalizedTracks, selectedSubtitleIds, activeTrackId)
            : state.transientSelection;

        const hasSameTrackCatalog = normalizedTracks.length === state.tracks.length
            && normalizedTracks.every((track, index) => track.id === state.tracks[index]?.id);
        if (!options?.resetHistory && !options?.skipHistory && !options?.skipSave && hasSameTrackCatalog) {
            planAndCommitSubtitleReplacement({
                state,
                tracks: normalizedTracks,
                activeTrackId,
                transientSelection,
                history: { label: 'Replace subtitle tracks' },
            });
            return;
        }

        const patch: Partial<TimelineStore> = {
            tracks: normalizedTracks,
            activeTrackId,
            selectedSubtitleIds,
            transientSelection,
            selectedClipId: state.selectedClipId
                && state.videoClips.some((clip) => clip.id === state.selectedClipId)
                ? state.selectedClipId
                : null,
            transcriptionByTrackId,
            rawTranscription: cloneSubtitles(legacy?.raw ?? null),
            transcriptionGroups: cloneTranscriptionGroups(legacy?.groups ?? null),
            transcriptionContainerIds: cloneContainerIds(legacy?.containerIds ?? null),
            lastSelectedId: null,
            isVideoSelected: false,
        };
        if (options?.resetHistory) {
            set({
                ...patch,
                contentBoundaryRevision: state.contentBoundaryRevision + 1,
                history: [],
                redoStack: [],
                historySequence: 0,
                historyBytes: 0,
            });
            if (!options.skipSave) persistEditorMutation();
            return;
        }
        commitDurableMutation(state, patch, {
            recordHistory: !options?.skipHistory,
            history: { label: 'Replace subtitle tracks' },
            persist: !options?.skipSave,
            recalculateContentBoundary: true,
        });
    },

    setVideoSelected: (selected) => set((state) => ({
        isVideoSelected: selected,
        // Delsect subtitles if we are selecting the video
        selectedSubtitleIds: selected ? [] : state.selectedSubtitleIds,
        selectedClipId: selected ? state.selectedClipId : null,
        transientSelection: selected && state.selectedClipId
            ? { kind: 'video-clip', clipId: state.selectedClipId }
            : { kind: 'none' },
    })),

    setIsDragging: (dragging, metadata) => {
        if (dragging) {
            if (metadata && !metadata.label.trim()) {
                throw new Error('Subtitle drag sessions require semantic history metadata.');
            }
            if (!subtitleDragPreview && metadata) {
                const state = get();
                subtitleDragPreview = {
                    durableTracks: state.tracks,
                    previewTracks: state.tracks,
                    touchedFields: new Map(),
                    movedSubtitleIds: new Set(),
                    historyMetadata: metadata,
                };
            }
            // Ruler, playhead, and numeric-input drags share this UI activity flag but do not
            // mutate subtitle documents. Only a caller with semantic metadata opens the deferred
            // subtitle history transaction above.
            set({ isDragging: true });
            return;
        }

        const current = get();
        const preview = subtitleDragPreview;
        subtitleDragPreview = null;
        if (!preview) {
            if (current.isDragging) set({ isDragging: false });
            return;
        }

        const recalculateContentBoundary = subtitlePreviewRecalculatesContentBoundary(preview);
        if (!subtitlePreviewChangesDurableTracks(preview)) {
            // Returning to the durable position is a strict no-op. A deferred history request was
            // never inserted, so concurrent command history remains untouched. A timing preview
            // still invalidates the cached terminal frame once more when its overlay is removed.
            set({
                tracks: preview.durableTracks,
                isDragging: false,
                ...(recalculateContentBoundary
                    ? { contentBoundaryRevision: current.contentBoundaryRevision + 1 }
                    : {}),
            });
            return;
        }

        const durableState = { ...current, tracks: preview.durableTracks } as TimelineStore;
        const finalTracks = applySubtitlePreviewToDurableTracks(preview);
        const result = planAndCommitSubtitleReplacement({
            state: durableState,
            tracks: finalTracks,
            activeTrackId: durableState.activeTrackId,
            transientSelection: durableState.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(
                    finalTracks,
                    durableState.selectedSubtitleIds,
                    durableState.activeTrackId,
                )
                : durableState.transientSelection,
            history: preview.historyMetadata,
        });
        if (result.kind !== 'success') {
            set({
                tracks: preview.durableTracks,
                isDragging: false,
                ...(recalculateContentBoundary
                    ? { contentBoundaryRevision: current.contentBoundaryRevision + 1 }
                    : {}),
            });
            return;
        }
        set({ isDragging: false });
    },

    cancelSubtitleDrag: () => {
        // Cancellation restores the closure-owned durable baseline without recording the pointer
        // preview as a command. This is intentionally distinct from setIsDragging(false), whose
        // physical pointer-up terminal commits the complete gesture.
        discardActiveDragPreview();
    },

    setActiveTrackId: (id) => {
        const state = get();
        const activeTrackId = state.tracks.some(t => t.id === id)
            ? id
            : (state.tracks.length > 0 ? state.tracks[0].id : null);
        if (activeTrackId === state.activeTrackId) return;
        const legacy = getLegacyTranscriptionForTrack(state.transcriptionByTrackId, activeTrackId);
        commitDurableMutation(state, {
            activeTrackId,
            rawTranscription: cloneSubtitles(legacy?.raw ?? null),
            transcriptionGroups: cloneTranscriptionGroups(legacy?.groups ?? null),
            transcriptionContainerIds: cloneContainerIds(legacy?.containerIds ?? null),
        }, { recordHistory: false });
    },

    toggleSubtitleSelection: (id, isMulti, isRange) => set((state) => {
        let newSelection: string[] = [];

        if (isRange && state.lastSelectedId) {
            // Range selection
            const allSubs = state.tracks.flatMap(t => t.subtitles).sort((a, b) => a.startTime - b.startTime);
            const idx1 = allSubs.findIndex(s => s.id === state.lastSelectedId);
            const idx2 = allSubs.findIndex(s => s.id === id);

            if (idx1 !== -1 && idx2 !== -1) {
                const start = Math.min(idx1, idx2);
                const end = Math.max(idx1, idx2);
                const range = allSubs.slice(start, end + 1).map(s => s.id);

                if (isMulti) {
                    newSelection = Array.from(new Set([...state.selectedSubtitleIds, ...range]));
                } else {
                    newSelection = range;
                }
            } else {
                newSelection = [id];
            }
        } else if (isMulti) {
            // Toggle selection
            if (state.selectedSubtitleIds.includes(id)) {
                newSelection = state.selectedSubtitleIds.filter(sid => sid !== id);
            } else {
                newSelection = [...state.selectedSubtitleIds, id];
            }
        } else {
            // Single selection
            newSelection = [id];
        }

        // Find track of the last selected subtitle to make it active
        let newActiveTrackId = state.activeTrackId;
        const trackWithSubtitle = state.tracks.find(t => t.subtitles.some(s => s.id === id));
        if (trackWithSubtitle) {
            newActiveTrackId = trackWithSubtitle.id;
        }

        return {
            selectedSubtitleIds: newSelection,
            lastSelectedId: id,
            activeTrackId: newActiveTrackId,
            selectedClipId: null,
            isVideoSelected: false, // Deselect video when selecting subtitles
            transientSelection: transientSubtitleSelection(state.tracks, newSelection, newActiveTrackId),
        };
    }),

    clearSelection: () => set({
        selectedSubtitleIds: [],
        selectedClipId: null,
        lastSelectedId: null,
        isVideoSelected: false,
        transientSelection: { kind: 'none' },
    }),

    setSnapEnabled: (enabled) => set({ snapEnabled: enabled }),

    setActiveSnapTime: (time) => set({ activeSnapTime: time }),

    copySelection: () => set((state) => {
        if (state.selectedSubtitleIds.length === 0) return state;

        const clipboard: { subtitle: Subtitle, relativeTrackIndex: number }[] = [];
        const baseTrackIndex = state.tracks.findIndex(t => t.id === state.activeTrackId);
        const refTrackIndex = baseTrackIndex !== -1 ? baseTrackIndex : 0;

        state.tracks.forEach((track, tIdx) => {
            track.subtitles.forEach(sub => {
                if (state.selectedSubtitleIds.includes(sub.id)) {
                    clipboard.push({
                        subtitle: { ...sub },
                        relativeTrackIndex: tIdx - refTrackIndex
                    });
                }
            });
        });

        return { clipboard };
    }),

    pasteSelection: (targetStartTime) => {
        const state = get();
        const { clipboard, tracks, activeTrackId } = state;
        if (!clipboard || clipboard.length === 0) return;

        const baseTrackIndex = tracks.findIndex(t => t.id === activeTrackId);
        const refTrackIndex = baseTrackIndex !== -1 ? baseTrackIndex : 0;

        // Find reference start time (earliest among clipboard items)
        const earliestTime = Math.min(...clipboard.map(item => item.subtitle.startTime));

        const newSelectionIds: string[] = [];
        const newTracks = tracks.map((track, tIdx) => {
            const itemsForThisTrack = clipboard.filter(item => {
                const targetTrackIdx = refTrackIndex + item.relativeTrackIndex;
                return targetTrackIdx === tIdx;
            });

            if (itemsForThisTrack.length === 0) return track;

            const pastedSubs = itemsForThisTrack.map(item => {
                const id = crypto.randomUUID();
                newSelectionIds.push(id);
                const offset = item.subtitle.startTime - earliestTime;
                const duration = item.subtitle.endTime - item.subtitle.startTime;

                return {
                    ...item.subtitle,
                    id,
                    startTime: targetStartTime + offset,
                    endTime: targetStartTime + offset + duration
                };
            });

            return {
                ...track,
                subtitles: [...track.subtitles, ...pastedSubs].sort((a, b) => a.startTime - b.startTime)
            };
        });

        const selectedSubtitleIds = [...newSelectionIds];
        planAndCommitSubtitleReplacement({
            state,
            tracks: newTracks,
            activeTrackId,
            transientSelection: transientSubtitleSelection(newTracks, selectedSubtitleIds, activeTrackId),
            history: { label: 'Paste subtitles' },
        });
    },

    trimSubtitleAtTime: (time, side) => {
        const { tracks, activeTrackId, updateSubtitleInTrack, removeSubtitleFromTrack } = get();
        const fps = get().projectFps || 30;
        const frameDuration = 1 / fps;

        // 1. Find the target track and subtitle
        let targetTrackId: string | null = null;
        let targetSubtitle: Subtitle | null = null;
        let mode: 'trim' | 'extend' = 'trim';

        const result = findSubtitleAcrossTracks(tracks, time, activeTrackId);
        if (result) {
            targetSubtitle = result.subtitle;
            targetTrackId = result.trackId;
        }

        // 2. Decide if we trim the current sub or extend a neighbor
        if (targetSubtitle && targetTrackId) {
            if (side === 'start') {
                // If we are EXACTLY at the start of the sub (or within epsilon), we extend previous sub instead of trimming
                if (time <= targetSubtitle.startTime + 0.005) {
                    mode = 'extend';
                }
            } else {
                // If we are EXACTLY at the end of the sub (or within epsilon), we extend next sub instead of trimming
                if (time >= targetSubtitle.endTime - 0.005) {
                    mode = 'extend';
                }
            }
        } else {
            // If no sub under playhead, we are in a gap, so we extend
            mode = 'extend';
            targetTrackId = activeTrackId || (tracks.length > 0 ? tracks[0].id : null);
        }

        if (!targetTrackId) return;
        const track = tracks.find(t => t.id === targetTrackId);
        if (!track) return;

        if (mode === 'trim' && targetSubtitle) {
            const newStartTime = side === 'start' ? time : targetSubtitle.startTime;
            const newEndTime = side === 'end' ? time : targetSubtitle.endTime;
            const newDuration = newEndTime - newStartTime;

            if (newDuration < frameDuration - 0.001) {
                removeSubtitleFromTrack(targetTrackId, targetSubtitle.id);
            } else {
                updateSubtitleInTrack(targetTrackId, targetSubtitle.id, side === 'start' ? { startTime: time } : { endTime: time });
            }
        } else {
            // Extend Neighbor
            if (side === 'start') {
                // Extension (Q): Find sub that ends BEFORE time
                const prevSub = [...track.subtitles]
                    .filter(s => s.endTime <= time + 0.005)
                    .sort((a, b) => b.endTime - a.endTime)[0];

                if (prevSub) {
                    // If it's already touching the playhead, delete it
                    if (prevSub.endTime >= time - 0.005) {
                        removeSubtitleFromTrack(targetTrackId, prevSub.id);
                    } else {
                        updateSubtitleInTrack(targetTrackId, prevSub.id, { endTime: time });
                    }
                }
            } else {
                // Extension (W): Find sub that starts AFTER time
                const nextSub = [...track.subtitles]
                    .filter(s => s.startTime >= time - 0.005)
                    .sort((a, b) => a.startTime - b.startTime)[0];

                if (nextSub) {
                    // If it's already touching the playhead, delete it
                    if (nextSub.startTime <= time + 0.005) {
                        removeSubtitleFromTrack(targetTrackId, nextSub.id);
                    } else {
                        updateSubtitleInTrack(targetTrackId, nextSub.id, { startTime: time });
                    }
                }
            }
        }
    },

    selectSubtitleAtTime: (time) => {
        const { tracks, activeTrackId, toggleSubtitleSelection } = get();

        const result = findSubtitleAcrossTracks(tracks, time, activeTrackId);
        const targetSubtitle = result?.subtitle || null;

        if (targetSubtitle) {
            toggleSubtitleSelection(targetSubtitle.id);
            return targetSubtitle.id;
        }
        return null;
    },

    requestEditSubtitleAtTime: (time) => {
        const { tracks, activeTrackId, selectSubtitleAtTime } = get();
        const subtitleId = selectSubtitleAtTime(time);

        if (subtitleId) {
            set({ requestEditSubtitleId: subtitleId });
            return;
        }

        // If no subtitle found, create a new one ("Add on Enter" feature)
        // 1. Determine target track (active or first available)
        const targetTrackId = activeTrackId || (tracks.length > 0 ? tracks[0].id : null);
        if (!targetTrackId) return;

        const targetTrack = tracks.find(t => t.id === targetTrackId);
        if (!targetTrack) return;

        // 2. Find the next subtitle on this track to avoid overlap
        // We use a small EPSILON to avoid overlaps caused by precision issues
        const EPSILON = 0.001;
        const nextSub = [...targetTrack.subtitles]
            .sort((a, b) => a.startTime - b.startTime)
            .find(s => s.startTime > time + EPSILON);

        // 3. Calculate duration (default 2s, capped by next sub)
        let endTime = time + 2;

        if (nextSub && endTime > nextSub.startTime) {
            endTime = nextSub.startTime;
        }

        // 4. Ensure we have at least one frame of space
        const fps = get().projectFps || 30;
        if (endTime - time < 1 / fps) return;

        // 5. Create and focus
        const newId = crypto.randomUUID();
        const state = get();
        const nextTracks = state.tracks.map((track) => track.id === targetTrackId
            ? {
                ...track,
                subtitles: [...track.subtitles, {
                    id: newId,
                    startTime: time,
                    endTime,
                    text: '',
                }],
            }
            : track);
        const addResult = planAndCommitSubtitleReplacement({
            state,
            tracks: nextTracks,
            activeTrackId: targetTrackId,
            transientSelection: transientSubtitleSelection(nextTracks, [newId], targetTrackId),
            history: { label: 'Add subtitle' },
        });

        if (addResult.kind === 'success') set({ requestEditSubtitleId: newId });
    },

    clearEditRequest: () => set({ requestEditSubtitleId: null }),

    setTranscriptionState: (groups, containerIds, raw) => {
        const state = get();
        const nextRaw = raw !== undefined ? raw : state.rawTranscription;
        const transcriptionByTrackId = { ...state.transcriptionByTrackId };
        if (state.activeTrackId) {
            if (groups && containerIds) {
                transcriptionByTrackId[state.activeTrackId] = {
                    raw: cloneSubtitles(nextRaw) ?? [],
                    groups: cloneTranscriptionGroups(groups) ?? {},
                    containerIds: cloneContainerIds(containerIds) ?? [],
                    sourceDocumentRevision: state.revision + 1,
                    sourceAudioGraphRevision: state.audioGraphRevision,
                    sourceAudioGraphSignature: getEditorAudioGraphSignature(buildEditorDocumentFromState(state)),
                    stale: false,
                };
            } else {
                delete transcriptionByTrackId[state.activeTrackId];
            }
        }

        commitDurableMutation(state, {
            transcriptionGroups: groups,
            transcriptionContainerIds: containerIds,
            rawTranscription: nextRaw,
            transcriptionByTrackId,
        }, { history: { label: 'Update transcription grouping' } });
    },

    generateDefaultGrouperState: (words, wordsPerLine = 3) =>
        generateDefaultGrouperState(words, wordsPerLine),

    generateTimelineSubtitles: (words, wordsPerLine = 3) =>
        generateTimelineSubtitles(words, wordsPerLine),

    setCuts: (cuts) => set({ cuts }),
    clearCuts: () => set({ cuts: [] }),
    setDetectionProgress: (progress) => set({ detectionProgress: progress }),
    setIsDetecting: (isDetecting) => set({ isDetecting })
    });
});
