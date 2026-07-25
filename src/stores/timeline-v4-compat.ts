import type { NarrativeDocumentV1 } from '@/types/editorial';
import type { SubtitleTrackV4 } from '@/types/timeline';
import { getVideoClipDurationFramesV4 } from '@/lib/video-placement-v4';
import type {
    EditorDocumentV4,
    RenderProfile,
    TransientMediaSelectionV4,
    VideoClipV3,
    VideoClipV4,
    VideoTrackV4,
} from '@/types/video';
import {
    buildVideoFrameRuntimePlan,
    type VideoFrameRuntimePlan,
} from '@/lib/video-frame-plan';

/**
 * Temporary lane mirror consumed by the pre-V4 Timeline components.
 *
 * `clipIds` is derived from the canonical V4 `VideoClipV4.trackId` relation and is stripped from
 * document, history, and persistence projections. Keeping the mirror at the store/view boundary
 * lets WP8 migrate components independently without creating a second persisted placement graph.
 */
export type TimelineVideoTrack = Pick<VideoTrackV4, 'id' | 'name'>
    & Partial<Pick<VideoTrackV4, 'visible' | 'locked'>>
    & { clipIds: string[] };

type TimelineVideoProjectionTrack = Pick<VideoTrackV4, 'id' | 'name'>
    & Partial<Pick<VideoTrackV4, 'visible' | 'locked'>>
    & { clipIds?: readonly string[] };

type TimelineVideoProjectionClip = VideoClipV3
    & Partial<Pick<VideoClipV4, 'trackId' | 'timelineStartFrame'>>;

/** Builds the temporary V3-shaped membership list from the sole V4 ownership authority. */
export function buildTimelineVideoTrackMirrors(
    tracks: readonly VideoTrackV4[],
    clips: readonly Pick<VideoClipV4, 'id' | 'trackId'>[],
): TimelineVideoTrack[] {
    const clipIdsByTrack = new Map(tracks.map((track) => [track.id, [] as string[]]));
    clips.forEach((clip) => clipIdsByTrack.get(clip.trackId)?.push(clip.id));
    return tracks.map((track) => ({
        id: track.id,
        name: track.name,
        visible: track.visible,
        locked: track.locked,
        clipIds: clipIdsByTrack.get(track.id) ?? [],
    }));
}

/** Removes the compatibility-only membership list before any serializable projection is built. */
export function projectVideoTracksV4(tracks: readonly TimelineVideoProjectionTrack[]): VideoTrackV4[] {
    return tracks.map(({ id, name, visible = true, locked = false }) => ({ id, name, visible, locked }));
}

/** Completes V4 lane flags after a legacy membership helper returns its additive mirror shape. */
export function normalizeTimelineVideoTrackMirrors(
    tracks: readonly TimelineVideoTrack[],
): TimelineVideoTrack[] {
    return tracks.map((track) => ({
        ...track,
        clipIds: [...track.clipIds],
        visible: track.visible ?? true,
        locked: track.locked ?? false,
    }));
}

/** Clones V4 clips, including the independently nullable embedded-audio controls. */
export function cloneVideoClipsV4(clips: readonly VideoClipV4[]): VideoClipV4[] {
    return clips.map((clip) => ({
        ...clip,
        audio: clip.audio ? { ...clip.audio } : null,
    }));
}

/**
 * Completes the temporary public clip shape at the one V4 projection boundary.
 *
 * Missing placement is accepted only for pre-WP8 V3 callers. It is reconstructed with the exact
 * legacy global cumulative rule used by the V3-to-V4 migration. Once a clip carries explicit V4
 * fields they are preserved verbatim, including intentional gaps and overlaps across tracks.
 */
export function projectVideoClipsV4(
    clips: readonly TimelineVideoProjectionClip[],
    tracks: readonly TimelineVideoProjectionTrack[],
    renderProfile: RenderProfile,
): VideoClipV4[] {
    const trackIdByClipId = new Map<string, string>();
    tracks.forEach((track) => track.clipIds?.forEach((clipId) => (
        trackIdByClipId.set(clipId, track.id)
    )));
    const fallbackTrackId = tracks[0]?.id;
    let legacyCursor = 0;
    return clips.map((clip) => {
        const trackId = clip.trackId ?? trackIdByClipId.get(clip.id) ?? fallbackTrackId;
        if (!trackId) throw new Error(`Video clip "${clip.id}" has no V4 track owner.`);
        const timelineStartFrame = clip.timelineStartFrame ?? legacyCursor;
        const projected: VideoClipV4 = {
            ...clip,
            trackId,
            timelineStartFrame,
            audio: clip.audio ? { ...clip.audio } : null,
        };
        legacyCursor += getVideoClipDurationFramesV4(projected, renderProfile);
        return projected;
    });
}

/** Returns the coherent V4 document slice shared by video, warmup, duration, and audio runtimes. */
export function projectTimelineVideoRuntimeDocumentV4(input: {
    renderProfile: RenderProfile;
    videoClips: readonly TimelineVideoProjectionClip[];
    videoTracks: readonly TimelineVideoProjectionTrack[];
}): Pick<EditorDocumentV4, 'renderProfile' | 'videoClips' | 'videoTracks'> {
    return {
        renderProfile: input.renderProfile,
        videoClips: projectVideoClipsV4(
            input.videoClips,
            input.videoTracks,
            input.renderProfile,
        ),
        videoTracks: projectVideoTracksV4(input.videoTracks),
    };
}

/**
 * Builds the video runtime plan from the canonical V4 projection of the transitional store graph.
 *
 * Store tracks temporarily retain `clipIds` for legacy Timeline components. Passing those mirrors
 * directly to the strict runtime discriminator creates an ambiguous V3/V4 graph, particularly for
 * a new project whose sole track has no clips. This boundary removes the mirrors and completes any
 * legacy-shaped clip placements before preview or warmup performs version detection.
 */
export function buildTimelineVideoFrameRuntimePlanV4(input: {
    renderProfile: RenderProfile;
    videoClips: readonly TimelineVideoProjectionClip[];
    videoTracks: readonly TimelineVideoProjectionTrack[];
}): Extract<VideoFrameRuntimePlan, { version: 4 }> {
    const plan = buildVideoFrameRuntimePlan(projectTimelineVideoRuntimeDocumentV4(input));
    if (plan.version !== 4) {
        throw new Error('Timeline store did not project a valid V4 video runtime graph.');
    }
    return plan;
}

/** Clones V4 subtitle lanes without retaining legacy `timingDomain` compatibility properties. */
export function cloneSubtitleTracksV4(tracks: readonly SubtitleTrackV4[]): SubtitleTrackV4[] {
    return tracks.map((track) => ({
        id: track.id,
        name: track.name,
        style: { ...track.style, position: { ...track.style.position } },
        subtitles: track.subtitles.map((subtitle) => ({ ...subtitle })),
        isVisible: track.isVisible,
        isLocked: track.isLocked,
        unlinkedVideoEditResponse: track.unlinkedVideoEditResponse,
    }));
}

/**
 * Derives every pre-V4 selection mirror from the authoritative transient V4 selection.
 *
 * Narrative selections intentionally highlight their owned Timeline clip. Keeping that mapping in
 * one pure projection prevents command commits, hydration, and history navigation from disagreeing
 * about whether the Text and Timeline workspaces refer to the same occurrence.
 */
export function projectTransientSelectionMirrorsV4(
    selection: TransientMediaSelectionV4,
    narrative: NarrativeDocumentV1 | null,
): {
    selectedSubtitleIds: string[];
    lastSelectedId: string | null;
    selectedClipId: string | null;
    isVideoSelected: boolean;
} {
    const selectedSubtitleIds = selection.kind === 'subtitles'
        ? [...selection.subtitleIds]
        : [];
    const narrativeClipId = selection.kind === 'narrative'
        ? narrative?.blocks[selection.blockId]?.clipId ?? null
        : null;
    const selectedClipId = selection.kind === 'video-clip'
        ? selection.clipId
        : narrativeClipId;
    return {
        selectedSubtitleIds,
        lastSelectedId: selectedSubtitleIds.at(-1) ?? null,
        selectedClipId,
        isVideoSelected: selectedClipId !== null,
    };
}
