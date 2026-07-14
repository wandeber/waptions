import { DraggableNumberInput } from '../../design-system/DraggableNumberInput';
import type { SubtitleAnimationStyle, SubtitleStyleEditHandlers } from './types';
import { defaultAnimationStyle } from './types';

interface PositionSectionProps extends SubtitleStyleEditHandlers {
  style: SubtitleAnimationStyle;
}

export function PositionSection({
  style,
  onStylePreview,
  onStyleCommit,
  onStyleCancel,
}: PositionSectionProps) {

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Posición X"
          value={style.position.x}
          onPreview={(value) => onStylePreview('position', { ...style.position, x: value })}
          onCommit={(value) => onStyleCommit('position', { ...style.position, x: value })}
          onCancel={() => onStyleCancel('position')}
          min={0}
          max={100}
          step={1}
          unit="%"
          layout="horizontal"
          labelWidth={100}
          defaultValue={defaultAnimationStyle.position.x}
        />
      </div>

      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Posición Y"
          value={style.position.y}
          onPreview={(value) => onStylePreview('position', { ...style.position, y: value })}
          onCommit={(value) => onStyleCommit('position', { ...style.position, y: value })}
          onCancel={() => onStyleCancel('position')}
          min={0}
          max={100}
          step={1}
          unit="%"
          layout="horizontal"
          labelWidth={100}
          defaultValue={defaultAnimationStyle.position.y}
        />
      </div>
    </div>
  );
}
