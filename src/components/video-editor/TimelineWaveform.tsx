'use client';

import { useRef, useEffect, useCallback } from 'react';

interface TimelineWaveformProps {
    audioBuffer: AudioBuffer | null;
    duration: number;
    pps: number; // pixels per second (base * zoom)
    height?: number;
    containerRef?: React.RefObject<HTMLDivElement | null>;
}

export function TimelineWaveform({
    audioBuffer,
    duration,
    pps,
    height = 40,
    containerRef
}: TimelineWaveformProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const lastRenderRef = useRef<{ scrollLeft: number, pps: number }>({ scrollLeft: -1, pps: -1 });

    const render = useCallback(() => {
        if (!canvasRef.current || !audioBuffer || !containerRef?.current) return;

        const canvas = canvasRef.current;
        const container = containerRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const viewportWidth = container.clientWidth;
        const scrollLeft = container.scrollLeft;

        // Skip if nothing changed (performance optimization)
        if (lastRenderRef.current.scrollLeft === scrollLeft && lastRenderRef.current.pps === pps) {
            return;
        }
        lastRenderRef.current = { scrollLeft, pps };

        const dpr = window.devicePixelRatio || 1;
        // Padding for smooth scroll
        const overscan = 200;
        const renderWidth = viewportWidth + (overscan * 2);

        // Canvas size
        if (canvas.width !== renderWidth * dpr || canvas.height !== height * dpr) {
            canvas.width = renderWidth * dpr;
            canvas.height = height * dpr;
            canvas.style.width = `${renderWidth}px`;
            canvas.style.height = `${height}px`;
            ctx.scale(dpr, dpr);
        }

        // Move the canvas to match the viewport scroll
        const offsetX = scrollLeft - overscan;
        canvas.style.transform = `translateX(${offsetX}px)`;

        ctx.clearRect(0, 0, renderWidth, height);
        ctx.fillStyle = '#3b82f6'; // blue-500
        ctx.globalAlpha = 0.5;

        const data = audioBuffer.getChannelData(0);
        const sampleRate = audioBuffer.sampleRate;

        // Render each pixel of the overscan-expanded viewport
        for (let x = 0; x < renderWidth; x++) {
            const timelineX = offsetX + x;
            if (timelineX < 0) continue;

            const timeAtX = timelineX / pps;
            if (timeAtX > duration) break;

            // Start and end samples for this single pixel
            const startSample = Math.floor(timeAtX * sampleRate);
            const nextTimeAtX = (timelineX + 1) / pps;
            const endSample = Math.max(startSample + 1, Math.floor(nextTimeAtX * sampleRate));
            const step = endSample - startSample;

            let max = 0;
            if (step > 100) {
                const skip = Math.floor(step / 100);
                for (let j = 0; j < step; j += skip) {
                    const datum = Math.abs(data[startSample + j] || 0);
                    if (datum > max) max = datum;
                }
            } else {
                for (let j = 0; j < step; j++) {
                    const datum = Math.abs(data[startSample + j] || 0);
                    if (datum > max) max = datum;
                }
            }

            const barHeight = max * height;
            ctx.fillRect(x, height - barHeight, 1, barHeight);
        }
    }, [audioBuffer, duration, pps, height, containerRef]);

    useEffect(() => {
        let frameId: number;

        const loop = () => {
            render();
            frameId = requestAnimationFrame(loop);
        };

        frameId = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(frameId);
    }, [render]);

    return (
        <canvas
            ref={canvasRef}
            className="absolute left-0 top-0 pointer-events-none opacity-40 mix-blend-screen"
        />
    );
}
