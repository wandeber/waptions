import { SVGProps } from 'react';

interface LoadVideoIconProps extends SVGProps<SVGSVGElement> {
  className?: string;
}

export function LoadVideoIcon({ className = 'w-6 h-6', ...props }: LoadVideoIconProps) {
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
        d="M12 6v6m0 0v6m0-6h6m-6 0H6" 
      />
    </svg>
  );
} 