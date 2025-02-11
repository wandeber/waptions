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
  fps: number;
  showThirdsGuide?: boolean;
  onThirdsGuideToggle?: () => void;
  showMetaInfo?: boolean;
  onMetaInfoToggle?: () => void;
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
  fps,
  showThirdsGuide = false,
  onThirdsGuideToggle,
  showMetaInfo = false,
  onMetaInfoToggle
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
    const frameCount = Math.floor(exactTime * fps) + 1;
    // Convertimos a tiempo usando división entera y luego a decimal
    return Number(((frameCount - 1) / fps).toFixed(3));
  }, [duration, fps, localTime]);

  const getCurrentFrame = useCallback(() => {
    const totalFrames = Math.ceil(duration * fps);
    const frameCount = Math.min(Math.floor(localTime * fps) + 1, totalFrames);
    const frameStart = ((frameCount - 1) / fps);
    const frameEnd = Math.min(frameCount / fps, duration);

    return {
      start: frameStart,
      end: frameEnd,
      width: frameEnd - frameStart,
      current: frameCount,
      total: totalFrames
    };
  }, [localTime, fps, duration]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  };

  const getTimeMarkers = useCallback(() => {
    const markers = [];
    const { total: totalFrames } = getCurrentFrame();
    
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
          <span className="absolute bottom-0 left-2 text-xs text-gray-400 select-none">
            {second}s
          </span>
        </div>
      );
    }

    // Marcadores de frames (sin números)
    for (let frame = 1; frame <= totalFrames; frame++) {
      const time = (frame - 1) / fps;
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
  }, [duration, fps, getCurrentFrame]);

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

  const moveFrame = useCallback((direction: 'next' | 'prev') => {
    if (!onTimeUpdate) return;

    const { current: currentFrameNumber, total: totalFrames } = getCurrentFrame();
    
    let newFrame;
    if (direction === 'next' && currentFrameNumber < totalFrames) {
      newFrame = currentFrameNumber + 1;
    } else if (direction === 'prev' && currentFrameNumber > 1) {
      newFrame = currentFrameNumber - 1;
    } else {
      console.log(`No se puede mover ${direction}. Frame actual: ${currentFrameNumber}, Total frames: ${totalFrames}`);
      return;
    }

    const newTime = Math.min((newFrame - 1) / fps, duration);
    console.log(`Frame ${currentFrameNumber} -> ${newFrame} (${newTime}s)`);
    setLocalTime(newTime);
    onTimeUpdate(newTime);
  }, [fps, duration, getCurrentFrame, onTimeUpdate]);

  // Efecto para sincronizar el tiempo local con el tiempo del video
  useEffect(() => {
    if (!isSeeking) {
      const { total: totalFrames } = getCurrentFrame();
      const frameFromCurrent = Math.min(Math.floor(currentTime * fps) + 1, totalFrames);
      const frameFromLocal = Math.min(Math.floor(localTime * fps) + 1, totalFrames);
      
      // Solo actualizamos si hay diferencia de frames
      if (frameFromCurrent !== frameFromLocal) {
        const newTime = Math.min((frameFromCurrent - 1) / fps, duration);
        setLocalTime(newTime);
      }
    }
  }, [currentTime, fps, isSeeking, localTime, duration, getCurrentFrame]);

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
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <div className="flex gap-2">
          <button
            className="p-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors select-none"
            onClick={() => {
              if (isPlaying) {
                onPlayPause?.();
              }
            }}
            title="Detener"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <rect x="6" y="6" width="12" height="12" strokeWidth={2} />
            </svg>
          </button>

          <button
            className={`p-1.5 ${
              isPlaying 
                ? 'bg-red-700 hover:bg-red-600' 
                : 'bg-gray-700 hover:bg-gray-600'
            } text-gray-300 rounded transition-colors select-none`}
            onClick={() => {
              if (!isPlaying) {
                onPlayPause?.();
              }
            }}
            title="Reproducir"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5v14l11-7z" />
            </svg>
          </button>
        </div>

        <div className="text-sm text-gray-300 select-none">
          {formatTime(localTime)} / {formatTime(duration)} ({currentFrame.current} / {currentFrame.total})
        </div>

        <div className="flex gap-2 ml-auto">
          <button
            onClick={onThirdsGuideToggle}
            className={`px-3 py-1 rounded text-sm transition-colors select-none ${
              showThirdsGuide 
                ? 'bg-blue-600 text-white hover:bg-blue-700' 
                : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
            }`}
            title="Mostrar/ocultar guías de los tercios"
          >
            Guías de tercios
          </button>
          <button
            onClick={onMetaInfoToggle}
            className={`px-3 py-1 rounded text-sm transition-colors select-none ${
              showMetaInfo 
                ? 'bg-blue-600 text-white hover:bg-blue-700' 
                : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
            }`}
            title="Mostrar/ocultar información del vídeo"
          >
            Meta Info
          </button>
        </div>
      </div>

      <div className="h-[88px] bg-gray-800 rounded-b-lg overflow-hidden">
        <div 
          ref={timelineRef}
          className="w-full h-full relative timeline-track"
          onMouseDown={handleMouseDownLocal}
        >
          {/* Regla de tiempo */}
          <div className="absolute top-0 left-0 right-0 h-8 bg-gray-700 timeline-markers">
            {getTimeMarkers()}
          </div>

          {/* Track de subtítulos */}
          <div className="absolute top-8 left-0 right-0 bottom-0">
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

          {/* Línea del cabezal */}
          <div 
            className="absolute inset-0 w-0.5 bg-red-500 pointer-events-none z-10"
            style={{ 
              left: `${(currentFrame.start / duration) * 100}%`
            }}
          />
        </div>
      </div>
    </div>
  );
} 