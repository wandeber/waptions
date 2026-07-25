import type {
    EditorDocumentV4,
    RationalFrameRate,
    RenderProfile,
    VideoClipV4,
    VideoTrackV4,
} from '@/types/video';
import { framesToSeconds, secondsToFrames } from './render-profile';

export type VideoPlacementDocumentV4 = Pick<
    EditorDocumentV4,
    'renderProfile' | 'videoTracks' | 'videoClips'
>;

/** Exact half-open project placement for one explicit V4 video occurrence. */
export interface VideoClipPlacementV4 {
    clip: VideoClipV4;
    clipIndex: number;
    trackId: string;
    trackIndex: number;
    projectFrameRate: RationalFrameRate;
    startFrame: number;
    endFrame: number;
    durationFrames: number;
    startSeconds: number;
    endSeconds: number;
}

/** One visual layer and its start-sorted, non-overlapping placements. */
export interface VideoTrackPlacementsV4 {
    track: VideoTrackV4;
    trackIndex: number;
    placements: VideoClipPlacementV4[];
}

/**
 * Reusable lookup indexes for frame planners and command preflights.
 *
 * Maps are returned as readonly contracts so callers share one placement calculation instead of
 * independently reconstructing track membership or clip duration from array order.
 */
export interface VideoTrackPlacementIndexV4 {
    tracks: VideoTrackPlacementsV4[];
    byTrackId: ReadonlyMap<string, VideoTrackPlacementsV4>;
    byClipId: ReadonlyMap<string, VideoClipPlacementV4>;
}

/** Uses the same nearest-output-frame duration rule as the V3 render and mix paths. */
export function getVideoClipDurationFramesV4(
    clip: Pick<VideoClipV4, 'sourceStart' | 'sourceEnd'>,
    profile: Pick<RenderProfile, 'fps'>,
): number {
    if (!Number.isFinite(clip.sourceStart) || clip.sourceStart < 0
        || !Number.isFinite(clip.sourceEnd) || clip.sourceEnd <= clip.sourceStart) {
        throw new RangeError('Video source bounds must form a finite, non-empty half-open interval.');
    }
    // V3 linked-audio and graph-signature code already clamps a valid native-frame crop to one
    // output frame when nearest-frame quantization would otherwise yield zero. Keeping that clamp
    // is required for migration identity; source/native minimum-duration validation remains the
    // authority that rejects genuinely sub-frame media crops.
    return Math.max(1, secondsToFrames(clip.sourceEnd - clip.sourceStart, profile.fps, 'nearest'));
}

/** Resolves one clip from its durable track and explicit start rather than legacy array position. */
export function getVideoClipPlacementV4(
    document: VideoPlacementDocumentV4,
    clipOrId: VideoClipV4 | string,
): VideoClipPlacementV4 {
    const clipId = typeof clipOrId === 'string' ? clipOrId : clipOrId.id;
    const clipIndex = document.videoClips.findIndex((clip) => clip.id === clipId);
    if (clipIndex < 0) throw new Error(`Unknown V4 video clip ID "${clipId}".`);
    const clip = document.videoClips[clipIndex];
    const trackIndex = document.videoTracks.findIndex((track) => track.id === clip.trackId);
    if (trackIndex < 0) {
        throw new Error(`V4 video clip "${clip.id}" references an unknown track.`);
    }
    return createPlacement(clip, clipIndex, trackIndex, document.renderProfile);
}

/**
 * Builds every visual layer in top-to-bottom order while sorting only inside each layer.
 *
 * Same-track overlap is rejected here as a runtime safety barrier. Structural validation should
 * normally catch it earlier, but frame planning must never silently choose between two clips on
 * the same layer if an unvalidated graph reaches this helper.
 */
export function buildVideoTrackPlacementsV4(
    document: VideoPlacementDocumentV4,
): VideoTrackPlacementsV4[] {
    if (document.videoTracks.length === 0) {
        throw new Error('A V4 video graph must contain at least one video track.');
    }
    const trackIndexById = new Map<string, number>();
    document.videoTracks.forEach((track, trackIndex) => {
        if (trackIndexById.has(track.id)) throw new Error(`Duplicate V4 video track ID "${track.id}".`);
        trackIndexById.set(track.id, trackIndex);
    });

    const clipIds = new Set<string>();
    const placementsByTrack = document.videoTracks.map(() => [] as VideoClipPlacementV4[]);
    document.videoClips.forEach((clip, clipIndex) => {
        if (clipIds.has(clip.id)) throw new Error(`Duplicate V4 video clip ID "${clip.id}".`);
        clipIds.add(clip.id);
        const trackIndex = trackIndexById.get(clip.trackId);
        if (trackIndex === undefined) {
            throw new Error(`V4 video clip "${clip.id}" references an unknown track.`);
        }
        placementsByTrack[trackIndex].push(createPlacement(
            clip,
            clipIndex,
            trackIndex,
            document.renderProfile,
        ));
    });

    return document.videoTracks.map((track, trackIndex) => {
        const placements = placementsByTrack[trackIndex].sort(comparePlacements);
        for (let index = 1; index < placements.length; index += 1) {
            if (placements[index].startFrame < placements[index - 1].endFrame) {
                throw new Error(`V4 video clips overlap on track "${track.id}".`);
            }
        }
        return { track, trackIndex, placements };
    });
}

/** Creates stable track/clip lookup maps from one validated placement build. */
export function indexVideoTrackPlacementsV4(
    document: VideoPlacementDocumentV4,
): VideoTrackPlacementIndexV4 {
    const tracks = buildVideoTrackPlacementsV4(document);
    const byTrackId = new Map<string, VideoTrackPlacementsV4>();
    const byClipId = new Map<string, VideoClipPlacementV4>();
    tracks.forEach((track) => {
        byTrackId.set(track.track.id, track);
        track.placements.forEach((placement) => byClipId.set(placement.clip.id, placement));
    });
    return { tracks, byTrackId, byClipId };
}

/**
 * Resolves the winning visual occurrence at one integer project frame.
 *
 * Track array order is the visual stacking authority: index zero wins. Hidden tracks are skipped,
 * while a locked track remains renderable because locking is an edit-preflight concern only.
 */
export function resolveVisibleVideoPlacementAtFrame(
    tracks: readonly VideoTrackPlacementsV4[],
    projectFrame: number,
): VideoClipPlacementV4 | null {
    if (!Number.isSafeInteger(projectFrame) || projectFrame < 0) return null;
    for (const track of tracks) {
        if (!track.track.visible) continue;
        const placement = resolvePlacementOnTrack(track.placements, projectFrame);
        if (placement) return placement;
    }
    return null;
}

/**
 * Maps a project frame to the source timestamp used by legacy V3 preview/export semantics.
 *
 * Duration quantization can leave the final source fraction shorter than one output frame. The
 * mapping therefore advances by exact project-frame duration and clamps only against the durable
 * source crop; it never stretches the crop to fill the rounded placement.
 */
export function mapProjectFrameToVideoSourceTimeV4(
    placement: VideoClipPlacementV4,
    projectFrame: number,
): number | null {
    if (!Number.isSafeInteger(projectFrame)
        || projectFrame < placement.startFrame
        || projectFrame >= placement.endFrame) {
        return null;
    }
    const elapsedFrames = projectFrame - placement.startFrame;
    return Math.min(
        placement.clip.sourceEnd,
        placement.clip.sourceStart + framesToSeconds(elapsedFrames, placement.projectFrameRate),
    );
}

/** Returns the maximum explicit video tail; gaps and array order do not affect the result. */
export function getVideoContentEndFrameV4(document: VideoPlacementDocumentV4): number {
    return buildVideoTrackPlacementsV4(document).reduce(
        (maximum, track) => track.placements.reduce(
            (trackMaximum, placement) => Math.max(trackMaximum, placement.endFrame),
            maximum,
        ),
        0,
    );
}

function createPlacement(
    clip: VideoClipV4,
    clipIndex: number,
    trackIndex: number,
    profile: Pick<RenderProfile, 'fps'>,
): VideoClipPlacementV4 {
    if (!Number.isSafeInteger(clip.timelineStartFrame) || clip.timelineStartFrame < 0) {
        throw new RangeError('V4 video placement must start at a non-negative safe frame.');
    }
    const durationFrames = getVideoClipDurationFramesV4(clip, profile);
    const endFrame = clip.timelineStartFrame + durationFrames;
    if (!Number.isSafeInteger(endFrame)) {
        throw new RangeError('V4 video placement end must fit in a safe integer frame.');
    }
    return {
        clip,
        clipIndex,
        trackId: clip.trackId,
        trackIndex,
        projectFrameRate: profile.fps,
        startFrame: clip.timelineStartFrame,
        endFrame,
        durationFrames,
        startSeconds: framesToSeconds(clip.timelineStartFrame, profile.fps),
        endSeconds: framesToSeconds(endFrame, profile.fps),
    };
}

function comparePlacements(left: VideoClipPlacementV4, right: VideoClipPlacementV4): number {
    return left.startFrame - right.startFrame
        || left.endFrame - right.endFrame
        || left.clipIndex - right.clipIndex;
}

function resolvePlacementOnTrack(
    placements: readonly VideoClipPlacementV4[],
    projectFrame: number,
): VideoClipPlacementV4 | null {
    let low = 0;
    let high = placements.length - 1;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const placement = placements[middle];
        if (projectFrame < placement.startFrame) high = middle - 1;
        else if (projectFrame >= placement.endFrame) low = middle + 1;
        else return placement;
    }
    return null;
}
