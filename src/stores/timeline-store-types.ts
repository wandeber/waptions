import type { Cut } from '@/lib/video-cut/core/types';
import type { EditorPersistentAsset } from '@/lib/storage/storage-service';
import type {
    AnimationStyle,
    Subtitle,
    SubtitleTrack,
    SubtitleTrackV4,
    UnlinkedVideoEditResponse,
} from '@/types/timeline';
import type {
    AudioClipMixSettings,
    AudioSourceAsset,
    AudioTrack,
    EditorDocumentV3,
    EditorDocumentV4,
    EditorManifestV4,
    EditorManifestV3,
    RenderProfile,
    TrackTranscriptionProvenanceV3,
    TrackTranscriptionState,
    TranscriptionJobGuard,
    TransientMediaSelectionV4,
    VideoClip,
    VideoClipAudioSettings,
    VideoClipV3,
    VideoClipV4,
    VideoSourceAsset,
    VideoTrackV4,
} from '@/types/video';
import type {
    EditorialDependentLinkV1,
    EditorialTranscriptDescriptor,
    GlobalEditingMode,
    NarrativeDocumentV1,
    TransientNarrativeSelectionV1,
} from '@/types/editorial';
import type { AudioGraphMutationImpact } from '@/lib/audio-graph-signature';
import type { DiarizationJobGuard } from '@/lib/diarization-provenance';
import type { SerializablePatch } from '@/lib/serializable-patch';
import type { TimelineVideoTrack } from './timeline-v4-compat';
import type {
    ActivateNarrativeRequest,
    TimelineEditorialLinkCommand,
    TimelineNarrativeCommand,
    TimelineOrdinaryCommand,
    TimelineV4CommandResult,
} from './timeline-v4-command-types';

export interface TimelinePersistenceBinding {
    projectId: string;
    generation: number;
    enqueue: (
        manifest: EditorManifestV3,
        sourceAssets: readonly EditorPersistentAsset[],
        history: TimelineHistoryRuntimeState,
    ) => void;
    enqueueV4?: (
        manifest: EditorManifestV4,
        sourceAssets: readonly EditorPersistentAsset[],
        history: TimelineHistoryRuntimeState,
    ) => void;
}

/**
 * Transitional public clip surface. Store normalization always supplies the V4 placement fields
 * before document/history serialization; optionality keeps pre-WP8 component fixtures source
 * compatible while their callers migrate from cumulative V3 placement.
 */
export type TimelineVideoClip = VideoClipV3
    & Partial<Pick<VideoClipV4, 'trackId' | 'timelineStartFrame'>>;
export type TimelineSubtitleTrack = SubtitleTrack
    & Partial<Pick<SubtitleTrackV4, 'unlinkedVideoEditResponse'>>
    & { timingDomain?: 'video-ripple' | 'absolute' };
export type TimelineHistoryVideoTrack = Pick<VideoTrackV4, 'id' | 'name'>
    & Partial<Pick<VideoTrackV4, 'visible' | 'locked'>>
    & { clipIds?: string[] };

export interface TimelineHistoryProjection {
    tracks: TimelineSubtitleTrack[];
    videoClips: TimelineVideoClip[];
    /** V4 projections omit the compatibility-only `clipIds`; V3 migration may still supply it. */
    videoTracks: TimelineHistoryVideoTrack[];
    renderProfile: RenderProfile;
    /** Missing only in persisted history written before durable project backgrounds existed. */
    renderBackgroundColor?: string;
    audioTracks: AudioTrack[];
    transientSelection: TransientMediaSelectionV4;
    activeTrackId: string | null;
    selectedSubtitleIds: string[];
    lastSelectedId: string | null;
    selectedClipId: string | null;
    isVideoSelected: boolean;
    transcriptionByTrackId: Record<string, TrackTranscriptionProvenanceV3>;
    rawTranscription: Subtitle[] | null;
    transcriptionGroups: { [key: string]: Subtitle[] } | null;
    transcriptionContainerIds: string[] | null;
    globalEditingMode?: GlobalEditingMode;
    editorialTranscriptDescriptors?: EditorialTranscriptDescriptor[];
    narrative?: NarrativeDocumentV1 | null;
    dependentLinks?: EditorialDependentLinkV1[];
}

export interface TimelineHistoryEntry {
    id: string;
    sequence: number;
    label: string;
    mergeKey: string | null;
    timestamp: number;
    patches: SerializablePatch[];
    inversePatches: SerializablePatch[];
    audioGraphMutationImpact: AudioGraphMutationImpact;
    recalculatesContentBoundary: boolean;
    byteSize: number;
    oversized: boolean;
}

export interface TimelineHistoryMetadata {
    label: string;
    mergeKey?: string;
}

export interface TimelineHistoryRuntimeState {
    history: TimelineHistoryEntry[];
    redoStack: TimelineHistoryEntry[];
    projection: TimelineHistoryProjection;
}

export interface SetTracksOptions {
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

/** Network-independent normalized input consumed by the atomic diarization store command. */
export interface DiarizedSpeakerTrackInput {
    sourceSpeakerLabel: string;
    subtitles: Subtitle[];
    transcription: TrackTranscriptionState;
}

export interface DiarizedTranscriptionMetadata {
    provider: string;
    model?: string;
    generatedAt: string;
}

export interface TimelineStore {
    zoomLevel: number;
    scrollLeft: number;
    tracks: TimelineSubtitleTrack[];
    pixelsPerSecond: number;
    activeTrackId: string | null;
    selectedSubtitleIds: string[];
    selectedClipId: string | null;
    revision: number;
    audioGraphRevision: number;
    /** Runtime-only invalidation token for the exact terminal frame of all timeline content. */
    contentBoundaryRevision: number;
    projectFps: number;
    renderProfile: RenderProfile;
    renderBackgroundColor: string;
    videoSources: VideoSourceAsset[];
    videoClips: TimelineVideoClip[];
    videoTracks: TimelineVideoTrack[];
    audioSources: AudioSourceAsset[];
    audioTracks: AudioTrack[];
    transientSelection: TransientMediaSelectionV4;
    globalEditingMode: GlobalEditingMode;
    editorialTranscriptDescriptors: EditorialTranscriptDescriptor[];
    narrative: NarrativeDocumentV1 | null;
    dependentLinks: EditorialDependentLinkV1[];
    transcriptionByTrackId: Record<string, TrackTranscriptionProvenanceV3>;
    lastSelectedId: string | null;
    snapEnabled: boolean;
    activeSnapTime: number | null;
    clipboard: { subtitle: Subtitle; relativeTrackIndex: number }[] | null;
    requestEditSubtitleId: string | null;
    isVideoSelected: boolean;
    isDragging: boolean;

    history: TimelineHistoryEntry[];
    redoStack: TimelineHistoryEntry[];
    historySequence: number;
    historyBytes: number;

    cuts: Cut[];
    detectionProgress: number;
    isDetecting: boolean;

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
    hydrateEditorDocument: (
        document: EditorDocumentV3 | EditorDocumentV4,
        historyState?: Pick<TimelineStore, 'history' | 'redoStack' | 'historySequence' | 'historyBytes'>,
    ) => void;
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
    addVideoTrack: (name?: string, id?: string, insertionIndex?: number) => string;
    removeVideoTrack: (trackId: string) => void;
    /** Canonical result-bearing video move used by pointer drag/drop. */
    moveVideoClip: (
        clipId: string,
        targetTrackId: string,
        targetStartFrame: number,
    ) => TimelineV4CommandResult;
    /** Atomically creates the destination lane and commits the requested horizontal placement. */
    moveVideoClipToNewTrackAtFrame: (
        clipId: string,
        insertionIndex: number,
        targetStartFrame: number,
        id?: string,
        name?: string,
    ) => TimelineV4CommandResult;
    moveVideoClipToTrack: (clipId: string, targetTrackId: string) => void;
    moveVideoClipToNewTrack: (clipId: string, insertionIndex: number, id?: string, name?: string) => string;
    selectClip: (clipId: string | null) => void;
    selectNarrativeRange: (
        blockId: string,
        sourceWordIds: readonly string[],
        boundary?: TransientNarrativeSelectionV1['boundary'],
    ) => boolean;
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
    setSubtitleTrackUnlinkedVideoEditResponse: (
        trackId: string,
        policy: UnlinkedVideoEditResponse,
    ) => void;
    setTrackTranscriptionState: (trackId: string, provenance: TrackTranscriptionState | TrackTranscriptionProvenanceV3 | null) => void;
    createTranscriptionGuard: (trackId: string) => TranscriptionJobGuard | null;
    replaceTrackWithTranscription: (
        trackId: string,
        subtitles: Subtitle[],
        provenance: TrackTranscriptionState,
        expectedRevision: number | TranscriptionJobGuard,
    ) => boolean;
    replaceTrackSetWithDiarizedTranscription: (
        targetTrackId: string,
        speakers: readonly DiarizedSpeakerTrackInput[],
        metadata: DiarizedTranscriptionMetadata,
        guard: DiarizationJobGuard,
    ) => boolean;
    getTrackTranscriptionState: (trackId: string) => TrackTranscriptionProvenanceV3 | null;
    /** Pre-WP8 compatibility projection; new state/persistence code uses the explicit V4 methods. */
    buildEditorDocument: () => EditorDocumentV3;
    buildEditorManifest: () => EditorManifestV3;
    buildEditorDocumentV4: () => EditorDocumentV4;
    buildEditorManifestV4: () => EditorManifestV4;
    activateNarrative: (request: ActivateNarrativeRequest) => Promise<TimelineV4CommandResult>;
    releaseNarrativeTracks: (trackIds: string[]) => Promise<TimelineV4CommandResult>;
    executeNarrativeCommand: (request: TimelineNarrativeCommand) => Promise<TimelineV4CommandResult>;
    executeEditorialLinkCommand: (request: TimelineEditorialLinkCommand) => TimelineV4CommandResult;
    executeOrdinaryV4Command: (request: TimelineOrdinaryCommand) => TimelineV4CommandResult;
    setGlobalEditingMode: (mode: GlobalEditingMode) => TimelineV4CommandResult;
    splitSelectedMediaAtFrame: (timelineFrame: number, rightClipId?: string) => void;
    deleteSelectedMedia: () => void;
    bumpRevision: () => number;
    ensureRevisionAtLeast: (revision: number) => number;
    setActiveTrackId: (id: string | null) => void;
    toggleSubtitleSelection: (id: string, isMulti?: boolean, isRange?: boolean) => void;
    clearSelection: () => void;
    copySelection: () => void;
    pasteSelection: (startTime: number) => void;
    trimSubtitleAtTime: (time: number, side: 'start' | 'end') => void;
    selectSubtitleAtTime: (time: number) => string | null;
    requestEditSubtitleAtTime: (time: number) => void;
    clearEditRequest: () => void;

    setCuts: (cuts: Cut[]) => void;
    clearCuts: () => void;
    setDetectionProgress: (progress: number) => void;
    setIsDetecting: (isDetecting: boolean) => void;

    undo: () => Promise<void>;
    redo: () => Promise<void>;
    jumpToHistoryEntry: (entryId: string | null) => Promise<void>;
    setSnapEnabled: (enabled: boolean) => void;
    setActiveSnapTime: (time: number | null) => void;
    setVideoSelected: (selected: boolean) => void;
    setIsDragging: (dragging: boolean, metadata?: TimelineHistoryMetadata) => void;
    cancelSubtitleDrag: () => void;

    rawTranscription: Subtitle[] | null;
    transcriptionGroups: { [key: string]: Subtitle[] } | null;
    transcriptionContainerIds: string[] | null;
    setTranscriptionState: (
        groups: { [key: string]: Subtitle[] } | null,
        containerIds: string[] | null,
        raw?: Subtitle[] | null,
    ) => void;
    generateDefaultGrouperState: (words: Subtitle[], wordsPerLine?: number) => {
        groups: { [key: string]: Subtitle[] };
        containerIds: string[];
    };
    generateTimelineSubtitles: (words: Subtitle[], wordsPerLine?: number) => Subtitle[];
}
