import { create } from 'zustand';
import { frameIndexToTime, timeToFrameIndex } from '@/lib/frame-utils';

/**
 * Optional sample-accurate clock supplied by the editor audio engine.
 *
 * The store owns clock arbitration so the visual RAF loop and the AudioWorklet can never race to
 * publish playback time. The driver is intentionally kept outside serializable Zustand state.
 */
export interface PlaybackClockDriver {
    hasAudibleContributors: () => boolean;
    play: () => Promise<void> | void;
    pause: () => void;
    seek: (timeSeconds: number) => void;
    setPlaybackRate: (speed: number) => void;
    setMasterGain: (gainLinear: number) => void;
}

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
    setClockDriver: (driver: PlaybackClockDriver | null) => void;
    refreshClockDriver: () => void;
    publishExternalClock: (timeSeconds: number) => void;
    reset: () => void;
}

type PlaybackStore = PlaybackState & PlaybackActions;

let playbackTimer: number | null = null;
let clockDriver: PlaybackClockDriver | null = null;
let externalClockDriving = false;
let clockRequestGeneration = 0;

const dispatchPlaybackEvent = (name: string, detail: Record<string, number>): void => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(name, { detail }));
};

const requestFrame = (callback: FrameRequestCallback): number => {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return globalThis.setTimeout(() => callback(performance.now()), 16) as unknown as number;
};

const cancelFrame = (id: number): void => {
    if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(id);
        return;
    }
    globalThis.clearTimeout(id);
};

const startTimer = (store: () => PlaybackStore) => {
    if (playbackTimer !== null || externalClockDriving) return;

    let lastUpdate = performance.now();
    let internalCurrentTime = store().currentTime;
    let lastPublishedFrameIndex = timeToFrameIndex(internalCurrentTime, store().fps);
    let lastObservedStoreTime = internalCurrentTime;

    const updateTime = () => {
        const state = store();
        if (!state.isPlaying || externalClockDriving) {
            playbackTimer = null;
            return;
        }

        const now = performance.now();
        if (Math.abs(state.currentTime - lastObservedStoreTime) > 0.000001) {
            internalCurrentTime = state.currentTime;
            lastPublishedFrameIndex = timeToFrameIndex(internalCurrentTime, state.fps);
            lastObservedStoreTime = state.currentTime;
            lastUpdate = now;
        }

        const delta = (now - lastUpdate) / 1000;
        lastUpdate = now;

        if (delta > 0 && delta < 0.2) {
            internalCurrentTime += delta * state.speed;

            if (internalCurrentTime >= state.contentDuration - 0.001) {
                state.pause();
                state.seek(state.contentDuration);
            } else {
                const nextFrameIndex = timeToFrameIndex(internalCurrentTime, state.fps);

                // Publish at most once per visual frame. This keeps the timeline reactive while
                // preventing duplicate preview cache lookups inside the same output frame.
                if (nextFrameIndex !== lastPublishedFrameIndex) {
                    lastPublishedFrameIndex = nextFrameIndex;
                    const nextFrameTime = frameIndexToTime(nextFrameIndex, state.fps);
                    lastObservedStoreTime = nextFrameTime;
                    usePlaybackStore.setState({ currentTime: nextFrameTime });
                    dispatchPlaybackEvent('playback-update', { time: nextFrameTime });
                }
            }
        }

        playbackTimer = requestFrame(updateTime);
    };

    playbackTimer = requestFrame(updateTime);
};

const stopTimer = () => {
    if (playbackTimer !== null) {
        cancelFrame(playbackTimer);
        playbackTimer = null;
    }
};

const stopExternalClock = (): void => {
    if (!externalClockDriving) return;
    externalClockDriving = false;
    clockDriver?.pause();
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
        // The extra view tail is editable space, not playable content. Restart against the exact
        // content boundary so audio-only and subtitle tails behave like video content.
        if (state.contentDuration > 0 && state.currentTime >= state.contentDuration - 0.001) {
            state.seek(0);
        }
        set({ isPlaying: true });

        if (clockDriver?.hasAudibleContributors()) {
            const requestGeneration = ++clockRequestGeneration;
            stopTimer();
            externalClockDriving = true;
            // Snapshot application and every editor seek already position the driver. Re-seeking
            // on each play discarded its warm queue and reopened the exact same scheduling work.
            clockDriver.setPlaybackRate(get().speed);
            clockDriver.setMasterGain(get().volume);
            Promise.resolve(clockDriver.play()).catch((error) => {
                // A browser can reject Web Audio startup even when it began in a user gesture.
                // Audible playback must not silently continue on RAF after that failure. Pausing
                // keeps the clocks mutually exclusive and makes the next retry an explicit user
                // gesture, which is required by browser AudioContext policies.
                console.error('Timeline audio playback could not start:', error);
                if (requestGeneration !== clockRequestGeneration
                    || !get().isPlaying || !externalClockDriving) return;
                clockDriver?.pause();
                externalClockDriving = false;
                set({ isPlaying: false });
                stopTimer();
            });
            return;
        }

        clockRequestGeneration += 1;
        externalClockDriving = false;
        startTimer(get);
    },

    pause: () => {
        clockRequestGeneration += 1;
        set({ isPlaying: false });
        stopTimer();
        stopExternalClock();
    },

    toggle: () => {
        if (get().isPlaying) {
            get().pause();
        } else {
            get().play();
        }
    },

    seek: (time: number) => {
        const { duration, fps } = get();
        const frameDuration = fps > 0 ? 1 / fps : 1 / 30;
        const clampedTime = Math.max(0, Math.min(duration, time));
        const quantizedTime = Math.round(clampedTime / frameDuration) * frameDuration;

        set({ currentTime: quantizedTime });
        clockDriver?.seek(quantizedTime);
        dispatchPlaybackEvent('playback-seek', { time: quantizedTime });
    },

    setVolume: (volume: number) => {
        const clampedVolume = Math.max(0, Math.min(1, volume));
        set((state) => ({
            volume: clampedVolume,
            muted: clampedVolume === 0,
            previousVolume: clampedVolume > 0 ? clampedVolume : state.previousVolume,
        }));
        clockDriver?.setMasterGain(clampedVolume);
    },

    setSpeed: (speed: number) => {
        const newSpeed = Math.max(0.1, Math.min(2.0, speed));
        set({ speed: newSpeed });
        clockDriver?.setPlaybackRate(newSpeed);
        dispatchPlaybackEvent('playback-speed', { speed: newSpeed });
    },

    setDuration: (duration: number) => set({ duration: Math.max(0, duration) }),
    setContentDuration: (contentDuration: number) => {
        const { fps } = get();
        const frameDuration = fps > 0 ? 1 / fps : 1 / 30;
        const alignedDuration = Math.round(Math.max(0, contentDuration) / frameDuration) * frameDuration;
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
        clockDriver?.setMasterGain(0);
    },

    unmute: () => {
        const restoredVolume = get().previousVolume ?? 1;
        set({ muted: false, volume: restoredVolume });
        clockDriver?.setMasterGain(restoredVolume);
    },

    toggleMute: () => {
        if (get().muted) {
            get().unmute();
        } else {
            get().mute();
        }
    },

    setClockDriver: (driver) => {
        if (clockDriver === driver) return;
        clockRequestGeneration += 1;
        const wasPlaying = get().isPlaying;
        const wasExternallyDriven = externalClockDriving;
        if (wasExternallyDriven) clockDriver?.pause();
        externalClockDriving = false;
        clockDriver = driver;
        if (driver) {
            // The editor applies its document and current playhead atomically before registering
            // the driver. Seeking here used to discard that freshly primed queue a second time.
            // Explicit user/store seeks still flow through the ordinary seek action below.
            driver.setPlaybackRate(get().speed);
            driver.setMasterGain(get().volume);
        }
        // Driver replacement is normally caused by a project change and is not a user gesture. If
        // audio owned the active transport, or the replacement introduces audible contributors,
        // pause instead of silently falling back to RAF. The next explicit play action can safely
        // create/resume Web Audio inside the gesture call stack.
        const replacementNeedsGesture = wasPlaying
            && (wasExternallyDriven || Boolean(driver?.hasAudibleContributors()));
        if (replacementNeedsGesture) {
            stopTimer();
            set({ isPlaying: false });
        } else if (wasPlaying) {
            startTimer(get);
        }
    },

    refreshClockDriver: () => {
        const audible = Boolean(clockDriver?.hasAudibleContributors());
        if (externalClockDriving) {
            if (audible) return;
            clockRequestGeneration += 1;
            clockDriver?.pause();
            externalClockDriving = false;
            if (get().isPlaying) startTimer(get);
            return;
        }
        if (!get().isPlaying || !audible) return;

        // A graph can become audible while the visual RAF clock is already running (for example,
        // after importing or unmuting a clip). React/store updates are not user gestures, so they
        // must not resume AudioContext. Stop playback and let the next explicit play gesture hand
        // ownership to the sample-accurate driver.
        clockRequestGeneration += 1;
        stopTimer();
        set({ isPlaying: false });
    },

    publishExternalClock: (timeSeconds) => {
        const state = get();
        if (!externalClockDriving || !state.isPlaying || !Number.isFinite(timeSeconds)) return;
        if (timeSeconds >= state.contentDuration - 0.000001) {
            state.pause();
            state.seek(state.contentDuration);
            return;
        }
        const frameIndex = timeToFrameIndex(Math.max(0, timeSeconds), state.fps);
        const nextFrameTime = frameIndexToTime(frameIndex, state.fps);
        if (Math.abs(nextFrameTime - state.currentTime) < 0.000001) return;
        set({ currentTime: nextFrameTime });
        dispatchPlaybackEvent('playback-update', { time: nextFrameTime });
    },

    reset: () => {
        clockRequestGeneration += 1;
        stopTimer();
        stopExternalClock();
        clockDriver?.seek(0);
        set({
            isPlaying: false,
            currentTime: 0,
            duration: 0,
            contentDuration: 0,
            speed: 1.0,
            previewTime: null,
        });
        clockDriver?.setPlaybackRate(1);
    },
}));
