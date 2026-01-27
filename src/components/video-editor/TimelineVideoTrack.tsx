import { useTimelineStore } from '@/stores/timeline-store';
import { usePlaybackStore } from '@/stores/playback-store';

interface TimelineVideoTrackProps {
    duration: number;
}

export function TimelineVideoTrack({ duration }: TimelineVideoTrackProps) {
    const { pixelsPerSecond, zoomLevel, isVideoSelected, setVideoSelected } = useTimelineStore();

    if (duration <= 0) return null;

    const fps = usePlaybackStore.getState().fps || 30;
    const frameDuration = 1 / fps;
    const snappedDuration = Math.round(duration / frameDuration) * frameDuration;
    const width = Math.round(snappedDuration * pixelsPerSecond * zoomLevel);

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        setVideoSelected(true);
    };

    return (
        <div
            className={`absolute top-0 bottom-0 border transition-all pointer-events-auto cursor-pointer rounded-sm ${isVideoSelected
                    ? 'bg-blue-500/30 border-blue-400 shadow-[0_0_15px_rgba(96,165,250,0.4)] z-20'
                    : 'bg-blue-500/10 border-blue-400/20 hover:bg-blue-500/20 z-10'
                }`}
            style={{
                width: `${width}px`,
                height: '32px',
                top: '8px'
            }}
            onClick={handleClick}
        >
            <div className="absolute inset-0 flex items-center px-3 overflow-hidden pointer-events-none">
                <span className={`text-[10px] font-bold uppercase tracking-widest whitespace-nowrap transition-colors ${isVideoSelected ? 'text-blue-300' : 'text-blue-300/40'
                    }`}>
                    Video Clip {isVideoSelected && '(Seleccionado)'}
                </span>
            </div>
        </div>
    );
}
