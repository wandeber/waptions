import { throwIfAborted } from '../../src/lib/media-byte-source/types';

interface Waiter {
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
    readonly signal?: AbortSignal;
    abortListener?: () => void;
}

export interface ConcurrencySnapshot {
    readonly active: number;
    readonly peakActive: number;
    readonly queued: number;
    readonly cancellations: number;
}

export class BoundedConcurrency {
    private active = 0;
    private peakActive = 0;
    private cancellations = 0;
    private readonly queue: Waiter[] = [];

    constructor(readonly maximum: number) {
        if (!Number.isSafeInteger(maximum) || maximum <= 0) {
            throw new RangeError('Concurrency maximum must be a positive safe integer.');
        }
    }

    async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        await this.acquire(signal);
        try {
            throwIfAborted(signal);
            return await operation();
        } finally {
            this.release();
        }
    }

    snapshot(): ConcurrencySnapshot {
        return Object.freeze({
            active: this.active,
            peakActive: this.peakActive,
            queued: this.queue.length,
            cancellations: this.cancellations,
        });
    }

    private async acquire(signal?: AbortSignal): Promise<void> {
        throwIfAborted(signal);
        if (this.active < this.maximum && this.queue.length === 0) {
            this.active++;
            this.peakActive = Math.max(this.peakActive, this.active);
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const waiter: Waiter = { resolve, reject, signal };
            this.queue.push(waiter);
            if (signal) {
                waiter.abortListener = () => {
                    const index = this.queue.indexOf(waiter);
                    if (index < 0) return;
                    this.queue.splice(index, 1);
                    this.cancellations++;
                    reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
                };
                signal.addEventListener('abort', waiter.abortListener, { once: true });
                // Close the small subscribe-after-check race without leaving an aborted waiter queued.
                if (signal.aborted) waiter.abortListener();
            }
        });
    }

    private release(): void {
        this.active--;
        while (this.queue.length > 0) {
            const waiter = this.queue.shift();
            if (!waiter) break;
            if (waiter.signal && waiter.abortListener) {
                waiter.signal.removeEventListener('abort', waiter.abortListener);
            }
            if (waiter.signal?.aborted) {
                this.cancellations++;
                waiter.reject(
                    waiter.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
                );
                continue;
            }
            this.active++;
            this.peakActive = Math.max(this.peakActive, this.active);
            waiter.resolve();
            break;
        }
    }
}
