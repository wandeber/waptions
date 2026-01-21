'use client';

import { useTimelineStore } from '@/stores/timeline-store';
import { Subtitle } from './SubtitleTrack';
import { SubtitleTrack } from '@/types/timeline';

interface TimelineTrackOverlayProps {
    duration: number;
    track: SubtitleTrack;
    zoomLevel: number;
    pixelsPerSecond: number;
    fps: number;
    onTimeUpdate?: (time: number) => void;
    onSubtitleClick?: (subtitle: Subtitle | null) => void;
    selectedSubtitleId?: string | null;
}

export function TimelineTrackOverlay({
    duration,
    track,
    zoomLevel,
    pixelsPerSecond,
    fps,
    onTimeUpdate,
    onSubtitleClick,
    selectedSubtitleId
}: TimelineTrackOverlayProps) {
    const updateSubtitleInTrack = useTimelineStore(state => state.updateSubtitleInTrack);
    const pps = pixelsPerSecond * zoomLevel;

    // Helper to calculate time from click
    const handleMouseClick = (e: React.MouseEvent) => {
        // Only trigger if click is directly on the track background, not on a subtitle block
        if (e.target !== e.currentTarget) return;

        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const time = Math.max(0, Math.min(duration, x / pps));
        onTimeUpdate?.(time);

        if (onSubtitleClick) {
            onSubtitleClick(null);
        }
    };

    return (
        <div
            className="relative h-14 border-b border-gray-800/50 hover:bg-white/5 transition-colors cursor-crosshair"
            style={{ width: `${duration * pps}px` }}
            onMouseDown={handleMouseClick}
        >
            {/* Subtitle Blocks */}
            {track.subtitles.map((subtitle) => (
                <SubtitleBlock
                    key={subtitle.id}
                    subtitle={subtitle}
                    pps={pps}
                    fps={fps}
                    isSelected={selectedSubtitleId === subtitle.id}
                    onClick={() => onSubtitleClick?.(subtitle)}
                    onUpdate={(updates) => updateSubtitleInTrack(track.id, subtitle.id, updates)}
                />
            ))}
        </div>
    );
}

// Internal component for Subtitle Block (simplification of current SubtitleTrack logic)
interface SubtitleBlockProps {
    subtitle: Subtitle;
    pps: number;
    fps: number;
    isSelected: boolean;
    onClick: () => void;
    onUpdate: (updates: Partial<Subtitle>) => void;
}

function SubtitleBlock({ subtitle, pps, fps, isSelected, onClick, onUpdate }: SubtitleBlockProps) {
    const left = subtitle.startTime * pps;
    const width = (subtitle.endTime - subtitle.startTime) * pps;

    const handleMouseDown = (e: React.MouseEvent, type: 'move' | 'resize-start' | 'resize-end') => {
        e.stopPropagation();
        if (!isSelected) onClick();

        const startX = e.clientX;
        const initialStart = subtitle.startTime;
        const initialEnd = subtitle.endTime;
        const frameDuration = fps > 0 ? 1 / fps : 0.01; // Default to 0.01s if fps is 0 or less

        const snapTime = (time: number) => {
            if (fps <= 0) return time;
            return Math.round(time / frameDuration) * frameDuration;
        };

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const deltaX = moveEvent.clientX - startX;
            const deltaTime = deltaX / pps;

            if (type === 'move') {
                const newStart = Math.max(0, snapTime(initialStart + deltaTime));
                const duration = initialEnd - initialStart;
                onUpdate({
                    startTime: newStart,
                    endTime: newStart + duration
                });
            } else if (type === 'resize-start') {
                const newStart = Math.max(0, Math.min(subtitle.endTime - 0.1, snapTime(initialStart + deltaTime)));
                onUpdate({ startTime: newStart });
            } else if (type === 'resize-end') {
                const newEnd = Math.max(subtitle.startTime + 0.1, snapTime(initialEnd + deltaTime));
                onUpdate({ endTime: newEnd });
            }
        };

        const handleMouseUp = () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    };

    return (
        <div
            className={`absolute top-2 bottom-2 rounded-md border text-[10px] flex items-center justify-center cursor-move select-none transition-shadow ${isSelected
                ? 'bg-yellow-500/30 border-yellow-500 z-20 shadow-[0_0_10px_rgba(234,179,8,0.3)]'
                : 'bg-blue-600/20 border-blue-500/50 hover:border-blue-400 z-10'
                }`}
            style={{
                left: `${left}px`,
                width: `${width}px`,
                minWidth: '4px'
            }}
            onMouseDown={(e) => handleMouseDown(e, 'move')}
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
        >
            <span className="px-2 truncate text-white/90 pointer-events-none">
                {subtitle.text}
            </span>

            {/* Drag Handles */}
            {isSelected && (
                <>
                    <div
                        className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-yellow-400/50 flex items-center justify-center group/handle"
                        onMouseDown={(e) => handleMouseDown(e, 'resize-start')}
                    >
                        <div className="w-[1px] h-3 bg-yellow-500/50 group-hover/handle:bg-yellow-500" />
                    </div>
                    <div
                        className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-yellow-400/50 flex items-center justify-center group/handle"
                        onMouseDown={(e) => handleMouseDown(e, 'resize-end')}
                    >
                        <div className="w-[1px] h-3 bg-yellow-500/50 group-hover/handle:bg-yellow-500" />
                    </div>
                </>
            )}
        </div>
    );
}
