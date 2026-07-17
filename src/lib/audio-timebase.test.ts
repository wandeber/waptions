import { describe, expect, it } from 'vitest';
import {
    frameSpanToOutputSamples,
    frameToOutputSample,
    nativeBoundaryToOutputSample,
    nativeSpanToOutputSamples,
    outputSampleToFloorNativeBoundary,
    outputSampleToNearestNativeBoundary,
    outputSampleToCoveringFrame,
    roundNonNegativeRatioHalfUp,
} from './audio-timebase';

describe('audio timebase', () => {
    it('maps broadcast frame rates with exact integer arithmetic', () => {
        const fps = { numerator: 30_000, denominator: 1_001 };
        expect(frameToOutputSample(1, fps)).toBe(1_602);
        expect(frameToOutputSample(30_000, fps)).toBe(48_048_000);
    });

    it('rounds exact halves upward in frame and native domains', () => {
        expect(roundNonNegativeRatioHalfUp(BigInt(1), BigInt(2))).toBe(BigInt(1));
        expect(frameToOutputSample(1, { numerator: 96_000, denominator: 1 })).toBe(1);
        expect(nativeBoundaryToOutputSample(1, 96_000)).toBe(1);
    });

    it('makes adjacent spans additive by mapping absolute boundaries', () => {
        const fps = { numerator: 30_000, denominator: 1_001 };
        const left = frameSpanToOutputSamples(0, 1, fps);
        const right = frameSpanToOutputSamples(1, 2, fps);
        expect(left + right).toBe(frameSpanToOutputSamples(0, 2, fps));

        expect(nativeSpanToOutputSamples(0, 1, 44_100)
            + nativeSpanToOutputSamples(1, 44_100, 44_100)).toBe(48_000);
    });

    it('keeps large safe boundaries exact when intermediate products exceed number precision', () => {
        const frame = 1_000_000_000_000;
        const fps = { numerator: 30_000, denominator: 1_001 };
        expect(frameToOutputSample(frame, fps)).toBe(1_601_600_000_000_000);
    });

    it('finds the smallest frame boundary covering a sample at broadcast rates', () => {
        const fps = { numerator: 30_000, denominator: 1_001 };
        expect(outputSampleToCoveringFrame(0, fps)).toBe(0);
        expect(outputSampleToCoveringFrame(1, fps)).toBe(1);
        expect(outputSampleToCoveringFrame(1_601, fps)).toBe(1);
        expect(outputSampleToCoveringFrame(1_602, fps)).toBe(1);
        expect(outputSampleToCoveringFrame(1_603, fps)).toBe(2);
        expect(outputSampleToCoveringFrame(3_203, fps)).toBe(2);
    });

    it('inverts native boundaries deterministically and breaks ties toward the higher boundary', () => {
        expect(outputSampleToNearestNativeBoundary(24_000, 44_100)).toBe(22_050);
        expect(outputSampleToNearestNativeBoundary(0, 192_000)).toBe(1);
    });

    it('keeps a native boundary on or before a canonical output target', () => {
        const boundary = outputSampleToFloorNativeBoundary(6_406, 44_100);
        expect(boundary).toBe(5_885);
        expect(nativeBoundaryToOutputSample(boundary, 44_100)).toBeLessThanOrEqual(6_406);
        expect(nativeBoundaryToOutputSample(boundary + 1, 44_100)).toBeGreaterThan(6_406);
    });
});
