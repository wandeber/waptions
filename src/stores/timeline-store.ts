import { create } from 'zustand';
import { AnimationStyle, Subtitle, type SubtitleTrack } from '@/types/timeline';
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
    VideoSourceAsset,
} from '@/types/video';
import type { EditorPersistentAsset } from '@/lib/storage/storage-service';
import { validateEditorDocumentV3 } from '@/lib/editor-document-v3';
import {
    createTranscriptionJobGuard,
    getEditorAudioGraphSignature,
    isTranscriptionJobGuardCurrent,
    type AudioGraphMutationImpact,
} from '@/lib/audio-graph-signature';
import {
    createDefaultRenderProfile,
    frameRateToNumber,
    framesToSeconds,
    normalizeFrameRate,
    secondsToFrames,
} from '@/lib/render-profile';
import {
    cloneAudioTracks,
    findAudioClip,
    clampFrameFades,
    clampSampleFades,
} from '@/lib/audio-timeline';
import {
    appendVideoClips as appendClipsToTimeline,
    buildClipPlacements,
    cleanSubtitleSelection,
    deleteVideoClip as deleteClipFromTimeline,
    getTimelineDurations,
    isSafeVideoId,
    reorderVideoClips as reorderClipsInTimeline,
    trimVideoClip as trimClipInTimeline,
} from '@/lib/video-timeline';
import {
    applyVideoEditToSubtitleDomains,
    clampVideoClipAudioFades,
    deleteAudioClipCommand,
    getCanonicalVideoClipDurationFrames,
    haveEqualClipPlacements,
    moveAudioClipCommand,
    splitAudioClipCommand,
    splitVideoClipCommand,
    trimAudioClipCommand,
    updateSubtitleCommand,
} from '@/lib/editor-commands';
import type {
    TimelinePersistenceBinding,
    TimelineStore,
    TimelineVideoClip,
} from './timeline-store-types';
import {
    DEFAULT_VIDEO_CLIP_AUDIO,
    buildEditorDocumentFromState,
    buildEditorManifestFromState,
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

export type {
    AudioClipEditableSettings,
    MixedMediaCandidate,
    TimelinePersistenceBinding,
    TimelineStore,
    TimelineVideoClip,
} from './timeline-store-types';

let timelinePersistenceBinding: TimelinePersistenceBinding | null = null;

export const createTimelinePersistencePayload = (
    timeline: TimelineStore,
    sourceAssets: readonly EditorPersistentAsset[] = [],
    buildManifest: (state: TimelineStore) => ReturnType<typeof buildEditorManifestFromState>
        = buildEditorManifestFromState,
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
    // Mutations enqueue one canonical v3 document after Zustand has committed the complete state.
    // The same manifest instance feeds dirty revision tracking and persistence, so a keystroke or
    // pointer commit never rebuilds and serializes the full editor graph merely to test dirtiness.
    const payload = createTimelinePersistencePayload(timeline, sourceAssets);
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
            recalculateContentBoundary?: boolean;
        } = {},
    ): boolean => {
        const preview = subtitleDragPreview;
        const durableState = preview
            ? { ...state, tracks: preview.durableTracks }
            : state;
        const durablePatch = preview && patch.tracks
            ? {
                ...patch,
                tracks: removeSubtitlePreviewFromTracks(patch.tracks, state.tracks, preview),
            }
            : patch;
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
            persistEditorMutation(options.sourceAssets, committedDurableState);
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
    videoSources: [],
    videoClips: [],
    audioSources: [],
    audioTracks: [],
    transientSelection: { kind: 'none' },
    transcriptionByTrackId: {},
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
        set({
            ...finalizeDurablePatch(
                state,
                restored,
                entry.audioGraphMutationImpact,
                entry.recalculatesContentBoundary,
            ),
            ...boundedHistory,
        });
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
        set({
            ...finalizeDurablePatch(
                state,
                restored,
                entry.audioGraphMutationImpact,
                entry.recalculatesContentBoundary,
            ),
            ...boundedHistory,
        });
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
        set({
            ...finalizeDurablePatch(
                state,
                restoreTimelineHistoryProjection(projection),
                impact,
                recalculatesContentBoundary,
            ),
            ...bounded,
        });
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
        commitDurableMutation(state, {
            tracks: state.tracks.map((track) => track.id === trackId
                ? { ...track, subtitles: [...track.subtitles, { ...subtitle, id: newId }] }
                : track),
        }, { history: { label: 'Add subtitle' }, recalculateContentBoundary: true });
        return newId;
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
        commitDurableMutation(state, {
            tracks,
        }, {
            recordHistory: !options?.skipHistory,
            history: {
                label: subtitleUpdatesTiming(updates) ? 'Edit subtitle timing' : 'Edit subtitle',
            },
            recalculateContentBoundary: subtitleUpdatesTiming(updates),
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

        commitDurableMutation(state, {
            tracks: finalTracks,
            activeTrackId: targetTrackId,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(finalTracks, state.selectedSubtitleIds, targetTrackId)
                : state.transientSelection,
        }, { history: { label: 'Move subtitle to track' }, recalculateContentBoundary: true });
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

        commitDurableMutation(state, {
            tracks: newTracks,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(newTracks, state.selectedSubtitleIds, state.activeTrackId)
                : state.transientSelection,
        }, {
            recordHistory: !options?.skipHistory,
            history: { label: 'Move subtitles between tracks' },
            recalculateContentBoundary: true,
        });
    },

    removeSubtitleFromTrack: (trackId, subtitleId) => {
        const state = get();
        const track = state.tracks.find(t => t.id === trackId);
        if (!track?.subtitles.some(s => s.id === subtitleId)) return;
        const newTracks = state.tracks.map(t => t.id === trackId
            ? { ...t, subtitles: t.subtitles.filter(s => s.id !== subtitleId) }
            : t);
        const selectedSubtitleIds = state.selectedSubtitleIds.filter(id => id !== subtitleId);
        commitDurableMutation(state, {
            tracks: newTracks,
            selectedSubtitleIds,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(newTracks, selectedSubtitleIds, state.activeTrackId)
                : state.transientSelection,
        }, { history: { label: 'Delete subtitle' }, recalculateContentBoundary: true });
    },

    hydrateEditorDocument: (document, historyState) => {
        const validation = validateEditorDocumentV3(document);
        if (!validation.valid) {
            throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
        }
        const provenance = cloneTranscriptionByTrackId(document.transcriptionByTrackId);
        const legacy = getLegacyTranscriptionForTrack(provenance, document.activeSubtitleTrackId);
        const projectFps = frameRateToNumber(document.renderProfile.fps);
        const tracks = cloneTracks(document.subtitleTracks);
        const contentBoundaryRevision = get().contentBoundaryRevision + 1;
        set({
            revision: document.revision,
            audioGraphRevision: document.audioGraphRevision,
            contentBoundaryRevision,
            projectFps,
            renderProfile: cloneRenderProfile(document.renderProfile),
            tracks,
            videoSources: document.videoSources.map((source) => ({ ...source })),
            videoClips: cloneVideoClips(document.videoClips),
            audioSources: document.audioSources.map((source) => ({ ...source })),
            audioTracks: cloneAudioTracks(document.audioTracks),
            // Durable manifests intentionally omit selection; direct runtime hydration accepts
            // a validated selection but keeps the legacy mirror fields synchronized with it.
            transientSelection: cloneTransientSelection(document.transientSelection),
            activeTrackId: document.activeSubtitleTrackId,
            selectedSubtitleIds: document.transientSelection.kind === 'subtitles'
                ? [...document.transientSelection.subtitleIds]
                : [],
            selectedClipId: document.transientSelection.kind === 'video-clip'
                ? document.transientSelection.clipId
                : null,
            transcriptionByTrackId: provenance,
            rawTranscription: cloneSubtitles(legacy?.raw ?? null),
            transcriptionGroups: cloneTranscriptionGroups(legacy?.groups ?? null),
            transcriptionContainerIds: cloneContainerIds(legacy?.containerIds ?? null),
            history: historyState?.history ?? [],
            redoStack: historyState?.redoStack ?? [],
            historySequence: historyState?.historySequence ?? 0,
            historyBytes: historyState?.historyBytes ?? 0,
            lastSelectedId: null,
            isVideoSelected: document.transientSelection.kind === 'video-clip',
            isDragging: false,
        });
        subtitleDragPreview = null;
        useVideoStore.getState().syncSourceCatalog(document.videoSources);
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
            tracks: [],
            videoSources: [],
            videoClips: [],
            audioSources: [],
            audioTracks: [],
            transientSelection: { kind: 'none' },
            activeTrackId: null,
            selectedSubtitleIds: [],
            selectedClipId: null,
            transcriptionByTrackId: {},
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
        const validation = validateEditorDocumentV3(buildEditorDocumentFromState({ ...state, ...validationPatch } as TimelineStore));
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
        const splitVideoClips = splitVideoClipCommand(
            state.videoClips,
            clipId,
            projectTime,
            rightClipId,
            state.renderProfile,
        );
        if (!splitVideoClips) return;
        commitDurableMutation(state, {
            videoClips: splitVideoClips,
        }, {
            history: { label: 'Split video clip' },
            impact: 'invalidate-transcription',
            recalculateContentBoundary: true,
        });
    },

    trimVideoClip: (clipId, sourceStart, sourceEnd) => {
        const state = get();
        if (!state.videoClips.some((clip) => clip.id === clipId)) return;
        const edit = trimClipInTimeline(
            state.videoClips,
            clipId,
            sourceStart,
            sourceEnd,
            state.videoSources,
            state.projectFps,
            getTimelineDurations(state.videoClips, state.tracks).contentDuration,
        );
        // Pointer deltas can be smaller than half a project frame. Once canonical snapping
        // returns the existing placement sequence, this is not an edit and must not invalidate
        // transcription provenance, consume history, increment revision, or enqueue persistence.
        if (haveEqualClipPlacements(state.videoClips, edit.videoClips)) return;
        const transformed = applyVideoEditToSubtitleDomains(
            state.tracks,
            state.selectedSubtitleIds,
            edit,
        );
        const trimmedVideoClips = cloneVideoClips(edit.videoClips).map((clip): TimelineVideoClip => {
            if (clip.id !== clipId || !clip.audio) return clip;
            // Trimming preserves the complete mix envelope. Only its two fade lengths are
            // proportionally reduced when their sum no longer fits the canonical new crop.
            return {
                ...clip,
                audio: clampVideoClipAudioFades(
                    clip.audio,
                    getCanonicalVideoClipDurationFrames(clip, state.renderProfile),
                ),
            };
        });
        commitDurableMutation(state, {
            videoClips: trimmedVideoClips,
            tracks: transformed.tracks,
            selectedSubtitleIds: transformed.selectedSubtitleIds,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(transformed.tracks, transformed.selectedSubtitleIds, state.activeTrackId)
                : state.transientSelection,
        }, {
            history: { label: 'Trim video clip', mergeKey: `video-trim:${clipId}` },
            impact: 'invalidate-transcription',
            recalculateContentBoundary: true,
        });
    },

    deleteVideoClip: (clipId) => {
        const state = get();
        if (!state.videoClips.some((clip) => clip.id === clipId)) return;
        const edit = deleteClipFromTimeline(
            state.videoClips,
            clipId,
            getTimelineDurations(state.videoClips, state.tracks).contentDuration,
            state.renderProfile.fps,
        );
        const transformed = applyVideoEditToSubtitleDomains(
            state.tracks,
            state.selectedSubtitleIds,
            edit,
        );
        commitDurableMutation(state, {
            videoClips: cloneVideoClips(edit.videoClips),
            tracks: transformed.tracks,
            selectedSubtitleIds: transformed.selectedSubtitleIds,
            selectedClipId: state.selectedClipId === clipId ? null : state.selectedClipId,
            transientSelection: state.transientSelection.kind === 'video-clip'
                && state.transientSelection.clipId === clipId
                ? { kind: 'none' }
                : state.transientSelection.kind === 'subtitles'
                    ? transientSubtitleSelection(transformed.tracks, transformed.selectedSubtitleIds, state.activeTrackId)
                    : state.transientSelection,
        }, {
            history: { label: 'Delete video clip' },
            impact: 'invalidate-transcription',
            recalculateContentBoundary: true,
        });
    },

    reorderVideoClips: (orderedClipIds) => {
        const state = get();
        if (
            orderedClipIds.length === state.videoClips.length
            && orderedClipIds.every((id, index) => state.videoClips[index]?.id === id)
        ) return;
        const edit = reorderClipsInTimeline(
            state.videoClips,
            orderedClipIds,
            getTimelineDurations(state.videoClips, state.tracks).contentDuration,
            state.renderProfile.fps,
        );
        const transformed = applyVideoEditToSubtitleDomains(
            state.tracks,
            state.selectedSubtitleIds,
            edit,
        );
        commitDurableMutation(state, {
            videoClips: cloneVideoClips(edit.videoClips),
            tracks: transformed.tracks,
            selectedSubtitleIds: transformed.selectedSubtitleIds,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(transformed.tracks, transformed.selectedSubtitleIds, state.activeTrackId)
                : state.transientSelection,
        }, {
            history: { label: 'Reorder video clips' },
            impact: 'invalidate-transcription',
            recalculateContentBoundary: true,
        });
    },

    selectClip: (clipId) => set((state) => {
        const selectedClipId = clipId && state.videoClips.some((clip) => clip.id === clipId) ? clipId : null;
        return {
            selectedClipId,
            selectedSubtitleIds: [],
            lastSelectedId: null,
            isVideoSelected: selectedClipId !== null,
            transientSelection: selectedClipId
                ? { kind: 'video-clip', clipId: selectedClipId }
                : { kind: 'none' },
        };
    }),

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
        const audioTracks = moveAudioClipCommand(state, clipId, targetTrackId, timelineStartFrame);
        if (!audioTracks) return;
        commitDurableMutation(state, {
            audioTracks,
            transientSelection: { kind: 'audio-clip', trackId: targetTrackId, clipId },
        }, {
            history: { label: 'Move audio clip', mergeKey: `audio-move:${clipId}` },
            impact: 'invalidate-transcription',
            recalculateContentBoundary: true,
        });
    },

    trimAudioClip: (clipId, side, timelineFrame) => {
        const state = get();
        const audioTracks = trimAudioClipCommand(state, clipId, side, timelineFrame);
        if (!audioTracks) return;
        commitDurableMutation(state, { audioTracks }, {
            history: { label: 'Trim audio clip', mergeKey: `audio-trim:${clipId}:${side}` },
            impact: 'invalidate-transcription',
            recalculateContentBoundary: true,
        });
    },

    splitAudioClip: (clipId, timelineFrame, rightClipId) => {
        if (!isSafeVideoId(rightClipId)) return;
        const state = get();
        const result = splitAudioClipCommand(state, clipId, timelineFrame, rightClipId);
        if (!result) return;
        commitDurableMutation(state, {
            audioTracks: result.audioTracks,
            transientSelection: { kind: 'audio-clip', trackId: result.trackId, clipId: rightClipId },
        }, {
            history: { label: 'Split audio clip' },
            impact: 'invalidate-transcription',
            recalculateContentBoundary: true,
        });
    },

    deleteAudioClip: (clipId) => {
        const state = get();
        const audioTracks = deleteAudioClipCommand(state, clipId);
        if (!audioTracks) return;
        commitDurableMutation(state, {
            audioTracks,
            transientSelection: state.transientSelection.kind === 'audio-clip'
                && state.transientSelection.clipId === clipId
                ? { kind: 'none' }
                : state.transientSelection,
        }, {
            history: { label: 'Delete audio clip' },
            impact: 'invalidate-transcription',
            recalculateContentBoundary: true,
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
        const track = state.tracks.find((item) => item.id === trackId);
        if (!track || getTrackTimingDomain(track) === timingDomain) return;
        commitDurableMutation(state, {
            tracks: state.tracks.map((item) => item.id === trackId ? { ...item, timingDomain } : item),
        }, { history: { label: 'Change subtitle timing domain' } });
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

    getTrackTranscriptionState: (trackId) => {
        const provenance = get().transcriptionByTrackId[trackId];
        return provenance ? cloneTranscriptionByTrackId({ value: provenance }).value : null;
    },

    buildEditorDocument: () => buildEditorDocumentFromState(get()),
    buildEditorManifest: () => buildEditorManifestFromState(get()),

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
        const isValidActive = tracks.some(t => t.id === state.activeTrackId);
        const activeTrackId = isValidActive ? state.activeTrackId : (tracks.length > 0 ? tracks[0].id : null);
        const trackIds = new Set(tracks.map((track) => track.id));
        const transcriptionByTrackId = Object.fromEntries(
            Object.entries(state.transcriptionByTrackId).filter(([trackId]) => trackIds.has(trackId)),
        );
        const legacy = getLegacyTranscriptionForTrack(transcriptionByTrackId, activeTrackId);
        const selectedSubtitleIds = cleanSubtitleSelection(state.selectedSubtitleIds, tracks);

        const patch: Partial<TimelineStore> = {
            tracks,
            activeTrackId,
            selectedSubtitleIds,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(tracks, selectedSubtitleIds, activeTrackId)
                : state.transientSelection,
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
        const prepared = prepareDurableTimelineMutation(durableState, {
            tracks: finalTracks,
        }, {
            history: preview.historyMetadata,
            recalculateContentBoundary,
        });
        if (!prepared) {
            set({
                tracks: preview.durableTracks,
                isDragging: false,
                ...(recalculateContentBoundary
                    ? { contentBoundaryRevision: current.contentBoundaryRevision + 1 }
                    : {}),
            });
            return;
        }

        const committedState = { ...durableState, ...prepared, isDragging: false } as TimelineStore;
        set({ ...prepared, isDragging: false });
        persistEditorMutation([], committedState);
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
        commitDurableMutation(state, {
            tracks: newTracks,
            selectedSubtitleIds,
            lastSelectedId: selectedSubtitleIds.at(-1) ?? null,
            selectedClipId: null,
            isVideoSelected: false,
            transientSelection: transientSubtitleSelection(newTracks, selectedSubtitleIds, activeTrackId),
        }, {
            history: { label: 'Paste subtitles' },
            recalculateContentBoundary: true,
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
        commitDurableMutation(state, {
            tracks: nextTracks,
            activeTrackId: targetTrackId,
            selectedSubtitleIds: [newId],
            lastSelectedId: newId,
            selectedClipId: null,
            isVideoSelected: false,
            transientSelection: transientSubtitleSelection(nextTracks, [newId], targetTrackId),
        }, {
            history: { label: 'Add subtitle' },
            recalculateContentBoundary: true,
        });

        set({ requestEditSubtitleId: newId });
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
