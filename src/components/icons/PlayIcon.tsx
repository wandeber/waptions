import { SVGProps } from 'react';

interface PlayIconProps extends SVGProps<SVGSVGElement> {
  className?: string;
}

export function PlayIcon({ className = 'w-5 h-5', ...props }: PlayIconProps) {
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
        d="M8 5v14l11-7z" 
      />
    </svg>
  );
} 