import type { MediaBudgetManager } from './budget-manager';
import { mediaRuntimeBudgets } from './budgets';
import { createMediaByteStream } from './stream';
import {
    assertMediaRange,
    createSourceClosedAbortError,
    freezeMediaIdentity,
    HTTP_RANGE_STAGING_BYTES,
    linkAbortSignals,
    MediaByteSourceError,
    type CoreMediaIdentity,
    type MediaByteRange,
    type MediaByteSource,
    throwIfAborted,
} from './types';

type FetchLike = typeof fetch;

export interface HttpRangeMediaByteSourceOptions {
    readonly sourceId: string;
    readonly url: string;
    readonly immutableVersion: string;
    readonly byteLength: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly fetch?: FetchLike;
    readonly stagingBudget?: MediaBudgetManager;
}

export class HttpRangeMediaByteSource implements MediaByteSource {
    readonly sourceId: string;
    readonly identity: CoreMediaIdentity;
    private readonly fetchImpl: FetchLike;
    private readonly stagingBudget: MediaBudgetManager;
    private closed = false;
    private closing: Promise<void> | null = null;
    private readonly lifecycleController = new AbortController();
    private readonly activeOperations = new Set<Promise<unknown>>();
    private readonly strongEtag: string;

    constructor(private readonly options: HttpRangeMediaByteSourceOptions) {
        this.identity = freezeMediaIdentity({
            fingerprint: normalizeStrongEtag(options.immutableVersion),
            sizeBytes: options.byteLength,
        });
        this.sourceId = options.sourceId;
        this.strongEtag = quoteStrongEtag(this.identity.fingerprint);
        this.fetchImpl = options.fetch ?? fetch;
        this.stagingBudget = options.stagingBudget ?? mediaRuntimeBudgets.compressedBytes;
    }

    async size(): Promise<number> {
        this.assertOpen();
        return this.identity.sizeBytes;
    }

    async read(range: MediaByteRange, signal?: AbortSignal): Promise<Uint8Array> {
        this.assertOpen();
        assertMediaRange(range, this.identity.sizeBytes);
        const linked = linkAbortSignals(signal, this.lifecycleController.signal);
        const operation = this.readRange(range, linked.signal);
        this.activeOperations.add(operation);
        try {
            return await operation;
        } finally {
            linked.dispose();
            this.activeOperations.delete(operation);
        }
    }

    private async readRange(range: MediaByteRange, signal: AbortSignal): Promise<Uint8Array> {
        throwIfAborted(signal);
        const result = new Uint8Array(range.endExclusive - range.start);
        let position = range.start;
        while (position < range.endExclusive) {
            const endExclusive = Math.min(position + HTTP_RANGE_STAGING_BYTES, range.endExclusive);
            const chunk = await this.readHttpChunk({ start: position, endExclusive }, signal);
            result.set(chunk, position - range.start);
            position = endExclusive;
        }
        return result;
    }

    stream(range?: MediaByteRange, signal?: AbortSignal): ReadableStream<Uint8Array> {
        this.assertOpen();
        return createMediaByteStream(this, range, signal);
    }

    async verify(signal?: AbortSignal): Promise<CoreMediaIdentity> {
        this.assertOpen();
        const linked = linkAbortSignals(signal, this.lifecycleController.signal);
        const operation = this.verifyRemote(linked.signal);
        this.activeOperations.add(operation);
        try {
            return await operation;
        } finally {
            linked.dispose();
            this.activeOperations.delete(operation);
        }
    }

    async close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        this.lifecycleController.abort(createSourceClosedAbortError());
        this.closing = Promise.allSettled(Array.from(this.activeOperations)).then(() => undefined);
        return this.closing;
    }

    private async readHttpChunk(range: MediaByteRange, signal?: AbortSignal): Promise<Uint8Array> {
        const expectedLength = range.endExclusive - range.start;
        const lease = await this.stagingBudget.reserve(expectedLength, {
            label: `http-range:${this.sourceId}`,
            signal,
        });
        try {
            const response = await this.fetchImpl(this.options.url, {
                method: 'GET',
                headers: {
                    ...this.options.headers,
                    Range: `bytes=${range.start}-${range.endExclusive - 1}`,
                    'If-Range': this.strongEtag,
                },
                signal,
            });
            if (response.status !== 206) {
                throw new MediaByteSourceError(
                    'INVALID_RANGE_RESPONSE',
                    `Expected HTTP 206 for a range read, received ${response.status}.`,
                );
            }
            this.assertResponseIdentity(response);
            const contentRange = response.headers.get('content-range');
            const expectedContentRange = `bytes ${range.start}-${range.endExclusive - 1}/${this.identity.sizeBytes}`;
            if (contentRange !== expectedContentRange) {
                throw new MediaByteSourceError(
                    'INVALID_RANGE_RESPONSE',
                    `Unexpected Content-Range "${contentRange ?? ''}".`,
                );
            }
            const advertisedLength = response.headers.get('content-length');
            if (advertisedLength !== null && Number(advertisedLength) !== expectedLength) {
                throw new MediaByteSourceError('INVALID_RANGE_RESPONSE', 'Unexpected range Content-Length.');
            }
            if (!response.body) {
                throw new MediaByteSourceError('INVALID_RANGE_RESPONSE', 'Range response has no body.');
            }

            const bytes = new Uint8Array(expectedLength);
            const reader = response.body.getReader();
            let offset = 0;
            try {
                while (offset < expectedLength) {
                    throwIfAborted(signal);
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (offset + value.byteLength > expectedLength) {
                        throw new MediaByteSourceError(
                            'INVALID_RANGE_RESPONSE',
                            'Range response exceeded the requested byte count.',
                        );
                    }
                    bytes.set(value, offset);
                    offset += value.byteLength;
                }
                if (offset !== expectedLength) {
                    throw new MediaByteSourceError(
                        'INVALID_RANGE_RESPONSE',
                        `Range response ended at ${offset} of ${expectedLength} bytes.`,
                    );
                }
                const trailing = await reader.read();
                if (!trailing.done && trailing.value.byteLength > 0) {
                    throw new MediaByteSourceError(
                        'INVALID_RANGE_RESPONSE',
                        'Range response contained trailing bytes.',
                    );
                }
            } catch (error) {
                await reader.cancel(error).catch(() => undefined);
                throw error;
            } finally {
                reader.releaseLock();
            }
            return bytes;
        } finally {
            lease.release();
        }
    }

    private assertResponseIdentity(response: Response): void {
        const etag = response.headers.get('etag');
        if (!etag) {
            throw new MediaByteSourceError('SOURCE_CHANGED', 'The HTTP media response omitted its strong ETag.');
        }
        if (normalizeStrongEtag(etag) !== this.identity.fingerprint) {
            throw new MediaByteSourceError('SOURCE_CHANGED', 'The HTTP media ETag changed.');
        }
        const sizeHeader = response.headers.get('content-length');
        if (response.status !== 206) {
            if (sizeHeader === null || Number(sizeHeader) !== this.identity.sizeBytes) {
                throw new MediaByteSourceError(
                    'SOURCE_CHANGED',
                    'The HTTP media size changed or was omitted.',
                );
            }
        }
    }

    private async verifyRemote(signal: AbortSignal): Promise<CoreMediaIdentity> {
        throwIfAborted(signal);
        const response = await this.fetchImpl(this.options.url, {
            method: 'HEAD',
            headers: this.options.headers,
            signal,
        });
        if (!response.ok) {
            throw new Error(`Media source verification failed with HTTP ${response.status}.`);
        }
        this.assertResponseIdentity(response);
        return this.identity;
    }

    private assertOpen(): void {
        if (this.closed) {
            throw new MediaByteSourceError('SOURCE_CLOSED', 'The HTTP range byte source is closed.');
        }
    }
}

function normalizeStrongEtag(value: string): string {
    const trimmed = value.trim();
    if (!trimmed || /^W\//i.test(trimmed)) {
        throw new MediaByteSourceError('SOURCE_CHANGED', 'HTTP media requires a strong ETag.');
    }
    const opaque = trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1)
        : trimmed;
    if (!opaque || /["\u0000-\u001f\u007f]/.test(opaque)) {
        throw new MediaByteSourceError('SOURCE_CHANGED', 'HTTP media ETag is malformed.');
    }
    return opaque;
}

function quoteStrongEtag(opaque: string): string {
    return `"${normalizeStrongEtag(opaque)}"`;
}
