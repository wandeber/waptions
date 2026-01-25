'use client';

import { useTimelineStore } from '@/stores/timeline-store';
import { useState, useEffect } from 'react';
import { frameCache } from '@/lib/frame-cache';

interface TimelineRulerProps {
    duration: number;
    fps: number;
    zoomLevel?: number;
    pixelsPerSecond?: number;
    onTimeUpdate?: (time: number) => void;
}

export function TimelineRuler({ duration, fps, zoomLevel: propZoom, pixelsPerSecond: propPPS, onTimeUpdate }: TimelineRulerProps) {
    const store = useTimelineStore();
    const zoom = propZoom ?? store.zoomLevel;
    const pixelsPerSecond = propPPS ?? store.pixelsPerSecond;

    const pps = pixelsPerSecond * zoom;
    const frameDuration = fps > 0 ? 1 / fps : 0.1;

    const snapTime = (time: number) => {
        if (!fps) return time;
        return Math.round(time / frameDuration) * frameDuration;
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const { snapEnabled, tracks, cuts } = useTimelineStore.getState();

        // One-shot snap points
        const snapPoints: number[] = [];
        if (snapEnabled) {
            const points = new Set<number>([0, duration]);
            tracks.forEach(t => {
                t.subtitles.forEach(s => {
                    points.add(s.startTime);
                    points.add(s.endTime);
                });
            });
            cuts.forEach(c => {
                points.add(c.timeSec);
            });
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
            const x = clientX - rect.left;
            const rawTime = Math.max(0, Math.min(duration, x / pps));
            onTimeUpdate?.(snapTime(applySnap(rawTime)));
        };

        updateTime(e.clientX);

        const handleMouseMove = (moveEvent: MouseEvent) => {
            updateTime(moveEvent.clientX);
        };

        const handleMouseUp = () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    };

    const getIntervals = (currentPps: number) => {
        // We want labels to have more space to avoid dominance (at least 200px)
        const targetLabelSpace = 200;
        const potentialIntervals = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 3600];

        const labelInt = potentialIntervals.find(v => v * currentPps >= targetLabelSpace) || potentialIntervals[potentialIntervals.length - 1];

        // Marker behavior: non-labeled lines should be at least 10px apart to not clutter
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

    // Main marker loop - iterate by markerInterval
    for (let time = 0; time <= duration; time += markerInt) {
        const left = time * pps;
        const isLabel = time % labelInt === 0;

        markers.push(
            <div key={`m-${time}`}>
                {/* Tier 1 (Full) or Tier 2 (Medium) */}
                <div
                    className={`absolute bottom-0 w-px ${isLabel ? 'h-full bg-gray-500' : 'h-4 bg-gray-700/60'}`}
                    style={{ left: `${left}px` }}
                />

                {/* Label (Tier 1) */}
                {isLabel && (
                    <span
                        className="absolute top-1 text-[10px] text-gray-400 select-none whitespace-nowrap"
                        style={{ left: `${left + 4}px` }}
                    >
                        {formatTime(time)}
                    </span>
                )}

                {/* Tier 3: Detail ticks (frames or divisions) - only if marker interval is <= 1s */}
                {markerInt <= 1 && (showFrameTicks || showIntermediateTicks) && Array.from({ length: Math.ceil(fps) - 1 }).map((_, fIdx) => {
                    const frameNumber = fIdx + 1;
                    const frameTime = time + (frameNumber / fps);
                    if (frameTime > duration || frameTime > time + 0.999) return null;

                    const frameLeft = left + (frameNumber / fps * pps);
                    const isTickVisible = pixelsPerFrame > 2; // Threshold for showing any detail

                    if (!isTickVisible) return null;

                    return (
                        <div
                            key={`frame-${time}-${fIdx}`}
                            className="absolute bottom-0 w-px h-1.5 bg-gray-800/80"
                            style={{ left: `${frameLeft}px` }}
                        />
                    );
                })}
            </div>
        );
    }

    return (
        <div
            className="relative h-8 bg-gray-800/50 border-b border-gray-700 select-none cursor-pointer"
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

    useEffect(() => {
        const updateSegments = () => {
            const timestamps = frameCache.getCachedTimestamps('preview');
            if (timestamps.length === 0) {
                setCachedSegments([]);
                return;
            }

            // Group adjacent timestamps into segments
            const segments: { start: number; end: number }[] = [];
            let currentSegment: { start: number; end: number } | null = null;
            const threshold = 0.2; // 200ms gap max to consider adjacent

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
    }, []);

    if (cachedSegments.length === 0) return null;

    return (
        <div className="absolute bottom-0 left-0 right-0 h-[3px] pointer-events-none z-10 overflow-hidden">
            {cachedSegments.map((seg, i) => (
                <div
                    key={i}
                    className="absolute h-full bg-green-500/30"
                    style={{
                        left: `${seg.start * pps}px`,
                        width: `${Math.max(2, (seg.end - seg.start) * pps)}px`,
                    }}
                />
            ))}
        </div>
    );
}
