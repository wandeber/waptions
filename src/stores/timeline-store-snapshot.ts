import { finalizeAudioGraphMutation, type AudioGraphMutationImpact } from '@/lib/audio-graph-signature';
import { createEditorManifestV3 } from '@/lib/editor-document-migration';
import { cloneAudioTracks } from '@/lib/audio-timeline';
import type { Subtitle, SubtitleTrack } from '@/types/timeline';
import type {
    EditorDocumentV3,
    EditorManifestV3,
    RenderProfile,
    TrackTranscriptionProvenanceV3,
    TransientMediaSelection,
    VideoClip,
    VideoClipAudioSettings,
    VideoClipV3,
} from '@/types/video';
import type { TimelineStore, TimelineVideoClip } from './timeline-store-types';
import { getTrackTimingDomain } from './timeline-store-selectors';

export const DEFAULT_VIDEO_CLIP_AUDIO: VideoClipAudioSettings = {
    linkState: 'linked',
    muted: false,
    gainDb: 0,
    fadeInFrames: 0,
    fadeOutFrames: 0,
};

export const cloneSubtitleTracks = (tracks: readonly SubtitleTrack[]): SubtitleTrack[] => (
    JSON.parse(JSON.stringify(tracks)) as SubtitleTrack[]
);

export const cloneSubtitles = (subtitles: readonly Subtitle[] | null): Subtitle[] | null => (
    subtitles ? JSON.parse(JSON.stringify(subtitles)) as Subtitle[] : null
);

export const cloneTranscriptionGroups = (
    groups: { [key: string]: Subtitle[] } | null,
): { [key: string]: Subtitle[] } | null => (
    groups ? JSON.parse(JSON.stringify(groups)) as { [key: string]: Subtitle[] } : null
);

export const cloneContainerIds = (ids: readonly string[] | null): string[] | null => (
    ids ? [...ids] : null
);

export const cloneVideoClips = (
    clips: readonly (VideoClip | VideoClipV3)[],
): TimelineVideoClip[] => clips.map((clip) => {
    const extended = clip as VideoClip & { audio?: VideoClipAudioSettings | null };
    return {
        ...extended,
        audio: extended.audio === null ? null : { ...(extended.audio ?? DEFAULT_VIDEO_CLIP_AUDIO) },
    };
});

export const cloneRenderProfile = (profile: RenderProfile): RenderProfile => ({
    ...profile,
    fps: { ...profile.fps },
});

export const cloneTransientSelection = (
    selection: TransientMediaSelection,
): TransientMediaSelection => (
    selection.kind === 'subtitles'
        ? { ...selection, subtitleIds: [...selection.subtitleIds] }
        : { ...selection }
);

export const cloneTranscriptionByTrackId = (
    provenance: Record<string, TrackTranscriptionProvenanceV3>,
): Record<string, TrackTranscriptionProvenanceV3> => (
    JSON.parse(JSON.stringify(provenance)) as Record<string, TrackTranscriptionProvenanceV3>
);

export const buildEditorDocumentFromState = (state: TimelineStore): EditorDocumentV3 => ({
    version: 3,
    revision: state.revision,
    audioGraphRevision: state.audioGraphRevision,
    renderProfile: cloneRenderProfile(state.renderProfile),
    subtitleTracks: cloneSubtitleTracks(state.tracks).map((track) => ({
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

export const buildEditorManifestFromState = (state: TimelineStore): EditorManifestV3 => (
    createEditorManifestV3(buildEditorDocumentFromState(state))
);

/** Applies audio-graph revision and transcription provenance policy to a durable state patch. */
export const finalizeDurableTimelinePatch = (
    state: TimelineStore,
    patch: Partial<TimelineStore>,
    impact: AudioGraphMutationImpact = 'preserve-transcription',
    recalculateContentBoundary = false,
): Partial<TimelineStore> => {
    // Boundary calculation walks every subtitle and media clip. A separate monotonic token lets
    // runtime selectors retain the exact cached scalar across text, style, and mix-only commands.
    const contentBoundaryRevision = recalculateContentBoundary
        ? state.contentBoundaryRevision + 1
        : state.contentBoundaryRevision;
    const changesAudioGraphCandidate = AUDIO_GRAPH_STATE_KEYS.some((key) => (
        Object.prototype.hasOwnProperty.call(patch, key) && !Object.is(state[key], patch[key])
    ));
    if (!changesAudioGraphCandidate) {
        // Subtitle text/style/name commands are much more frequent than graph edits. They do not
        // need a full cloned EditorDocument plus graph signature comparison on every keystroke.
        return {
            ...patch,
            revision: state.revision + 1,
            audioGraphRevision: state.audioGraphRevision,
            contentBoundaryRevision,
            transcriptionByTrackId: patch.transcriptionByTrackId ?? state.transcriptionByTrackId,
        };
    }

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
        contentBoundaryRevision,
        transcriptionByTrackId: finalized.transcriptionByTrackId,
    };
};

const AUDIO_GRAPH_STATE_KEYS = [
    'renderProfile',
    'videoSources',
    'videoClips',
    'audioSources',
    'audioTracks',
] as const satisfies readonly (keyof TimelineStore)[];
