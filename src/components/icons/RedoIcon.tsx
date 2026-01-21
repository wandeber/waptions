import { SVGProps } from 'react';

export function RedoIcon(props: SVGProps<SVGSVGElement>) {
    return (
        <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            {...props}
        >
            <path
                d="M15 15L21 9M21 9L15 3M21 9H9C4.02944 9 0 13.0294 0 18C0 19.9686 0.511069 21.8289 1.41421 23.4645"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}
