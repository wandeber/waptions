import type {
    AudioSourceAsset,
    AudioSourceDescriptor,
    EditorManifestV3,
    EditorManifestV4,
    VideoSourceAssetV3,
    VideoSourceDescriptorV3,
} from '@/types/video';
import { getEditorMediaAssetKey } from '@/lib/media-asset-ref';
import { doesVideoSourceFingerprintMatch } from '@/lib/video-timeline';

export const LEGACY_VIDEO_SOURCE_KEY_PREFIX = 'source:';
export const LEGACY_SCALAR_VIDEO_KEY = 'video-file';

export interface EditorAssetReader {
    get(key: string): Promise<unknown | null>;
}

export interface ResolvedEditorAsset<T> {
    asset: T;
    /**
     * The key records where the File was found. Migration deliberately keeps legacy blobs in
     * place: writing a second multi-gigabyte File merely to rename its key can exhaust quota and
     * leave the otherwise valid legacy project impossible to open.
     */
    storageKey: string;
    usesTypedKey: boolean;
}

/** Resolves a v3 video descriptor without copying or deleting any legacy IndexedDB record. */
export async function resolveEditorVideoAsset(
    reader: EditorAssetReader,
    descriptor: VideoSourceDescriptorV3,
    manifestVideoSourceCount: number,
): Promise<ResolvedEditorAsset<VideoSourceAssetV3>> {
    const typedKey = getEditorMediaAssetKey({ kind: 'video-source', videoSourceId: descriptor.id });
    const legacyKey = `${LEGACY_VIDEO_SOURCE_KEY_PREFIX}${descriptor.id}`;
    const candidateKeys = [typedKey, legacyKey];
    if (manifestVideoSourceCount === 1) candidateKeys.push(LEGACY_SCALAR_VIDEO_KEY);

    for (const key of candidateKeys) {
        const value = await reader.get(key);
        if (value === null) continue;
        const file = validateResolvedFile(value, descriptor, key);
        return {
            asset: { ...descriptor, file },
            storageKey: key,
            usesTypedKey: key === typedKey,
        };
    }
    throw new Error(`Missing video source File "${descriptor.id}".`);
}

/** Audio was introduced with v3, so accepting an untyped fallback would hide corrupt data. */
export async function resolveEditorAudioAsset(
    reader: EditorAssetReader,
    descriptor: AudioSourceDescriptor,
): Promise<ResolvedEditorAsset<AudioSourceAsset>> {
    const typedKey = getEditorMediaAssetKey({ kind: 'audio-source', audioSourceId: descriptor.id });
    const value = await reader.get(typedKey);
    if (value === null) throw new Error(`Missing audio source File "${descriptor.id}".`);
    return {
        asset: { ...descriptor, file: validateResolvedFile(value, descriptor, typedKey) },
        storageKey: typedKey,
        usesTypedKey: true,
    };
}

export async function resolveEditorManifestAssets(
    reader: EditorAssetReader,
    manifest: EditorManifestV3 | EditorManifestV4,
): Promise<{
    videoSources: VideoSourceAssetV3[];
    audioSources: AudioSourceAsset[];
    legacyResolvedAssetKeys: string[];
}> {
    const video = await Promise.all(manifest.videoSourceDescriptors.map((descriptor) => (
        resolveEditorVideoAsset(reader, descriptor, manifest.videoSourceDescriptors.length)
    )));
    const audio = await Promise.all(manifest.audioSourceDescriptors.map((descriptor) => (
        resolveEditorAudioAsset(reader, descriptor)
    )));
    return {
        videoSources: video.map((result) => result.asset),
        audioSources: audio.map((result) => result.asset),
        legacyResolvedAssetKeys: video.filter((result) => !result.usesTypedKey).map((result) => result.storageKey),
    };
}

function validateResolvedFile(
    value: unknown,
    descriptor: Pick<VideoSourceDescriptorV3, 'id' | 'originalName' | 'mimeType' | 'size' | 'lastModified' | 'fingerprint'>,
    storageKey: string,
): File {
    if (!isFileLike(value)) {
        throw new Error(`Stored asset "${storageKey}" for source "${descriptor.id}" is not a File.`);
    }
    const fingerprintMatches = doesVideoSourceFingerprintMatch(descriptor.fingerprint, {
        name: value.name,
        type: value.type,
        size: value.size,
        lastModified: value.lastModified,
    });
    if (
        value.name !== descriptor.originalName
        || value.type !== descriptor.mimeType
        || value.size !== descriptor.size
        || value.lastModified !== descriptor.lastModified
        || !fingerprintMatches
    ) {
        throw new Error(`Stored asset "${storageKey}" does not match source descriptor "${descriptor.id}".`);
    }
    return value;
}

function isFileLike(value: unknown): value is File {
    return typeof value === 'object'
        && value !== null
        && 'name' in value
        && typeof value.name === 'string'
        && 'type' in value
        && typeof value.type === 'string'
        && 'size' in value
        && typeof value.size === 'number'
        && 'lastModified' in value
        && typeof value.lastModified === 'number';
}
