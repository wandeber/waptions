import { SVGProps } from 'react';

export function DevinIcon({ className = 'w-5 h-5', ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      <path d="M8 6h6a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H8V6z" />
    </svg>
  );
}