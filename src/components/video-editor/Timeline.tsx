'use client';

import { useRef, useState } from 'react';
import { SubtitleTrack, type Subtitle } from './SubtitleTrack';

interface TimelineProps {
  duration: number;
  currentTime?: number;
  onTimeUpdate?: (time: number) => void;
  onSubtitleClick?: (subtitle: Subtitle) => void;
  subtitles: Subtitle[];
  onSubtitlesChange?: (subtitles: Subtitle[]) => void;
  selectedSubtitleId?: string | null;
  isPlaying?: boolean;
  onPlayPause?: () => void;
}

export function Timeline({ 
  duration, 
  currentTime = 0, 
  onTimeUpdate,
  onSubtitleClick,
  subtitles,
  onSubtitlesChange,
  selectedSubtitleId,
  isPlaying = false,
  onPlayPause
}: TimelineProps) {
  const timelineRef = useRef<HTMLDivElement>(null);

  const handleTimelineClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current) return;
    
    const rect = timelineRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const percentage = x / rect.width;
    const newTime = percentage * duration;
    
    onTimeUpdate?.(newTime);
  };

  const handleAddSubtitle = () => {
    if (!onSubtitlesChange) return;
    
    const newSubtitle: Subtitle = {
      id: Date.now().toString(),
      startTime: currentTime,
      endTime: currentTime + 2, // Por defecto, 2 segundos de duración
      text: ''
    };

    onSubtitlesChange([...subtitles, newSubtitle]);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const timeMarkers = Array.from({ length: Math.ceil(duration / 10) }, (_, i) => i * 10);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4 px-4">
        <button
          className="p-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          onClick={onPlayPause}
        >
          {isPlaying ? (
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 4h4v16H6zM14 4h4v16h-4z" />
            </svg>
          ) : (
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
        </button>

        <div className="text-sm text-gray-300">
          {formatTime(currentTime)} / {formatTime(duration)}
        </div>

        <button
          className="px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 ml-auto"
          onClick={handleAddSubtitle}
        >
          Añadir Subtítulo
        </button>
      </div>

      <div className="h-32 bg-gray-800 rounded-lg p-4">
        <div 
          ref={timelineRef}
          className="w-full h-full bg-gray-700 rounded relative"
          onClick={handleTimelineClick}
        >
          {/* Time markers */}
          <div className="absolute top-0 left-0 w-full h-6 flex">
            {timeMarkers.map((time) => (
              <div key={time} className="flex-1 border-l border-gray-600 text-xs text-gray-400 pl-1">
                {formatTime(time)}
              </div>
            ))}
          </div>
          
          {/* Current time indicator */}
          <div 
            className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10"
            style={{ left: `${(currentTime / duration) * 100}%` }}
          />
          
          <SubtitleTrack
            duration={duration}
            currentTime={currentTime}
            onSubtitleClick={onSubtitleClick}
            subtitles={subtitles}
            onSubtitlesChange={onSubtitlesChange}
            selectedSubtitleId={selectedSubtitleId}
          />
        </div>
      </div>
    </div>
  );
} 