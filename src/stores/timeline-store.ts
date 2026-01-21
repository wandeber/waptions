import { create } from 'zustand';
import { SubtitleTrack, AnimationStyle, Subtitle } from '@/types/timeline';
import { storageService } from '@/lib/storage/storage-service';
import { useProjectStore } from './project-store';
import { useVideoStore } from './video-store'; // Import useVideoStore
import { getVideoInfo } from '@/lib/mediabunny-utils'; // Import getVideoInfo

interface HistorySnapshot {
    tracks: SubtitleTrack[];
    videoFile: File | null;
}

interface TimelineStore {
    zoomLevel: number;
    scrollLeft: number;
    tracks: SubtitleTrack[];
    pixelsPerSecond: number;
    activeTrackId: string | null;
    snapEnabled: boolean;
    activeSnapTime: number | null;

    // History
    history: HistorySnapshot[];
    redoStack: HistorySnapshot[];

    // Actions
    setZoom: (zoom: number) => void;
    setScrollLeft: (scroll: number) => void;

    addTrack: (name?: string, style?: AnimationStyle, options?: { skipHistory?: boolean }) => string;
    removeTrack: (id: string) => void;
    updateTrackStyle: (id: string, style: Partial<AnimationStyle>) => void;
    updateTrackName: (id: string, name: string) => void;

    addSubtitleToTrack: (trackId: string, subtitle: Omit<Subtitle, 'id'>) => string;
    updateSubtitleInTrack: (trackId: string, subtitleId: string, updates: Partial<Subtitle>, options?: { skipHistory?: boolean }) => void;
    removeSubtitleFromTrack: (trackId: string, subtitleId: string) => void;

    setTracks: (tracks: SubtitleTrack[]) => void;
    setActiveTrackId: (id: string | null) => void;

    // History Actions
    undo: () => Promise<void>;
    redo: () => Promise<void>;
    pushHistory: () => void;
    setSnapEnabled: (enabled: boolean) => void;
    setActiveSnapTime: (time: number | null) => void;
}

// Helper to save timeline changes
const saveTimelineToStorage = async (tracks: SubtitleTrack[]) => {
    try {
        // Access project store carefully to avoid circular dependency issues during initialization
        // We use getState() here which is safe at runtime
        const projectStore = useProjectStore.getState();
        const activeProject = projectStore.activeProject;
        if (activeProject) {
            // Check dirty state BEFORE saving to DB because auto-save doesn't affect "saved" status relative to explicit user save
            // Wait, "saved" means explicit user save. Auto-save is for crash recovery.
            // So if I modify something, checkDirty() compares against last EXPLICIT save snapshot.
            // So yes, we should check dirty.
            projectStore.checkDirty();
            await storageService.saveTimeline(activeProject.id, tracks);
        }
    } catch (error) {
        console.error("Failed to auto-save timeline:", error);
    }
};

export const useTimelineStore = create<TimelineStore>((set, get) => ({
    zoomLevel: 1,
    scrollLeft: 0,
    pixelsPerSecond: 100, // Base pixels per second at zoom 1
    tracks: [],
    activeTrackId: null,
    snapEnabled: true,
    activeSnapTime: null,

    history: [],
    redoStack: [],

    setZoom: (zoom) => set({ zoomLevel: Math.max(0.1, Math.min(10, zoom)) }),
    setScrollLeft: (scroll) => set({ scrollLeft: scroll }),

    pushHistory: () => {
        const { tracks, history } = get();
        const videoFile = useVideoStore.getState().videoFile;
        set({
            history: [...history, { tracks: JSON.parse(JSON.stringify(tracks)), videoFile }],
            redoStack: []
        });
    },

    undo: async () => {
        const { history, redoStack, tracks } = get();
        if (history.length === 0) return;

        const previousSnapshot = history[history.length - 1];
        const currentVideoFile = useVideoStore.getState().videoFile;

        // Save state for redo
        const newRedoStack = [...redoStack, { tracks: JSON.parse(JSON.stringify(tracks)), videoFile: currentVideoFile }];
        const newHistory = history.slice(0, -1);

        set({
            tracks: previousSnapshot.tracks,
            history: newHistory,
            redoStack: newRedoStack
        });

        const activeProjectId = useProjectStore.getState().activeProject?.id;

        // Restore video state if changed
        if (previousSnapshot.videoFile !== currentVideoFile) {
            if (previousSnapshot.videoFile) {
                try {
                    const info = await getVideoInfo(previousSnapshot.videoFile);
                    useVideoStore.getState().loadVideo(previousSnapshot.videoFile, info);
                    if (activeProjectId) await storageService.saveVideo(activeProjectId, previousSnapshot.videoFile);
                } catch (e) {
                    console.error("Failed to restore video from history", e);
                }
            } else {
                useVideoStore.getState().clearVideo();
                if (activeProjectId) await storageService.deleteVideo(activeProjectId);
            }
        }

        saveTimelineToStorage(previousSnapshot.tracks);
    },

    redo: async () => {
        const { history, redoStack, tracks } = get();
        if (redoStack.length === 0) return;

        const nextSnapshot = redoStack[redoStack.length - 1];
        const currentVideoFile = useVideoStore.getState().videoFile;

        // Save state for undo
        const newHistory = [...history, { tracks: JSON.parse(JSON.stringify(tracks)), videoFile: currentVideoFile }];
        const newRedoStack = redoStack.slice(0, -1);

        set({
            tracks: nextSnapshot.tracks,
            history: newHistory,
            redoStack: newRedoStack
        });

        const activeProjectId = useProjectStore.getState().activeProject?.id;

        // Restore video state if changed
        if (nextSnapshot.videoFile !== currentVideoFile) {
            if (nextSnapshot.videoFile) {
                try {
                    const info = await getVideoInfo(nextSnapshot.videoFile);
                    useVideoStore.getState().loadVideo(nextSnapshot.videoFile, info);
                    if (activeProjectId) await storageService.saveVideo(activeProjectId, nextSnapshot.videoFile);
                } catch (e) {
                    console.error("Failed to restore video from history", e);
                }
            } else {
                useVideoStore.getState().clearVideo();
                if (activeProjectId) await storageService.deleteVideo(activeProjectId);
            }
        }

        saveTimelineToStorage(nextSnapshot.tracks);
    },

    addTrack: (name, style, options) => {
        if (!options?.skipHistory) {
            get().pushHistory();
        }

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
            saveTimelineToStorage(newTracks);
            return {
                tracks: newTracks,
                activeTrackId: id
            };
        });
        return id;
    },

    removeTrack: (id) => {
        get().pushHistory();
        set((state) => {
            const nextTracks = state.tracks.filter(t => t.id !== id);
            let nextActiveId = state.activeTrackId;

            // Si borramos la capa activa, intentamos activar otra
            if (state.activeTrackId === id) {
                nextActiveId = nextTracks.length > 0 ? nextTracks[0].id : null;
            }

            saveTimelineToStorage(nextTracks);

            return {
                tracks: nextTracks,
                activeTrackId: nextActiveId
            };
        });
    },

    updateTrackStyle: (id, styleUpdates) => {
        get().pushHistory();
        set((state) => {
            const newTracks = state.tracks.map(t =>
                t.id === id ? { ...t, style: { ...t.style, ...styleUpdates } } : t
            );
            saveTimelineToStorage(newTracks);
            return { tracks: newTracks };
        });
    },

    updateTrackName: (id, name) => {
        get().pushHistory();
        set((state) => {
            const newTracks = state.tracks.map(t =>
                t.id === id ? { ...t, name } : t
            );
            saveTimelineToStorage(newTracks);
            return { tracks: newTracks };
        });
    },

    addSubtitleToTrack: (trackId, subtitle) => {
        get().pushHistory();
        const newId = crypto.randomUUID();
        set((state) => {
            const newTracks = state.tracks.map(t =>
                t.id === trackId
                    ? { ...t, subtitles: [...t.subtitles, { ...subtitle, id: newId }] }
                    : t
            );
            saveTimelineToStorage(newTracks);
            return { tracks: newTracks };
        });
        return newId;
    },

    updateSubtitleInTrack: (trackId, subtitleId, updates, options) => {
        if (!options?.skipHistory) {
            get().pushHistory();
        }
        set((state) => {
            const newTracks = state.tracks.map(t =>
                t.id === trackId
                    ? {
                        ...t,
                        subtitles: t.subtitles.map(s =>
                            s.id === subtitleId ? { ...s, ...updates } : s
                        )
                    }
                    : t
            );
            saveTimelineToStorage(newTracks);
            return { tracks: newTracks };
        });
    },

    removeSubtitleFromTrack: (trackId, subtitleId) => {
        get().pushHistory();
        set((state) => {
            const newTracks = state.tracks.map(t =>
                t.id === trackId
                    ? { ...t, subtitles: t.subtitles.filter(s => s.id !== subtitleId) }
                    : t
            );
            saveTimelineToStorage(newTracks);
            return { tracks: newTracks };
        });
    },

    setTracks: (tracks) => set((state) => {
        // Clearing history when setting tracks explicitly (e.g. loading project)
        const isValidActive = tracks.some(t => t.id === state.activeTrackId);
        return {
            tracks,
            activeTrackId: isValidActive ? state.activeTrackId : (tracks.length > 0 ? tracks[0].id : null),
            history: [],
            redoStack: []
        };
    }),

    setActiveTrackId: (id) => set((state) => ({
        activeTrackId: state.tracks.some(t => t.id === id) ? id : (state.tracks.length > 0 ? state.tracks[0].id : null)
    })),

    setSnapEnabled: (enabled) => set({ snapEnabled: enabled }),

    setActiveSnapTime: (time) => set({ activeSnapTime: time })
}));
