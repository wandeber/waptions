import {
    buildVideoTrackPlacementsV4,
    mapProjectFrameToVideoSourceTimeV4,
    resolveVisibleVideoPlacementAtFrame,
    type VideoClipPlacementV4,
    type VideoTrackPlacementsV4,
} from '../video-placement-v4';
import type { DescriptorRenderGraphV4 } from './descriptor-render-graph';

export interface DescriptorVideoFramePlacementV4 {
    /** Always explicit in V4; no ClipPlacement union can erase track ownership. */
    placement: VideoClipPlacementV4;
    projectFrameIndex: number;
    sourceTime: number;
}

export function buildDescriptorVideoPlanV4(
    graph: Pick<DescriptorRenderGraphV4, 'renderProfile' | 'videoClips' | 'videoTracks'>,
): VideoTrackPlacementsV4[] {
    return buildVideoTrackPlacementsV4({
        renderProfile: graph.renderProfile,
        videoClips: [...graph.videoClips],
        videoTracks: [...graph.videoTracks],
    });
}

export function resolveDescriptorVideoPlacementAtFrame(
    tracks: readonly VideoTrackPlacementsV4[],
    projectFrameIndex: number,
): DescriptorVideoFramePlacementV4 | null {
    const placement = resolveVisibleVideoPlacementAtFrame(tracks, projectFrameIndex);
    if (!placement) return null;
    const sourceTime = mapProjectFrameToVideoSourceTimeV4(placement, projectFrameIndex);
    return sourceTime === null ? null : { placement, projectFrameIndex, sourceTime };
}
