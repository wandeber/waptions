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
  textColor: string;
  strokeWidth: number;
  strokeColor: string;
  fontWeight: number;
  textCase: 'normal' | 'uppercase' | 'lowercase';
  hidePunctuation: boolean;
  punctuationChars: string;
  removeAccents: boolean;
}

const defaultAnimationStyle: SubtitleAnimationStyle = {
  fadeInDuration: 0.15,
  fadeOutDuration: 0.15,
  initialScale: 1.5,
  bounceStrength: 1.70158,
  useElasticEffect: true,
  fontSize: 48,
  textColor: '#FFD000',
  strokeWidth: 6,
  strokeColor: '#000000',
  fontWeight: 800,
  textCase: 'normal',
  hidePunctuation: false,
  punctuationChars: '¿?:-,;¡!',
  removeAccents: false
};

export function SubtitleEditor({ 
  subtitles, 
  selectedSubtitleId, 
  onSave, 
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
    exitAnimation: false
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

  const handleStyleChange = (key: keyof SubtitleAnimationStyle, value: number | boolean | string) => {
    const newStyle = { ...localAnimationStyle, [key]: value };
    setLocalAnimationStyle(newStyle);
    onAnimationStyleChange?.(newStyle);
  };

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
                  <button
                    className={`p-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors select-none ${
                      isGeneratingSubtitles ? 'opacity-50 cursor-not-allowed' : ''
                    }`}
                    onClick={onGenerateSubtitles}
                    disabled={isGeneratingSubtitles}
                    title="Generar subtítulos automáticamente"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                    </svg>
                  </button>
                  <button
                    className="p-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors select-none"
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
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </button>
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
                        <button
                          className="p-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors select-none"
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
                  <svg 
                    className={`w-5 h-5 transition-transform ${collapsedSections.textStyle ? '-rotate-90' : ''}`}
                    fill="none" 
                    viewBox="0 0 24 24" 
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {!collapsedSections.textStyle && (
                  <div className="flex flex-col gap-6 mt-4">
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

                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Grosor de fuente</label>
                      <div className="flex gap-4 items-center">
                        <input
                          type="range"
                          min="400"
                          max="900"
                          step="100"
                          value={localAnimationStyle.fontWeight}
                          onChange={(e) => handleStyleChange('fontWeight', parseInt(e.target.value))}
                          className="flex-1"
                        />
                        <div className="text-xs text-gray-400 w-12 text-right">{localAnimationStyle.fontWeight}</div>
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
                            Caracteres por defecto: ¿?:-,;¡!
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

              {/* Animación de entrada */}
              <div className="p-4">
                <button
                  onClick={() => setCollapsedSections(prev => ({ ...prev, entryAnimation: !prev.entryAnimation }))}
                  className="w-full flex items-center justify-between text-sm font-medium text-white hover:text-gray-300 transition-colors"
                >
                  <span>Animación de entrada</span>
                  <svg 
                    className={`w-5 h-5 transition-transform ${collapsedSections.entryAnimation ? '-rotate-90' : ''}`}
                    fill="none" 
                    viewBox="0 0 24 24" 
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {!collapsedSections.entryAnimation && (
                  <div className="flex flex-col gap-6 mt-4">
                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Duración</label>
                      <div className="flex gap-4 items-center">
                        <input
                          type="range"
                          min="0.05"
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
                  <svg 
                    className={`w-5 h-5 transition-transform ${collapsedSections.exitAnimation ? '-rotate-90' : ''}`}
                    fill="none" 
                    viewBox="0 0 24 24" 
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {!collapsedSections.exitAnimation && (
                  <div className="flex flex-col gap-6 mt-4">
                    <div className="flex flex-col gap-2">
                      <label className="text-sm text-gray-300">Duración</label>
                      <div className="flex gap-4 items-center">
                        <input
                          type="range"
                          min="0.05"
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