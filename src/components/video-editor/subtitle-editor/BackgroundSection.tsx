import { DraggableNumberInput } from '../../design-system/DraggableNumberInput';
import { TransactionalHexInput } from '../../design-system/TransactionalHexInput';
import type { SubtitleAnimationStyle, SubtitleStyleEditHandlers } from './types';

interface BackgroundSectionProps extends SubtitleStyleEditHandlers {
  style: SubtitleAnimationStyle;
}

export function BackgroundSection({
  style,
  onStylePreview,
  onStyleCommit,
  onStyleCancel,
}: BackgroundSectionProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label className="text-sm text-gray-300">Color del fondo</label>
        <div className="flex gap-2 items-center">
          <input
            type="color"
            value={style.backgroundColor}
            onInput={(event) => onStylePreview('backgroundColor', event.currentTarget.value)}
            onChange={(event) => onStyleCommit('backgroundColor', event.currentTarget.value)}
            onBlur={() => onStyleCommit('backgroundColor', style.backgroundColor)}
            onPointerCancel={() => onStyleCancel('backgroundColor')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onStyleCancel('backgroundColor');
            }}
            className="w-8 h-8 rounded cursor-pointer"
          />
          <TransactionalHexInput
            ariaLabel="Background color hex"
            value={style.backgroundColor}
            onPreview={(value) => onStylePreview('backgroundColor', value)}
            onCommit={(value) => onStyleCommit('backgroundColor', value)}
            onCancel={() => onStyleCancel('backgroundColor')}
            className="flex-1 bg-gray-700 rounded px-2 py-1 text-sm text-white"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Opacidad"
          value={Math.round(style.backgroundOpacity * 100)}
          onPreview={(value) => onStylePreview('backgroundOpacity', value / 100)}
          onCommit={(value) => onStyleCommit('backgroundOpacity', value / 100)}
          onCancel={() => onStyleCancel('backgroundOpacity')}
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
            onInput={(event) => onStylePreview('backgroundBorderColor', event.currentTarget.value)}
            onChange={(event) => onStyleCommit('backgroundBorderColor', event.currentTarget.value)}
            onBlur={() => onStyleCommit('backgroundBorderColor', style.backgroundBorderColor)}
            onPointerCancel={() => onStyleCancel('backgroundBorderColor')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onStyleCancel('backgroundBorderColor');
            }}
            className="w-8 h-8 rounded cursor-pointer"
          />
          <TransactionalHexInput
            ariaLabel="Background border color hex"
            value={style.backgroundBorderColor}
            onPreview={(value) => onStylePreview('backgroundBorderColor', value)}
            onCommit={(value) => onStyleCommit('backgroundBorderColor', value)}
            onCancel={() => onStyleCancel('backgroundBorderColor')}
            className="flex-1 bg-gray-700 rounded px-2 py-1 text-sm text-white"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Grosor del borde"
          value={style.backgroundBorderWidth}
          onPreview={(value) => onStylePreview('backgroundBorderWidth', value)}
          onCommit={(value) => onStyleCommit('backgroundBorderWidth', value)}
          onCancel={() => onStyleCancel('backgroundBorderWidth')}
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
          onPreview={(value) => onStylePreview('backgroundMarginVertical', value)}
          onCommit={(value) => onStyleCommit('backgroundMarginVertical', value)}
          onCancel={() => onStyleCancel('backgroundMarginVertical')}
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
          onPreview={(value) => onStylePreview('backgroundMarginHorizontal', value)}
          onCommit={(value) => onStyleCommit('backgroundMarginHorizontal', value)}
          onCancel={() => onStyleCancel('backgroundMarginHorizontal')}
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
          onPreview={(value) => onStylePreview('backgroundBorderRadius', value)}
          onCommit={(value) => onStyleCommit('backgroundBorderRadius', value)}
          onCancel={() => onStyleCancel('backgroundBorderRadius')}
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
            onPreview={(value) => onStylePreview('backgroundOffsetX', value)}
            onCommit={(value) => onStyleCommit('backgroundOffsetX', value)}
            onCancel={() => onStyleCancel('backgroundOffsetX')}
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
            onPreview={(value) => onStylePreview('backgroundOffsetY', value)}
            onCommit={(value) => onStyleCommit('backgroundOffsetY', value)}
            onCancel={() => onStyleCancel('backgroundOffsetY')}
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
