import type { VideoClipV3, VideoTrack } from '@/types/video';

export type VideoCutDetectionScope = 'clip' | 'selection' | 'track' | 'all-tracks';

/** Runtime-only context captured when scene detection is opened from a clip or video lane. */
export interface VideoCutDetectionRequest {
    trackId: string;
    clickedClipId: string | null;
    selectedClipIds: string[];
    restoreFocusTo?: HTMLElement | null;
}

/** Mirrors desktop editors: a context click inside a multi-selection keeps that selection active. */
export function getDefaultVideoCutDetectionScope(
    request: VideoCutDetectionRequest,
): VideoCutDetectionScope {
    if (!request.clickedClipId) return 'track';
    if (request.selectedClipIds.length > 1 && request.selectedClipIds.includes(request.clickedClipId)) {
        return 'selection';
    }
    return 'clip';
}

/** Resolves a modal choice to existing clip ids without leaking stale transient selection. */
export function resolveVideoCutDetectionClipIds(
    request: VideoCutDetectionRequest,
    scope: VideoCutDetectionScope,
    tracks: readonly VideoTrack[],
    clips: readonly VideoClipV3[],
): string[] {
    const existingClipIds = new Set(clips.map((clip) => clip.id));
    let candidates: readonly string[];
    if (scope === 'all-tracks') {
        candidates = tracks.flatMap((track) => track.clipIds);
    } else if (scope === 'track') {
        candidates = tracks.find((track) => track.id === request.trackId)?.clipIds ?? [];
    } else if (scope === 'selection') {
        candidates = request.selectedClipIds;
    } else {
        candidates = request.clickedClipId ? [request.clickedClipId] : [];
    }

    return Array.from(new Set(candidates)).filter((clipId) => existingClipIds.has(clipId));
}
