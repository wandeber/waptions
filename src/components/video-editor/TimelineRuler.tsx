'use client';

import { useTimelineStore } from '@/stores/timeline-store';

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

        const updateTime = (clientX: number) => {
            const x = clientX - rect.left;
            const rawTime = Math.max(0, Math.min(duration, x / pps));
            onTimeUpdate?.(snapTime(rawTime));
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

    const getTimeInterval = (z: number) => {
        const currentPps = pixelsPerSecond * z;
        if (currentPps >= 400) return 0.1;
        if (currentPps >= 200) return 0.5;
        if (currentPps >= 100) return 1;
        if (currentPps >= 50) return 2;
        if (currentPps >= 25) return 5;
        if (currentPps >= 10) return 10;
        return 30;
    };

    const interval = getTimeInterval(zoom);
    const markerCount = Math.ceil(duration / interval) + 1;

    // Drawing frames as small dots if zoomed in enough
    const framesPerInterval = interval / frameDuration;
    const showFrameDots = (pps * frameDuration) > 5; // Pixels per frame > 5px

    const markers = Array.from({ length: markerCount }, (_, i) => {
        const time = i * interval;
        if (time > duration) return null;

        const left = time * pps;
        const isMainMarker = interval >= 1 ? (time % Math.max(1, Math.floor(interval * 5)) === 0) : (i % 10 === 0);

        const formatTime = (t: number) => {
            const m = Math.floor(t / 60);
            const s = Math.floor(t % 60);
            const f = Math.round((t % 1) * fps);
            return `${m}:${s.toString().padStart(2, '0')}${pps > 200 ? (':' + f.toString().padStart(2, '0')) : ''}`;
        };

        return (
            <div
                key={i}
                className="absolute top-0 border-l border-gray-600 h-full"
                style={{ left: `${left}px` }}
            >
                {isMainMarker && (
                    <span className="absolute top-1 left-1 text-[10px] text-gray-400 select-none whitespace-nowrap">
                        {formatTime(time)}
                    </span>
                )}
                <div className={`absolute bottom-0 left-0 w-px ${isMainMarker ? 'h-4 bg-gray-400' : 'h-2 bg-gray-600'}`} />

                {/* Frame dots between markers */}
                {showFrameDots && !isMainMarker && Array.from({ length: Math.floor(framesPerInterval) - 1 }).map((_, fIdx) => {
                    const frameTime = time + (fIdx + 1) * frameDuration;
                    if (frameTime >= time + interval || frameTime > duration) return null;
                    const frameLeft = (fIdx + 1) * frameDuration * pps;
                    return (
                        <div
                            key={fIdx}
                            className="absolute bottom-1 w-0.5 h-0.5 bg-gray-700 rounded-full"
                            style={{ left: `${frameLeft}px` }}
                        />
                    );
                })}
            </div>
        );
    });

    return (
        <div
            className="relative h-8 bg-gray-800/50 border-b border-gray-700 select-none cursor-pointer"
            style={{ width: `${duration * pps}px` }}
            onMouseDown={handleMouseDown}
        >
            {markers}
        </div>
    );
}
