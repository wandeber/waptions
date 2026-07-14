import { runtimeDiagnostics } from '@/lib/runtime-diagnostics';
import {
    estimateWaveformPeaksBytes,
    type WaveformPeaks,
} from '@/lib/video-waveform';
import type { WaveformRepositoryKey } from '@/lib/media-asset-ref';

export const DEFAULT_PERSISTENT_WAVEFORM_CACHE_BYTES = 64 * 1024 * 1024;
const WAVEFORM_CACHE_DATABASE = 'waptions-derived-waveforms';
const WAVEFORM_CACHE_STORE = 'waveforms';
const WAVEFORM_CACHE_METADATA_STORE = 'waveform-metadata';
const WAVEFORM_CACHE_DATABASE_VERSION = 1;
const WAVEFORM_CACHE_RECORD_VERSION = 1;

export interface StoredWaveformRecord {
    key: WaveformRepositoryKey;
    recordVersion: number;
    duration: number;
    sampleRate: number;
    bucketCount: number;
    min: Float32Array;
    max: Float32Array;
    bytes: number;
    lastAccess: number;
}

interface StoredWaveformMetadata {
    key: WaveformRepositoryKey;
    bytes: number;
    lastAccess: number;
}

function isRemovableIndexedDbKey(value: unknown): value is IDBValidKey {
    return typeof value === 'string'
        || typeof value === 'number'
        || value instanceof Date
        || value instanceof ArrayBuffer
        || ArrayBuffer.isView(value)
        || (Array.isArray(value) && value.every(isRemovableIndexedDbKey));
}

/** The repository depends on this narrow interface so quota and corruption are testable. */
export interface WaveformPersistentCache {
    get(key: WaveformRepositoryKey): Promise<WaveformPeaks | null>;
    put(key: WaveformRepositoryKey, peaks: WaveformPeaks): Promise<void>;
}

/** @internal Exported for deterministic storage tests; application code uses BestEffortWaveformCache. */
export interface WaveformCacheDriver {
    read(key: WaveformRepositoryKey, lastAccess: number): Promise<unknown | null>;
    write(record: StoredWaveformRecord, maxBytes: number): Promise<number>;
    remove(key: WaveformRepositoryKey): Promise<void>;
}

export function createStoredWaveformRecord(
    key: WaveformRepositoryKey,
    peaks: WaveformPeaks,
    lastAccess: number,
): StoredWaveformRecord {
    return {
        key,
        recordVersion: WAVEFORM_CACHE_RECORD_VERSION,
        duration: peaks.duration,
        sampleRate: peaks.sampleRate,
        bucketCount: peaks.bucketCount,
        min: peaks.min,
        max: peaks.max,
        bytes: estimateWaveformPeaksBytes(peaks),
        lastAccess,
    };
}

export function readStoredWaveformRecord(
    value: unknown,
    expectedKey: WaveformRepositoryKey,
): StoredWaveformRecord | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Partial<StoredWaveformRecord>;
    if (record.key !== expectedKey || record.recordVersion !== WAVEFORM_CACHE_RECORD_VERSION) {
        return null;
    }
    if (!Number.isFinite(record.duration) || (record.duration ?? -1) < 0) return null;
    if (!Number.isFinite(record.sampleRate) || (record.sampleRate ?? 0) <= 0) return null;
    if (!Number.isSafeInteger(record.bucketCount) || (record.bucketCount ?? 0) <= 0) return null;
    if (!(record.min instanceof Float32Array) || !(record.max instanceof Float32Array)) return null;
    if (record.min.length !== record.bucketCount || record.max.length !== record.bucketCount) {
        return null;
    }
    const retainedBytes = record.min.byteLength + record.max.byteLength;
    if (record.bytes !== retainedBytes) return null;
    if (!Number.isFinite(record.lastAccess) || (record.lastAccess ?? -1) < 0) return null;
    return record as StoredWaveformRecord;
}

/**
 * Selects enough least-recently-used records to keep the committed object store under its cap.
 * The incoming key is treated as a replacement, so a refreshed record never counts twice.
 */
export function selectPersistentWaveformEvictions(
    records: readonly StoredWaveformMetadata[],
    incoming: Pick<StoredWaveformMetadata, 'key' | 'bytes'>,
    maxBytes: number,
): { evictedKeys: WaveformRepositoryKey[]; totalBytes: number } {
    const retained = records.filter((record) => record.key !== incoming.key);
    let totalBytes = retained.reduce((total, record) => total + record.bytes, 0) + incoming.bytes;
    const evictedKeys: WaveformRepositoryKey[] = [];
    for (const record of [...retained].sort((left, right) => (
        left.lastAccess - right.lastAccess || left.key.localeCompare(right.key)
    ))) {
        if (totalBytes <= maxBytes) break;
        totalBytes -= record.bytes;
        evictedKeys.push(record.key);
    }
    return { evictedKeys, totalBytes };
}

export class IndexedDbWaveformCacheDriver implements WaveformCacheDriver {
    private disabled = false;

    constructor(private readonly databaseProvider?: () => Promise<IDBDatabase>) {}

    async read(key: WaveformRepositoryKey, lastAccess: number): Promise<unknown | null> {
        return this.runTransaction<unknown | null>(
            [WAVEFORM_CACHE_STORE, WAVEFORM_CACHE_METADATA_STORE],
            'readwrite',
            (transaction, setResult, fail) => {
                const store = transaction.objectStore(WAVEFORM_CACHE_STORE);
                const metadataStore = transaction.objectStore(WAVEFORM_CACHE_METADATA_STORE);
                setResult(null);
                const request = store.get(key);
                request.onerror = () => fail(request.error);
                request.onsuccess = () => {
                    const value = request.result ?? null;
                    setResult(value);
                    if (value === null) {
                        // A missing payload with leftover metadata can follow manual DevTools
                        // edits or a browser recovery. Drop the orphan so it cannot consume the
                        // next capacity calculation indefinitely.
                        const deleteRequest = metadataStore.delete(key);
                        deleteRequest.onerror = () => fail(deleteRequest.error);
                        return;
                    }
                    // LRU metadata lives separately so a cache hit never rewrites or clones the
                    // large typed-array payload just to update its access time.
                    const record = readStoredWaveformRecord(value, key);
                    if (record) {
                        const putRequest = metadataStore.put({
                            key,
                            bytes: record.bytes,
                            lastAccess,
                        } satisfies StoredWaveformMetadata);
                        putRequest.onerror = () => fail(putRequest.error);
                    }
                };
            },
        );
    }

    async write(record: StoredWaveformRecord, maxBytes: number): Promise<number> {
        if (record.bytes > maxBytes) return 0;
        return this.runTransaction<number>(
            [WAVEFORM_CACHE_STORE, WAVEFORM_CACHE_METADATA_STORE],
            'readwrite',
            (transaction, setResult, fail) => {
                const store = transaction.objectStore(WAVEFORM_CACHE_STORE);
                const metadataStore = transaction.objectStore(WAVEFORM_CACHE_METADATA_STORE);
                setResult(0);
                // Capacity enforcement reads only compact metadata. Reading every waveform value
                // here would clone as much as 64 MiB into the main thread on every insert.
                const request = metadataStore.getAll();
                request.onerror = () => fail(request.error);
                request.onsuccess = () => {
                    const records: StoredWaveformMetadata[] = [];
                    const corruptKeys: IDBValidKey[] = [];
                    for (const value of request.result as unknown[]) {
                        const key = value && typeof value === 'object'
                            ? (value as { key?: unknown }).key
                            : null;
                        const bytes = value && typeof value === 'object'
                            ? (value as { bytes?: unknown }).bytes
                            : null;
                        const lastAccess = value && typeof value === 'object'
                            ? (value as { lastAccess?: unknown }).lastAccess
                            : null;
                        if (
                            typeof key === 'string'
                            && Number.isFinite(bytes)
                            && (bytes as number) >= 0
                            && Number.isFinite(lastAccess)
                            && (lastAccess as number) >= 0
                        ) {
                            records.push({
                                key: key as WaveformRepositoryKey,
                                bytes: bytes as number,
                                lastAccess: lastAccess as number,
                            });
                        } else if (isRemovableIndexedDbKey(key)) {
                            corruptKeys.push(key);
                        }
                    }

                    const eviction = selectPersistentWaveformEvictions(records, record, maxBytes);
                    for (const key of [...corruptKeys, ...eviction.evictedKeys]) {
                        const deleteRequest = store.delete(key);
                        deleteRequest.onerror = () => fail(deleteRequest.error);
                        const metadataDeleteRequest = metadataStore.delete(key);
                        metadataDeleteRequest.onerror = () => fail(metadataDeleteRequest.error);
                    }
                    const putRequest = store.put(record);
                    putRequest.onerror = () => fail(putRequest.error);
                    const metadataPutRequest = metadataStore.put({
                        key: record.key,
                        bytes: record.bytes,
                        lastAccess: record.lastAccess,
                    } satisfies StoredWaveformMetadata);
                    metadataPutRequest.onerror = () => fail(metadataPutRequest.error);
                    setResult(eviction.totalBytes);
                };
            },
        );
    }

    async remove(key: WaveformRepositoryKey): Promise<void> {
        await this.runTransaction<void>(
            [WAVEFORM_CACHE_STORE, WAVEFORM_CACHE_METADATA_STORE],
            'readwrite',
            (transaction, setResult, fail) => {
                setResult(undefined);
                const request = transaction.objectStore(WAVEFORM_CACHE_STORE).delete(key);
                request.onerror = () => fail(request.error);
                const metadataRequest = transaction
                    .objectStore(WAVEFORM_CACHE_METADATA_STORE)
                    .delete(key);
                metadataRequest.onerror = () => fail(metadataRequest.error);
            },
        );
    }

    private async openDatabase(): Promise<IDBDatabase> {
        if (this.databaseProvider) return this.databaseProvider();
        if (this.disabled || typeof indexedDB === 'undefined') {
            throw new Error('IndexedDB waveform cache is unavailable.');
        }
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(
                WAVEFORM_CACHE_DATABASE,
                WAVEFORM_CACHE_DATABASE_VERSION,
            );
            let settled = false;
            const fail = (error: unknown) => {
                if (settled) return;
                settled = true;
                this.disabled = true;
                reject(error);
            };
            request.onerror = () => fail(request.error ?? new Error('Failed to open waveform cache.'));
            request.onblocked = () => {
                // A version-blocked derived cache must never hold editor startup hostage. The open
                // request may succeed later; its onsuccess branch closes that now-unused handle.
                fail(new Error('Opening the waveform cache was blocked by another tab.'));
            };
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(WAVEFORM_CACHE_STORE)) {
                    request.result.createObjectStore(WAVEFORM_CACHE_STORE, { keyPath: 'key' });
                }
                if (!request.result.objectStoreNames.contains(WAVEFORM_CACHE_METADATA_STORE)) {
                    request.result.createObjectStore(WAVEFORM_CACHE_METADATA_STORE, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => {
                if (settled) {
                    request.result.close();
                    return;
                }
                settled = true;
                const database = request.result;
                database.onversionchange = () => database.close();
                resolve(database);
            };
        });
    }

    private async runTransaction<Result>(
        storeNames: readonly string[],
        mode: IDBTransactionMode,
        run: (
            transaction: IDBTransaction,
            setResult: (result: Result) => void,
            fail: (error: unknown) => void,
        ) => void,
    ): Promise<Result> {
        const database = await this.openDatabase();
        return new Promise((resolve, reject) => {
            let result: Result;
            let explicitError: unknown;
            let settled = false;
            let transaction: IDBTransaction;
            try {
                transaction = database.transaction(storeNames, mode);
            } catch (error) {
                database.close();
                reject(error);
                return;
            }
            const finish = (error?: unknown) => {
                if (settled) return;
                settled = true;
                database.close();
                if (error !== undefined) reject(error);
                else resolve(result);
            };
            const fail = (error: unknown) => {
                explicitError = error ?? new Error('Waveform cache request failed.');
                try {
                    transaction.abort();
                } catch {
                    finish(explicitError);
                }
            };
            transaction.oncomplete = () => finish();
            transaction.onerror = () => finish(explicitError ?? transaction.error);
            transaction.onabort = () => finish(explicitError ?? transaction.error);
            try {
                run(transaction, (next) => {
                    result = next;
                }, fail);
            } catch (error) {
                fail(error);
            }
        });
    }
}

export interface BestEffortWaveformCacheOptions {
    driver?: WaveformCacheDriver;
    maxBytes?: number;
    now?: () => number;
}

/**
 * Best-effort facade for derived waveform data. Any unavailable, blocked, quota-exhausted, or
 * corrupt IndexedDB path degrades to a miss; project persistence and editing never depend on it.
 */
export class BestEffortWaveformCache implements WaveformPersistentCache {
    private readonly driver: WaveformCacheDriver;
    private readonly maxBytes: number;
    private readonly now: () => number;
    private available = true;

    constructor(options: BestEffortWaveformCacheOptions = {}) {
        this.driver = options.driver ?? new IndexedDbWaveformCacheDriver();
        this.maxBytes = options.maxBytes ?? DEFAULT_PERSISTENT_WAVEFORM_CACHE_BYTES;
        if (!Number.isFinite(this.maxBytes) || this.maxBytes < 0) {
            throw new Error('Persistent waveform cache cap must be non-negative and finite.');
        }
        this.now = options.now ?? Date.now;
    }

    async get(key: WaveformRepositoryKey): Promise<WaveformPeaks | null> {
        if (!this.available) return null;
        try {
            const value = await this.driver.read(key, this.now());
            if (value === null) return null;
            const record = readStoredWaveformRecord(value, key);
            if (!record) {
                // Corruption is scoped to this derived entry. Removing it allows a fresh decode
                // without disabling otherwise healthy cached waveforms.
                try {
                    await this.driver.remove(key);
                } catch {
                    this.available = false;
                }
                return null;
            }
            return {
                duration: record.duration,
                sampleRate: record.sampleRate,
                bucketCount: record.bucketCount,
                min: record.min,
                max: record.max,
            };
        } catch {
            this.available = false;
            return null;
        }
    }

    async put(key: WaveformRepositoryKey, peaks: WaveformPeaks): Promise<void> {
        if (!this.available) return;
        const record = createStoredWaveformRecord(key, peaks, this.now());
        if (!readStoredWaveformRecord(record, key) || record.bytes > this.maxBytes) return;
        try {
            const persistentBytes = await this.driver.write(record, this.maxBytes);
            runtimeDiagnostics.setGauge('waveform', 'persistentBytes', persistentBytes);
        } catch {
            // Quota, private-mode, blocked, and transaction failures only disable this optional
            // derived cache for the session. The repository keeps its bounded in-memory result.
            this.available = false;
        }
    }
}
