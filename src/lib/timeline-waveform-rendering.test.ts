import { describe, expect, it } from 'vitest';
import type { WaveformPeaks } from './video-waveform';
import {
    MAXIMUM_TIMELINE_WAVEFORM_BACKING_HEIGHT,
    MAXIMUM_TIMELINE_WAVEFORM_BACKING_WIDTH,
    MAXIMUM_TIMELINE_WAVEFORM_RENDER_COLUMNS,
    buildTimelineWaveformAmplitudes,
    getTimelineWaveformBarGeometry,
    getTimelineWaveformCanvasMetrics,
} from './timeline-waveform-rendering';

const peaks = (values: readonly number[]): WaveformPeaks => ({
    duration: values.length,
    sampleRate: 48_000,
    bucketCount: values.length,
    min: Float32Array.from(values, (value) => -value),
    max: Float32Array.from(values),
});

describe('timeline waveform canvas metrics', () => {
    it('bounds a high-density long-clip canvas independently of its CSS width', () => {
        const metrics = getTimelineWaveformCanvasMetrics(120_000, 192, 3);

        expect(metrics).toEqual({
            renderColumnCount: MAXIMUM_TIMELINE_WAVEFORM_RENDER_COLUMNS,
            pixelWidth: MAXIMUM_TIMELINE_WAVEFORM_BACKING_WIDTH,
            pixelHeight: 576,
            horizontalScale: 2,
            verticalScale: 3,
        });
    });

    it('bounds pathological height and rejects missing layout geometry', () => {
        expect(getTimelineWaveformCanvasMetrics(100, 10_000, 4)?.pixelHeight)
            .toBe(MAXIMUM_TIMELINE_WAVEFORM_BACKING_HEIGHT);
        expect(getTimelineWaveformCanvasMetrics(0, 64, 2)).toBeNull();
        expect(getTimelineWaveformCanvasMetrics(100, Number.NaN, 2)).toBeNull();
    });
});

describe('timeline waveform source aggregation', () => {
    it('aggregates every source bucket covered by a render column', () => {
        const amplitudes = buildTimelineWaveformAmplitudes(
            peaks([1, 2, 3, 4, 5, 6, 7, 8]),
            2,
            6,
            2,
        );

        expect(Array.from(amplitudes)).toEqual([4, 6]);
    });

    it('preserves a narrow spike when many buckets collapse into one column', () => {
        const values = Array.from({ length: 100 }, () => 0);
        values[49] = 0.875;

        expect(buildTimelineWaveformAmplitudes(peaks(values), 0, 100, 1)[0]).toBe(0.875);
    });

    it('caps requested columns and rejects invalid source ranges', () => {
        expect(buildTimelineWaveformAmplitudes(peaks([0.5]), 0, 1, 1_000_000))
            .toHaveLength(MAXIMUM_TIMELINE_WAVEFORM_RENDER_COLUMNS);
        expect(buildTimelineWaveformAmplitudes(peaks([0.5]), 1, 1, 10)).toHaveLength(0);
    });
});

describe('timeline waveform bar geometry', () => {
    it('keeps silence on the bottom edge and grows amplitude upward', () => {
        expect(getTimelineWaveformBarGeometry(0, 32)).toEqual({ top: 31, height: 1 });
        expect(getTimelineWaveformBarGeometry(0.5, 32)).toEqual({ top: 17.5, height: 14.5 });
        expect(getTimelineWaveformBarGeometry(1, 32)).toEqual({ top: 3, height: 29 });
    });

    it('clamps malformed amplitudes to a safe bottom-origin bar', () => {
        expect(getTimelineWaveformBarGeometry(2, 10)).toEqual({ top: 3, height: 7 });
        expect(getTimelineWaveformBarGeometry(Number.NaN, 10)).toEqual({ top: 9, height: 1 });
    });
});
