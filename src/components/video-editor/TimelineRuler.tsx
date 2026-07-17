'use client';

import { useTimelineStore } from '@/stores/timeline-store';
import { usePlaybackStore } from '@/stores/playback-store';
import { useEffect, useMemo, useState } from 'react';
import { videoCache } from '@/lib/video-cache';
import { buildClipPlacements, getMediaDuration } from '@/lib/video-timeline';
import { buildAudioClipSnapPoints, buildVideoClipSnapPoints } from '@/lib/timeline-snap';
import { framesToSeconds } from '@/lib/render-profile';

interface TimelineRulerProps {
    duration: number;
    fps: number;
    zoomLevel: number;
    pixelsPerSecond: number;
    onTimeUpdate?: (time: number) => void;
}

export function TimelineRuler({ duration, fps, zoomLevel, pixelsPerSecond, onTimeUpdate }: TimelineRulerProps) {
    const pps = pixelsPerSecond * zoomLevel;
    const frameDuration = fps > 0 ? 1 / fps : 0.1;

    const snapTime = (time: number) => {
        if (!fps) return time;
        return Math.round(time / frameDuration) * frameDuration;
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        const {
            audioSources,
            audioTracks,
            cuts,
            renderProfile,
            snapEnabled,
            tracks,
            videoSources,
            setIsDragging,
        } = useTimelineStore.getState();
        setIsDragging(true);

        const scrollEl = e.currentTarget;

        // One-shot snap points
        const snapPoints: number[] = [];
        if (snapEnabled) {
            const { videoClips } = useTimelineStore.getState();
            const mediaDuration = getMediaDuration(videoClips, renderProfile.fps);

            const points = new Set<number>([0, mediaDuration, duration]);
            buildVideoClipSnapPoints(videoClips, renderProfile.fps)
                .forEach((point) => points.add(framesToSeconds(point.frame, renderProfile.fps)));
            tracks.forEach(t => {
                t.subtitles.forEach(s => {
                    points.add(s.startTime);
                    points.add(s.endTime);
                });
            });
            cuts.forEach(c => {
                points.add(c.timeSec);
            });
            buildAudioClipSnapPoints(audioTracks, renderProfile.fps, videoSources, audioSources)
                .forEach((point) => points.add(framesToSeconds(point.frame, renderProfile.fps)));
            snapPoints.push(...Array.from(points));
        }

        const applySnap = (rawTime: number) => {
            if (!snapEnabled || snapPoints.length === 0) return rawTime;

            const thresholdSeconds = 15 / pps;
            let minDiff = thresholdSeconds;
            let closestPoint = rawTime;
            let foundSnap = false;

            snapPoints.forEach(point => {
                const diff = Math.abs(rawTime - point);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestPoint = point;
                    foundSnap = true;
                }
            });

            return foundSnap ? closestPoint : rawTime;
        };

        const updateTime = (clientX: number) => {
            const scrollContainer = scrollEl.parentElement;
            if (!scrollContainer) return;

            const viewportRect = scrollContainer.getBoundingClientRect();
            const x = clientX - viewportRect.left;
            const scrollLeft = scrollContainer.scrollLeft;
            const rawTime = Math.max(0, Math.min(duration, (scrollLeft + x) / pps));
            onTimeUpdate?.(snapTime(applySnap(rawTime)));
        };

        updateTime(e.clientX);

        const handleMouseMove = (moveEvent: MouseEvent) => {
            updateTime(moveEvent.clientX);
        };

        const handleMouseUp = () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            useTimelineStore.getState().setIsDragging(false);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    };

    const getIntervals = (currentPps: number) => {
        const targetLabelSpace = 200;
        const potentialIntervals = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 3600];
        const labelInt = potentialIntervals.find(v => v * currentPps >= targetLabelSpace) || potentialIntervals[potentialIntervals.length - 1];
        const targetMarkerSpace = 10;
        const markerInt = potentialIntervals.find(v => v * currentPps >= targetMarkerSpace) || 1;

        return {
            labelInt: Math.max(labelInt, markerInt),
            markerInt
        };
    };

    const { labelInt, markerInt } = getIntervals(pps);
    const pixelsPerFrame = pps * frameDuration;
    const showFrameTicks = pixelsPerFrame > 5;
    const showIntermediateTicks = pixelsPerFrame > 2;

    const markers: React.ReactNode[] = [];
    const formatTime = (t: number) => {
        const h = Math.floor(t / 3600);
        const m = Math.floor((t % 3600) / 60);
        const s = Math.floor(t % 60);
        if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    for (let time = 0; time <= duration + 0.001; time += markerInt) {
        const currentTime = Math.min(time, duration);
        const left = Math.round(currentTime * pps);
        const isLabel = Math.abs(currentTime % labelInt) < 0.001 || Math.abs((currentTime % labelInt) - labelInt) < 0.001;

        markers.push(
            <div key={`m-${currentTime}`}>
                <div
                    className={`absolute bottom-0 w-px ${isLabel ? 'h-full bg-gray-500' : 'h-4 bg-gray-700/60'}`}
                    style={{ left: `${left}px` }}
                />
                {isLabel && (
                    <span
                        className="absolute top-1 text-[10px] text-gray-400 select-none whitespace-nowrap"
                        style={{ left: `${left + 4}px` }}
                    >
                        {formatTime(currentTime)}
                    </span>
                )}
                {markerInt <= 1 && (showFrameTicks || showIntermediateTicks) && (() => {
                    const ticks = [];
                    const nextMarkerTime = currentTime + markerInt;
                    const startFrame = Math.floor(currentTime * fps + 0.001) + 1;
                    const endFrame = Math.floor(nextMarkerTime * fps - 0.001);

                    for (let f = startFrame; f <= endFrame; f++) {
                        const frameTime = f / fps;
                        if (frameTime > duration + 0.0001) continue;
                        const frameLeft = Math.round(frameTime * pps);
                        if (pixelsPerFrame > 2) {
                            ticks.push(
                                <div
                                    key={`frame-${f}`}
                                    className="absolute bottom-0 w-px h-1.5 bg-gray-800/80"
                                    style={{ left: `${frameLeft}px` }}
                                />
                            );
                        }
                    }
                    return ticks;
                })()}
            </div>
        );
    }

    return (
        <div
            className="relative h-8 bg-gray-800/50 border-b border-gray-700 select-none cursor-pointer"
            data-testid="timeline-ruler"
            data-duration-seconds={duration}
            style={{ width: `${duration * pps}px` }}
            onMouseDown={handleMouseDown}
        >
            <TimelineCacheIndicator duration={duration} pps={pps} />
            {markers}
        </div>
    );
}

function TimelineCacheIndicator({ pps }: { duration: number; pps: number }) {
    const [cachedSegments, setCachedSegments] = useState<{ start: number; end: number }[]>([]);
    const fps = usePlaybackStore(s => s.fps);
    const videoClips = useTimelineStore((state) => state.videoClips);
    const videoSources = useTimelineStore((state) => state.videoSources);
    const sourceFingerprints = useMemo(
        () => new Map(videoSources.map((source) => [source.id, source.fingerprint])),
        [videoSources],
    );
    const frameDuration = fps > 0 ? 1 / fps : 0.033;

    useEffect(() => {
        const updateSegments = () => {
            const timestamps = buildClipPlacements(videoClips).flatMap((placement) => {
                const sourceFingerprint = sourceFingerprints.get(placement.clip.sourceId);
                if (!sourceFingerprint) return [];
                return videoCache.getCachedPreviewTimestamps(
                    placement.clip.sourceId,
                    sourceFingerprint,
                )
                    .filter((sourceTime) => (
                        sourceTime >= placement.clip.sourceStart
                        && sourceTime < placement.clip.sourceEnd
                    ))
                    .map((sourceTime) => (
                        placement.projectStart + sourceTime - placement.clip.sourceStart
                    ));
            }).sort((left, right) => left - right);
            if (timestamps.length === 0) {
                setCachedSegments([]);
                return;
            }

            const segments: { start: number; end: number }[] = [];
            let currentSegment: { start: number; end: number } | null = null;
            const threshold = frameDuration * 1.5;

            timestamps.forEach((t) => {
                if (!currentSegment) {
                    currentSegment = { start: t, end: t };
                } else if (t - currentSegment.end <= threshold) {
                    currentSegment.end = t;
                } else {
                    segments.push(currentSegment);
                    currentSegment = { start: t, end: t };
                }
            });

            if (currentSegment) {
                segments.push(currentSegment);
            }

            setCachedSegments(segments);
        };

        const interval = setInterval(updateSegments, 500);
        updateSegments();
        return () => clearInterval(interval);
    }, [frameDuration, sourceFingerprints, videoClips]);

    if (cachedSegments.length === 0) return null;

    return (
        <div className="absolute bottom-0 left-0 right-0 h-[3px] pointer-events-none z-10 overflow-hidden">
            {cachedSegments.map((seg, i) => {
                const startSnapped = Math.floor(seg.start * fps + 0.01) / fps;
                const endSnapped = Math.floor(seg.end * fps + 0.01) / fps;
                const left = Math.round(startSnapped * pps);
                const right = Math.round((endSnapped + frameDuration) * pps);
                const width = Math.max(1, right - left);

                return (
                    <div
                        key={i}
                        className="absolute h-full bg-green-500/30"
                        style={{
                            left: `${left}px`,
                            width: `${width}px`,
                        }}
                    />
                );
            })}
        </div>
    );
}
