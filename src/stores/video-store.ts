import { create } from 'zustand';
import { videoCache } from '@/lib/video-cache';
import type { VideoSourceAsset, VideoSourceHandle } from '@/types/video';

interface VideoState {
    sourceHandles: Record<string, VideoSourceHandle>;
    /** Only URLs created by this store may be revoked by this store. */
    ownedObjectUrls: Record<string, true>;
    isLoading: boolean;
}

interface VideoActions {
    setSourceHandle: (sourceId: string, objectUrl: string, ownsObjectUrl?: boolean) => void;
    removeSourceHandle: (sourceId: string) => void;
    syncSourceCatalog: (sources: readonly VideoSourceAsset[]) => void;
    clearSourceHandles: () => void;
    getSourceObjectUrl: (sourceId: string) => string | null;
    setLoading: (loading: boolean) => void;
}

type VideoStore = VideoState & VideoActions;

export const useVideoStore = create<VideoStore>((set, get) => ({
    sourceHandles: {},
    ownedObjectUrls: {},
    isLoading: false,

    setSourceHandle: (sourceId, objectUrl, ownsObjectUrl = false) => set((state) => {
        const previous = state.sourceHandles[sourceId];
        const ownedObjectUrls = { ...(state.ownedObjectUrls ?? {}) };
        if (previous?.objectUrl && previous.objectUrl !== objectUrl && ownedObjectUrls[sourceId]) {
            URL.revokeObjectURL(previous.objectUrl);
        }
        if (ownsObjectUrl) ownedObjectUrls[sourceId] = true;
        else delete ownedObjectUrls[sourceId];
        return {
            sourceHandles: {
                ...state.sourceHandles,
                [sourceId]: { sourceId, objectUrl },
            },
            ownedObjectUrls,
        };
    }),

    removeSourceHandle: (sourceId) => set((state) => {
        const handle = state.sourceHandles[sourceId];
        if (!handle) return state;
        const ownedObjectUrls = { ...(state.ownedObjectUrls ?? {}) };
        if (ownedObjectUrls[sourceId]) URL.revokeObjectURL(handle.objectUrl);
        videoCache.clearVideo(`preview:${sourceId}`);
        const sourceHandles = { ...state.sourceHandles };
        delete sourceHandles[sourceId];
        delete ownedObjectUrls[sourceId];
        return { sourceHandles, ownedObjectUrls };
    }),

    syncSourceCatalog: (sources) => set((state) => {
        const retainedIds = new Set(sources.map((source) => source.id));
        const sourceHandles = { ...state.sourceHandles };
        const ownedObjectUrls = { ...(state.ownedObjectUrls ?? {}) };

        Object.entries(sourceHandles).forEach(([sourceId, handle]) => {
            if (!retainedIds.has(sourceId)) {
                if (ownedObjectUrls[sourceId]) URL.revokeObjectURL(handle.objectUrl);
                videoCache.clearVideo(`preview:${sourceId}`);
                delete sourceHandles[sourceId];
                delete ownedObjectUrls[sourceId];
            }
        });

        sources.forEach((source) => {
            if (sourceHandles[source.id]) return;
            try {
                // Tests and server-side module evaluation may not provide browser object-URL
                // support. In that environment the canonical File remains available and the
                // runtime handle can be created later when a browser consumer attaches.
                if (typeof URL.createObjectURL === 'function') {
                    sourceHandles[source.id] = {
                        sourceId: source.id,
                        objectUrl: URL.createObjectURL(source.file),
                    };
                    ownedObjectUrls[source.id] = true;
                }
            } catch {
                // A non-Blob test double cannot produce an object URL; catalog synchronization
                // still succeeds without pretending that a runtime handle exists.
            }
        });

        return { sourceHandles, ownedObjectUrls };
    }),

    clearSourceHandles: () => set((state) => {
        Object.values(state.sourceHandles).forEach((handle) => {
            if (state.ownedObjectUrls?.[handle.sourceId]) URL.revokeObjectURL(handle.objectUrl);
            videoCache.clearVideo(`preview:${handle.sourceId}`);
        });
        return { sourceHandles: {}, ownedObjectUrls: {} };
    }),

    getSourceObjectUrl: (sourceId) => get().sourceHandles[sourceId]?.objectUrl ?? null,

    setLoading: (loading: boolean) => set({ isLoading: loading }),
}));
