'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ScanSearch, Unlink } from 'lucide-react';

interface TimelineContextMenuProps {
    x: number;
    y: number;
    canSeparateAudio?: boolean;
    onSeparateAudio?: () => void;
    onDetectSceneCuts?: () => void;
    onClose: () => void;
    restoreFocusTo: HTMLElement | null;
    ariaLabel?: string;
}

/** Accessible context menu shared by pointer and keyboard clip invocations. */
export function TimelineContextMenu({
    x,
    y,
    canSeparateAudio = false,
    onSeparateAudio,
    onDetectSceneCuts,
    onClose,
    restoreFocusTo,
    ariaLabel = 'Clip actions',
}: TimelineContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);
    const actionRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const actions = useMemo(() => [
        ...(onSeparateAudio ? [{
            id: 'separate-audio',
            label: 'Separate audio',
            disabled: !canSeparateAudio,
            icon: Unlink,
            run: onSeparateAudio,
            restoreFocus: true,
            testId: 'separate-audio-action',
        }] : []),
        ...(onDetectSceneCuts ? [{
            id: 'detect-scene-cuts',
            label: 'Detect scene cuts…',
            disabled: false,
            icon: ScanSearch,
            run: onDetectSceneCuts,
            // The modal owns focus after this terminal action.
            restoreFocus: false,
            testId: 'detect-scene-cuts-action',
        }] : []),
    ], [canSeparateAudio, onDetectSceneCuts, onSeparateAudio]);

    const closeAndRestoreFocus = useCallback((restoreFocus = true) => {
        onClose();
        // Restoring focus makes pointer and keyboard flows repeatable and avoids dropping users
        // at the document body after Escape, an outside click, or a terminal menu action.
        if (restoreFocus) requestAnimationFrame(() => restoreFocusTo?.focus());
    }, [onClose, restoreFocusTo]);

    useEffect(() => {
        const firstEnabledIndex = actions.findIndex((action) => !action.disabled);
        if (firstEnabledIndex >= 0) actionRefs.current[firstEnabledIndex]?.focus();
        else menuRef.current?.focus();

        const closeFromOutside = (event: PointerEvent) => {
            if (!menuRef.current?.contains(event.target as Node)) closeAndRestoreFocus();
        };
        window.addEventListener('pointerdown', closeFromOutside);
        return () => window.removeEventListener('pointerdown', closeFromOutside);
    }, [actions, closeAndRestoreFocus]);

    const focusAction = (requestedIndex: number) => {
        if (actions.length === 0) return;
        for (let offset = 0; offset < actions.length; offset += 1) {
            const index = (requestedIndex + offset + actions.length) % actions.length;
            if (!actions[index].disabled) {
                actionRefs.current[index]?.focus();
                return;
            }
        }
    };

    return (
        <div
            ref={menuRef}
            role="menu"
            tabIndex={-1}
            data-testid="media-context-menu"
            className="fixed z-[100] min-w-44 rounded-md border border-gray-700 bg-gray-950 p-1 shadow-xl"
            style={{ left: x, top: y }}
            aria-label={ariaLabel}
            onClick={(event) => {
                // Context actions live inside their timeline row in the React tree. Keep their
                // terminal click from reaching the row's empty-space handler, which would clear
                // the multi-selection immediately before the modal starts using its snapshot.
                event.stopPropagation();
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    closeAndRestoreFocus();
                } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    event.stopPropagation();
                    const activeIndex = actionRefs.current.findIndex((item) => item === document.activeElement);
                    if (event.key === 'Home') focusAction(0);
                    else if (event.key === 'End') focusAction(actions.length - 1);
                    else focusAction(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
                }
            }}
        >
            {actions.map((action, index) => {
                const Icon = action.icon;
                return (
                    <button
                        key={action.id}
                        ref={(element) => { actionRefs.current[index] = element; }}
                        type="button"
                        role="menuitem"
                        data-testid={action.testId}
                        disabled={action.disabled}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-800 focus:bg-gray-800 focus:outline-none disabled:text-gray-600 disabled:hover:bg-transparent"
                        onClick={() => {
                            if (action.disabled) return;
                            action.run();
                            closeAndRestoreFocus(action.restoreFocus);
                        }}
                    >
                        <Icon className="h-3.5 w-3.5" />
                        {action.label}
                    </button>
                );
            })}
        </div>
    );
}
