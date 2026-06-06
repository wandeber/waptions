import { describe, expect, it, vi } from 'vitest';
import { FrameCache } from './frame-cache';

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

        expect(cache.getFrame('preview', 1.006, 30)).toBe(frame);
        expect(cache.getFrame('preview', 1.017, 30)).toBeNull();
    });

    it('supports exact frame-index reads and timestamp reporting', () => {
        const cache = new FrameCache(1);
        const frame = bitmap();

        cache.addFrameAtIndex('preview', 45, frame, 30);

        expect(cache.hasFrameAtIndex('preview', 45)).toBe(true);
        expect(cache.getFrameAtIndex('preview', 45)).toBe(frame);
        expect(cache.getCachedTimestamps('preview')).toEqual([1.5]);
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
});
