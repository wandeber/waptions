import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlaybackStore, type PlaybackClockDriver } from './playback-store';

const createDriver = (audible = true): PlaybackClockDriver => ({
    hasAudibleContributors: vi.fn(() => audible),
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    seek: vi.fn(),
    setPlaybackRate: vi.fn(),
    setMasterGain: vi.fn(),
});

describe('playback clock arbitration', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 7));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        usePlaybackStore.getState().pause();
        usePlaybackStore.getState().setClockDriver(null);
        usePlaybackStore.setState({
            isPlaying: false,
            currentTime: 0,
            duration: 12,
            contentDuration: 10,
            volume: 1,
            muted: false,
            previousVolume: 1,
            speed: 1,
            fps: 30,
            previewTime: null,
        });
    });

    afterEach(() => {
        usePlaybackStore.getState().pause();
        usePlaybackStore.getState().setClockDriver(null);
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('starts the audible driver without starting the visual RAF clock', () => {
        const driver = createDriver(true);
        usePlaybackStore.getState().setClockDriver(driver);

        usePlaybackStore.getState().play();

        expect(driver.seek).toHaveBeenLastCalledWith(0);
        expect(driver.play).toHaveBeenCalledOnce();
        expect(requestAnimationFrame).not.toHaveBeenCalled();
    });

    it('uses RAF when the installed graph has no audible contributors', () => {
        const driver = createDriver(false);
        usePlaybackStore.getState().setClockDriver(driver);

        usePlaybackStore.getState().play();

        expect(driver.play).not.toHaveBeenCalled();
        expect(requestAnimationFrame).toHaveBeenCalledOnce();
    });

    it('publishes external sample-clock time only while that driver owns playback', () => {
        const driver = createDriver(true);
        usePlaybackStore.getState().setClockDriver(driver);
        usePlaybackStore.getState().play();

        usePlaybackStore.getState().publishExternalClock(1.02);
        expect(usePlaybackStore.getState().currentTime).toBe(1.0333333333333334);

        usePlaybackStore.getState().pause();
        usePlaybackStore.getState().publishExternalClock(2);
        expect(usePlaybackStore.getState().currentTime).toBe(1.0333333333333334);
    });

    it('forwards transport and bounded mix controls to the driver', () => {
        const driver = createDriver(true);
        usePlaybackStore.getState().setClockDriver(driver);

        usePlaybackStore.getState().seek(3.014);
        usePlaybackStore.getState().setSpeed(4);
        usePlaybackStore.getState().setVolume(-1);
        usePlaybackStore.getState().unmute();

        expect(driver.seek).toHaveBeenLastCalledWith(3);
        expect(driver.setPlaybackRate).toHaveBeenLastCalledWith(2);
        expect(driver.setMasterGain).toHaveBeenNthCalledWith(2, 0);
        expect(driver.setMasterGain).toHaveBeenLastCalledWith(1);
    });

    it('switches to RAF when a playing audio graph becomes silent', () => {
        let audible = true;
        const driver = createDriver();
        vi.mocked(driver.hasAudibleContributors).mockImplementation(() => audible);
        usePlaybackStore.getState().setClockDriver(driver);
        usePlaybackStore.getState().play();

        audible = false;
        usePlaybackStore.getState().refreshClockDriver();

        expect(driver.pause).toHaveBeenCalledOnce();
        expect(requestAnimationFrame).toHaveBeenCalledOnce();
    });

    it('pauses RAF playback when contributors become audible until the next explicit play', () => {
        let audible = false;
        const driver = createDriver();
        vi.mocked(driver.hasAudibleContributors).mockImplementation(() => audible);
        usePlaybackStore.getState().setClockDriver(driver);
        usePlaybackStore.getState().play();
        expect(requestAnimationFrame).toHaveBeenCalledOnce();

        audible = true;
        usePlaybackStore.getState().refreshClockDriver();

        expect(usePlaybackStore.getState().isPlaying).toBe(false);
        expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
        expect(driver.play).not.toHaveBeenCalled();

        usePlaybackStore.getState().play();
        expect(usePlaybackStore.getState().isPlaying).toBe(true);
        expect(driver.play).toHaveBeenCalledOnce();
    });

    it('pauses when an active external driver is replaced instead of starting silent RAF', () => {
        const previousDriver = createDriver(true);
        const replacementDriver = createDriver(true);
        usePlaybackStore.getState().setClockDriver(previousDriver);
        usePlaybackStore.getState().play();

        usePlaybackStore.getState().setClockDriver(replacementDriver);

        expect(previousDriver.pause).toHaveBeenCalledOnce();
        expect(usePlaybackStore.getState().isPlaying).toBe(false);
        expect(replacementDriver.play).not.toHaveBeenCalled();
        expect(requestAnimationFrame).not.toHaveBeenCalled();
    });

    it('pauses RAF when a replacement driver introduces audible contributors', () => {
        const silentDriver = createDriver(false);
        const audibleDriver = createDriver(true);
        usePlaybackStore.getState().setClockDriver(silentDriver);
        usePlaybackStore.getState().play();

        usePlaybackStore.getState().setClockDriver(audibleDriver);

        expect(usePlaybackStore.getState().isPlaying).toBe(false);
        expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
        expect(audibleDriver.play).not.toHaveBeenCalled();
    });

    it('stops transport after external startup failure instead of falling back to RAF', async () => {
        const driver = createDriver(true);
        vi.mocked(driver.play).mockRejectedValue(new Error('worklet startup failed'));
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        usePlaybackStore.getState().setClockDriver(driver);

        usePlaybackStore.getState().play();
        await Promise.resolve();
        await Promise.resolve();

        expect(driver.pause).toHaveBeenCalledOnce();
        expect(usePlaybackStore.getState().isPlaying).toBe(false);
        expect(requestAnimationFrame).not.toHaveBeenCalled();
    });

    it('restarts from the content boundary rather than the editable view tail', () => {
        usePlaybackStore.setState({ currentTime: 10, contentDuration: 10, duration: 12 });
        usePlaybackStore.getState().play();

        expect(usePlaybackStore.getState().currentTime).toBe(0);
    });
});
