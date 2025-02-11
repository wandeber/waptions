import { SVGProps } from 'react';

interface StopIconProps extends SVGProps<SVGSVGElement> {
  className?: string;
}

export function StopIcon({ className = 'w-5 h-5', ...props }: StopIconProps) {
  return (
    <svg 
      className={className} 
      fill="none" 
      viewBox="0 0 24 24" 
      stroke="currentColor"
      {...props}
    >
      <rect x="6" y="6" width="12" height="12" strokeWidth={2} />
    </svg>
  );
} 