'use client';

import { SubtitleTrack } from '@/types/timeline';
import { EyeIcon } from '../icons/EyeIcon';
import { EyeOffIcon } from '../icons/EyeOffIcon';
import { TrashIcon } from '../icons/TrashIcon';
import { Button } from '../design-system/Button';
import { useTimelineStore } from '@/stores/timeline-store';

interface TimelineTrackHeaderProps {
    track: SubtitleTrack;
    onToggleVisibility: (id: string) => void;
    isActive: boolean;
    onClick: () => void;
}

export function TimelineTrackHeader({ track, onToggleVisibility, isActive, onClick }: TimelineTrackHeaderProps) {
    const { removeTrack } = useTimelineStore();

    return (
        <div
            className={`flex items-center gap-2 px-3 border-b border-gray-800 cursor-pointer transition-colors
                ${isActive ? 'bg-gray-800' : 'bg-gray-900 hover:bg-gray-800/50'}`}
            style={{ height: '56px' }}
            onClick={onClick}
        >
            <div className="flex-1 min-w-0">
                <span className="text-xs font-medium text-gray-300 truncate block">
                    {track.name}
                </span>
            </div>

            <div className="flex items-center gap-1">
                <Button
                    variant="secondary"
                    size="sm"
                    className="text-gray-400 hover:text-white"
                    onClick={() => onToggleVisibility(track.id)}
                    title={track.isVisible ? "Ocultar capa" : "Mostrar capa"}
                >
                    {track.isVisible ? <EyeIcon /> : <EyeOffIcon />}
                </Button>

                <Button
                    variant="secondary"
                    size="sm"
                    className="text-gray-400 hover:text-white"
                    onClick={() => removeTrack(track.id)}
                    title="Eliminar capa"
                >
                    <TrashIcon />
                </Button>
            </div>
        </div>
    );
}
