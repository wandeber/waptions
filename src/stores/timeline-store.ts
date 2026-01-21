import { create } from 'zustand';
import { SubtitleTrack, AnimationStyle } from '@/types/timeline';
import { Subtitle } from '@/components/video-editor/SubtitleTrack';

interface TimelineStore {
    zoomLevel: number;
    scrollLeft: number;
    tracks: SubtitleTrack[];
    pixelsPerSecond: number;
    activeTrackId: string | null;

    // Actions
    setZoom: (zoom: number) => void;
    setScrollLeft: (scroll: number) => void;

    addTrack: (name?: string, style?: AnimationStyle) => string;
    removeTrack: (id: string) => void;
    updateTrackStyle: (id: string, style: Partial<AnimationStyle>) => void;

    addSubtitleToTrack: (trackId: string, subtitle: Omit<Subtitle, 'id'>) => void;
    updateSubtitleInTrack: (trackId: string, subtitleId: string, updates: Partial<Subtitle>) => void;
    removeSubtitleFromTrack: (trackId: string, subtitleId: string) => void;

    setTracks: (tracks: SubtitleTrack[]) => void;
    setActiveTrackId: (id: string | null) => void;
}

export const useTimelineStore = create<TimelineStore>((set) => ({
    zoomLevel: 1,
    scrollLeft: 0,
    pixelsPerSecond: 100, // Base pixels per second at zoom 1
    tracks: [],
    activeTrackId: null,

    setZoom: (zoom) => set({ zoomLevel: Math.max(0.1, Math.min(10, zoom)) }),
    setScrollLeft: (scroll) => set({ scrollLeft: scroll }),

    addTrack: (name, style) => {
        const id = crypto.randomUUID();
        const defaultStyle: AnimationStyle = style || {
            fadeInDuration: 0,
            fadeOutDuration: 0,
            initialScale: 1.5,
            bounceStrength: 1.7,
            useElasticEffect: true,
            fontSize: 48,
            textColor: '#FFD000',
            strokeWidth: 6,
            strokeColor: '#000000',
            fontWeight: 800,
            textCase: 'uppercase',
            textAlign: 'center',
            hidePunctuation: false,
            punctuationChars: '¿?:-,.;¡!',
            removeAccents: false,
            fontFamily: 'Arial',
            numberOfLines: 1,
            position: { x: 50, y: 80 },
            backgroundColor: '#000000',
            backgroundOpacity: 0.5,
            backgroundBorderColor: '#FFD000',
            backgroundBorderWidth: 2,
            backgroundMarginVertical: 8,
            backgroundMarginHorizontal: 16,
            backgroundBorderRadius: 8,
            backgroundOffsetX: 0,
            backgroundOffsetY: 0
        };

        set((state) => {
            const newTracks = [...state.tracks, {
                id,
                name: name || `Capa ${state.tracks.length + 1}`,
                style: defaultStyle,
                subtitles: [],
                isVisible: true,
                isLocked: false
            }];
            return {
                tracks: newTracks,
                // Si es la primera o única capa, la hacemos activa
                activeTrackId: state.activeTrackId || id
            };
        });
        return id;
    },

    removeTrack: (id) => set((state) => {
        const nextTracks = state.tracks.filter(t => t.id !== id);
        let nextActiveId = state.activeTrackId;

        // Si borramos la capa activa, intentamos activar otra
        if (state.activeTrackId === id) {
            nextActiveId = nextTracks.length > 0 ? nextTracks[0].id : null;
        }

        return {
            tracks: nextTracks,
            activeTrackId: nextActiveId
        };
    }),

    updateTrackStyle: (id, styleUpdates) => set((state) => ({
        tracks: state.tracks.map(t =>
            t.id === id ? { ...t, style: { ...t.style, ...styleUpdates } } : t
        )
    })),

    addSubtitleToTrack: (trackId, subtitle) => set((state) => ({
        tracks: state.tracks.map(t =>
            t.id === trackId
                ? { ...t, subtitles: [...t.subtitles, { ...subtitle, id: crypto.randomUUID() }] }
                : t
        )
    })),

    updateSubtitleInTrack: (trackId, subtitleId, updates) => set((state) => ({
        tracks: state.tracks.map(t =>
            t.id === trackId
                ? {
                    ...t,
                    subtitles: t.subtitles.map(s =>
                        s.id === subtitleId ? { ...s, ...updates } : s
                    )
                }
                : t
        )
    })),

    removeSubtitleFromTrack: (trackId, subtitleId) => set((state) => ({
        tracks: state.tracks.map(t =>
            t.id === trackId
                ? { ...t, subtitles: t.subtitles.filter(s => s.id !== subtitleId) }
                : t
        )
    })),

    setTracks: (tracks) => set((state) => ({
        tracks,
        activeTrackId: state.activeTrackId || (tracks.length > 0 ? tracks[0].id : null)
    })),
    setActiveTrackId: (id) => set({ activeTrackId: id })
}));
