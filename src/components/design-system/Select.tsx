import { ReactNode, SelectHTMLAttributes } from 'react';
import { ChevronDownIcon } from '../icons/ChevronDownIcon';

type SelectTone = 'flat' | 'panel' | 'modal' | 'modalSuccess';
type SelectSize = 'compact' | 'xs' | 'sm' | 'md';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode;
  wrapperClassName?: string;
  tone?: SelectTone;
  controlSize?: SelectSize;
}

export function Select({
  children,
  wrapperClassName = '',
  tone = 'panel',
  controlSize = 'sm',
  className = '',
  ...props
}: SelectProps) {
  const toneStyles: Record<SelectTone, string> = {
    flat: 'bg-gray-700 text-white focus:ring-blue-500/40',
    panel: 'bg-gray-700 border border-gray-600 text-white focus:ring-blue-500/40',
    modal: 'bg-gray-950 border border-gray-700 text-white focus:ring-blue-500/50',
    modalSuccess: 'bg-gray-950 border border-gray-700 text-white focus:ring-emerald-500/50',
  };

  const sizeStyles: Record<SelectSize, string> = {
    compact: 'p-1 pr-8 text-sm',
    xs: 'px-2 py-1.5 pr-8 text-xs',
    sm: 'px-2 py-1.5 pr-8 text-sm',
    md: 'px-3 py-2 pr-9 text-sm',
  };

  return (
    <div className={`relative ${wrapperClassName}`}>
      <select
        className={`w-full rounded appearance-none transition-colors focus:outline-none focus:ring-2 disabled:opacity-50 disabled:cursor-not-allowed ${toneStyles[tone]} ${sizeStyles[controlSize]} ${className}`}
        {...props}
      >
        {children}
      </select>
      <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none text-gray-400">
        <ChevronDownIcon />
      </div>
    </div>
  );
}
