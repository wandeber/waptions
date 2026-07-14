import { create } from 'zustand';
import { SubtitleTrack, AnimationStyle, Subtitle } from '@/types/timeline';
import { useProjectStore } from './project-store';
import { useVideoStore } from './video-store';
import {
    findSubtitleAcrossTracks,
    generateDefaultGrouperState,
    generateTimelineSubtitles
} from '@/lib/timeline-utils';
import { Cut } from '@/lib/video-cut/core/types';
import type {
    AudioClip,
    AudioClipMixSettings,
    AudioSourceAsset,
    AudioTrack,
    EditorDocumentV3,
    EditorManifestV3,
    RenderProfile,
    SubtitleTrackV3,
    TrackTranscriptionProvenanceV3,
    TrackTranscriptionState,
    TranscriptionJobGuard,
    TransientMediaSelection,
    VideoClipAudioSettings,
    VideoClip,
    VideoClipV3,
    VideoSourceAsset,
} from '@/types/video';
import type { EditorPersistentAsset } from '@/lib/storage/storage-service';
import { createEditorManifestV3 } from '@/lib/editor-document-migration';
import { validateEditorDocumentV3 } from '@/lib/editor-document-v3';
import {
    createTranscriptionJobGuard,
    finalizeAudioGraphMutation,
    getEditorAudioGraphSignature,
    isTranscriptionJobGuardCurrent,
    type AudioGraphMutationImpact,
} from '@/lib/audio-graph-signature';
import { createDefaultRenderProfile, framesToSeconds, normalizeFrameRate, secondsToFrames } from '@/lib/render-profile';
import {
    cloneAudioTracks,
    findAudioClip,
    moveAudioClipInTracks,
    splitAudioClipInTracks,
    trimAudioClipInTracks,
    clampFrameFades,
    clampSampleFades,
} from '@/lib/audio-timeline';
import {
    appendVideoClips as appendClipsToTimeline,
    applyMediaEditToTimeline,
    buildClipPlacements,
    cleanSubtitleSelection,
    deleteVideoClip as deleteClipFromTimeline,
    getTimelineDurations,
    isSafeVideoId,
    reorderVideoClips as reorderClipsInTimeline,
    splitVideoClip as splitClipInTimeline,
    trimVideoClip as trimClipInTimeline,
} from '@/lib/video-timeline';

export interface TimelinePersistenceBinding {
    projectId: string;
    generation: number;
    enqueue: (manifest: EditorManifestV3, sourceAssets: readonly EditorPersistentAsset[]) => void;
}

let timelinePersistenceBinding: TimelinePersistenceBinding | null = null;

export function setTimelinePersistenceBinding(binding: TimelinePersistenceBinding | null): void {
    timelinePersistenceBinding = binding;
}

export type TimelineVideoClip = VideoClipV3;

interface HistorySnapshot {
    tracks: SubtitleTrack[];
    videoClips: TimelineVideoClip[];
    renderProfile: RenderProfile;
    audioTracks: AudioTrack[];
    transientSelection: TransientMediaSelection;
    activeTrackId: string | null;
    selectedSubtitleIds: string[];
    selectedClipId: string | null;
    transcriptionByTrackId: Record<string, TrackTranscriptionProvenanceV3>;
    rawTranscription: Subtitle[] | null;
    transcriptionGroups: { [key: string]: Subtitle[] } | null;
    transcriptionContainerIds: string[] | null;
    /** The terminal mutation recorded after this snapshot determines undo/redo invalidation. */
    audioGraphMutationImpact: AudioGraphMutationImpact;
}

interface SetTracksOptions {
    skipHistory?: boolean;
    resetHistory?: boolean;
    skipSave?: boolean;
}

export interface MixedMediaCandidate {
    videoSources?: VideoSourceAsset[];
    videoClips?: (VideoClip | VideoClipV3)[];
    audioSources?: AudioSourceAsset[];
    audioTracks?: AudioTrack[];
    insertionFrame?: number;
}

export type AudioClipEditableSettings = Partial<AudioClipMixSettings> & {
    fadeInSamples?: number;
    fadeOutSamples?: number;
    fadeInFrames?: number;
    fadeOutFrames?: number;
};

export interface TimelineStore {
    zoomLevel: number;
    scrollLeft: number;
    tracks: SubtitleTrack[];
    pixelsPerSecond: number;
    activeTrackId: string | null;
    selectedSubtitleIds: string[];
    selectedClipId: string | null;
    revision: number;
    audioGraphRevision: number;
    projectFps: number;
    renderProfile: RenderProfile;
    videoSources: VideoSourceAsset[];
    videoClips: TimelineVideoClip[];
    audioSources: AudioSourceAsset[];
    audioTracks: AudioTrack[];
    transientSelection: TransientMediaSelection;
    transcriptionByTrackId: Record<string, TrackTranscriptionProvenanceV3>;
    lastSelectedId: string | null;
    snapEnabled: boolean;
    activeSnapTime: number | null;
    clipboard: { subtitle: Subtitle, relativeTrackIndex: number }[] | null;
    requestEditSubtitleId: string | null;
    isVideoSelected: boolean;
    isDragging: boolean;

    // History
    history: HistorySnapshot[];
    redoStack: HistorySnapshot[];

    // Video Cuts
    cuts: Cut[];
    detectionProgress: number;
    isDetecting: boolean;

    // Actions
    setZoom: (zoom: number) => void;
    setScrollLeft: (scroll: number) => void;

    addTrack: (name?: string, style?: AnimationStyle, options?: { skipHistory?: boolean }) => string;
    removeTrack: (id: string) => void;
    updateTrackStyle: (id: string, style: Partial<AnimationStyle>) => void;
    updateTrackName: (id: string, name: string) => void;

    addSubtitleToTrack: (trackId: string, subtitle: Omit<Subtitle, 'id'>) => string;
    updateSubtitleInTrack: (trackId: string, subtitleId: string, updates: Partial<Subtitle>, options?: { skipHistory?: boolean }) => void;
    moveSubtitleToTrack: (subtitleId: string, sourceTrackId: string, targetTrackId: string) => void;
    moveSubtitlesToTrack: (subtitleIds: string[], deltaTrackIndex: number, options?: { skipHistory?: boolean }) => void;
    removeSubtitleFromTrack: (trackId: string, subtitleId: string) => void;

    setTracks: (tracks: SubtitleTrack[], options?: SetTracksOptions) => void;
    hydrateEditorDocument: (document: EditorDocumentV3) => void;
    resetEditorDocument: () => void;
    appendVideoSourcesAndClips: (sources: VideoSourceAsset[], clips: VideoClip[]) => void;
    appendAudioSourcesAndTracks: (sources: AudioSourceAsset[], tracks: AudioTrack[]) => void;
    appendMixedMediaCandidate: (candidate: MixedMediaCandidate, insertionFrame?: number) => void;
    detachVideoClipAudio: (
        clipId: string,
        idsOrTrackId?: { trackId?: string; clipId?: string } | string,
        detachedClipId?: string,
    ) => void;
    splitVideoClip: (clipId: string, projectTime: number, rightClipId: string) => void;
    trimVideoClip: (clipId: string, sourceStart: number, sourceEnd: number) => void;
    deleteVideoClip: (clipId: string) => void;
    reorderVideoClips: (orderedClipIds: string[]) => void;
    selectClip: (clipId: string | null) => void;
    selectAudioClip: (trackId: string, clipId: string) => void;
    moveAudioClip: (clipId: string, targetTrackId: string, timelineStartFrame: number) => void;
    trimAudioClip: (clipId: string, side: 'left' | 'right', timelineFrame: number) => void;
    splitAudioClip: (clipId: string, timelineFrame: number, rightClipId: string) => void;
    deleteAudioClip: (clipId: string) => void;
    addAudioTrack: (name?: string, id?: string) => string;
    removeAudioTrack: (trackId: string) => void;
    renameAudioTrack: (trackId: string, name: string) => void;
    updateAudioClipMix: (clipId: string, updates: AudioClipEditableSettings) => void;
    updateAudioTrackMix: (trackId: string, updates: Partial<Pick<AudioTrack, 'muted' | 'solo' | 'gainDb'>>) => void;
    setAudioTrackLocked: (trackId: string, locked: boolean) => void;
    updateVideoClipAudio: (clipId: string, updates: Partial<VideoClipAudioSettings>) => void;
    setSubtitleTrackTimingDomain: (trackId: string, timingDomain: 'video-ripple' | 'absolute') => void;
    setTrackTranscriptionState: (trackId: string, provenance: TrackTranscriptionState | TrackTranscriptionProvenanceV3 | null) => void;
    createTranscriptionGuard: (trackId: string) => TranscriptionJobGuard | null;
    replaceTrackWithTranscription: (
        trackId: string,
        subtitles: Subtitle[],
        provenance: TrackTranscriptionState,
        expectedRevision: number | TranscriptionJobGuard,
    ) => boolean;
    getTrackTranscriptionState: (trackId: string) => TrackTranscriptionProvenanceV3 | null;
    buildEditorDocument: () => EditorDocumentV3;
    buildEditorManifest: () => EditorManifestV3;
    splitSelectedMediaAtFrame: (timelineFrame: number, rightClipId?: string) => void;
    deleteSelectedMedia: () => void;
    bumpRevision: () => number;
    setActiveTrackId: (id: string | null) => void;
    toggleSubtitleSelection: (id: string, isMulti?: boolean, isRange?: boolean) => void;
    clearSelection: () => void;
    copySelection: () => void;
    pasteSelection: (startTime: number) => void;
    trimSubtitleAtTime: (time: number, side: 'start' | 'end') => void;
    selectSubtitleAtTime: (time: number) => string | null;
    requestEditSubtitleAtTime: (time: number) => void;
    clearEditRequest: () => void;

    // Video Cuts Actions
    setCuts: (cuts: Cut[]) => void;
    clearCuts: () => void;
    setDetectionProgress: (progress: number) => void;
    setIsDetecting: (isDetecting: boolean) => void;

    // History Actions
    undo: () => Promise<void>;
    redo: () => Promise<void>;
    pushHistory: (impact?: AudioGraphMutationImpact) => void;
    setSnapEnabled: (enabled: boolean) => void;
    setActiveSnapTime: (time: number | null) => void;
    setVideoSelected: (selected: boolean) => void;
    setIsDragging: (dragging: boolean) => void;

    // Transcription Persistence
    rawTranscription: Subtitle[] | null;
    transcriptionGroups: { [key: string]: Subtitle[] } | null;
    transcriptionContainerIds: string[] | null;
    setTranscriptionState: (
        groups: { [key: string]: Subtitle[] } | null,
        containerIds: string[] | null,
        raw?: Subtitle[] | null
    ) => void;
    // Layer generation helpers
    generateDefaultGrouperState: (words: Subtitle[], wordsPerLine?: number) => { groups: { [key: string]: Subtitle[] }, containerIds: string[] };
    generateTimelineSubtitles: (words: Subtitle[], wordsPerLine?: number) => Subtitle[];
}

const cloneTracks = (tracks: SubtitleTrack[]) => JSON.parse(JSON.stringify(tracks)) as SubtitleTrack[];
const cloneSubtitles = (subtitles: Subtitle[] | null) =>
    subtitles ? JSON.parse(JSON.stringify(subtitles)) as Subtitle[] : null;
const cloneTranscriptionGroups = (groups: { [key: string]: Subtitle[] } | null) =>
    groups ? JSON.parse(JSON.stringify(groups)) as { [key: string]: Subtitle[] } : null;
const cloneContainerIds = (ids: string[] | null) => ids ? [...ids] : null;
const cloneVideoClips = (clips: readonly (VideoClip | VideoClipV3)[]): TimelineVideoClip[] => clips.map((clip) => {
    const extended = clip as VideoClip & { audio?: VideoClipAudioSettings | null };
    return {
        ...extended,
        audio: extended.audio === null ? null : { ...(extended.audio ?? DEFAULT_VIDEO_CLIP_AUDIO) },
    };
});
const cloneRenderProfile = (profile: RenderProfile): RenderProfile => ({
    ...profile,
    fps: { ...profile.fps },
});
const cloneTransientSelection = (selection: TransientMediaSelection): TransientMediaSelection => (
    selection.kind === 'subtitles'
        ? { ...selection, subtitleIds: [...selection.subtitleIds] }
        : { ...selection }
);
const DEFAULT_VIDEO_CLIP_AUDIO: VideoClipAudioSettings = {
    linkState: 'linked',
    muted: false,
    gainDb: 0,
    fadeInFrames: 0,
    fadeOutFrames: 0,
};

/**
 * Clamps an embedded-video envelope to a canonical output-frame duration.
 *
 * Both linked and detached video clips retain these settings in the v3 document. Keeping the
 * clamp here, at the store boundary, prevents a shorter media edit from producing a document
 * that the v3 validator cannot persist. Proportional scaling preserves the user's fade balance;
 * assigning the rounding remainder to fade-out makes the result deterministic.
 */
const clampVideoClipAudioFades = (
    audio: VideoClipAudioSettings,
    durationFrames: number,
): VideoClipAudioSettings => {
    const safeDurationFrames = Math.max(1, Math.floor(durationFrames));
    // Do not clamp each side to the duration before calculating the ratio: doing so would turn
    // any pair of individually oversized fades into an unintended 50/50 envelope.
    let fadeInFrames = Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(0, Math.round(audio.fadeInFrames)),
    );
    let fadeOutFrames = Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(0, Math.round(audio.fadeOutFrames)),
    );
    const combinedFrames = fadeInFrames + fadeOutFrames;
    if (combinedFrames > safeDurationFrames) {
        const ratio = safeDurationFrames / combinedFrames;
        fadeInFrames = Math.floor(fadeInFrames * ratio);
        fadeOutFrames = safeDurationFrames - fadeInFrames;
    }
    return { ...audio, fadeInFrames, fadeOutFrames };
};

const getCanonicalVideoClipDurationFrames = (
    clip: Pick<VideoClip, 'sourceStart' | 'sourceEnd'>,
    renderProfile: RenderProfile,
): number => Math.max(1, secondsToFrames(
    clip.sourceEnd - clip.sourceStart,
    renderProfile.fps,
    'nearest',
));
const cloneTranscriptionByTrackId = (
    provenance: Record<string, TrackTranscriptionProvenanceV3>,
): Record<string, TrackTranscriptionProvenanceV3> => JSON.parse(JSON.stringify(provenance)) as Record<string, TrackTranscriptionProvenanceV3>;

const buildEditorDocumentFromState = (state: TimelineStore): EditorDocumentV3 => ({
    version: 3,
    revision: state.revision,
    audioGraphRevision: state.audioGraphRevision,
    renderProfile: cloneRenderProfile(state.renderProfile),
    subtitleTracks: cloneTracks(state.tracks).map((track): SubtitleTrackV3 => ({
        ...track,
        timingDomain: getTrackTimingDomain(track),
    })),
    videoSources: state.videoSources.map((source) => ({ ...source })),
    videoClips: cloneVideoClips(state.videoClips),
    audioSources: state.audioSources.map((source) => ({ ...source })),
    audioTracks: cloneAudioTracks(state.audioTracks),
    activeSubtitleTrackId: state.activeTrackId,
    transientSelection: cloneTransientSelection(state.transientSelection),
    transcriptionByTrackId: cloneTranscriptionByTrackId(state.transcriptionByTrackId),
});

const buildEditorManifestFromState = (state: TimelineStore): EditorManifestV3 => (
    createEditorManifestV3(buildEditorDocumentFromState(state))
);

const enqueueEditorDocument = (sourceAssets: readonly EditorPersistentAsset[] = []) => {
    if (!timelinePersistenceBinding) return;
    timelinePersistenceBinding.enqueue(
        buildEditorManifestFromState(useTimelineStore.getState()),
        sourceAssets,
    );
};

const persistEditorMutation = (sourceAssets: readonly EditorPersistentAsset[] = []) => {
    // Mutations enqueue one canonical v3 document after Zustand has committed the complete state.
    // The coordinator coalesces rapid drag updates while preserving revision ordering.
    const timeline = useTimelineStore.getState();
    const duration = getTimelineDurations(timeline.videoClips, timeline.tracks, {
        audioTracks: timeline.audioTracks,
        videoSources: timeline.videoSources,
        audioSources: timeline.audioSources,
        renderProfile: timeline.renderProfile,
    }).contentDuration;
    useProjectStore.setState((projectState) => projectState.activeProject
        ? { activeProject: { ...projectState.activeProject, duration } }
        : projectState);
    useProjectStore.getState().checkDirty();
    enqueueEditorDocument(sourceAssets);
};

const haveEqualClipPlacements = (
    currentClips: readonly VideoClip[],
    resultingClips: readonly VideoClip[],
): boolean => currentClips.length === resultingClips.length && currentClips.every((clip, index) => {
    const resultingClip = resultingClips[index];
    return resultingClip !== undefined
        && clip.id === resultingClip.id
        && clip.sourceId === resultingClip.sourceId
        && clip.sourceStart === resultingClip.sourceStart
        && clip.sourceEnd === resultingClip.sourceEnd;
});

const getAudioTimelineSources = (state: Pick<TimelineStore, 'videoSources' | 'audioSources'>) => ({
    videoSources: state.videoSources,
    audioSources: state.audioSources,
});

const getLegacyTranscriptionForTrack = (
    provenance: Record<string, TrackTranscriptionProvenanceV3>,
    trackId: string | null,
) => trackId ? provenance[trackId] ?? null : null;

const createHistorySnapshot = (
    state: TimelineStore,
    audioGraphMutationImpact: AudioGraphMutationImpact = 'preserve-transcription',
): HistorySnapshot => ({
    // History must be detached from live state. Timeline updates are immutable
    // today, but cloning keeps undo safe if a future drag/edit path mutates an
    // object before replacing its parent array.
    tracks: cloneTracks(state.tracks),
    videoClips: cloneVideoClips(state.videoClips),
    renderProfile: cloneRenderProfile(state.renderProfile),
    audioTracks: cloneAudioTracks(state.audioTracks),
    transientSelection: cloneTransientSelection(state.transientSelection),
    activeTrackId: state.activeTrackId,
    selectedSubtitleIds: [...state.selectedSubtitleIds],
    selectedClipId: state.selectedClipId,
    transcriptionByTrackId: cloneTranscriptionByTrackId(state.transcriptionByTrackId),
    rawTranscription: cloneSubtitles(state.rawTranscription),
    transcriptionGroups: cloneTranscriptionGroups(state.transcriptionGroups),
    transcriptionContainerIds: cloneContainerIds(state.transcriptionContainerIds),
    audioGraphMutationImpact,
});

const restoreSnapshotState = (snapshot: HistorySnapshot) => ({
    tracks: cloneTracks(snapshot.tracks),
    videoClips: cloneVideoClips(snapshot.videoClips),
    renderProfile: cloneRenderProfile(snapshot.renderProfile),
    audioTracks: cloneAudioTracks(snapshot.audioTracks),
    transientSelection: cloneTransientSelection(snapshot.transientSelection),
    activeTrackId: snapshot.activeTrackId,
    selectedSubtitleIds: [...snapshot.selectedSubtitleIds],
    selectedClipId: snapshot.selectedClipId,
    transcriptionByTrackId: cloneTranscriptionByTrackId(snapshot.transcriptionByTrackId),
    rawTranscription: cloneSubtitles(snapshot.rawTranscription),
    transcriptionGroups: cloneTranscriptionGroups(snapshot.transcriptionGroups),
    transcriptionContainerIds: cloneContainerIds(snapshot.transcriptionContainerIds),
});

/**
 * Applies the graph-revision and provenance policy to an already-computed immutable patch.
 * Source catalogs may be present in the patch, but they stay outside history snapshots because
 * a File chosen by the user must remain available when an import is undone and later redone.
 */
const finalizeDurablePatch = (
    state: TimelineStore,
    patch: Partial<TimelineStore>,
    impact: AudioGraphMutationImpact = 'preserve-transcription',
): Partial<TimelineStore> => {
    const candidate = {
        ...state,
        ...patch,
        audioGraphRevision: state.audioGraphRevision,
        transcriptionByTrackId: patch.transcriptionByTrackId ?? state.transcriptionByTrackId,
    } as TimelineStore;
    const finalized = finalizeAudioGraphMutation(
        buildEditorDocumentFromState(state),
        buildEditorDocumentFromState(candidate),
        impact,
    );
    return {
        ...patch,
        revision: state.revision + 1,
        audioGraphRevision: finalized.audioGraphRevision,
        transcriptionByTrackId: finalized.transcriptionByTrackId,
    };
};

const getTrackTimingDomain = (track: SubtitleTrack): 'video-ripple' | 'absolute' => (
    'timingDomain' in track && track.timingDomain === 'absolute' ? 'absolute' : 'video-ripple'
);

/**
 * Legacy v2 subtitle tracks implicitly live in the video-ripple domain. Absolute v3 tracks are
 * excluded from the video transform and merged back in their original lane order afterwards.
 */
const applyVideoEditToSubtitleDomains = (
    tracks: SubtitleTrack[],
    selectedSubtitleIds: string[],
    edit: Parameters<typeof applyMediaEditToTimeline>[2],
): { tracks: SubtitleTrack[]; selectedSubtitleIds: string[] } => {
    const rippleTracks = tracks.filter((track) => getTrackTimingDomain(track) === 'video-ripple');
    const absoluteTracks = tracks.filter((track) => getTrackTimingDomain(track) === 'absolute');
    const rippleSubtitleIds = new Set(rippleTracks.flatMap((track) => track.subtitles.map((subtitle) => subtitle.id)));
    const transformed = applyMediaEditToTimeline(
        rippleTracks,
        selectedSubtitleIds.filter((id) => rippleSubtitleIds.has(id)),
        edit,
        () => crypto.randomUUID(),
    );
    const transformedById = new Map(transformed.tracks.map((track) => [track.id, track]));
    const absoluteById = new Map(absoluteTracks.map((track) => [track.id, track]));
    const nextTracks = tracks.map((track) => transformedById.get(track.id) ?? absoluteById.get(track.id) ?? track);
    const absoluteSelection = selectedSubtitleIds.filter((id) => !rippleSubtitleIds.has(id));
    return {
        tracks: nextTracks,
        selectedSubtitleIds: cleanSubtitleSelection(
            [...absoluteSelection, ...transformed.selectedSubtitleIds],
            nextTracks,
        ),
    };
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

const transientSubtitleSelection = (
    tracks: readonly SubtitleTrack[],
    selectedSubtitleIds: readonly string[],
    preferredTrackId: string | null,
): TransientMediaSelection => {
    const selectedIds = new Set(selectedSubtitleIds);
    const track = tracks.find((item) => item.id === preferredTrackId && item.subtitles.some((subtitle) => selectedIds.has(subtitle.id)))
        ?? tracks.find((item) => item.subtitles.some((subtitle) => selectedIds.has(subtitle.id)));
    if (!track) return { kind: 'none' };
    const subtitleIds = track.subtitles
        .filter((subtitle) => selectedIds.has(subtitle.id))
        .map((subtitle) => subtitle.id);
    return subtitleIds.length > 0 ? { kind: 'subtitles', trackId: track.id, subtitleIds } : { kind: 'none' };
};

export const useTimelineStore = create<TimelineStore>((set, get) => ({
    zoomLevel: 1,
    scrollLeft: 0,
    pixelsPerSecond: 100, // Base pixels per second at zoom 1
    tracks: [],
    activeTrackId: null,
    selectedSubtitleIds: [],
    selectedClipId: null,
    revision: 1,
    audioGraphRevision: 0,
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

    pushHistory: (impact = 'preserve-transcription') => {
        const state = get();
        const { history } = state;
        set({
            history: [...history, createHistorySnapshot(state, impact)],
            redoStack: []
        });
    },

    undo: async () => {
        const state = get();
        const { history, redoStack } = state;
        if (history.length === 0) return;

        const previousSnapshot = history[history.length - 1];
        // Save state for redo
        const newRedoStack = [
            ...redoStack,
            createHistorySnapshot(state, previousSnapshot.audioGraphMutationImpact),
        ];
        const newHistory = history.slice(0, -1);

        const restored = restoreSnapshotState(previousSnapshot);
        set({
            ...finalizeDurablePatch(state, restored, previousSnapshot.audioGraphMutationImpact),
            history: newHistory,
            redoStack: newRedoStack
        });
        persistEditorMutation();
    },

    redo: async () => {
        const state = get();
        const { history, redoStack } = state;
        if (redoStack.length === 0) return;

        const nextSnapshot = redoStack[redoStack.length - 1];
        // Save state for undo
        const newHistory = [
            ...history,
            createHistorySnapshot(state, nextSnapshot.audioGraphMutationImpact),
        ];
        const newRedoStack = redoStack.slice(0, -1);

        const restored = restoreSnapshotState(nextSnapshot);
        set({
            ...finalizeDurablePatch(state, restored, nextSnapshot.audioGraphMutationImpact),
            history: newHistory,
            redoStack: newRedoStack
        });
        persistEditorMutation();
    },

    addTrack: (name, style, options) => {
        if (!options?.skipHistory) {
            get().pushHistory();
        }

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

        set((state) => {
            const newTracks = [...state.tracks, {
                id,
                name: name || `Capa ${state.tracks.length + 1}`,
                style: defaultStyle,
                subtitles: [],
                isVisible: true,
                isLocked: false
            }];
            return {
                tracks: newTracks,
                activeTrackId: id,
                revision: state.revision + 1,
            };
        });
        persistEditorMutation();
        return id;
    },

    removeTrack: (id) => {
        get().pushHistory();
        let savedTracks: SubtitleTrack[] = [];
        set((state) => {
            const nextTracks = state.tracks.filter(t => t.id !== id);
            savedTracks = nextTracks;
            let nextActiveId = state.activeTrackId;

            // Si borramos la capa activa, intentamos activar otra
            if (state.activeTrackId === id) {
                nextActiveId = nextTracks.length > 0 ? nextTracks[0].id : null;
            }

            const transcriptionByTrackId = { ...state.transcriptionByTrackId };
            delete transcriptionByTrackId[id];
            const legacy = getLegacyTranscriptionForTrack(transcriptionByTrackId, nextActiveId);
            const selectedSubtitleIds = cleanSubtitleSelection(state.selectedSubtitleIds, nextTracks);

            return {
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
                revision: state.revision + 1,
            };
        });
        void savedTracks;
        persistEditorMutation();
    },

    updateTrackStyle: (id, styleUpdates) => {
        get().pushHistory();
        set((state) => {
            const newTracks = state.tracks.map(t =>
                t.id === id ? { ...t, style: { ...t.style, ...styleUpdates } } : t
            );
            return { tracks: newTracks, revision: state.revision + 1 };
        });
        persistEditorMutation();
    },

    updateTrackName: (id, name) => {
        get().pushHistory();
        set((state) => {
            const newTracks = state.tracks.map(t =>
                t.id === id ? { ...t, name } : t
            );
            return { tracks: newTracks, revision: state.revision + 1 };
        });
        persistEditorMutation();
    },

    addSubtitleToTrack: (trackId, subtitle) => {
        get().pushHistory();
        const newId = crypto.randomUUID();
        set((state) => {
            const newTracks = state.tracks.map(t =>
                t.id === trackId
                    ? { ...t, subtitles: [...t.subtitles, { ...subtitle, id: newId }] }
                    : t
            );
            return { tracks: newTracks, revision: state.revision + 1 };
        });
        persistEditorMutation();
        return newId;
    },

    updateSubtitleInTrack: (trackId, subtitleId, updates, options) => {
        const track = get().tracks.find(t => t.id === trackId);
        if (!track?.subtitles.some(s => s.id === subtitleId)) return;

        if (!options?.skipHistory) get().pushHistory();
        set((state) => {
            const newTracks = state.tracks.map(t => {
                if (t.id !== trackId) return t;
                return {
                    ...t,
                    subtitles: t.subtitles.map(s => s.id === subtitleId ? { ...s, ...updates } : s)
                };
            });
            return { tracks: newTracks, revision: state.revision + 1 };
        });
        persistEditorMutation();
    },

    moveSubtitleToTrack: (subtitleId, sourceTrackId, targetTrackId) => {
        if (sourceTrackId === targetTrackId) return;

        const state = get();
        const sourceTrack = state.tracks.find(t => t.id === sourceTrackId);
        const targetTrack = state.tracks.find(t => t.id === targetTrackId);
        if (!sourceTrack || !targetTrack || !sourceTrack.subtitles.some(s => s.id === subtitleId)) return;

        get().pushHistory();
        set((state) => {
            let movedSubtitle: Subtitle | null = null;

            // Remove from source and capture subtitle
            const tracksWithSourcedRemoved = state.tracks.map(t => {
                if (t.id === sourceTrackId) {
                    const subtitle = t.subtitles.find(s => s.id === subtitleId);
                    if (subtitle) movedSubtitle = { ...subtitle };
                    return {
                        ...t,
                        subtitles: t.subtitles.filter(s => s.id !== subtitleId)
                    };
                }
                return t;
            });

            if (!movedSubtitle) return state;

            // Add to target
            const finalTracks = tracksWithSourcedRemoved.map(t => {
                if (t.id === targetTrackId) {
                    return {
                        ...t,
                        subtitles: [...t.subtitles, movedSubtitle!].sort((a, b) => a.startTime - b.startTime)
                    };
                }
                return t;
            });

            return {
                tracks: finalTracks,
                activeTrackId: targetTrackId,
                transientSelection: state.transientSelection.kind === 'subtitles'
                    ? transientSubtitleSelection(finalTracks, state.selectedSubtitleIds, targetTrackId)
                    : state.transientSelection,
                revision: state.revision + 1,
            };
        });
        persistEditorMutation();
    },

    moveSubtitlesToTrack: (subtitleIds, deltaTrackIndex, options) => {
        if (deltaTrackIndex === 0 || subtitleIds.length === 0) return;

        const currentTracks = get().tracks;
        const trackIds = currentTracks.map(t => t.id);
        const subtitleLocations = subtitleIds.flatMap(subtitleId => {
            const currentTrackIndex = currentTracks.findIndex(track =>
                track.subtitles.some(subtitle => subtitle.id === subtitleId)
            );
            return currentTrackIndex === -1 ? [] : [currentTrackIndex];
        });

        if (
            subtitleLocations.length === 0 ||
            subtitleLocations.some(currentTrackIndex => {
                const targetIndex = currentTrackIndex + deltaTrackIndex;
                return targetIndex < 0 || targetIndex >= trackIds.length;
            })
        ) return;

        if (!options?.skipHistory) get().pushHistory();
        set((state) => {
            const currentTracks = state.tracks;
            const subtitleLocations = new Map<string, { trackId: string, subtitle: Subtitle }>();

            // 1. Locate all subtitles to move
            currentTracks.forEach(track => {
                track.subtitles.forEach(s => {
                    if (subtitleIds.includes(s.id)) {
                        subtitleLocations.set(s.id, { trackId: track.id, subtitle: { ...s } });
                    }
                });
            });

            // 2. Identify target tracks and check bounds
            const trackIds = currentTracks.map(t => t.id);
            const updates = new Map<string, string>(); // subtitleId -> newTrackId

            for (const [sId, loc] of Array.from(subtitleLocations.entries())) {
                const currentIdx = trackIds.indexOf(loc.trackId);
                const targetIdx = currentIdx + deltaTrackIndex;

                if (targetIdx < 0 || targetIdx >= trackIds.length) {
                    // If ANY subtitle would go out of bounds, we cancel the track shift for the WHOLE group
                    // or just cap it? Caps are safer for group movement.
                    return state;
                }
                updates.set(sId, trackIds[targetIdx]);
            }

            // 3. Perform the move
            const newTracks = currentTracks.map(track => {
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

            return {
                tracks: newTracks,
                transientSelection: state.transientSelection.kind === 'subtitles'
                    ? transientSubtitleSelection(newTracks, state.selectedSubtitleIds, state.activeTrackId)
                    : state.transientSelection,
                revision: state.revision + 1,
            };
        });
        persistEditorMutation();
    },

    removeSubtitleFromTrack: (trackId, subtitleId) => {
        const track = get().tracks.find(t => t.id === trackId);
        if (!track?.subtitles.some(s => s.id === subtitleId)) return;

        get().pushHistory();
        set((state) => {
            const newTracks = state.tracks.map(t =>
                t.id === trackId
                    ? { ...t, subtitles: t.subtitles.filter(s => s.id !== subtitleId) }
                    : t
            );
            const selectedSubtitleIds = state.selectedSubtitleIds.filter(id => id !== subtitleId);
            return {
                tracks: newTracks,
                selectedSubtitleIds,
                transientSelection: state.transientSelection.kind === 'subtitles'
                    ? transientSubtitleSelection(newTracks, selectedSubtitleIds, state.activeTrackId)
                    : state.transientSelection,
                revision: state.revision + 1,
            };
        });
        persistEditorMutation();
    },

    hydrateEditorDocument: (document) => {
        const validation = validateEditorDocumentV3(document);
        if (!validation.valid) {
            throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
        }
        const provenance = cloneTranscriptionByTrackId(document.transcriptionByTrackId);
        const legacy = getLegacyTranscriptionForTrack(provenance, document.activeSubtitleTrackId);
        const projectFps = document.renderProfile.fps.numerator / document.renderProfile.fps.denominator;
        const tracks = cloneTracks(document.subtitleTracks);
        set({
            revision: document.revision,
            audioGraphRevision: document.audioGraphRevision,
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
            history: [],
            redoStack: [],
            lastSelectedId: null,
            isVideoSelected: document.transientSelection.kind === 'video-clip',
        });
        useVideoStore.getState().syncSourceCatalog(document.videoSources);
    },

    resetEditorDocument: () => {
        set({
            revision: 1,
            audioGraphRevision: 0,
            projectFps: 30,
            renderProfile: createDefaultRenderProfile(),
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
            lastSelectedId: null,
            isVideoSelected: false,
        });
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
        const nextProjectFps = nextRenderProfile.fps.numerator / nextRenderProfile.fps.denominator;
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
            projectFps: nextProjectFps,
            renderProfile: nextRenderProfile,
        };
        if (!hasHistoricalMutation) return;
        const finalizedPatch = finalizeDurablePatch(state, patch, 'invalidate-transcription');
        const validation = validateEditorDocumentV3(buildEditorDocumentFromState({ ...state, ...finalizedPatch } as TimelineStore));
        if (!validation.valid) {
            throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
        }

        get().pushHistory('invalidate-transcription');
        set(finalizedPatch);
        if (videoSources.length > 0) useVideoStore.getState().syncSourceCatalog(nextVideoSources);
        persistEditorMutation([
            ...videoSources.map((asset): EditorPersistentAsset => ({ kind: 'video-source', asset })),
            ...audioSources.map((asset): EditorPersistentAsset => ({ kind: 'audio-source', asset })),
        ]);
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
        get().pushHistory('invalidate-transcription');
        set(finalizeDurablePatch(state, patch, 'invalidate-transcription'));
        persistEditorMutation();
    },

    splitVideoClip: (clipId, projectTime, rightClipId) => {
        const state = get();
        const originalClip = state.videoClips.find((clip) => clip.id === clipId);
        if (!originalClip) return;
        let result: ReturnType<typeof splitClipInTimeline>;
        try {
            // Boundary, duplicate-ID, and otherwise invalid split requests are interaction no-ops.
            // Computing the complete result before history ensures a rejected gesture cannot
            // consume undo state, revisions, provenance, or a persistence write.
            result = splitClipInTimeline(state.videoClips, clipId, projectTime, rightClipId, state.projectFps);
        } catch {
            return;
        }
        const splitVideoClips = cloneVideoClips(result.videoClips).map((clip): TimelineVideoClip => {
            if (!originalClip.audio || !clip.audio) return clip;
            if (clip.id === clipId) {
                const durationFrames = getCanonicalVideoClipDurationFrames(clip, state.renderProfile);
                // A split creates an artificial right edge. It must not duplicate the source
                // fade-out at that seam; only the original outer fade-in belongs to the left.
                return {
                    ...clip,
                    audio: clampVideoClipAudioFades({
                        ...originalClip.audio,
                        fadeOutFrames: 0,
                    }, durationFrames),
                };
            }
            if (clip.id === rightClipId) {
                const durationFrames = getCanonicalVideoClipDurationFrames(clip, state.renderProfile);
                // The matching artificial left edge must start at full level. The original
                // outer fade-out stays on the right-hand clip and is clamped to its duration.
                return {
                    ...clip,
                    audio: clampVideoClipAudioFades({
                        ...originalClip.audio,
                        fadeInFrames: 0,
                    }, durationFrames),
                };
            }
            return clip;
        });
        get().pushHistory('invalidate-transcription');
        set(finalizeDurablePatch(state, {
            videoClips: splitVideoClips,
        }, 'invalidate-transcription'));
        persistEditorMutation();
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
        get().pushHistory('invalidate-transcription');
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
        set(finalizeDurablePatch(state, {
            videoClips: trimmedVideoClips,
            tracks: transformed.tracks,
            selectedSubtitleIds: transformed.selectedSubtitleIds,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(transformed.tracks, transformed.selectedSubtitleIds, state.activeTrackId)
                : state.transientSelection,
        }, 'invalidate-transcription'));
        persistEditorMutation();
    },

    deleteVideoClip: (clipId) => {
        const state = get();
        if (!state.videoClips.some((clip) => clip.id === clipId)) return;
        get().pushHistory('invalidate-transcription');
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
        set(finalizeDurablePatch(state, {
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
        }, 'invalidate-transcription'));
        persistEditorMutation();
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
        get().pushHistory('invalidate-transcription');
        const transformed = applyVideoEditToSubtitleDomains(
            state.tracks,
            state.selectedSubtitleIds,
            edit,
        );
        set(finalizeDurablePatch(state, {
            videoClips: cloneVideoClips(edit.videoClips),
            tracks: transformed.tracks,
            selectedSubtitleIds: transformed.selectedSubtitleIds,
            transientSelection: state.transientSelection.kind === 'subtitles'
                ? transientSubtitleSelection(transformed.tracks, transformed.selectedSubtitleIds, state.activeTrackId)
                : state.transientSelection,
        }, 'invalidate-transcription'));
        persistEditorMutation();
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
        const audioTracks = moveAudioClipInTracks(
            state.audioTracks,
            getAudioTimelineSources(state),
            state.renderProfile,
            clipId,
            targetTrackId,
            timelineStartFrame,
        );
        if (!audioTracks) return;
        get().pushHistory('invalidate-transcription');
        set(finalizeDurablePatch(state, {
            audioTracks,
            transientSelection: { kind: 'audio-clip', trackId: targetTrackId, clipId },
        }, 'invalidate-transcription'));
        persistEditorMutation();
    },

    trimAudioClip: (clipId, side, timelineFrame) => {
        const state = get();
        const audioTracks = trimAudioClipInTracks(
            state.audioTracks,
            getAudioTimelineSources(state),
            state.renderProfile,
            clipId,
            side,
            timelineFrame,
        );
        if (!audioTracks) return;
        get().pushHistory('invalidate-transcription');
        set(finalizeDurablePatch(state, { audioTracks }, 'invalidate-transcription'));
        persistEditorMutation();
    },

    splitAudioClip: (clipId, timelineFrame, rightClipId) => {
        if (!isSafeVideoId(rightClipId)) return;
        const state = get();
        const audioTracks = splitAudioClipInTracks(
            state.audioTracks,
            getAudioTimelineSources(state),
            state.renderProfile,
            clipId,
            timelineFrame,
            rightClipId,
        );
        if (!audioTracks) return;
        const located = findAudioClip(audioTracks, getAudioTimelineSources(state), rightClipId);
        if (!located) return;
        get().pushHistory('invalidate-transcription');
        set(finalizeDurablePatch(state, {
            audioTracks,
            transientSelection: { kind: 'audio-clip', trackId: located.track.id, clipId: rightClipId },
        }, 'invalidate-transcription'));
        persistEditorMutation();
    },

    deleteAudioClip: (clipId) => {
        const state = get();
        const located = findAudioClip(state.audioTracks, getAudioTimelineSources(state), clipId);
        if (!located || located.track.locked) return;
        get().pushHistory('invalidate-transcription');
        set(finalizeDurablePatch(state, {
            audioTracks: state.audioTracks.map((track) => track.id === located.track.id
                ? { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }
                : track),
            transientSelection: state.transientSelection.kind === 'audio-clip'
                && state.transientSelection.clipId === clipId
                ? { kind: 'none' }
                : state.transientSelection,
        }, 'invalidate-transcription'));
        persistEditorMutation();
    },

    addAudioTrack: (name, requestedId) => {
        const state = get();
        const id = requestedId ?? crypto.randomUUID();
        if (!isSafeVideoId(id) || state.audioTracks.some((track) => track.id === id)) return '';
        get().pushHistory();
        set(finalizeDurablePatch(state, {
            audioTracks: [...state.audioTracks, {
                id,
                name: name?.trim() || `Audio ${state.audioTracks.length + 1}`,
                muted: false,
                solo: false,
                locked: false,
                gainDb: 0,
                clips: [],
            }],
        }));
        persistEditorMutation();
        return id;
    },

    removeAudioTrack: (trackId) => {
        const state = get();
        const track = state.audioTracks.find((item) => item.id === trackId);
        if (!track || track.locked) return;
        const impact: AudioGraphMutationImpact = track.clips.length > 0
            ? 'invalidate-transcription'
            : 'preserve-transcription';
        get().pushHistory(impact);
        set(finalizeDurablePatch(state, {
            audioTracks: state.audioTracks.filter((item) => item.id !== trackId),
            transientSelection: state.transientSelection.kind === 'audio-clip'
                && state.transientSelection.trackId === trackId
                ? { kind: 'none' }
                : state.transientSelection,
        }, impact));
        persistEditorMutation();
    },

    renameAudioTrack: (trackId, name) => {
        const state = get();
        const track = state.audioTracks.find((item) => item.id === trackId);
        const nextName = name.trim();
        if (!track || track.locked || !nextName || track.name === nextName) return;
        get().pushHistory();
        set(finalizeDurablePatch(state, {
            audioTracks: state.audioTracks.map((item) => item.id === trackId ? { ...item, name: nextName } : item),
        }));
        persistEditorMutation();
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
        if (JSON.stringify(candidateClip) === JSON.stringify(located.clip)) return;
        const audioTracks = state.audioTracks.map((track) => track.id === located.track.id
            ? { ...track, clips: track.clips.map((clip) => clip.id === clipId ? candidateClip : clip) }
            : track);
        const impact: AudioGraphMutationImpact = candidateClip.muted !== located.clip.muted
            ? 'invalidate-transcription'
            : 'preserve-transcription';
        get().pushHistory(impact);
        set(finalizeDurablePatch(state, { audioTracks }, impact));
        persistEditorMutation();
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
        get().pushHistory(impact);
        set(finalizeDurablePatch(state, {
            audioTracks: state.audioTracks.map((item) => item.id === trackId
                ? { ...item, muted: nextMuted, solo: nextSolo, gainDb: nextGainDb }
                : item),
        }, impact));
        persistEditorMutation();
    },

    setAudioTrackLocked: (trackId, locked) => {
        const state = get();
        const track = state.audioTracks.find((item) => item.id === trackId);
        if (!track || track.locked === locked) return;
        get().pushHistory();
        set(finalizeDurablePatch(state, {
            audioTracks: state.audioTracks.map((item) => item.id === trackId ? { ...item, locked } : item),
        }));
        persistEditorMutation();
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
        get().pushHistory(impact);
        set(finalizeDurablePatch(state, {
            videoClips: state.videoClips.map((item) => item.id === clipId ? { ...item, audio } : item),
        }, impact));
        persistEditorMutation();
    },

    setSubtitleTrackTimingDomain: (trackId, timingDomain) => {
        const state = get();
        const track = state.tracks.find((item) => item.id === trackId);
        if (!track || getTrackTimingDomain(track) === timingDomain) return;
        get().pushHistory();
        set({
            tracks: state.tracks.map((item) => item.id === trackId ? { ...item, timingDomain } : item),
            revision: state.revision + 1,
        });
        persistEditorMutation();
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
        get().pushHistory();
        set(finalizeDurablePatch(state, {
            transcriptionByTrackId,
            rawTranscription: cloneSubtitles(legacy?.raw ?? null),
            transcriptionGroups: cloneTranscriptionGroups(legacy?.groups ?? null),
            transcriptionContainerIds: cloneContainerIds(legacy?.containerIds ?? null),
        }));
        persistEditorMutation();
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

        get().pushHistory();
        set((current) => {
            const tracks = current.tracks.map((track) => (
                track.id === trackId ? { ...track, subtitles: cloneSubtitles(subtitles) ?? [] } : track
            ));
            const nextRevision = current.revision + 1;
            const transcriptionByTrackId = {
                ...current.transcriptionByTrackId,
                [trackId]: cloneTranscriptionByTrackId({
                    value: {
                        ...provenance,
                        sourceDocumentRevision: nextRevision,
                        sourceAudioGraphRevision: current.audioGraphRevision,
                        sourceAudioGraphSignature: getEditorAudioGraphSignature(buildEditorDocumentFromState(current)),
                        stale: false,
                    },
                }).value,
            };
            const legacy = getLegacyTranscriptionForTrack(transcriptionByTrackId, current.activeTrackId);
            const selectedSubtitleIds = cleanSubtitleSelection(current.selectedSubtitleIds, tracks);
            return {
                tracks,
                transcriptionByTrackId,
                rawTranscription: cloneSubtitles(legacy?.raw ?? null),
                transcriptionGroups: cloneTranscriptionGroups(legacy?.groups ?? null),
                transcriptionContainerIds: cloneContainerIds(legacy?.containerIds ?? null),
                selectedSubtitleIds,
                transientSelection: current.transientSelection.kind === 'subtitles'
                    ? transientSubtitleSelection(tracks, selectedSubtitleIds, current.activeTrackId)
                    : current.transientSelection,
                revision: nextRevision,
            };
        });
        persistEditorMutation();
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

    setTracks: (tracks, options) => {
        if (!options?.resetHistory && !options?.skipHistory) {
            get().pushHistory();
        }

        set((state) => {
            const isValidActive = tracks.some(t => t.id === state.activeTrackId);
            const activeTrackId = isValidActive ? state.activeTrackId : (tracks.length > 0 ? tracks[0].id : null);
            const trackIds = new Set(tracks.map((track) => track.id));
            const transcriptionByTrackId = Object.fromEntries(
                Object.entries(state.transcriptionByTrackId).filter(([trackId]) => trackIds.has(trackId)),
            );
            const legacy = getLegacyTranscriptionForTrack(transcriptionByTrackId, activeTrackId);
            const selectedSubtitleIds = cleanSubtitleSelection(state.selectedSubtitleIds, tracks);

            return {
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
                revision: options?.resetHistory ? state.revision : state.revision + 1,
                history: options?.resetHistory ? [] : state.history,
                redoStack: options?.resetHistory ? [] : state.redoStack,
                isVideoSelected: false
            };
        });

        if (!options?.skipSave) {
            persistEditorMutation();
        }
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

    setIsDragging: (dragging) => set({ isDragging: dragging }),

    setActiveTrackId: (id) => {
        const state = get();
        const activeTrackId = state.tracks.some(t => t.id === id)
            ? id
            : (state.tracks.length > 0 ? state.tracks[0].id : null);
        if (activeTrackId === state.activeTrackId) return;
        const legacy = getLegacyTranscriptionForTrack(state.transcriptionByTrackId, activeTrackId);
        set({
            activeTrackId,
            rawTranscription: cloneSubtitles(legacy?.raw ?? null),
            transcriptionGroups: cloneTranscriptionGroups(legacy?.groups ?? null),
            transcriptionContainerIds: cloneContainerIds(legacy?.containerIds ?? null),
            revision: state.revision + 1,
        });
        persistEditorMutation();
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
        const { clipboard, tracks, activeTrackId, pushHistory, toggleSubtitleSelection, clearSelection } = get();
        if (!clipboard || clipboard.length === 0) return;

        pushHistory();

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

        set((state) => ({ tracks: newTracks, revision: state.revision + 1 }));
        persistEditorMutation();

        // Select the newly pasted subtitles
        if (newSelectionIds.length > 0) {
            clearSelection();
            newSelectionIds.forEach((id, idx) => {
                toggleSubtitleSelection(id, idx > 0);
            });
        }
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
        const { tracks, activeTrackId, selectSubtitleAtTime, addSubtitleToTrack, toggleSubtitleSelection } = get();
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
        const newId = addSubtitleToTrack(targetTrackId, {
            startTime: time,
            endTime: endTime,
            text: ''
        });

        // Select it (so it highlights on timeline) and request edit (so SubtitleList focuses it)
        toggleSubtitleSelection(newId, false, false);
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

        get().pushHistory();
        set(finalizeDurablePatch(state, {
            transcriptionGroups: groups,
            transcriptionContainerIds: containerIds,
            rawTranscription: nextRaw,
            transcriptionByTrackId,
        }));

        // Save after Zustand has applied the new transcription fields; the
        // storage helper reads them from the current store state.
        persistEditorMutation();
    },

    generateDefaultGrouperState: (words, wordsPerLine = 3) =>
        generateDefaultGrouperState(words, wordsPerLine),

    generateTimelineSubtitles: (words, wordsPerLine = 3) =>
        generateTimelineSubtitles(words, wordsPerLine),

    setCuts: (cuts) => set({ cuts }),
    clearCuts: () => set({ cuts: [] }),
    setDetectionProgress: (progress) => set({ detectionProgress: progress }),
    setIsDetecting: (isDetecting) => set({ isDetecting })
}));
