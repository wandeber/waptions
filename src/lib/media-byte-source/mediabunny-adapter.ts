import { StreamSource, type Source } from 'mediabunny';
import type { MediaBudgetLease, MediaBudgetManager } from './budget-manager';
import { BlobMediaByteSource } from './blob-source';
import { mediaRuntimeBudgets } from './budgets';
import {
    isMediaByteSource,
    type MediaByteSource,
    type MediaByteSourceInput,
} from './types';

export const MEDIABUNNY_SOURCE_CACHE_BYTES = 8 * 1024 * 1024;

export interface MediabunnyByteSourceHandle {
    readonly source: Source;
    readonly byteSource: MediaByteSource;
    readonly cacheBytes: number;
    /** Releases a handle that was acquired but not transferred into an Input. */
    dispose(): Promise<void>;
    whenDisposed(): Promise<void>;
}

interface MediabunnyAdapterOptions {
    readonly cacheBytes?: number;
    readonly cacheBudget?: MediaBudgetManager;
    readonly cacheAdmissionBudget?: MediaBudgetManager;
    readonly signal?: AbortSignal;
}

/**
 * Adapts random, bounded MediaByteSource reads to Mediabunny without materializing
 * the complete media file. This synchronous compatibility path deliberately disables
 * Mediabunny's private cache; production callers should use the admitted async factory.
 */
export function createMediabunnyByteSource(input: MediaByteSourceInput): MediabunnyByteSourceHandle {
    return buildMediabunnyByteSource(input, [], 0);
}

/**
 * Reserves the complete per-Input cache before exposing a StreamSource. The lease is held until
 * Input.dispose() invokes StreamSource.dispose, so aggregate cache capacity cannot exceed the
 * process-wide compressed-byte budget.
 */
export async function acquireMediabunnyByteSource(
    input: MediaByteSourceInput,
    options: MediabunnyAdapterOptions = {},
): Promise<MediabunnyByteSourceHandle> {
    const cacheBytes = options.cacheBytes ?? MEDIABUNNY_SOURCE_CACHE_BYTES;
    const cacheBudget = options.cacheBudget ?? mediaRuntimeBudgets.compressedBytes;
    const admissionBudget = options.cacheAdmissionBudget
        ?? mediaRuntimeBudgets.mediabunnyCacheAdmissions;
    const admission = await admissionBudget.reserve(cacheBytes, {
        label: 'mediabunny-stream-cache-admission',
        signal: options.signal,
    });
    const admissionLease = admission.commit();
    try {
        const reservation = await cacheBudget.reserve(cacheBytes, {
            label: 'mediabunny-stream-cache',
            signal: options.signal,
        });
        return buildMediabunnyByteSource(
            input,
            [admissionLease, reservation.commit()],
            cacheBytes,
        );
    } catch (error) {
        admissionLease.release();
        throw error;
    }
}

export async function createAdmittedMediabunnyInput<T>(
    input: MediaByteSourceInput,
    createInput: (source: Source) => T,
    options: MediabunnyAdapterOptions = {},
): Promise<T> {
    const handle = await acquireMediabunnyByteSource(input, options);
    try {
        return createInput(handle.source);
    } catch (error) {
        await handle.dispose();
        throw error;
    }
}

function buildMediabunnyByteSource(
    input: MediaByteSourceInput,
    cacheLeases: readonly MediaBudgetLease[],
    cacheBytes: number,
): MediabunnyByteSourceHandle {
    const ownsByteSource = !isMediaByteSource(input);
    const byteSource = ownsByteSource ? new BlobMediaByteSource(input) : input;
    let disposed = false;
    let resolveDisposed!: () => void;
    let rejectDisposed!: (error: unknown) => void;
    const disposedPromise = new Promise<void>((resolve, reject) => {
        resolveDisposed = resolve;
        rejectDisposed = reject;
    });
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const lease of cacheLeases) lease.release();
        Promise.resolve(ownsByteSource ? byteSource.close() : undefined)
            .then(resolveDisposed, rejectDisposed);
    };

    let source: StreamSource;
    try {
        source = new StreamSource({
            getSize: () => byteSource.size(),
            read: (start, end) => byteSource.read({ start, endExclusive: end }),
            dispose,
            maxCacheSize: cacheBytes,
            prefetchProfile: cacheBytes > 0 && ownsByteSource ? 'fileSystem' : 'none',
        });
    } catch (error) {
        dispose();
        throw error;
    }
    return {
        byteSource,
        cacheBytes,
        dispose: async () => {
            dispose();
            return disposedPromise;
        },
        whenDisposed: () => disposedPromise,
        source,
    };
}
