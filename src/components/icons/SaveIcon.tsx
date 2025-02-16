import { SVGProps } from 'react';

interface SaveIconProps extends SVGProps<SVGSVGElement> {
  className?: string;
}

export function SaveIcon({ className = 'w-5 h-5', ...props }: SaveIconProps) {
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
        d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2zM17 21v-8H7v8M7 3v5h8" 
      />
    </svg>
  );
} 