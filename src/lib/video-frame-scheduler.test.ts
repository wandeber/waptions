import { describe, expect, it, vi } from 'vitest';
import { VideoFrameScheduler } from './video-frame-scheduler';

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
    return { promise, resolve };
};

describe('VideoFrameScheduler', () => {
    it('runs at most one decoder task at a time', async () => {
        const scheduler = new VideoFrameScheduler();
        const gate = deferred<void>();
        let inFlight = 0;
        let maximumInFlight = 0;
        const task = vi.fn(async () => {
            inFlight += 1;
            maximumInFlight = Math.max(maximumInFlight, inFlight);
            await gate.promise;
            inFlight -= 1;
            return 'frame';
        });

        const first = scheduler.schedule('preview', task);
        const second = scheduler.schedule('preview', task);
        await Promise.resolve();
        expect(task).toHaveBeenCalledTimes(1);
        gate.resolve();

        await expect(Promise.all([first, second])).resolves.toEqual(['frame', 'frame']);
        expect(maximumInFlight).toBe(1);
    });

    it('drops queued warmup when a visible request arrives', async () => {
        const scheduler = new VideoFrameScheduler();
        const gate = deferred<void>();
        const order: string[] = [];
        const running = scheduler.schedule('warmup', async () => {
            order.push('running-warmup');
            await gate.promise;
            return 'running';
        });
        const queuedWarmup = scheduler.schedule('warmup', async () => {
            order.push('queued-warmup');
            return 'queued';
        });
        const visible = scheduler.schedule('preview', async () => {
            order.push('visible');
            return 'visible';
        });

        gate.resolve();
        await expect(running).resolves.toBe('running');
        await expect(queuedWarmup).resolves.toBeNull();
        await expect(visible).resolves.toBe('visible');
        expect(order).toEqual(['running-warmup', 'visible']);
    });

    it('cancels an obsolete running subscriber while keeping decoder work bounded', async () => {
        const scheduler = new VideoFrameScheduler();
        const oldDecode = deferred<void>();
        let inFlight = 0;
        let maximumInFlight = 0;
        const oldController = new AbortController();
        const oldWarmup = scheduler.schedule('warmup', async () => {
            inFlight += 1;
            maximumInFlight = Math.max(maximumInFlight, inFlight);
            await oldDecode.promise;
            inFlight -= 1;
            return 'old';
        }, oldController.signal);
        await Promise.resolve();
        oldController.abort();
        await expect(oldWarmup).resolves.toBeNull();

        const nextWarmupTask = vi.fn(async () => {
            inFlight += 1;
            maximumInFlight = Math.max(maximumInFlight, inFlight);
            inFlight -= 1;
            return 'new';
        });
        const nextWarmup = scheduler.schedule('warmup', nextWarmupTask);
        await Promise.resolve();
        expect(nextWarmupTask).not.toHaveBeenCalled();

        oldDecode.resolve();
        await expect(nextWarmup).resolves.toBe('new');
        expect(maximumInFlight).toBe(1);
    });

    it('removes an aborted queued warmup without running it', async () => {
        const scheduler = new VideoFrameScheduler();
        const runningGate = deferred<void>();
        const running = scheduler.schedule('warmup', async () => {
            await runningGate.promise;
            return 'running';
        });
        const controller = new AbortController();
        const queuedTask = vi.fn(async () => 'queued');
        const queued = scheduler.schedule('warmup', queuedTask, controller.signal);

        controller.abort();
        await expect(queued).resolves.toBeNull();
        runningGate.resolve();
        await expect(running).resolves.toBe('running');
        expect(queuedTask).not.toHaveBeenCalled();
    });

    it('reports physical idleness only after cancelled decoder work has unwound', async () => {
        const scheduler = new VideoFrameScheduler();
        const decodeGate = deferred<void>();
        const controller = new AbortController();
        expect(scheduler.isIdle).toBe(true);

        const pending = scheduler.schedule('warmup', async () => {
            await decodeGate.promise;
            return 'frame';
        }, controller.signal);
        await Promise.resolve();
        expect(scheduler.isIdle).toBe(false);

        controller.abort();
        await expect(pending).resolves.toBeNull();
        let reachedIdle = false;
        const idle = scheduler.whenIdle().then(() => { reachedIdle = true; });
        await Promise.resolve();
        expect(reachedIdle).toBe(false);
        expect(scheduler.isIdle).toBe(false);

        decodeGate.resolve();
        await idle;
        expect(reachedIdle).toBe(true);
        expect(scheduler.isIdle).toBe(true);
    });
});
