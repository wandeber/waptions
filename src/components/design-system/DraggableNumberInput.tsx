import { useCallback, useEffect, useRef, useState } from 'react';
import { ResetIcon } from '../icons/ResetIcon';

interface DraggableNumberInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  unit?: string;
  className?: string;
  defaultValue?: number;
  /** Layout del componente. 'stacked' muestra el label arriba, 'horizontal' lo muestra a la izquierda */
  layout?: 'stacked' | 'horizontal';
  /** Ancho del label cuando el layout es horizontal. Por defecto se ajusta al contenido */
  labelWidth?: number;
}

/**
 * A numeric input component that can be changed by dragging horizontally.
 * Inspired by Blender's UI.
 * 
 * Features:
 * - Click and drag horizontally to change value (from input or label)
 * - Hold Shift for fine control (0.1x sensitivity)
 * - Double click on label to reset to default value
 * - Click reset button to restore default value
 * - Supports stacked (default) and horizontal layouts
 */
export function DraggableNumberInput({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  label,
  unit = '',
  className = '',
  defaultValue = 0,
  layout = 'stacked',
  labelWidth
}: DraggableNumberInputProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [startValue, setStartValue] = useState(0);
  const [inputValue, setInputValue] = useState(value.toString());
  const inputRef = useRef<HTMLInputElement>(null);
  const dragOverlayRef = useRef<HTMLDivElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [hasMoved, setHasMoved] = useState(false);
  const [clickCount, setClickCount] = useState(0);
  const clickTimer = useRef<NodeJS.Timeout | null>(null);

  // Update input value when prop changes
  useEffect(() => {
    setInputValue(value.toString());
  }, [value]);

  const resetToDefault = useCallback(() => {
    const clampedDefault = Math.min(max, Math.max(min, defaultValue));
    onChange(clampedDefault);
    setInputValue(clampedDefault.toString());
  }, [defaultValue, max, min, onChange]);

  const handleDragStart = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (e.button !== 0) return; // Solo botón izquierdo

    const isLabel = e.currentTarget.tagName.toLowerCase() === 'label';
    
    // Solo comprobar el foco si NO es el label
    if (!isLabel && isFocused) return;

    // Si es el label, gestionar el doble clic
    if (isLabel) {
      setClickCount(prev => prev + 1);
      
      // Limpiar el timer anterior si existe
      if (clickTimer.current) {
        clearTimeout(clickTimer.current);
      }
      
      // Configurar nuevo timer
      clickTimer.current = setTimeout(() => {
        setClickCount(0);
      }, 300);

      // Si es doble clic, no iniciar el arrastre
      if (clickCount === 1) {
        setClickCount(0);
        resetToDefault();
        return;
      }
    }

    setIsDragging(true);
    setHasMoved(false);
    setStartX(e.clientX);
    setStartValue(value);
    document.body.style.cursor = 'ew-resize';
    window.getSelection()?.removeAllRanges();
    
    // Activar el overlay de arrastre
    if (dragOverlayRef.current) {
      dragOverlayRef.current.style.display = 'block';
    }
    
    e.preventDefault();
  }, [value, isFocused, clickCount, resetToDefault]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;

    const dx = e.clientX - startX;
    const sensitivity = e.shiftKey ? 0.1 : 1; // Shift for fine control
    const newValue = startValue + (dx * step * sensitivity);
    const clampedValue = Math.min(max, Math.max(min, newValue));
    
    onChange(clampedValue);
    setInputValue(clampedValue.toString());
    
    e.preventDefault();
  }, [isDragging, startX, startValue, step, min, max, onChange]);

  const handleMouseUp = useCallback(() => {
    if (!isDragging) return;
    
    setIsDragging(false);
    setHasMoved(true);
    document.body.style.cursor = '';
    
    // Desactivar el overlay de arrastre
    if (dragOverlayRef.current) {
      dragOverlayRef.current.style.display = 'none';
    }

    // Si no hubo movimiento, dar foco al input
    if (!hasMoved) {
      inputRef.current?.focus();
    }
  }, [isDragging, hasMoved]);

  // Add/remove event listeners
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Cleanup click timer
  useEffect(() => {
    return () => {
      if (clickTimer.current) {
        clearTimeout(clickTimer.current);
      }
    };
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    const newValue = parseFloat(e.target.value);
    if (!isNaN(newValue)) {
      const clampedValue = Math.min(max, Math.max(min, newValue));
      onChange(clampedValue);
    }
  };

  const handleFocus = () => {
    setIsFocused(true);
  };

  const handleBlur = () => {
    setIsFocused(false);
    // Reset to current value if input is invalid
    if (isNaN(parseFloat(inputValue))) {
      setInputValue(value.toString());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      inputRef.current?.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const sensitivity = e.shiftKey ? 0.1 : 1;
      const direction = e.key === 'ArrowUp' ? 1 : -1;
      const newValue = value + (direction * step * sensitivity);
      const clampedValue = Math.min(max, Math.max(min, newValue));
      onChange(clampedValue);
      setInputValue(clampedValue.toString());
    }
  };

  return (
    <div className={`
      ${layout === 'stacked' ? 'flex flex-col gap-2' : 'flex items-center gap-3'}
      ${className}
    `}>
      {label && (
        <label 
          className={`
            text-sm text-gray-300 cursor-ew-resize select-none
            ${layout === 'horizontal' ? 'truncate' : ''}
          `}
          style={layout === 'horizontal' && labelWidth ? { width: labelWidth } : undefined}
          onMouseDown={handleDragStart}
          title={layout === 'horizontal' ? label : "Arrastra para cambiar valor. Doble clic para restablecer valor por defecto"}
        >
          {label}
        </label>
      )}
      <div className={`
        relative flex items-center
        ${layout === 'horizontal' ? 'min-w-[120px] flex-1' : ''}
      `}>
        {/* Overlay de arrastre - solo visible durante el arrastre */}
        <div
          ref={dragOverlayRef}
          className="fixed inset-0 z-50 cursor-ew-resize"
          style={{ display: 'none' }}
        />
        <div className="relative flex-1">
          {/* Fondo base */}
          <div className="absolute inset-0 bg-gray-700 rounded-l" />
          {/* Barra de progreso - solo visible cuando hay min y max definidos */}
          {min !== -Infinity && max !== Infinity && (
            <div 
              className="absolute inset-0 bg-gray-800 rounded-l pointer-events-none"
              style={{ 
                width: `${((value - min) / (max - min)) * 100}%`,
                opacity: 0.5
              }}
            />
          )}
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className={`relative w-full h-8 bg-transparent text-white rounded-l px-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500
              ${isFocused ? 'cursor-text' : 'cursor-ew-resize'}`}
          />
          {/* Área de arrastre - solo visible cuando no tiene foco */}
          {!isFocused && (
            <div
              className="absolute inset-0 cursor-ew-resize"
              onMouseDown={handleDragStart}
            />
          )}
          {unit && (
            <span className="absolute right-2 text-sm text-gray-400 top-1/2 -translate-y-1/2">{unit}</span>
          )}
        </div>
        <button
          onClick={resetToDefault}
          className="h-8 w-8 flex items-center justify-center bg-gray-700 text-gray-400 hover:text-white rounded-r border-l border-gray-600"
          title="Restablecer valor por defecto"
        >
          <ResetIcon />
        </button>
      </div>
    </div>
  );
} 