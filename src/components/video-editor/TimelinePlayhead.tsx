'use client';

import { useTimelineStore } from '@/stores/timeline-store';

interface TimelinePlayheadProps {
    currentTime: number;
    duration: number;
    fps: number;
    zoomLevel?: number;
    pixelsPerSecond?: number;
    onTimeUpdate?: (time: number) => void;
}

export function TimelinePlayhead({
    currentTime,
    duration,
    fps,
    zoomLevel: propZoom,
    pixelsPerSecond: propPPS,
    onTimeUpdate
}: TimelinePlayheadProps) {
    const store = useTimelineStore();
    const zoom = propZoom ?? store.zoomLevel;
    const basePPS = propPPS ?? store.pixelsPerSecond;

    const pps = basePPS * zoom;
    const left = currentTime * pps;
    const frameDuration = fps > 0 ? 1 / fps : 0.1;

    const snapTime = (time: number) => {
        if (fps <= 0) return time;
        return Math.round(time / frameDuration) * frameDuration;
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        e.stopPropagation();
        const parent = (e.currentTarget as HTMLElement).parentElement;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            if (!parent) return;
            const rect = parent.getBoundingClientRect();
            const x = moveEvent.clientX - rect.left;
            const rawTime = Math.max(0, Math.min(duration, x / pps));
            onTimeUpdate?.(snapTime(rawTime));
        };

        const handleMouseUp = () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    };

    const pixelsPerFrame = fps > 0 ? pps / fps : 0;
    const showFrameHighlight = pixelsPerFrame > 2;

    return (
        <div
            className="absolute top-0 bottom-0 z-50 flex flex-col items-center cursor-ew-resize group pointer-events-auto"
            style={{
                left: `${left}px`,
                transform: 'translateX(-50%)',
                marginTop: '0px'
            }}
            onMouseDown={handleMouseDown}
        >
            {/* current frame highlight area */}
            {showFrameHighlight && (
                <div
                    className="absolute top-0 bottom-0 bg-red-500/10 border-r border-red-500/20 pointer-events-none"
                    style={{
                        left: '50%',
                        width: `${pixelsPerFrame}px`
                    }}
                />
            )}

            {/* Cabezal (triángulo/diamante) */}
            <div className="w-5 h-5 bg-red-600 clip-playhead shadow-[0_0_10px_rgba(220,38,38,0.5)] group-hover:bg-red-500 transition-colors z-[60]" />

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
