import {
    getWaveformRepositoryKey,
    type AudioMediaAsset,
    type WaveformRepositoryKey,
} from '@/lib/media-asset-ref';
import { runtimeDiagnostics } from '@/lib/runtime-diagnostics';
import {
    BestEffortWaveformCache,
    type WaveformPersistentCache,
} from '@/lib/storage/waveform-cache';
import { extractWaveformPeaksInWorker } from '@/lib/video-waveform-client';
import {
    estimateWaveformPeaksBytes,
    getWaveformBucketCount,
    WAVEFORM_PEAK_ALGORITHM_VERSION,
    type WaveformPeaks,
} from '@/lib/video-waveform';
import { isImmutableVideoSourceFingerprint } from '@/lib/video-timeline';

export const DEFAULT_MEMORY_WAVEFORM_CACHE_BYTES = 32 * 1024 * 1024;

export interface WaveformRepositoryRequestOptions {
    signal?: AbortSignal;
    onProgress?: (peaks: WaveformPeaks) => void;
}

export type WaveformRepositoryExtractor = (
    file: File,
    duration: number,
    signal: AbortSignal,
    onProgress: (peaks: WaveformPeaks) => void,
) => Promise<WaveformPeaks | null>;

export interface WaveformRepositoryOptions {
    memoryMaxBytes?: number;
    persistentCache?: WaveformPersistentCache;
    extract?: WaveformRepositoryExtractor;
    now?: () => number;
    legacyIdentityFactory?: () => string;
}

interface MemoryWaveformEntry {
    peaks: WaveformPeaks;
    bytes: number;
    lastAccess: number;
}

interface WaveformSubscriber {
    signal?: AbortSignal;
    abortListener?: () => void;
    onProgress?: (peaks: WaveformPeaks) => void;
    resolve: (peaks: WaveformPeaks | null) => void;
    reject: (error: unknown) => void;
}

interface InFlightWaveform {
    key: WaveformRepositoryKey;
    controller: AbortController;
    subscribers: Map<number, WaveformSubscriber>;
}

const defaultExtractor: WaveformRepositoryExtractor = (
    file,
    duration,
    signal,
    onProgress,
) => extractWaveformPeaksInWorker(file, duration, signal, undefined, onProgress);

/**
 * Owns all waveform caching and decoder coordination across editor components.
 *
 * Repository keys describe immutable derived data, not project identities. One worker therefore
 * serves duplicate subscribers across panes or projects, while each subscriber keeps independent
 * cancellation: leaving one viewport does not terminate work still needed by another viewport.
 */
export class WaveformRepository {
    private readonly memoryMaxBytes: number;
    private readonly persistentCache: WaveformPersistentCache;
    private readonly extract: WaveformRepositoryExtractor;
    private readonly now: () => number;
    private readonly legacyIdentityFactory: () => string;
    private readonly legacyFileIdentities = new WeakMap<File, string>();
    private readonly memory = new Map<WaveformRepositoryKey, MemoryWaveformEntry>();
    private readonly inFlight = new Map<WaveformRepositoryKey, InFlightWaveform>();
    private memoryBytes = 0;
    private accessCounter = 0;
    private subscriberCounter = 0;

    constructor(options: WaveformRepositoryOptions = {}) {
        this.memoryMaxBytes = options.memoryMaxBytes ?? DEFAULT_MEMORY_WAVEFORM_CACHE_BYTES;
        if (!Number.isFinite(this.memoryMaxBytes) || this.memoryMaxBytes < 0) {
            throw new Error('Waveform memory cache cap must be non-negative and finite.');
        }
        this.persistentCache = options.persistentCache ?? new BestEffortWaveformCache();
        this.extract = options.extract ?? defaultExtractor;
        this.now = options.now ?? (() => (
            typeof performance !== 'undefined' ? performance.now() : Date.now()
        ));
        this.legacyIdentityFactory = options.legacyIdentityFactory ?? (() => crypto.randomUUID());
    }

    getKey(media: AudioMediaAsset): WaveformRepositoryKey {
        let fingerprint = media.asset.fingerprint;
        if (!isImmutableVideoSourceFingerprint(fingerprint)) {
            let sessionIdentity = this.legacyFileIdentities.get(media.asset.file);
            if (!sessionIdentity) {
                sessionIdentity = this.legacyIdentityFactory();
                this.legacyFileIdentities.set(media.asset.file, sessionIdentity);
            }
            // Legacy v1 descriptors contain only metadata. Scoping them to this File object avoids
            // returning another project's peaks; the tradeoff is deliberately no persistent hit
            // until the owning storage migration persists its project-scoped v2 identity.
            fingerprint = `${fingerprint}:legacy-session:${sessionIdentity}`;
        }
        return getWaveformRepositoryKey(
            media,
            WAVEFORM_PEAK_ALGORITHM_VERSION,
            getWaveformBucketCount(media.asset.duration),
            fingerprint,
        );
    }

    /** Returns a synchronous memory hit for first-paint snapshots without starting any work. */
    peek(media: AudioMediaAsset, updateRecency = true): WaveformPeaks | null {
        const entry = this.memory.get(this.getKey(media));
        if (!entry) return null;
        if (updateRecency) {
            this.accessCounter += 1;
            entry.lastAccess = this.accessCounter;
        }
        return entry.peaks;
    }

    request(
        media: AudioMediaAsset,
        options: WaveformRepositoryRequestOptions = {},
    ): Promise<WaveformPeaks | null> {
        runtimeDiagnostics.increment('waveform', 'requests');
        if (options.signal?.aborted) {
            runtimeDiagnostics.increment('waveform', 'aborts');
            return Promise.resolve(null);
        }

        const key = this.getKey(media);
        const memoryHit = this.memory.get(key);
        if (memoryHit) {
            this.accessCounter += 1;
            memoryHit.lastAccess = this.accessCounter;
            runtimeDiagnostics.increment('waveform', 'cacheHits');
            return Promise.resolve(memoryHit.peaks);
        }

        let operation = this.inFlight.get(key);
        let shouldStart = false;
        if (!operation || operation.controller.signal.aborted) {
            operation = {
                key,
                controller: new AbortController(),
                subscribers: new Map(),
            };
            this.inFlight.set(key, operation);
            runtimeDiagnostics.setGauge('waveform', 'inFlight', this.inFlight.size);
            shouldStart = true;
        }
        // Attach the first subscriber before starting even an async operation. An injected cache
        // is allowed to fail synchronously; starting first could otherwise settle an empty
        // operation and leave the subsequently attached promise unresolved forever.
        const subscription = this.subscribe(operation, options);
        if (shouldStart) void this.runOperation(operation, media);
        return subscription;
    }

    getDebugState(): Readonly<{ memoryBytes: number; memoryEntries: number; inFlight: number }> {
        return {
            memoryBytes: this.memoryBytes,
            memoryEntries: this.memory.size,
            inFlight: this.inFlight.size,
        };
    }

    private subscribe(
        operation: InFlightWaveform,
        options: WaveformRepositoryRequestOptions,
    ): Promise<WaveformPeaks | null> {
        return new Promise((resolve, reject) => {
            const subscriberId = ++this.subscriberCounter;
            const subscriber: WaveformSubscriber = {
                signal: options.signal,
                onProgress: options.onProgress,
                resolve,
                reject,
            };
            const abort = () => {
                if (!operation.subscribers.delete(subscriberId)) return;
                options.signal?.removeEventListener('abort', abort);
                runtimeDiagnostics.increment('waveform', 'aborts');
                resolve(null);
                if (operation.subscribers.size === 0) {
                    // The shared worker remains alive while any subscriber needs it. Once the last
                    // one leaves, remove the operation immediately so a later request cannot join
                    // an already-aborted decoder generation.
                    operation.controller.abort();
                    if (this.inFlight.get(operation.key) === operation) {
                        this.inFlight.delete(operation.key);
                        runtimeDiagnostics.setGauge('waveform', 'inFlight', this.inFlight.size);
                    }
                }
            };
            subscriber.abortListener = abort;
            operation.subscribers.set(subscriberId, subscriber);
            options.signal?.addEventListener('abort', abort, { once: true });
        });
    }

    private async runOperation(
        operation: InFlightWaveform,
        media: AudioMediaAsset,
    ): Promise<void> {
        let result: WaveformPeaks | null = null;
        let failure: unknown;
        let persistResult: WaveformPeaks | null = null;
        const expectedBucketCount = getWaveformBucketCount(media.asset.duration);
        const lookupStartedAt = this.now();
        try {
            const isPersistentIdentity = isImmutableVideoSourceFingerprint(media.asset.fingerprint);
            let persistent: WaveformPeaks | null = null;
            if (isPersistentIdentity) {
                try {
                    persistent = await this.persistentCache.get(operation.key);
                } catch {
                    // Persistence is an optional derived-data optimization. A custom or future
                    // cache implementation that throws still degrades to a decoder miss.
                }
            }
            runtimeDiagnostics.observeTiming(
                'waveform',
                'lookup',
                Math.max(0, this.now() - lookupStartedAt),
            );
            if (operation.controller.signal.aborted) return;

            if (persistent && this.matchesRequest(persistent, media.asset.duration, expectedBucketCount)) {
                runtimeDiagnostics.increment('waveform', 'cacheHits');
                runtimeDiagnostics.increment('waveform', 'persistentHits');
                this.storeInMemory(operation.key, persistent);
                result = persistent;
                return;
            }

            runtimeDiagnostics.increment('waveform', 'cacheMisses');
            runtimeDiagnostics.increment('waveform', 'decoderStarts');
            const extractionStartedAt = this.now();
            result = await this.extract(
                media.asset.file,
                media.asset.duration,
                operation.controller.signal,
                (progressPeaks) => {
                    if (operation.controller.signal.aborted) return;
                    if (!this.matchesRequest(progressPeaks, media.asset.duration, expectedBucketCount)) {
                        return;
                    }
                    operation.subscribers.forEach((subscriber) => {
                        if (subscriber.signal?.aborted) return;
                        try {
                            subscriber.onProgress?.(progressPeaks);
                        } catch (error) {
                            console.error('Failed to publish repository waveform progress:', error);
                        }
                    });
                },
            );
            runtimeDiagnostics.observeTiming(
                'waveform',
                'extraction',
                Math.max(0, this.now() - extractionStartedAt),
            );
            if (operation.controller.signal.aborted || !result) {
                result = null;
                return;
            }
            if (!this.matchesRequest(result, media.asset.duration, expectedBucketCount)) {
                throw new Error('Waveform decoder returned peaks for an unexpected resolution.');
            }
            this.storeInMemory(operation.key, result);
            if (isPersistentIdentity) {
                persistResult = result;
            }
        } catch (error) {
            if (!operation.controller.signal.aborted) {
                runtimeDiagnostics.increment('waveform', 'failures');
                failure = error;
            }
        } finally {
            if (this.inFlight.get(operation.key) === operation) {
                this.inFlight.delete(operation.key);
                runtimeDiagnostics.setGauge('waveform', 'inFlight', this.inFlight.size);
            }
            operation.subscribers.forEach((subscriber) => {
                if (subscriber.abortListener) {
                    subscriber.signal?.removeEventListener('abort', subscriber.abortListener);
                }
                if (failure !== undefined) subscriber.reject(failure);
                else subscriber.resolve(result);
            });
            operation.subscribers.clear();
            const peaksToPersist = persistResult;
            if (peaksToPersist) {
                // The decoder operation and subscribers are settled before optional persistence
                // starts in an independent microtask, so IndexedDB completion is never on their
                // critical path and cannot keep the operation marked in-flight.
                queueMicrotask(() => {
                    try {
                        void this.persistentCache.put(operation.key, peaksToPersist)
                            .catch(() => {
                                // Observe quota/blocked failures so optional derived persistence
                                // can never produce an unhandled rejection.
                            });
                    } catch {
                        // A cache may throw before returning its Promise. Decoded memory peaks have
                        // already been delivered and remain valid.
                    }
                });
            }
        }
    }

    private matchesRequest(
        peaks: WaveformPeaks,
        duration: number,
        bucketCount: number,
    ): boolean {
        return peaks.duration === duration
            && Number.isFinite(peaks.sampleRate)
            && peaks.sampleRate > 0
            && peaks.bucketCount === bucketCount
            && peaks.min instanceof Float32Array
            && peaks.max instanceof Float32Array
            && peaks.min.length === bucketCount
            && peaks.max.length === bucketCount;
    }

    private storeInMemory(key: WaveformRepositoryKey, peaks: WaveformPeaks): void {
        const bytes = estimateWaveformPeaksBytes(peaks);
        const existing = this.memory.get(key);
        if (existing) {
            this.memory.delete(key);
            this.memoryBytes -= existing.bytes;
        }
        if (bytes > this.memoryMaxBytes) {
            runtimeDiagnostics.setGauge('waveform', 'memoryBytes', this.memoryBytes);
            return;
        }

        this.accessCounter += 1;
        this.memory.set(key, { peaks, bytes, lastAccess: this.accessCounter });
        this.memoryBytes += bytes;
        while (this.memoryBytes > this.memoryMaxBytes) {
            let oldestKey: WaveformRepositoryKey | null = null;
            let oldestAccess = Number.POSITIVE_INFINITY;
            this.memory.forEach((entry, candidateKey) => {
                if (entry.lastAccess < oldestAccess) {
                    oldestAccess = entry.lastAccess;
                    oldestKey = candidateKey;
                }
            });
            if (!oldestKey) break;
            const evicted = this.memory.get(oldestKey);
            this.memory.delete(oldestKey);
            if (evicted) this.memoryBytes -= evicted.bytes;
        }
        runtimeDiagnostics.setGauge('waveform', 'memoryBytes', this.memoryBytes);
    }
}

/** Shared browser-local repository; IndexedDB is opened lazily on the first cache lookup. */
export const sharedWaveformRepository = new WaveformRepository();
