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
    selectedSubtitleIds: string[];
    lastSelectedId: string | null;
    snapEnabled: boolean;
    activeSnapTime: number | null;
    clipboard: { subtitle: Subtitle, relativeTrackIndex: number }[] | null;
    requestEditSubtitleId: string | null;

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
    moveSubtitleToTrack: (subtitleId: string, sourceTrackId: string, targetTrackId: string) => void;
    moveSubtitlesToTrack: (subtitleIds: string[], deltaTrackIndex: number, options?: { skipHistory?: boolean }) => void;
    removeSubtitleFromTrack: (trackId: string, subtitleId: string) => void;

    setTracks: (tracks: SubtitleTrack[]) => void;
    setActiveTrackId: (id: string | null) => void;
    toggleSubtitleSelection: (id: string, isMulti?: boolean, isRange?: boolean) => void;
    clearSelection: () => void;
    copySelection: () => void;
    pasteSelection: (startTime: number) => void;
    trimSubtitleAtTime: (time: number, side: 'start' | 'end') => void;
    selectSubtitleAtTime: (time: number) => string | null;
    requestEditSubtitleAtTime: (time: number) => void;
    clearEditRequest: () => void;

    // History Actions
    undo: () => Promise<void>;
    redo: () => Promise<void>;
    pushHistory: () => void;
    setSnapEnabled: (enabled: boolean) => void;
    setActiveSnapTime: (time: number | null) => void;

    // Transcription Persistence
    rawTranscription: Subtitle[] | null;
    transcriptionGroups: { [key: string]: Subtitle[] } | null;
    transcriptionContainerIds: string[] | null;
    setTranscriptionState: (
        groups: { [key: string]: Subtitle[] } | null,
        containerIds: string[] | null,
        raw?: Subtitle[] | null
    ) => void;
    // Layer generation helpers
    generateDefaultGrouperState: (words: Subtitle[], wordsPerLine?: number) => { groups: { [key: string]: Subtitle[] }, containerIds: string[] };
    generateTimelineSubtitles: (words: Subtitle[], wordsPerLine?: number) => Subtitle[];
}

// Helper to save timeline changes
const saveTimelineToStorage = async (tracks: SubtitleTrack[]) => {
    try {
        // Access project store carefully to avoid circular dependency issues during initialization
        // We use getState() here which is safe at runtime
        const projectStore = useProjectStore.getState();
        const activeProject = projectStore.activeProject;
        if (activeProject) {
            projectStore.checkDirty();
            const timelineStore = useTimelineStore.getState();
            await storageService.saveTimeline(
                activeProject.id,
                tracks,
                timelineStore.rawTranscription,
                timelineStore.transcriptionGroups,
                timelineStore.transcriptionContainerIds
            );
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
    selectedSubtitleIds: [],
    lastSelectedId: null,
    snapEnabled: true,
    activeSnapTime: null,
    clipboard: null,
    requestEditSubtitleId: null,

    history: [],
    redoStack: [],

    rawTranscription: null,
    transcriptionGroups: null,
    transcriptionContainerIds: null,

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
            fadeInDuration: 0.2,
            fadeOutDuration: 0.2,
            initialScale: 1.5,
            bounceStrength: 1.7,
            useElasticEffect: true,
            fontSize: 48,
            textColor: '#FFF50B',
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
            backgroundBorderColor: '#FFF50B',
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
        if (!options?.skipHistory) get().pushHistory();
        set((state) => {
            const newTracks = state.tracks.map(t => {
                if (t.id !== trackId) return t;
                return {
                    ...t,
                    subtitles: t.subtitles.map(s => s.id === subtitleId ? { ...s, ...updates } : s)
                };
            });
            saveTimelineToStorage(newTracks);
            return { tracks: newTracks };
        });
    },

    moveSubtitleToTrack: (subtitleId, sourceTrackId, targetTrackId) => {
        if (sourceTrackId === targetTrackId) return;

        get().pushHistory();
        set((state) => {
            let movedSubtitle: Subtitle | null = null;

            // Remove from source and capture subtitle
            const tracksWithSourcedRemoved = state.tracks.map(t => {
                if (t.id === sourceTrackId) {
                    const subtitle = t.subtitles.find(s => s.id === subtitleId);
                    if (subtitle) movedSubtitle = { ...subtitle };
                    return {
                        ...t,
                        subtitles: t.subtitles.filter(s => s.id !== subtitleId)
                    };
                }
                return t;
            });

            if (!movedSubtitle) return state;

            // Add to target
            const finalTracks = tracksWithSourcedRemoved.map(t => {
                if (t.id === targetTrackId) {
                    return {
                        ...t,
                        subtitles: [...t.subtitles, movedSubtitle!].sort((a, b) => a.startTime - b.startTime)
                    };
                }
                return t;
            });

            saveTimelineToStorage(finalTracks);
            return { tracks: finalTracks, activeTrackId: targetTrackId };
        });
    },

    moveSubtitlesToTrack: (subtitleIds, deltaTrackIndex, options) => {
        if (deltaTrackIndex === 0 || subtitleIds.length === 0) return;

        if (!options?.skipHistory) get().pushHistory();
        set((state) => {
            const currentTracks = state.tracks;
            const subtitleLocations = new Map<string, { trackId: string, subtitle: Subtitle }>();

            // 1. Locate all subtitles to move
            currentTracks.forEach(track => {
                track.subtitles.forEach(s => {
                    if (subtitleIds.includes(s.id)) {
                        subtitleLocations.set(s.id, { trackId: track.id, subtitle: { ...s } });
                    }
                });
            });

            // 2. Identify target tracks and check bounds
            const trackIds = currentTracks.map(t => t.id);
            const updates = new Map<string, string>(); // subtitleId -> newTrackId

            for (const [sId, loc] of Array.from(subtitleLocations.entries())) {
                const currentIdx = trackIds.indexOf(loc.trackId);
                const targetIdx = currentIdx + deltaTrackIndex;

                if (targetIdx < 0 || targetIdx >= trackIds.length) {
                    // If ANY subtitle would go out of bounds, we cancel the track shift for the WHOLE group
                    // or just cap it? Caps are safer for group movement.
                    return state;
                }
                updates.set(sId, trackIds[targetIdx]);
            }

            // 3. Perform the move
            const newTracks = currentTracks.map(track => {
                // Remove subtitles that are moving OUT of this track
                let subtitles = track.subtitles.filter(s => !updates.has(s.id) || updates.get(s.id) === track.id);

                // Add subtitles that are moving IN to this track
                const movingIn = Array.from(updates.entries())
                    .filter(([, tId]) => tId === track.id)
                    .map(([sId]) => subtitleLocations.get(sId)!.subtitle);

                if (movingIn.length > 0) {
                    subtitles = [...subtitles, ...movingIn].sort((a, b) => a.startTime - b.startTime);
                }

                return { ...track, subtitles };
            });

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
            return {
                tracks: newTracks,
                selectedSubtitleIds: state.selectedSubtitleIds.filter(id => id !== subtitleId)
            };
        });
    },

    setTracks: (tracks) => set((state) => {
        // Clearing history when setting tracks explicitly (e.g. loading project)
        const isValidActive = tracks.some(t => t.id === state.activeTrackId);

        // Trigger auto-save
        saveTimelineToStorage(tracks);

        return {
            tracks,
            activeTrackId: isValidActive ? state.activeTrackId : (tracks.length > 0 ? tracks[0].id : null),
            selectedSubtitleIds: [],
            lastSelectedId: null,
            history: [],
            redoStack: []
        };
    }),

    setActiveTrackId: (id) => set((state) => ({
        activeTrackId: state.tracks.some(t => t.id === id) ? id : (state.tracks.length > 0 ? state.tracks[0].id : null)
    })),

    toggleSubtitleSelection: (id, isMulti, isRange) => set((state) => {
        let newSelection: string[] = [];

        if (isRange && state.lastSelectedId) {
            // Range selection
            const allSubs = state.tracks.flatMap(t => t.subtitles).sort((a, b) => a.startTime - b.startTime);
            const idx1 = allSubs.findIndex(s => s.id === state.lastSelectedId);
            const idx2 = allSubs.findIndex(s => s.id === id);

            if (idx1 !== -1 && idx2 !== -1) {
                const start = Math.min(idx1, idx2);
                const end = Math.max(idx1, idx2);
                const range = allSubs.slice(start, end + 1).map(s => s.id);

                if (isMulti) {
                    newSelection = Array.from(new Set([...state.selectedSubtitleIds, ...range]));
                } else {
                    newSelection = range;
                }
            } else {
                newSelection = [id];
            }
        } else if (isMulti) {
            // Toggle selection
            if (state.selectedSubtitleIds.includes(id)) {
                newSelection = state.selectedSubtitleIds.filter(sid => sid !== id);
            } else {
                newSelection = [...state.selectedSubtitleIds, id];
            }
        } else {
            // Single selection
            newSelection = [id];
        }

        // Find track of the last selected subtitle to make it active
        let newActiveTrackId = state.activeTrackId;
        const trackWithSubtitle = state.tracks.find(t => t.subtitles.some(s => s.id === id));
        if (trackWithSubtitle) {
            newActiveTrackId = trackWithSubtitle.id;
        }

        return {
            selectedSubtitleIds: newSelection,
            lastSelectedId: id,
            activeTrackId: newActiveTrackId
        };
    }),

    clearSelection: () => set({ selectedSubtitleIds: [], lastSelectedId: null }),

    setSnapEnabled: (enabled) => set({ snapEnabled: enabled }),

    setActiveSnapTime: (time) => set({ activeSnapTime: time }),

    copySelection: () => set((state) => {
        if (state.selectedSubtitleIds.length === 0) return state;

        const clipboard: { subtitle: Subtitle, relativeTrackIndex: number }[] = [];
        const baseTrackIndex = state.tracks.findIndex(t => t.id === state.activeTrackId);
        const refTrackIndex = baseTrackIndex !== -1 ? baseTrackIndex : 0;

        state.tracks.forEach((track, tIdx) => {
            track.subtitles.forEach(sub => {
                if (state.selectedSubtitleIds.includes(sub.id)) {
                    clipboard.push({
                        subtitle: { ...sub },
                        relativeTrackIndex: tIdx - refTrackIndex
                    });
                }
            });
        });

        return { clipboard };
    }),

    pasteSelection: (targetStartTime) => {
        const { clipboard, tracks, activeTrackId, pushHistory, toggleSubtitleSelection, clearSelection } = get();
        if (!clipboard || clipboard.length === 0) return;

        pushHistory();

        const baseTrackIndex = tracks.findIndex(t => t.id === activeTrackId);
        const refTrackIndex = baseTrackIndex !== -1 ? baseTrackIndex : 0;

        // Find reference start time (earliest among clipboard items)
        const earliestTime = Math.min(...clipboard.map(item => item.subtitle.startTime));

        const newSelectionIds: string[] = [];
        const newTracks = tracks.map((track, tIdx) => {
            const itemsForThisTrack = clipboard.filter(item => {
                const targetTrackIdx = refTrackIndex + item.relativeTrackIndex;
                return targetTrackIdx === tIdx;
            });

            if (itemsForThisTrack.length === 0) return track;

            const pastedSubs = itemsForThisTrack.map(item => {
                const id = crypto.randomUUID();
                newSelectionIds.push(id);
                const offset = item.subtitle.startTime - earliestTime;
                const duration = item.subtitle.endTime - item.subtitle.startTime;

                return {
                    ...item.subtitle,
                    id,
                    startTime: targetStartTime + offset,
                    endTime: targetStartTime + offset + duration
                };
            });

            return {
                ...track,
                subtitles: [...track.subtitles, ...pastedSubs].sort((a, b) => a.startTime - b.startTime)
            };
        });

        set({ tracks: newTracks });
        saveTimelineToStorage(newTracks);

        // Select the newly pasted subtitles
        if (newSelectionIds.length > 0) {
            clearSelection();
            newSelectionIds.forEach((id, idx) => {
                toggleSubtitleSelection(id, idx > 0);
            });
        }
    },

    trimSubtitleAtTime: (time, side) => {
        const { tracks, activeTrackId, updateSubtitleInTrack, removeSubtitleFromTrack } = get();
        const fps = useVideoStore.getState().fps || 30;
        const frameDuration = 1 / fps;

        // 1. Find the target track and subtitle
        let targetTrackId: string | null = null;
        let targetSubtitle: Subtitle | null = null;
        let mode: 'trim' | 'extend' = 'trim';

        const findOnTrack = (track: SubtitleTrack) => {
            const EPSILON = 0.005;
            return track.subtitles.find(s => time >= s.startTime - EPSILON && time < s.endTime - EPSILON);
        };

        const activeTrack = tracks.find(t => t.id === activeTrackId);

        // Try to find subtitle under playhead on active track or fallback
        if (activeTrack) {
            targetSubtitle = findOnTrack(activeTrack) || null;
            if (targetSubtitle) targetTrackId = activeTrack.id;
        }
        if (!targetSubtitle) {
            for (const track of tracks) {
                targetSubtitle = findOnTrack(track) || null;
                if (targetSubtitle) {
                    targetTrackId = track.id;
                    break;
                }
            }
        }

        // 2. Decide if we trim the current sub or extend a neighbor
        if (targetSubtitle && targetTrackId) {
            if (side === 'start') {
                // If we are EXACTLY at the start of the sub (or within epsilon), we extend previous sub instead of trimming
                if (time <= targetSubtitle.startTime + 0.005) {
                    mode = 'extend';
                }
            } else {
                // If we are EXACTLY at the end of the sub (or within epsilon), we extend next sub instead of trimming
                if (time >= targetSubtitle.endTime - 0.005) {
                    mode = 'extend';
                }
            }
        } else {
            // If no sub under playhead, we are in a gap, so we extend
            mode = 'extend';
            targetTrackId = activeTrackId || (tracks.length > 0 ? tracks[0].id : null);
        }

        if (!targetTrackId) return;
        const track = tracks.find(t => t.id === targetTrackId);
        if (!track) return;

        if (mode === 'trim' && targetSubtitle) {
            const newStartTime = side === 'start' ? time : targetSubtitle.startTime;
            const newEndTime = side === 'end' ? time : targetSubtitle.endTime;
            const newDuration = newEndTime - newStartTime;

            if (newDuration < frameDuration - 0.001) {
                removeSubtitleFromTrack(targetTrackId, targetSubtitle.id);
            } else {
                updateSubtitleInTrack(targetTrackId, targetSubtitle.id, side === 'start' ? { startTime: time } : { endTime: time });
            }
        } else {
            // Extend Neighbor
            if (side === 'start') {
                // Extension (Q): Find sub that ends BEFORE time
                const prevSub = [...track.subtitles]
                    .filter(s => s.endTime <= time + 0.005)
                    .sort((a, b) => b.endTime - a.endTime)[0];

                if (prevSub) {
                    // If it's already touching the playhead, delete it
                    if (prevSub.endTime >= time - 0.005) {
                        removeSubtitleFromTrack(targetTrackId, prevSub.id);
                    } else {
                        updateSubtitleInTrack(targetTrackId, prevSub.id, { endTime: time });
                    }
                }
            } else {
                // Extension (W): Find sub that starts AFTER time
                const nextSub = [...track.subtitles]
                    .filter(s => s.startTime >= time - 0.005)
                    .sort((a, b) => a.startTime - b.startTime)[0];

                if (nextSub) {
                    // If it's already touching the playhead, delete it
                    if (nextSub.startTime <= time + 0.005) {
                        removeSubtitleFromTrack(targetTrackId, nextSub.id);
                    } else {
                        updateSubtitleInTrack(targetTrackId, nextSub.id, { startTime: time });
                    }
                }
            }
        }
    },

    selectSubtitleAtTime: (time) => {
        const { tracks, activeTrackId, toggleSubtitleSelection } = get();

        let targetSubtitle: Subtitle | null = null;

        const findOnTrack = (track: SubtitleTrack) => {
            const EPSILON = 0.005; // 5ms buffer for floating point/snapping
            return track.subtitles.find(s => time >= s.startTime - EPSILON && time < s.endTime - EPSILON);
        };

        const activeTrack = tracks.find(t => t.id === activeTrackId);
        if (activeTrack) {
            targetSubtitle = findOnTrack(activeTrack) || null;
        }

        if (!targetSubtitle) {
            for (const track of tracks) {
                targetSubtitle = findOnTrack(track) || null;
                if (targetSubtitle) break;
            }
        }

        if (targetSubtitle) {
            toggleSubtitleSelection(targetSubtitle.id);
            return targetSubtitle.id;
        }
        return null;
    },

    requestEditSubtitleAtTime: (time) => {
        const { tracks, activeTrackId, selectSubtitleAtTime, addSubtitleToTrack, toggleSubtitleSelection } = get();
        const subtitleId = selectSubtitleAtTime(time);

        if (subtitleId) {
            set({ requestEditSubtitleId: subtitleId });
            return;
        }

        // If no subtitle found, create a new one ("Add on Enter" feature)
        // 1. Determine target track (active or first available)
        const targetTrackId = activeTrackId || (tracks.length > 0 ? tracks[0].id : null);
        if (!targetTrackId) return;

        const targetTrack = tracks.find(t => t.id === targetTrackId);
        if (!targetTrack) return;

        // 2. Find the next subtitle on this track to avoid overlap
        // We use a small EPSILON to avoid overlaps caused by precision issues
        const EPSILON = 0.001;
        const nextSub = [...targetTrack.subtitles]
            .sort((a, b) => a.startTime - b.startTime)
            .find(s => s.startTime > time + EPSILON);

        // 3. Calculate duration (default 2s, capped by next sub or video duration)
        const videoDuration = useVideoStore.getState().duration;
        let endTime = time + 2;

        if (nextSub && endTime > nextSub.startTime) {
            endTime = nextSub.startTime;
        } else if (endTime > videoDuration) {
            endTime = videoDuration;
        }

        // 4. Ensure we have at least one frame of space
        const fps = useVideoStore.getState().fps || 30;
        if (endTime - time < 1 / fps) return;

        // 5. Create and focus
        const newId = addSubtitleToTrack(targetTrackId, {
            startTime: time,
            endTime: endTime,
            text: ''
        });

        // Select it (so it highlights on timeline) and request edit (so SubtitleList focuses it)
        toggleSubtitleSelection(newId, false, false);
        set({ requestEditSubtitleId: newId });
    },

    clearEditRequest: () => set({ requestEditSubtitleId: null }),

    setTranscriptionState: (groups, containerIds, raw) => set((state) => {
        const nextGroups = groups;
        const nextIds = containerIds;
        const nextRaw = raw !== undefined ? raw : state.rawTranscription;

        // Trigger auto-save for transcription state
        saveTimelineToStorage(state.tracks);

        return {
            transcriptionGroups: nextGroups,
            transcriptionContainerIds: nextIds,
            rawTranscription: nextRaw
        };
    }),

    generateDefaultGrouperState: (words, wordsPerLine = 3) => {
        const groups: { [key: string]: Subtitle[] } = {};
        const containerIds: string[] = [];
        const MAX_CHARS = 20;

        const sorted = [...words].sort((a, b) => a.startTime - b.startTime);
        const timestamp = Date.now();

        let currentChunk: Subtitle[] = [];
        let currentChars = 0;
        let groupCount = 0;

        for (const word of sorted) {
            const wordLen = word.text.length;
            const projectedChars = currentChars + (currentChunk.length > 0 ? 1 : 0) + wordLen;

            if (currentChunk.length >= wordsPerLine || (currentChunk.length > 0 && projectedChars > MAX_CHARS)) {
                const firstWordId = currentChunk[0].id.toString().slice(0, 8);
                const groupId = `group-${firstWordId}-${groupCount}-${timestamp}`;
                groups[groupId] = currentChunk;
                containerIds.push(groupId);

                currentChunk = [];
                currentChars = 0;
                groupCount++;
            }

            currentChunk.push(word);
            currentChars += (currentChunk.length === 1 ? 0 : 1) + wordLen;
        }

        if (currentChunk.length > 0) {
            const firstWordId = currentChunk[0].id.toString().slice(0, 8);
            const groupId = `group-${firstWordId}-${groupCount}-${timestamp}`;
            groups[groupId] = currentChunk;
            containerIds.push(groupId);
        }

        return { groups, containerIds };
    },

    generateTimelineSubtitles: (words, wordsPerLine = 3) => {
        const subtitles: Subtitle[] = [];
        const sorted = [...words].sort((a, b) => a.startTime - b.startTime);
        const MAX_CHARS = 20;

        let currentChunk: Subtitle[] = [];
        let currentChars = 0;

        for (const word of sorted) {
            const wordLen = word.text.length;
            const projectedChars = currentChars + (currentChunk.length > 0 ? 1 : 0) + wordLen;

            if (currentChunk.length >= wordsPerLine || (currentChunk.length > 0 && projectedChars > MAX_CHARS)) {
                subtitles.push({
                    id: currentChunk[0].id,
                    startTime: currentChunk[0].startTime,
                    endTime: currentChunk[currentChunk.length - 1].endTime,
                    text: currentChunk.map(w => w.text).join(' ')
                });
                currentChunk = [];
                currentChars = 0;
            }

            currentChunk.push(word);
            currentChars += (currentChunk.length === 1 ? 0 : 1) + wordLen;
        }

        if (currentChunk.length > 0) {
            subtitles.push({
                id: currentChunk[0].id,
                startTime: currentChunk[0].startTime,
                endTime: currentChunk[currentChunk.length - 1].endTime,
                text: currentChunk.map(w => w.text).join(' ')
            });
        }

        return subtitles;
    }
}));
