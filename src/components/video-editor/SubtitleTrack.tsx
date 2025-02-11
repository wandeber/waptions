'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

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
  fps: number;
  onTimeUpdate?: (time: number) => void;
}

export function SubtitleTrack({ 
  duration, 
  currentTime,
  onSubtitleClick,
  subtitles,
  onSubtitlesChange,
  selectedSubtitleId,
  fps,
  onTimeUpdate
}: SubtitleTrackProps) {
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [dragStartTime, setDragStartTime] = useState<number>(0);
  const [draggedSubtitle, setDraggedSubtitle] = useState<Subtitle | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const getTimeFromX = useCallback((x: number) => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const percentage = Math.max(0, Math.min(1, x / rect.width));
    const exactTime = percentage * duration;
    // Ajustamos al frame más cercano
    const frameCount = Math.round(exactTime * fps);
    return Number((frameCount / fps).toFixed(3));
  }, [duration, fps]);

  const handleMouseDown = (e: React.MouseEvent, subtitle: Subtitle) => {
    e.stopPropagation(); // Evitar que el evento llegue al timeline
    
    if (!trackRef.current) return;

    const rect = trackRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const subtitleLeft = (subtitle.startTime / duration) * rect.width;
    const subtitleRight = (subtitle.endTime / duration) * rect.width;
    const handleWidth = 10; // Ancho del área para redimensionar

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

    const rect = trackRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const newTime = getTimeFromX(x);
    
    // El cabezal siempre lidera el movimiento
    onTimeUpdate?.(newTime);
    
    const updatedSubtitle = { ...draggedSubtitle };
    let shouldUpdate = false;
    
    switch (dragMode) {
      case 'move': {
        const subtitleDuration = draggedSubtitle.endTime - draggedSubtitle.startTime;
        const timeDiff = newTime - dragStartTime;
        const newStartFrame = Math.round((draggedSubtitle.startTime + timeDiff) * fps);
        const newStartTime = Number((newStartFrame / fps).toFixed(3));
        
        // Asegurarnos de que no se salga de los límites
        if (newStartTime >= 0) {
          updatedSubtitle.startTime = newStartTime;
          updatedSubtitle.endTime = Number((newStartTime + subtitleDuration).toFixed(3));
          shouldUpdate = true;
        }
        break;
      }
      case 'resize-start': {
        const newStartFrame = Math.round(newTime * fps);
        const endFrame = Math.round(draggedSubtitle.endTime * fps);
        
        // Asegurar un mínimo de 1 frame entre inicio y fin
        if (newStartFrame < endFrame - 1) {
          updatedSubtitle.startTime = Number((newStartFrame / fps).toFixed(3));
          shouldUpdate = true;
        }
        break;
      }
      case 'resize-end': {
        const startFrame = Math.round(draggedSubtitle.startTime * fps);
        // Para el final del subtítulo, usamos el frame siguiente al del cabezal
        const newEndFrame = Math.round(newTime * fps) + 1;
        
        // Asegurar un mínimo de 1 frame entre inicio y fin
        if (newEndFrame > startFrame + 1) {
          updatedSubtitle.endTime = Number((newEndFrame / fps).toFixed(3));
          shouldUpdate = true;
        }
        break;
      }
    }

    if (shouldUpdate) {
      // Verificar si realmente hay un cambio antes de actualizar
      const currentSubtitle = subtitles.find(s => s.id === draggedSubtitle.id);
      if (currentSubtitle && (
        currentSubtitle.startTime !== updatedSubtitle.startTime ||
        currentSubtitle.endTime !== updatedSubtitle.endTime
      )) {
        onSubtitlesChange(
          subtitles.map(s => s.id === draggedSubtitle.id ? updatedSubtitle : s)
        );
      }
    }
  }, [dragMode, draggedSubtitle, dragStartTime, onSubtitlesChange, subtitles, getTimeFromX, fps, onTimeUpdate]);

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

  // Añadir un efecto para manejar la posición del cursor de reproducción
  useEffect(() => {
    // Aquí podemos usar currentTime para actualizar cualquier indicador visual
    // del tiempo actual si es necesario
  }, [currentTime]);

  return (
    <div 
      ref={trackRef}
      className="absolute inset-0 bg-gray-800"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {subtitles.map(subtitle => {
        const isSelected = subtitle.id === selectedSubtitleId;
        return (
          <div
            key={subtitle.id}
            className={`absolute top-[15%] bottom-[15%] bg-blue-600 opacity-75 rounded group
              hover:opacity-90 transition-opacity flex items-center overflow-hidden`}
            style={{
              left: `${(subtitle.startTime / duration) * 100}%`,
              width: `${((subtitle.endTime - subtitle.startTime) / duration) * 100}%`,
              cursor: dragMode && draggedSubtitle?.id === subtitle.id 
                ? dragMode === 'move' ? 'move' : dragMode === 'resize-start' ? 'w-resize' : 'e-resize'
                : 'pointer',
              boxShadow: isSelected 
                ? 'inset 0 0 0 2px white' 
                : 'inset 0 0 0 1px rgba(255, 255, 255, 0.3)'
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
          >
            {/* Indicadores visuales para los bordes redimensionables */}
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-white opacity-0 group-hover:opacity-50 cursor-w-resize" />
            <div className="absolute right-0 top-0 bottom-0 w-1 bg-white opacity-0 group-hover:opacity-50 cursor-e-resize" />
            
            {/* Texto del subtítulo */}
            <div className="px-2 text-xs text-white font-medium truncate select-none pointer-events-none">
              {subtitle.text || '(Sin texto)'}
            </div>
          </div>
        );
      })}
    </div>
  );
} 