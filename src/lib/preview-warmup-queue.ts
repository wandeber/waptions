import type {
    PreviewWarmupFrame,
    PreviewWarmupPlanIdentity,
} from './video-runtime-types';

interface PreviewWarmupQueueOptions {
    request(
        frame: PreviewWarmupFrame,
        signal: AbortSignal,
        plan: PreviewWarmupPlanIdentity,
    ): Promise<void>;
    hasFrame(frame: PreviewWarmupFrame): boolean;
    schedule(callback: () => void): void;
    onError?(error: unknown): void;
}

const frameKey = (frame: PreviewWarmupFrame) => `${frame.sourceId}:${frame.sourceFrameIndex}`;
let nextPlanGeneration = 0;

interface PendingWarmupFrame {
    frame: PreviewWarmupFrame;
    plan: PreviewWarmupPlanIdentity;
}

/**
 * One long-lived speculative queue for a stable document/source/resolution generation.
 *
 * Playback ticks merge their newest runway into this queue instead of aborting the current decode.
 * Every enqueue still receives a distinct retention generation, because cancellation lifetime and
 * cache usefulness are separate concerns: a persistent signal must not make an old runway outrank
 * the lookahead for a newer playback tick.
 * Frames that fell behind the playhead are removed before they start, while the single in-flight
 * decode is allowed to finish and populate the cache. Explicit seeks and structural changes call
 * reset(), which aborts the generation and prevents obsolete work from publishing.
 */
export class PreviewWarmupQueue {
    private readonly options: PreviewWarmupQueueOptions;
    private pending: PendingWarmupFrame[] = [];
    private scheduledKeys = new Set<string>();
    private controller = new AbortController();
    private generation = 0;
    private callbackScheduled = false;
    private consumingGeneration: number | null = null;
    private activeEntry: PendingWarmupFrame | null = null;
    private disposed = false;

    constructor(options: PreviewWarmupQueueOptions) {
        this.options = options;
    }

    enqueue(frames: readonly PreviewWarmupFrame[], minimumProjectFrameIndex?: number): void {
        if (this.disposed) return;
        if (minimumProjectFrameIndex !== undefined) {
            const retained: PendingWarmupFrame[] = [];
            this.pending.forEach((entry) => {
                if (entry.frame.projectFrameIndex > minimumProjectFrameIndex) retained.push(entry);
                else this.scheduledKeys.delete(frameKey(entry.frame));
            });
            this.pending = retained;
        }
        const generation = frames.length > 0 ? ++nextPlanGeneration : 0;
        frames.forEach((frame, order) => {
            const key = frameKey(frame);
            if (this.options.hasFrame(frame)) return;
            const existing = this.pending.find((entry) => frameKey(entry.frame) === key);
            if (existing) {
                // Repeated playback ticks share one cancellation signal, but each tick is a new
                // retention plan. Promote still-pending frames to the latest plan so newly appended
                // lookahead cannot displace a closer frame merely because it was queued earlier.
                existing.plan.generation = generation;
                existing.plan.order = order;
                return;
            }
            if (this.activeEntry && frameKey(this.activeEntry.frame) === key) {
                // The decoder stays single-flight, but its mutable plan identity is promoted before
                // publication. VideoCache reads that identity at admission time, so a slow frame
                // required by the newest runway is not retained with stale priority.
                this.activeEntry.plan.generation = generation;
                this.activeEntry.plan.order = order;
                return;
            }
            if (this.scheduledKeys.has(key)) return;
            this.scheduledKeys.add(key);
            this.pending.push({ frame, plan: { generation, order } });
        });
        this.scheduleNext();
    }

    reset(): void {
        if (this.disposed) return;
        this.generation += 1;
        this.controller.abort();
        this.controller = new AbortController();
        this.pending = [];
        this.scheduledKeys.clear();
        this.callbackScheduled = false;
        this.consumingGeneration = null;
        this.activeEntry = null;
    }

    dispose(): void {
        if (this.disposed) return;
        this.reset();
        this.disposed = true;
        this.controller.abort();
    }

    private scheduleNext(): void {
        if (this.disposed
            || this.callbackScheduled
            || this.consumingGeneration !== null
            || this.pending.length === 0) return;
        this.callbackScheduled = true;
        const generation = this.generation;
        this.options.schedule(() => {
            if (this.disposed || generation !== this.generation) return;
            this.callbackScheduled = false;
            void this.consumeNext(generation);
        });
    }

    private async consumeNext(generation: number): Promise<void> {
        const entry = this.pending.shift();
        if (!entry || this.disposed || generation !== this.generation) return;
        this.consumingGeneration = generation;
        this.activeEntry = entry;
        const key = frameKey(entry.frame);
        try {
            if (!this.options.hasFrame(entry.frame)) {
                await this.options.request(entry.frame, this.controller.signal, entry.plan);
            }
        } catch (error) {
            if (!this.controller.signal.aborted) this.options.onError?.(error);
        } finally {
            if (this.disposed || generation !== this.generation) return;
            this.activeEntry = null;
            this.consumingGeneration = null;
            this.scheduledKeys.delete(key);
            this.scheduleNext();
        }
    }
}
