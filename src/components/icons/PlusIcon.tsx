import { SVGProps } from 'react';

interface PlusIconProps extends SVGProps<SVGSVGElement> {
  className?: string;
}

export function PlusIcon({ className = 'w-5 h-5', ...props }: PlusIconProps) {
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
        d="M12 4v16m8-8H4" 
      />
    </svg>
  );
} 