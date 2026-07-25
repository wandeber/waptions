import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
    lstat,
    mkdtemp,
    open,
    rm,
    type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDirectory } from '../../persistence/fs-durable';
import { ManagedMediaError, throwIfAborted } from '../../media/errors';
import type {
    ManagedProcessOutputHandle,
    ManagedProcessOutputResolverPort,
} from './node-bounded-media-process';

const STREAM_CHUNK_BYTES = 1024 * 1024;

interface StageRecord {
    readonly stageId: string;
    readonly capabilityId: string;
    readonly directory: string;
    readonly path: string;
    readonly maxBytes: number;
    readonly device: bigint;
    readonly inode: bigint;
    settled: boolean;
}

export interface PrivateReviewArtifactStage {
    readonly stageId: string;
    readonly processOutputCapabilityId: string;
    writeJson(value: unknown, signal?: AbortSignal): Promise<void>;
    byteLength(signal?: AbortSignal): Promise<number>;
    stream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
    discard(): Promise<void>;
}

/**
 * Private create-only output authority for review workers.
 *
 * The generated path is never returned to a job/result. Workers resolve only an opaque capability
 * to a fresh descriptor, and the entire directory disappears after transfer or cancellation.
 */
export class PrivateReviewArtifactStager implements ManagedProcessOutputResolverPort {
    private readonly records = new Map<string, StageRecord>();

    constructor(private readonly privateRoot: string) {}

    async create(maxBytes: number, signal?: AbortSignal): Promise<PrivateReviewArtifactStage> {
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
            throw new RangeError('Review artifact byte limit must be positive.');
        }
        throwIfAborted(signal);
        await ensurePrivateDirectory(this.privateRoot);
        const directory = await mkdtemp(join(this.privateRoot, 'review-'));
        const path = join(directory, 'artifact.partial');
        const handle = await open(
            path,
            constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
            0o600,
        );
        const stat = await handle.stat({ bigint: true });
        await handle.close();
        const record: StageRecord = {
            stageId: `review-stage:${randomUUID()}`,
            capabilityId: `review-output:${randomUUID()}`,
            directory,
            path,
            maxBytes,
            device: stat.dev,
            inode: stat.ino,
            settled: false,
        };
        this.records.set(record.capabilityId, record);
        return {
            stageId: record.stageId,
            processOutputCapabilityId: record.capabilityId,
            writeJson: async (value, writeSignal) => {
                throwIfAborted(writeSignal);
                const bytes = Buffer.from(JSON.stringify(value));
                if (bytes.byteLength > record.maxBytes) {
                    throw new ManagedMediaError(
                        'OUTPUT_LIMIT_EXCEEDED',
                        'Structured review artifact exceeded its byte limit.',
                    );
                }
                const output = await this.openRecord(record, 'read-write', writeSignal);
                try {
                    await output.truncate(0);
                    await output.writeFile(bytes);
                    await output.sync();
                } finally {
                    await output.close();
                }
            },
            byteLength: async (sizeSignal) => {
                throwIfAborted(sizeSignal);
                const stat = await this.assertCurrent(record);
                return Number(stat.size);
            },
            stream: (streamSignal) => this.streamRecord(record, streamSignal),
            discard: () => this.discardRecord(record),
        };
    }

    async acquire(
        processOutputCapabilityId: string,
        signal?: AbortSignal,
    ): Promise<ManagedProcessOutputHandle> {
        throwIfAborted(signal);
        const record = this.records.get(processOutputCapabilityId);
        if (!record || record.settled) {
            throw new ManagedMediaError(
                'PATH_NOT_GRANTED',
                'Review output capability is not active.',
            );
        }
        const handle = await this.openRecord(record, 'read-write', signal);
        let closed = false;
        return {
            fileDescriptor: handle.fd,
            size: async (sizeSignal) => {
                throwIfAborted(sizeSignal);
                const stat = await handle.stat({ bigint: true });
                this.assertIdentity(record, stat);
                return Number(stat.size);
            },
            assertCurrent: async (assertSignal) => {
                throwIfAborted(assertSignal);
                if (closed || record.settled) {
                    throw new ManagedMediaError(
                        'PATH_NOT_GRANTED',
                        'Review output capability is closed.',
                    );
                }
                const stat = await handle.stat({ bigint: true });
                this.assertIdentity(record, stat);
                if (stat.size > BigInt(record.maxBytes)) {
                    throw new ManagedMediaError(
                        'OUTPUT_LIMIT_EXCEEDED',
                        'Review output exceeded its byte limit.',
                    );
                }
            },
            sync: async (syncSignal) => {
                throwIfAborted(syncSignal);
                await handle.sync();
            },
            close: async () => {
                if (closed) return;
                closed = true;
                await handle.close();
            },
        };
    }

    private async *streamRecord(
        record: StageRecord,
        signal?: AbortSignal,
    ): AsyncIterable<Uint8Array> {
        throwIfAborted(signal);
        const handle = await this.openRecord(record, 'read-only', signal);
        try {
            const initial = await handle.stat({ bigint: true });
            this.assertIdentity(record, initial);
            if (initial.size > BigInt(record.maxBytes)) {
                throw new ManagedMediaError(
                    'OUTPUT_LIMIT_EXCEEDED',
                    'Review output exceeded its byte limit.',
                );
            }
            const total = Number(initial.size);
            let position = 0;
            while (position < total) {
                throwIfAborted(signal);
                const length = Math.min(STREAM_CHUNK_BYTES, total - position);
                const bytes = Buffer.allocUnsafe(length);
                const result = await handle.read(bytes, 0, length, position);
                if (result.bytesRead !== length) {
                    throw new ManagedMediaError(
                        'PATH_IDENTITY_CHANGED',
                        'Review output changed while it was transferred.',
                    );
                }
                position += result.bytesRead;
                yield bytes;
            }
            const current = await handle.stat({ bigint: true });
            this.assertIdentity(record, current);
            if (current.size !== initial.size) {
                throw new ManagedMediaError(
                    'PATH_IDENTITY_CHANGED',
                    'Review output length changed while it was transferred.',
                );
            }
        } finally {
            await handle.close();
        }
    }

    private async openRecord(
        record: StageRecord,
        access: 'read-only' | 'read-write',
        signal?: AbortSignal,
    ): Promise<FileHandle> {
        throwIfAborted(signal);
        if (record.settled) {
            throw new ManagedMediaError('PATH_NOT_GRANTED', 'Review stage is settled.');
        }
        const flags = access === 'read-only'
            ? constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag()
            : constants.O_RDWR | constants.O_NONBLOCK | noFollowFlag();
        const handle = await open(record.path, flags);
        try {
            const stat = await handle.stat({ bigint: true });
            this.assertIdentity(record, stat);
            return handle;
        } catch (error) {
            await handle.close().catch(() => undefined);
            throw error;
        }
    }

    private async assertCurrent(record: StageRecord) {
        if (record.settled) {
            throw new ManagedMediaError('PATH_NOT_GRANTED', 'Review stage is settled.');
        }
        const stat = await lstat(record.path, { bigint: true });
        this.assertIdentity(record, stat);
        return stat;
    }

    private assertIdentity(
        record: StageRecord,
        stat: Awaited<ReturnType<FileHandle['stat']>>,
    ): void {
        if (!stat.isFile() || stat.dev !== record.device || stat.ino !== record.inode) {
            throw new ManagedMediaError(
                'PATH_IDENTITY_CHANGED',
                'Review output staging identity changed.',
            );
        }
    }

    private async discardRecord(record: StageRecord): Promise<void> {
        if (record.settled) return;
        await rm(record.directory, { recursive: true, force: true });
        record.settled = true;
        this.records.delete(record.capabilityId);
    }
}

function noFollowFlag(): number {
    return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
}
