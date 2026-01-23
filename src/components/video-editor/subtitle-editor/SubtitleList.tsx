import { useRef, useEffect, useState } from 'react';
import { Subtitle } from '@/types/timeline';
import { Button } from '../../design-system/Button';
import { MagicMicIcon } from '../../icons/MagicMicIcon';
import { SpinnerIcon } from '../../icons/SpinnerIcon';
import { PlusIcon } from '../../icons/PlusIcon';
import { CloseIcon } from '../../icons/CloseIcon';
import { useTimelineStore } from '@/stores/timeline-store';
import { FileText } from 'lucide-react';
import { TranscriptionViewModal } from '../TranscriptionViewModal';

interface SubtitleListProps {
  subtitles: Subtitle[];
  editingText: { [key: string]: string };
  currentTime: number;
  onSubtitleClick?: (subtitle: Subtitle) => void;
  onDelete?: (subtitleId: string) => void;
  onSubtitlesChange?: (subtitles: Subtitle[]) => void;
  onAddSubtitle?: (subtitle: Omit<Subtitle, 'id'>) => string;
  onGenerateSubtitles?: () => void;
  isGeneratingSubtitles?: boolean;
  onTextChange: (subtitle: Subtitle, newText: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>, subtitle: Subtitle) => void;
}

export function SubtitleList({
  subtitles,
  editingText,
  currentTime,
  onSubtitleClick,
  onDelete,
  onSubtitlesChange,
  onAddSubtitle,
  onGenerateSubtitles,
  isGeneratingSubtitles,
  onTextChange,
  onKeyDown
}: SubtitleListProps) {
  const { selectedSubtitleIds, toggleSubtitleSelection, clearSelection } = useTimelineStore();
  const selectedSubtitleId = selectedSubtitleIds[selectedSubtitleIds.length - 1]; // Main selected for scrolling
  const textAreasRef = useRef<{ [key: string]: HTMLTextAreaElement | null }>({});
  const isInternalInteraction = useRef(false);
  const [showTranscriptionView, setShowTranscriptionView] = useState(false);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  };

  // Ajusta la altura del textarea al contenido
  useEffect(() => {
    Object.values(textAreasRef.current).forEach(textarea => {
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
      }
    });
  }, [editingText]);

  // Scroll al subtítulo seleccionado
  useEffect(() => {
    if (selectedSubtitleId && textAreasRef.current[selectedSubtitleId]) {
      // Si el cambio de selección viene de un clic interno en la lista, no hacemos scroll
      if (isInternalInteraction.current) {
        isInternalInteraction.current = false;
        return;
      }

      const textarea = textAreasRef.current[selectedSubtitleId];
      const card = textarea?.closest('.bg-gray-700') as HTMLElement;
      const scrollParent = card?.parentElement?.parentElement; // El div con overflow-y-auto en Tabs.tsx

      if (card && scrollParent) {
        const targetScrollTop = card.offsetTop - (scrollParent.offsetHeight / 2) + (card.offsetHeight / 2);

        // Animación suave con duración fija (400ms)
        const startScrollTop = scrollParent.scrollTop;
        const distance = targetScrollTop - startScrollTop;
        const duration = 400;
        let startTime: number | null = null;

        const animate = (currentTime: number) => {
          if (!startTime) startTime = currentTime;
          const timeElapsed = currentTime - startTime;
          const progress = Math.min(timeElapsed / duration, 1);

          // Easing function: easeInOutQuad
          const easing = progress < 0.5
            ? 2 * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 2) / 2;

          scrollParent.scrollTop = startScrollTop + distance * easing;

          if (timeElapsed < duration) {
            requestAnimationFrame(animate);
          }
        };

        requestAnimationFrame(animate);
      }
    }
  }, [selectedSubtitleId]);

  const { requestEditSubtitleId, clearEditRequest } = useTimelineStore();

  // Handle focus request from shortcuts
  useEffect(() => {
    if (requestEditSubtitleId) {
      const textarea = textAreasRef.current[requestEditSubtitleId];
      if (textarea) {
        textarea.focus();
        // Clear request so it can be triggered again for the same ID if needed
        clearEditRequest();
      }
    }
  }, [requestEditSubtitleId, clearEditRequest]);

  const handleInternalSelect = (e: React.MouseEvent, subtitle: Subtitle) => {
    isInternalInteraction.current = true;
    const isMulti = e.metaKey;
    const isRange = e.shiftKey;
    toggleSubtitleSelection(subtitle.id, isMulti, isRange);
    onSubtitleClick?.(subtitle);
  };

  const handleFocus = (subtitle: Subtitle) => {
    isInternalInteraction.current = true;
    // Only toggle (clearing others if no mods) if NOT already selected.
    // This allows focusing to edit text WITHOUT losing multi-selection.
    if (!selectedSubtitleIds.includes(subtitle.id)) {
      toggleSubtitleSelection(subtitle.id);
    }
    onSubtitleClick?.(subtitle);
  };

  return (
    <>
      <div className="flex flex-col gap-4 p-4" onClick={() => clearSelection()}>
        <div className="flex justify-between items-center" onClick={e => e.stopPropagation()}>
          <div></div>
          <div className="flex gap-2 ml-auto">
            {subtitles.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowTranscriptionView(true)}
                title="Ver transcripción completa"
                className="w-8 justify-center"
              >
                <FileText className="w-4 h-4" />
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={onGenerateSubtitles}
              disabled={isGeneratingSubtitles}
              title="Generar subtítulos automáticamente con IA"
              className="w-8 justify-center"
            >
              {isGeneratingSubtitles ? <SpinnerIcon /> : <MagicMicIcon />}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                isInternalInteraction.current = true;
                if (onAddSubtitle) {
                  const newSubtitleBase = {
                    startTime: currentTime,
                    endTime: currentTime + 2,
                    text: ''
                  };
                  const newId = onAddSubtitle(newSubtitleBase);
                  toggleSubtitleSelection(newId);

                  requestAnimationFrame(() => {
                    const textarea = textAreasRef.current[newId];
                    if (textarea) {
                      textarea.focus();
                    }
                  });
                  return;
                }

                const newSubtitle: Subtitle = {
                  id: Date.now().toString(),
                  startTime: currentTime,
                  endTime: currentTime + 2,
                  text: ''
                };
                onSubtitlesChange?.([...subtitles, newSubtitle]);
                toggleSubtitleSelection(newSubtitle.id);
                requestAnimationFrame(() => {
                  const textarea = textAreasRef.current[newSubtitle.id];
                  if (textarea) {
                    textarea.focus();
                  }
                });
              }}
              title="Añadir subtítulo"
              className="w-8 justify-center"
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
                  ${selectedSubtitleIds.includes(subtitle.id) ? 'ring-2 ring-white' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleInternalSelect(e, subtitle);
                }}
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
                  className="bg-gray-600 rounded p-2 text-white text-sm resize-none overflow-hidden transition-colors border border-transparent focus:border-blue-500/50 focus:bg-gray-700 focus:outline-none min-h-[2rem]"
                  value={editingText[subtitle.id] || ''}
                  onChange={(e) => {
                    onTextChange(subtitle, e.target.value);
                    // Ajustar altura inmediatamente al escribir
                    e.target.style.height = 'auto';
                    e.target.style.height = `${e.target.scrollHeight}px`;
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleInternalSelect(e, subtitle);
                  }}
                  onFocus={() => handleFocus(subtitle)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => onKeyDown(e, subtitle)}
                  placeholder="Escribe el texto del subtítulo aquí..."
                  rows={1}
                />
              </div>
            ))
        )}
      </div>

      <TranscriptionViewModal
        isOpen={showTranscriptionView}
        onClose={() => setShowTranscriptionView(false)}
        onApplyGroups={(newSubtitles) => {
          onSubtitlesChange?.(newSubtitles);
        }}
      />
    </>
  );
}
