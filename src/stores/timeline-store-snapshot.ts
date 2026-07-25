import { finalizeAudioGraphMutation, type AudioGraphMutationImpact } from '@/lib/audio-graph-signature';
import { createEditorManifestV4 } from '@/lib/editor-document-v4-migration';
import { createEditorManifestV3 } from '@/lib/editor-document-migration';
import { cloneAudioTracks } from '@/lib/audio-timeline';
import type { Subtitle, SubtitleTrack, SubtitleTrackV4 } from '@/types/timeline';
import type {
    EditorDocumentV4,
    EditorDocumentV3,
    EditorManifestV4,
    EditorManifestV3,
    RenderProfile,
    TrackTranscriptionProvenanceV3,
    TransientMediaSelectionV4,
    VideoClipAudioSettings,
    VideoClip,
    VideoClipV4,
    VideoTrackV4,
} from '@/types/video';
import type { TimelineStore, TimelineSubtitleTrack, TimelineVideoClip } from './timeline-store-types';
import {
    buildTimelineVideoTrackMirrors,
    projectVideoClipsV4,
    projectVideoTracksV4,
    type TimelineVideoTrack,
} from './timeline-v4-compat';

export const DEFAULT_VIDEO_CLIP_AUDIO: VideoClipAudioSettings = {
    linkState: 'linked',
    muted: false,
    gainDb: 0,
    fadeInFrames: 0,
    fadeOutFrames: 0,
};

export const cloneSubtitleTracks = (tracks: readonly SubtitleTrack[]): TimelineSubtitleTrack[] => (
    tracks.map((track) => {
        const candidate = track as SubtitleTrack & Partial<SubtitleTrackV4> & {
            timingDomain?: 'video-ripple' | 'absolute';
        };
        const unlinkedVideoEditResponse = candidate.unlinkedVideoEditResponse
            ?? (candidate.timingDomain === 'absolute' ? 'stay-absolute' : 'follow-project-ripple');
        return {
            ...candidate,
            style: {
                ...candidate.style,
                ...(candidate.style.position
                    ? { position: { ...candidate.style.position } }
                    : {}),
            },
            subtitles: candidate.subtitles.map((subtitle) => ({ ...subtitle })),
            unlinkedVideoEditResponse,
            timingDomain: unlinkedVideoEditResponse === 'follow-project-ripple'
                ? 'video-ripple'
                : 'absolute',
        };
    })
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
    clips: readonly (TimelineVideoClip | VideoClip)[],
): TimelineVideoClip[] => clips.map((clip) => ({
    ...clip,
    audio: 'audio' in clip
        ? (clip.audio ? { ...clip.audio } : null)
        : { ...DEFAULT_VIDEO_CLIP_AUDIO },
}));

export const cloneRenderProfile = (profile: RenderProfile): RenderProfile => ({
    ...profile,
    fps: { ...profile.fps },
});

export const cloneTransientSelection = (
    selection: TransientMediaSelectionV4,
): TransientMediaSelectionV4 => (
    selection.kind === 'subtitles'
        ? { ...selection, subtitleIds: [...selection.subtitleIds] }
        : selection.kind === 'narrative'
            ? { ...selection, sourceWordIds: [...selection.sourceWordIds], boundary: selection.boundary ? { ...selection.boundary } : null }
        : { ...selection }
);

export const cloneTranscriptionByTrackId = (
    provenance: Record<string, TrackTranscriptionProvenanceV3>,
): Record<string, TrackTranscriptionProvenanceV3> => (
    JSON.parse(JSON.stringify(provenance)) as Record<string, TrackTranscriptionProvenanceV3>
);

export const buildEditorDocumentFromState = (state: TimelineStore): EditorDocumentV4 => ({
    version: 4,
    revision: state.revision,
    audioGraphRevision: state.audioGraphRevision,
    renderProfile: cloneRenderProfile(state.renderProfile),
    renderBackgroundColor: state.renderBackgroundColor,
    subtitleTracks: cloneSubtitleTracks(state.tracks).map((track) => {
        const { timingDomain: _legacyTimingDomain, ...v4Track } = track;
        void _legacyTimingDomain;
        return {
            ...v4Track,
            // cloneSubtitleTracks always materializes this V4 policy; the transitional public
            // type keeps it optional only so pre-WP8 callers can still provide legacy fixtures.
            unlinkedVideoEditResponse: track.unlinkedVideoEditResponse ?? 'follow-project-ripple',
        };
    }),
    videoSources: state.videoSources.map((source) => ({ ...source })),
    videoClips: projectVideoClipsV4(state.videoClips, state.videoTracks, state.renderProfile),
    videoTracks: projectVideoTracksV4(state.videoTracks),
    audioSources: state.audioSources.map((source) => ({ ...source })),
    audioTracks: cloneAudioTracks(state.audioTracks),
    activeSubtitleTrackId: state.activeTrackId,
    transientSelection: cloneTransientSelection(state.transientSelection),
    transcriptionByTrackId: cloneTranscriptionByTrackId(state.transcriptionByTrackId),
    globalEditingMode: state.globalEditingMode,
    editorialTranscriptDescriptors: structuredClone(state.editorialTranscriptDescriptors),
    narrative: structuredClone(state.narrative),
    dependentLinks: structuredClone(state.dependentLinks),
});

export const buildEditorManifestFromState = (state: TimelineStore): EditorManifestV4 => (
    createEditorManifestV4(buildEditorDocumentFromState(state))
);

/**
 * Read-only compatibility projection for legacy subtitle-transcription/bundle consumers.
 *
 * V3 cannot encode explicit gaps or cross-track overlap, so this adapter must never feed V4
 * persistence or structural commands. It exists only until WP7/WP8 move those callers to the
 * canonical methods and deliberately drops narrative selection to `none`.
 */
export const buildLegacyEditorDocumentFromState = (state: TimelineStore): EditorDocumentV3 => ({
    version: 3,
    revision: state.revision,
    audioGraphRevision: state.audioGraphRevision,
    renderProfile: cloneRenderProfile(state.renderProfile),
    subtitleTracks: cloneSubtitleTracks(state.tracks).map((track) => {
        const { unlinkedVideoEditResponse, ...base } = track;
        return {
            ...base,
            timingDomain: unlinkedVideoEditResponse === 'follow-project-ripple'
                ? 'video-ripple'
                : 'absolute',
        };
    }),
    videoSources: state.videoSources.map((source) => ({ ...source })),
    videoClips: state.videoClips.map((clip) => ({
        id: clip.id,
        sourceId: clip.sourceId,
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
        audio: clip.audio ? { ...clip.audio } : null,
    })),
    videoTracks: state.videoTracks.map((track) => ({
        id: track.id,
        name: track.name,
        clipIds: [...track.clipIds],
    })),
    audioSources: state.audioSources.map((source) => ({ ...source })),
    audioTracks: cloneAudioTracks(state.audioTracks),
    activeSubtitleTrackId: state.activeTrackId,
    transientSelection: state.transientSelection.kind === 'narrative'
        ? { kind: 'none' }
        : cloneTransientSelection(state.transientSelection) as import('@/types/video').TransientMediaSelection,
    transcriptionByTrackId: cloneTranscriptionByTrackId(state.transcriptionByTrackId),
});

export const buildLegacyEditorManifestFromState = (state: TimelineStore): EditorManifestV3 => (
    createEditorManifestV3(buildLegacyEditorDocumentFromState(state))
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
            transcriptionByTrackId: preserveEqualTranscriptionReference(
                state.transcriptionByTrackId,
                patch.transcriptionByTrackId ?? state.transcriptionByTrackId,
            ),
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
        transcriptionByTrackId: preserveEqualTranscriptionReference(
            state.transcriptionByTrackId,
            finalized.transcriptionByTrackId,
        ),
    };
};

const preserveEqualTranscriptionReference = (
    current: Record<string, TrackTranscriptionProvenanceV3>,
    next: Record<string, TrackTranscriptionProvenanceV3>,
): Record<string, TrackTranscriptionProvenanceV3> => (
    JSON.stringify(current) === JSON.stringify(next) ? current : next
);

const AUDIO_GRAPH_STATE_KEYS = [
    'renderProfile',
    'videoSources',
    'videoClips',
    'audioSources',
    'audioTracks',
] as const satisfies readonly (keyof TimelineStore)[];

export const cloneTimelineVideoTracks = (
    tracks: readonly (VideoTrackV4 | TimelineVideoTrack)[],
    clips: readonly VideoClipV4[],
): TimelineVideoTrack[] => buildTimelineVideoTrackMirrors(
    tracks.map(({ id, name, visible = true, locked = false }) => ({ id, name, visible, locked })),
    clips,
);
