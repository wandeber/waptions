import type { ExportOptions } from '@/types/export';
import type { EditorDocumentV3 } from '@/types/video';
import { calculateActiveTimelineBitrate } from './export-bitrate';
import { framesToSeconds } from './render-profile';
import { getTimelineContentEndFrame } from './video-timeline';

const EXPORT_CONTAINER_OVERHEAD_MULTIPLIER = 1.12;
const EXPORT_CONTAINER_FIXED_OVERHEAD_BYTES = 2 * 1024 * 1024;
const EXPORT_AUDIO_BITRATE = 128_000;

const QUALITY_BITRATE_MULTIPLIERS = {
    low: 0.5,
    medium: 0.8,
    high: 1.2,
    very_high: 2,
} as const;

/** Exact exclusive content boundary shared by the timeline, playback, and export. */
export function getExportContentEndFrame(document: EditorDocumentV3): number {
    return getTimelineContentEndFrame(document.videoClips, document.subtitleTracks, {
        renderProfile: document.renderProfile,
        videoSources: document.videoSources,
        audioSources: document.audioSources,
        audioTracks: document.audioTracks,
    });
}

/**
 * Selects the encoded video bitrate from the active, trimmed program rather than imported media
 * that never appears on the timeline. The lower and upper guards prevent pathological metadata
 * from producing either an unusable stream or an unexpectedly huge allocation.
 */
export function calculateExportVideoBitrate(
    document: EditorDocumentV3,
    quality: ExportOptions['quality'],
): number {
    const { width, height } = document.renderProfile;
    const sourceBitrate = calculateActiveTimelineBitrate(
        document.videoSources,
        document.videoClips,
    );
    const baseBitrate = width * height / (1920 * 1080) * 10_000_000;
    return Math.round(Math.max(
        Math.max(500_000, baseBitrate * 0.2),
        Math.min(
            Math.max(50_000_000, baseBitrate * 5),
            sourceBitrate * QUALITY_BITRATE_MULTIPLIERS[quality],
        ),
    ));
}

/** Conservative preflight used only to decide whether the bounded memory fallback is safe. */
export function estimateExportOutputBytes(
    document: EditorDocumentV3,
    options: Pick<ExportOptions, 'quality' | 'includeAudio'>,
): number {
    const duration = framesToSeconds(
        getExportContentEndFrame(document),
        document.renderProfile.fps,
    );
    const bitsPerSecond = calculateExportVideoBitrate(document, options.quality)
        + (options.includeAudio === false ? 0 : EXPORT_AUDIO_BITRATE);
    return Math.ceil(
        bitsPerSecond * duration / 8 * EXPORT_CONTAINER_OVERHEAD_MULTIPLIER
        + EXPORT_CONTAINER_FIXED_OVERHEAD_BYTES,
    );
}

/**
 * Captures one detached export graph before the first asynchronous operation.
 *
 * Files are immutable browser handles and deliberately retain identity. Everything else is
 * recursively cloned and frozen, so timeline mutations made while a long export is running cannot
 * change later frames, audio contributors, subtitle tails, or render-profile boundaries.
 */
export function createExportDocumentSnapshot(document: EditorDocumentV3): EditorDocumentV3 {
    return cloneAndFreeze(document) as EditorDocumentV3;
}

/** Reports only finite, clamped, monotonic progress values. */
export function createExportProgressReporter(
    onProgress?: (progress: number) => void,
): (progress: number) => void {
    let lastProgress = 0;
    return (progress) => {
        if (!Number.isFinite(progress)) return;
        lastProgress = Math.max(lastProgress, Math.min(1, Math.max(0, progress)));
        onProgress?.(lastProgress);
    };
}

export function createExportAbortError(message = 'Export was cancelled.'): Error {
    if (typeof DOMException !== 'undefined') return new DOMException(message, 'AbortError');
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

export function throwIfExportAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw createExportAbortError();
}

/**
 * Rejects immediately when a signal fires while an API without native AbortSignal support is
 * pending. The wrapped operation is still observed, which prevents a late rejection from becoming
 * an unhandled promise after the export job has already completed its cleanup.
 */
export async function awaitExportPhase<T>(
    operation: Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    throwIfExportAborted(signal);
    if (!signal) return operation;
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const settle = (callback: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', abort);
            callback();
        };
        const abort = () => settle(() => reject(createExportAbortError()));
        signal.addEventListener('abort', abort, { once: true });
        operation.then(
            (value) => settle(() => resolve(value)),
            (error: unknown) => settle(() => reject(error)),
        );
    });
}

export function isExportAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

function cloneAndFreeze(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    // File instances expose internal browser slots that cannot be reproduced by enumerating
    // properties. Their byte content is immutable, so sharing the handle is snapshot-safe.
    if (typeof File !== 'undefined' && value instanceof File) return value;
    if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));

    const clone: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) clone[key] = cloneAndFreeze(nested);
    return Object.freeze(clone);
}
