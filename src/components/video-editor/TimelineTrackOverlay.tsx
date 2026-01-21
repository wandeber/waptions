'use client';

import { useState } from 'react';
import { useTimelineStore } from '@/stores/timeline-store';
import { usePlaybackStore } from '@/stores/playback-store';
import { Subtitle, SubtitleTrack } from '@/types/timeline';

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
    const pushHistory = useTimelineStore(state => state.pushHistory);
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
            className="relative h-16 border-b border-gray-800/50 hover:bg-white/5 transition-colors cursor-crosshair"
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
                    onUpdate={(updates, options) => updateSubtitleInTrack(track.id, subtitle.id, updates, options)}
                    onPushHistory={pushHistory}
                    onTimeUpdate={onTimeUpdate}
                    duration={duration}
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
    onUpdate: (updates: Partial<Subtitle>, options?: { skipHistory?: boolean }) => void;
    onPushHistory: () => void;
    onTimeUpdate?: (time: number) => void;
    duration: number;
}

function SubtitleBlock({ subtitle, fps, isSelected, onClick, onUpdate, onPushHistory, onTimeUpdate, duration }: SubtitleBlockProps) {
    const { tracks, snapEnabled, setActiveSnapTime, pixelsPerSecond, zoomLevel } = useTimelineStore();
    const [activeHandle, setActiveHandle] = useState<'start' | 'end' | null>(null);
    const pps = pixelsPerSecond * zoomLevel;

    const handleMouseDown = (e: React.MouseEvent, type: 'move' | 'resize-start' | 'resize-end') => {
        e.stopPropagation();
        if (!isSelected) onClick();

        if (type === 'resize-start') setActiveHandle('start');
        if (type === 'resize-end') setActiveHandle('end');

        // Push history before starting the drag operation
        onPushHistory();

        const startX = e.clientX;
        const startY = e.clientY;
        const initialStart = subtitle.startTime;
        const initialEnd = subtitle.endTime;
        const frameDuration = fps > 0 ? 1 / fps : 0.01;
        const initialTrackIndex = tracks.findIndex(t => t.subtitles.some(s => s.id === subtitle.id));
        let lastShift = 0;

        // Collect snap points once (one-shot optimization)
        const snapPoints: { time: number, isInitial: boolean }[] = [];
        if (snapEnabled) {
            const pointsMap = new Map<number, boolean>(); // time -> isInitial

            // Base points
            pointsMap.set(0, false);
            pointsMap.set(duration, false);

            // Re-accessing store for playhead/current time
            const playheadTime = usePlaybackStore.getState().currentTime;
            pointsMap.set(playheadTime, false);

            // Initial position (don't show line for these)
            pointsMap.set(initialStart, true);
            pointsMap.set(initialEnd, true);

            tracks.forEach(t => {
                t.subtitles.forEach(s => {
                    if (s.id === subtitle.id) return;
                    pointsMap.set(s.startTime, false);
                    pointsMap.set(s.endTime, false);
                });
            });

            pointsMap.forEach((isInitial, time) => {
                snapPoints.push({ time, isInitial });
            });
        }

        const snapToFrame = (time: number) => {
            if (fps <= 0) return time;
            return Math.round(time / frameDuration) * frameDuration;
        };

        const applySnap = (time: number, isEnd = false, durOffset = 0) => {
            if (!snapEnabled || snapPoints.length === 0) {
                setActiveSnapTime(null);
                return { time, isSnapped: false };
            }

            const thresholdSeconds = 15 / pps; // Reduced to 15px
            const targetTime = isEnd ? time + durOffset : time;

            let closestPoint = targetTime;
            let minDiff = thresholdSeconds;
            let foundSnap = false;
            let snappedToInitial = false;

            snapPoints.forEach(point => {
                const diff = Math.abs(targetTime - point.time);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestPoint = point.time;
                    foundSnap = true;
                    snappedToInitial = point.isInitial;
                }
            });

            const finalTime = isEnd ? closestPoint - durOffset : closestPoint;

            // Don't show the line if it's snapping to the original position
            setActiveSnapTime(foundSnap && !snappedToInitial ? closestPoint : null);

            return {
                time: finalTime,
                isSnapped: foundSnap
            };
        };

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const deltaX = moveEvent.clientX - startX;
            const deltaY = moveEvent.clientY - startY;
            const deltaTime = deltaX / pps;

            if (type === 'move') {
                // Vertical track switching logic
                const trackIndexShift = Math.round(deltaY / 64);

                if (trackIndexShift !== lastShift) {
                    const targetTrackIndex = Math.max(0, Math.min(tracks.length - 1, initialTrackIndex + trackIndexShift));

                    // We need to know the track where the subtitle is RIGHT NOW to move it successfully
                    const currentTracks = useTimelineStore.getState().tracks;
                    const currentTrack = currentTracks.find(t => t.subtitles.some(s => s.id === subtitle.id));
                    const targetTrack = tracks[targetTrackIndex];

                    if (currentTrack && targetTrack && currentTrack.id !== targetTrack.id) {
                        useTimelineStore.getState().moveSubtitleToTrack(subtitle.id, currentTrack.id, targetTrack.id);
                        lastShift = trackIndexShift;
                    }
                }

                let newStart = initialStart + deltaTime;
                const duration = initialEnd - initialStart;

                if (snapEnabled) {
                    const snapStart = applySnap(newStart, false);
                    if (snapStart.isSnapped) {
                        newStart = snapStart.time;
                    } else {
                        const snapEnd = applySnap(newStart, true, duration);
                        if (snapEnd.isSnapped) {
                            newStart = snapEnd.time;
                        }
                    }
                }

                newStart = Math.max(0, snapToFrame(newStart));

                // Get current track because it might have changed due to vertical drag
                const currentTracks = useTimelineStore.getState().tracks;
                const activeTrack = currentTracks.find(t => t.subtitles.some(s => s.id === subtitle.id));

                if (activeTrack) {
                    useTimelineStore.getState().updateSubtitleInTrack(activeTrack.id, subtitle.id, {
                        startTime: newStart,
                        endTime: Number((newStart + duration).toFixed(3))
                    }, { skipHistory: true });
                }

                onTimeUpdate?.(newStart);
            } else if (type === 'resize-start') {
                let newStart = initialStart + deltaTime;
                if (snapEnabled) {
                    newStart = applySnap(newStart, false).time;
                }
                newStart = Math.max(0, Math.min(subtitle.endTime - 0.1, snapToFrame(newStart)));
                onUpdate({ startTime: newStart }, { skipHistory: true });
                onTimeUpdate?.(newStart);
            } else if (type === 'resize-end') {
                let newEnd = initialEnd + deltaTime;
                if (snapEnabled) {
                    newEnd = applySnap(newEnd, false).time;
                }
                newEnd = Math.max(subtitle.startTime + 0.1, snapToFrame(newEnd));
                onUpdate({ endTime: newEnd }, { skipHistory: true });
                onTimeUpdate?.(newEnd);
            }
        };

        const handleMouseUp = () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            setActiveSnapTime(null);
            setActiveHandle(null);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    };

    const left = subtitle.startTime * pps;
    const width = (subtitle.endTime - subtitle.startTime) * pps;

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
                        className={`absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize flex items-center justify-center group/handle transition-colors ${activeHandle === 'start' ? 'bg-yellow-400/50' : 'hover:bg-yellow-400/50'
                            }`}
                        onMouseDown={(e) => handleMouseDown(e, 'resize-start')}
                    >
                        <div className={`w-[1px] h-3 transition-colors ${activeHandle === 'start' ? 'bg-yellow-500' : 'bg-yellow-500/50 group-hover/handle:bg-yellow-500'
                            }`} />
                    </div>
                    <div
                        className={`absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize flex items-center justify-center group/handle transition-colors ${activeHandle === 'end' ? 'bg-yellow-400/50' : 'hover:bg-yellow-400/50'
                            }`}
                        onMouseDown={(e) => handleMouseDown(e, 'resize-end')}
                    >
                        <div className={`w-[1px] h-3 transition-colors ${activeHandle === 'end' ? 'bg-yellow-500' : 'bg-yellow-500/50 group-hover/handle:bg-yellow-500'
                            }`} />
                    </div>
                </>
            )}
        </div>
    );
}
