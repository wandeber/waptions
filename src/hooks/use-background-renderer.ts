'use client';

import { useEffect, useMemo, useRef } from 'react';
import { usePlaybackStore } from '@/stores/playback-store';
import { useVideoStore } from '@/stores/video-store';
import { videoCache } from '@/lib/video-cache';
import { frameCache } from '@/lib/frame-cache';
import { frameIndexToTime, normalizeFps, timeToFrameIndex } from '@/lib/frame-utils';

interface BackgroundRendererOptions {
    rangeForward?: number; // Seconds to look ahead while idle.
    rangeBackward?: number; // Seconds to look behind while idle.
    fps?: number; // Sparse idle sampling rate after the dense near window.
    playbackLookaheadFrames?: number;
}

interface WarmupFramePlanOptions {
    isPlaying: boolean;
    currentFrameIndex: number;
    cacheFps: number;
    rangeForward: number;
    rangeBackward: number;
    sparseFps: number;
    playbackLookaheadFrames: number;
    hasFrame: (frameIndex: number) => boolean;
}

export function buildPreviewWarmupFramePlan({
    isPlaying,
    currentFrameIndex,
    cacheFps,
    rangeForward,
    rangeBackward,
    sparseFps,
    playbackLookaheadFrames,
    hasFrame,
}: WarmupFramePlanOptions): number[] {
    const frames: number[] = [];
    const seen = new Set<number>();
    const pushMissingFrame = (frameIndex: number) => {
        if (seen.has(frameIndex) || hasFrame(frameIndex)) return;
        seen.add(frameIndex);
        frames.push(frameIndex);
    };

    if (isPlaying) {
        for (let offset = 1; offset <= playbackLookaheadFrames; offset += 1) {
            pushMissingFrame(currentFrameIndex + offset);
        }
        return frames;
    }

    const denseForwardFrames = Math.round(Math.min(2, rangeForward) * cacheFps);
    const sparseStep = Math.max(1, Math.round(cacheFps / Math.max(1, sparseFps)));
    const farForwardFrames = Math.round(rangeForward * cacheFps);
    const backwardFrames = Math.round(rangeBackward * cacheFps);

    for (let offset = 1; offset <= denseForwardFrames; offset += 1) {
        pushMissingFrame(currentFrameIndex + offset);
    }

    for (let offset = denseForwardFrames + sparseStep; offset <= farForwardFrames; offset += sparseStep) {
        pushMissingFrame(currentFrameIndex + offset);
    }

    for (let offset = sparseStep; offset <= backwardFrames; offset += sparseStep) {
        pushMissingFrame(Math.max(0, currentFrameIndex - offset));
    }

    return frames;
}

const requestIdle = (callback: () => void) => {
    if ('requestIdleCallback' in window) {
        (window as unknown as {
            requestIdleCallback: (cb: () => void, options?: { timeout: number }) => void;
        }).requestIdleCallback(callback, { timeout: 200 });
    } else {
        globalThis.setTimeout(callback, 16);
    }
};

/**
 * Warms preview frames around the playhead without competing with visible
 * rendering. Idle warmup prepares a wider range, while playback warmup keeps a
 * short full-fps runway so pressing play can consume already-decoded frames.
 */
export function useBackgroundRenderer(options: BackgroundRendererOptions = {}) {
    const {
        rangeForward = 5,
        rangeBackward = 2,
        fps = 10,
        playbackLookaheadFrames = 12,
    } = options;

    const { isPlaying, currentTime } = usePlaybackStore();
    const { videoFile, fps: sourceFps } = useVideoStore();
    const cacheFps = normalizeFps(sourceFps);
    const currentFrameIndex = useMemo(
        () => timeToFrameIndex(currentTime, cacheFps),
        [currentTime, cacheFps]
    );

    const runIdRef = useRef(0);
    const idleTimeoutRef = useRef<number | null>(null);

    useEffect(() => {
        runIdRef.current += 1;
        const runId = runIdRef.current;

        if (idleTimeoutRef.current) {
            window.clearTimeout(idleTimeoutRef.current);
            idleTimeoutRef.current = null;
        }

        if (!videoFile) return;

        const renderFrames = async (frames: number[], index = 0): Promise<void> => {
            if (runIdRef.current !== runId || index >= frames.length) return;

            const frameIndex = frames[index];
            if (!frameCache.hasFrameAtIndex('preview', frameIndex)) {
                try {
                    await videoCache.getFrameAt(
                        'preview',
                        videoFile,
                        frameIndexToTime(frameIndex, cacheFps),
                        { mode: 'warmup', fps: cacheFps }
                    );
                } catch (error) {
                    console.warn('Background frame warmup failed:', error);
                }
            }

            requestIdle(() => {
                void renderFrames(frames, index + 1);
            });
        };

        const start = () => {
            const frames = buildPreviewWarmupFramePlan({
                isPlaying,
                currentFrameIndex,
                cacheFps,
                rangeForward,
                rangeBackward,
                sparseFps: fps,
                playbackLookaheadFrames,
                hasFrame: (frameIndex) => frameCache.hasFrameAtIndex('preview', frameIndex),
            });
            if (frames.length > 0) {
                void renderFrames(frames);
            }
        };

        if (isPlaying) {
            start();
        } else {
            idleTimeoutRef.current = window.setTimeout(start, 500);
        }

        return () => {
            runIdRef.current += 1;
            if (idleTimeoutRef.current) {
                window.clearTimeout(idleTimeoutRef.current);
                idleTimeoutRef.current = null;
            }
        };
    }, [
        cacheFps,
        currentFrameIndex,
        fps,
        isPlaying,
        playbackLookaheadFrames,
        rangeBackward,
        rangeForward,
        videoFile,
    ]);
}
