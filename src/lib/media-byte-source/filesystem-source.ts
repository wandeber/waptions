import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import type { MediaBudgetManager } from './budget-manager';
import { mediaRuntimeBudgets } from './budgets';
import { createMediaByteStream } from './stream';
import {
    assertMediaRange,
    createSourceClosedAbortError,
    freezeMediaIdentity,
    linkAbortSignals,
    MEDIA_READ_CHUNK_BYTES,
    MediaByteSourceError,
    type CoreMediaIdentity,
    type MediaByteRange,
    type MediaByteSource,
    throwIfAborted,
} from './types';

export interface FilesystemStatToken {
    readonly dev: string;
    readonly ino: string;
    readonly size: string;
    readonly mtimeNs: string;
    readonly ctimeNs: string;
}

export interface FilesystemMediaByteSourceOptions {
    readonly sourceId: string;
    readonly path: string;
    readonly authorize?: (range: MediaByteRange | null, signal?: AbortSignal) => void | Promise<void>;
    readonly stagingBudget?: MediaBudgetManager;
}

export interface VerifiedFilesystemHandleCapability {
    readonly sourceId: string;
    /** Ownership transfers to FilesystemMediaByteSource. */
    readonly handle: FileHandle;
    readonly identity: CoreMediaIdentity;
    readonly statToken?: FilesystemStatToken;
    readonly authorize?: (range: MediaByteRange | null, signal?: AbortSignal) => void | Promise<void>;
    readonly stagingBudget?: MediaBudgetManager;
}

export class FilesystemHandleAdoptionError extends Error {
    constructor(
        message: string,
        readonly adoptionError: unknown,
        readonly cleanupError: unknown,
    ) {
        super(message, { cause: adoptionError });
        this.name = 'FilesystemHandleAdoptionError';
    }
}

function tokenFromStat(value: Awaited<ReturnType<FileHandle['stat']>>): FilesystemStatToken {
    const bigintStat = value as typeof value & {
        dev: bigint;
        ino: bigint;
        size: bigint;
        mtimeNs: bigint;
        ctimeNs: bigint;
    };
    return {
        dev: String(bigintStat.dev),
        ino: String(bigintStat.ino),
        size: String(bigintStat.size),
        mtimeNs: String(bigintStat.mtimeNs),
        ctimeNs: String(bigintStat.ctimeNs),
    };
}

function tokensEqual(left: FilesystemStatToken, right: FilesystemStatToken): boolean {
    return (
        left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs
    );
}

async function checkedStat(handle: FileHandle): Promise<FilesystemStatToken> {
    const value = await handle.stat({ bigint: true });
    if (!value.isFile()) {
        throw new MediaByteSourceError('SOURCE_UNREADABLE', 'Filesystem media source is not a regular file.');
    }
    return tokenFromStat(value);
}

async function hashHandle(
    handle: FileHandle,
    sizeBytes: number,
    stagingBudget: MediaBudgetManager,
    signal?: AbortSignal,
): Promise<string> {
    const bufferBytes = Math.min(MEDIA_READ_CHUNK_BYTES, Math.max(1, sizeBytes));
    const reservation = await stagingBudget.reserve(bufferBytes, {
        label: 'filesystem-sha256-buffer',
        signal,
    });
    const lease = reservation.commit();
    try {
        const hash = createHash('sha256');
        const buffer = new Uint8Array(bufferBytes);
        let position = 0;
        while (position < sizeBytes) {
            throwIfAborted(signal);
            const requested = Math.min(buffer.byteLength, sizeBytes - position);
            const { bytesRead } = await handle.read(buffer, 0, requested, position);
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
        throwIfAborted(signal);
        return hash.digest('hex');
    } finally {
        lease.release();
    }
}

export class FilesystemMediaByteSource implements MediaByteSource {
    readonly sourceId: string;
    readonly identity: CoreMediaIdentity;
    private closed = false;
    private closing: Promise<void> | null = null;
    private readonly activeOperations = new Set<Promise<unknown>>();
    private readonly lifecycleController = new AbortController();

    private constructor(
        private readonly handle: FileHandle,
        private readonly statToken: FilesystemStatToken,
        private readonly authorize: VerifiedFilesystemHandleCapability['authorize'],
        sourceId: string,
        identity: CoreMediaIdentity,
        private readonly stagingBudget: MediaBudgetManager,
    ) {
        this.sourceId = sourceId;
        this.identity = identity;
    }

    /**
     * Adopts an already-authorized and verified descriptor without resolving or reopening a path.
     * Managed runtimes use this entrypoint so a path swap cannot redirect later reads.
     */
    static async fromVerifiedHandle(
        capability: VerifiedFilesystemHandleCapability,
        signal?: AbortSignal,
    ): Promise<FilesystemMediaByteSource> {
        throwIfAborted(signal);
        try {
            const currentToken = await checkedStat(capability.handle);
            if (capability.statToken && !tokensEqual(capability.statToken, currentToken)) {
                throw new MediaByteSourceError(
                    'SOURCE_CHANGED',
                    'The verified filesystem handle changed before adoption.',
                );
            }
            if (Number(currentToken.size) !== capability.identity.sizeBytes) {
                throw new MediaByteSourceError(
                    'SOURCE_CHANGED',
                    'The verified filesystem handle size does not match its Core identity.',
                );
            }
            return new FilesystemMediaByteSource(
                capability.handle,
                currentToken,
                capability.authorize,
                capability.sourceId,
                freezeMediaIdentity(capability.identity),
                capability.stagingBudget ?? mediaRuntimeBudgets.compressedBytes,
            );
        } catch (error) {
            try {
                await capability.handle.close();
            } catch (cleanupError) {
                throw new FilesystemHandleAdoptionError(
                    'The verified filesystem handle failed adoption and cleanup.',
                    error,
                    cleanupError,
                );
            }
            throw error;
        }
    }

    static async open(
        options: FilesystemMediaByteSourceOptions,
        signal?: AbortSignal,
    ): Promise<FilesystemMediaByteSource> {
        throwIfAborted(signal);
        await options.authorize?.(null, signal);
        const canonicalPath = await realpath(options.path);
        throwIfAborted(signal);
        const handle = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const stagingBudget = options.stagingBudget ?? mediaRuntimeBudgets.compressedBytes;
            const before = await checkedStat(handle);
            const byteLength = Number(before.size);
            if (!Number.isSafeInteger(byteLength)) {
                throw new MediaByteSourceError('SOURCE_UNREADABLE', 'Filesystem media is too large to index safely.');
            }
            const sha256 = await hashHandle(handle, byteLength, stagingBudget, signal);
            const after = await checkedStat(handle);
            if (!tokensEqual(before, after)) {
                throw new MediaByteSourceError('SOURCE_CHANGED', 'Filesystem media changed while hashing.');
            }
            return new FilesystemMediaByteSource(
                handle,
                after,
                options.authorize,
                options.sourceId,
                freezeMediaIdentity({
                    fingerprint: `sha256:${sha256}`,
                    sizeBytes: byteLength,
                }),
                stagingBudget,
            );
        } catch (error) {
            await handle.close().catch(() => undefined);
            throw error;
        }
    }

    async size(): Promise<number> {
        this.assertOpen();
        return this.identity.sizeBytes;
    }

    async read(range: MediaByteRange, signal?: AbortSignal): Promise<Uint8Array> {
        this.assertOpen();
        assertMediaRange(range, this.identity.sizeBytes);
        const linked = linkAbortSignals(signal, this.lifecycleController.signal);
        const operation = this.authorizedRead(range, linked.signal);
        this.activeOperations.add(operation);
        try {
            return await operation;
        } finally {
            linked.dispose();
            this.activeOperations.delete(operation);
        }
    }

    private async authorizedRead(
        range: MediaByteRange,
        signal: AbortSignal,
    ): Promise<Uint8Array> {
        throwIfAborted(signal);
        await this.authorize?.(range, signal);
        throwIfAborted(signal);
        return this.readBounded(range, signal);
    }

    stream(range?: MediaByteRange, signal?: AbortSignal): ReadableStream<Uint8Array> {
        this.assertOpen();
        return createMediaByteStream(this, range, signal);
    }

    async verify(signal?: AbortSignal): Promise<CoreMediaIdentity> {
        this.assertOpen();
        const linked = linkAbortSignals(signal, this.lifecycleController.signal);
        const operation = this.verifyHandle(linked.signal);
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
        this.closing = (async () => {
            await Promise.allSettled(Array.from(this.activeOperations));
            await this.handle.close();
        })();
        return this.closing;
    }

    private async readBounded(range: MediaByteRange, signal?: AbortSignal): Promise<Uint8Array> {
        const before = await checkedStat(this.handle);
        if (!tokensEqual(before, this.statToken)) {
            throw new MediaByteSourceError('SOURCE_CHANGED', 'Filesystem media changed before a read.');
        }
        const byteLength = range.endExclusive - range.start;
        const reservation = await this.stagingBudget.reserve(byteLength, {
            label: `filesystem-read:${this.sourceId}`,
            signal,
        });
        try {
            const bytes = new Uint8Array(byteLength);
            let offset = 0;
            while (offset < byteLength) {
                throwIfAborted(signal);
                const result = await this.handle.read(
                    bytes,
                    offset,
                    byteLength - offset,
                    range.start + offset,
                );
                if (result.bytesRead === 0) {
                    throw new MediaByteSourceError('SOURCE_CHANGED', 'Filesystem media ended during a bounded read.');
                }
                offset += result.bytesRead;
            }
            throwIfAborted(signal);
            const after = await checkedStat(this.handle);
            if (!tokensEqual(after, this.statToken)) {
                throw new MediaByteSourceError('SOURCE_CHANGED', 'Filesystem media changed during a read.');
            }
            return bytes;
        } finally {
            reservation.release();
        }
    }

    private async verifyHandle(signal: AbortSignal): Promise<CoreMediaIdentity> {
        throwIfAborted(signal);
        await this.authorize?.(null, signal);
        const before = await checkedStat(this.handle);
        if (!tokensEqual(before, this.statToken)) {
            throw new MediaByteSourceError('SOURCE_CHANGED', 'Filesystem media metadata changed.');
        }
        const sha256 = await hashHandle(
            this.handle,
            this.identity.sizeBytes,
            this.stagingBudget,
            signal,
        );
        const after = await checkedStat(this.handle);
        if (
            !tokensEqual(before, after)
            || this.identity.fingerprint !== `sha256:${sha256}`
        ) {
            throw new MediaByteSourceError('SOURCE_CHANGED', 'Filesystem media bytes changed.');
        }
        return this.identity;
    }

    private assertOpen(): void {
        if (this.closed) {
            throw new MediaByteSourceError('SOURCE_CLOSED', 'Filesystem media byte source is closed.');
        }
    }
}
