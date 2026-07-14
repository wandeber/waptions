import type { VideoFrameSessionRequestScope } from './video-runtime-types';

interface ScheduledTask<T> {
    scope: VideoFrameSessionRequestScope;
    sequence: number;
    run: () => Promise<T>;
    resolve: (value: T | null) => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    abortHandler?: () => void;
    cancelled: boolean;
    settled: boolean;
}

const taskPriority = (scope: VideoFrameSessionRequestScope): number => (
    scope === 'warmup' ? 1 : 0
);

/**
 * Serializes all decoder access for one source session. User-visible and export requests are
 * ordered ahead of queued speculative warmup, and superseded warmup resolves to null rather than
 * surfacing cancellation as an application error.
 */
export class VideoFrameScheduler {
    private queue: ScheduledTask<unknown>[] = [];
    private readonly idleWaiters = new Set<() => void>();
    private sequence = 0;
    private running = false;
    private disposed = false;
    private currentTask: ScheduledTask<unknown> | null = null;

    get isIdle(): boolean {
        return !this.running && this.currentTask === null && this.queue.length === 0;
    }

    /**
     * Waits for the underlying task, not merely its cancelled subscriber, to finish. Decoder-session
     * eviction uses this physical-idle boundary before releasing codec-owned resources.
     */
    whenIdle(): Promise<void> {
        if (this.isIdle) return Promise.resolve();
        return new Promise((resolve) => {
            this.idleWaiters.add(resolve);
        });
    }

    schedule<T>(
        scope: VideoFrameSessionRequestScope,
        run: () => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T | null> {
        if (this.disposed || signal?.aborted) return Promise.resolve(null);

        if (scope !== 'warmup') {
            const retained: ScheduledTask<unknown>[] = [];
            for (const task of this.queue) {
                if (task.scope === 'warmup') this.cancelTask(task);
                else retained.push(task);
            }
            this.queue = retained;
        }

        return new Promise<T | null>((resolve, reject) => {
            const task = {
                scope,
                sequence: this.sequence++,
                run,
                resolve,
                reject,
                signal,
                cancelled: false,
                settled: false,
            } as ScheduledTask<unknown>;
            task.abortHandler = () => this.cancelTask(task);
            signal?.addEventListener('abort', task.abortHandler, { once: true });
            this.queue.push(task);
            this.queue.sort((left, right) => (
                taskPriority(left.scope) - taskPriority(right.scope)
                || left.sequence - right.sequence
            ));
            void this.drain();
        });
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.currentTask) this.cancelTask(this.currentTask);
        for (const task of this.queue) this.cancelTask(task);
        this.queue = [];
        this.resolveIdleWaiters();
    }

    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            while (!this.disposed && this.queue.length > 0) {
                const task = this.queue.shift();
                if (!task) continue;
                if (task.cancelled) {
                    this.cleanupTask(task);
                    continue;
                }
                this.currentTask = task;
                try {
                    const result = await task.run();
                    if (!task.cancelled) this.resolveTask(task, result);
                } catch (error) {
                    if (!task.cancelled && !task.settled) {
                        task.settled = true;
                        task.reject(error);
                    }
                } finally {
                    this.cleanupTask(task);
                    this.currentTask = null;
                }
            }
        } finally {
            this.running = false;
            this.resolveIdleWaiters();
        }
    }

    private cancelTask(task: ScheduledTask<unknown>): void {
        if (task.cancelled) return;
        task.cancelled = true;
        this.resolveTask(task, null);
        if (this.currentTask !== task) {
            this.queue = this.queue.filter((candidate) => candidate !== task);
            this.cleanupTask(task);
        }
    }

    private resolveTask(task: ScheduledTask<unknown>, value: unknown): void {
        if (task.settled) return;
        task.settled = true;
        task.resolve(value);
    }

    private cleanupTask(task: ScheduledTask<unknown>): void {
        if (task.abortHandler) task.signal?.removeEventListener('abort', task.abortHandler);
    }

    private resolveIdleWaiters(): void {
        if (!this.isIdle) return;
        const waiters = Array.from(this.idleWaiters);
        this.idleWaiters.clear();
        for (const resolve of waiters) resolve();
    }
}
