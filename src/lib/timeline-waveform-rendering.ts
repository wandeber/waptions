import type { WaveformPeaks } from './video-waveform';

export const MAXIMUM_TIMELINE_WAVEFORM_RENDER_COLUMNS = 4_096;
export const MAXIMUM_TIMELINE_WAVEFORM_BACKING_WIDTH = 8_192;
export const MAXIMUM_TIMELINE_WAVEFORM_BACKING_HEIGHT = 1_024;

export interface TimelineWaveformCanvasMetrics {
    renderColumnCount: number;
    pixelWidth: number;
    pixelHeight: number;
    horizontalScale: number;
    verticalScale: number;
}

export interface TimelineWaveformBarGeometry {
    top: number;
    height: number;
}

/**
 * Maps a normalized peak to a bottom-origin bar inside the available waveform lane.
 *
 * Silence remains a one-pixel baseline at the bottom. Louder samples grow upward through almost
 * the complete lane height, which uses twice the visible vertical range of a centered symmetric
 * waveform when the canvas already occupies only the lower half of a video clip.
 */
export function getTimelineWaveformBarGeometry(
    amplitude: number,
    cssHeight: number,
): TimelineWaveformBarGeometry {
    const safeHeight = Number.isFinite(cssHeight) ? Math.max(1, cssHeight) : 1;
    const safeAmplitude = Number.isFinite(amplitude)
        ? Math.max(0, Math.min(1, amplitude))
        : 0;
    const drawableHeight = Math.max(1, safeHeight - 3);
    const height = Math.max(1, safeAmplitude * drawableHeight);
    return {
        top: safeHeight - height,
        height,
    };
}

/**
 * Resolves bounded backing-store geometry while leaving the canvas's CSS size untouched.
 *
 * Long clips can be hundreds of thousands of CSS pixels wide at maximum timeline zoom. The
 * browser still stretches this bounded raster across that complete CSS box, while the physical
 * buffer remains below reliable canvas limits on high-density displays.
 */
export function getTimelineWaveformCanvasMetrics(
    cssWidth: number,
    cssHeight: number,
    devicePixelRatio: number,
): TimelineWaveformCanvasMetrics | null {
    if (
        !Number.isFinite(cssWidth)
        || !Number.isFinite(cssHeight)
        || cssWidth <= 0
        || cssHeight <= 0
    ) return null;

    const safeDevicePixelRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
        ? devicePixelRatio
        : 1;
    const renderColumnCount = Math.min(
        MAXIMUM_TIMELINE_WAVEFORM_RENDER_COLUMNS,
        Math.max(1, Math.round(cssWidth)),
    );
    const pixelWidth = Math.min(
        MAXIMUM_TIMELINE_WAVEFORM_BACKING_WIDTH,
        Math.max(1, Math.round(renderColumnCount * safeDevicePixelRatio)),
    );
    const pixelHeight = Math.min(
        MAXIMUM_TIMELINE_WAVEFORM_BACKING_HEIGHT,
        Math.max(1, Math.round(cssHeight * safeDevicePixelRatio)),
    );
    return {
        renderColumnCount,
        pixelWidth,
        pixelHeight,
        horizontalScale: pixelWidth / renderColumnCount,
        verticalScale: pixelHeight / cssHeight,
    };
}

/**
 * Aggregates every peak bucket covered by each bounded render column.
 *
 * Sampling only one bucket per stretched column would hide short spikes when a long source is
 * zoomed far enough to exceed the canvas cap. Treating each column as a half-open source-time
 * interval preserves the strongest peak anywhere inside that interval.
 */
export function buildTimelineWaveformAmplitudes(
    peaks: WaveformPeaks,
    sourceStart: number,
    sourceEnd: number,
    requestedColumnCount: number,
): Float32Array {
    if (
        !Number.isFinite(peaks.duration)
        || peaks.duration <= 0
        || !Number.isInteger(peaks.bucketCount)
        || peaks.bucketCount <= 0
        || peaks.min.length < peaks.bucketCount
        || peaks.max.length < peaks.bucketCount
        || !Number.isFinite(sourceStart)
        || !Number.isFinite(sourceEnd)
        || sourceEnd <= sourceStart
        || !Number.isFinite(requestedColumnCount)
        || requestedColumnCount <= 0
    ) return new Float32Array();

    const rangeStart = Math.max(0, Math.min(peaks.duration, sourceStart));
    const rangeEnd = Math.max(rangeStart, Math.min(peaks.duration, sourceEnd));
    if (rangeEnd <= rangeStart) return new Float32Array();

    const columnCount = Math.min(
        MAXIMUM_TIMELINE_WAVEFORM_RENDER_COLUMNS,
        Math.max(1, Math.round(requestedColumnCount)),
    );
    const amplitudes = new Float32Array(columnCount);
    const sourceDuration = rangeEnd - rangeStart;

    for (let column = 0; column < columnCount; column += 1) {
        const columnStart = rangeStart + sourceDuration * column / columnCount;
        const columnEnd = rangeStart + sourceDuration * (column + 1) / columnCount;
        const firstBucket = Math.min(
            peaks.bucketCount - 1,
            Math.max(0, Math.floor(columnStart / peaks.duration * peaks.bucketCount)),
        );
        const bucketEnd = Math.min(
            peaks.bucketCount,
            Math.max(
                firstBucket + 1,
                Math.ceil(columnEnd / peaks.duration * peaks.bucketCount),
            ),
        );

        let amplitude = 0;
        for (let bucket = firstBucket; bucket < bucketEnd; bucket += 1) {
            amplitude = Math.max(
                amplitude,
                Math.abs(peaks.min[bucket]),
                Math.abs(peaks.max[bucket]),
            );
        }
        amplitudes[column] = amplitude;
    }

    return amplitudes;
}
