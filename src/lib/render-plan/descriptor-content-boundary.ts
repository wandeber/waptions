import type { AudioMixPlan } from '../audio-mix-plan';
import { outputSampleToCoveringFrame } from '../audio-timebase';
import { secondsToFrames } from '../render-profile';
import { getVideoContentEndFrameV4 } from '../video-placement-v4';
import type { DescriptorRenderGraphV4 } from './descriptor-render-graph';

/** Descriptor-only V4 boundary matching timeline/playback/export half-open semantics. */
export function getDescriptorContentEndFrameV4(
    graph: DescriptorRenderGraphV4,
    audioPlan: AudioMixPlan,
): number {
    const videoEndFrame = getVideoContentEndFrameV4({
        renderProfile: graph.renderProfile,
        videoClips: [...graph.videoClips],
        videoTracks: [...graph.videoTracks],
    });
    const subtitleEndFrame = graph.subtitleTracks.reduce(
        (maximum, track) => track.subtitles.reduce(
            (trackMaximum, subtitle) => Math.max(
                trackMaximum,
                secondsToFrames(
                    Math.max(0, subtitle.endTime),
                    graph.renderProfile.fps,
                    'ceil',
                ),
            ),
            maximum,
        ),
        0,
    );
    const audioEndFrame = outputSampleToCoveringFrame(
        audioPlan.totalSampleCount,
        graph.renderProfile.fps,
    );
    return Math.max(videoEndFrame, subtitleEndFrame, audioEndFrame);
}
