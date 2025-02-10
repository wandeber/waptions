'use client';

import { useState, useEffect, useRef } from 'react';
import type { Subtitle } from './SubtitleTrack';

interface SubtitleEditorProps {
  subtitles: Subtitle[];
  selectedSubtitleId?: string | null;
  onSave?: (subtitle: Subtitle) => void;
  onSubtitleClick?: (subtitle: Subtitle) => void;
  onDelete?: (subtitleId: string) => void;
  onSubtitlesChange?: (subtitles: Subtitle[]) => void;
  currentTime: number;
}

export function SubtitleEditor({ subtitles, selectedSubtitleId, onSave, onSubtitleClick, onDelete, onSubtitlesChange, currentTime }: SubtitleEditorProps) {
  const [editingText, setEditingText] = useState<{[key: string]: string}>({});
  const textAreasRef = useRef<{[key: string]: HTMLTextAreaElement | null}>({});

  // Inicializar o actualizar el texto de edición cuando cambian los subtítulos
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    const newEditingText: {[key: string]: string} = {};
    let needsUpdate = false;

    subtitles.forEach(subtitle => {
      if (!(subtitle.id in editingText)) {
        newEditingText[subtitle.id] = subtitle.text;
        needsUpdate = true;
      }
    });

    if (needsUpdate) {
      setEditingText(prev => ({...prev, ...newEditingText}));
    }
  }, [subtitles]);
  /* eslint-enable react-hooks/exhaustive-deps */

  const adjustTextareaHeight = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  };

  const handleTextChange = (subtitle: Subtitle, newText: string) => {
    setEditingText(prev => ({...prev, [subtitle.id]: newText}));
    onSave?.({
      ...subtitle,
      text: newText
    });

    // Ajustar altura después de cambiar el texto
    const textarea = textAreasRef.current[subtitle.id];
    if (textarea) {
      adjustTextareaHeight(textarea);
    }
  };

  // Ajustar altura inicial cuando se monta el componente o cambia el texto
  useEffect(() => {
    Object.values(textAreasRef.current).forEach(textarea => {
      if (textarea) {
        adjustTextareaHeight(textarea);
      }
    });
  }, [editingText]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>, subtitle: Subtitle) => {
    if (e.key === 'Enter') {
      if (e.ctrlKey) {
        // Permitir el comportamiento por defecto para insertar salto de línea
        const textarea = e.currentTarget;
        const cursorPosition = textarea.selectionStart;
        const currentText = editingText[subtitle.id] || '';
        const newText = currentText.slice(0, cursorPosition) + '\n' + currentText.slice(cursorPosition);
        handleTextChange(subtitle, newText);
        
        // Mover el cursor después del salto de línea
        requestAnimationFrame(() => {
          textarea.setSelectionRange(cursorPosition + 1, cursorPosition + 1);
        });
        return;
      }

      e.preventDefault();
      
      const textarea = e.currentTarget;
      const cursorPosition = textarea.selectionStart;
      const currentText = editingText[subtitle.id] || '';

      // No crear nuevo subtítulo si el texto está vacío
      if (!currentText.trim()) {
        return;
      }
      
      // Dividir el texto en dos partes según la posición del cursor y limpiar espacios en la zona del split
      const firstPart = currentText.slice(0, cursorPosition).replace(/\s+$/, '');
      const secondPart = currentText.slice(cursorPosition).replace(/^\s+/, '');
      
      // Calcular los tiempos para los dos nuevos subtítulos
      const originalDuration = subtitle.endTime - subtitle.startTime;
      const splitRatio = cursorPosition / currentText.length;

      // Si estamos al final del texto, asegurar una duración mínima de 1 segundo para el nuevo subtítulo
      const isAtEnd = cursorPosition >= currentText.length;
      const minDuration = 1; // 1 segundo
      
      let splitTime: number;
      let newSubtitle: Subtitle;
      
      if (isAtEnd) {
        splitTime = subtitle.endTime;
        // Ajustar el tiempo final del nuevo subtítulo para asegurar la duración mínima
        const newEndTime = splitTime + minDuration;
        
        // Actualizar el subtítulo original (sin cambios en su duración)
        const updatedOriginal: Subtitle = {
          ...subtitle,
          text: firstPart
        };
        
        // Crear el nuevo subtítulo con la duración mínima
        newSubtitle = {
          id: Date.now().toString(),
          startTime: splitTime,
          endTime: newEndTime,
          text: secondPart
        };
        
        // Actualizar el estado local de edición
        setEditingText(prev => ({
          ...prev,
          [updatedOriginal.id]: firstPart,
          [newSubtitle.id]: secondPart
        }));
        
        // Guardar ambos subtítulos
        onSave?.(updatedOriginal);
        onSave?.(newSubtitle);
        
        // Seleccionar el nuevo subtítulo
        onSubtitleClick?.(newSubtitle);
      } else {
        // Comportamiento normal para división en medio del texto
        splitTime = subtitle.startTime + (originalDuration * splitRatio);
        
        // Actualizar el subtítulo original con la primera parte
        const updatedOriginal: Subtitle = {
          ...subtitle,
          text: firstPart,
          endTime: splitTime
        };
        
        // Crear el nuevo subtítulo con la segunda parte
        newSubtitle = {
          id: Date.now().toString(),
          startTime: splitTime,
          endTime: subtitle.endTime,
          text: secondPart
        };
        
        // Actualizar el estado local de edición
        setEditingText(prev => ({
          ...prev,
          [updatedOriginal.id]: firstPart,
          [newSubtitle.id]: secondPart
        }));
        
        // Guardar ambos subtítulos
        onSave?.(updatedOriginal);
        onSave?.(newSubtitle);
        
        // Seleccionar el nuevo subtítulo
        onSubtitleClick?.(newSubtitle);
      }

      // Mover el foco al nuevo textarea después de que se renderice
      requestAnimationFrame(() => {
        const newTextarea = textAreasRef.current[newSubtitle.id];
        if (newTextarea) {
          newTextarea.focus();
          // Posicionar el cursor al inicio del nuevo textarea
          newTextarea.setSelectionRange(0, 0);
        }
      });
    } else if (e.key === 'Backspace') {
      const textarea = e.currentTarget;
      // Solo proceder si estamos al inicio del texto
      if (textarea.selectionStart !== 0 || textarea.selectionEnd !== 0) {
        return;
      }

      // Encontrar el subtítulo anterior
      const sortedSubtitles = [...subtitles].sort((a, b) => a.startTime - b.startTime);
      const currentIndex = sortedSubtitles.findIndex(s => s.id === subtitle.id);
      if (currentIndex <= 0) {
        return; // No hay subtítulo anterior
      }

      e.preventDefault();
      const previousSubtitle = sortedSubtitles[currentIndex - 1];
      const currentText = editingText[subtitle.id] || '';
      const previousText = editingText[previousSubtitle.id] || '';

      // Unir los textos con un espacio, eliminando espacios extra
      const combinedText = `${previousText.trim()} ${currentText.trim()}`.trim();

      // Actualizar el subtítulo anterior con el texto combinado y la nueva duración
      const updatedPrevious: Subtitle = {
        ...previousSubtitle,
        text: combinedText,
        endTime: subtitle.endTime
      };

      // Actualizar el estado local de edición
      setEditingText(prev => {
        const newState = { ...prev };
        delete newState[subtitle.id];
        return {
          ...newState,
          [previousSubtitle.id]: combinedText
        };
      });

      // Guardar el subtítulo actualizado y eliminar el actual
      onSave?.(updatedPrevious);
      onSubtitleClick?.(updatedPrevious);
      onDelete?.(subtitle.id);

      // Calcular la posición del cursor donde ocurre el join
      const joinPosition = previousText.length;

      // Mover el foco al textarea anterior y posicionar el cursor en el punto de unión
      requestAnimationFrame(() => {
        const previousTextarea = textAreasRef.current[previousSubtitle.id];
        if (previousTextarea) {
          previousTextarea.focus();
          previousTextarea.setSelectionRange(joinPosition, joinPosition);
        }
      });
    }
  };

  return (
    <div className="h-full bg-gray-800 rounded-lg p-4 flex flex-col gap-4 overflow-y-auto">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-white">Subtítulos</h2>
        <button
          className="px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1"
          onClick={() => {
            const newSubtitle: Subtitle = {
              id: Date.now().toString(),
              startTime: currentTime,
              endTime: currentTime + 2,
              text: ''
            };
            onSubtitlesChange?.([...subtitles, newSubtitle]);
            onSubtitleClick?.(newSubtitle);
            // Dar foco al textarea después de que se renderice
            requestAnimationFrame(() => {
              const textarea = textAreasRef.current[newSubtitle.id];
              if (textarea) {
                textarea.focus();
              }
            });
          }}
          title="Añadir subtítulo"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          <span>Añadir</span>
        </button>
      </div>
      {subtitles.length === 0 ? (
        <div className="text-gray-500 text-center">
          No hay subtítulos añadidos
        </div>
      ) : (
        [...subtitles]
          .sort((a, b) => {
            // Primero ordenar por tiempo de inicio
            if (a.startTime !== b.startTime) {
              return a.startTime - b.startTime;
            }
            // Si tienen el mismo tiempo de inicio, ordenar por duración
            const aDuration = a.endTime - a.startTime;
            const bDuration = b.endTime - b.startTime;
            return aDuration - bDuration;
          })
          .map(subtitle => (
            <div 
              key={subtitle.id}
              className={`bg-gray-700 rounded p-3 flex flex-col gap-2 transition-colors cursor-pointer
                ${subtitle.id === selectedSubtitleId ? 'ring-2 ring-white' : ''}`}
              onClick={() => onSubtitleClick?.(subtitle)}
            >
              <div className="flex justify-between items-center">
                <div className="text-sm text-gray-400">
                  <span className="select-none">{formatTime(subtitle.startTime)} - {formatTime(subtitle.endTime)}</span>
                </div>
                <button
                  className="ml-2 p-1 text-gray-400 hover:text-red-500 rounded hover:bg-gray-600"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete?.(subtitle.id);
                  }}
                  title="Eliminar subtítulo"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              
              <textarea
                ref={el => {
                  textAreasRef.current[subtitle.id] = el;
                }}
                className="bg-gray-600 rounded p-2 text-white resize-none overflow-hidden"
                value={editingText[subtitle.id] || ''}
                onChange={(e) => handleTextChange(subtitle, e.target.value)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSubtitleClick?.(subtitle);
                }}
                onFocus={() => onSubtitleClick?.(subtitle)}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => handleKeyDown(e, subtitle)}
                placeholder="Escribe el texto del subtítulo aquí..."
                rows={1}
              />
            </div>
          ))
      )}
    </div>
  );
} 