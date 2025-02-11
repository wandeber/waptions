import { SVGProps } from 'react';

interface CloseIconProps extends SVGProps<SVGSVGElement> {
  className?: string;
}

export function CloseIcon({ className = 'w-4 h-4', ...props }: CloseIconProps) {
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
        d="M6 18L18 6M6 6l12 12" 
      />
    </svg>
  );
} 