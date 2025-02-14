import { SVGProps } from 'react';

/**
 * Reset icon with a circular arrow design pointing left (counter-clockwise)
 */
export function ResetIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg 
      width="16" 
      height="16" 
      viewBox="0 0 16 16" 
      fill="none" 
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M4.5 5C5.5 4.2 6.7 3.75 8 3.75C10.9 3.75 13.25 6.1 13.25 9C13.25 11.9 10.9 14.25 8 14.25C5.1 14.25 2.75 11.9 2.75 9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 1.75L4.5 5L8 8.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
} 