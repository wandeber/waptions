'use client';

import { SubtitleTrack } from '@/types/timeline';
import { Eye, EyeOff, Trash2 } from 'lucide-react';
import { Button } from '../design-system/Button';
import { ConfirmDialog } from '../design-system/ConfirmDialog';
import { useTimelineStore } from '@/stores/timeline-store';
import { useState } from 'react';
import { InlineEditor } from '../design-system/InlineEditor';

interface TimelineTrackHeaderProps {
    track: SubtitleTrack;
    onToggleVisibility: (id: string) => void;
    isActive: boolean;
    onClick: () => void;
}

export function TimelineTrackHeader({ track, onToggleVisibility, isActive, onClick }: TimelineTrackHeaderProps) {
    const { removeTrack, tracks, updateTrackName } = useTimelineStore();
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const isOnlyTrack = tracks.length <= 1;

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
            className={`relative flex h-full items-center gap-2 border-b border-gray-800 px-3 cursor-pointer transition-colors duration-200
                ${isActive ? 'bg-gray-800 shadow-[inset_4px_0_0_0_#3b82f6]' : 'bg-gray-900 hover:bg-gray-800/50'}`}
            onClick={onClick}
        >
            <div className="flex-1 min-w-0">
                <InlineEditor
                    initialValue={track.name}
                    onSave={(val) => updateTrackName(track.id, val)}
                    textClassName="text-xs font-medium text-gray-300"
                    inputClassName="text-xs font-medium h-6"
                />
            </div>

            <div className="flex items-center gap-1">
                <Button
                    variant="secondary"
                    size="sm"
                    className="text-gray-400 hover:text-white"
                    onClick={() => onToggleVisibility(track.id)}
                    title={track.isVisible ? "Ocultar capa" : "Mostrar capa"}
                >
                    {track.isVisible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </Button>

                <Button
                    variant="secondary"
                    size="sm"
                    className="text-gray-400 hover:text-white"
                    onClick={handleDeleteClick}
                    disabled={isOnlyTrack}
                >
                    <Trash2 className="w-4 h-4" />
                </Button>
            </div>

            <ConfirmDialog
                isOpen={showDeleteConfirm}
                title="Eliminar capa"
                message={<>¿Estás seguro de que quieres eliminar la capa <strong>&ldquo;{track.name}&rdquo;</strong>? Esta acción no se puede deshacer.</>}
                confirmLabel="Eliminar"
                cancelLabel="Cancelar"
                confirmVariant="danger"
                onConfirm={handleConfirmDelete}
                onCancel={() => setShowDeleteConfirm(false)}
            />
        </div>
    );
}
