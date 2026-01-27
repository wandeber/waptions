'use client';

import { useState, memo } from 'react';
import { useTimelineStore } from '@/stores/timeline-store';
import { usePlaybackStore } from '@/stores/playback-store';
import { useVideoStore } from '@/stores/video-store';
import { Subtitle, SubtitleTrack } from '@/types/timeline';

interface TimelineTrackOverlayProps {
    duration: number;
    track: SubtitleTrack;
    zoomLevel: number;
    pixelsPerSecond: number;
    fps: number;
    onTimeUpdate?: (time: number) => void;
    onSubtitleClick?: (subtitle: Subtitle | null) => void;
}

export const TimelineTrackOverlay = memo(function TimelineTrackOverlay({
    duration,
    track,
    zoomLevel,
    pixelsPerSecond,
    fps,
    onTimeUpdate,
    onSubtitleClick
}: TimelineTrackOverlayProps) {
    const { updateSubtitleInTrack, pushHistory, selectedSubtitleIds } = useTimelineStore();
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
                    isSelected={selectedSubtitleIds.includes(subtitle.id)}
                    onClick={() => onSubtitleClick?.(subtitle)}
                    onUpdate={(updates, options) => updateSubtitleInTrack(track.id, subtitle.id, updates, options)}
                    onPushHistory={pushHistory}
                    duration={duration}
                />
            ))}
        </div>
    );
});

// Internal component for Subtitle Block (simplification of current SubtitleTrack logic)
interface SubtitleBlockProps {
    subtitle: Subtitle;
    pps: number;
    fps: number;
    isSelected: boolean;
    onClick: () => void;
    onUpdate: (updates: Partial<Subtitle>, options?: { skipHistory?: boolean }) => void;
    onPushHistory: () => void;
    duration: number;
}

const SubtitleBlock = memo(function SubtitleBlock({ subtitle, fps, isSelected, onClick, onUpdate, onPushHistory }: SubtitleBlockProps) {
    const { pixelsPerSecond, zoomLevel } = useTimelineStore();
    const [activeHandle, setActiveHandle] = useState<'start' | 'end' | null>(null);
    const pps = pixelsPerSecond * zoomLevel;

    const handleMouseDown = (e: React.MouseEvent, type: 'move' | 'resize-start' | 'resize-end') => {
        e.stopPropagation();

        const {
            toggleSubtitleSelection,
            moveSubtitlesToTrack,
            updateSubtitleInTrack,
            setActiveSnapTime,
            snapEnabled,
            tracks: allTracks,
            setIsDragging
        } = useTimelineStore.getState();

        setIsDragging(true);

        // Handle selection toggle/multiselect
        const isMulti = e.metaKey;
        const isShift = e.shiftKey;

        if (type === 'move') {
            // If it's already selected and we are just clicking (no mods), we DON'T toggle yet
            // to allow dragging the selection. We toggle on onClick if it wasn't a drag.
            // But if it's NOT selected, or mods are pressed, we toggle immediately.
            if (!isSelected || isMulti || isShift) {
                toggleSubtitleSelection(subtitle.id, isMulti, isShift);
            }
        } else {
            // Resize always ensures selection of the single object
            if (!isSelected) toggleSubtitleSelection(subtitle.id);
        }

        if (type === 'resize-start') setActiveHandle('start');
        if (type === 'resize-end') setActiveHandle('end');

        // Capture initial state for ALL selected subtitles
        const currentSelectedIds = useTimelineStore.getState().selectedSubtitleIds;
        const targetIds = currentSelectedIds.includes(subtitle.id) ? currentSelectedIds : [subtitle.id];

        // Push history before starting the drag operation
        onPushHistory();

        const startX = e.clientX;
        const startY = e.clientY;
        // Note: we can also get it from refs, but tracksContentRef isn't easily accessible here.
        // Actually, we can just use the DOM since we are in a browser event.
        const tracksEl = document.querySelector('.overflow-x-scroll'); // The tracks container
        const startScroll = tracksEl?.scrollLeft || 0;

        // Map of subtitleId -> initial values for group movement
        const initialStates = new Map<string, { startTime: number, endTime: number, trackId: string }>();
        targetIds.forEach(id => {
            allTracks.forEach(t => {
                const sub = t.subtitles.find(s => s.id === id);
                if (sub) {
                    initialStates.set(id, {
                        startTime: sub.startTime,
                        endTime: sub.endTime,
                        trackId: t.id
                    });
                }
            });
        });

        const frameDuration = fps > 0 ? 1 / fps : 0.01;
        let lastShift = 0;

        // Group boundaries for snapping
        const groupMinStart = Math.min(...Array.from(initialStates.values()).map(s => s.startTime));
        const groupMaxEnd = Math.max(...Array.from(initialStates.values()).map(s => s.endTime));
        const groupDuration = groupMaxEnd - groupMinStart;

        // Collect snap points once (one-shot optimization)
        const snapPoints: { time: number, isInitial: boolean }[] = [];
        if (snapEnabled) {
            const pointsMap = new Map<number, boolean>(); // time -> isInitial

            const videoDuration = useVideoStore.getState().duration;
            const videoFrameDuration = fps > 0 ? 1 / fps : 1 / 30;
            const snappedVideoDuration = Math.round(videoDuration / videoFrameDuration) * videoFrameDuration;

            pointsMap.set(0, false);
            pointsMap.set(snappedVideoDuration, false);

            const playheadTime = usePlaybackStore.getState().currentTime;
            pointsMap.set(playheadTime, false);

            // Initial position (don't show line for these)
            pointsMap.set(groupMinStart, true);
            pointsMap.set(groupMaxEnd, true);

            allTracks.forEach(t => {
                t.subtitles.forEach(s => {
                    if (targetIds.includes(s.id)) return;
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

            const thresholdSeconds = 15 / pps;
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

            let finalTime = isEnd ? closestPoint - durOffset : closestPoint;

            // SACRED FRAMES: Final quantization to frame boundary
            finalTime = snapToFrame(finalTime);

            setActiveSnapTime(foundSnap && !snappedToInitial ? closestPoint : null);

            return {
                time: finalTime,
                isSnapped: foundSnap
            };
        };

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const currentScroll = tracksEl?.scrollLeft || 0;
            const scrollDelta = currentScroll - startScroll;
            const deltaX = moveEvent.clientX - startX;
            const deltaY = moveEvent.clientY - startY;
            const deltaTime = (deltaX + scrollDelta) / pps;

            const { setPreviewTime } = usePlaybackStore.getState();

            if (type === 'move') {
                // 1. Vertical track switching (Group)
                const trackIndexShift = Math.round(deltaY / 64);
                if (trackIndexShift !== lastShift) {
                    // Try to move all selected subtitles
                    moveSubtitlesToTrack(targetIds, trackIndexShift - lastShift, { skipHistory: true });
                    lastShift = trackIndexShift;
                }

                // 2. Horizontal movement (Group)
                let currentGroupStart = groupMinStart + deltaTime;

                if (snapEnabled) {
                    const snapStart = applySnap(currentGroupStart, false);
                    if (snapStart.isSnapped) {
                        currentGroupStart = snapStart.time;
                    } else {
                        const snapEnd = applySnap(currentGroupStart, true, groupDuration);
                        if (snapEnd.isSnapped) {
                            currentGroupStart = snapEnd.time;
                        }
                    }
                }

                currentGroupStart = Math.max(0, snapToFrame(currentGroupStart));
                const finalDeltaTime = currentGroupStart - groupMinStart;

                // Apply finalDeltaTime to all subtitles in the selection
                const currentTracks = useTimelineStore.getState().tracks;
                targetIds.forEach(id => {
                    const initial = initialStates.get(id);
                    if (!initial) return;

                    const activeTrack = currentTracks.find(t => t.subtitles.some(s => s.id === id));
                    if (activeTrack) {
                        const newStart = initial.startTime + finalDeltaTime;
                        updateSubtitleInTrack(activeTrack.id, id, {
                            startTime: newStart,
                            endTime: Number((newStart + (initial.endTime - initial.startTime)).toFixed(3))
                        }, { skipHistory: true });
                    }
                });

                setPreviewTime(currentGroupStart);
            } else if (type === 'resize-start' || type === 'resize-end') {
                // Resize still works on individual elements for now as per plan
                const initial = initialStates.get(subtitle.id);
                if (!initial) return;

                if (type === 'resize-start') {
                    let newStart = initial.startTime + deltaTime;
                    if (snapEnabled) {
                        newStart = applySnap(newStart, false).time;
                    }
                    newStart = Math.max(0, Math.min(subtitle.endTime - 0.1, snapToFrame(newStart)));
                    onUpdate({ startTime: newStart }, { skipHistory: true });
                    setPreviewTime(newStart);
                } else {
                    let newEnd = initial.endTime + deltaTime;
                    if (snapEnabled) {
                        newEnd = applySnap(newEnd, false).time;
                    }
                    newEnd = Math.max(subtitle.startTime + 0.1, snapToFrame(newEnd));
                    onUpdate({ endTime: newEnd }, { skipHistory: true });
                    setPreviewTime(newEnd);
                }
            }
        };

        const handleMouseUp = () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            useTimelineStore.getState().setActiveSnapTime(null);
            useTimelineStore.getState().setIsDragging(false);
            setActiveHandle(null);
            usePlaybackStore.getState().setPreviewTime(null);
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
});
