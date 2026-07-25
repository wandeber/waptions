import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { MediaBudgetManager } from '../../src/lib/media-byte-source/budget-manager';
import type { FilesystemStatToken } from '../../src/lib/media-byte-source/filesystem-source';
import {
    freezeMediaIdentity,
    throwIfAborted,
    type CoreMediaIdentity,
} from '../../src/lib/media-byte-source/types';
import { BoundedConcurrency } from './concurrency';
import {
    DEFAULT_MEDIA_CANDIDATES,
    MANAGED_MEDIA_HASH_CHUNK_BYTES,
    MAX_MEDIA_CANDIDATES,
    type ManagedMediaDescriptor,
    type ManagedSourceRegistryPort,
    type MediaCandidate,
    type MediaProbePort,
    type ProbedMediaMetadata,
    type VerifiedMediaAccessPort,
    type VerifiedOpenMediaHandle,
} from './contracts';
import { sortMediaCandidatesNaturally } from './natural-sort';

export interface ProbedMediaCandidate {
    readonly candidateId: string;
    readonly displayName: string;
    readonly identity: CoreMediaIdentity;
    readonly metadata: ProbedMediaMetadata;
}

export interface ProbeImportRequest {
    readonly grantId: string;
    readonly directory?: string;
    readonly maximumCandidates?: number;
    readonly maximumResults?: number;
    readonly requireVideo?: boolean;
    readonly signal?: AbortSignal;
}

export interface ProbeImportDiagnostics {
    readonly probed: number;
    readonly imported: number;
    readonly skippedUnsupported: number;
    readonly hashBytes: number;
    readonly cleanupFailures: number;
    readonly failedOwnedHandles: number;
    readonly probeConcurrency: ReturnType<BoundedConcurrency['snapshot']>;
}

interface PreparedManagedImport {
    readonly handle: VerifiedOpenMediaHandle;
    readonly identity: CoreMediaIdentity;
    readonly metadata: ProbedMediaMetadata;
}

export class MediaProbeImportService {
    private probed = 0;
    private imported = 0;
    private skippedUnsupported = 0;
    private hashBytes = 0;
    private cleanupFailures = 0;
    private readonly failedHandleCleanup = new Map<FileHandle, unknown>();

    constructor(
        private readonly access: VerifiedMediaAccessPort,
        private readonly probePort: MediaProbePort,
        private readonly sourceRegistry: ManagedSourceRegistryPort,
        private readonly compressedBudget: MediaBudgetManager,
        /** Process-wide limiter shared with review jobs. */
        private readonly probes: BoundedConcurrency,
    ) {}

    async probe(request: ProbeImportRequest): Promise<readonly ProbedMediaCandidate[]> {
        return this.processCandidates(request, false) as Promise<readonly ProbedMediaCandidate[]>;
    }

    async import(request: ProbeImportRequest): Promise<readonly ManagedMediaDescriptor[]> {
        return this.processCandidates(request, true) as Promise<readonly ManagedMediaDescriptor[]>;
    }

    diagnostics(): ProbeImportDiagnostics {
        return Object.freeze({
            probed: this.probed,
            imported: this.imported,
            skippedUnsupported: this.skippedUnsupported,
            hashBytes: this.hashBytes,
            cleanupFailures: this.cleanupFailures,
            failedOwnedHandles: this.failedHandleCleanup.size,
            probeConcurrency: this.probes.snapshot(),
        });
    }

    assertDrained(): void {
        const diagnostics = this.diagnostics();
        if (
            diagnostics.failedOwnedHandles !== 0
            || diagnostics.probeConcurrency.active !== 0
            || diagnostics.probeConcurrency.queued !== 0
        ) {
            throw new Error(`Media probe/import service leaked resources: ${JSON.stringify(diagnostics)}`);
        }
    }

    async close(): Promise<void> {
        const failures = Array.from(this.failedHandleCleanup.values());
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                'The media probe/import service retained handles whose cleanup failed.',
            );
        }
        this.assertDrained();
    }

    private async processCandidates(
        request: ProbeImportRequest,
        shouldImport: boolean,
    ): Promise<readonly (ProbedMediaCandidate | ManagedMediaDescriptor)[]> {
        const maximumCandidates = clampCount(
            request.maximumCandidates ?? DEFAULT_MEDIA_CANDIDATES,
            MAX_MEDIA_CANDIDATES,
        );
        const maximumResults = clampCount(
            request.maximumResults ?? maximumCandidates,
            maximumCandidates,
        );
        throwIfAborted(request.signal);
        const listed = await this.access.listCandidates({
            grantId: request.grantId,
            directory: request.directory,
            maximumCandidates,
            signal: request.signal,
        });
        if (listed.length > maximumCandidates) {
            throw new Error('The media access port exceeded the requested candidate bound.');
        }
        const candidates = sortMediaCandidatesNaturally(listed);
        const results: Array<ProbedMediaCandidate | PreparedManagedImport> = [];
        let offset = 0;
        while (offset < candidates.length && results.length < maximumResults) {
            const batchSize = Math.min(
                this.probes.maximum,
                maximumResults - results.length,
            );
            const batch = candidates.slice(offset, offset + batchSize);
            offset += batch.length;
            const settled = await Promise.allSettled(batch.map((candidate) => (
                this.probes.run(
                    () => this.processCandidate(candidate, request, shouldImport),
                    request.signal,
                )
            )));
            for (const result of settled) {
                if (result.status === 'fulfilled' && result.value) results.push(result.value);
            }
            const failure = settled.find((result) => result.status === 'rejected');
            if (failure?.status === 'rejected') {
                for (const cleanup of await closePreparedImports(results)) {
                    this.recordFailedHandle(cleanup.handle, cleanup.error);
                }
                throw failure.reason;
            }
        }
        if (!shouldImport) {
            return Object.freeze(results as ProbedMediaCandidate[]);
        }
        const prepared = results as PreparedManagedImport[];
        const descriptors = await this.sourceRegistry.registerBatch(prepared);
        this.imported += descriptors.length;
        return descriptors;
    }

    private async processCandidate(
        candidate: MediaCandidate,
        request: ProbeImportRequest,
        shouldImport: boolean,
    ): Promise<ProbedMediaCandidate | PreparedManagedImport | null> {
        throwIfAborted(request.signal);
        const opened = await this.access.openCandidate({
            grantId: request.grantId,
            candidateId: candidate.candidateId,
            signal: request.signal,
        });
        let ownershipTransferred = false;
        let operationFailed = false;
        try {
            assertCapabilityMatches(opened, candidate, request.grantId);
            const identity = await hashVerifiedHandle(
                opened,
                this.compressedBudget,
                request.signal,
            );
            this.hashBytes += identity.sizeBytes;
            const metadata = freezeMetadata(await this.probePort.probe(opened, request.signal));
            await assertVerifiedHandleCurrent(opened);
            this.probed++;
            if (!metadata.video && !metadata.audio) {
                this.skippedUnsupported++;
                return null;
            }
            if ((request.requireVideo ?? true) && !metadata.video) {
                this.skippedUnsupported++;
                return null;
            }
            if (!shouldImport) {
                return Object.freeze({
                    candidateId: candidate.candidateId,
                    displayName: candidate.displayName,
                    identity,
                    metadata,
                });
            }
            ownershipTransferred = true;
            return Object.freeze({ handle: opened, identity, metadata });
        } catch (error) {
            operationFailed = true;
            throw error;
        } finally {
            if (!ownershipTransferred) {
                try {
                    await opened.handle.close();
                } catch (closeError) {
                    this.recordFailedHandle(opened.handle, closeError);
                    if (!operationFailed) throw closeError;
                }
            }
        }
    }

    private recordFailedHandle(handle: FileHandle, error: unknown): void {
        if (this.failedHandleCleanup.has(handle)) return;
        this.failedHandleCleanup.set(handle, error);
        this.cleanupFailures++;
    }
}

export async function hashVerifiedHandle(
    capability: VerifiedOpenMediaHandle,
    budget: MediaBudgetManager,
    signal?: AbortSignal,
): Promise<CoreMediaIdentity> {
    const before = await statToken(capability.handle);
    if (!tokensEqual(before, capability.statToken) || Number(before.size) !== capability.sizeBytes) {
        throw sourceChanged('The verified media handle changed before hashing.');
    }
    const bufferBytes = Math.min(
        MANAGED_MEDIA_HASH_CHUNK_BYTES,
        Math.max(1, capability.sizeBytes),
    );
    const reservation = await budget.reserve(bufferBytes, {
        label: `managed-hash:${capability.sourceId}`,
        signal,
    });
    const lease = reservation.commit();
    try {
        const buffer = new Uint8Array(bufferBytes);
        const hash = createHash('sha256');
        let position = 0;
        while (position < capability.sizeBytes) {
            throwIfAborted(signal);
            const requested = Math.min(buffer.byteLength, capability.sizeBytes - position);
            const { bytesRead } = await capability.handle.read(buffer, 0, requested, position);
            if (bytesRead === 0) throw sourceChanged('Media ended while computing its digest.');
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
        const after = await statToken(capability.handle);
        if (!tokensEqual(before, after)) {
            throw sourceChanged('The verified media handle changed while hashing.');
        }
        return freezeMediaIdentity({
            fingerprint: `sha256:${hash.digest('hex')}`,
            sizeBytes: capability.sizeBytes,
        });
    } finally {
        lease.release();
    }
}

function clampCount(value: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError('Media collection bounds must be positive safe integers.');
    }
    return Math.min(value, maximum);
}

function assertCapabilityMatches(
    opened: VerifiedOpenMediaHandle,
    candidate: MediaCandidate,
    grantId: string,
): void {
    if (
        opened.grantId !== grantId
        || opened.candidateId !== candidate.candidateId
        || opened.displayName !== candidate.displayName
    ) {
        throw new Error('The verified media capability does not match the granted candidate.');
    }
}

async function statToken(handle: FileHandle): Promise<FilesystemStatToken> {
    const value = await handle.stat({ bigint: true });
    if (!value.isFile()) throw sourceChanged('The verified media handle is no longer a regular file.');
    return {
        dev: String(value.dev),
        ino: String(value.ino),
        size: String(value.size),
        mtimeNs: String(value.mtimeNs),
        ctimeNs: String(value.ctimeNs),
    };
}

async function assertVerifiedHandleCurrent(capability: VerifiedOpenMediaHandle): Promise<void> {
    const current = await statToken(capability.handle);
    if (!tokensEqual(current, capability.statToken)) {
        throw sourceChanged('The verified media handle changed while probing.');
    }
}

function tokensEqual(left: FilesystemStatToken, right: FilesystemStatToken): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}

function sourceChanged(message: string): Error {
    const error = new Error(message);
    error.name = 'SourceChangedError';
    return error;
}

function freezeMetadata(metadata: ProbedMediaMetadata): ProbedMediaMetadata {
    return Object.freeze({
        ...metadata,
        video: metadata.video ? Object.freeze({ ...metadata.video }) : null,
        audio: metadata.audio ? Object.freeze({ ...metadata.audio }) : null,
    });
}

async function closePreparedImports(
    results: readonly (ProbedMediaCandidate | PreparedManagedImport)[],
): Promise<readonly { handle: FileHandle; error: unknown }[]> {
    const handles = results
        .filter((result): result is PreparedManagedImport => 'handle' in result)
        .map((result) => result.handle.handle);
    const settled = await Promise.allSettled(handles.map((handle) => handle.close()));
    return Object.freeze(settled.flatMap((result, index) => (
        result.status === 'rejected' && handles[index]
            ? [{ handle: handles[index], error: result.reason }]
            : []
    )));
}
