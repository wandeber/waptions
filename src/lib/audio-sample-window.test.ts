import { describe, expect, it } from 'vitest';
import {
    buildSanitizedAudioWindowPlan,
    materializeSanitizedAudioWindowRange,
    materializeSanitizedAudioWindows,
} from './audio-sample-window';

describe('buildSanitizedAudioWindowPlan', () => {
    it('removes negative priming and preserves the declared silent tail', () => {
        const plan = buildSanitizedAudioWindowPlan([
            { timestampSeconds: -0.01, sampleRate: 48_000, frameCount: 960 },
        ], {
            nativeSampleRate: 48_000,
            declaredSampleCount: 1_000,
        });

        expect(plan.spans).toEqual([{
            windowIndex: 0,
            sourceStartSample: 0,
            sourceEndSample: 480,
            windowStartPosition: 480,
            windowEndPosition: 960,
        }]);
        expect(plan.silenceRanges).toEqual([{ startSample: 480, endSample: 1_000 }]);
    });

    it('maps mismatched decoder rates from the common timestamp origin', () => {
        const plan = buildSanitizedAudioWindowPlan([
            { timestampSeconds: 0, sampleRate: 44_100, frameCount: 441 },
        ], {
            nativeSampleRate: 48_000,
            declaredDurationSeconds: 0.01,
        });

        expect(plan.totalSampleCount).toBe(480);
        expect(plan.spans[0]).toEqual({
            windowIndex: 0,
            sourceStartSample: 0,
            sourceEndSample: 480,
            windowStartPosition: 0,
            windowEndPosition: 441,
        });
    });

    it('uses first-write-wins for overlaps and reports timestamp gaps once', () => {
        const plan = buildSanitizedAudioWindowPlan([
            { timestampSeconds: 0, sampleRate: 1_000, frameCount: 600 },
            { timestampSeconds: 0.5, sampleRate: 1_000, frameCount: 400 },
            { timestampSeconds: 0.95, sampleRate: 1_000, frameCount: 50 },
        ], {
            nativeSampleRate: 1_000,
            declaredSampleCount: 1_200,
        });

        expect(plan.spans).toEqual([
            {
                windowIndex: 0,
                sourceStartSample: 0,
                sourceEndSample: 600,
                windowStartPosition: 0,
                windowEndPosition: 600,
            },
            {
                windowIndex: 1,
                sourceStartSample: 600,
                sourceEndSample: 900,
                windowStartPosition: 100,
                windowEndPosition: 400,
            },
            {
                windowIndex: 2,
                sourceStartSample: 950,
                sourceEndSample: 1_000,
                windowStartPosition: 0,
                windowEndPosition: 50,
            },
        ]);
        expect(plan.silenceRanges).toEqual([
            { startSample: 900, endSample: 950 },
            { startSample: 1_000, endSample: 1_200 },
        ]);
    });

    it('materializes overlaps and gaps without decoder-specific dependencies', () => {
        const windows = [{
            timestampSeconds: 0,
            sampleRate: 4,
            frameCount: 3,
            channels: [Float32Array.of(1, 2, 3)],
        }, {
            timestampSeconds: 0.5,
            sampleRate: 4,
            frameCount: 2,
            channels: [Float32Array.of(8, 9)],
        }, {
            timestampSeconds: 1.25,
            sampleRate: 4,
            frameCount: 1,
            channels: [Float32Array.of(7)],
        }];
        const plan = buildSanitizedAudioWindowPlan(windows, {
            nativeSampleRate: 4,
            declaredSampleCount: 6,
        });
        const [channel] = materializeSanitizedAudioWindows(windows, plan, 1);

        // Window two overlaps samples two and three, so only its uncovered trailing sample wins.
        // Sample four is a real timestamp gap and the declared source ends at sample six.
        expect(Array.from(channel)).toEqual([1, 2, 3, 9, 0, 7]);
    });

    it('materializes a bounded absolute range without allocating the declared duration', () => {
        const windows = [{
            timestampSeconds: 2,
            sampleRate: 4,
            frameCount: 4,
            channels: [Float32Array.of(1, 2, 3, 4)],
        }];
        const plan = buildSanitizedAudioWindowPlan(windows, {
            nativeSampleRate: 4,
            declaredSampleCount: 40,
        });
        const [channel] = materializeSanitizedAudioWindowRange(windows, plan, {
            startSample: 7,
            endSample: 13,
            channelCount: 1,
        });

        expect(channel).toHaveLength(6);
        expect(Array.from(channel)).toEqual([0, 1, 2, 3, 4, 0]);
    });
});
