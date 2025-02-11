import { SVGProps } from 'react';

interface MagicMicIconProps extends SVGProps<SVGSVGElement> {
  className?: string;
}

export function MagicMicIcon({ className = 'w-5 h-5', ...props }: MagicMicIconProps) {
  return (
    <svg 
      className={className} 
      fill="none" 
      viewBox="0 0 24 24" 
      stroke="currentColor"
      {...props}
    >
      {/* Magic sparkle - square star with all concave edges */}
      <path 
        stroke="currentColor" 
        fill="currentColor" 
        strokeLinecap="round" 
        strokeLinejoin="round" 
        strokeWidth={0.5} 
        d="M19 1 Q20.5 4 22 4 Q19.5 4 19 7 Q18.5 4 16 4 Q18.5 4 19 1" 
      />
      {/* Centered smaller microphone */}
      <g transform="translate(0,2) scale(0.85)">
        <path 
          strokeLinecap="round" 
          strokeLinejoin="round" 
          strokeWidth={2} 
          d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" 
        />
      </g>
    </svg>
  );
} 