'use client';

import { useState, useEffect, useRef } from 'react';
import type { Subtitle } from './SubtitleTrack';
import { FontSelector } from './FontSelector';
import { MagicMicIcon } from '../icons/MagicMicIcon';
import { PlusIcon } from '../icons/PlusIcon';
import { CloseIcon } from '../icons/CloseIcon';
import { ChevronDownIcon } from '../icons/ChevronDownIcon';
import { Button } from '../design-system/Button';
import { DraggableNumberInput } from '../design-system/DraggableNumberInput';

interface SubtitleEditorProps {
  subtitles: Subtitle[];
  selectedSubtitleId?: string | null;
  onSubtitleClick?: (subtitle: Subtitle) => void;
  onDelete?: (subtitleId: string) => void;
  onSubtitlesChange?: (subtitles: Subtitle[]) => void;
  currentTime: number;
  onGenerateSubtitles?: () => void;
  isGeneratingSubtitles?: boolean;
  onAnimationStyleChange?: (style: SubtitleAnimationStyle) => void;
  animationStyle?: SubtitleAnimationStyle;
}

interface SubtitleAnimationStyle {
  // Propiedades de animación
  fadeInDuration: number;
  fadeOutDuration: number;
  initialScale: number;
  bounceStrength: number;
  useElasticEffect: boolean;
  // Propiedades de estilo visual
  fontSize: number;
  fontFamily: string;
  textColor: string;
  strokeWidth: number;
  strokeColor: string;
  fontWeight: number;
  textCase: 'normal' | 'uppercase' | 'lowercase';
  hidePunctuation: boolean;
  punctuationChars: string;
  removeAccents: boolean;
  // Propiedades del fondo
  backgroundColor: string;
  backgroundOpacity: number;
  backgroundBorderColor: string;
  backgroundBorderWidth: number;
  backgroundMarginVertical: number;
  backgroundMarginHorizontal: number;
  backgroundBorderRadius: number;
  backgroundOffsetX: number;
  backgroundOffsetY: number;
}

const defaultAnimationStyle: SubtitleAnimationStyle = {
  fadeInDuration: 0,
  fadeOutDuration: 0,
  initialScale: 1.5,
  bounceStrength: 1.70158,
  useElasticEffect: true,
  fontSize: 48,
  fontFamily: 'Inter',
  textColor: '#FFD000',
  strokeWidth: 6,
  strokeColor: '#000000',
  fontWeight: 800,
  textCase: 'normal',
  hidePunctuation: false,
  punctuationChars: '¿?:-,.;¡!',
  removeAccents: false,
  // Valores por defecto del fondo
  backgroundColor: '#000000',
  backgroundOpacity: 0.5,
  backgroundBorderColor: '#000000',
  backgroundBorderWidth: 0,
  backgroundMarginVertical: 8,
  backgroundMarginHorizontal: 16,
  backgroundBorderRadius: 4,
  backgroundOffsetX: 0,
  backgroundOffsetY: 0
};

export function SubtitleEditor({ 
  subtitles, 
  selectedSubtitleId, 
  onSubtitleClick, 
  onDelete, 
  onSubtitlesChange, 
  currentTime, 
  onGenerateSubtitles, 
  isGeneratingSubtitles,
  onAnimationStyleChange,
  animationStyle = defaultAnimationStyle
}: SubtitleEditorProps) {
  const [editingText, setEditingText] = useState<{[key: string]: string}>({});
  const [activeTab, setActiveTab] = useState<'subtitles' | 'style'>('subtitles');
  const [collapsedSections, setCollapsedSections] = useState<{[key: string]: boolean}>({
    textStyle: false,
    entryAnimation: false,
    exitAnimation: false,
    background: false
  });
  const textAreasRef = useRef<{[key: string]: HTMLTextAreaElement | null}>({});
  const [localAnimationStyle, setLocalAnimationStyle] = useState<SubtitleAnimationStyle>({
    ...defaultAnimationStyle,
    ...animationStyle
  });

  // Efecto para sincronizar los estilos locales con los props
  useEffect(() => {
    setLocalAnimationStyle({
      ...defaultAnimationStyle,
      ...animationStyle
    });
  }, [animationStyle]);

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
    
    if (onSubtitlesChange) {
      const updatedSubtitles = subtitles.map(s => 
        s.id === subtitle.id ? { ...s, text: newText } : s
      );
      onSubtitlesChange(updatedSubtitles);
    }

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
        onSubtitlesChange?.([...subtitles, newSubtitle]);
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
        onSubtitlesChange?.([...subtitles, newSubtitle]);
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
          endTime: subtitle.endTime
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
          const previousTextarea = textAreasRef.current[previousSubtitle.id];
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
        const previousTextarea = textAreasRef.current[previousSubtitle.id];
        if (previousTextarea) {
          previousTextarea.focus();
          previousTextarea.setSelectionRange(joinPosition, joinPosition);
        }
      });
    }
  };

  const handleStyleChange = (key: keyof SubtitleAnimationStyle, value: number | boolean | string) => {
    const newStyle = { ...localAnimationStyle, [key]: value };
    setLocalAnimationStyle(newStyle);
    onAnimationStyleChange?.(newStyle);
  };

  // Efecto para manejar atajos de teclado
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Si no hay subtítulo seleccionado, no hacemos nada
      if (!selectedSubtitleId) return;

      // Borrar subtítulo con tecla Supr/Delete
      if (e.key === 'Delete') {
        onDelete?.(selectedSubtitleId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSubtitleId, onDelete]);

  return (
    <div className="h-full flex flex-col">
      {/* Tabs - ahora pegados al panel */}
      <div className="flex">
        <button
          className={`px-4 py-2 text-sm font-medium rounded-t transition-colors ${
            activeTab === 'subtitles'
              ? 'bg-gray-800 text-white'
              : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
          }`}
          onClick={() => setActiveTab('subtitles')}
        >
          Subtítulos
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium rounded-t transition-colors ${
            activeTab === 'style'
              ? 'bg-gray-800 text-white'
              : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
          }`}
          onClick={() => setActiveTab('style')}
        >
          Estilo
        </button>
      </div>

      {/* Panel principal - sin redondeado arriba */}
      <div className="flex-1 bg-gray-800 rounded-b-lg overflow-hidden">
        {/* Panel de contenido */}
        <div className="h-full overflow-y-auto">
          {activeTab === 'subtitles' ? (
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
                        className="bg-gray-600 rounded p-2 text-white text-sm resize-none overflow-hidden transition-colors border border-transparent focus:border-blue-500/50 focus:bg-gray-700 focus:outline-none"
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
          ) : (
            <div className="flex flex-col divide-y divide-gray-700">
              {/* Estilo visual */}
              <div className="p-4">
                <button
                  onClick={() => setCollapsedSections(prev => ({ ...prev, textStyle: !prev.textStyle }))}
                  className="w-full flex items-center justify-between text-sm font-medium text-white hover:text-gray-300 transition-colors"
                >
                  <span>Estilo del texto</span>
                  <ChevronDownIcon 
                    className={`w-5 h-5 transition-transform ${
                      collapsedSections.textStyle ? '-rotate-90' : ''
                    }`}
                  />
                </button>
                {!collapsedSections.textStyle && (
                  <div className="flex flex-col gap-6 mt-4">
                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Fuente</label>
                      <FontSelector
                        value={localAnimationStyle.fontFamily}
                        onChange={(font) => handleStyleChange('fontFamily', font)}
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Tamaño de fuente</label>
                      <div className="flex gap-4 items-center">
                        <input
                          type="range"
                          min="24"
                          max="96"
                          step="1"
                          value={localAnimationStyle.fontSize}
                          onChange={(e) => handleStyleChange('fontSize', parseInt(e.target.value))}
                          className="flex-1"
                        />
                        <div className="text-xs text-gray-400 w-12 text-right">{localAnimationStyle.fontSize}px</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <label className="text-sm text-gray-300 whitespace-nowrap">Grosor de fuente</label>
                      <div className="relative flex-1">
                        <select
                          value={localAnimationStyle.fontWeight}
                          onChange={(e) => handleStyleChange('fontWeight', parseInt(e.target.value))}
                          className="w-full bg-gray-700 text-white rounded px-2 py-1.5 text-sm appearance-none"
                        >
                          <option value="400">Normal (400)</option>
                          <option value="500">Medium (500)</option>
                          <option value="600">Semi Bold (600)</option>
                          <option value="700">Bold (700)</option>
                          <option value="800">Extra Bold (800)</option>
                          <option value="900">Black (900)</option>
                        </select>
                        <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none text-gray-400">
                          <ChevronDownIcon />
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Color del texto</label>
                      <div className="flex gap-2 items-center">
                        <input
                          type="color"
                          value={localAnimationStyle.textColor}
                          onChange={(e) => handleStyleChange('textColor', e.target.value)}
                          className="w-8 h-8 rounded cursor-pointer"
                        />
                        <input
                          type="text"
                          value={localAnimationStyle.textColor}
                          onChange={(e) => handleStyleChange('textColor', e.target.value)}
                          className="flex-1 bg-gray-700 rounded px-2 py-1 text-sm text-white"
                        />
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Grosor del borde</label>
                      <div className="flex gap-4 items-center">
                        <input
                          type="range"
                          min="0"
                          max="8"
                          step="0.5"
                          value={localAnimationStyle.strokeWidth}
                          onChange={(e) => handleStyleChange('strokeWidth', parseFloat(e.target.value))}
                          className="flex-1"
                        />
                        <div className="text-xs text-gray-400 w-12 text-right">{localAnimationStyle.strokeWidth}px</div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Color del borde</label>
                      <div className="flex gap-2 items-center">
                        <input
                          type="color"
                          value={localAnimationStyle.strokeColor}
                          onChange={(e) => handleStyleChange('strokeColor', e.target.value)}
                          className="w-8 h-8 rounded cursor-pointer"
                        />
                        <input
                          type="text"
                          value={localAnimationStyle.strokeColor}
                          onChange={(e) => handleStyleChange('strokeColor', e.target.value)}
                          className="flex-1 bg-gray-700 rounded px-2 py-1 text-sm text-white"
                        />
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Transformación del texto</label>
                      <div className="flex gap-2">
                        <button
                          className={`px-3 py-1 rounded text-sm ${
                            localAnimationStyle.textCase === 'normal'
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                          }`}
                          onClick={() => handleStyleChange('textCase', 'normal')}
                        >
                          Normal
                        </button>
                        <button
                          className={`px-3 py-1 rounded text-sm ${
                            localAnimationStyle.textCase === 'uppercase'
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                          }`}
                          onClick={() => handleStyleChange('textCase', 'uppercase')}
                        >
                          MAYÚS.
                        </button>
                        <button
                          className={`px-3 py-1 rounded text-sm ${
                            localAnimationStyle.textCase === 'lowercase'
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                          }`}
                          onClick={() => handleStyleChange('textCase', 'lowercase')}
                        >
                          minús.
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={localAnimationStyle.hidePunctuation}
                          onChange={(e) => handleStyleChange('hidePunctuation', e.target.checked)}
                          className="rounded border-gray-600 text-blue-600 focus:ring-blue-500"
                        />
                        <label className="text-sm text-gray-300">Ocultar signos de puntuación</label>
                      </div>
                      
                      {localAnimationStyle.hidePunctuation && (
                        <div className="flex flex-col gap-1 pl-6">
                          <input
                            type="text"
                            value={localAnimationStyle.punctuationChars}
                            onChange={(e) => handleStyleChange('punctuationChars', e.target.value)}
                            className="bg-gray-700 rounded px-2 py-1 text-sm text-white"
                            placeholder="Caracteres a ocultar..."
                          />
                          <span className="text-xs text-gray-400">
                            Caracteres por defecto: ¿?:-,.;¡!
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={localAnimationStyle.removeAccents}
                        onChange={(e) => handleStyleChange('removeAccents', e.target.checked)}
                        className="rounded border-gray-600 text-blue-600 focus:ring-blue-500"
                      />
                      <label className="text-sm text-gray-300">Omitir tildes</label>
                    </div>
                  </div>
                )}
              </div>

              {/* Fondo */}
              <div className="p-4">
                <button
                  onClick={() => setCollapsedSections(prev => ({ ...prev, background: !prev.background }))}
                  className="w-full flex items-center justify-between text-sm font-medium text-white hover:text-gray-300 transition-colors"
                >
                  <span>Fondo</span>
                  <ChevronDownIcon 
                    className={`w-5 h-5 transition-transform ${
                      collapsedSections.background ? '-rotate-90' : ''
                    }`}
                  />
                </button>
                {!collapsedSections.background && (
                  <div className="flex flex-col gap-6 mt-4">
                    {/* Color y opacidad del fondo */}
                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Color del fondo</label>
                      <div className="flex gap-2 items-center">
                        <input
                          type="color"
                          value={localAnimationStyle.backgroundColor}
                          onChange={(e) => handleStyleChange('backgroundColor', e.target.value)}
                          className="w-8 h-8 rounded cursor-pointer"
                        />
                        <input
                          type="text"
                          value={localAnimationStyle.backgroundColor}
                          onChange={(e) => handleStyleChange('backgroundColor', e.target.value)}
                          className="flex-1 bg-gray-700 rounded px-2 py-1 text-sm text-white"
                        />
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Opacidad</label>
                      <div className="flex gap-4 items-center">
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={localAnimationStyle.backgroundOpacity}
                          onChange={(e) => handleStyleChange('backgroundOpacity', parseFloat(e.target.value))}
                          className="flex-1"
                        />
                        <div className="text-xs text-gray-400 w-12 text-right">
                          {Math.round(localAnimationStyle.backgroundOpacity * 100)}%
                        </div>
                      </div>
                    </div>

                    {/* Borde del fondo */}
                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Color del borde</label>
                      <div className="flex gap-2 items-center">
                        <input
                          type="color"
                          value={localAnimationStyle.backgroundBorderColor}
                          onChange={(e) => handleStyleChange('backgroundBorderColor', e.target.value)}
                          className="w-8 h-8 rounded cursor-pointer"
                        />
                        <input
                          type="text"
                          value={localAnimationStyle.backgroundBorderColor}
                          onChange={(e) => handleStyleChange('backgroundBorderColor', e.target.value)}
                          className="flex-1 bg-gray-700 rounded px-2 py-1 text-sm text-white"
                        />
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Grosor del borde</label>
                      <div className="flex gap-4 items-center">
                        <input
                          type="range"
                          min="0"
                          max="8"
                          step="0.5"
                          value={localAnimationStyle.backgroundBorderWidth}
                          onChange={(e) => handleStyleChange('backgroundBorderWidth', parseFloat(e.target.value))}
                          className="flex-1"
                        />
                        <div className="text-xs text-gray-400 w-12 text-right">{localAnimationStyle.backgroundBorderWidth}px</div>
                      </div>
                    </div>

                    {/* Márgenes */}
                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Margen vertical</label>
                      <div className="flex gap-4 items-center">
                        <input
                          type="range"
                          min="0"
                          max="32"
                          step="2"
                          value={localAnimationStyle.backgroundMarginVertical}
                          onChange={(e) => handleStyleChange('backgroundMarginVertical', parseInt(e.target.value))}
                          className="flex-1"
                        />
                        <div className="text-xs text-gray-400 w-12 text-right">{localAnimationStyle.backgroundMarginVertical}px</div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Margen horizontal</label>
                      <div className="flex gap-4 items-center">
                        <input
                          type="range"
                          min="0"
                          max="64"
                          step="4"
                          value={localAnimationStyle.backgroundMarginHorizontal}
                          onChange={(e) => handleStyleChange('backgroundMarginHorizontal', parseInt(e.target.value))}
                          className="flex-1"
                        />
                        <div className="text-xs text-gray-400 w-12 text-right">{localAnimationStyle.backgroundMarginHorizontal}px</div>
                      </div>
                    </div>

                    {/* Redondeo de esquinas */}
                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Redondeo de esquinas</label>
                      <div className="flex gap-4 items-center">
                        <input
                          type="range"
                          min="0"
                          max="16"
                          step="1"
                          value={localAnimationStyle.backgroundBorderRadius}
                          onChange={(e) => handleStyleChange('backgroundBorderRadius', parseInt(e.target.value))}
                          className="flex-1"
                        />
                        <div className="text-xs text-gray-400 w-12 text-right">{localAnimationStyle.backgroundBorderRadius}px</div>
                      </div>
                    </div>

                    {/* Offset del fondo */}
                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Desplazamiento del fondo</label>
                      <div className="flex flex-col gap-4">
                        <DraggableNumberInput
                          label="Horizontal (X)"
                          value={localAnimationStyle.backgroundOffsetX}
                          onChange={(value) => handleStyleChange('backgroundOffsetX', value)}
                          min={-100}
                          max={100}
                          step={1}
                          unit="px"
                        />
                        <div className="flex flex-col gap-2">
                          <label className="text-xs text-gray-400">Vertical (Y)</label>
                          <div className="flex gap-4 items-center">
                            <input
                              type="range"
                              min="-100"
                              max="100"
                              step="1"
                              value={localAnimationStyle.backgroundOffsetY}
                              onChange={(e) => handleStyleChange('backgroundOffsetY', parseInt(e.target.value))}
                              className="flex-1"
                            />
                            <div className="text-xs text-gray-400 w-12 text-right">{localAnimationStyle.backgroundOffsetY}px</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Animación de entrada */}
              <div className="p-4">
                <button
                  onClick={() => setCollapsedSections(prev => ({ ...prev, entryAnimation: !prev.entryAnimation }))}
                  className="w-full flex items-center justify-between text-sm font-medium text-white hover:text-gray-300 transition-colors"
                >
                  <span>Animación de entrada</span>
                  <ChevronDownIcon 
                    className={`w-5 h-5 transition-transform ${
                      collapsedSections.entryAnimation ? '-rotate-90' : ''
                    }`}
                  />
                </button>
                {!collapsedSections.entryAnimation && (
                  <div className="flex flex-col gap-6 mt-4">
                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Duración</label>
                      <div className="flex gap-4 items-center">
                        <input
                          type="range"
                          min="0"
                          max="0.5"
                          step="0.05"
                          value={localAnimationStyle.fadeInDuration}
                          onChange={(e) => handleStyleChange('fadeInDuration', parseFloat(e.target.value))}
                          className="flex-1"
                        />
                        <div className="text-xs text-gray-400 w-12 text-right">{localAnimationStyle.fadeInDuration}s</div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Escala inicial</label>
                      <div className="flex gap-4 items-center">
                        <input
                          type="range"
                          min="1"
                          max="2"
                          step="0.1"
                          value={localAnimationStyle.initialScale}
                          onChange={(e) => handleStyleChange('initialScale', parseFloat(e.target.value))}
                          className="flex-1"
                        />
                        <div className="text-xs text-gray-400 w-12 text-right">{localAnimationStyle.initialScale}x</div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Intensidad del rebote</label>
                      <div className="flex gap-4 items-center">
                        <input
                          type="range"
                          min="0"
                          max="3"
                          step="0.1"
                          value={localAnimationStyle.bounceStrength}
                          onChange={(e) => handleStyleChange('bounceStrength', parseFloat(e.target.value))}
                          className="flex-1"
                        />
                        <div className="text-xs text-gray-400 w-12 text-right">{localAnimationStyle.bounceStrength}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={localAnimationStyle.useElasticEffect}
                        onChange={(e) => handleStyleChange('useElasticEffect', e.target.checked)}
                        className="rounded border-gray-600 text-blue-600 focus:ring-blue-500"
                      />
                      <label className="text-sm text-gray-300">Usar efecto elástico</label>
                    </div>
                  </div>
                )}
              </div>

              {/* Animación de salida */}
              <div className="p-4">
                <button
                  onClick={() => setCollapsedSections(prev => ({ ...prev, exitAnimation: !prev.exitAnimation }))}
                  className="w-full flex items-center justify-between text-sm font-medium text-white hover:text-gray-300 transition-colors"
                >
                  <span>Animación de salida</span>
                  <ChevronDownIcon 
                    className={`w-5 h-5 transition-transform ${
                      collapsedSections.exitAnimation ? '-rotate-90' : ''
                    }`}
                  />
                </button>
                {!collapsedSections.exitAnimation && (
                  <div className="flex flex-col gap-6 mt-4">
                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Duración</label>
                      <div className="flex gap-4 items-center">
                        <input
                          type="range"
                          min="0"
                          max="0.5"
                          step="0.05"
                          value={localAnimationStyle.fadeOutDuration}
                          onChange={(e) => handleStyleChange('fadeOutDuration', parseFloat(e.target.value))}
                          className="flex-1"
                        />
                        <div className="text-xs text-gray-400 w-12 text-right">{localAnimationStyle.fadeOutDuration}s</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
} 