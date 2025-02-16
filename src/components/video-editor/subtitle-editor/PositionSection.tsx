import { DraggableNumberInput } from '../../design-system/DraggableNumberInput';
import type { SubtitleAnimationStyle } from './types';
import { defaultAnimationStyle } from './types';

interface PositionSectionProps {
  style: SubtitleAnimationStyle;
  onStyleChange: (key: keyof SubtitleAnimationStyle, value: SubtitleAnimationStyle[keyof SubtitleAnimationStyle]) => void;
}

export function PositionSection({ style, onStyleChange }: PositionSectionProps) {
  const handlePositionChange = (axis: 'x' | 'y', value: number) => {
    onStyleChange('position', { ...style.position, [axis]: value });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <DraggableNumberInput
          label="Posición X"
          value={style.position.x}
          onChange={(value) => handlePositionChange('x', value)}
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
          onChange={(value) => handlePositionChange('y', value)}
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