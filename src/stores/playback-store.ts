import { create } from 'zustand';

interface PlaybackState {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    contentDuration: number;
    volume: number;
    muted: boolean;
    previousVolume: number;
    speed: number;
    fps: number;
    previewTime: number | null;
}

interface PlaybackActions {
    play: () => void;
    pause: () => void;
    toggle: () => void;
    seek: (time: number) => void;
    setVolume: (volume: number) => void;
    setSpeed: (speed: number) => void;
    setDuration: (duration: number) => void;
    setContentDuration: (duration: number) => void;
    setCurrentTime: (time: number) => void;
    setFps: (fps: number) => void;
    setPreviewTime: (time: number | null) => void;
    mute: () => void;
    unmute: () => void;
    toggleMute: () => void;
    reset: () => void;
}

type PlaybackStore = PlaybackState & PlaybackActions;

let playbackTimer: number | null = null;

const startTimer = (store: () => PlaybackStore) => {
    // Only one loop allowed
    if (playbackTimer) return;

    let lastUpdate = performance.now();

    const updateTime = () => {
        const state = store();
        if (!state.isPlaying) {
            playbackTimer = null;
            return;
        }

        const now = performance.now();
        const delta = (now - lastUpdate) / 1000;
        lastUpdate = now;

        if (delta > 0 && delta < 0.2) {
            const newTime = state.currentTime + delta * state.speed;

            if (newTime >= state.contentDuration - 0.001) {
                state.pause();
                state.seek(state.contentDuration);
            } else {
                // Use a non-quantizing internal update to prevent the "stuck" behavior
                // but keep UI reactive
                usePlaybackStore.setState({ currentTime: newTime });
                window.dispatchEvent(
                    new CustomEvent('playback-update', { detail: { time: newTime } })
                );
            }
        }

        playbackTimer = requestAnimationFrame(updateTime);
    };

    playbackTimer = requestAnimationFrame(updateTime);
};

const stopTimer = () => {
    if (playbackTimer) {
        cancelAnimationFrame(playbackTimer);
        playbackTimer = null;
    }
};

export const usePlaybackStore = create<PlaybackStore>((set, get) => ({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    previousVolume: 1,
    speed: 1.0,
    fps: 30,
    contentDuration: 0,
    previewTime: null,

    play: () => {
        const state = get();
        // If at the end, restart from beginning
        if (state.duration > 0 && state.currentTime >= state.duration - 0.001) {
            get().seek(0);
        }
        set({ isPlaying: true });
        startTimer(get);
    },

    pause: () => {
        set({ isPlaying: false });
        stopTimer();
    },

    toggle: () => {
        const { isPlaying } = get();
        if (isPlaying) {
            get().pause();
        } else {
            get().play();
        }
    },

    seek: (time: number) => {
        const { duration, fps } = get();
        const frameDuration = fps > 0 ? 1 / fps : 1 / 30;
        const clampedTime = Math.max(0, Math.min(duration, time));
        // Quantize to nearest frame
        const quantizedTime = Math.round(clampedTime / frameDuration) * frameDuration;

        set({ currentTime: quantizedTime });
        window.dispatchEvent(
            new CustomEvent('playback-seek', { detail: { time: quantizedTime } })
        );
    },

    setVolume: (volume: number) =>
        set((state) => ({
            volume: Math.max(0, Math.min(1, volume)),
            muted: volume === 0,
            previousVolume: volume > 0 ? volume : state.previousVolume,
        })),

    setSpeed: (speed: number) => {
        const newSpeed = Math.max(0.1, Math.min(2.0, speed));
        set({ speed: newSpeed });
        window.dispatchEvent(
            new CustomEvent('playback-speed', { detail: { speed: newSpeed } })
        );
    },

    setDuration: (duration: number) => set({ duration }),
    setContentDuration: (contentDuration: number) => {
        const { fps } = get();
        const frameDuration = fps > 0 ? 1 / fps : 1 / 30;
        const alignedDuration = Math.round(contentDuration / frameDuration) * frameDuration;
        set({ contentDuration: alignedDuration });
    },
    setCurrentTime: (time: number) => {
        const { fps } = get();
        const frameDuration = fps > 0 ? 1 / fps : 1 / 30;
        const quantizedTime = Math.round(time / frameDuration) * frameDuration;
        set({ currentTime: quantizedTime });
    },
    setFps: (fps: number) => set({ fps: Math.max(1, fps) }),
    setPreviewTime: (time: number | null) => set({ previewTime: time }),

    mute: () => {
        const { volume, previousVolume } = get();
        set({
            muted: true,
            previousVolume: volume > 0 ? volume : previousVolume,
            volume: 0,
        });
    },

    unmute: () => {
        const { previousVolume } = get();
        set({ muted: false, volume: previousVolume ?? 1 });
    },

    toggleMute: () => {
        const { muted } = get();
        if (muted) {
            get().unmute();
        } else {
            get().mute();
        }
    },

    reset: () => {
        set({
            isPlaying: false,
            currentTime: 0,
            duration: 0,
            speed: 1.0,
        });
        stopTimer();
    },
}));
