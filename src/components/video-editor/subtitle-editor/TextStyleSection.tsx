import { FontSelector } from '../FontSelector';
import { DraggableNumberInput } from '../../design-system/DraggableNumberInput';
import { TransactionalHexInput } from '../../design-system/TransactionalHexInput';
import { Select } from '../../design-system/Select';
import { AlignLeftIcon } from '../../icons/AlignLeftIcon';
import { AlignCenterIcon } from '../../icons/AlignCenterIcon';
import { AlignRightIcon } from '../../icons/AlignRightIcon';
import { TextNormalIcon } from '../../icons/TextNormalIcon';
import { TextUppercaseIcon } from '../../icons/TextUppercaseIcon';
import { TextLowercaseIcon } from '../../icons/TextLowercaseIcon';
import type { SubtitleAnimationStyle, SubtitleStyleEditHandlers } from './types';

interface TextStyleSectionProps extends SubtitleStyleEditHandlers {
  style: SubtitleAnimationStyle;
}

export function TextStyleSection({
  style,
  onStyleChange,
  onStylePreview,
  onStyleCommit,
  onStyleCancel,
}: TextStyleSectionProps) {
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
          onPreview={(value) => onStylePreview('fontSize', value)}
          onCommit={(value) => onStyleCommit('fontSize', value)}
          onCancel={() => onStyleCancel('fontSize')}
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
        <Select
          value={style.fontWeight}
          onChange={(e) => onStyleChange('fontWeight', parseInt(e.target.value))}
          wrapperClassName="flex-1"
          tone="flat"
        >
          <option value="400">Normal (400)</option>
          <option value="500">Medium (500)</option>
          <option value="600">Semi Bold (600)</option>
          <option value="700">Bold (700)</option>
          <option value="800">Extra Bold (800)</option>
          <option value="900">Black (900)</option>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm text-gray-300">Color del texto</label>
        <div className="flex gap-2 items-center">
          <input
            type="color"
            value={style.textColor}
            onInput={(event) => onStylePreview('textColor', event.currentTarget.value)}
            onChange={(event) => onStyleCommit('textColor', event.currentTarget.value)}
            onBlur={() => onStyleCommit('textColor', style.textColor)}
            onPointerCancel={() => onStyleCancel('textColor')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onStyleCancel('textColor');
            }}
            className="w-8 h-8 rounded cursor-pointer"
          />
          <TransactionalHexInput
            ariaLabel="Text color hex"
            value={style.textColor}
            onPreview={(value) => onStylePreview('textColor', value)}
            onCommit={(value) => onStyleCommit('textColor', value)}
            onCancel={() => onStyleCancel('textColor')}
            className="flex-1 bg-gray-700 rounded px-2 py-1 text-sm text-white"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Grosor del borde"
          value={style.strokeWidth}
          onPreview={(value) => onStylePreview('strokeWidth', value)}
          onCommit={(value) => onStyleCommit('strokeWidth', value)}
          onCancel={() => onStyleCancel('strokeWidth')}
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
            onInput={(event) => onStylePreview('strokeColor', event.currentTarget.value)}
            onChange={(event) => onStyleCommit('strokeColor', event.currentTarget.value)}
            onBlur={() => onStyleCommit('strokeColor', style.strokeColor)}
            onPointerCancel={() => onStyleCancel('strokeColor')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onStyleCancel('strokeColor');
            }}
            className="w-8 h-8 rounded cursor-pointer"
          />
          <TransactionalHexInput
            ariaLabel="Stroke color hex"
            value={style.strokeColor}
            onPreview={(value) => onStylePreview('strokeColor', value)}
            onCommit={(value) => onStyleCommit('strokeColor', value)}
            onCancel={() => onStyleCancel('strokeColor')}
            className="flex-1 bg-gray-700 rounded px-2 py-1 text-sm text-white"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Número de líneas"
          value={style.numberOfLines}
          onPreview={(value) => onStylePreview('numberOfLines', value)}
          onCommit={(value) => onStyleCommit('numberOfLines', value)}
          onCancel={() => onStyleCancel('numberOfLines')}
          min={1}
          max={3}
          step={1}
          layout="horizontal"
          labelWidth={100}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm text-gray-300">Transformación del texto</label>
        <div className="flex gap-2">
          <button
            className={`p-2 rounded ${
              style.textCase === 'normal'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            onClick={() => onStyleChange('textCase', 'normal')}
            title="Normal"
          >
            <TextNormalIcon />
          </button>
          <button
            className={`p-2 rounded ${
              style.textCase === 'uppercase'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            onClick={() => onStyleChange('textCase', 'uppercase')}
            title="Mayúsculas"
          >
            <TextUppercaseIcon />
          </button>
          <button
            className={`p-2 rounded ${
              style.textCase === 'lowercase'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            onClick={() => onStyleChange('textCase', 'lowercase')}
            title="Minúsculas"
          >
            <TextLowercaseIcon />
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm text-gray-300">Alineación del texto</label>
        <div className="flex gap-2">
          <button
            className={`p-2 rounded ${
              style.textAlign === 'left'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            onClick={() => onStyleChange('textAlign', 'left')}
            title="Alinear a la izquierda"
          >
            <AlignLeftIcon />
          </button>
          <button
            className={`p-2 rounded ${
              style.textAlign === 'center'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            onClick={() => onStyleChange('textAlign', 'center')}
            title="Centrar"
          >
            <AlignCenterIcon />
          </button>
          <button
            className={`p-2 rounded ${
              style.textAlign === 'right'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            onClick={() => onStyleChange('textAlign', 'right')}
            title="Alinear a la derecha"
          >
            <AlignRightIcon />
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
              onChange={(event) => onStylePreview('punctuationChars', event.target.value)}
              onBlur={() => onStyleCommit('punctuationChars', style.punctuationChars)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onStyleCancel('punctuationChars');
                }
              }}
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
