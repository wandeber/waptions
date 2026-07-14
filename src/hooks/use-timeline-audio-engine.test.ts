import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTimelineAudioEngineCallbacks } from './use-timeline-audio-engine';
import { usePlaybackStore, type PlaybackClockDriver } from '@/stores/playback-store';

const createDriver = (): PlaybackClockDriver => ({
    hasAudibleContributors: vi.fn(() => true),
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    seek: vi.fn(),
    setPlaybackRate: vi.fn(),
    setMasterGain: vi.fn(),
});

describe('timeline audio engine callback bridge', () => {
    beforeEach(() => {
        usePlaybackStore.getState().pause();
        usePlaybackStore.getState().setClockDriver(null);
        usePlaybackStore.setState({
            isPlaying: false,
            currentTime: 0,
            duration: 10,
            contentDuration: 10,
        });
    });

    afterEach(() => {
        usePlaybackStore.getState().pause();
        usePlaybackStore.getState().setClockDriver(null);
        vi.restoreAllMocks();
    });

    it('stops external-clock playback after an active asynchronous engine failure', () => {
        const driver = createDriver();
        const error = new Error('refill failed');
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        usePlaybackStore.getState().setClockDriver(driver);
        usePlaybackStore.getState().play();
        expect(usePlaybackStore.getState().isPlaying).toBe(true);

        createTimelineAudioEngineCallbacks(() => true).onError(error);

        expect(console.error).toHaveBeenCalledWith('Timeline audio engine error:', error);
        expect(driver.pause).toHaveBeenCalledOnce();
        expect(usePlaybackStore.getState().isPlaying).toBe(false);
    });

    it('ignores a late engine failure after the project callback becomes inactive', () => {
        const driver = createDriver();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        usePlaybackStore.getState().setClockDriver(driver);
        usePlaybackStore.getState().play();

        createTimelineAudioEngineCallbacks(() => false).onError(new Error('stale failure'));

        expect(consoleError).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });
});
