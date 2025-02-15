import { useRef } from 'react';
import type { Subtitle } from '../SubtitleTrack';
import { Button } from '../../design-system/Button';
import { MagicMicIcon } from '../../icons/MagicMicIcon';
import { PlusIcon } from '../../icons/PlusIcon';
import { CloseIcon } from '../../icons/CloseIcon';

interface SubtitleListProps {
  subtitles: Subtitle[];
  selectedSubtitleId?: string | null;
  editingText: {[key: string]: string};
  currentTime: number;
  onSubtitleClick?: (subtitle: Subtitle) => void;
  onDelete?: (subtitleId: string) => void;
  onSubtitlesChange?: (subtitles: Subtitle[]) => void;
  onGenerateSubtitles?: () => void;
  isGeneratingSubtitles?: boolean;
  onTextChange: (subtitle: Subtitle, newText: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>, subtitle: Subtitle) => void;
}

export function SubtitleList({
  subtitles,
  selectedSubtitleId,
  editingText,
  currentTime,
  onSubtitleClick,
  onDelete,
  onSubtitlesChange,
  onGenerateSubtitles,
  isGeneratingSubtitles,
  onTextChange,
  onKeyDown
}: SubtitleListProps) {
  const textAreasRef = useRef<{[key: string]: HTMLTextAreaElement | null}>({});

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex justify-between items-center">
        <div></div>
        <div className="flex gap-2 ml-auto">
          <Button
            variant="secondary"
            size="sm"
            onClick={onGenerateSubtitles}
            disabled={isGeneratingSubtitles}
            title="Generar subtítulos automáticamente con IA"
          >
            <MagicMicIcon />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const newSubtitle: Subtitle = {
                id: Date.now().toString(),
                startTime: currentTime,
                endTime: currentTime + 2,
                text: ''
              };
              onSubtitlesChange?.([...subtitles, newSubtitle]);
              onSubtitleClick?.(newSubtitle);
              requestAnimationFrame(() => {
                const textarea = textAreasRef.current[newSubtitle.id];
                if (textarea) {
                  textarea.focus();
                }
              });
            }}
            title="Añadir subtítulo"
          >
            <PlusIcon />
          </Button>
        </div>
      </div>

      {subtitles.length === 0 ? (
        <div className="text-gray-500 text-center text-sm mt-8">
          No hay subtítulos añadidos
        </div>
      ) : (
        [...subtitles]
          .sort((a, b) => a.startTime - b.startTime)
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
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete?.(subtitle.id);
                  }}
                  title="Eliminar subtítulo"
                >
                  <CloseIcon />
                </Button>
              </div>
              
              <textarea
                ref={el => {
                  textAreasRef.current[subtitle.id] = el;
                }}
                id={`subtitle-${subtitle.id}`}
                className="bg-gray-600 rounded p-2 text-white text-sm resize-none overflow-hidden transition-colors border border-transparent focus:border-blue-500/50 focus:bg-gray-700 focus:outline-none"
                value={editingText[subtitle.id] || ''}
                onChange={(e) => onTextChange(subtitle, e.target.value)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSubtitleClick?.(subtitle);
                }}
                onFocus={() => onSubtitleClick?.(subtitle)}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => onKeyDown(e, subtitle)}
                placeholder="Escribe el texto del subtítulo aquí..."
                rows={1}
              />
            </div>
          ))
      )}
    </div>
  );
} 