'use client';

import { useState } from 'react';

export interface Subtitle {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
}

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
  return (
    <div className="absolute top-8 left-0 w-full h-12 bg-gray-800 border-t border-b border-gray-600">
      {subtitles.map(subtitle => (
        <div
          key={subtitle.id}
          className={`absolute top-0 h-full bg-blue-600 opacity-75 rounded cursor-pointer
            hover:opacity-90
            ${subtitle.id === selectedSubtitleId ? 'ring-2 ring-white' : ''}`}
          style={{
            left: `${(subtitle.startTime / duration) * 100}%`,
            width: `${((subtitle.endTime - subtitle.startTime) / duration) * 100}%`
          }}
          onClick={() => onSubtitleClick?.(subtitle)}
        />
      ))}
      
      {/* Indicador de tiempo actual */}
      <div 
        className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10"
        style={{ left: `${(currentTime / duration) * 100}%` }}
      />
    </div>
  );
} 