import type { AudioSourceAsset, VideoSourceAsset } from '@/types/video';
import { inspectMediaTracks, type MediaInspectionInputFactory } from './mediabunny-utils';
import {
    createAudioSourceAsset,
    getAudioSourceMetadataFromInspection,
} from './audio-source';
import {
    createVideoSourceAsset,
    getVideoSourceMetadataFromInspection,
} from './video-source';

export type MediaImportCandidateKind = 'video' | 'audio' | 'unknown';
export type InspectedMediaKind = 'video' | 'audio' | 'unsupported';

export interface MediaImportDiagnostic {
    code: 'candidate-mismatch' | 'no-primary-media-track';
    message: string;
    candidateKind: MediaImportCandidateKind;
    inspectedKind: InspectedMediaKind;
}

export type InspectedMediaFile =
    | {
        kind: 'video';
        file: File;
        candidateKind: MediaImportCandidateKind;
        diagnostics: MediaImportDiagnostic[];
        source: VideoSourceAsset;
    }
    | {
        kind: 'audio';
        file: File;
        candidateKind: MediaImportCandidateKind;
        diagnostics: MediaImportDiagnostic[];
        source: AudioSourceAsset;
    }
    | {
        kind: 'unsupported';
        file: File;
        candidateKind: MediaImportCandidateKind;
        diagnostics: MediaImportDiagnostic[];
    };

export interface FailedMediaInspection {
    kind: 'failed';
    file: File;
    candidateKind: MediaImportCandidateKind;
    error: Error;
}

export type MediaBatchItem = InspectedMediaFile | FailedMediaInspection;

export interface InspectMediaFileOptions {
    sourceId?: string;
    idFactory?: () => string;
    sourceIdFactory?: (kind: Exclude<InspectedMediaKind, 'unsupported'>) => string;
    /** Test seam for deterministic track inspection without browser decoders. */
    inputFactory?: MediaInspectionInputFactory;
}

export interface InspectMediaBatchOptions {
    sourceIdFactory?: (
        kind: Exclude<InspectedMediaKind, 'unsupported'>,
        file: File,
        index: number,
    ) => string;
    inputFactory?: MediaInspectionInputFactory;
}

export interface InspectedMediaBatch {
    items: MediaBatchItem[];
    videoSources: VideoSourceAsset[];
    audioSources: AudioSourceAsset[];
    firstValidVideo: VideoSourceAsset | null;
    failures: FailedMediaInspection[];
}

const VIDEO_EXTENSIONS = new Set([
    'avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'webm',
]);
const AUDIO_EXTENSIONS = new Set([
    'aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'weba',
]);
const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/**
 * Provides an inexpensive import hint only. The hint must never be treated as proof because
 * drag-and-drop sources frequently omit MIME metadata and file extensions can be misleading.
 */
export function classifyMediaImportCandidate(file: Pick<File, 'name' | 'type'>): MediaImportCandidateKind {
    const mimeType = file.type.split(';', 1)[0].trim().toLowerCase();
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (!GENERIC_MIME_TYPES.has(mimeType)) return 'unknown';

    const extension = file.name.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? '';
    if (VIDEO_EXTENSIONS.has(extension)) return 'video';
    if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
    return 'unknown';
}

/**
 * Inspects primary container tracks before constructing an asset. Primary video is
 * authoritative for mixed A/V containers; primary audio is selected only when no video
 * track exists. This function builds values but deliberately performs no store mutation.
 */
export async function inspectMediaFile(
    file: File,
    options: InspectMediaFileOptions = {},
): Promise<InspectedMediaFile> {
    const candidateKind = classifyMediaImportCandidate(file);
    const inspection = await inspectMediaTracks(file, options.inputFactory);
    const inspectedKind: InspectedMediaKind = inspection.video
        ? 'video'
        : inspection.audio
            ? 'audio'
            : 'unsupported';
    const diagnostics: MediaImportDiagnostic[] = [];

    if (candidateKind !== 'unknown' && candidateKind !== inspectedKind) {
        diagnostics.push({
            code: 'candidate-mismatch',
            message: `File metadata suggested ${candidateKind}, but primary tracks identify ${inspectedKind}.`,
            candidateKind,
            inspectedKind,
        });
    }
    if (inspectedKind === 'unsupported') {
        diagnostics.push({
            code: 'no-primary-media-track',
            message: 'The container has neither a primary video track nor a primary audio track.',
            candidateKind,
            inspectedKind,
        });
        return { kind: 'unsupported', file, candidateKind, diagnostics };
    }

    const assetOptions = {
        sourceId: options.sourceId ?? options.sourceIdFactory?.(inspectedKind),
        idFactory: options.idFactory,
    };
    if (inspectedKind === 'video') {
        return {
            kind: 'video',
            file,
            candidateKind,
            diagnostics,
            source: createVideoSourceAsset(
                file,
                getVideoSourceMetadataFromInspection(file, inspection),
                assetOptions,
            ),
        };
    }
    return {
        kind: 'audio',
        file,
        candidateKind,
        diagnostics,
        source: createAudioSourceAsset(
            file,
            getAudioSourceMetadataFromInspection(inspection),
            assetOptions,
        ),
    };
}

/**
 * Inspects every selected file, preserving input order and isolating malformed files. The
 * first valid video is derived from successful results rather than from the first FileList
 * entry, so audio-first and unsupported-first batches can still establish a video project.
 */
export async function inspectMediaBatch(
    files: readonly File[],
    options: InspectMediaBatchOptions = {},
): Promise<InspectedMediaBatch> {
    const items: MediaBatchItem[] = [];
    for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const candidateKind = classifyMediaImportCandidate(file);
        try {
            const item = await inspectMediaFile(file, {
                inputFactory: options.inputFactory,
                sourceIdFactory: options.sourceIdFactory
                    ? (kind) => options.sourceIdFactory!(kind, file, index)
                    : undefined,
            });
            items.push(item);
        } catch (caught) {
            items.push({
                kind: 'failed',
                file,
                candidateKind,
                error: caught instanceof Error ? caught : new Error(String(caught)),
            });
        }
    }

    const videoSources = items.flatMap((item) => item.kind === 'video' ? [item.source] : []);
    const audioSources = items.flatMap((item) => item.kind === 'audio' ? [item.source] : []);
    const failures = items.filter((item): item is FailedMediaInspection => item.kind === 'failed');
    return {
        items,
        videoSources,
        audioSources,
        firstValidVideo: videoSources[0] ?? null,
        failures,
    };
}
