import { throwIfAborted as throwIfByteSourceAborted } from '../../src/lib/media-byte-source/types';
import { ManagedMediaError, throwIfAborted as throwIfManagedMediaAborted } from './errors';
import type { MediaDiagnosticsPort } from './ports';

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
            throwIfByteSourceAborted(signal);
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
        throwIfByteSourceAborted(signal);
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

interface QueueEntry {
  readonly operationId: string;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: ManagedMediaError) => void;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
}

export class BoundedConcurrencyGate {
  private active = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(
    private readonly limit: number,
    private readonly diagnosticName: string,
    private readonly diagnostics: MediaDiagnosticsPort,
  ) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new ManagedMediaError('INVALID_REQUEST', 'Concurrency limit must be positive.');
    }
  }

  async acquire(operationId: string, signal?: AbortSignal): Promise<() => void> {
    throwIfManagedMediaAborted(signal);
    if (this.active < this.limit) {
      this.active += 1;
      this.record(operationId);
      return this.createRelease(operationId);
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry: QueueEntry = {
        operationId,
        resolve,
        reject,
        signal,
      };
      if (signal) {
        entry.abortListener = () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) {
            this.queue.splice(index, 1);
            this.record(operationId);
            reject(new ManagedMediaError('ABORTED', 'Queued media operation was cancelled.', {
              retryable: true,
              cause: signal.reason,
            }));
          }
        };
        signal.addEventListener('abort', entry.abortListener, { once: true });
      }
      this.queue.push(entry);
      this.record(operationId);
    });
  }

  snapshot(): { readonly active: number; readonly queued: number; readonly limit: number } {
    return {
      active: this.active,
      queued: this.queue.length,
      limit: this.limit,
    };
  }

  private createRelease(operationId: string): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
      this.record(operationId);
      this.startNext();
    };
  }

  private startNext(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) {
        return;
      }
      if (entry.abortListener && entry.signal) {
        entry.signal.removeEventListener('abort', entry.abortListener);
      }
      if (entry.signal?.aborted) {
        entry.reject(new ManagedMediaError('ABORTED', 'Queued media operation was cancelled.', {
          retryable: true,
          cause: entry.signal.reason,
        }));
        continue;
      }
      this.active += 1;
      this.record(entry.operationId);
      entry.resolve(this.createRelease(entry.operationId));
    }
  }

  private record(operationId: string): void {
    this.diagnostics.record({
      name: this.diagnosticName,
      operationId,
      attributes: {
        active: this.active,
        queued: this.queue.length,
        limit: this.limit,
      },
    });
  }
}
