'use client';

import { useEffect, useRef } from 'react';
import {
    DEFAULT_TIMELINE_ROW_HEIGHT,
    MAXIMUM_TIMELINE_ROW_HEIGHT,
    MINIMUM_TIMELINE_ROW_HEIGHT,
    clampTimelineRowHeight,
    getTimelineRowHeightForKey,
} from '@/lib/editor-layout';

interface TimelineRowResizeHandleProps {
    rowKey: string;
    rowKind: 'subtitle' | 'video' | 'audio';
    label: string;
    height: number;
    projectId: string | null;
    onHeightChange: (height: number) => void;
}

/**
 * Accessible boundary handle for one timeline row.
 *
 * The separator is absolutely overlaid on the final pixels of the sidebar row, so it never adds
 * height or drifts away from the matching content row. Pointer capture keeps the drag terminal
 * even when the cursor leaves the sidebar; Escape and cancellation restore the starting height.
 */
export function TimelineRowResizeHandle({
    rowKey,
    rowKind,
    label,
    height,
    projectId,
    onHeightChange,
}: TimelineRowResizeHandleProps) {
    const cleanupRef = useRef<(() => void) | null>(null);

    useEffect(() => () => cleanupRef.current?.(), []);

    const beginPointerResize = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.stopPropagation();
        cleanupRef.current?.();

        const handle = event.currentTarget;
        const pointerId = event.pointerId;
        const gestureProjectId = projectId;
        const startY = event.clientY;
        const startHeight = height;
        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;
        let terminal = false;

        handle.focus({ preventScroll: true });
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        try {
            handle.setPointerCapture(pointerId);
        } catch {
            // Some synthetic pointer environments do not expose capture. Window-independent
            // keyboard cancellation and the remaining native pointer events still terminate it.
        }

        const cleanup = (restoreStart: boolean) => {
            if (terminal) return;
            terminal = true;
            handle.removeEventListener('pointermove', handlePointerMove);
            handle.removeEventListener('pointerup', handlePointerUp);
            handle.removeEventListener('pointercancel', handlePointerCancel);
            handle.removeEventListener('lostpointercapture', handleLostPointerCapture);
            window.removeEventListener('keydown', handleEscape);
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
            if (restoreStart && projectId === gestureProjectId) onHeightChange(startHeight);
            try {
                if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
            } catch {
                // Releasing an already-lost capture is terminal cleanup, not a user-visible error.
            }
            if (cleanupRef.current === cleanupWithoutRestore) cleanupRef.current = null;
        };
        const cleanupWithoutRestore = () => cleanup(false);
        const handlePointerMove = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== pointerId || projectId !== gestureProjectId) return;
            moveEvent.preventDefault();
            moveEvent.stopPropagation();
            onHeightChange(clampTimelineRowHeight(startHeight + moveEvent.clientY - startY));
        };
        const handlePointerUp = (upEvent: PointerEvent) => {
            if (upEvent.pointerId !== pointerId) return;
            upEvent.preventDefault();
            upEvent.stopPropagation();
            cleanup(false);
        };
        const handlePointerCancel = (cancelEvent: PointerEvent) => {
            if (cancelEvent.pointerId !== pointerId) return;
            cancelEvent.preventDefault();
            cancelEvent.stopPropagation();
            cleanup(true);
        };
        const handleLostPointerCapture = (lostEvent: PointerEvent) => {
            if (lostEvent.pointerId === pointerId) cleanup(true);
        };
        const handleEscape = (keyEvent: KeyboardEvent) => {
            if (keyEvent.key !== 'Escape') return;
            keyEvent.preventDefault();
            keyEvent.stopPropagation();
            cleanup(true);
        };

        handle.addEventListener('pointermove', handlePointerMove);
        handle.addEventListener('pointerup', handlePointerUp);
        handle.addEventListener('pointercancel', handlePointerCancel);
        handle.addEventListener('lostpointercapture', handleLostPointerCapture);
        window.addEventListener('keydown', handleEscape);
        cleanupRef.current = cleanupWithoutRestore;
    };

    return (
        <div
            role="separator"
            tabIndex={0}
            aria-label={`Resize ${label} row`}
            aria-orientation="horizontal"
            aria-valuemin={MINIMUM_TIMELINE_ROW_HEIGHT}
            aria-valuemax={MAXIMUM_TIMELINE_ROW_HEIGHT}
            aria-valuenow={height}
            title={`Drag to resize ${label} row`}
            data-testid="timeline-row-resize-handle"
            data-row-key={rowKey}
            data-row-kind={rowKind}
            className="group absolute inset-x-0 bottom-0 z-40 h-2 cursor-row-resize touch-none outline-none"
            onPointerDown={beginPointerResize}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onHeightChange(DEFAULT_TIMELINE_ROW_HEIGHT);
            }}
            onKeyDown={(event) => {
                const nextHeight = getTimelineRowHeightForKey(height, event.key, event.shiftKey);
                if (nextHeight === null) return;
                event.preventDefault();
                event.stopPropagation();
                onHeightChange(nextHeight);
            }}
        >
            <div className="absolute inset-x-0 bottom-0 h-px bg-gray-700 transition-colors group-hover:bg-blue-400 group-focus:bg-blue-400" />
        </div>
    );
}
