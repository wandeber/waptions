'use client';

import { useTimelineStore } from '@/stores/timeline-store';
import { usePlaybackStore } from '@/stores/playback-store';
import { buildClipPlacements, getMediaDuration } from '@/lib/video-timeline';

interface TimelinePlayheadProps {
    duration: number;
    fps: number;
    zoomLevel: number;
    pixelsPerSecond: number;
    onTimeUpdate?: (time: number) => void;
}

export function TimelinePlayhead({
    duration,
    fps,
    zoomLevel,
    pixelsPerSecond,
    onTimeUpdate
}: TimelinePlayheadProps) {
    const currentTime = usePlaybackStore((state) => state.currentTime);
    const pps = pixelsPerSecond * zoomLevel;
    const left = currentTime * pps;
    const frameDuration = fps > 0 ? 1 / fps : 0.1;

    const snapTime = (time: number) => {
        if (fps <= 0) return time;
        return Math.round(time / frameDuration) * frameDuration;
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        e.stopPropagation();
        const parent = (e.currentTarget as HTMLElement).parentElement?.parentElement; // Up to synchronization container
        const { snapEnabled, tracks, setIsDragging } = useTimelineStore.getState();
        setIsDragging(true);

        // One-shot snap points
        const snapPoints: number[] = [];
        if (snapEnabled) {
            const { videoClips } = useTimelineStore.getState();
            const mediaDuration = getMediaDuration(videoClips);

            const points = new Set<number>([0, mediaDuration, duration]);
            buildClipPlacements(videoClips).forEach((placement) => {
                points.add(placement.projectStart);
                points.add(placement.projectEnd);
            });
            tracks.forEach(t => {
                t.subtitles.forEach(s => {
                    points.add(s.startTime);
                    points.add(s.endTime);
                });
            });
            snapPoints.push(...Array.from(points));
        }

        const handleMouseMove = (moveEvent: MouseEvent) => {
            if (!parent) return;
            const scrollContainer = parent.parentElement;
            if (!scrollContainer) return;

            const rect = scrollContainer.getBoundingClientRect();
            const x = moveEvent.clientX - rect.left;
            const scrollLeft = scrollContainer.scrollLeft;
            let targetTime = Math.max(0, Math.min(duration, (scrollLeft + x) / pps));

            if (snapEnabled && snapPoints.length > 0) {
                const thresholdSeconds = 15 / pps;
                let minDiff = thresholdSeconds;
                let closestPoint = targetTime;
                let foundSnap = false;

                snapPoints.forEach(point => {
                    const diff = Math.abs(targetTime - point);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestPoint = point;
                        foundSnap = true;
                    }
                });

                if (foundSnap) {
                    targetTime = closestPoint;
                }
            }

            onTimeUpdate?.(snapTime(targetTime));
        };

        const handleMouseUp = () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            useTimelineStore.getState().setIsDragging(false);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    };

    const pixelsPerFrame = fps > 0 ? pps / fps : 0;
    const showFrameHighlight = pixelsPerFrame > 2;

    // FIND CURRENT FRAME INDEX ROBUSTLY
    // +0.01 epsilon ensures that if currentTime is 1.0, we get frame index relative to 1.0 accurately
    const frameIndex = Math.floor(currentTime * fps + 0.01);
    const frameStartTime = frameIndex / fps;
    const highlightOffset = (currentTime - frameStartTime) * pps;

    return (
        <div
            className="absolute top-0 bottom-0 z-50 flex flex-col items-center group pointer-events-none"
            style={{
                left: `${left}px`,
                transform: 'translateX(-50%)',
                marginTop: '0px'
            }}
        >
            {/* current frame highlight area */}
            {showFrameHighlight && (
                <div
                    className="absolute top-0 bottom-0 bg-red-500/10 border-r border-red-500/20 pointer-events-none"
                    style={{
                        left: '50%',
                        width: `${pixelsPerFrame}px`,
                        transform: `translateX(${-highlightOffset}px)`
                    }}
                />
            )}

            {/* Cabezal (triángulo/diamante) */}
            <div
                className="w-5 h-5 bg-red-600 clip-playhead shadow-[0_0_10px_rgba(220,38,38,0.5)] group-hover:bg-red-500 transition-colors z-[60] cursor-ew-resize pointer-events-auto"
                onMouseDown={handleMouseDown}
            />

            {/* Línea vertical */}
            <div className="flex-1 w-[1px] bg-red-600 shadow-[0_0_5px_rgba(220,38,38,0.3)] z-[55]" />

            <style jsx>{`
                .clip-playhead {
                    clip-path: polygon(0% 0%, 100% 0%, 100% 50%, 50% 100%, 0% 50%);
                }
            `}</style>
        </div>
    );
}
