import type { VideoClipV3, VideoTrack } from '@/types/video';
import { isSafeVideoId } from './video-timeline';

export const DEFAULT_VIDEO_TRACK_ID = 'video_track_1';
export const DEFAULT_VIDEO_TRACK_NAME = 'Video 1';

export interface VideoTrackValidationIssue {
    path: string;
    message: string;
}

export interface VideoTrackMoveResult {
    videoTracks: VideoTrack[];
    changed: boolean;
}

/** Creates the deterministic lane used by V1/V2 and pre-lane V3 documents. */
export function createDefaultVideoTracks(videoClips: readonly Pick<VideoClipV3, 'id'>[]): VideoTrack[] {
    return [{
        id: DEFAULT_VIDEO_TRACK_ID,
        name: DEFAULT_VIDEO_TRACK_NAME,
        clipIds: videoClips.map((clip) => clip.id),
    }];
}

/** Clones lane membership before it crosses a store, history, or persistence boundary. */
export function cloneVideoTracks(videoTracks: readonly VideoTrack[]): VideoTrack[] {
    return videoTracks.map((track) => ({ ...track, clipIds: [...track.clipIds] }));
}

/**
 * Validates the complete lane partition against canonical program order.
 *
 * A present but malformed mapping is never repaired silently. This makes corruption explicit,
 * while legacy documents can be normalized only at the version-aware hydration boundary.
 */
export function validateVideoTracks(
    videoTracks: readonly VideoTrack[],
    videoClips: readonly Pick<VideoClipV3, 'id'>[],
): VideoTrackValidationIssue[] {
    const issues: VideoTrackValidationIssue[] = [];
    if (videoTracks.length === 0) {
        issues.push({ path: 'videoTracks', message: 'At least one video track is required.' });
        return issues;
    }

    const globalIndex = new Map(videoClips.map((clip, index) => [clip.id, index]));
    const trackIds = new Set<string>();
    const assigned = new Map<string, string>();
    videoTracks.forEach((track, trackIndex) => {
        const path = `videoTracks[${trackIndex}]`;
        if (!isSafeVideoId(track.id)) {
            issues.push({ path: `${path}.id`, message: 'Video track ID must be a safe editor ID.' });
        } else if (trackIds.has(track.id)) {
            issues.push({ path: `${path}.id`, message: `Duplicate video track ID "${track.id}".` });
        }
        trackIds.add(track.id);
        if (typeof track.name !== 'string' || track.name.trim().length === 0) {
            issues.push({ path: `${path}.name`, message: 'Video track name must not be empty.' });
        }

        let previousGlobalIndex = -1;
        track.clipIds.forEach((clipId, clipIndex) => {
            const clipPath = `${path}.clipIds[${clipIndex}]`;
            const canonicalIndex = globalIndex.get(clipId);
            if (canonicalIndex === undefined) {
                issues.push({ path: clipPath, message: `Unknown video clip ID "${clipId}".` });
                return;
            }
            const previousTrackId = assigned.get(clipId);
            if (previousTrackId) {
                issues.push({
                    path: clipPath,
                    message: `Video clip "${clipId}" is already assigned to track "${previousTrackId}".`,
                });
            } else {
                assigned.set(clipId, track.id);
            }
            if (canonicalIndex <= previousGlobalIndex) {
                issues.push({
                    path: clipPath,
                    message: 'Video track clip IDs must follow canonical video clip order.',
                });
            }
            previousGlobalIndex = canonicalIndex;
        });
    });

    videoClips.forEach((clip, index) => {
        if (!assigned.has(clip.id)) {
            issues.push({
                path: `videoClips[${index}].id`,
                message: `Video clip "${clip.id}" is not assigned to a video track.`,
            });
        }
    });
    return issues;
}

/** Reorders lane IDs to match the canonical, flat program sequence without changing membership. */
export function canonicalizeVideoTrackClipOrder(
    videoTracks: readonly VideoTrack[],
    videoClips: readonly Pick<VideoClipV3, 'id'>[],
): VideoTrack[] {
    const trackByClipId = new Map<string, string>();
    videoTracks.forEach((track) => track.clipIds.forEach((clipId) => trackByClipId.set(clipId, track.id)));
    const idsByTrack = new Map(videoTracks.map((track) => [track.id, [] as string[]]));
    videoClips.forEach((clip) => idsByTrack.get(trackByClipId.get(clip.id) ?? '')?.push(clip.id));
    return videoTracks.map((track) => ({ ...track, clipIds: idsByTrack.get(track.id) ?? [] }));
}

export function addVideoTrackMembership(
    videoTracks: readonly VideoTrack[],
    track: VideoTrack,
    insertionIndex = videoTracks.length,
): VideoTrackMoveResult {
    if (!isSafeVideoId(track.id)
        || !track.name.trim()
        || track.clipIds.length > 0
        || videoTracks.some((item) => item.id === track.id)) {
        return { videoTracks: cloneVideoTracks(videoTracks), changed: false };
    }
    const index = Math.max(0, Math.min(videoTracks.length, Math.round(insertionIndex)));
    const next = cloneVideoTracks(videoTracks);
    next.splice(index, 0, { ...track, clipIds: [] });
    return { videoTracks: next, changed: true };
}

export function removeEmptyVideoTrackMembership(
    videoTracks: readonly VideoTrack[],
    trackId: string,
): VideoTrackMoveResult {
    const track = videoTracks.find((item) => item.id === trackId);
    if (videoTracks.length <= 1 || !track || track.clipIds.length > 0) {
        return { videoTracks: cloneVideoTracks(videoTracks), changed: false };
    }
    return {
        videoTracks: cloneVideoTracks(videoTracks.filter((item) => item.id !== trackId)),
        changed: true,
    };
}

export function moveVideoClipToTrackMembership(
    videoTracks: readonly VideoTrack[],
    videoClips: readonly Pick<VideoClipV3, 'id'>[],
    clipId: string,
    targetTrackId: string,
): VideoTrackMoveResult {
    const source = videoTracks.find((track) => track.clipIds.includes(clipId));
    const target = videoTracks.find((track) => track.id === targetTrackId);
    if (!source || !target || source.id === target.id) {
        return { videoTracks: cloneVideoTracks(videoTracks), changed: false };
    }

    let next = cloneVideoTracks(videoTracks).map((track) => ({
        ...track,
        clipIds: track.id === source.id
            ? track.clipIds.filter((id) => id !== clipId)
            : track.id === target.id
                ? [...track.clipIds, clipId]
                : track.clipIds,
    }));
    if (next.length > 1 && next.find((track) => track.id === source.id)?.clipIds.length === 0) {
        next = next.filter((track) => track.id !== source.id);
    }
    return { videoTracks: canonicalizeVideoTrackClipOrder(next, videoClips), changed: true };
}

export function moveVideoClipToNewTrackMembership(
    videoTracks: readonly VideoTrack[],
    videoClips: readonly Pick<VideoClipV3, 'id'>[],
    clipId: string,
    newTrack: Pick<VideoTrack, 'id' | 'name'>,
    insertionIndex: number,
): VideoTrackMoveResult {
    const sourceIndex = videoTracks.findIndex((track) => track.clipIds.includes(clipId));
    if (sourceIndex < 0 || !isSafeVideoId(newTrack.id) || !newTrack.name.trim()
        || videoTracks.some((track) => track.id === newTrack.id)) {
        return { videoTracks: cloneVideoTracks(videoTracks), changed: false };
    }

    const next = cloneVideoTracks(videoTracks).map((track, index) => index === sourceIndex
        ? { ...track, clipIds: track.clipIds.filter((id) => id !== clipId) }
        : track);
    // The new lane is inserted in the same atomic command, so an emptied source can always be
    // removed here. Even when it was the sole lane before the command, the target lane becomes
    // the required remaining lane and no transient zero-lane state is ever published.
    const prunesSource = next[sourceIndex].clipIds.length === 0;
    if (prunesSource) next.splice(sourceIndex, 1);
    let adjustedIndex = Math.max(0, Math.min(videoTracks.length, Math.round(insertionIndex)));
    if (prunesSource && sourceIndex < adjustedIndex) adjustedIndex -= 1;
    adjustedIndex = Math.max(0, Math.min(next.length, adjustedIndex));
    next.splice(adjustedIndex, 0, { ...newTrack, clipIds: [clipId] });
    return { videoTracks: canonicalizeVideoTrackClipOrder(next, videoClips), changed: true };
}

export function insertSplitVideoClipMembership(
    videoTracks: readonly VideoTrack[],
    videoClips: readonly Pick<VideoClipV3, 'id'>[],
    leftClipId: string,
    rightClipId: string,
): VideoTrack[] {
    return canonicalizeVideoTrackClipOrder(videoTracks.map((track) => {
        const index = track.clipIds.indexOf(leftClipId);
        if (index < 0) return { ...track, clipIds: [...track.clipIds] };
        const clipIds = [...track.clipIds];
        clipIds.splice(index + 1, 0, rightClipId);
        return { ...track, clipIds };
    }), videoClips);
}

export function deleteVideoClipMembership(
    videoTracks: readonly VideoTrack[],
    clipId: string,
): VideoTrack[] {
    const source = videoTracks.find((track) => track.clipIds.includes(clipId));
    let next = cloneVideoTracks(videoTracks).map((track) => track.id === source?.id
        ? { ...track, clipIds: track.clipIds.filter((id) => id !== clipId) }
        : track);
    if (source && next.length > 1 && next.find((track) => track.id === source.id)?.clipIds.length === 0) {
        next = next.filter((track) => track.id !== source.id);
    }
    return next;
}
