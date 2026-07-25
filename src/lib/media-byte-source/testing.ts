import type { MediaBudgetManager } from './budget-manager';
import { mediaRuntimeBudgets } from './budgets';
import { createMediaByteStream } from './stream';
import {
    assertMediaRange,
    awaitWithAbort,
    createSourceClosedAbortError,
    freezeMediaIdentity,
    MediaByteSourceError,
    linkAbortSignals,
    type CoreMediaIdentity,
    type MediaByteRange,
    type MediaByteSource,
    throwIfAborted,
} from './types';

export interface SparseMediaByteSourceStats {
    readonly bytesRead: number;
    readonly readCalls: number;
    readonly maxReadBytes: number;
    readonly currentReads: number;
    readonly peakConcurrentReads: number;
    readonly closeCalls: number;
}

export class SparseMediaByteSource implements MediaByteSource {
    readonly sourceId: string;
    readonly identity: CoreMediaIdentity;
    private bytesRead = 0;
    private readCalls = 0;
    private maxReadBytes = 0;
    private currentReads = 0;
    private peakConcurrentReads = 0;
    private closeCalls = 0;
    private closed = false;
    private closing: Promise<void> | null = null;
    private readonly lifecycleController = new AbortController();
    private readonly activeOperations = new Set<Promise<unknown>>();

    constructor(options: {
        sourceId: string;
        immutableVersion: string;
        byteLength: number;
        byteAt?: (offset: number) => number;
        stagingBudget?: MediaBudgetManager;
        beforeRead?: (range: MediaByteRange, signal?: AbortSignal) => void | Promise<void>;
    }) {
        this.sourceId = options.sourceId;
        this.identity = freezeMediaIdentity({
            fingerprint: options.immutableVersion,
            sizeBytes: options.byteLength,
        });
        this.byteAt = options.byteAt ?? ((offset) => offset % 251);
        this.stagingBudget = options.stagingBudget ?? mediaRuntimeBudgets.compressedBytes;
        this.beforeRead = options.beforeRead;
    }

    private readonly byteAt: (offset: number) => number;
    private readonly stagingBudget: MediaBudgetManager;
    private readonly beforeRead?: (
        range: MediaByteRange,
        signal?: AbortSignal,
    ) => void | Promise<void>;

    async size(): Promise<number> {
        this.assertOpen();
        return this.identity.sizeBytes;
    }

    async read(range: MediaByteRange, signal?: AbortSignal): Promise<Uint8Array> {
        this.assertOpen();
        assertMediaRange(range, this.identity.sizeBytes);
        const linked = linkAbortSignals(signal, this.lifecycleController.signal);
        const operation = this.readSparse(range, linked.signal);
        this.activeOperations.add(operation);
        try {
            return await operation;
        } finally {
            linked.dispose();
            this.activeOperations.delete(operation);
        }
    }

    private async readSparse(range: MediaByteRange, signal: AbortSignal): Promise<Uint8Array> {
        throwIfAborted(signal);
        if (this.beforeRead) {
            await awaitWithAbort(this.beforeRead(range, signal), signal);
        }
        throwIfAborted(signal);
        const length = range.endExclusive - range.start;
        const reservation = await this.stagingBudget.reserve(length, {
            label: `sparse-read:${this.sourceId}`,
            signal,
        });
        this.currentReads++;
        this.peakConcurrentReads = Math.max(this.peakConcurrentReads, this.currentReads);
        try {
            const bytes = new Uint8Array(length);
            for (let index = 0; index < length; index++) {
                bytes[index] = this.byteAt(range.start + index);
            }
            this.bytesRead += length;
            this.readCalls++;
            this.maxReadBytes = Math.max(this.maxReadBytes, length);
            return bytes;
        } finally {
            this.currentReads--;
            reservation.release();
        }
    }

    stream(range?: MediaByteRange, signal?: AbortSignal): ReadableStream<Uint8Array> {
        this.assertOpen();
        return createMediaByteStream(this, range, signal);
    }

    async verify(signal?: AbortSignal): Promise<CoreMediaIdentity> {
        this.assertOpen();
        throwIfAborted(signal);
        return this.identity;
    }

    async close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closeCalls++;
        this.closed = true;
        this.lifecycleController.abort(createSourceClosedAbortError());
        this.closing = Promise.allSettled(Array.from(this.activeOperations)).then(() => undefined);
        return this.closing;
    }

    stats(): SparseMediaByteSourceStats {
        return Object.freeze({
            bytesRead: this.bytesRead,
            readCalls: this.readCalls,
            maxReadBytes: this.maxReadBytes,
            currentReads: this.currentReads,
            peakConcurrentReads: this.peakConcurrentReads,
            closeCalls: this.closeCalls,
        });
    }

    private assertOpen(): void {
        if (this.closed) {
            throw new MediaByteSourceError('SOURCE_CLOSED', 'Sparse media byte source is closed.');
        }
    }
}

export class MemoryMediaByteSource extends SparseMediaByteSource {
    constructor(
        bytes: Uint8Array,
        options: {
            sourceId?: string;
            immutableVersion?: string;
            stagingBudget?: MediaBudgetManager;
        } = {},
    ) {
        const snapshot = bytes.slice();
        super({
            sourceId: options.sourceId ?? 'memory',
            immutableVersion: options.immutableVersion ?? `memory:${snapshot.byteLength}`,
            byteLength: snapshot.byteLength,
            byteAt: (offset) => snapshot[offset] ?? 0,
            stagingBudget: options.stagingBudget,
        });
    }
}
