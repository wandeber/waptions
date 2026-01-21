import { SVGProps } from 'react';

export function UndoIcon(props: SVGProps<SVGSVGElement>) {
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
                d="M9 15L3 9M3 9L9 3M3 9H15C19.9706 9 24 13.0294 24 18C24 19.9686 23.4889 21.8289 22.5858 23.4645"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}
