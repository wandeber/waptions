import { SVGProps } from 'react';

interface ChevronDownIconProps extends SVGProps<SVGSVGElement> {
  className?: string;
}

export function ChevronDownIcon({ className = 'w-4 h-4', ...props }: ChevronDownIconProps) {
  return (
    <svg 
      className={className} 
      fill="none" 
      viewBox="0 0 24 24" 
      stroke="currentColor"
      {...props}
    >
      <path 
        strokeLinecap="round" 
        strokeLinejoin="round" 
        strokeWidth={2} 
        d="M19 9l-7 7-7-7" 
      />
    </svg>
  );
} 