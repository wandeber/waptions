import type { EditorPersistentAsset } from '@/lib/storage/storage-service';
import type { SubtitleTrack } from '@/types/timeline';
import type { TrackTranscriptionProvenanceV3, TransientMediaSelection } from '@/types/video';
import { getTimelineDurations } from '@/lib/video-timeline';
import type { TimelineStore } from './timeline-store-types';

export const getTrackTimingDomain = (
    track: SubtitleTrack,
): 'video-ripple' | 'absolute' => (
    'timingDomain' in track && track.timingDomain === 'absolute' ? 'absolute' : 'video-ripple'
);

export const getLegacyTranscriptionForTrack = (
    provenance: Record<string, TrackTranscriptionProvenanceV3>,
    trackId: string | null,
): TrackTranscriptionProvenanceV3 | null => (
    trackId ? provenance[trackId] ?? null : null
);

export const selectAudioTimelineSources = (
    state: Pick<TimelineStore, 'videoSources' | 'audioSources'>,
) => ({
    videoSources: state.videoSources,
    audioSources: state.audioSources,
});

export const selectTransientSubtitleSelection = (
    tracks: readonly SubtitleTrack[],
    selectedSubtitleIds: readonly string[],
    preferredTrackId: string | null,
): TransientMediaSelection => {
    const selectedIds = new Set(selectedSubtitleIds);
    const track = tracks.find((item) => (
        item.id === preferredTrackId && item.subtitles.some((subtitle) => selectedIds.has(subtitle.id))
    )) ?? tracks.find((item) => item.subtitles.some((subtitle) => selectedIds.has(subtitle.id)));
    if (!track) return { kind: 'none' };
    const subtitleIds = track.subtitles
        .filter((subtitle) => selectedIds.has(subtitle.id))
        .map((subtitle) => subtitle.id);
    return subtitleIds.length > 0
        ? { kind: 'subtitles', trackId: track.id, subtitleIds }
        : { kind: 'none' };
};

export const selectTimelineContentDuration = (state: TimelineStore): number => (
    getTimelineDurations(state.videoClips, state.tracks, {
        audioTracks: state.audioTracks,
        videoSources: state.videoSources,
        audioSources: state.audioSources,
        renderProfile: state.renderProfile,
    }).contentDuration
);

export const selectPersistentEditorAssets = (state: TimelineStore): EditorPersistentAsset[] => [
    ...state.videoSources.map((asset): EditorPersistentAsset => ({ kind: 'video-source', asset })),
    ...state.audioSources.map((asset): EditorPersistentAsset => ({ kind: 'audio-source', asset })),
];
