'use client';

import type { TimelineSubtitleTrack } from '@/stores/timeline-store-types';
import { Captions, Eye, EyeOff, Trash2 } from 'lucide-react';
import { Button } from '../design-system/Button';
import { ConfirmDialog } from '../design-system/ConfirmDialog';
import { useTimelineStore } from '@/stores/timeline-store';
import { useState } from 'react';
import { InlineEditor } from '../design-system/InlineEditor';
import { useShallow } from 'zustand/react/shallow';
import type { UnlinkedVideoEditResponse } from '@/types/timeline';

const UNLINKED_RESPONSE_PRESENTATION: Record<UnlinkedVideoEditResponse, {
    label: string;
    ariaLabel: string;
    title: string;
    next: UnlinkedVideoEditResponse;
}> = {
    'follow-project-ripple': {
        label: 'follow ripple',
        ariaLabel: 'follow project ripple',
        title: 'Unlinked cues follow uncontrolled video ripple. Click to keep them absolute.',
        next: 'stay-absolute',
    },
    'stay-absolute': {
        label: 'stay absolute',
        ariaLabel: 'stay absolute',
        title: 'Unlinked cues stay absolute during uncontrolled video edits. Click to remove cues overlapping deleted video.',
        next: 'remove-with-deleted-video-range',
    },
    'remove-with-deleted-video-range': {
        label: 'remove in deleted range',
        ariaLabel: 'remove with deleted video range',
        title: 'Unlinked cues overlapping deleted video are removed. Click to make them follow ripple.',
        next: 'follow-project-ripple',
    },
};

interface TimelineTrackHeaderProps {
    track: TimelineSubtitleTrack;
    onToggleVisibility: (id: string) => void;
    isActive: boolean;
    onClick: () => void;
}

export function TimelineTrackHeader({ track, onToggleVisibility, isActive, onClick }: TimelineTrackHeaderProps) {
    const {
        removeTrack,
        trackCount,
        updateTrackName,
        setSubtitleTrackUnlinkedVideoEditResponse,
    } = useTimelineStore(useShallow((state) => ({
        removeTrack: state.removeTrack,
        trackCount: state.tracks.length,
        updateTrackName: state.updateTrackName,
        setSubtitleTrackUnlinkedVideoEditResponse: state.setSubtitleTrackUnlinkedVideoEditResponse,
    })));
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const isOnlyTrack = trackCount <= 1;
    const unlinkedResponse = track.unlinkedVideoEditResponse
        ?? (track.timingDomain === 'video-ripple' ? 'follow-project-ripple' : 'stay-absolute');
    const responsePresentation = UNLINKED_RESPONSE_PRESENTATION[unlinkedResponse];

    const handleDeleteClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isOnlyTrack) return;
        setShowDeleteConfirm(true);
    };

    const handleConfirmDelete = () => {
        removeTrack(track.id);
        setShowDeleteConfirm(false);
    };

    return (
        <div
            className={`relative flex h-full cursor-pointer flex-col justify-center gap-0.5 border-b border-slate-800 px-2 transition-colors duration-150
                ${isActive ? 'bg-violet-500/10 shadow-[inset_3px_0_0_0_#a78bfa]' : 'bg-slate-950 hover:bg-slate-900'}`}
            onClick={onClick}
        >
            <div className="flex w-full min-w-0 items-center gap-1.5">
                <Captions className={`h-3.5 w-3.5 flex-none ${isActive ? 'text-violet-300' : 'text-slate-500'}`} />
                <div className="min-w-0 flex-1">
                    <InlineEditor
                        initialValue={track.name}
                        onSave={(val) => updateTrackName(track.id, val)}
                        textClassName="text-xs font-medium text-slate-300"
                        inputClassName="text-xs font-medium h-6"
                    />
                </div>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-slate-500 hover:bg-slate-800 hover:text-white"
                    onClick={() => onToggleVisibility(track.id)}
                    title={track.isVisible ? 'Hide subtitle track' : 'Show subtitle track'}
                    aria-label={track.isVisible ? `Hide ${track.name}` : `Show ${track.name}`}
                >
                    {track.isVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-slate-600 hover:bg-red-500/15 hover:text-red-300"
                    onClick={handleDeleteClick}
                    disabled={isOnlyTrack}
                    title={isOnlyTrack ? 'Keep at least one subtitle track' : 'Delete subtitle track'}
                    aria-label={`Delete ${track.name}`}
                >
                    <Trash2 className="h-3.5 w-3.5" />
                </Button>
            </div>
            <button
                type="button"
                className="w-full truncate rounded border border-violet-500/20 bg-violet-500/5 px-1.5 py-0.5 text-left text-[9px] text-violet-200 hover:bg-violet-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
                title={responsePresentation.title}
                aria-label={`${track.name} unlinked video edit response: ${responsePresentation.ariaLabel}`}
                onClick={(event) => {
                    event.stopPropagation();
                    setSubtitleTrackUnlinkedVideoEditResponse(
                        track.id,
                        responsePresentation.next,
                    );
                }}
            >
                Unlinked: {responsePresentation.label}
            </button>

            <ConfirmDialog
                isOpen={showDeleteConfirm}
                title="Delete subtitle track"
                message={<>Delete <strong>&ldquo;{track.name}&rdquo;</strong> and all of its subtitles? This can be undone from history.</>}
                confirmLabel="Delete"
                cancelLabel="Cancel"
                confirmVariant="danger"
                onConfirm={handleConfirmDelete}
                onCancel={() => setShowDeleteConfirm(false)}
            />
        </div>
    );
}
