import { describe, expect, it, vi } from 'vitest';
import {
    EditorialPcmWindowRepository,
    createEditorialPcmWindowKey,
    findQuietEditorialBoundary,
    readStoredEditorialPcmWindow,
    type EditorialPcmWindowCacheDriver,
    type EditorialPcmWindowIdentity,
    type StoredEditorialPcmWindow,
} from './editorial-pcm-window-cache';

class FakeDriver implements EditorialPcmWindowCacheDriver {
    readonly values = new Map<string, unknown>();
    reads = 0;
    writes = 0;
    removes: string[] = [];
    fail = false;

    async read(key: string) {
        this.reads += 1;
        if (this.fail) throw new DOMException('Synthetic quota.', 'QuotaExceededError');
        return this.values.get(key) ?? null;
    }

    async write(record: StoredEditorialPcmWindow) {
        this.writes += 1;
        if (this.fail) throw new DOMException('Synthetic quota.', 'QuotaExceededError');
        this.values.set(record.key, record);
    }

    async remove(key: string) {
        this.removes.push(key);
        this.values.delete(key);
    }
}

const first: EditorialPcmWindowIdentity = {
    sourceFingerprint: 'source',
    pcmAlgorithmVersion: 1,
    startSample: 0,
    endSample: 4,
};

describe('bounded editorial PCM refinement cache', () => {
    it('round-trips defensive copies and enforces strict memory LRU capacity', async () => {
        const driver = new FakeDriver();
        const cache = new EditorialPcmWindowRepository({
            driver,
            memoryMaxBytes: 8,
            persistentMaxBytes: 100,
            maxWindowSamples: 4,
            now: () => 1,
        });
        const values = Int16Array.from([1, 2, 3, 4]);
        await cache.put(first, values);
        values[0] = 99;
        const retained = await cache.get(first);
        expect(Array.from(retained ?? [])).toEqual([1, 2, 3, 4]);
        retained![0] = 88;
        expect(Array.from((await cache.get(first)) ?? [])).toEqual([1, 2, 3, 4]);

        const second = { ...first, startSample: 4, endSample: 8 };
        await cache.put(second, Int16Array.from([5, 6, 7, 8]));
        // First was evicted from memory and therefore requires a persistent lookup.
        expect(Array.from((await cache.get(first)) ?? [])).toEqual([1, 2, 3, 4]);
        expect(driver.reads).toBe(1);
    });

    it('removes one corrupt derived entry and degrades persistent failure to misses', async () => {
        const driver = new FakeDriver();
        const cache = new EditorialPcmWindowRepository({ driver, maxWindowSamples: 4 });
        const key = createEditorialPcmWindowKey(first);
        driver.values.set(key, { key, recordVersion: 1, samples: 'corrupt' });
        await expect(cache.get(first)).resolves.toBeNull();
        expect(driver.removes).toEqual([key]);

        driver.fail = true;
        await expect(cache.get(first)).resolves.toBeNull();
        await expect(cache.get(first)).resolves.toBeNull();
        expect(driver.reads).toBe(2);
    });

    it('rejects mismatched or over-bounded windows before persistence', async () => {
        const driver = new FakeDriver();
        const cache = new EditorialPcmWindowRepository({ driver, maxWindowSamples: 4 });
        await expect(cache.put(first, Int16Array.from([1]))).rejects.toThrow('does not match');
        await expect(cache.put({ ...first, endSample: 5 }, new Int16Array(5)))
            .rejects.toThrow('exceeds');
        expect(driver.writes).toBe(0);
    });

    it('uses an injected bounded decoder with explicit filter padding on a cache miss', async () => {
        const driver = new FakeDriver();
        const cache = new EditorialPcmWindowRepository({ driver, maxWindowSamples: 4 });
        const decodeWindow = vi.fn(async () => Int16Array.from([1, 2, 3, 4]));
        const result = await cache.getOrDecode(first, { decodeWindow }, {
            filterPaddingSamples: 64,
        });
        expect(Array.from(result)).toEqual([1, 2, 3, 4]);
        expect(decodeWindow).toHaveBeenCalledWith({
            ...first,
            filterPaddingSamples: 64,
            signal: undefined,
        });
        await cache.getOrDecode(first, { decodeWindow });
        expect(decodeWindow).toHaveBeenCalledTimes(1);
    });

    it('validates stored typed-array records', () => {
        const key = createEditorialPcmWindowKey(first);
        const record = {
            ...first,
            key,
            recordVersion: 1 as const,
            samples: Int16Array.from([1, 2, 3, 4]),
            bytes: 8,
            lastAccess: 1,
        };
        expect(readStoredEditorialPcmWindow(record, key)).toBe(record);
        expect(readStoredEditorialPcmWindow({ ...record, bytes: 7 }, key)).toBeNull();
    });
});

describe('quiet-assisted editorial boundary search', () => {
    it('chooses a bounded RMS valley and nearest deterministic zero crossing', () => {
        const samples = new Int16Array(4_000).fill(20_000);
        // Provide a quiet 10 ms valley around source sample 2,050 and a zero crossing at 2,048.
        samples.fill(200, 1_970, 2_130);
        samples[2_047] = -1;
        samples[2_048] = 1;
        expect(findQuietEditorialBoundary({
            samples,
            windowStartSample: 0,
            originalSample: 2_000,
            minimumSample: 1_900,
            maximumSample: 2_100,
        })).toBe(2_048);
    });

    it('never searches farther than 120 ms or outside caller word-core bounds', () => {
        const samples = new Int16Array(8_000).fill(1_000);
        samples.fill(0, 6_000, 6_200);
        const chosen = findQuietEditorialBoundary({
            samples,
            windowStartSample: 0,
            originalSample: 3_000,
            minimumSample: 2_900,
            maximumSample: 3_100,
        });
        expect(chosen).toBeGreaterThanOrEqual(2_900);
        expect(chosen).toBeLessThanOrEqual(3_100);
    });

    it('rejects a boundary origin outside the neighboring word-core bounds', () => {
        expect(() => findQuietEditorialBoundary({
            samples: new Int16Array(1_000),
            windowStartSample: 0,
            originalSample: 500,
            minimumSample: 600,
            maximumSample: 900,
        })).toThrow('bounds are invalid');
    });
});
