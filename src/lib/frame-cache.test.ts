import { describe, expect, it, vi } from 'vitest';
import { FrameCache, getAdaptiveFrameCacheBudgetBytes } from './frame-cache';

const bitmap = (width = 2, height = 2) => ({
    width,
    height,
    close: vi.fn(),
}) as unknown as ImageBitmap;

describe('FrameCache', () => {
    it('reuses one cached bitmap for timestamps that resolve to the same frame index', () => {
        const cache = new FrameCache(1);
        const frame = bitmap();

        cache.addFrame('preview', 1.001, frame, 30);
        const lease = cache.acquireFrame('preview', 1.006, 30);

        expect(lease?.bitmap).toBe(frame);
        expect(cache.acquireFrame('preview', 1.017, 30)).toBeNull();
        lease?.release();
    });

    it('supports exact frame-index reads and timestamp reporting', () => {
        const cache = new FrameCache(1);
        const frame = bitmap();

        cache.addFrameAtIndex('preview', 45, frame, 30);
        const lease = cache.acquireFrameAtIndex('preview', 45);

        expect(cache.hasFrameAtIndex('preview', 45)).toBe(true);
        expect(lease?.bitmap).toBe(frame);
        expect(cache.getCachedTimestamps('preview')).toEqual([1.5]);
        lease?.release();
    });

    it('closes replaced and cleared bitmaps', () => {
        const cache = new FrameCache(1);
        const first = bitmap();
        const second = bitmap();

        cache.addFrameAtIndex('preview', 2, first, 30);
        cache.addFrameAtIndex('preview', 2, second, 30);
        cache.clear('preview');

        expect(first.close).toHaveBeenCalledTimes(1);
        expect(second.close).toHaveBeenCalledTimes(1);
    });

    it('selects a bounded adaptive budget from device memory', () => {
        expect(getAdaptiveFrameCacheBudgetBytes(2)).toBe(64 * 1024 * 1024);
        expect(getAdaptiveFrameCacheBudgetBytes(4)).toBe(128 * 1024 * 1024);
        expect(getAdaptiveFrameCacheBudgetBytes(undefined)).toBe(128 * 1024 * 1024);
        expect(getAdaptiveFrameCacheBudgetBytes(8)).toBe(256 * 1024 * 1024);
    });

    it('never exceeds the hard cap and closes an oversized bitmap immediately', () => {
        const cache = new FrameCache(1);
        const first = bitmap(400, 400);
        const second = bitmap(400, 400);
        const oversized = bitmap(1024, 1024);

        expect(cache.addFrameAtIndex('preview', 0, first)).toBe(true);
        expect(cache.addFrameAtIndex('preview', 1, second)).toBe(true);
        expect(cache.getStats().memoryBytes).toBeLessThanOrEqual(cache.getStats().maxMemoryBytes);
        expect(first.close).toHaveBeenCalledTimes(1);

        expect(cache.addFrameAtIndex('preview', 2, oversized)).toBe(false);
        expect(oversized.close).toHaveBeenCalledTimes(1);
        expect(cache.getStats().memoryBytes).toBeLessThanOrEqual(cache.getStats().maxMemoryBytes);
    });

    it('defers an evicted bitmap close until its last idempotent lease release', () => {
        const cache = new FrameCache(1);
        const first = bitmap(400, 400);
        const second = bitmap(400, 400);
        cache.addFrameAtIndex('preview', 0, first);
        const lease = cache.acquireFrameAtIndex('preview', 0);

        expect(lease?.bitmap).toBe(first);
        // The leased frame remains resident. Since it cannot be reclaimed yet, the cache rejects
        // the newcomer instead of temporarily crossing its hard resident-memory budget.
        expect(cache.addFrameAtIndex('preview', 1, second)).toBe(false);
        expect(first.close).not.toHaveBeenCalled();
        expect(second.close).toHaveBeenCalledTimes(1);
        expect(cache.hasFrameAtIndex('preview', 0)).toBe(false);

        lease?.release();
        lease?.release();
        expect(first.close).toHaveBeenCalledTimes(1);
        expect(cache.getStats().memoryBytes).toBe(0);
    });

    it('clears leased entries safely and closes them after release', () => {
        const cache = new FrameCache(1);
        const frame = bitmap();
        cache.addFrameAtIndex('preview', 0, frame);
        const lease = cache.acquireFrameAtIndex('preview', 0);

        cache.clear();
        expect(cache.getStats()).toMatchObject({ frameCount: 0, leasedFrameCount: 1 });
        expect(frame.close).not.toHaveBeenCalled();

        lease?.release();
        expect(frame.close).toHaveBeenCalledTimes(1);
        expect(cache.getStats()).toMatchObject({ memoryBytes: 0, leasedFrameCount: 0 });
    });

    it('preserves the hard cap and exactly-once ownership across randomized churn', () => {
        const cache = new FrameCache(2);
        const frames: Array<ReturnType<typeof bitmap>> = [];
        const leases: Array<ReturnType<typeof cache.acquireFrameAtIndex>> = [];
        let seed = 0x5eed1234;
        const random = () => {
            seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
            return seed / 0x1_0000_0000;
        };

        for (let index = 0; index < 250; index += 1) {
            const side = 64 + Math.floor(random() * 512);
            const frame = bitmap(side, side);
            frames.push(frame);
            cache.addFrameAtIndex(`source-${index % 3}`, index % 40, frame);
            if (random() > 0.65) {
                leases.push(cache.acquireFrameAtIndex(`source-${index % 3}`, index % 40));
            }
            if (random() > 0.8) leases.shift()?.release();
            expect(cache.getStats().memoryBytes).toBeLessThanOrEqual(cache.getStats().maxMemoryBytes);
        }

        cache.clear();
        for (const lease of leases) lease?.release();
        expect(cache.getStats().memoryBytes).toBe(0);
        for (const frame of frames) {
            expect(frame.close).toHaveBeenCalledTimes(1);
        }
    });
});
