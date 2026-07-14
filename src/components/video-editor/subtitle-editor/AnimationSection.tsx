import { DraggableNumberInput } from '../../design-system/DraggableNumberInput';
import type { SubtitleAnimationStyle, SubtitleStyleEditHandlers } from './types';

interface AnimationSectionProps extends SubtitleStyleEditHandlers {
  style: SubtitleAnimationStyle;
  type: 'entry' | 'exit';
}

export function AnimationSection({
  style,
  onStyleChange,
  onStylePreview,
  onStyleCommit,
  onStyleCancel,
  type,
}: AnimationSectionProps) {
  if (type === 'entry') {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <DraggableNumberInput
            label="Duración"
            value={style.fadeInDuration * 1000}
            onPreview={(value) => onStylePreview('fadeInDuration', value / 1000)}
            onCommit={(value) => onStyleCommit('fadeInDuration', value / 1000)}
            onCancel={() => onStyleCancel('fadeInDuration')}
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
            onPreview={(value) => onStylePreview('initialScale', value / 100)}
            onCommit={(value) => onStyleCommit('initialScale', value / 100)}
            onCancel={() => onStyleCancel('initialScale')}
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
            onPreview={(value) => onStylePreview('bounceStrength', value / 100)}
            onCommit={(value) => onStyleCommit('bounceStrength', value / 100)}
            onCancel={() => onStyleCancel('bounceStrength')}
            min={0}
            max={300}
            step={10}
            unit="%"
            layout="horizontal"
            labelWidth={100}
          />
        </div>

        <div className="flex items-center gap-2">
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
          onPreview={(value) => onStylePreview('fadeOutDuration', value / 1000)}
          onCommit={(value) => onStyleCommit('fadeOutDuration', value / 1000)}
          onCancel={() => onStyleCancel('fadeOutDuration')}
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
