'use client';

import { useState, useRef, useCallback } from 'react';

export interface Subtitle {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
}

type DragMode = 'move' | 'resize-start' | 'resize-end' | null;

interface SubtitleTrackProps {
  duration: number;
  currentTime: number;
  onSubtitleClick?: (subtitle: Subtitle) => void;
  subtitles: Subtitle[];
  onSubtitlesChange?: (subtitles: Subtitle[]) => void;
  selectedSubtitleId?: string | null;
}

export function SubtitleTrack({ 
  duration, 
  currentTime, 
  onSubtitleClick,
  subtitles,
  onSubtitlesChange,
  selectedSubtitleId
}: SubtitleTrackProps) {
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [dragStartTime, setDragStartTime] = useState<number>(0);
  const [draggedSubtitle, setDraggedSubtitle] = useState<Subtitle | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const getTimeFromX = useCallback((x: number) => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const percentage = Math.max(0, Math.min(1, x / rect.width));
    return percentage * duration;
  }, [duration]);

  const handleMouseDown = (e: React.MouseEvent, subtitle: Subtitle) => {
    if (!trackRef.current) return;

    const rect = trackRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const subtitleLeft = (subtitle.startTime / duration) * rect.width;
    const subtitleRight = (subtitle.endTime / duration) * rect.width;
    const handleWidth = 10;

    // Determinar el modo de arrastre
    if (Math.abs(x - subtitleLeft) <= handleWidth) {
      setDragMode('resize-start');
    } else if (Math.abs(x - subtitleRight) <= handleWidth) {
      setDragMode('resize-end');
    } else {
      setDragMode('move');
    }

    setDragStartTime(getTimeFromX(e.clientX - rect.left));
    setDraggedSubtitle(subtitle);
    onSubtitleClick?.(subtitle);
  };

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragMode || !draggedSubtitle || !onSubtitlesChange || !trackRef.current) return;

    const currentTime = getTimeFromX(e.clientX - trackRef.current.getBoundingClientRect().left);
    const timeDiff = currentTime - dragStartTime;

    const updatedSubtitle = { ...draggedSubtitle };
    
    switch (dragMode) {
      case 'move':
        const duration = draggedSubtitle.endTime - draggedSubtitle.startTime;
        updatedSubtitle.startTime = Math.max(0, draggedSubtitle.startTime + timeDiff);
        updatedSubtitle.endTime = updatedSubtitle.startTime + duration;
        break;
      case 'resize-start':
        updatedSubtitle.startTime = Math.min(
          Math.max(0, currentTime),
          draggedSubtitle.endTime - 0.1
        );
        break;
      case 'resize-end':
        updatedSubtitle.endTime = Math.max(
          draggedSubtitle.startTime + 0.1,
          currentTime
        );
        break;
    }

    onSubtitlesChange(
      subtitles.map(s => s.id === draggedSubtitle.id ? updatedSubtitle : s)
    );
  }, [dragMode, draggedSubtitle, dragStartTime, onSubtitlesChange, subtitles, getTimeFromX]);

  const handleMouseUp = () => {
    setDragMode(null);
    setDraggedSubtitle(null);
  };

  const getSubtitleCursor = useCallback((subtitle: Subtitle, x: number) => {
    if (!trackRef.current) return 'pointer';

    const rect = trackRef.current.getBoundingClientRect();
    const subtitleLeft = (subtitle.startTime / duration) * rect.width;
    const subtitleRight = (subtitle.endTime / duration) * rect.width;
    const handleWidth = 10;

    if (Math.abs(x - subtitleLeft) <= handleWidth) {
      return 'w-resize';
    } else if (Math.abs(x - subtitleRight) <= handleWidth) {
      return 'e-resize';
    }
    return 'move';
  }, [duration]);

  return (
    <div 
      ref={trackRef}
      className="absolute top-8 left-0 w-full h-12 bg-gray-800 border-t border-b border-gray-600"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {subtitles.map(subtitle => (
        <div
          key={subtitle.id}
          className={`absolute top-0 h-full bg-blue-600 opacity-75 rounded
            hover:opacity-90 transition-opacity
            ${subtitle.id === selectedSubtitleId ? 'ring-2 ring-white' : ''}`}
          style={{
            left: `${(subtitle.startTime / duration) * 100}%`,
            width: `${((subtitle.endTime - subtitle.startTime) / duration) * 100}%`,
            cursor: dragMode && draggedSubtitle?.id === subtitle.id 
              ? dragMode === 'move' ? 'move' : dragMode === 'resize-start' ? 'w-resize' : 'e-resize'
              : 'pointer'
          }}
          onMouseDown={(e) => handleMouseDown(e, subtitle)}
          onMouseMove={(e) => {
            if (!dragMode) {
              const rect = trackRef.current?.getBoundingClientRect();
              if (rect) {
                const x = e.clientX - rect.left;
                e.currentTarget.style.cursor = getSubtitleCursor(subtitle, x);
              }
            }
          }}
        />
      ))}
    </div>
  );
} 