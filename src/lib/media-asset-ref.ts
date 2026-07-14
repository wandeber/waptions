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
export type WaveformRepositoryKey = `waveform:${'video-source-audio' | 'audio-source'}:${string}:v${number}:r${number}`;

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

/**
 * Builds the identity of derived waveform peaks independently from a project's source IDs.
 *
 * Source IDs are intentionally omitted: importing the same immutable file into another project
 * should reuse its derived peaks. The typed source kind still separates an embedded video stream
 * from a standalone audio file, while the algorithm version and resolution make invalidation an
 * explicit schema decision instead of relying on a destructive database migration. The optional
 * fingerprint override lets the repository session-scope unsafe legacy metadata fingerprints.
 */
export function getWaveformRepositoryKey(
    media: AudioMediaAsset,
    algorithmVersion: number,
    resolution: number,
    fingerprint = media.asset.fingerprint,
): WaveformRepositoryKey {
    if (!Number.isSafeInteger(algorithmVersion) || algorithmVersion <= 0) {
        throw new Error('Waveform algorithm version must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(resolution) || resolution <= 0) {
        throw new Error('Waveform resolution must be a positive safe integer.');
    }
    return `waveform:${media.kind}:${encodeURIComponent(fingerprint)}:v${algorithmVersion}:r${resolution}`;
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
