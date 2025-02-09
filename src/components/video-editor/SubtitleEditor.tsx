'use client';

import { useState, useEffect, useRef } from 'react';
import type { Subtitle } from './SubtitleTrack';

interface SubtitleEditorProps {
  subtitles: Subtitle[];
  selectedSubtitleId?: string | null;
  onSave?: (subtitle: Subtitle) => void;
}

export function SubtitleEditor({ subtitles, selectedSubtitleId, onSave }: SubtitleEditorProps) {
  const [editingText, setEditingText] = useState<{[key: string]: string}>({});
  const textAreasRef = useRef<{[key: string]: HTMLTextAreaElement | null}>({});

  // Inicializar o actualizar el texto de edición cuando cambian los subtítulos
  useEffect(() => {
    const newEditingText: {[key: string]: string} = {};
    subtitles.forEach(subtitle => {
      if (!editingText[subtitle.id]) {
        newEditingText[subtitle.id] = subtitle.text;
      }
    });
    setEditingText(prev => ({...prev, ...newEditingText}));
  }, [subtitles]);

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

  return (
    <div className="h-full bg-gray-800 rounded-lg p-4 flex flex-col gap-4 overflow-y-auto">
      {subtitles.length === 0 ? (
        <div className="text-gray-500 text-center">
          No hay subtítulos añadidos
        </div>
      ) : (
        subtitles.map(subtitle => (
          <div 
            key={subtitle.id}
            className={`bg-gray-700 rounded p-3 flex flex-col gap-2 transition-colors
              ${subtitle.id === selectedSubtitleId ? 'ring-2 ring-white' : ''}`}
          >
            <div className="flex justify-between text-sm text-gray-400">
              <span>Inicio: {formatTime(subtitle.startTime)}</span>
              <span>Fin: {formatTime(subtitle.endTime)}</span>
            </div>
            
            <textarea
              ref={el => {
                textAreasRef.current[subtitle.id] = el;
              }}
              className="bg-gray-600 rounded p-2 text-white resize-none overflow-hidden"
              value={editingText[subtitle.id] || ''}
              onChange={(e) => handleTextChange(subtitle, e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder="Escribe el texto del subtítulo aquí..."
              rows={1}
            />
          </div>
        ))
      )}
    </div>
  );
} 