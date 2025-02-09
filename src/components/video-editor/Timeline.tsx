'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import { SubtitleTrack, type Subtitle } from './SubtitleTrack';

interface TimelineProps {
  duration: number;
  currentTime?: number;
  onTimeUpdate?: (time: number) => void;
  onSubtitleClick?: (subtitle: Subtitle | null) => void;
  subtitles: Subtitle[];
  onSubtitlesChange?: (subtitles: Subtitle[]) => void;
  selectedSubtitleId?: string | null;
  isPlaying?: boolean;
  onPlayPause?: () => void;
  fps?: number;
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
  onPlayPause,
  fps = 30
}: TimelineProps) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const [localTime, setLocalTime] = useState(currentTime);
  const [isSeeking, setIsSeeking] = useState(false);

  useEffect(() => {
    // Solo sincronizamos si no estamos buscando y la diferencia es significativa
    if (!isSeeking && Math.abs(currentTime - localTime) > 0.01) {
      setLocalTime(currentTime);
    }
  }, [currentTime, isSeeking, localTime]);

  const getTimeFromClick = useCallback((clientX: number): number => {
    if (!timelineRef.current) return localTime;
    
    const rect = timelineRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, x / rect.width));
    const exactTime = percentage * duration;
    const frameCount = Math.round(exactTime * fps);
    // Convertimos a tiempo usando división entera y luego a decimal
    return Number((frameCount / fps).toFixed(3));
  }, [duration, fps, localTime]);

  const getCurrentFrame = useCallback(() => {
    // Asegurarnos de que trabajamos con frames enteros
    const frameCount = Math.round(localTime * fps);
    const frameStart = Number((frameCount / fps).toFixed(3));
    const frameEnd = Number(((frameCount + 1) / fps).toFixed(3));
    const frameWidth = frameEnd - frameStart;

    return {
      start: frameStart,
      end: frameEnd,
      width: frameWidth,
      current: frameCount
    };
  }, [localTime, fps]);

  const handleAddSubtitle = () => {
    if (!onSubtitlesChange || !onSubtitleClick) return;
    
    const newSubtitle: Subtitle = {
      id: Date.now().toString(),
      startTime: localTime,
      endTime: localTime + 2,
      text: ''
    };

    onSubtitlesChange([...subtitles, newSubtitle]);
    // Seleccionar automáticamente el nuevo subtítulo
    onSubtitleClick(newSubtitle);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  };

  const getTimeMarkers = useCallback(() => {
    const markers = [];
    const totalFrames = Math.floor(duration * fps);
    
    // Marcadores de segundos
    for (let second = 0; second <= duration; second++) {
      markers.push(
        <div
          key={`second-${second}`}
          className="absolute border-l border-gray-400"
          style={{
            left: `${(second / duration) * 100}%`,
            height: '32px'
          }}
        >
          <span className="absolute bottom-0 left-2 text-xs text-gray-400">
            {second}s
          </span>
        </div>
      );
    }

    // Marcadores de frames (sin números)
    for (let frame = 0; frame <= totalFrames; frame++) {
      const time = frame / fps;
      if (Math.floor(time) === time) continue;
      markers.push(
        <div
          key={`frame-${frame}`}
          className="absolute border-l border-gray-600"
          style={{
            left: `${(time / duration) * 100}%`,
            height: '8px'
          }}
        />
      );
    }

    return markers;
  }, [duration, fps]);

  const currentFrame = getCurrentFrame();

  // Funciones globales para seguir el ratón
  const handleGlobalMouseMove = useCallback((event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const newTime = getTimeFromClick(event.clientX);
    setLocalTime(newTime);
    onTimeUpdate?.(newTime);
  }, [getTimeFromClick, onTimeUpdate]);

  const handleGlobalMouseUp = useCallback((event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsSeeking(false);
    document.removeEventListener('mousemove', handleGlobalMouseMove);
    document.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [handleGlobalMouseMove]);

  const handleMouseDownLocal = (event: React.MouseEvent<HTMLDivElement>) => {
    // Solo deseleccionar si el clic fue directamente en el área de track o en el área de marcadores
    const target = event.target as HTMLElement;
    const isEmptyArea = target.classList.contains('timeline-track') || 
                       target.classList.contains('timeline-markers');

    if (isEmptyArea && onSubtitleClick) {
      onSubtitleClick(null);
    }

    event.preventDefault();
    event.stopPropagation();
    setIsSeeking(true);
    const finalTime = getTimeFromClick(event.clientX);
    setLocalTime(finalTime);
    onTimeUpdate?.(finalTime);
    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);
  };

  const handleDeleteSubtitle = () => {
    if (!selectedSubtitleId || !onSubtitlesChange) return;
    onSubtitlesChange(subtitles.filter(s => s.id !== selectedSubtitleId));
    if (onSubtitleClick) {
      onSubtitleClick(null);
    }
  };

  const moveFrame = useCallback((direction: 'next' | 'prev') => {
    if (!onTimeUpdate) return;

    const currentFrame = getCurrentFrame();
    const totalFrames = Math.floor(duration * fps);
    
    let newFrame;
    if (direction === 'next' && currentFrame.current < totalFrames - 1) {
      newFrame = currentFrame.current + 1;
    } else if (direction === 'prev' && currentFrame.current > 0) {
      newFrame = currentFrame.current - 1;
    } else {
      console.log(`No se puede mover ${direction}. Frame actual: ${currentFrame.current}, Total frames: ${totalFrames}`);
      return;
    }

    // Convertimos el frame a tiempo usando división entera y luego a decimal
    const newTime = Number((newFrame / fps).toFixed(3));
    console.log(`Frame ${currentFrame.current} -> ${newFrame} (${newTime}s)`);
    
    setLocalTime(newTime);
    onTimeUpdate(newTime);
  }, [fps, getCurrentFrame, duration, onTimeUpdate]);

  // Efecto para sincronizar el tiempo local con el tiempo del video
  useEffect(() => {
    if (!isSeeking) {
      const frameFromCurrent = Math.round(currentTime * fps);
      const frameFromLocal = Math.round(localTime * fps);
      
      // Solo actualizamos si hay diferencia de frames
      if (frameFromCurrent !== frameFromLocal) {
        setLocalTime(Number((frameFromCurrent / fps).toFixed(3)));
      }
    }
  }, [currentTime, fps, isSeeking, localTime]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') {
        moveFrame('next');
      } else if (event.key === 'ArrowLeft') {
        moveFrame('prev');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [moveFrame]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4 px-4">
        <button
          className="p-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          onClick={onPlayPause}
          title={isPlaying ? "Pausar" : "Reproducir"}
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
          {formatTime(localTime)} / {formatTime(duration)}
        </div>

        <div className="flex gap-2 ml-auto">
          <button
            className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleDeleteSubtitle}
            disabled={!selectedSubtitleId}
            title="Eliminar subtítulo seleccionado"
          >
            Eliminar Subtítulo
          </button>
          <button
            className="px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700"
            onClick={handleAddSubtitle}
            title="Añadir un nuevo subtítulo en la posición actual"
          >
            Añadir Subtítulo
          </button>
        </div>
      </div>

      <div className="h-32 bg-gray-800 rounded-lg p-4">
        <div 
          ref={timelineRef}
          className="w-full h-full relative timeline-track"
          onMouseDown={handleMouseDownLocal}
        >
          <div className="absolute top-0 left-0 right-0 h-8 bg-gray-700 rounded-t timeline-markers">
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden timeline-markers">
              {getTimeMarkers()}
            </div>
          </div>
          
          <div 
            className="absolute top-0 bottom-0 bg-white/10 pointer-events-none border-l border-r border-white/20"
            style={{
              left: `${(currentFrame.start / duration) * 100}%`,
              width: `${(currentFrame.width / duration) * 100}%`
            }}
          />

          <div 
            className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10 pointer-events-none"
            style={{ left: `${(currentFrame.start / duration) * 100}%` }}
          />

          <div className="absolute top-0 left-0 w-full h-full">
            <SubtitleTrack
              duration={duration}
              currentTime={localTime}
              onSubtitleClick={onSubtitleClick}
              subtitles={subtitles}
              onSubtitlesChange={onSubtitlesChange}
              selectedSubtitleId={selectedSubtitleId}
              fps={fps}
            />
          </div>
        </div>
      </div>
    </div>
  );
} 