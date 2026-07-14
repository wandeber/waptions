import type { AudioSourceAsset, ImportedAudioClip } from '@/types/video';
import { getAudioInfo, type MediaTrackInspection } from '@/lib/mediabunny-utils';
import { createMediaSourceFingerprint } from '@/lib/video-source';
import { isSafeVideoId } from '@/lib/video-timeline';

export interface InspectAudioSourceOptions {
    sourceId?: string;
    idFactory?: () => string;
}

export interface AudioSourceInspectionMetadata {
    duration: number;
    sampleRate: number;
    numberOfChannels: number;
    codec: string | null;
    bitrate: number | null;
}

export function getAudioSourceMetadataFromInspection(
    inspection: MediaTrackInspection,
): AudioSourceInspectionMetadata {
    if (!inspection.audio) {
        throw new Error('No audio track found in the file');
    }
    return {
        duration: inspection.duration,
        sampleRate: inspection.audio.sampleRate,
        numberOfChannels: inspection.audio.numberOfChannels,
        codec: inspection.audio.codec,
        bitrate: inspection.audio.bitrate,
    };
}

export function createAudioSourceAsset(
    file: File,
    metadata: AudioSourceInspectionMetadata,
    options: InspectAudioSourceOptions = {},
): AudioSourceAsset {
    const id = options.sourceId ?? options.idFactory?.() ?? crypto.randomUUID();
    if (!isSafeVideoId(id)) {
        throw new Error(`Audio source ID "${id}" is not safe.`);
    }
    if (!Number.isFinite(metadata.duration) || metadata.duration < 0) {
        throw new Error('Audio duration must be non-negative and finite.');
    }
    if (!Number.isSafeInteger(metadata.sampleRate) || metadata.sampleRate <= 0) {
        throw new Error('Audio sample rate must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(metadata.numberOfChannels) || metadata.numberOfChannels <= 0) {
        throw new Error('Audio channel count must be a positive safe integer.');
    }

    const nativeSampleCount = Math.max(1, Math.round(metadata.duration * metadata.sampleRate));
    if (!Number.isSafeInteger(nativeSampleCount)) {
        throw new Error('Audio sample count exceeds the safe integer range.');
    }
    const roundedBitrate = metadata.bitrate === null ? null : Math.round(metadata.bitrate);
    const bitrate = roundedBitrate !== null
        && Number.isSafeInteger(roundedBitrate)
        && roundedBitrate >= 0
        ? roundedBitrate
        : null;

    return {
        id,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: createMediaSourceFingerprint(file),
        // Persist duration from the same integer clock used by crop bounds. Container-reported
        // duration can fall between native sample boundaries; canonicalizing it prevents the
        // descriptor duration and full-length clip from disagreeing by a fractional sample.
        duration: nativeSampleCount / metadata.sampleRate,
        nativeSampleRate: metadata.sampleRate,
        // Even an empty or metadata-only container receives a one-sample crop domain. This
        // matches the editor graph invariant and prevents zero-width full-source clips.
        nativeSampleCount,
        nativeChannelCount: metadata.numberOfChannels,
        bitrate,
        codec: metadata.codec,
        file,
    };
}

export async function inspectAudioSource(
    file: File,
    options: InspectAudioSourceOptions = {},
): Promise<AudioSourceAsset> {
    const metadata = await getAudioInfo(file);
    return createAudioSourceAsset(file, metadata, options);
}

/** Creates a full-length independently editable clip for an imported audio source. */
export function createFullLengthImportedAudioClip(
    source: AudioSourceAsset,
    timelineStartFrame: number,
    clipId = crypto.randomUUID(),
): ImportedAudioClip {
    if (!isSafeVideoId(clipId)) {
        throw new Error(`Audio clip ID "${clipId}" is not safe.`);
    }
    if (!Number.isInteger(timelineStartFrame) || timelineStartFrame < 0) {
        throw new Error('Audio clip placement must be a non-negative integer frame.');
    }
    return {
        id: clipId,
        source: { kind: 'audio-source', audioSourceId: source.id },
        timelineStartFrame,
        sourceStartSample: 0,
        sourceEndSample: source.nativeSampleCount,
        muted: false,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
    };
}
