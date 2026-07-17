import { frameRateToNumber } from '@/lib/render-profile';
import type { TimelineHistoryProjection, TimelineStore } from './timeline-store-types';
import {
    cloneAudioTracks,
} from '@/lib/audio-timeline';
import {
    cloneContainerIds,
    cloneRenderProfile,
    cloneSubtitles,
    cloneSubtitleTracks,
    cloneTranscriptionByTrackId,
    cloneTranscriptionGroups,
    cloneTransientSelection,
    cloneVideoClips,
} from './timeline-store-snapshot';
import { cloneVideoTracks } from '@/lib/video-tracks';

/** Only these roots may be addressed by serialized history patches. */
export const TIMELINE_HISTORY_ROOTS = new Set<keyof TimelineHistoryProjection>([
    'tracks',
    'videoClips',
    'videoTracks',
    'renderProfile',
    'audioTracks',
    'transientSelection',
    'activeTrackId',
    'selectedSubtitleIds',
    'lastSelectedId',
    'selectedClipId',
    'isVideoSelected',
    'transcriptionByTrackId',
    'rawTranscription',
    'transcriptionGroups',
    'transcriptionContainerIds',
]);

/**
 * Captures the editable graph and full selection/provenance mirrors owned by undo history.
 * Source catalogs remain outside history because their File objects are immutable project assets.
 */
export function projectTimelineHistory(state: TimelineStore): TimelineHistoryProjection {
    return {
        tracks: cloneSubtitleTracks(state.tracks),
        videoClips: cloneVideoClips(state.videoClips),
        videoTracks: cloneVideoTracks(state.videoTracks),
        renderProfile: cloneRenderProfile(state.renderProfile),
        audioTracks: cloneAudioTracks(state.audioTracks),
        transientSelection: cloneTransientSelection(state.transientSelection),
        activeTrackId: state.activeTrackId,
        selectedSubtitleIds: [...state.selectedSubtitleIds],
        lastSelectedId: state.lastSelectedId,
        selectedClipId: state.selectedClipId,
        isVideoSelected: state.isVideoSelected,
        transcriptionByTrackId: cloneTranscriptionByTrackId(state.transcriptionByTrackId),
        rawTranscription: cloneSubtitles(state.rawTranscription),
        transcriptionGroups: cloneTranscriptionGroups(state.transcriptionGroups),
        transcriptionContainerIds: cloneContainerIds(state.transcriptionContainerIds),
    };
}

/**
 * Returns the immutable Zustand references needed for an immediate diff/application.
 *
 * This hot-path view must never be retained after the synchronous command. Patch values own their
 * clones, while persistence uses `projectTimelineHistory` above to capture a detached request.
 */
export function selectTimelineHistoryProjection(state: TimelineStore): TimelineHistoryProjection {
    return {
        tracks: state.tracks,
        videoClips: state.videoClips,
        videoTracks: state.videoTracks,
        renderProfile: state.renderProfile,
        audioTracks: state.audioTracks,
        transientSelection: state.transientSelection,
        activeTrackId: state.activeTrackId,
        selectedSubtitleIds: state.selectedSubtitleIds,
        lastSelectedId: state.lastSelectedId,
        selectedClipId: state.selectedClipId,
        isVideoSelected: state.isVideoSelected,
        transcriptionByTrackId: state.transcriptionByTrackId,
        rawTranscription: state.rawTranscription,
        transcriptionGroups: state.transcriptionGroups,
        transcriptionContainerIds: state.transcriptionContainerIds,
    };
}

/** Converts a detached projection back into a Zustand patch and refreshes derived runtime FPS. */
export function restoreTimelineHistoryProjection(
    projection: TimelineHistoryProjection,
): Partial<TimelineStore> {
    const activeTranscription = projection.activeTrackId
        ? projection.transcriptionByTrackId[projection.activeTrackId] ?? null
        : null;
    return {
        ...projection,
        tracks: cloneSubtitleTracks(projection.tracks),
        videoClips: cloneVideoClips(projection.videoClips),
        videoTracks: cloneVideoTracks(projection.videoTracks),
        renderProfile: cloneRenderProfile(projection.renderProfile),
        projectFps: frameRateToNumber(projection.renderProfile.fps),
        audioTracks: cloneAudioTracks(projection.audioTracks),
        transientSelection: cloneTransientSelection(projection.transientSelection),
        selectedSubtitleIds: [...projection.selectedSubtitleIds],
        transcriptionByTrackId: cloneTranscriptionByTrackId(projection.transcriptionByTrackId),
        // These fields are compatibility mirrors for the active subtitle track. History can
        // restore activeTrackId and provenance together, so derive the mirrors instead of keeping
        // values that belonged to whichever track happened to be active before navigation.
        rawTranscription: cloneSubtitles(activeTranscription?.raw ?? null),
        transcriptionGroups: cloneTranscriptionGroups(activeTranscription?.groups ?? null),
        transcriptionContainerIds: cloneContainerIds(activeTranscription?.containerIds ?? null),
    };
}
