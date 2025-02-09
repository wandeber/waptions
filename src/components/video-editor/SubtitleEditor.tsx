'use client';

import { useState, useEffect } from 'react';
import type { Subtitle } from './SubtitleTrack';

interface SubtitleEditorProps {
  subtitle: Subtitle | null;
  onSave?: (subtitle: Subtitle) => void;
  onDelete?: (subtitleId: string) => void;
}

export function SubtitleEditor({ subtitle, onSave, onDelete }: SubtitleEditorProps) {
  const [text, setText] = useState('');

  // Actualizar el texto cuando se selecciona un nuevo subtítulo
  useEffect(() => {
    if (subtitle) {
      setText(subtitle.text);
    }
  }, [subtitle]);

  const handleSave = () => {
    if (!subtitle) return;
    onSave?.({
      ...subtitle,
      text
    });
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
    <div className="h-full bg-gray-800 rounded-lg p-4 flex flex-col gap-4">
      <div className="flex justify-between text-sm text-gray-400">
        <span>Inicio: {formatTime(subtitle.startTime)}</span>
        <span>Fin: {formatTime(subtitle.endTime)}</span>
      </div>
      
      <textarea
        className="flex-1 bg-gray-700 rounded p-2 text-white resize-none min-h-0"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Escribe el texto del subtítulo aquí..."
      />
      
      <div className="flex justify-end gap-2">
        <button
          className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700"
          onClick={() => onDelete?.(subtitle.id)}
        >
          Eliminar
        </button>
        <button
          className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
          onClick={handleSave}
        >
          Guardar
        </button>
      </div>
    </div>
  );
} 