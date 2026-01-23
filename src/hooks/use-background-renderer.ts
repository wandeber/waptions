'use client';

import { useEffect, useRef } from 'react';
import { usePlaybackStore } from '@/stores/playback-store';
import { useVideoStore } from '@/stores/video-store';
import { videoCache } from '@/lib/video-cache';
import { frameCache } from '@/lib/frame-cache';

interface BackgroundRendererOptions {
    rangeForward?: number; // Seconds to look ahead
    rangeBackward?: number; // Seconds to look behind
    fps?: number; // Sampling rate for background rendering
}

/**
 * useBackgroundRenderer detects idle time and pre-renders frames around the current playhead.
 * This fills the FrameCache, making future scrubbing or playback instantaneous.
 */
export function useBackgroundRenderer(options: BackgroundRendererOptions = {}) {
    const { rangeForward = 5, rangeBackward = 2, fps = 10 } = options;

    const { isPlaying, currentTime } = usePlaybackStore();
    const { videoFile } = useVideoStore();

    const idleTimeoutRef = useRef<number | null>(null);
    const isRenderingRef = useRef(false);

    useEffect(() => {
        if (isPlaying || !videoFile) {
            if (idleTimeoutRef.current) {
                clearTimeout(idleTimeoutRef.current);
                idleTimeoutRef.current = null;
            }
            return;
        }

        const startBackgroundRendering = () => {
            if (isRenderingRef.current) return;
            isRenderingRef.current = true;

            const framesToRender: number[] = [];
            const step = 1 / fps;

            // Phase 1: Near Forward (Priority 1) - Next 2 seconds
            for (let t = currentTime + step; t <= currentTime + 2; t += step) {
                if (!frameCache.hasFrame('preview', t)) {
                    framesToRender.push(t);
                }
            }

            // Phase 2: Far Forward (Priority 2) - Up to rangeForward
            for (let t = currentTime + 2 + step; t <= currentTime + rangeForward; t += step) {
                if (!frameCache.hasFrame('preview', t)) {
                    framesToRender.push(t);
                }
            }

            // Phase 3: Backward (Priority 3)
            for (let t = currentTime - step; t >= Math.max(0, currentTime - rangeBackward); t -= step) {
                if (!frameCache.hasFrame('preview', t)) {
                    framesToRender.push(t);
                }
            }

            if (framesToRender.length === 0) {
                isRenderingRef.current = false;
                return;
            }

            // Render frames sequentially to avoid overloading the decoder
            const renderNext = async (index: number) => {
                if (index >= framesToRender.length || isPlaying) {
                    isRenderingRef.current = false;
                    return;
                }

                try {
                    // This will fill the cache. isPriority: false ensures we don't block the main renderer.
                    await videoCache.getFrameAt('preview', videoFile, framesToRender[index], false);
                } catch (e) {
                    console.warn('Background render failed for time:', framesToRender[index], e);
                }

                // Schedule next frame in the next "idle" period or small timeout
                if ('requestIdleCallback' in window) {
                    (window as unknown as { requestIdleCallback: (cb: () => void, options?: { timeout: number }) => void }).requestIdleCallback(
                        () => renderNext(index + 1),
                        { timeout: 200 }
                    );
                } else {
                    setTimeout(() => renderNext(index + 1), 16);
                }
            };

            renderNext(0);
        };

        // Wait for 500ms of idle time before starting background rendering
        idleTimeoutRef.current = window.setTimeout(startBackgroundRendering, 500);

        return () => {
            if (idleTimeoutRef.current) {
                clearTimeout(idleTimeoutRef.current);
            }
        };
    }, [isPlaying, currentTime, videoFile, rangeForward, rangeBackward, fps]);
}
