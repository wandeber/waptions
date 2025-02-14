import { FontSelector } from '../FontSelector';
import { DraggableNumberInput } from '../../design-system/DraggableNumberInput';
import { ChevronDownIcon } from '../../icons/ChevronDownIcon';
import type { SubtitleAnimationStyle } from './types';

interface TextStyleSectionProps {
  style: SubtitleAnimationStyle;
  onStyleChange: (key: keyof SubtitleAnimationStyle, value: number | boolean | string) => void;
}

export function TextStyleSection({ style, onStyleChange }: TextStyleSectionProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label className="text-sm text-gray-300">Fuente</label>
        <FontSelector
          value={style.fontFamily}
          onChange={(font) => onStyleChange('fontFamily', font)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Tamaño"
          value={style.fontSize}
          onChange={(value) => onStyleChange('fontSize', value)}
          min={24}
          max={96}
          step={1}
          unit="px"
          layout="horizontal"
          labelWidth={100}
        />
      </div>

      <div className="flex items-center gap-4">
        <label className="text-sm text-gray-300 whitespace-nowrap">Grosor de fuente</label>
        <div className="relative flex-1">
          <select
            value={style.fontWeight}
            onChange={(e) => onStyleChange('fontWeight', parseInt(e.target.value))}
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
            value={style.textColor}
            onChange={(e) => onStyleChange('textColor', e.target.value)}
            className="w-8 h-8 rounded cursor-pointer"
          />
          <input
            type="text"
            value={style.textColor}
            onChange={(e) => onStyleChange('textColor', e.target.value)}
            className="flex-1 bg-gray-700 rounded px-2 py-1 text-sm text-white"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Grosor del borde"
          value={style.strokeWidth}
          onChange={(value) => onStyleChange('strokeWidth', value)}
          min={0}
          max={8}
          step={0.5}
          unit="px"
          layout="horizontal"
          labelWidth={100}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm text-gray-300">Color del borde</label>
        <div className="flex gap-2 items-center">
          <input
            type="color"
            value={style.strokeColor}
            onChange={(e) => onStyleChange('strokeColor', e.target.value)}
            className="w-8 h-8 rounded cursor-pointer"
          />
          <input
            type="text"
            value={style.strokeColor}
            onChange={(e) => onStyleChange('strokeColor', e.target.value)}
            className="flex-1 bg-gray-700 rounded px-2 py-1 text-sm text-white"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm text-gray-300">Transformación del texto</label>
        <div className="flex gap-2">
          <button
            className={`px-3 py-1 rounded text-sm ${
              style.textCase === 'normal'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            onClick={() => onStyleChange('textCase', 'normal')}
          >
            Normal
          </button>
          <button
            className={`px-3 py-1 rounded text-sm ${
              style.textCase === 'uppercase'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            onClick={() => onStyleChange('textCase', 'uppercase')}
          >
            MAYÚS.
          </button>
          <button
            className={`px-3 py-1 rounded text-sm ${
              style.textCase === 'lowercase'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            onClick={() => onStyleChange('textCase', 'lowercase')}
          >
            minús.
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={style.hidePunctuation}
            onChange={(e) => onStyleChange('hidePunctuation', e.target.checked)}
            className="rounded border-gray-600 text-blue-600 focus:ring-blue-500"
          />
          <label className="text-sm text-gray-300">Ocultar signos de puntuación</label>
        </div>
        
        {style.hidePunctuation && (
          <div className="flex flex-col gap-1 pl-6">
            <input
              type="text"
              value={style.punctuationChars}
              onChange={(e) => onStyleChange('punctuationChars', e.target.value)}
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
          checked={style.removeAccents}
          onChange={(e) => onStyleChange('removeAccents', e.target.checked)}
          className="rounded border-gray-600 text-blue-600 focus:ring-blue-500"
        />
        <label className="text-sm text-gray-300">Omitir tildes</label>
      </div>
    </div>
  );
} 