import { createHash, createHmac, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, realpath, rm, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { managedError } from '../coordinator/errors';
import type { DurableWrite, ManagedFilesystemStore } from '../persistence/managed-filesystem-store';
import {
    constantTimeStringEqual,
} from '../persistence/canonical-json';
import { ensurePrivateDirectory, fsyncDirectory } from '../persistence/fs-durable';

export interface ArtifactRecord {
    schemaVersion: 1;
    artifactId: string;
    projectId: string;
    kind: string;
    mediaType: string;
    byteLength: number;
    digest: string;
    relativeBlobPath: string;
    createdAt: string;
    expiresAt?: string;
    sourceIds: readonly string[];
}

export interface ArtifactRange {
    bytes: Uint8Array;
    start: number;
    endExclusive: number;
    totalBytes: number;
    digest: string;
}

export interface StagedArtifact {
    record: ArtifactRecord;
    registryWrite: DurableWrite;
}

const MAX_STREAM_BUFFER = 8 * 1024 * 1024;
const MAX_RANGE_BYTES = 4 * 1024 * 1024;

export class ArtifactRegistry {
    constructor(
        private readonly store: ManagedFilesystemStore,
        private readonly capabilitySecret: Uint8Array,
    ) {}

    async stage(
        projectId: string,
        kind: string,
        mediaType: string,
        source: AsyncIterable<Uint8Array> | Readable,
        options: { expiresAt?: string; sourceIds?: readonly string[] } = {},
    ): Promise<StagedArtifact> {
        const root = this.store.projectPath(projectId, 'artifacts');
        const blobRoot = join(root, 'blobs');
        await ensurePrivateDirectory(blobRoot);
        const artifactId = randomUUID();
        const temporary = join(blobRoot, `.${artifactId}.partial`);
        const hash = createHash('sha256');
        let byteLength = 0;
        let handle;
        try {
            handle = await open(
                temporary,
                constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
                0o600,
            );
            for await (const input of source) {
                if (input.byteLength > MAX_STREAM_BUFFER) {
                    throw managedError(
                        'PAYLOAD_TOO_LARGE',
                        'Artifact producers must stream chunks no larger than 8 MiB.',
                    );
                }
                const chunk = Buffer.from(input);
                for (let offset = 0; offset < chunk.byteLength; offset += MAX_STREAM_BUFFER) {
                    const bounded = chunk.subarray(offset, offset + MAX_STREAM_BUFFER);
                    await handle.write(bounded);
                    hash.update(bounded);
                    byteLength += bounded.byteLength;
                    if (!Number.isSafeInteger(byteLength)) {
                        throw managedError(
                            'PAYLOAD_TOO_LARGE',
                            'The artifact exceeds the supported size.',
                        );
                    }
                }
            }
            await handle.sync();
            await handle.close();
            handle = undefined;
            const digest = `sha256:${hash.digest('hex')}`;
            const finalPath = join(blobRoot, `${digest.slice(7)}.blob`);
            try {
                const existing = await stat(finalPath);
                if (
                    !existing.isFile()
                    || !Number.isSafeInteger(existing.size)
                    || existing.size !== byteLength
                ) {
                    throw new Error('Artifact digest collision or corrupt blob.');
                }
                await rm(temporary);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    const staged = await open(temporary, constants.O_RDONLY);
                    await staged.close();
                    const { rename } = await import('node:fs/promises');
                    await rename(temporary, finalPath);
                    await fsyncDirectory(blobRoot);
                } else {
                    throw error;
                }
            }
            const record: ArtifactRecord = {
                schemaVersion: 1,
                artifactId,
                projectId,
                kind: boundedText(kind),
                mediaType: boundedText(mediaType),
                byteLength,
                digest,
                relativeBlobPath: relative(root, finalPath),
                createdAt: new Date().toISOString(),
                ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
                sourceIds: [...(options.sourceIds ?? [])],
            };
            return {
                record,
                registryWrite: {
                    relativePath: `artifacts/${artifactId}.json`,
                    value: record,
                },
            };
        } finally {
            await handle?.close().catch(() => undefined);
            await rm(temporary, { force: true }).catch(() => undefined);
        }
    }

    async list(projectId: string): Promise<ArtifactRecord[]> {
        return (await this.store.readNamespace<ArtifactRecord>(projectId, 'artifacts'))
            .filter((record) => !isExpired(record));
    }

    async get(projectId: string, artifactId: string): Promise<ArtifactRecord> {
        const records = await this.list(projectId);
        const record = records.find((candidate) => candidate.artifactId === artifactId);
        if (!record) {
            const all = await this.store.readNamespace<ArtifactRecord>(projectId, 'artifacts');
            if (all.some((candidate) => candidate.artifactId === artifactId)) {
                throw managedError('ARTIFACT_EXPIRED', 'The managed artifact has expired.');
            }
            throw managedError('NOT_FOUND', 'The managed artifact does not exist.');
        }
        return record;
    }

    async readRange(
        projectId: string,
        artifactId: string,
        start: number,
        endExclusive: number,
    ): Promise<ArtifactRange> {
        const record = await this.get(projectId, artifactId);
        if (
            !Number.isSafeInteger(start)
            || !Number.isSafeInteger(endExclusive)
            || start < 0
            || endExclusive <= start
            || endExclusive > record.byteLength
            || endExclusive - start > MAX_RANGE_BYTES
        ) {
            throw managedError('INVALID_REQUEST', 'The requested artifact byte range is invalid.');
        }
        const path = await this.resolveBlob(record);
        const handle = await open(path, constants.O_RDONLY);
        try {
            const bytes = Buffer.allocUnsafe(endExclusive - start);
            const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, start);
            if (bytesRead !== bytes.byteLength) throw new Error('Artifact range was truncated.');
            return {
                bytes,
                start,
                endExclusive,
                totalBytes: record.byteLength,
                digest: record.digest,
            };
        } finally {
            await handle.close();
        }
    }

    capability(projectId: string, artifactId: string, expiresAtMilliseconds: number): string {
        const body = `a1.${projectId}.${artifactId}.${expiresAtMilliseconds}`;
        const signature = createHmac('sha256', this.capabilitySecret).update(body).digest('base64url');
        return `${body}.${signature}`;
    }

    verifyCapability(
        token: string,
        projectId: string,
        artifactId: string,
        now = Date.now(),
    ): void {
        const match = /^a1\.([^.]+)\.([^.]+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(token);
        if (!match || match[1] !== projectId || match[2] !== artifactId) {
            throw managedError('CAPABILITY_EXPIRED', 'The artifact capability is invalid.');
        }
        const body = `a1.${match[1]}.${match[2]}.${match[3]}`;
        const expected = createHmac('sha256', this.capabilitySecret).update(body).digest('base64url');
        if (!constantTimeStringEqual(expected, match[4]) || Number(match[3]) < now) {
            throw managedError('CAPABILITY_EXPIRED', 'The artifact capability has expired.');
        }
    }

    async cleanupExpired(projectId: string, now = Date.now()): Promise<string[]> {
        const root = this.store.projectPath(projectId, 'artifacts');
        const records = await this.store.readNamespace<ArtifactRecord>(projectId, 'artifacts');
        const expired = records.filter((record) => isExpired(record, now));
        for (const record of expired) {
            await rm(join(root, `${record.artifactId}.json`), { force: true });
        }
        const retainedBlobs = new Set(
            records.filter((record) => !isExpired(record, now)).map((record) => record.relativeBlobPath),
        );
        const blobRoot = join(root, 'blobs');
        let blobNames: string[] = [];
        try {
            blobNames = await readdir(blobRoot);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        for (const name of blobNames) {
            const relativePath = `blobs/${name}`;
            if (!retainedBlobs.has(relativePath)) await rm(join(blobRoot, name), { force: true });
        }
        await fsyncDirectory(root);
        await fsyncDirectory(blobRoot).catch(() => undefined);
        return expired.map((record) => record.artifactId);
    }

    private async resolveBlob(record: ArtifactRecord): Promise<string> {
        const root = await realpath(this.store.projectPath(record.projectId, 'artifacts'));
        const path = await realpath(join(root, record.relativeBlobPath));
        const nested = relative(root, path);
        if (nested === '..' || nested.startsWith(`..${sep}`)) {
            throw new Error('Artifact blob escaped its namespace.');
        }
        const metadata = await stat(path);
        if (
            !metadata.isFile()
            || !Number.isSafeInteger(metadata.size)
            || metadata.size !== record.byteLength
        ) {
            throw new Error('Artifact blob metadata does not match its registry record.');
        }
        return path;
    }
}

function isExpired(record: ArtifactRecord, now = Date.now()): boolean {
    return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now;
}

function boundedText(value: string): string {
    const normalized = value.trim();
    if (!normalized || normalized.length > 128) {
        throw managedError('INVALID_REQUEST', 'Artifact metadata is empty or oversized.');
    }
    return normalized;
}
