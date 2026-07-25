import type { MediaBudgetManager } from './budget-manager';
import { mediaRuntimeBudgets } from './budgets';
import { createMediaByteStream } from './stream';
import {
    assertMediaRange,
    createSourceClosedAbortError,
    freezeMediaIdentity,
    linkAbortSignals,
    MediaByteSourceError,
    type CoreMediaIdentity,
    type MediaByteRange,
    type MediaByteSource,
    throwIfAborted,
} from './types';

let nextBlobId = 1;
const blobIds = new WeakMap<Blob, string>();

function identityForBlob(blob: Blob): CoreMediaIdentity {
    let objectId = blobIds.get(blob);
    if (!objectId) {
        objectId = `blob-${nextBlobId++}`;
        blobIds.set(blob, objectId);
    }
    const file = typeof File !== 'undefined' && blob instanceof File ? blob : null;
    const immutableVersion = file
        ? `${objectId}:${file.name}:${file.lastModified}:${file.size}:${file.type}`
        : `${objectId}:${blob.size}:${blob.type}`;
    return freezeMediaIdentity({
        fingerprint: immutableVersion,
        sizeBytes: blob.size,
    });
}

export class BlobMediaByteSource implements MediaByteSource {
    readonly sourceId: string;
    readonly identity: CoreMediaIdentity;
    private closed = false;
    private readonly lifecycleController = new AbortController();
    private readonly activeOperations = new Set<Promise<unknown>>();
    private closing: Promise<void> | null = null;

    constructor(
        private readonly blob: Blob,
        options: {
            sourceId?: string;
            stagingBudget?: MediaBudgetManager;
        } = {},
    ) {
        if (!(blob instanceof Blob)) throw new TypeError('blob must be a Blob.');
        this.identity = identityForBlob(blob);
        this.sourceId = options.sourceId ?? `blob:${this.identity.fingerprint}`;
        this.stagingBudget = options.stagingBudget ?? mediaRuntimeBudgets.compressedBytes;
    }

    private readonly stagingBudget: MediaBudgetManager;

    async size(): Promise<number> {
        this.assertOpen();
        return this.identity.sizeBytes;
    }

    async read(range: MediaByteRange, signal?: AbortSignal): Promise<Uint8Array> {
        this.assertOpen();
        assertMediaRange(range, this.identity.sizeBytes);
        const linked = linkAbortSignals(signal, this.lifecycleController.signal);
        const operation = this.readBounded(range, linked.signal);
        this.activeOperations.add(operation);
        try {
            return await operation;
        } finally {
            linked.dispose();
            this.activeOperations.delete(operation);
        }
    }

    private async readBounded(range: MediaByteRange, signal: AbortSignal): Promise<Uint8Array> {
        throwIfAborted(signal);
        const byteLength = range.endExclusive - range.start;
        const lease = await this.stagingBudget.reserve(byteLength, {
            label: `blob-read:${this.sourceId}`,
            signal,
        });
        try {
            const buffer = await this.blob.slice(range.start, range.endExclusive).arrayBuffer();
            throwIfAborted(signal);
            if (buffer.byteLength !== byteLength) {
                throw new MediaByteSourceError(
                    'SOURCE_CHANGED',
                    'The Blob returned a different byte length than its immutable identity.',
                );
            }
            return new Uint8Array(buffer);
        } finally {
            lease.release();
        }
    }

    stream(range?: MediaByteRange, signal?: AbortSignal): ReadableStream<Uint8Array> {
        this.assertOpen();
        return createMediaByteStream(this, range, signal);
    }

    async verify(signal?: AbortSignal): Promise<CoreMediaIdentity> {
        this.assertOpen();
        throwIfAborted(signal);
        if (this.blob.size !== this.identity.sizeBytes) {
            throw new MediaByteSourceError('SOURCE_CHANGED', 'The Blob size changed.');
        }
        return this.identity;
    }

    async close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        this.lifecycleController.abort(createSourceClosedAbortError());
        this.closing = Promise.allSettled(Array.from(this.activeOperations)).then(() => undefined);
        return this.closing;
    }

    private assertOpen(): void {
        if (this.closed) {
            throw new MediaByteSourceError('SOURCE_CLOSED', 'The Blob byte source is closed.');
        }
    }
}
