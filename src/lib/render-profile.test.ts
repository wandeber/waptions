import { describe, expect, it } from 'vitest';
import {
    DEFAULT_RENDER_PROFILE,
    createDefaultRenderProfile,
    framesToSeconds,
    normalizeFrameRate,
    outputFramesToSamples,
    samplesToOutputFrames,
    secondsToFrames,
} from './render-profile';

describe('render profile timing', () => {
    it('creates an unlocked 1080p, 30 fps, 48 kHz default profile', () => {
        expect(createDefaultRenderProfile()).toEqual(DEFAULT_RENDER_PROFILE);
    });

    it('normalizes rational broadcast frame rates without decimal approximation', () => {
        expect(normalizeFrameRate({ numerator: 48_000, denominator: 2_002 })).toEqual({
            numerator: 24_000,
            denominator: 1_001,
        });
        expect(framesToSeconds(24_000, { numerator: 24_000, denominator: 1_001 })).toBe(1_001);
    });

    it('supports explicit boundary rounding when converting seconds to frames', () => {
        const fps = { numerator: 30, denominator: 1 };
        expect(secondsToFrames(1.01, fps, 'floor')).toBe(30);
        expect(secondsToFrames(1.01, fps, 'nearest')).toBe(30);
        expect(secondsToFrames(1.01, fps, 'ceil')).toBe(31);
    });

    it('maps shared frame boundaries to the same 48 kHz sample boundaries', () => {
        const fps = { numerator: 24_000, denominator: 1_001 };
        const sampleBoundary = outputFramesToSamples(1_000, fps);

        expect(sampleBoundary).toBe(2_002_000);
        expect(samplesToOutputFrames(sampleBoundary, fps)).toBe(1_000);
    });

    it('rejects unsafe rational rates and non-finite coordinates', () => {
        expect(() => normalizeFrameRate({ numerator: 0, denominator: 1 })).toThrow(RangeError);
        expect(() => normalizeFrameRate({ numerator: 30, denominator: 1.5 })).toThrow(RangeError);
        expect(() => secondsToFrames(Number.NaN, { numerator: 30, denominator: 1 })).toThrow(RangeError);
    });
});
