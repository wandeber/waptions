import type { VerifiedReadHandle } from '../../path-grants/path-grant-authority';
import {
    assertMediaRange,
    freezeMediaIdentity,
    MediaByteSourceError,
    throwIfAborted,
    type CoreMediaIdentity,
    type MediaByteRange,
    type MediaByteSource,
} from '../../../src/lib/media-byte-source/types';

/**
 * This equals one managed Mediabunny worker read. The decoder reserves both StreamSource workers,
 * both cache extents and their staging overlap in the shared aggregate budget.
 */
export const MANAGED_TRANSCRIPTION_SOURCE_READ_MAX_BYTES = 512 * 1024;

/**
 * Adapts the coordinator's already-open retained source capability without exposing or reopening
 * a filesystem path. Every bounded read is bracketed by immutable identity checks.
 */
export class VerifiedReadHandleMediaByteSource implements MediaByteSource {
    readonly identity: CoreMediaIdentity;
    private closed = false;
    private closing: Promise<void> | null = null;

    constructor(
        readonly sourceId: string,
        private readonly capability: VerifiedReadHandle,
    ) {
        if (!sourceId || sourceId.length > 200) {
            throw new TypeError('Managed transcription source identity is invalid.');
        }
        this.identity = freezeMediaIdentity({
            fingerprint: capability.digest,
            sizeBytes: capability.identity.size,
        });
    }

    async size(): Promise<number> {
        this.assertOpen();
        await this.capability.verifyUnchanged();
        return this.identity.sizeBytes;
    }

    async read(range: MediaByteRange, signal?: AbortSignal): Promise<Uint8Array> {
        this.assertOpen();
        assertMediaRange(
            range,
            this.identity.sizeBytes,
            MANAGED_TRANSCRIPTION_SOURCE_READ_MAX_BYTES,
        );
        throwIfAborted(signal);
        await this.capability.verifyUnchanged();
        throwIfAborted(signal);
        const target = new Uint8Array(range.endExclusive - range.start);
        let offset = 0;
        while (offset < target.byteLength) {
            throwIfAborted(signal);
            const { bytesRead } = await this.capability.handle.read(
                target,
                offset,
                target.byteLength - offset,
                range.start + offset,
            );
            if (bytesRead <= 0) {
                throw new MediaByteSourceError(
                    'SOURCE_CHANGED',
                    'The retained source ended before its immutable length.',
                );
            }
            offset += bytesRead;
        }
        throwIfAborted(signal);
        await this.capability.verifyUnchanged();
        return target;
    }

    stream(range?: MediaByteRange, signal?: AbortSignal): ReadableStream<Uint8Array> {
        this.assertOpen();
        const normalized = range ?? {
            start: 0,
            endExclusive: this.identity.sizeBytes,
        };
        assertMediaRange(normalized, this.identity.sizeBytes, this.identity.sizeBytes);
        let offset = normalized.start;
        return new ReadableStream<Uint8Array>({
            pull: async (controller) => {
                try {
                    throwIfAborted(signal);
                    if (offset >= normalized.endExclusive) {
                        controller.close();
                        return;
                    }
                    const endExclusive = Math.min(
                        normalized.endExclusive,
                        offset + MANAGED_TRANSCRIPTION_SOURCE_READ_MAX_BYTES,
                    );
                    const bytes = await this.read({ start: offset, endExclusive }, signal);
                    offset = endExclusive;
                    controller.enqueue(bytes);
                } catch (error) {
                    controller.error(error);
                }
            },
        });
    }

    async verify(signal?: AbortSignal): Promise<CoreMediaIdentity> {
        this.assertOpen();
        throwIfAborted(signal);
        await this.capability.verifyUnchanged();
        throwIfAborted(signal);
        return this.identity;
    }

    async close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        this.closing = this.capability.close();
        return this.closing;
    }

    private assertOpen(): void {
        if (this.closed) {
            throw new MediaByteSourceError(
                'SOURCE_CLOSED',
                'The managed transcription source is closed.',
            );
        }
    }
}
