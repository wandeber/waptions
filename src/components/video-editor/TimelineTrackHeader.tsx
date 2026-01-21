'use client';

import { SubtitleTrack } from '@/types/timeline';
import { EyeIcon } from '../icons/EyeIcon';
import { EyeOffIcon } from '../icons/EyeOffIcon';
import { TrashIcon } from '../icons/TrashIcon';
import { SettingsIcon } from '../icons/SettingsIcon';
import { Button } from '../design-system/Button';
import { useTimelineStore } from '@/stores/timeline-store';

interface TimelineTrackHeaderProps {
    track: SubtitleTrack;
    onToggleVisibility: (id: string) => void;
    onOpenSettings: (id: string) => void;
}

export function TimelineTrackHeader({ track, onToggleVisibility, onOpenSettings }: TimelineTrackHeaderProps) {
    const { removeTrack } = useTimelineStore();

    return (
        <div className="flex items-center gap-2 px-3 bg-gray-900 border-b border-gray-800" style={{ height: '56px' }}>
            <div className="flex-1 min-w-0">
                <span className="text-xs font-medium text-gray-300 truncate block">
                    {track.name}
                </span>
            </div>

            <div className="flex items-center gap-1">
                <Button
                    variant="secondary"
                    className="p-1 h-8 w-8 text-gray-400 hover:text-white"
                    onClick={() => onToggleVisibility(track.id)}
                    title={track.isVisible ? "Ocultar capa" : "Mostrar capa"}
                >
                    {track.isVisible ? <EyeIcon className="w-5 h-5" /> : <EyeOffIcon className="w-5 h-5" />}
                </Button>

                <Button
                    variant="secondary"
                    className="p-1 h-8 w-8 text-gray-400 hover:text-white"
                    onClick={() => onOpenSettings(track.id)}
                    title="Configurar estilo de capa"
                >
                    <SettingsIcon className="w-4.5 h-4.5" />
                </Button>

                <Button
                    variant="danger"
                    className="p-1 h-8 w-8"
                    onClick={() => removeTrack(track.id)}
                    title="Eliminar capa"
                >
                    <TrashIcon className="w-4.5 h-4.5 text-white" />
                </Button>
            </div>
        </div>
    );
}
