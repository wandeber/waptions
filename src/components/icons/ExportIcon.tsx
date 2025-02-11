import { SVGProps } from 'react';

interface ExportIconProps extends SVGProps<SVGSVGElement> {
  className?: string;
}

export function ExportIcon({ className = 'w-4 h-4', ...props }: ExportIconProps) {
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
        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" 
      />
    </svg>
  );
} 