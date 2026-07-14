'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { WaveformPeaks } from '@/lib/video-waveform';
import {
    buildTimelineWaveformAmplitudes,
    getTimelineWaveformBarGeometry,
    getTimelineWaveformCanvasMetrics,
} from '@/lib/timeline-waveform-rendering';

interface TimelineWaveformProps {
    peaks?: WaveformPeaks;
    sourceStart: number;
    sourceEnd: number;
    className?: string;
    color?: string;
    testId?: string;
}

interface RenderedWaveformToken {
    peaks: WaveformPeaks;
    sourceStart: number;
    sourceEnd: number;
    width: number;
    height: number;
}

/**
 * Draws a cropped source waveform inside its owning clip.
 *
 * The canvas keeps the clip's complete CSS geometry while a bounded backing raster prevents long,
 * highly zoomed media from exceeding browser canvas limits. Each raster column aggregates its
 * complete source-time interval, which preserves narrow peaks after the bounded image is stretched.
 */
export function TimelineWaveform({
    peaks,
    sourceStart,
    sourceEnd,
    className = '',
    color = '#93c5fd',
    testId,
}: TimelineWaveformProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [renderedToken, setRenderedToken] = useState<RenderedWaveformToken | null>(null);
    const isReady = Boolean(
        peaks
        && renderedToken?.peaks === peaks
        && renderedToken.sourceStart === sourceStart
        && renderedToken.sourceEnd === sourceEnd,
    );

    const render = useCallback(() => {
        const canvas = canvasRef.current;
        const context = canvas?.getContext('2d');
        if (!canvas || !context) return;

        const clearCanvas = () => {
            // Resetting the transform is required because invalidation can follow a high-DPI draw.
            // Clearing in backing-store coordinates guarantees stale project/cache pixels vanish.
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.clearRect(0, 0, canvas.width, canvas.height);
        };

        // A mounted canvas can still have zero layout size while its row or project is changing.
        // Readiness is published only after the measured pixels for the current crop were drawn.
        const bounds = canvas.getBoundingClientRect();
        const cssWidth = Math.round(bounds.width);
        const cssHeight = Math.round(bounds.height);
        const metrics = getTimelineWaveformCanvasMetrics(
            cssWidth,
            cssHeight,
            window.devicePixelRatio || 1,
        );
        const hasValidPeaks = Boolean(
            peaks
            && peaks.duration > 0
            && peaks.bucketCount > 0
            && peaks.min.length >= peaks.bucketCount
            && peaks.max.length >= peaks.bucketCount,
        );
        if (!metrics || !hasValidPeaks || sourceEnd <= sourceStart) {
            clearCanvas();
            setRenderedToken((current) => current === null ? current : null);
            return;
        }
        const drawablePeaks = peaks as WaveformPeaks;
        const amplitudes = buildTimelineWaveformAmplitudes(
            drawablePeaks,
            sourceStart,
            sourceEnd,
            metrics.renderColumnCount,
        );
        if (amplitudes.length === 0) {
            clearCanvas();
            setRenderedToken((current) => current === null ? current : null);
            return;
        }
        if (canvas.width !== metrics.pixelWidth || canvas.height !== metrics.pixelHeight) {
            canvas.width = metrics.pixelWidth;
            canvas.height = metrics.pixelHeight;
        }

        clearCanvas();
        context.setTransform(metrics.horizontalScale, 0, 0, metrics.verticalScale, 0, 0);

        context.fillStyle = color;
        context.globalAlpha = 0.72;
        for (let x = 0; x < amplitudes.length; x += 1) {
            const bar = getTimelineWaveformBarGeometry(amplitudes[x], cssHeight);
            context.fillRect(x, bar.top, 1, bar.height);
        }
        const nextToken = {
            peaks: drawablePeaks,
            sourceStart,
            sourceEnd,
            width: cssWidth,
            height: cssHeight,
        };
        setRenderedToken((current) => (
            current?.peaks === nextToken.peaks
            && current.sourceStart === nextToken.sourceStart
            && current.sourceEnd === nextToken.sourceEnd
            && current.width === nextToken.width
            && current.height === nextToken.height
                ? current
                : nextToken
        ));
    }, [color, peaks, sourceEnd, sourceStart]);

    useLayoutEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        render();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', render);
            return () => window.removeEventListener('resize', render);
        }
        const observer = new ResizeObserver(render);
        observer.observe(canvas);
        return () => observer.disconnect();
    }, [render]);

    return (
        <canvas
            ref={canvasRef}
            className={`absolute inset-0 h-full w-full pointer-events-none ${className}`}
            data-testid={testId}
            data-waveform-state={isReady ? 'ready' : 'loading'}
            aria-hidden="true"
        />
    );
}
