import { create } from 'zustand';

interface VideoState {
    videoFile: File | null;
    videoUrl: string | null;
    width: number;
    height: number;
    fps: number;
    duration: number;
    bitrate: number | null;
    isLoading: boolean;
}

interface VideoActions {
    loadVideo: (file: File, metadata: {
        width: number;
        height: number;
        fps: number;
        duration: number;
        bitrate?: number;
    }) => void;
    clearVideo: () => void;
    setLoading: (loading: boolean) => void;
}

type VideoStore = VideoState & VideoActions;

export const useVideoStore = create<VideoStore>((set, get) => ({
    videoFile: null,
    videoUrl: null,
    width: 0,
    height: 0,
    fps: 30,
    duration: 0,
    bitrate: null,
    isLoading: false,

    loadVideo: (file, metadata) => {
        // Revoke previous URL if exists
        const { videoUrl } = get();
        if (videoUrl) {
            URL.revokeObjectURL(videoUrl);
        }

        const newUrl = URL.createObjectURL(file);
        set({
            videoFile: file,
            videoUrl: newUrl,
            width: metadata.width,
            height: metadata.height,
            fps: metadata.fps,
            duration: metadata.duration,
            bitrate: metadata.bitrate ?? null,
            isLoading: false,
        });
    },

    clearVideo: () => {
        const { videoUrl } = get();
        if (videoUrl) {
            URL.revokeObjectURL(videoUrl);
        }
        set({
            videoFile: null,
            videoUrl: null,
            width: 0,
            height: 0,
            fps: 30,
            duration: 0,
            bitrate: null,
            isLoading: false,
        });
    },

    setLoading: (loading: boolean) => set({ isLoading: loading }),
}));
