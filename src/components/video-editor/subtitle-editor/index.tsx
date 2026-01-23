'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Subtitle } from '@/types/timeline';
import { Tabs } from '../../design-system/Tabs';
import { Accordion } from '../../design-system/Accordion';
import { TextStyleSection } from './TextStyleSection';
import { BackgroundSection } from './BackgroundSection';
import { AnimationSection } from './AnimationSection';
import { PositionSection } from './PositionSection';
import { SubtitleList } from './SubtitleList';
import { StylePresetSelector } from './StylePresetSelector';
import type { SubtitleEditorProps, SubtitleAnimationStyle } from './types';
import { defaultAnimationStyle } from './types';
import { useTimelineStore } from '@/stores/timeline-store';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function debounce<T extends (...args: any[]) => void>(func: T, wait: number) {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

export function SubtitleEditor({
  subtitles,
  onSubtitleClick,
  onDelete,
  onSubtitlesChange,
  onSubtitleUpdate,
  onAddSubtitle,
  currentTime,
  onGenerateSubtitles,
  isGeneratingSubtitles,
  onAnimationStyleChange,
  animationStyle = defaultAnimationStyle,
  fps = 30
}: SubtitleEditorProps & { fps?: number }) {
  const { selectedSubtitleIds } = useTimelineStore();
  const frameDuration = fps > 0 ? 1 / fps : 0.01;
  const snapTime = (t: number) => Math.round(t / frameDuration) * frameDuration;

  const [editingText, setEditingText] = useState<{ [key: string]: string }>({});
  const [activeTab, setActiveTab] = useState<'subtitles' | 'style'>('subtitles');
  const [expandedStyleSection, setExpandedStyleSection] = useState<string | null>(null);
  const [localAnimationStyle, setLocalAnimationStyle] = useState<SubtitleAnimationStyle>({
    ...defaultAnimationStyle,
    ...animationStyle
  });

  const isTypingRef = useRef(false);
  const finishTyping = useCallback(() => {
    isTypingRef.current = false;
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedFinishTyping = useCallback(debounce(finishTyping, 300), [finishTyping]);

  // Efecto para sincronizar los estilos locales con los props
  useEffect(() => {
    const newStyle = {
      ...defaultAnimationStyle,
      ...animationStyle
    };
    // Solo actualizar si realmente hay cambios
    if (JSON.stringify(newStyle) !== JSON.stringify(localAnimationStyle)) {
      setLocalAnimationStyle(newStyle);
    }
  }, [animationStyle, localAnimationStyle]);

  // Sincronizar el texto de edición con los subtítulos (incluyendo fusiones externas)
  useEffect(() => {
    // Construir el objeto de texto esperado basado en los subtítulos actuales
    const expectedText: { [key: string]: string } = {};
    subtitles.forEach(s => {
      expectedText[s.id] = s.text;
    });

    // Detectar si necesitamos actualizar la memoria interna
    // 1. ¿Falta algún ID?
    // 2. ¿Sobra algún ID (limpieza)?
    // 3. ¿El texto de algún ID existente ha cambiado externamente (fusión)?
    const currentIds = Object.keys(editingText);
    const expectedIds = Object.keys(expectedText);

    const hasIdMismatch = currentIds.length !== expectedIds.length ||
      expectedIds.some(id => !editingText.hasOwnProperty(id));

    const hasTextMismatch = expectedIds.some(id =>
      editingText.hasOwnProperty(id) && editingText[id] !== expectedText[id] && !isTypingRef.current
    );

    if (hasIdMismatch || hasTextMismatch) {
      setEditingText(expectedText);
    }
  }, [subtitles, editingText]);

  const handleTextChange = (subtitle: Subtitle, newText: string) => {
    setEditingText(prev => ({ ...prev, [subtitle.id]: newText }));

    if (onSubtitleUpdate) {
      if (!isTypingRef.current) {
        // Al empezar a escribir, guardamos un punto en la historia (estado previo)
        onSubtitleUpdate(subtitle.id, { text: newText }, { skipHistory: false });
        isTypingRef.current = true;
      } else {
        // Mientras escribimos, actualizamos sin guardar en historia
        onSubtitleUpdate(subtitle.id, { text: newText }, { skipHistory: true });
      }
      debouncedFinishTyping();
    } else if (onSubtitlesChange) {
      const updatedSubtitles = subtitles.map(s =>
        s.id === subtitle.id ? { ...s, text: newText } : s
      );
      onSubtitlesChange(updatedSubtitles);
    }
  };

  const handleStyleChange = (
    key: keyof SubtitleAnimationStyle,
    value: SubtitleAnimationStyle[keyof SubtitleAnimationStyle]
  ) => {
    const newStyle = { ...localAnimationStyle, [key]: value };
    setLocalAnimationStyle(newStyle);
    onAnimationStyleChange?.(newStyle);
  };

  const handleSubtitleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>, subtitle: Subtitle) => {
    if (e.key === 'Escape') {
      e.currentTarget.blur();
      return;
    }

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
        splitTime = snapTime(subtitle.endTime);
        // Ajustar el tiempo final del nuevo subtítulo para asegurar la duración mínima
        const newEndTime = snapTime(splitTime + minDuration);

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
        onSubtitlesChange?.([...subtitles.map(s =>
          s.id === subtitle.id ? { ...s, text: firstPart, endTime: splitTime } : s
        ), newSubtitle]);
        onSubtitleClick?.(newSubtitle);

        // Mover el foco al nuevo textarea
        requestAnimationFrame(() => {
          const newTextarea = document.getElementById(`subtitle-${newSubtitle.id}`) as HTMLTextAreaElement;
          if (newTextarea) {
            newTextarea.focus();
            newTextarea.setSelectionRange(0, 0);
          }
        });
      } else {
        // Comportamiento normal para división en medio del texto
        splitTime = snapTime(subtitle.startTime + (originalDuration * splitRatio));

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
          endTime: snapTime(subtitle.endTime),
          text: secondPart
        };

        // Actualizar el estado local de edición
        setEditingText(prev => ({
          ...prev,
          [updatedOriginal.id]: firstPart,
          [newSubtitle.id]: secondPart
        }));

        // Guardar ambos subtítulos
        onSubtitlesChange?.([...subtitles.map(s =>
          s.id === subtitle.id ? { ...s, text: firstPart, endTime: splitTime } : s
        ), newSubtitle]);
        onSubtitleClick?.(newSubtitle);

        // Mover el foco al nuevo textarea
        requestAnimationFrame(() => {
          const newTextarea = document.getElementById(`subtitle-${newSubtitle.id}`) as HTMLTextAreaElement;
          if (newTextarea) {
            newTextarea.focus();
            newTextarea.setSelectionRange(0, 0);
          }
        });
      }
    } else if (e.key === 'Backspace') {
      const textarea = e.currentTarget;
      const currentText = editingText[subtitle.id] || '';

      // Si el texto no está vacío y no estamos al inicio, permitir el comportamiento normal
      if (currentText.length > 0 && textarea.selectionStart !== 0) {
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
      const previousText = editingText[previousSubtitle.id] || '';

      // Si el texto actual está vacío, simplemente borrar el subtítulo
      if (!currentText) {
        // Actualizar el subtítulo anterior para que llegue hasta el final del actual
        const updatedPrevious: Subtitle = {
          ...previousSubtitle,
          endTime: snapTime(subtitle.endTime)
        };

        // Actualizar el estado local de edición
        setEditingText(prev => {
          const newState = { ...prev };
          delete newState[subtitle.id];
          return newState;
        });

        // Actualizar los subtítulos y eliminar el actual
        const updatedSubtitles = subtitles
          .filter(s => s.id !== subtitle.id)
          .map(s => s.id === previousSubtitle.id ? updatedPrevious : s);

        onSubtitlesChange?.(updatedSubtitles);
        onSubtitleClick?.(updatedPrevious);

        // Mover el foco al textarea anterior y posicionar el cursor al final
        requestAnimationFrame(() => {
          const previousTextarea = document.getElementById(`subtitle-${previousSubtitle.id}`) as HTMLTextAreaElement;
          if (previousTextarea) {
            previousTextarea.focus();
            previousTextarea.setSelectionRange(previousText.length, previousText.length);
          }
        });
        return;
      }

      // Si hay texto, unir con el anterior
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

      // Actualizar los subtítulos y eliminar el actual
      const updatedSubtitles = subtitles
        .filter(s => s.id !== subtitle.id)
        .map(s => s.id === previousSubtitle.id ? updatedPrevious : s);

      onSubtitlesChange?.(updatedSubtitles);
      onSubtitleClick?.(updatedPrevious);

      // Calcular la posición del cursor donde ocurre el join
      const joinPosition = previousText.length;

      // Mover el foco al textarea anterior y posicionar el cursor en el punto de unión
      requestAnimationFrame(() => {
        const previousTextarea = document.getElementById(`subtitle-${previousSubtitle.id}`) as HTMLTextAreaElement;
        if (previousTextarea) {
          previousTextarea.focus();
          previousTextarea.setSelectionRange(joinPosition, joinPosition);
        }
      });
    }
  };

  // Efecto para manejar atajos de teclado
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Si no hay subtítulos seleccionados, no hacemos nada
      if (selectedSubtitleIds.length === 0) return;

      // Borrar subtítulos seleccionados con tecla Supr/Delete
      if (e.key === 'Delete') {
        selectedSubtitleIds.forEach(id => {
          onDelete?.(id);
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSubtitleIds, onDelete]);

  const handlePresetStyleChange = useCallback((newStyle: SubtitleAnimationStyle) => {
    setLocalAnimationStyle(newStyle);
    onAnimationStyleChange?.(newStyle);
  }, [onAnimationStyleChange]);

  const styleContent = (
    <div className="flex flex-col gap-6">
      <div className="px-4 pt-4">
        <StylePresetSelector
          currentStyle={localAnimationStyle}
          onStyleChange={handlePresetStyleChange}
        />
      </div>

      <Accordion
        sections={[
          {
            id: 'textStyle',
            title: 'Estilo del texto',
            content: (
              <TextStyleSection
                style={localAnimationStyle}
                onStyleChange={handleStyleChange}
              />
            )
          },
          {
            id: 'position',
            title: 'Posición',
            content: (
              <PositionSection
                style={localAnimationStyle}
                onStyleChange={handleStyleChange}
              />
            )
          },
          {
            id: 'background',
            title: 'Fondo',
            content: (
              <BackgroundSection
                style={localAnimationStyle}
                onStyleChange={handleStyleChange}
              />
            )
          },
          {
            id: 'entryAnimation',
            title: 'Animación de entrada',
            content: (
              <AnimationSection
                style={localAnimationStyle}
                onStyleChange={handleStyleChange}
                type="entry"
              />
            )
          },
          {
            id: 'exitAnimation',
            title: 'Animación de salida',
            content: (
              <AnimationSection
                style={localAnimationStyle}
                onStyleChange={handleStyleChange}
                type="exit"
              />
            )
          }
        ]}
        expandedSection={expandedStyleSection}
        onSectionChange={setExpandedStyleSection}
      />
    </div>
  );

  const tabs = [
    {
      id: 'subtitles',
      label: 'Subtítulos',
      content: (
        <SubtitleList
          subtitles={subtitles}
          editingText={editingText}
          currentTime={currentTime}
          onSubtitleClick={onSubtitleClick}
          onDelete={onDelete}
          onSubtitlesChange={onSubtitlesChange}
          onAddSubtitle={onAddSubtitle}
          onGenerateSubtitles={onGenerateSubtitles}
          isGeneratingSubtitles={isGeneratingSubtitles}
          onTextChange={handleTextChange}
          onKeyDown={handleSubtitleKeyDown}
        />
      )
    },
    {
      id: 'style',
      label: 'Estilo',
      content: styleContent
    }
  ];

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden select-none"
      data-testid="subtitle-editor"
    >
      <Tabs
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={(tabId) => setActiveTab(tabId as 'subtitles' | 'style')}
      />
    </div>
  );
} 