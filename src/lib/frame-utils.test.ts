import { describe, expect, it } from 'vitest';
import { frameDuration, frameIndexToTime, normalizeFps, timeToFrameIndex } from './frame-utils';

describe('frame utils', () => {
    it('normalizes invalid fps values to the preview default', () => {
        expect(normalizeFps(0)).toBe(30);
        expect(normalizeFps(Number.NaN)).toBe(30);
        expect(normalizeFps(undefined)).toBe(30);
    });

    it('converts time to stable frame indexes', () => {
        expect(timeToFrameIndex(1, 30)).toBe(30);
        expect(timeToFrameIndex(1.016, 30)).toBe(30);
        expect(timeToFrameIndex(1.017, 30)).toBe(31);
        expect(timeToFrameIndex(-1, 30)).toBe(0);
    });

    it('converts frame indexes back to frame times', () => {
        expect(frameIndexToTime(30, 30)).toBe(1);
        expect(frameIndexToTime(15, 60)).toBe(0.25);
        expect(frameDuration(25)).toBe(0.04);
    });
});
