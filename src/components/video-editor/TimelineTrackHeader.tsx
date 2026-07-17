'use client';

import { SubtitleTrack } from '@/types/timeline';
import { Captions, Eye, EyeOff, Trash2 } from 'lucide-react';
import { Button } from '../design-system/Button';
import { ConfirmDialog } from '../design-system/ConfirmDialog';
import { useTimelineStore } from '@/stores/timeline-store';
import { useState } from 'react';
import { InlineEditor } from '../design-system/InlineEditor';
import { useShallow } from 'zustand/react/shallow';

interface TimelineTrackHeaderProps {
    track: SubtitleTrack;
    onToggleVisibility: (id: string) => void;
    isActive: boolean;
    onClick: () => void;
}

export function TimelineTrackHeader({ track, onToggleVisibility, isActive, onClick }: TimelineTrackHeaderProps) {
    const { removeTrack, trackCount, updateTrackName } = useTimelineStore(useShallow((state) => ({
        removeTrack: state.removeTrack,
        trackCount: state.tracks.length,
        updateTrackName: state.updateTrackName,
    })));
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const isOnlyTrack = trackCount <= 1;

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
            className={`relative flex h-full cursor-pointer items-center gap-2 border-b border-slate-800 px-2.5 transition-colors duration-150
                ${isActive ? 'bg-violet-500/10 shadow-[inset_3px_0_0_0_#a78bfa]' : 'bg-slate-950 hover:bg-slate-900'}`}
            onClick={onClick}
        >
            <Captions className={`h-3.5 w-3.5 flex-none ${isActive ? 'text-violet-300' : 'text-slate-500'}`} />
            <div className="flex-1 min-w-0">
                <InlineEditor
                    initialValue={track.name}
                    onSave={(val) => updateTrackName(track.id, val)}
                    textClassName="text-xs font-medium text-slate-300"
                    inputClassName="text-xs font-medium h-6"
                />
            </div>

            <div className="flex items-center gap-0.5">
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
