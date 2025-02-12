import { SVGProps } from 'react';

interface PlayIconProps extends SVGProps<SVGSVGElement> {
  className?: string;
}

export function PlayIcon({ className = 'w-5 h-5', ...props }: PlayIconProps) {
  return (
    <svg 
      className={className} 
      viewBox="0 0 24 24" 
      fill="currentColor"
      stroke="currentColor"
      {...props}
    >
      <path 
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 5v14l11-7z" 
      />
    </svg>
  );
} 