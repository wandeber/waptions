'use client';

import { useState, useEffect } from 'react';
import type { Subtitle } from './SubtitleTrack';

interface SubtitleEditorProps {
  subtitle: Subtitle | null;
  onSave?: (subtitle: Subtitle) => void;
}

export function SubtitleEditor({ subtitle, onSave }: SubtitleEditorProps) {
  const [text, setText] = useState('');

  // Actualizar el texto cuando se selecciona un nuevo subtítulo
  useEffect(() => {
    if (subtitle) {
      setText(subtitle.text);
    } else {
      setText('');
    }
  }, [subtitle]);

  // Guardar cambios cuando el texto cambia
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const newText = e.target.value;
    setText(newText);
    
    if (subtitle) {
      onSave?.({
        ...subtitle,
        text: newText
      });
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  };

  if (!subtitle) {
    return (
      <div className="h-full bg-gray-800 rounded-lg p-4 flex items-center justify-center text-gray-500">
        Selecciona un subtítulo para editar
      </div>
    );
  }

  return (
    <div className="h-full bg-gray-800 rounded-lg p-4 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
      <div className="flex justify-between text-sm text-gray-400">
        <span>Inicio: {formatTime(subtitle.startTime)}</span>
        <span>Fin: {formatTime(subtitle.endTime)}</span>
      </div>
      
      <textarea
        className="flex-1 bg-gray-700 rounded p-2 text-white resize-none min-h-0"
        value={text}
        onChange={handleTextChange}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        placeholder="Escribe el texto del subtítulo aquí..."
      />
    </div>
  );
} 