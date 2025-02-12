import { SVGProps } from 'react';

interface StopIconProps extends SVGProps<SVGSVGElement> {
  className?: string;
}

export function StopIcon({ className = 'w-5 h-5', ...props }: StopIconProps) {
  return (
    <svg 
      className={className} 
      viewBox="0 0 24 24" 
      fill="currentColor"
      stroke="currentColor"
      {...props}
    >
      <rect 
        x="6" 
        y="6" 
        width="12" 
        height="12" 
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
} 