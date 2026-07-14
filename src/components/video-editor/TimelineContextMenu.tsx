'use client';

import { useCallback, useEffect, useRef } from 'react';
import { Unlink } from 'lucide-react';

interface TimelineContextMenuProps {
    x: number;
    y: number;
    canSeparateAudio: boolean;
    onSeparateAudio: () => void;
    onClose: () => void;
    restoreFocusTo: HTMLElement | null;
}

/** Accessible context menu shared by pointer and keyboard clip invocations. */
export function TimelineContextMenu({
    x,
    y,
    canSeparateAudio,
    onSeparateAudio,
    onClose,
    restoreFocusTo,
}: TimelineContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);
    const actionRef = useRef<HTMLButtonElement>(null);

    const closeAndRestoreFocus = useCallback(() => {
        onClose();
        // Restoring focus makes pointer and keyboard flows repeatable and avoids dropping users
        // at the document body after Escape, an outside click, or a terminal menu action.
        requestAnimationFrame(() => restoreFocusTo?.focus());
    }, [onClose, restoreFocusTo]);

    useEffect(() => {
        if (canSeparateAudio) actionRef.current?.focus();
        else menuRef.current?.focus();

        const closeFromOutside = (event: PointerEvent) => {
            if (!menuRef.current?.contains(event.target as Node)) closeAndRestoreFocus();
        };
        window.addEventListener('pointerdown', closeFromOutside);
        return () => window.removeEventListener('pointerdown', closeFromOutside);
    }, [canSeparateAudio, closeAndRestoreFocus]);

    return (
        <div
            ref={menuRef}
            role="menu"
            tabIndex={-1}
            data-testid="media-context-menu"
            className="fixed z-[100] min-w-44 rounded-md border border-gray-700 bg-gray-950 p-1 shadow-xl"
            style={{ left: x, top: y }}
            aria-label="Clip actions"
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    closeAndRestoreFocus();
                } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (canSeparateAudio) actionRef.current?.focus();
                } else if ((event.key === 'Enter' || event.key === ' ') && event.target === menuRef.current) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (canSeparateAudio) {
                        onSeparateAudio();
                        closeAndRestoreFocus();
                    }
                }
            }}
        >
            <button
                ref={actionRef}
                type="button"
                role="menuitem"
                data-testid="separate-audio-action"
                disabled={!canSeparateAudio}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-800 focus:bg-gray-800 focus:outline-none disabled:text-gray-600 disabled:hover:bg-transparent"
                onClick={() => {
                    if (!canSeparateAudio) return;
                    onSeparateAudio();
                    closeAndRestoreFocus();
                }}
            >
                <Unlink className="h-3.5 w-3.5" />
                Separate audio
            </button>
        </div>
    );
}
