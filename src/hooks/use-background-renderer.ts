'use client';

import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePlaybackStore } from '@/stores/playback-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { videoCache } from '@/lib/video-cache';
import { buildClipPlacements } from '@/lib/video-timeline';
import { secondsToFrames } from '@/lib/render-profile';
import { buildPreviewWarmupFramePlan } from '@/lib/video-frame-plan';
import { PreviewWarmupQueue } from '@/lib/preview-warmup-queue';
import { usePreviewTargetResolution } from '@/lib/preview-target-resolution';
import type { VideoSourceAssetV3 } from '@/types/video';
import type {
    PreviewWarmupFrame,
    PreviewWarmupPlanIdentity,
    VideoFrameRequest,
    VideoFrameTargetResolution,
} from '@/lib/video-runtime-types';

interface BackgroundRendererOptions {
    rangeForward?: number;
    rangeBackward?: number;
    fps?: number;
    playbackLookaheadFrames?: number;
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

export function buildPreviewWarmupRequest(
    source: VideoSourceAssetV3,
    planned: PreviewWarmupFrame,
    targetResolution: VideoFrameTargetResolution,
    signal: AbortSignal,
    warmupPlan: PreviewWarmupPlanIdentity,
): VideoFrameRequest {
    return {
        scope: 'warmup',
        sourceId: source.id,
        sourceFingerprint: source.fingerprint,
        file: source.file,
        sourceTime: planned.sourceTime,
        sourceFps: source.fps,
        targetResolution,
        signal,
        warmupPlan,
    };
}

/** Warms a bounded project-frame runway without competing with visible frame requests. */
export function useBackgroundRenderer(options: BackgroundRendererOptions = {}) {
    const {
        rangeForward = 5,
        rangeBackward = 2,
        fps = 10,
        playbackLookaheadFrames = 12,
    } = options;
    const { videoSources, videoClips, projectFrameRate } = useTimelineStore(useShallow((state) => ({
        videoSources: state.videoSources,
        videoClips: state.videoClips,
        projectFrameRate: state.renderProfile.fps,
    })));
    const targetResolution = usePreviewTargetResolution();
    const placements = useMemo(
        () => buildClipPlacements(videoClips, projectFrameRate),
        [projectFrameRate, videoClips],
    );
    const sourcesById = useMemo(
        () => new Map(videoSources.map((source) => [source.id, source])),
        [videoSources],
    );

    useEffect(() => {
        if (!targetResolution || videoSources.length === 0 || placements.length === 0) return;
        let pausedStartTimer: number | null = null;
        const hasFrame = (frame: PreviewWarmupFrame) => {
            const source = sourcesById.get(frame.sourceId);
            return source ? videoCache.hasCachedPreviewFrame(
                source.id,
                source.fingerprint,
                frame.sourceFrameIndex,
            ) : false;
        };
        const queue = new PreviewWarmupQueue({
            hasFrame,
            schedule: requestIdle,
            request: async (planned, signal, warmupPlan) => {
                const source = sourcesById.get(planned.sourceId);
                if (!source) return;
                const result = await videoCache.requestFrame(buildPreviewWarmupRequest(
                    source,
                    planned,
                    targetResolution,
                    signal,
                    warmupPlan,
                ));
                // Warmup needs cache residency, not a render lease. Releasing immediately keeps
                // later viewport clears and LRU eviction able to close the bitmap promptly.
                result?.release();
            },
            onError: (error) => console.warn('Background frame warmup failed:', error),
        });

        const clearPausedStart = () => {
            if (pausedStartTimer === null) return;
            window.clearTimeout(pausedStartTimer);
            pausedStartTimer = null;
        };
        const enqueuePlan = (playback: ReturnType<typeof usePlaybackStore.getState>) => {
            const currentProjectFrameIndex = secondsToFrames(
                Math.max(0, playback.currentTime),
                projectFrameRate,
                'floor',
            );
            const frames = buildPreviewWarmupFramePlan({
                isPlaying: playback.isPlaying,
                currentProjectFrameIndex,
                projectFrameRate,
                placements,
                sources: videoSources,
                rangeForward,
                rangeBackward,
                sparseFps: fps,
                playbackLookaheadFrames,
                hasFrame: (sourceId, sourceFrameIndex) => {
                    const source = sourcesById.get(sourceId);
                    return source ? videoCache.hasCachedPreviewFrame(
                        sourceId,
                        source.fingerprint,
                        sourceFrameIndex,
                    ) : false;
                },
            });
            queue.enqueue(
                frames,
                playback.isPlaying ? currentProjectFrameIndex : undefined,
            );
        };
        const scheduleForState = (playback: ReturnType<typeof usePlaybackStore.getState>) => {
            clearPausedStart();
            if (playback.isPlaying) {
                enqueuePlan(playback);
                return;
            }
            // Finish the one in-flight frame but discard the old active-playback runway. Paused
            // broad warmup begins after the same quiet period used by the previous implementation.
            queue.enqueue([], Number.MAX_SAFE_INTEGER);
            pausedStartTimer = window.setTimeout(() => enqueuePlan(usePlaybackStore.getState()), 500);
        };

        let previousFrameIndex = secondsToFrames(
            Math.max(0, usePlaybackStore.getState().currentTime),
            projectFrameRate,
            'floor',
        );
        scheduleForState(usePlaybackStore.getState());
        const unsubscribePlayback = usePlaybackStore.subscribe((playback, previous) => {
            const nextFrameIndex = secondsToFrames(
                Math.max(0, playback.currentTime),
                projectFrameRate,
                'floor',
            );
            if (playback.isPlaying !== previous.isPlaying) {
                previousFrameIndex = nextFrameIndex;
                scheduleForState(playback);
                return;
            }
            if (playback.isPlaying && nextFrameIndex !== previousFrameIndex) {
                previousFrameIndex = nextFrameIndex;
                enqueuePlan(playback);
            }
        });
        const handleSeek = () => {
            // Unlike normal clock ticks, a seek changes the desired runway discontinuously. Abort
            // the old decode generation before planning from the exact new transport position.
            queue.reset();
            previousFrameIndex = secondsToFrames(
                Math.max(0, usePlaybackStore.getState().currentTime),
                projectFrameRate,
                'floor',
            );
            scheduleForState(usePlaybackStore.getState());
        };
        window.addEventListener('playback-seek', handleSeek);

        return () => {
            clearPausedStart();
            unsubscribePlayback();
            window.removeEventListener('playback-seek', handleSeek);
            queue.dispose();
        };
    }, [
        fps,
        placements,
        playbackLookaheadFrames,
        projectFrameRate,
        rangeBackward,
        rangeForward,
        sourcesById,
        targetResolution,
        videoSources,
    ]);
}
