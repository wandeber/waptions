import { createHash, createHmac, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { managedError } from '../coordinator/errors';
import type { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics';
import type { DurableWrite, ManagedFilesystemStore } from '../persistence/managed-filesystem-store';
import { constantTimeStringEqual } from '../persistence/canonical-json';
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
    accept(): void;
    reject(): Promise<void>;
}

export interface ArtifactQuotaPolicy {
    maximumArtifactBytes: number;
    maximumSessionBytes: number;
    maximumSessionCount: number;
    maximumGlobalBytes: number;
    maximumGlobalCount: number;
    maximumConcurrentArtifacts: number;
    maximumDurationMilliseconds: number;
    maximumChunkBytes: number;
}

const DEFAULT_QUOTAS: ArtifactQuotaPolicy = {
    maximumArtifactBytes: 4 * 1024 * 1024 * 1024,
    maximumSessionBytes: 32 * 1024 * 1024 * 1024,
    maximumSessionCount: 2_048,
    maximumGlobalBytes: 128 * 1024 * 1024 * 1024,
    maximumGlobalCount: 8_192,
    maximumConcurrentArtifacts: 8,
    maximumDurationMilliseconds: 30 * 60 * 1000,
    maximumChunkBytes: 8 * 1024 * 1024,
};
const MAX_RANGE_BYTES = 4 * 1024 * 1024;

interface QuotaReservation {
    addBytes(bytes: number): void;
    release(): void;
}

export class ArtifactRegistry {
    private reservedGlobalBytes = 0;
    private reservedGlobalCount = 0;
    private readonly reservedSessionBytes = new Map<string, number>();
    private readonly reservedSessionCount = new Map<string, number>();
    private readonly stagedBlobOwners = new Map<string, number>();
    private quotaQueue = Promise.resolve();
    private blobOwnershipQueue = Promise.resolve();

    constructor(
        private readonly store: ManagedFilesystemStore,
        private readonly capabilitySecret: Uint8Array,
        private readonly diagnostics?: RuntimeDiagnostics,
        readonly quotas: ArtifactQuotaPolicy = DEFAULT_QUOTAS,
    ) {
        validateQuotaPolicy(quotas);
    }

    async stage(
        projectId: string,
        kindInput: string,
        mediaTypeInput: string,
        source: AsyncIterable<Uint8Array> | Readable,
        options: {
            expiresAt?: string;
            sourceIds?: readonly string[];
            signal?: AbortSignal;
            deadlineMilliseconds?: number;
        } = {},
    ): Promise<StagedArtifact> {
        // Reject every caller-controlled field before UUID allocation, directory creation, or
        // stream consumption. Receipt lookup and mutation guards occur before this method.
        const kind = boundedText(kindInput);
        const mediaType = boundedText(mediaTypeInput);
        const expiresAt = validateExpiry(options.expiresAt);
        const sourceIds = validateSourceIds(options.sourceIds ?? []);
        const duration = options.deadlineMilliseconds ?? this.quotas.maximumDurationMilliseconds;
        if (
            !Number.isSafeInteger(duration)
            || duration <= 0
            || duration > this.quotas.maximumDurationMilliseconds
        ) {
            throw managedError('INVALID_REQUEST', 'The artifact deadline is invalid.');
        }
        if (options.signal?.aborted) {
            throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        const deadlineAt = Date.now() + duration;

        let reservation: QuotaReservation;
        try {
            reservation = await this.reserve(projectId);
        } catch (error) {
            if ((error as { code?: string }).code === 'PAYLOAD_TOO_LARGE') {
                this.diagnostics?.record('limitRejections');
            }
            throw error;
        }
        const releaseArtifactDiagnostic = this.diagnostics?.increment('artifactsInFlight');
        const root = this.store.projectPath(projectId, 'artifacts');
        const blobRoot = join(root, 'blobs');
        const stagingRoot = join(root, 'staging');
        let temporary: string | undefined;
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        let finalPath: string | undefined;
        let retainedBlob = false;
        let settled = false;
        try {
            await Promise.all([
                ensurePrivateDirectory(blobRoot),
                ensurePrivateDirectory(stagingRoot),
            ]);
            const artifactId = randomUUID();
            temporary = join(stagingRoot, `${artifactId}.partial`);
            handle = await open(
                temporary,
                constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
                0o600,
            );
            const hash = createHash('sha256');
            let byteLength = 0;
            const iterator = source[Symbol.asyncIterator]();
            try {
                while (true) {
                    const item = await nextWithDeadline(iterator, options.signal, deadlineAt);
                    if (item.done) break;
                    if (!(item.value instanceof Uint8Array)) {
                        throw managedError('INVALID_REQUEST', 'Artifact streams must yield bytes.');
                    }
                    if (item.value.byteLength > this.quotas.maximumChunkBytes) {
                        throw managedError(
                            'PAYLOAD_TOO_LARGE',
                            'An artifact stream chunk exceeds the configured limit.',
                        );
                    }
                    const chunk = Buffer.from(item.value);
                    reservation.addBytes(chunk.byteLength);
                    this.diagnostics?.set('artifactBytesInFlight', this.reservedGlobalBytes);
                    await writeAll(handle, chunk);
                    hash.update(chunk);
                    byteLength += chunk.byteLength;
                }
            } finally {
                // A hostile iterator may ignore cancellation while blocked in next(). Do not let
                // its optional cleanup hook extend the authority deadline.
                void iterator.return?.().catch(() => undefined);
            }
            assertNotCancelled(options.signal, deadlineAt);
            await handle.sync();
            assertNotCancelled(options.signal, deadlineAt);
            await handle.close();
            handle = undefined;
            assertNotCancelled(options.signal, deadlineAt);

            const digest = `sha256:${hash.digest('hex')}`;
            finalPath = join(blobRoot, `${digest.slice(7)}.blob`);
            try {
                const existing = await stat(finalPath);
                assertNotCancelled(options.signal, deadlineAt);
                if (
                    !existing.isFile()
                    || !Number.isSafeInteger(existing.size)
                    || existing.size !== byteLength
                ) {
                    throw new Error('Artifact digest collision or corrupt blob.');
                }
                this.retainStagedBlob(finalPath);
                retainedBlob = true;
                await rm(temporary);
                assertNotCancelled(options.signal, deadlineAt);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                await rename(temporary, finalPath);
                this.retainStagedBlob(finalPath);
                retainedBlob = true;
                assertNotCancelled(options.signal, deadlineAt);
                await fsyncDirectory(blobRoot);
                assertNotCancelled(options.signal, deadlineAt);
            }
            temporary = undefined;

            const record: ArtifactRecord = {
                schemaVersion: 1,
                artifactId,
                projectId,
                kind,
                mediaType,
                byteLength,
                digest,
                relativeBlobPath: relative(root, finalPath),
                createdAt: new Date().toISOString(),
                ...(expiresAt ? { expiresAt } : {}),
                sourceIds,
            };
            const settle = () => {
                if (settled) return;
                settled = true;
                if (retainedBlob) {
                    this.releaseStagedBlob(finalPath!);
                    retainedBlob = false;
                }
                reservation.release();
                this.diagnostics?.set('artifactBytesInFlight', this.reservedGlobalBytes);
                releaseArtifactDiagnostic?.();
            };
            return {
                record,
                registryWrite: {
                    relativePath: `artifacts/${artifactId}.json`,
                    value: record,
                },
                accept: settle,
                reject: async () => {
                    if (settled) return;
                    try {
                        // A persistence exception may happen after the WAL marker. Recover first;
                        // delete only when no committed registry record owns this project blob.
                        await this.store.recoverProject(projectId);
                        const records = await this.store.readNamespace<ArtifactRecord>(
                            projectId,
                            'artifacts',
                        );
                        await this.releaseStagedBlobAndMaybeDelete(
                            finalPath!,
                            blobRoot,
                            records.some((candidate) => (
                                candidate.relativeBlobPath === record.relativeBlobPath
                            )),
                        );
                        retainedBlob = false;
                    } finally {
                        settle();
                    }
                },
            };
        } catch (error) {
            if (options.signal?.aborted || (error as { name?: string }).name === 'AbortError') {
                this.diagnostics?.record('abortedOperations');
            } else if ((error as { code?: string }).code === 'PAYLOAD_TOO_LARGE') {
                this.diagnostics?.record('limitRejections');
            } else if (
                (error as { code?: string }).code === 'COORDINATOR_UNAVAILABLE'
                && Date.now() >= deadlineAt
            ) {
                this.diagnostics?.record('deadlineExceeded');
            }
            if (retainedBlob && finalPath) {
                const records = await this.store.readNamespace<ArtifactRecord>(
                    projectId,
                    'artifacts',
                ).catch(() => null);
                await this.releaseStagedBlobAndMaybeDelete(
                    finalPath,
                    blobRoot,
                    records === null || records.some((candidate) => (
                        candidate.relativeBlobPath === relative(root, finalPath!)
                    )),
                ).catch(() => undefined);
                retainedBlob = false;
            }
            reservation.release();
            this.diagnostics?.set('artifactBytesInFlight', this.reservedGlobalBytes);
            releaseArtifactDiagnostic?.();
            throw error;
        } finally {
            await handle?.close().catch(() => undefined);
            if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
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
        const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
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
        for (const name of await directoryEntries(blobRoot)) {
            const relativePath = `blobs/${name}`;
            if (!retainedBlobs.has(relativePath)) await rm(join(blobRoot, name), { force: true });
        }
        const stagingRoot = join(root, 'staging');
        for (const name of await directoryEntries(stagingRoot)) {
            await rm(join(stagingRoot, name), { force: true });
        }
        await fsyncDirectory(root);
        await fsyncDirectory(blobRoot).catch(() => undefined);
        await fsyncDirectory(stagingRoot).catch(() => undefined);
        return expired.map((record) => record.artifactId);
    }

    private async reserve(projectId: string): Promise<QuotaReservation> {
        return this.withQuotaLock(async () => {
            const projectRecords = await this.store.readNamespace<ArtifactRecord>(
                projectId,
                'artifacts',
            );
            const projectIds = await this.store.listProjectIds();
            const allRecords = (await Promise.all(projectIds.map((id) => (
                id === projectId
                    ? projectRecords
                    : this.store.readNamespace<ArtifactRecord>(id, 'artifacts')
            )))).flat();
            // Expiry controls visibility, not disk accounting. Records continue to consume
            // persistent quota until cleanup durably removes metadata and unowned blobs.
            const currentProject = projectRecords;
            const projectBytes = sumBytes(currentProject);
            const globalBytes = sumBytes(allRecords);
            if (
                this.reservedGlobalCount >= this.quotas.maximumConcurrentArtifacts
                ||
                currentProject.length + (this.reservedSessionCount.get(projectId) ?? 0) + 1
                    > this.quotas.maximumSessionCount
                || allRecords.length + this.reservedGlobalCount + 1
                    > this.quotas.maximumGlobalCount
            ) {
                throw managedError(
                    'PAYLOAD_TOO_LARGE',
                    'The managed artifact count quota was reached.',
                );
            }
            this.reservedGlobalCount += 1;
            this.reservedSessionCount.set(
                projectId,
                (this.reservedSessionCount.get(projectId) ?? 0) + 1,
            );
            let bytes = 0;
            let released = false;
            return {
                addBytes: (amount) => {
                    if (!Number.isSafeInteger(amount) || amount < 0) {
                        throw managedError('PAYLOAD_TOO_LARGE', 'The artifact byte count is invalid.');
                    }
                    const next = bytes + amount;
                    if (
                        !Number.isSafeInteger(next)
                        || next > this.quotas.maximumArtifactBytes
                        || projectBytes
                            + (this.reservedSessionBytes.get(projectId) ?? 0)
                            + amount
                            > this.quotas.maximumSessionBytes
                        || globalBytes + this.reservedGlobalBytes + amount
                            > this.quotas.maximumGlobalBytes
                    ) {
                        throw managedError(
                            'PAYLOAD_TOO_LARGE',
                            'The managed artifact byte quota was reached.',
                        );
                    }
                    bytes = next;
                    this.reservedGlobalBytes += amount;
                    this.reservedSessionBytes.set(
                        projectId,
                        (this.reservedSessionBytes.get(projectId) ?? 0) + amount,
                    );
                },
                release: () => {
                    if (released) return;
                    released = true;
                    this.reservedGlobalCount = Math.max(0, this.reservedGlobalCount - 1);
                    this.reservedGlobalBytes = Math.max(0, this.reservedGlobalBytes - bytes);
                    updateMapCounter(this.reservedSessionCount, projectId, -1);
                    updateMapCounter(this.reservedSessionBytes, projectId, -bytes);
                },
            };
        });
    }

    private async withQuotaLock<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.quotaQueue;
        let release!: () => void;
        this.quotaQueue = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }

    private retainStagedBlob(path: string): void {
        this.stagedBlobOwners.set(path, (this.stagedBlobOwners.get(path) ?? 0) + 1);
    }

    private releaseStagedBlob(path: string): void {
        updateMapCounter(this.stagedBlobOwners, path, -1);
    }

    private async releaseStagedBlobAndMaybeDelete(
        path: string,
        blobRoot: string,
        durablyOwned: boolean,
    ): Promise<void> {
        const previous = this.blobOwnershipQueue;
        let unlock!: () => void;
        this.blobOwnershipQueue = new Promise<void>((resolve) => {
            unlock = resolve;
        });
        await previous;
        try {
            this.releaseStagedBlob(path);
            if (!durablyOwned && !this.stagedBlobOwners.has(path)) {
                await rm(path, { force: true });
                await fsyncDirectory(blobRoot);
            }
        } finally {
            unlock();
        }
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

async function nextWithDeadline<T>(
    iterator: AsyncIterator<T>,
    signal: AbortSignal | undefined,
    deadlineAt: number,
): Promise<IteratorResult<T>> {
    assertNotCancelled(signal, deadlineAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
        const cancellation = new Promise<never>((_resolve, reject) => {
            const remaining = Math.max(1, deadlineAt - Date.now());
            timer = setTimeout(() => reject(managedError(
                'COORDINATOR_UNAVAILABLE',
                'Artifact streaming timed out.',
                true,
            )), remaining);
            timer.unref?.();
            abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            signal?.addEventListener('abort', abort, { once: true });
        });
        return await Promise.race([iterator.next(), cancellation]);
    } finally {
        if (timer) clearTimeout(timer);
        if (abort) signal?.removeEventListener('abort', abort);
    }
}

function assertNotCancelled(signal: AbortSignal | undefined, deadlineAt: number): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (Date.now() >= deadlineAt) {
        throw managedError('COORDINATOR_UNAVAILABLE', 'Artifact streaming timed out.', true);
    }
}

function validateQuotaPolicy(policy: ArtifactQuotaPolicy): void {
    for (const [name, value] of Object.entries(policy)) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw managedError('INVALID_REQUEST', `The artifact ${name} quota is invalid.`);
        }
    }
    if (
        policy.maximumArtifactBytes > policy.maximumSessionBytes
        || policy.maximumSessionBytes > policy.maximumGlobalBytes
        || policy.maximumSessionCount > policy.maximumGlobalCount
        || policy.maximumConcurrentArtifacts > policy.maximumGlobalCount
    ) {
        throw managedError('INVALID_REQUEST', 'The artifact quota hierarchy is invalid.');
    }
}

function validateExpiry(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const timestamp = Date.parse(value);
    if (
        value.length > 64
        || !Number.isFinite(timestamp)
        || timestamp <= Date.now()
    ) {
        throw managedError('INVALID_REQUEST', 'The artifact expiry is invalid.');
    }
    return value;
}

function validateSourceIds(values: readonly string[]): readonly string[] {
    if (values.length > 1_000) {
        throw managedError('PAYLOAD_TOO_LARGE', 'The artifact source list is oversized.');
    }
    return values.map((value) => {
        const bounded = boundedText(value);
        return bounded;
    });
}

function sumBytes(records: readonly ArtifactRecord[]): number {
    return records.reduce((total, record) => {
        if (!Number.isSafeInteger(record.byteLength) || record.byteLength < 0) {
            throw new Error('Managed artifact metadata contains an invalid byte count.');
        }
        const next = total + record.byteLength;
        if (!Number.isSafeInteger(next)) {
            throw new Error('Managed artifact quota accounting overflowed.');
        }
        return next;
    }, 0);
}

function updateMapCounter(map: Map<string, number>, key: string, delta: number): void {
    const next = Math.max(0, (map.get(key) ?? 0) + delta);
    if (next === 0) map.delete(key);
    else map.set(key, next);
}

async function directoryEntries(path: string): Promise<string[]> {
    try {
        return await readdir(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
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

async function writeAll(
    handle: Awaited<ReturnType<typeof open>>,
    chunk: Uint8Array,
): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(
            chunk,
            offset,
            chunk.byteLength - offset,
        );
        if (bytesWritten <= 0) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The artifact staging write made no progress.',
            );
        }
        offset += bytesWritten;
    }
}
