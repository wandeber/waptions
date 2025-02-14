import { DraggableNumberInput } from '../../design-system/DraggableNumberInput';
import type { SubtitleAnimationStyle } from './types';

interface AnimationSectionProps {
  style: SubtitleAnimationStyle;
  onStyleChange: (key: keyof SubtitleAnimationStyle, value: number | boolean | string) => void;
  type: 'entry' | 'exit';
}

export function AnimationSection({ style, onStyleChange, type }: AnimationSectionProps) {
  if (type === 'entry') {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <DraggableNumberInput
            label="Duración"
            value={style.fadeInDuration * 1000}
            onChange={(value) => onStyleChange('fadeInDuration', value / 1000)}
            min={0}
            max={500}
            step={50}
            unit="ms"
            layout="horizontal"
            labelWidth={100}
          />
        </div>

        <div className="flex flex-col gap-2">
          <DraggableNumberInput
            label="Escala inicial"
            value={style.initialScale * 100}
            onChange={(value) => onStyleChange('initialScale', value / 100)}
            min={100}
            max={200}
            step={10}
            unit="%"
            layout="horizontal"
            labelWidth={100}
          />
        </div>

        <div className="flex flex-col gap-2">
          <DraggableNumberInput
            label="Rebote"
            value={style.bounceStrength * 100}
            onChange={(value) => onStyleChange('bounceStrength', value / 100)}
            min={0}
            max={300}
            step={10}
            unit="%"
            layout="horizontal"
            labelWidth={100}
          />
        </div>

        <div className="items-center gap-2">
          <input
            type="checkbox"
            checked={style.useElasticEffect}
            onChange={(e) => onStyleChange('useElasticEffect', e.target.checked)}
            className="rounded border-gray-600 text-blue-600 focus:ring-blue-500"
          />
          <label className="text-sm text-gray-300">Usar efecto elástico</label>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Duración"
          value={style.fadeOutDuration * 1000}
          onChange={(value) => onStyleChange('fadeOutDuration', value / 1000)}
          min={0}
          max={500}
          step={50}
          unit="ms"
          layout="horizontal"
          labelWidth={100}
        />
      </div>
    </div>
  );
} 