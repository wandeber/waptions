import { throwIfAborted } from './types';

export interface MediaBudgetSnapshot {
    readonly name: string;
    readonly maxBytes: number;
    readonly currentBytes: number;
    readonly peakBytes: number;
    readonly reservedBytes: number;
    readonly leasedBytes: number;
    readonly activeReservations: number;
    readonly activeLeases: number;
    readonly queuedReservations: number;
    readonly peakQueuedReservations: number;
    readonly reservations: number;
    readonly releases: number;
    readonly cancellations: number;
    readonly rejectedOversized: number;
}

export interface MediaBudgetLease {
    readonly bytes: number;
    readonly label: string;
    readonly released: boolean;
    release(): void;
}

export interface MediaBudgetReservation {
    readonly bytes: number;
    readonly label: string;
    readonly released: boolean;
    commit(actualBytes?: number): MediaBudgetLease;
    release(): void;
}

export interface MediaBudgetReserveOptions {
    readonly label?: string;
    readonly signal?: AbortSignal;
}

interface PendingReservation {
    readonly bytes: number;
    readonly label: string;
    readonly signal?: AbortSignal;
    readonly resolve: (reservation: MediaBudgetReservation) => void;
    readonly reject: (error: unknown) => void;
    onAbort?: () => void;
}

export class MediaBudgetExceededError extends Error {
    constructor(
        readonly budgetName: string,
        readonly requestedBytes: number,
        readonly maxBytes: number,
    ) {
        super(`Budget "${budgetName}" cannot reserve ${requestedBytes} bytes; its hard limit is ${maxBytes} bytes.`);
        this.name = 'MediaBudgetExceededError';
    }
}

export class MediaBudgetManager {
    private currentBytes = 0;
    private peakBytes = 0;
    private reservedBytes = 0;
    private leasedBytes = 0;
    private activeReservations = 0;
    private activeLeases = 0;
    private peakQueuedReservations = 0;
    private reservations = 0;
    private releases = 0;
    private cancellations = 0;
    private rejectedOversized = 0;
    private closed = false;
    private readonly queue: PendingReservation[] = [];

    constructor(
        readonly name: string,
        readonly maxBytes: number,
    ) {
        if (!name) throw new TypeError('Budget name must not be empty.');
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
            throw new RangeError('Budget maxBytes must be a positive safe integer.');
        }
    }

    tryReserve(bytes: number, label = 'unnamed'): MediaBudgetReservation | null {
        this.assertReservationSize(bytes);
        if (this.closed || this.queue.length > 0 || this.currentBytes + bytes > this.maxBytes) {
            return null;
        }
        return this.createReservation(bytes, label);
    }

    async reserve(bytes: number, options: MediaBudgetReserveOptions = {}): Promise<MediaBudgetReservation> {
        this.assertReservationSize(bytes);
        throwIfAborted(options.signal);
        if (this.closed) {
            throw new Error(`Budget "${this.name}" is closed.`);
        }

        const immediate = this.tryReserve(bytes, options.label);
        if (immediate) return immediate;

        return new Promise<MediaBudgetReservation>((resolve, reject) => {
            const pending: PendingReservation = {
                bytes,
                label: options.label ?? 'unnamed',
                signal: options.signal,
                resolve,
                reject,
            };
            if (options.signal) {
                pending.onAbort = () => {
                    const index = this.queue.indexOf(pending);
                    if (index === -1) return;
                    this.queue.splice(index, 1);
                    this.cancellations++;
                    reject(options.signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
                    this.drain();
                };
                options.signal.addEventListener('abort', pending.onAbort, { once: true });
            }
            this.queue.push(pending);
            this.peakQueuedReservations = Math.max(this.peakQueuedReservations, this.queue.length);
            this.drain();
        });
    }

    close(reason: unknown = new Error(`Budget "${this.name}" is closed.`)): void {
        if (this.closed) return;
        this.closed = true;
        for (const pending of this.queue.splice(0)) {
            this.removeAbortListener(pending);
            pending.reject(reason);
        }
    }

    snapshot(): MediaBudgetSnapshot {
        return Object.freeze({
            name: this.name,
            maxBytes: this.maxBytes,
            currentBytes: this.currentBytes,
            peakBytes: this.peakBytes,
            reservedBytes: this.reservedBytes,
            leasedBytes: this.leasedBytes,
            activeReservations: this.activeReservations,
            activeLeases: this.activeLeases,
            queuedReservations: this.queue.length,
            peakQueuedReservations: this.peakQueuedReservations,
            reservations: this.reservations,
            releases: this.releases,
            cancellations: this.cancellations,
            rejectedOversized: this.rejectedOversized,
        });
    }

    assertDrained(): void {
        if (
            this.currentBytes !== 0
            || this.activeReservations !== 0
            || this.activeLeases !== 0
            || this.queue.length !== 0
        ) {
            throw new Error(
                `Budget "${this.name}" leaked: ${this.currentBytes} bytes, `
                + `${this.activeReservations} reservations, ${this.activeLeases} leases, `
                + `${this.queue.length} waiters.`,
            );
        }
    }

    private assertReservationSize(bytes: number): void {
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
            throw new RangeError('Reservation bytes must be a non-negative safe integer.');
        }
        if (bytes > this.maxBytes) {
            this.rejectedOversized++;
            throw new MediaBudgetExceededError(this.name, bytes, this.maxBytes);
        }
    }

    private createReservation(bytes: number, label: string): MediaBudgetReservation {
        this.currentBytes += bytes;
        this.reservedBytes += bytes;
        this.peakBytes = Math.max(this.peakBytes, this.currentBytes);
        this.activeReservations++;
        this.reservations++;

        let released = false;
        let committed = false;
        return {
            bytes,
            label,
            get released() {
                return released;
            },
            commit: (actualBytes = bytes) => {
                if (released || committed) {
                    throw new Error(`Budget reservation "${label}" is no longer available.`);
                }
                if (!Number.isSafeInteger(actualBytes) || actualBytes < 0 || actualBytes > bytes) {
                    throw new RangeError('Committed bytes must be between zero and the reserved byte count.');
                }
                committed = true;
                released = true;
                this.reservedBytes -= bytes;
                this.activeReservations--;
                this.currentBytes -= bytes - actualBytes;
                this.leasedBytes += actualBytes;
                this.activeLeases++;
                this.drain();

                let leaseReleased = false;
                return {
                    bytes: actualBytes,
                    label,
                    get released() {
                        return leaseReleased;
                    },
                    release: () => {
                        if (leaseReleased) return;
                        leaseReleased = true;
                        this.currentBytes -= actualBytes;
                        this.leasedBytes -= actualBytes;
                        this.activeLeases--;
                        this.releases++;
                        this.drain();
                    },
                };
            },
            release: () => {
                if (released) return;
                released = true;
                this.currentBytes -= bytes;
                this.reservedBytes -= bytes;
                this.activeReservations--;
                this.releases++;
                this.drain();
            },
        };
    }

    private drain(): void {
        if (this.closed) return;
        while (this.queue.length > 0) {
            const pending = this.queue[0];
            if (!pending) return;
            if (pending.signal?.aborted) {
                this.queue.shift();
                this.removeAbortListener(pending);
                this.cancellations++;
                pending.reject(pending.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
                continue;
            }
            if (this.currentBytes + pending.bytes > this.maxBytes) return;
            this.queue.shift();
            this.removeAbortListener(pending);
            pending.resolve(this.createReservation(pending.bytes, pending.label));
        }
    }

    private removeAbortListener(pending: PendingReservation): void {
        if (pending.signal && pending.onAbort) {
            pending.signal.removeEventListener('abort', pending.onAbort);
        }
    }
}
