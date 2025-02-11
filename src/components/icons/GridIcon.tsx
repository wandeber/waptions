import { SVGProps } from 'react';

interface GridIconProps extends SVGProps<SVGSVGElement> {
  className?: string;
}

export function GridIcon({ className = 'w-5 h-5', ...props }: GridIconProps) {
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
        d="M4 8h16M4 16h16M16 4v16M8 4v16" 
      />
    </svg>
  );
} 