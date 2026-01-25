import { useState, useRef, useEffect, ReactNode, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

interface PopoverProps {
    trigger: ReactNode;
    children: ReactNode;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    className?: string;
    width?: number | string;
}

export function Popover({
    trigger,
    children,
    isOpen,
    onOpenChange,
    className = "",
    width = 256 // Default 64 * 4 = 256px
}: PopoverProps) {
    const triggerRef = useRef<HTMLDivElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
    const [placement, setPlacement] = useState<'up' | 'down'>('down');

    const updatePosition = useCallback(() => {
        if (!triggerRef.current) return;

        const rect = triggerRef.current.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const popoverHeight = 300; // Estimated max height

        const newPlacement = spaceBelow < popoverHeight ? 'up' : 'down';
        setPlacement(newPlacement);

        if (newPlacement === 'down') {
            setCoords({
                top: rect.bottom + window.scrollY + 4,
                left: Math.max(10, rect.right + window.scrollX - (typeof width === 'number' ? width : 256))
            });
        } else {
            setCoords({
                top: rect.top + window.scrollY - 4, // Will translate target by 100%
                left: Math.max(10, rect.right + window.scrollX - (typeof width === 'number' ? width : 256))
            });
        }
    }, [width]);

    // Use useLayoutEffect for initial positioning to avoid flicker
    useLayoutEffect(() => {
        if (isOpen) {
            updatePosition();
        } else {
            setCoords(null);
        }
    }, [isOpen, updatePosition]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                triggerRef.current && !triggerRef.current.contains(event.target as Node) &&
                popoverRef.current && !popoverRef.current.contains(event.target as Node)
            ) {
                onOpenChange(false);
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen, onOpenChange]);

    // Update position on scroll or resize to keep it attached
    useEffect(() => {
        if (!isOpen) return;

        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);

        return () => {
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
        };
    }, [isOpen, updatePosition]);

    return (
        <div className="relative inline-block" ref={triggerRef}>
            <div onClick={() => onOpenChange(!isOpen)}>
                {trigger}
            </div>

            {isOpen && createPortal(
                <div
                    ref={popoverRef}
                    className={`fixed bg-gray-800 border border-gray-700 rounded-lg shadow-2xl z-[100] py-1 animate-in fade-in duration-200 ring-1 ring-white/10 ${className} ${placement === 'up' ? 'slide-in-from-bottom-2' : 'slide-in-from-top-2'} ${!coords ? 'opacity-0' : 'opacity-100'}`}
                    style={{
                        top: coords?.top ?? 0,
                        left: coords?.left ?? 0,
                        width: width,
                        transform: placement === 'up' ? 'translateY(-100%)' : 'none',
                        visibility: coords ? 'visible' : 'hidden'
                    }}
                >
                    {children}
                </div>,
                document.body
            )}
        </div>
    );
}
