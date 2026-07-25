import type { SubtitleTrackV4 } from '@/types/timeline';
import type {
    AudioSourceDescriptor,
    AudioTrack,
    EditorManifestV4,
    RenderProfile,
    VideoClipV4,
    VideoSourceDescriptorV3,
    VideoTrackV4,
} from '@/types/video';

/** Exact descriptor-only subset consumed by headless planning. */
export interface DescriptorRenderGraphV4 {
    renderProfile: RenderProfile;
    videoSources: readonly VideoSourceDescriptorV3[];
    videoClips: readonly VideoClipV4[];
    videoTracks: readonly VideoTrackV4[];
    audioSources: readonly AudioSourceDescriptor[];
    audioTracks: readonly AudioTrack[];
    subtitleTracks: readonly SubtitleTrackV4[];
}

export function createDescriptorRenderGraphV4(
    manifest: EditorManifestV4,
): DescriptorRenderGraphV4 {
    return {
        renderProfile: manifest.renderProfile,
        videoSources: manifest.videoSourceDescriptors,
        videoClips: manifest.videoClips,
        videoTracks: manifest.videoTracks,
        audioSources: manifest.audioSourceDescriptors,
        audioTracks: manifest.audioTracks,
        subtitleTracks: manifest.subtitleTracks,
    };
}
