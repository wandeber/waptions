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
import {
    buildTimelineVideoTrackMirrors,
    projectTransientSelectionMirrorsV4,
    projectVideoClipsV4,
    projectVideoTracksV4,
} from './timeline-v4-compat';

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
    'globalEditingMode',
    'editorialTranscriptDescriptors',
    'narrative',
    'dependentLinks',
]);

/**
 * Captures the editable graph and full selection/provenance mirrors owned by undo history.
 * Source catalogs remain outside history because their File objects are immutable project assets.
 */
export function projectTimelineHistory(state: TimelineStore): TimelineHistoryProjection {
    const subtitleTracks = cloneSubtitleTracks(state.tracks);
    const legacyV3Projection = state.globalEditingMode === undefined;
    return {
        tracks: legacyV3Projection
            ? subtitleTracks
            : subtitleTracks.map((track) => {
                const { timingDomain: _legacyTimingDomain, ...v4Track } = track;
                void _legacyTimingDomain;
                return v4Track;
            }),
        videoClips: legacyV3Projection
            ? cloneVideoClips(state.videoClips)
            : projectVideoClipsV4(state.videoClips, state.videoTracks, state.renderProfile),
        videoTracks: legacyV3Projection
            ? state.videoTracks.map((track) => ({ ...track, clipIds: [...track.clipIds] }))
            : projectVideoTracksV4(state.videoTracks),
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
        globalEditingMode: state.globalEditingMode,
        editorialTranscriptDescriptors: structuredClone(state.editorialTranscriptDescriptors),
        narrative: structuredClone(state.narrative),
        dependentLinks: structuredClone(state.dependentLinks),
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
        videoClips: projectVideoClipsV4(state.videoClips, state.videoTracks, state.renderProfile),
        videoTracks: projectVideoTracksV4(state.videoTracks),
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
        globalEditingMode: state.globalEditingMode,
        editorialTranscriptDescriptors: state.editorialTranscriptDescriptors,
        narrative: state.narrative,
        dependentLinks: state.dependentLinks,
    };
}

/** Converts a detached projection back into a Zustand patch and refreshes derived runtime FPS. */
export function restoreTimelineHistoryProjection(
    projection: TimelineHistoryProjection,
): Partial<TimelineStore> {
    const activeTranscription = projection.activeTrackId
        ? projection.transcriptionByTrackId[projection.activeTrackId] ?? null
        : null;
    const transientSelection = cloneTransientSelection(projection.transientSelection);
    const narrative = structuredClone(projection.narrative ?? null);
    const selectionMirrors = transientSelection.kind === 'narrative'
        ? projectTransientSelectionMirrorsV4(transientSelection, narrative)
        : {
            selectedSubtitleIds: [...projection.selectedSubtitleIds],
            lastSelectedId: projection.lastSelectedId,
            selectedClipId: projection.selectedClipId,
            isVideoSelected: projection.isVideoSelected,
        };
    return {
        ...projection,
        tracks: cloneSubtitleTracks(projection.tracks),
        videoClips: cloneVideoClips(projection.videoClips),
        videoTracks: buildTimelineVideoTrackMirrors(
            projection.videoTracks.map((track) => ({
                id: track.id,
                name: track.name,
                visible: 'visible' in track ? track.visible ?? true : true,
                locked: 'locked' in track ? track.locked ?? false : false,
            })),
            projection.videoClips.map((clip) => ({
                id: clip.id,
                trackId: clip.trackId
                    ?? projection.videoTracks.find((track) => (
                        track.clipIds?.includes(clip.id)
                    ))?.id
                    ?? projection.videoTracks[0]?.id
                    ?? '',
            })),
        ),
        renderProfile: cloneRenderProfile(projection.renderProfile),
        projectFps: frameRateToNumber(projection.renderProfile.fps),
        audioTracks: cloneAudioTracks(projection.audioTracks),
        transientSelection,
        ...selectionMirrors,
        transcriptionByTrackId: cloneTranscriptionByTrackId(projection.transcriptionByTrackId),
        // These fields are compatibility mirrors for the active subtitle track. History can
        // restore activeTrackId and provenance together, so derive the mirrors instead of keeping
        // values that belonged to whichever track happened to be active before navigation.
        rawTranscription: cloneSubtitles(activeTranscription?.raw ?? null),
        transcriptionGroups: cloneTranscriptionGroups(activeTranscription?.groups ?? null),
        transcriptionContainerIds: cloneContainerIds(activeTranscription?.containerIds ?? null),
        globalEditingMode: projection.globalEditingMode ?? 'ripple',
        editorialTranscriptDescriptors: structuredClone(projection.editorialTranscriptDescriptors ?? []),
        narrative,
        dependentLinks: structuredClone(projection.dependentLinks ?? []),
    };
}
