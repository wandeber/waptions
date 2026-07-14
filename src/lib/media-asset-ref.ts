import type {
    AudioSourceAsset,
    AudioSourceDescriptor,
    VideoSourceAssetV3,
    VideoSourceDescriptorV3,
} from '@/types/video';

export type EditorMediaAssetReference =
    | { kind: 'video-source'; videoSourceId: string }
    | { kind: 'audio-source'; audioSourceId: string };

export type AudioMediaReference =
    | { kind: 'video-source-audio'; videoSourceId: string }
    | { kind: 'audio-source'; audioSourceId: string };

export type EditorMediaAsset =
    | { kind: 'video-source'; asset: VideoSourceDescriptorV3 | VideoSourceAssetV3 }
    | { kind: 'audio-source'; asset: AudioSourceDescriptor | AudioSourceAsset };

export type AudioMediaAsset =
    | { kind: 'video-source-audio'; asset: VideoSourceAssetV3 }
    | { kind: 'audio-source'; asset: AudioSourceAsset };

export type EditorMediaAssetKey = `video-source:${string}` | `audio-source:${string}`;
export type AudioMediaCacheKey = `video-source-audio:${string}` | `audio-source:${string}`;

/**
 * Builds a durable editor-catalog key from a discriminated reference or asset wrapper.
 * A bare source ID is deliberately insufficient because video and audio catalogs are
 * independent namespaces and may legally allocate the same identifier.
 */
export function getEditorMediaAssetKey(
    value: EditorMediaAssetReference | EditorMediaAsset,
): EditorMediaAssetKey {
    if ('asset' in value) {
        return value.kind === 'video-source'
            ? `video-source:${value.asset.id}`
            : `audio-source:${value.asset.id}`;
    }
    return value.kind === 'video-source'
        ? `video-source:${value.videoSourceId}`
        : `audio-source:${value.audioSourceId}`;
}

/**
 * Builds a typed cache key for decoded audio. Embedded video audio is a different
 * media stream from an imported audio asset even when both happen to share an ID.
 */
export function getAudioMediaCacheKey(
    value: AudioMediaReference | AudioMediaAsset,
): AudioMediaCacheKey {
    if ('asset' in value) {
        return value.kind === 'video-source-audio'
            ? `video-source-audio:${value.asset.id}`
            : `audio-source:${value.asset.id}`;
    }
    return value.kind === 'video-source-audio'
        ? `video-source-audio:${value.videoSourceId}`
        : `audio-source:${value.audioSourceId}`;
}

export function getAudioMediaDuration(media: AudioMediaAsset): number {
    return media.asset.duration;
}

export function resolveAudioMediaAsset(
    reference: AudioMediaReference,
    videoSources: readonly VideoSourceAssetV3[],
    audioSources: readonly AudioSourceAsset[],
): AudioMediaAsset | null {
    if (reference.kind === 'video-source-audio') {
        const asset = videoSources.find((source) => source.id === reference.videoSourceId);
        return asset?.hasAudio ? { kind: 'video-source-audio', asset } : null;
    }
    const asset = audioSources.find((source) => source.id === reference.audioSourceId);
    return asset ? { kind: 'audio-source', asset } : null;
}
