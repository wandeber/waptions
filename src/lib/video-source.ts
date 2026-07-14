import type { VideoClip, VideoSourceAsset } from '@/types/video';
import { getVideoInfo, type MediaTrackInspection } from '@/lib/mediabunny-utils';
import {
    createImmutableVideoSourceFingerprint,
    doesVideoSourceFingerprintMatch,
    getImportedSourceEnd,
    isSafeVideoId,
    type VideoFingerprintInput,
} from '@/lib/video-timeline';

export interface InspectVideoSourceOptions {
    sourceId?: string;
    idFactory?: () => string;
}

export type MediaSourceFingerprintInput = VideoFingerprintInput;

/**
 * Shared video/audio import fingerprint. New imports receive a persisted nonce while validators
 * continue accepting deterministic v1 fingerprints from older project formats.
 */
export const createMediaSourceFingerprint = createImmutableVideoSourceFingerprint;
export const doesMediaSourceFingerprintMatch = doesVideoSourceFingerprintMatch;

export interface VideoSourceInspectionMetadata {
    duration: number;
    width: number;
    height: number;
    fps: number;
    bitrate: number;
    hasAudio: boolean;
}

export function getVideoSourceMetadataFromInspection(
    file: File,
    inspection: MediaTrackInspection,
): VideoSourceInspectionMetadata {
    if (!inspection.video) {
        throw new Error('No video track found in the file');
    }
    return {
        duration: inspection.duration,
        width: inspection.video.width,
        height: inspection.video.height,
        fps: inspection.video.fps,
        // Preserve the existing descriptor definition: video bitrate represents the average
        // container payload rate, not only the primary video track packet rate.
        bitrate: inspection.duration > 0
            ? Math.round((file.size * 8) / inspection.duration)
            : 0,
        hasAudio: inspection.audio !== null,
    };
}

export function createVideoSourceAsset(
    file: File,
    metadata: VideoSourceInspectionMetadata,
    options: InspectVideoSourceOptions = {},
): VideoSourceAsset {
    const id = options.sourceId ?? options.idFactory?.() ?? crypto.randomUUID();
    if (!isSafeVideoId(id)) {
        throw new Error(`Video source ID "${id}" is not safe.`);
    }

    return {
        id,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: createMediaSourceFingerprint(file),
        duration: metadata.duration,
        fps: metadata.fps,
        width: metadata.width,
        height: metadata.height,
        bitrate: metadata.bitrate,
        hasAudio: metadata.hasAudio,
        file,
    };
}

/**
 * Inspects an imported file once and builds the canonical source asset used by
 * persistence, preview, transcription, and export.
 */
export async function inspectVideoSource(
    file: File,
    options: InspectVideoSourceOptions = {},
): Promise<VideoSourceAsset> {
    const metadata = await getVideoInfo(file);
    return createVideoSourceAsset(file, metadata, options);
}

/** Creates the deterministic full-length clip appended for a newly imported source. */
export function createFullSourceClip(
    source: VideoSourceAsset,
    projectFps: number,
    clipId = crypto.randomUUID(),
): VideoClip {
    if (!isSafeVideoId(clipId)) {
        throw new Error(`Video clip ID "${clipId}" is not safe.`);
    }
    return {
        id: clipId,
        sourceId: source.id,
        sourceStart: 0,
        sourceEnd: getImportedSourceEnd(source.duration, projectFps),
    };
}
