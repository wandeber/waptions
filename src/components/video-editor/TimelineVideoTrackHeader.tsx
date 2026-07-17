'use client';

'use client';

import { useRef, useState } from 'react';
import { Clapperboard, Trash2 } from 'lucide-react';
import type { VideoTrack } from '@/types/video';
import type { VideoCutDetectionRequest } from '@/lib/video-cut/targets';
import { TimelineContextMenu } from './TimelineContextMenu';

interface TimelineVideoTrackHeaderProps {
    track: VideoTrack;
    index: number;
    canRemove: boolean;
    onRemove: () => void;
    selectedClipIds: readonly string[];
    onOpenCutDetection: (request: VideoCutDetectionRequest) => void;
}

/** Compact durable label for one independently resizable video lane. */
export function TimelineVideoTrackHeader({
    track,
    index,
    canRemove,
    onRemove,
    selectedClipIds,
    onOpenCutDetection,
}: TimelineVideoTrackHeaderProps) {
    const headerRef = useRef<HTMLDivElement>(null);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const openMenu = (x: number, y: number) => setMenu({ x, y });

    return (
        <div
            ref={headerRef}
            tabIndex={0}
            data-testid="timeline-video-track-header"
            className="group flex h-full items-center gap-2 bg-slate-950 px-3 text-xs font-medium text-sky-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-sky-400"
            aria-label={`${track.name} video track`}
            onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openMenu(event.clientX, event.clientY);
            }}
            onKeyDown={(event) => {
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                openMenu(bounds.left + Math.min(bounds.width, 28), bounds.top + Math.min(bounds.height, 28));
            }}
        >
            <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-300">
                V{index + 1}
            </span>
            <Clapperboard className="h-3.5 w-3.5 flex-none" />
            <span className="min-w-0 flex-1 truncate" title={track.name}>{track.name}</span>
            {canRemove && (
                <button
                    type="button"
                    className="rounded p-1 text-slate-500 opacity-0 transition-colors hover:bg-red-500/15 hover:text-red-300 focus:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 group-hover:opacity-100"
                    onClick={onRemove}
                    title={`Remove ${track.name}`}
                    aria-label={`Remove ${track.name}`}
                >
                    <Trash2 className="h-3.5 w-3.5" />
                </button>
            )}
            {menu && (
                <TimelineContextMenu
                    x={menu.x}
                    y={menu.y}
                    onDetectSceneCuts={() => onOpenCutDetection({
                        trackId: track.id,
                        clickedClipId: null,
                        selectedClipIds: [...selectedClipIds],
                        restoreFocusTo: headerRef.current,
                    })}
                    onClose={() => setMenu(null)}
                    restoreFocusTo={headerRef.current}
                    ariaLabel={`${track.name} video track actions`}
                />
            )}
        </div>
    );
}
