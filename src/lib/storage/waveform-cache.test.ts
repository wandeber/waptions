import { describe, expect, it } from 'vitest';
import type { WaveformRepositoryKey } from '@/lib/media-asset-ref';
import type { WaveformPeaks } from '@/lib/video-waveform';
import {
    BestEffortWaveformCache,
    createStoredWaveformRecord,
    IndexedDbWaveformCacheDriver,
    readStoredWaveformRecord,
    selectPersistentWaveformEvictions,
    type StoredWaveformRecord,
    type WaveformCacheDriver,
} from './waveform-cache';

function createWaveformDatabase(
    values: Record<string, Map<IDBValidKey, unknown>>,
): IDBDatabase {
    return {
        close: () => undefined,
        transaction: (storeNames: string | string[]) => {
            const names = Array.isArray(storeNames) ? storeNames : [storeNames];
            const staged = new Map(names.map((name) => [name, new Map(values[name])]));
            let pendingRequests = 0;
            let completionQueued = false;
            let aborted = false;
            const transaction = {
                error: null,
                oncomplete: null,
                onerror: null,
                onabort: null,
                abort: () => {
                    if (aborted) return;
                    aborted = true;
                    queueMicrotask(() => transaction.onabort?.(new Event('abort')));
                },
                objectStore: (name: string) => {
                    const store = staged.get(name);
                    if (!store) throw new DOMException(`Unknown store ${name}.`, 'NotFoundError');
                    return {
                        get: (recordKey: IDBValidKey) => makeRequest(() => store.get(recordKey)),
                        getAll: () => makeRequest(() => Array.from(store.values())),
                        put: (record: { key: IDBValidKey }) => makeRequest(() => {
                            store.set(record.key, record);
                            return record.key;
                        }),
                        delete: (recordKey: IDBValidKey) => makeRequest(() => {
                            store.delete(recordKey);
                            return undefined;
                        }),
                    };
                },
            } as unknown as IDBTransaction;

            const queueCompletion = () => {
                if (completionQueued || pendingRequests !== 0 || aborted) return;
                completionQueued = true;
                queueMicrotask(() => {
                    completionQueued = false;
                    if (pendingRequests !== 0 || aborted) return;
                    staged.forEach((items, name) => {
                        values[name] = new Map(items);
                    });
                    transaction.oncomplete?.(new Event('complete'));
                });
            };
            const makeRequest = <Result>(operation: () => Result): IDBRequest<Result> => {
                pendingRequests += 1;
                const request = {
                    result: undefined,
                    error: null,
                    onsuccess: null,
                    onerror: null,
                } as unknown as IDBRequest<Result>;
                queueMicrotask(() => {
                    if (aborted) return;
                    try {
                        Object.defineProperty(request, 'result', { value: operation() });
                        request.onsuccess?.(new Event('success'));
                    } catch (error) {
                        Object.defineProperty(request, 'error', { value: error });
                        request.onerror?.(new Event('error'));
                    } finally {
                        pendingRequests -= 1;
                        queueCompletion();
                    }
                });
                return request;
            };
            return transaction;
        },
    } as unknown as IDBDatabase;
}

const key = (name: string): WaveformRepositoryKey => (
    `waveform:audio-source:${name}:v2:r2` as WaveformRepositoryKey
);

const peaks = (value: number): WaveformPeaks => ({
    duration: 1,
    sampleRate: 48_000,
    bucketCount: 2,
    min: Float32Array.from([value, value]),
    max: Float32Array.from([value, value]),
});

class FakeDriver implements WaveformCacheDriver {
    readonly values = new Map<WaveformRepositoryKey, unknown>();
    reads = 0;
    removals: WaveformRepositoryKey[] = [];
    failWrites = false;
    failReads = false;

    async read(cacheKey: WaveformRepositoryKey): Promise<unknown | null> {
        this.reads += 1;
        if (this.failReads) throw new Error('Synthetic blocked database.');
        return this.values.get(cacheKey) ?? null;
    }

    async write(record: StoredWaveformRecord): Promise<number> {
        if (this.failWrites) throw new DOMException('Synthetic quota failure.', 'QuotaExceededError');
        this.values.set(record.key, record);
        return record.bytes;
    }

    async remove(cacheKey: WaveformRepositoryKey): Promise<void> {
        this.removals.push(cacheKey);
        this.values.delete(cacheKey);
    }
}

describe('persistent waveform cache records', () => {
    it('round-trips valid typed arrays and rejects corrupt or stale record versions', () => {
        const cacheKey = key('valid');
        const record = createStoredWaveformRecord(cacheKey, peaks(0.5), 10);

        expect(readStoredWaveformRecord(record, cacheKey)).toBe(record);
        expect(readStoredWaveformRecord({ ...record, recordVersion: 99 }, cacheKey)).toBeNull();
        expect(readStoredWaveformRecord({ ...record, min: new Float32Array(1) }, cacheKey))
            .toBeNull();
        expect(readStoredWaveformRecord({ ...record, bytes: 1 }, cacheKey)).toBeNull();
    });

    it('selects deterministic LRU evictions while treating an incoming key as a replacement', () => {
        const first = createStoredWaveformRecord(key('a'), peaks(1), 1);
        const second = createStoredWaveformRecord(key('b'), peaks(2), 2);
        const replacement = createStoredWaveformRecord(key('b'), peaks(3), 3);

        expect(selectPersistentWaveformEvictions(
            [first, second],
            replacement,
            replacement.bytes,
        )).toEqual({
            evictedKeys: [first.key],
            totalBytes: replacement.bytes,
        });
    });
});

describe('IndexedDB waveform cache driver', () => {
    it('updates compact LRU metadata and atomically evicts payloads over the cap', async () => {
        const values = {
            waveforms: new Map<IDBValidKey, unknown>(),
            'waveform-metadata': new Map<IDBValidKey, unknown>(),
        };
        const driver = new IndexedDbWaveformCacheDriver(async () => createWaveformDatabase(values));
        const first = createStoredWaveformRecord(key('first'), peaks(1), 1);
        const second = createStoredWaveformRecord(key('second'), peaks(2), 2);

        await expect(driver.write(first, 16)).resolves.toBe(16);
        await expect(driver.write(second, 16)).resolves.toBe(16);
        expect(values.waveforms.has(first.key)).toBe(false);
        expect(values.waveforms.get(second.key)).toBe(second);

        await expect(driver.read(second.key, 99)).resolves.toBe(second);
        expect(values['waveform-metadata'].get(second.key)).toEqual({
            key: second.key,
            bytes: 16,
            lastAccess: 99,
        });

        await driver.remove(second.key);
        expect(values.waveforms.size).toBe(0);
        expect(values['waveform-metadata'].size).toBe(0);
    });
});

describe('best-effort persistent waveform cache', () => {
    it('returns a stored waveform and removes only a corrupt derived entry', async () => {
        const driver = new FakeDriver();
        const cache = new BestEffortWaveformCache({ driver, now: () => 10 });
        const validKey = key('valid');
        const corruptKey = key('corrupt');
        driver.values.set(validKey, createStoredWaveformRecord(validKey, peaks(0.5), 1));
        driver.values.set(corruptKey, { key: corruptKey, recordVersion: 1, min: 'bad' });

        await expect(cache.get(corruptKey)).resolves.toBeNull();
        expect(driver.removals).toEqual([corruptKey]);
        await expect(cache.get(validKey)).resolves.toEqual(peaks(0.5));
    });

    it('degrades quota failures to memory-only behavior without repeated storage work', async () => {
        const driver = new FakeDriver();
        driver.failWrites = true;
        const cache = new BestEffortWaveformCache({ driver });

        await expect(cache.put(key('quota'), peaks(1))).resolves.toBeUndefined();
        await expect(cache.get(key('quota'))).resolves.toBeNull();
        expect(driver.reads).toBe(0);
    });

    it('degrades a blocked database lookup to one non-fatal miss', async () => {
        const driver = new FakeDriver();
        driver.failReads = true;
        const cache = new BestEffortWaveformCache({ driver });

        await expect(cache.get(key('blocked'))).resolves.toBeNull();
        await expect(cache.get(key('blocked-again'))).resolves.toBeNull();
        expect(driver.reads).toBe(1);
    });

    it('treats unavailable IndexedDB as a non-fatal cache miss', async () => {
        const cache = new BestEffortWaveformCache();
        await expect(cache.get(key('node-without-indexeddb'))).resolves.toBeNull();
    });

    it('does not wait for an IndexedDB open request after its blocked event', async () => {
        const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
        const request = {
            error: null,
            onerror: null,
            onblocked: null,
            onupgradeneeded: null,
            onsuccess: null,
        } as unknown as IDBOpenDBRequest;
        Object.defineProperty(globalThis, 'indexedDB', {
            configurable: true,
            value: {
                open: () => {
                    queueMicrotask(() => request.onblocked?.(
                        new Event('blocked') as IDBVersionChangeEvent,
                    ));
                    return request;
                },
            },
        });

        try {
            const cache = new BestEffortWaveformCache();
            await expect(cache.get(key('blocked-open'))).resolves.toBeNull();
        } finally {
            if (originalDescriptor) {
                Object.defineProperty(globalThis, 'indexedDB', originalDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, 'indexedDB');
            }
        }
    });
});
