import { DraggableNumberInput } from '../../design-system/DraggableNumberInput';
import type { SubtitleAnimationStyle } from './types';

interface BackgroundSectionProps {
  style: SubtitleAnimationStyle;
  onStyleChange: (key: keyof SubtitleAnimationStyle, value: number | boolean | string) => void;
}

export function BackgroundSection({ style, onStyleChange }: BackgroundSectionProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label className="text-sm text-gray-300">Color del fondo</label>
        <div className="flex gap-2 items-center">
          <input
            type="color"
            value={style.backgroundColor}
            onChange={(e) => onStyleChange('backgroundColor', e.target.value)}
            className="w-8 h-8 rounded cursor-pointer"
          />
          <input
            type="text"
            value={style.backgroundColor}
            onChange={(e) => onStyleChange('backgroundColor', e.target.value)}
            className="flex-1 bg-gray-700 rounded px-2 py-1 text-sm text-white"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Opacidad"
          value={Math.round(style.backgroundOpacity * 100)}
          onChange={(value) => onStyleChange('backgroundOpacity', value / 100)}
          min={0}
          max={100}
          step={5}
          unit="%"
          layout="horizontal"
          labelWidth={100}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm text-gray-300">Color del borde</label>
        <div className="flex gap-2 items-center">
          <input
            type="color"
            value={style.backgroundBorderColor}
            onChange={(e) => onStyleChange('backgroundBorderColor', e.target.value)}
            className="w-8 h-8 rounded cursor-pointer"
          />
          <input
            type="text"
            value={style.backgroundBorderColor}
            onChange={(e) => onStyleChange('backgroundBorderColor', e.target.value)}
            className="flex-1 bg-gray-700 rounded px-2 py-1 text-sm text-white"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Grosor del borde"
          value={style.backgroundBorderWidth}
          onChange={(value) => onStyleChange('backgroundBorderWidth', value)}
          min={0}
          max={8}
          step={0.5}
          unit="px"
          layout="horizontal"
          labelWidth={100}
        />
      </div>

      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Margen vertical"
          value={style.backgroundMarginVertical}
          onChange={(value) => onStyleChange('backgroundMarginVertical', value)}
          min={0}
          max={32}
          step={2}
          unit="px"
          layout="horizontal"
          labelWidth={100}
        />
      </div>

      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Margen horizontal"
          value={style.backgroundMarginHorizontal}
          onChange={(value) => onStyleChange('backgroundMarginHorizontal', value)}
          min={0}
          max={64}
          step={4}
          unit="px"
          layout="horizontal"
          labelWidth={100}
        />
      </div>

      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Redondeo"
          value={style.backgroundBorderRadius}
          onChange={(value) => onStyleChange('backgroundBorderRadius', value)}
          min={0}
          max={16}
          step={1}
          unit="px"
          layout="horizontal"
          labelWidth={100}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm text-gray-300">Desplazamiento del fondo</label>
        <div className="flex flex-col gap-4">
          <DraggableNumberInput
            label="Horizontal (X)"
            value={style.backgroundOffsetX}
            onChange={(value) => onStyleChange('backgroundOffsetX', value)}
            min={-100}
            max={100}
            step={1}
            unit="px"
            layout="horizontal"
            labelWidth={100}
          />
          <DraggableNumberInput
            label="Vertical (Y)"
            value={style.backgroundOffsetY}
            onChange={(value) => onStyleChange('backgroundOffsetY', value)}
            min={-100}
            max={100}
            step={1}
            unit="px"
            layout="horizontal"
            labelWidth={100}
          />
        </div>
      </div>
    </div>
  );
} 