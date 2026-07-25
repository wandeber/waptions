import { MediaBudgetManager } from './budget-manager';
import { MEDIA_READ_CHUNK_BYTES } from './types';

const MIB = 1024 * 1024;

export const MEDIA_PCM_WINDOW_BYTES = 8 * MIB;
export const MEDIA_COMPRESSED_STAGING_BYTES = 32 * MIB;

export function getAdaptiveDecodedPixelBudgetBytes(deviceMemory?: number): number {
    if (deviceMemory !== undefined && deviceMemory <= 2) return 96 * MIB;
    if (deviceMemory !== undefined && deviceMemory >= 8) return 384 * MIB;
    return 192 * MIB;
}

export interface MediaRuntimeBudgets {
    readonly decodedPixels: MediaBudgetManager;
    readonly compressedBytes: MediaBudgetManager;
    readonly pcmBytes: MediaBudgetManager;
    /** Admission-only cap that preserves one maximum-size compressed read slot. */
    readonly mediabunnyCacheAdmissions: MediaBudgetManager;
}

export function createMediaRuntimeBudgets(options: {
    decodedPixelBytes?: number;
    compressedBytes?: number;
    pcmBytes?: number;
    mediabunnyCacheAdmissionBytes?: number;
    deviceMemory?: number;
} = {}): MediaRuntimeBudgets {
    const compressedBytes = options.compressedBytes ?? MEDIA_COMPRESSED_STAGING_BYTES;
    return Object.freeze({
        decodedPixels: new MediaBudgetManager(
            'decoded-pixels',
            options.decodedPixelBytes ?? getAdaptiveDecodedPixelBudgetBytes(options.deviceMemory),
        ),
        compressedBytes: new MediaBudgetManager(
            'compressed-byte-staging',
            compressedBytes,
        ),
        pcmBytes: new MediaBudgetManager('pcm-window', options.pcmBytes ?? MEDIA_PCM_WINDOW_BYTES),
        mediabunnyCacheAdmissions: new MediaBudgetManager(
            'mediabunny-cache-admission',
            options.mediabunnyCacheAdmissionBytes
                ?? Math.max(1, compressedBytes - MEDIA_READ_CHUNK_BYTES),
        ),
    });
}

function getBrowserDeviceMemory(): number | undefined {
    if (typeof navigator === 'undefined') return undefined;
    return (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
}

export const mediaRuntimeBudgets = createMediaRuntimeBudgets({
    deviceMemory: getBrowserDeviceMemory(),
});

/** Process-wide decoded memory budget shared by preview, render, and managed review jobs. */
export const globalDecodedMemoryBudget = mediaRuntimeBudgets.decodedPixels;
export type GlobalDecodedMemoryBudget = MediaBudgetManager;
