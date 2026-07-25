import { createHash, createHmac, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
    link,
    lstat,
    open,
    readdir,
    realpath,
    rename,
    rm,
    type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { managedError } from '../coordinator/errors';
import type { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics';
import type { DurableWrite } from '../persistence/managed-filesystem-store';
import {
    atomicWriteJson,
    ensurePrivateDirectory,
    fsyncDirectory,
    readJsonFile,
} from '../persistence/fs-durable';
import { canonicalJson, constantTimeStringEqual } from '../persistence/canonical-json';

export type PathGrantKind = 'read-root' | 'create-only-destination' | 'exact-overwrite';

export interface FileIdentity {
    device: string;
    inode: string;
    size: number;
    modifiedMilliseconds: number;
}

export interface SessionPathGrantRecord {
    schemaVersion: 2;
    grantId: string;
    sessionId: string;
    sessionEpoch: string;
    kind: PathGrantKind;
    canonicalPath: string;
    createdAt: string;
    revokedAt?: string;
    identity?: FileIdentity;
    rootIdentity?: Pick<FileIdentity, 'device' | 'inode'>;
    parentIdentity?: Pick<FileIdentity, 'device' | 'inode'>;
    sourceDigest?: string;
    authorityMac: string;
}

export interface PathGrantScope {
    sessionId: string;
    sessionEpoch: string;
}

export interface VerifiedReadHandle {
    capabilityType: 'verified-read-handle';
    grantId: string;
    handle: FileHandle;
    identity: FileIdentity;
    digest: string;
    verifyUnchanged(): Promise<void>;
    close(): Promise<void>;
}

export interface StagedDestination {
    capabilityType: 'validated-staged-destination';
    grantId: string;
    handle: ManagedOutputStagingHandle;
    commit(options?: {
        signal?: AbortSignal;
        deadlineMilliseconds?: number;
    }): Promise<StagedOutputPublication>;
    abort(): Promise<void>;
}

export interface OutputPublicationRecord {
    schemaVersion: 1;
    publicationId: string;
    grantId: string;
    sessionId: string;
    byteLength: number;
    digest: string;
    createdAt: string;
}

export interface StagedOutputPublication {
    record: OutputPublicationRecord;
    registryWrite: DurableWrite;
    accept(): Promise<void>;
    reject(): Promise<void>;
}

export interface ManagedOutputStagingHandle {
    writeFile(data: string | Uint8Array): Promise<void>;
    write(data: Uint8Array, position: number): Promise<{ bytesWritten: number }>;
    read(
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
    ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
    stat(): Promise<{ byteLength: number; device: string; inode: string }>;
    hash(options?: {
        signal?: AbortSignal;
        deadlineMilliseconds?: number;
    }): Promise<{ digest: string; bytes: number }>;
    sync(): Promise<void>;
    /**
     * The coordinator may pass its private path to a trusted read-only inspector such as ffprobe.
     * The path must never cross MCP, event, receipt, or UI boundaries.
     */
    inspect<T>(
        operation: (privatePath: string, signal: AbortSignal) => Promise<T>,
        options?: { signal?: AbortSignal; deadlineMilliseconds?: number },
    ): Promise<T>;
}

interface BoundPath {
    canonicalPath: string;
    handle: FileHandle;
    metadata: Awaited<ReturnType<FileHandle['stat']>>;
}

interface MaterializedSource {
    path: string;
    digest: string;
    byteLength: number;
}

interface OutputPublicationJournal extends OutputPublicationRecord {
    state: 'prepared' | 'published';
    targetPath: string;
    privatePath: string;
    parentIdentity: Pick<FileIdentity, 'device' | 'inode'>;
    finalIdentity: FileIdentity;
}

export interface PathGrantAuthorityOptions {
    privateCopyRoot: string;
    authoritySecret: Uint8Array;
    diagnostics?: RuntimeDiagnostics;
    sourceCopyQuotas?: SourceCopyQuotaPolicy;
    renderStagingQuotas?: RenderStagingQuotaPolicy;
}

export interface SourceCopyQuotaPolicy {
    maximumSourceBytes: number;
    maximumSessionBytes: number;
    maximumSessionCount: number;
    maximumGlobalBytes: number;
    maximumGlobalCount: number;
    maximumConcurrentCopies: number;
}

export interface RenderStagingQuotaPolicy {
    maximumOutputBytes: number;
    maximumSessionBytes: number;
    maximumSessionCount: number;
    maximumGlobalBytes: number;
    maximumGlobalCount: number;
    maximumConcurrentStages: number;
    maximumLifetimeMilliseconds: number;
}

const DEFAULT_SOURCE_COPY_QUOTAS: SourceCopyQuotaPolicy = {
    maximumSourceBytes: 64 * 1024 * 1024 * 1024,
    maximumSessionBytes: 256 * 1024 * 1024 * 1024,
    maximumSessionCount: 2_048,
    maximumGlobalBytes: 1024 * 1024 * 1024 * 1024,
    maximumGlobalCount: 8_192,
    maximumConcurrentCopies: 2,
};

const DEFAULT_RENDER_STAGING_QUOTAS: RenderStagingQuotaPolicy = {
    maximumOutputBytes: 64 * 1024 * 1024 * 1024,
    maximumSessionBytes: 128 * 1024 * 1024 * 1024,
    maximumSessionCount: 8,
    maximumGlobalBytes: 256 * 1024 * 1024 * 1024,
    maximumGlobalCount: 32,
    maximumConcurrentStages: 2,
    maximumLifetimeMilliseconds: 6 * 60 * 60 * 1000,
};

interface SourceCopyReservation {
    growTo(byteLength: number): Promise<void>;
    release(): void;
}

/**
 * Process-local authority for durable opaque grant identifiers.
 *
 * Callers never present grant records back to this class. Records are issuer-owned state; media
 * consumers resolve only an opaque identifier under the current session and coordinator epoch.
 */
export class PathGrantAuthority {
    private readonly grants = new Map<string, SessionPathGrantRecord>();
    private readonly materialized = new Map<string, MaterializedSource>();
    private readonly sourceCopyQuotas: SourceCopyQuotaPolicy;
    private readonly renderStagingQuotas: RenderStagingQuotaPolicy;
    private activeSourceBytes = 0;
    private activeSourceCount = 0;
    private readonly activeSessionBytes = new Map<string, number>();
    private readonly activeSessionCount = new Map<string, number>();
    private sourceQuotaQueue = Promise.resolve();
    private renderQuotaQueue = Promise.resolve();
    private readonly activeRenderStages = new Map<
        string,
        { sessionKey: string; byteLength: number }
    >();

    constructor(private readonly options: PathGrantAuthorityOptions) {
        this.sourceCopyQuotas = options.sourceCopyQuotas ?? DEFAULT_SOURCE_COPY_QUOTAS;
        this.renderStagingQuotas = options.renderStagingQuotas
            ?? DEFAULT_RENDER_STAGING_QUOTAS;
        validateSourceCopyQuotaPolicy(this.sourceCopyQuotas);
        validateRenderStagingQuotaPolicy(this.renderStagingQuotas);
    }

    register(record: SessionPathGrantRecord): void {
        this.validateRestorable(record);
        if (this.grants.has(record.grantId)) {
            throw managedError('INVALID_REQUEST', 'The managed path grant identifier is duplicated.');
        }
        this.grants.set(record.grantId, structuredClone(record));
    }

    validateRestorable(record: unknown): asserts record is SessionPathGrantRecord {
        validateGrantRecord(record);
        if (!constantTimeStringEqual(record.authorityMac, this.mac(record))) {
            throw managedError('PATH_NOT_GRANTED', 'The managed path grant issuer is invalid.');
        }
    }

    hasRegisteredGrant(grantId: string): boolean {
        return this.grants.has(grantId);
    }

    async create(
        sessionId: string,
        sessionEpoch: string,
        kind: PathGrantKind,
        requestedPath: string,
        overwriteConfirmed = false,
    ): Promise<SessionPathGrantRecord> {
        void overwriteConfirmed;
        validateScope({ sessionId, sessionEpoch });
        validateAbsolutePath(requestedPath);
        if (kind === 'exact-overwrite') {
            // Node does not expose descriptor-relative renameat2/linkat on macOS. A path-based
            // replacement cannot preserve an exact-file capability across the final syscall.
            throw managedError(
                'OVERWRITE_NOT_AUTHORIZED',
                'Exact overwrite is disabled because this platform cannot publish it race-safely.',
            );
        }

        let canonicalPath: string;
        let identity: FileIdentity | undefined;
        let rootIdentity: Pick<FileIdentity, 'device' | 'inode'> | undefined;
        let parentIdentity: Pick<FileIdentity, 'device' | 'inode'> | undefined;
        let sourceDigest: string | undefined;

        if (kind === 'read-root') {
            const bound = await openBoundPath(requestedPath, true);
            try {
                canonicalPath = bound.canonicalPath;
                rootIdentity = identityPair(bound.metadata);
                if (bound.metadata.isFile()) {
                    validateRegularFile(bound.metadata);
                    identity = fileIdentity(bound.metadata);
                    if (identity.size > this.sourceCopyQuotas.maximumSourceBytes) {
                        throw managedError(
                            'PAYLOAD_TOO_LARGE',
                            'The managed source exceeds its byte quota.',
                        );
                    }
                    sourceDigest = (await digestHandle(
                        bound.handle,
                        undefined,
                        deadlineFrom(undefined, 5 * 60 * 1000),
                    )).digest;
                    await validateBoundPath(bound);
                }
            } finally {
                await bound.handle.close();
            }
        } else {
            const requestedParent = dirname(requestedPath);
            const parent = await openBoundDirectory(requestedParent);
            try {
                canonicalPath = join(parent.canonicalPath, basename(requestedPath));
                parentIdentity = identityPair(parent.metadata);
                if (await lstatOrNull(canonicalPath)) {
                    throw managedError(
                        'WRITE_DESTINATION_NOT_GRANTED',
                        'Create-only destinations must not already exist.',
                    );
                }
                await validateBoundPath(parent);
            } finally {
                await parent.handle.close();
            }
        }

        const unsigned = {
            schemaVersion: 2 as const,
            grantId: randomUUID(),
            sessionId,
            sessionEpoch,
            kind,
            canonicalPath,
            createdAt: new Date().toISOString(),
            ...(identity ? { identity } : {}),
            ...(rootIdentity ? { rootIdentity } : {}),
            ...(parentIdentity ? { parentIdentity } : {}),
            ...(sourceDigest ? { sourceDigest } : {}),
        };
        const record: SessionPathGrantRecord = {
            ...unsigned,
            authorityMac: this.mac(unsigned),
        };
        this.grants.set(record.grantId, record);
        return structuredClone(record);
    }

    revoke(grantId: string, scope: PathGrantScope): SessionPathGrantRecord {
        const grant = this.resolve(grantId, scope);
        const revoked = grant.revokedAt
            ? grant
            : withGrantMac(
                { ...grant, revokedAt: new Date().toISOString() },
                this.options.authoritySecret,
            );
        this.grants.set(grantId, revoked);
        return structuredClone(revoked);
    }

    async releaseSourceCopies(sessionId: string, digests: readonly string[]): Promise<void> {
        const sessionRoot = sourceCopySessionRoot(this.options.privateCopyRoot, sessionId);
        const paths = new Set<string>();
        for (const digest of digests) {
            if (!/^sha256:[a-f0-9]{64}$/.test(digest)) continue;
            paths.add(join(sessionRoot, `${digest.slice(7)}.source`));
        }
        for (const path of Array.from(paths)) await rm(path, { force: true });
        for (const [cacheKey, materialized] of Array.from(this.materialized.entries())) {
            if (paths.has(materialized.path)) this.materialized.delete(cacheKey);
        }
        await fsyncDirectory(sessionRoot).catch(() => undefined);
    }

    async openRetainedSource(
        sessionId: string,
        sourceId: string,
        digest: string,
        expectedBytes: number,
    ): Promise<VerifiedReadHandle> {
        if (
            !sessionId
            || !sourceId
            || sourceId.length > 200
            || !/^sha256:[a-f0-9]{64}$/.test(digest)
            || !Number.isSafeInteger(expectedBytes)
            || expectedBytes < 0
        ) {
            throw managedError('INVALID_REQUEST', 'The retained source identity is invalid.');
        }
        const path = join(
            sourceCopySessionRoot(this.options.privateCopyRoot, sessionId),
            `${digest.slice(7)}.source`,
        );
        const handle = await openNoFollow(
            path,
            constants.O_RDONLY | constants.O_NONBLOCK,
        );
        try {
            const metadata = await handle.stat({ bigint: true });
            validateRegularFile(metadata);
            const identity = fileIdentity(metadata);
            if (identity.size !== expectedBytes) {
                throw managedError('SOURCE_CHANGED', 'The retained source length changed.');
            }
            const verified = await digestHandle(
                handle,
                undefined,
                deadlineFrom(undefined, 5 * 60 * 1000),
            );
            if (verified.digest !== digest || verified.bytes !== expectedBytes) {
                throw managedError('SOURCE_CHANGED', 'The retained source digest changed.');
            }
            return {
                capabilityType: 'verified-read-handle',
                grantId: `retained:${sourceId}`,
                handle,
                identity,
                digest,
                verifyUnchanged: async () => {
                    const current = await handle.stat({ bigint: true });
                    validateRegularFile(current);
                    validateStoredIdentity(identity, fileIdentity(current));
                },
                close: () => handle.close(),
            };
        } catch (error) {
            await handle.close().catch(() => undefined);
            throw error;
        }
    }

    async cleanupSourceCopies(
        retained: readonly { sessionId: string; digests: readonly string[] }[],
    ): Promise<void> {
        await ensurePrivateDirectory(this.options.privateCopyRoot);
        const retainedBySession = new Map<string, Set<string>>();
        for (const entry of retained) {
            const key = sourceCopySessionKey(entry.sessionId);
            const digests = retainedBySession.get(key) ?? new Set<string>();
            for (const digest of entry.digests) {
                if (/^sha256:[a-f0-9]{64}$/.test(digest)) digests.add(digest.slice(7));
            }
            retainedBySession.set(key, digests);
        }
        for (const entry of await readdir(this.options.privateCopyRoot, { withFileTypes: true })) {
            const path = join(this.options.privateCopyRoot, entry.name);
            if (entry.name === 'output-staging') {
                if (!entry.isDirectory()) {
                    await rm(path, { recursive: true, force: true });
                    continue;
                }
                for (const name of await readdir(path)) {
                    await rm(join(path, name), { recursive: true, force: true });
                }
                await fsyncDirectory(path).catch(() => undefined);
                continue;
            }
            if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) {
                await rm(path, { recursive: true, force: true });
                continue;
            }
            const retainedDigests = retainedBySession.get(entry.name) ?? new Set<string>();
            for (const name of await readdir(path)) {
                const match = /^([a-f0-9]{64})\.source$/.exec(name);
                if (!match || !retainedDigests.has(match[1])) {
                    await rm(join(path, name), { recursive: true, force: true });
                }
            }
            await fsyncDirectory(path).catch(() => undefined);
        }
        for (const [cacheKey, materialized] of Array.from(this.materialized.entries())) {
            if (!await lstatOrNull(materialized.path)) this.materialized.delete(cacheKey);
        }
        await fsyncDirectory(this.options.privateCopyRoot).catch(() => undefined);
    }

    async openRead(
        grantId: string,
        scope: PathGrantScope,
        requestedPath: string,
        options: { signal?: AbortSignal; deadlineMilliseconds?: number } = {},
    ): Promise<VerifiedReadHandle> {
        const grant = this.resolve(grantId, scope, 'read-root');
        validateAbsolutePath(requestedPath);
        await validateReadRootIdentity(grant);

        const cacheKey = `${grant.grantId}\0${requestedPath}`;
        let materialized = this.materialized.get(cacheKey);
        try {
            if (!materialized) {
                // Do not share an in-flight operation across callers: one caller's deadline or
                // AbortSignal must never cancel or extend another caller's authority request.
                materialized = await this.materializeSource(grant, requestedPath, options);
                this.materialized.set(cacheKey, materialized);
            }
        } catch (error) {
            if (options.signal?.aborted || (error as { name?: string }).name === 'AbortError') {
                this.options.diagnostics?.record('abortedOperations');
            } else if ((error as { code?: string }).code === 'COORDINATOR_UNAVAILABLE') {
                this.options.diagnostics?.record('deadlineExceeded');
            } else if ((error as { code?: string }).code === 'PAYLOAD_TOO_LARGE') {
                this.options.diagnostics?.record('limitRejections');
            }
            throw error;
        }
        this.resolve(grantId, scope, 'read-root');

        const handle = await openNoFollow(
            materialized.path,
            constants.O_RDONLY | constants.O_NONBLOCK,
        );
        try {
            const metadata = await handle.stat({ bigint: true });
            validateRegularFile(metadata);
            if (toSafeNumber(metadata.size, 'file size') !== materialized.byteLength) {
                throw managedError('SOURCE_CHANGED', 'The immutable source copy is corrupt.');
            }
            const identity = fileIdentity(metadata);
            return {
                capabilityType: 'verified-read-handle',
                grantId,
                handle,
                identity,
                digest: materialized.digest,
                verifyUnchanged: async () => {
                    this.resolve(grantId, scope, 'read-root');
                    const descriptor = await handle.stat({ bigint: true });
                    validateRegularFile(descriptor);
                    validateStoredIdentity(identity, fileIdentity(descriptor));
                },
                close: () => handle.close(),
            };
        } catch (error) {
            await handle.close().catch(() => undefined);
            throw error;
        }
    }

    async stageCreate(grantId: string, scope: PathGrantScope): Promise<StagedDestination> {
        const grant = this.resolve(grantId, scope, 'create-only-destination');
        if (!grant.parentIdentity) {
            throw managedError('PATH_IDENTITY_CHANGED', 'The destination grant has no parent identity.');
        }
        const targetPath = grant.canonicalPath;
        let parentDevice: string;
        // Validate the authority now, but keep all render/inspect bytes in the private namespace.
        // The final destination is not opened until terminal publication.
        const initialParent = await openBoundDirectory(dirname(targetPath));
        try {
            validateIdentityPair(grant.parentIdentity, identityPair(initialParent.metadata));
            if (join(initialParent.canonicalPath, basename(targetPath)) !== targetPath) {
                throw managedError('PATH_IDENTITY_CHANGED', 'The destination parent changed after granting.');
            }
            if (await lstatOrNull(targetPath)) {
                throw managedError(
                    'WRITE_DESTINATION_NOT_GRANTED',
                    'The create-only destination is no longer absent.',
                );
            }
            parentDevice = initialParent.metadata.dev.toString();
            await validateBoundPath(initialParent);
        } finally {
            await initialParent.handle.close().catch(() => undefined);
        }

        const stagingRoot = join(this.options.privateCopyRoot, 'output-staging');
        const stagingSessionRoot = join(stagingRoot, sourceCopySessionKey(grant.sessionId));
        const { privatePath, stagingHandle, stagingIdentity } = await this.createRenderStage(
            stagingRoot,
            stagingSessionRoot,
        );
        if (stagingIdentity.device !== parentDevice) {
            await stagingHandle.close().catch(() => undefined);
            await removeIfIdentityMatches(privatePath, stagingIdentity).catch(() => undefined);
            this.releaseRenderStage(privatePath);
            throw managedError(
                'WRITE_DESTINATION_NOT_GRANTED',
                'Atomic create-only publication requires private staging on the destination filesystem.',
            );
        }
        let lifecycle: 'open' | 'committing' | 'settled' = 'open';
        let lifecycleQueue = Promise.resolve();
        const withLifecycle = async <T>(operation: () => Promise<T>): Promise<T> => {
            const previous = lifecycleQueue;
            let unlock!: () => void;
            lifecycleQueue = new Promise<void>((resolve) => {
                unlock = resolve;
            });
            await previous;
            try {
                return await operation();
            } finally {
                unlock();
            }
        };
        const lifetimeTimer = setTimeout(() => {
            this.options.diagnostics?.record('deadlineExceeded');
            void abort().catch(() => undefined);
        }, this.renderStagingQuotas.maximumLifetimeMilliseconds);
        lifetimeTimer.unref?.();
        const cleanupStage = async () => {
            if (lifecycle === 'settled') return;
            lifecycle = 'settled';
            clearTimeout(lifetimeTimer);
            await stagingHandle.close().catch(() => undefined);
            await removeIfIdentityMatches(privatePath, stagingIdentity).catch(() => undefined);
            await fsyncDirectory(stagingSessionRoot).catch(() => undefined);
            this.releaseRenderStage(privatePath);
        };
        const abort = () => withLifecycle(cleanupStage);
        const commit = async (
            options: { signal?: AbortSignal; deadlineMilliseconds?: number } = {},
        ) => withLifecycle(async () => {
            if (lifecycle !== 'open') {
                throw managedError('PATH_NOT_GRANTED', 'The render staging handle is closed.');
            }
            lifecycle = 'committing';
            const deadline = deadlineFrom(options.deadlineMilliseconds, 30 * 60 * 1000);
            let parent: BoundPath | undefined;
            let publishedIdentity: FileIdentity | undefined;
            let publicationJournalPath: string | undefined;
            try {
                this.resolve(grantId, scope, 'create-only-destination');
                assertNotCancelled(options.signal, deadline);
                await this.validateRenderStageSize(privatePath, stagingSessionRoot);
                await stagingHandle.sync();
                assertNotCancelled(options.signal, deadline);
                const stagedMetadata = await stagingHandle.stat({ bigint: true });
                validateRegularFile(stagedMetadata);
                if (
                    stagedMetadata.dev.toString() !== stagingIdentity.device
                    || stagedMetadata.ino.toString() !== stagingIdentity.inode
                ) {
                    throw managedError(
                        'PATH_IDENTITY_CHANGED',
                        'The private staging descriptor changed unexpectedly.',
                    );
                }
                const stagedSize = toSafeNumber(stagedMetadata.size, 'file size');
                await validateTargetIdentity(privatePath, stagedMetadata);
                const stagedDigest = await digestHandle(
                    stagingHandle,
                    options.signal,
                    deadline,
                );
                if (stagedDigest.bytes !== stagedSize) {
                    throw managedError(
                        'PATH_IDENTITY_CHANGED',
                        'The private render output changed before publication.',
                    );
                }
                const publicationId = createHash('sha256')
                    .update(`output-publication\0${grant.grantId}`)
                    .digest('hex');
                const publicationRoot = join(
                    this.options.privateCopyRoot,
                    'output-publications',
                );
                await ensurePrivateDirectory(publicationRoot);
                publicationJournalPath = join(publicationRoot, `${publicationId}.json`);
                const journal: OutputPublicationJournal = {
                    schemaVersion: 1,
                    publicationId,
                    grantId: grant.grantId,
                    sessionId: grant.sessionId,
                    byteLength: stagedSize,
                    digest: stagedDigest.digest,
                    createdAt: new Date().toISOString(),
                    state: 'prepared',
                    targetPath,
                    privatePath,
                    parentIdentity: grant.parentIdentity!,
                    finalIdentity: fileIdentity(stagedMetadata),
                };
                await atomicWriteJson(publicationJournalPath, journal, { mode: 0o600 });
                await fsyncDirectory(publicationRoot);

                parent = await openBoundDirectory(dirname(targetPath));
                validateIdentityPair(grant.parentIdentity!, identityPair(parent.metadata));
                if (join(parent.canonicalPath, basename(targetPath)) !== targetPath) {
                    throw managedError(
                        'PATH_IDENTITY_CHANGED',
                        'The destination parent changed before publication.',
                    );
                }
                if (await lstatOrNull(targetPath)) {
                    throw managedError(
                        'WRITE_DESTINATION_NOT_GRANTED',
                        'The create-only destination is no longer absent.',
                    );
                }
                await validateBoundPath(parent);
                assertNotCancelled(options.signal, deadline);

                try {
                    // Both names reference the already-synced private inode. `link` provides an
                    // atomic create-only publication: a crash exposes either no final target or
                    // the complete staged bytes, never a partially copied final file.
                    await link(privatePath, targetPath);
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code === 'EEXIST') {
                        throw managedError(
                            'WRITE_DESTINATION_NOT_GRANTED',
                            'The create-only destination is no longer absent.',
                        );
                    }
                    if (code === 'EXDEV') {
                        throw managedError(
                            'WRITE_DESTINATION_NOT_GRANTED',
                            'Atomic create-only publication requires one filesystem.',
                        );
                    }
                    throw error;
                }
                publishedIdentity = fileIdentity(stagedMetadata);
                await atomicWriteJson(
                    publicationJournalPath,
                    { ...journal, state: 'published' },
                    { mode: 0o600 },
                );
                await fsyncDirectory(publicationRoot);
                await validateTargetIdentity(targetPath, stagedMetadata);
                await validateBoundPath(parent);
                validateIdentityPair(grant.parentIdentity!, identityPair(parent.metadata));
                assertNotCancelled(options.signal, deadline);
                const publishedMetadata = await stagingHandle.stat({ bigint: true });
                validatePublishedFile(publishedMetadata);
                if (toSafeNumber(publishedMetadata.size, 'file size') !== stagedSize) {
                    throw managedError(
                        'PATH_IDENTITY_CHANGED',
                        'The published destination was truncated.',
                    );
                }
                await validateTargetIdentity(targetPath, publishedMetadata);
                await validateBoundPath(parent);
                validateIdentityPair(grant.parentIdentity!, identityPair(parent.metadata));
                await syncDirectoryHandle(parent.handle);
                await validateBoundPath(parent);
                await validateTargetIdentity(targetPath, publishedMetadata);
                await validateCurrentParentIdentity(targetPath, grant.parentIdentity!);
                assertNotCancelled(options.signal, deadline);

                await parent.handle.close();
                parent = undefined;
                await removeIfIdentityMatches(privatePath, stagingIdentity);
                await fsyncDirectory(stagingSessionRoot);
                await stagingHandle.close();
                lifecycle = 'settled';
                clearTimeout(lifetimeTimer);
                this.releaseRenderStage(privatePath);
                return this.outputPublication(
                    { ...journal, state: 'published' },
                    publicationJournalPath,
                );
            } catch (error) {
                if (publishedIdentity) {
                    // If the granted parent moved after publication, the still-open private
                    // descriptor remains bound to every link. Truncating it prevents content
                    // disclosure even where Node cannot unlink through the old directory fd.
                    await stagingHandle.truncate(0).catch(() => undefined);
                    await stagingHandle.sync().catch(() => undefined);
                    await removeIfIdentityMatches(targetPath, publishedIdentity)
                        .catch(() => undefined);
                }
                if (publicationJournalPath) {
                    await rm(publicationJournalPath, { force: true }).catch(() => undefined);
                    await fsyncDirectory(dirname(publicationJournalPath)).catch(() => undefined);
                }
                await parent?.handle.close().catch(() => undefined);
                await cleanupStage();
                throw error;
            }
        });
        return {
            capabilityType: 'validated-staged-destination',
            grantId,
            handle: {
                writeFile: (data) => withLifecycle(async () => {
                    const buffer = typeof data === 'string' ? Buffer.from(data) : data;
                    const bytes = buffer.byteLength;
                    await this.runRenderWrite(
                        privatePath,
                        stagingSessionRoot,
                        () => bytes,
                        async () => {
                            await stagingHandle.truncate(0);
                            await writeBufferAt(stagingHandle, buffer, 0);
                            await stagingHandle.truncate(bytes);
                        },
                        () => lifecycle !== 'open',
                    );
                }),
                write: (data, position) => withLifecycle(async () => {
                    if (!Number.isSafeInteger(position) || position < 0) {
                        throw managedError(
                            'INVALID_REQUEST',
                            'Render staging writes require an explicit safe position.',
                        );
                    }
                    return this.runRenderWrite(
                        privatePath,
                        stagingSessionRoot,
                        (currentBytes) => Math.max(currentBytes, position + data.byteLength),
                        async () => {
                            const result = await stagingHandle.write(
                                data,
                                0,
                                data.byteLength,
                                position,
                            );
                            return { bytesWritten: result.bytesWritten };
                        },
                        () => lifecycle !== 'open',
                    );
                }),
                read: (buffer, offset, length, position) => withLifecycle(async () => {
                    if (lifecycle !== 'open') {
                        throw managedError('PATH_NOT_GRANTED', 'The render staging handle is closed.');
                    }
                    return stagingHandle.read(buffer, offset, length, position);
                }),
                stat: () => withLifecycle(async () => {
                    if (lifecycle !== 'open') {
                        throw managedError('PATH_NOT_GRANTED', 'The render staging handle is closed.');
                    }
                    const metadata = await stagingHandle.stat({ bigint: true });
                    validateRegularFile(metadata);
                    return {
                        byteLength: toSafeNumber(metadata.size, 'file size'),
                        device: metadata.dev.toString(),
                        inode: metadata.ino.toString(),
                    };
                }),
                hash: (options = {}) => withLifecycle(async () => {
                    if (lifecycle !== 'open') {
                        throw managedError('PATH_NOT_GRANTED', 'The render staging handle is closed.');
                    }
                    const deadline = deadlineFrom(
                        options.deadlineMilliseconds,
                        5 * 60 * 1000,
                    );
                    const before = await stagingHandle.stat({ bigint: true });
                    validateRegularFile(before);
                    const result = await digestHandle(
                        stagingHandle,
                        options.signal,
                        deadline,
                    );
                    const after = await stagingHandle.stat({ bigint: true });
                    validateSameDescriptorIdentity(before, after);
                    if (result.bytes !== toSafeNumber(after.size, 'file size')) {
                        throw managedError(
                            'PATH_IDENTITY_CHANGED',
                            'The private render output changed while hashing.',
                        );
                    }
                    return result;
                }),
                sync: () => withLifecycle(async () => {
                    if (lifecycle !== 'open') {
                        throw managedError('PATH_NOT_GRANTED', 'The render staging handle is closed.');
                    }
                    await stagingHandle.sync();
                }),
                inspect: (operation, options = {}) => withLifecycle(async () => {
                    if (lifecycle !== 'open') {
                        throw managedError('PATH_NOT_GRANTED', 'The render staging handle is closed.');
                    }
                    const deadlineMilliseconds = options.deadlineMilliseconds ?? 5 * 60 * 1000;
                    const deadline = deadlineFrom(deadlineMilliseconds, deadlineMilliseconds);
                    const controller = new AbortController();
                    const abortFromCaller = () => {
                        controller.abort(
                            options.signal?.reason ?? new DOMException('Aborted', 'AbortError'),
                        );
                    };
                    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
                    if (options.signal?.aborted) abortFromCaller();
                    const timer = setTimeout(() => {
                        controller.abort(
                            managedError(
                                'COORDINATOR_UNAVAILABLE',
                                'Render inspection timed out.',
                                true,
                            ),
                        );
                    }, deadlineMilliseconds);
                    timer.unref?.();
                    let result: Awaited<ReturnType<typeof operation>>;
                    try {
                        assertNotCancelled(controller.signal, deadline);
                        result = await operation(privatePath, controller.signal);
                        assertNotCancelled(controller.signal, deadline);
                    } catch (error) {
                        if (options.signal?.aborted) {
                            this.options.diagnostics?.record('abortedOperations');
                        } else if (controller.signal.aborted) {
                            this.options.diagnostics?.record('deadlineExceeded');
                        }
                        await cleanupStage();
                        throw controller.signal.reason ?? error;
                    } finally {
                        clearTimeout(timer);
                        options.signal?.removeEventListener('abort', abortFromCaller);
                    }
                    try {
                        await this.validateRenderStageSize(privatePath, stagingSessionRoot);
                    } catch (error) {
                        await cleanupStage();
                        throw error;
                    }
                    return result;
                }),
            },
            commit,
            abort,
        };
    }

    async recoverOutputPublication(
        grantId: string,
        sessionId: string,
    ): Promise<StagedOutputPublication | null> {
        if (!grantId || !sessionId) {
            throw managedError('INVALID_REQUEST', 'The output publication scope is invalid.');
        }
        const publicationId = createHash('sha256')
            .update(`output-publication\0${grantId}`)
            .digest('hex');
        const publicationRoot = join(this.options.privateCopyRoot, 'output-publications');
        const journalPath = join(publicationRoot, `${publicationId}.json`);
        const journal = await readJsonFile<OutputPublicationJournal>(
            journalPath,
            256 * 1024,
        );
        if (!journal) return null;
        validateOutputPublicationJournal(journal);
        if (journal.grantId !== grantId || journal.sessionId !== sessionId) {
            throw managedError(
                'PATH_NOT_GRANTED',
                'The durable output publication does not belong to this session.',
            );
        }
        let handle: FileHandle | undefined;
        try {
            handle = await openNoFollow(
                journal.targetPath,
                constants.O_RDONLY | constants.O_NONBLOCK,
            );
            const metadata = await handle.stat({ bigint: true });
            validateRecoveredPublishedFile(metadata);
            validateStoredIdentity(journal.finalIdentity, fileIdentity(metadata));
            const digest = await digestHandle(
                handle,
                undefined,
                deadlineFrom(undefined, 5 * 60 * 1000),
            );
            if (digest.digest !== journal.digest || digest.bytes !== journal.byteLength) {
                throw managedError(
                    'PATH_IDENTITY_CHANGED',
                    'The recovered output publication bytes changed.',
                );
            }
            if (journal.state !== 'published') {
                journal.state = 'published';
                await atomicWriteJson(journalPath, journal, { mode: 0o600 });
                await fsyncDirectory(publicationRoot);
            }
            await removeIfIdentityMatches(journal.privatePath, journal.finalIdentity)
                .catch(() => undefined);
            return this.outputPublication(journal, journalPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                await Promise.all([
                    rm(journal.privatePath, { force: true }),
                    rm(journalPath, { force: true }),
                ]);
                await fsyncDirectory(publicationRoot).catch(() => undefined);
                return null;
            }
            throw error;
        } finally {
            await handle?.close().catch(() => undefined);
        }
    }

    async stageOverwrite(grantId: string, scope: PathGrantScope): Promise<never> {
        void grantId;
        void scope;
        throw managedError(
            'OVERWRITE_NOT_AUTHORIZED',
            'Exact overwrite is disabled because this platform cannot publish it race-safely.',
        );
    }

    private resolve(
        grantId: string,
        scope: PathGrantScope,
        expectedKind?: PathGrantKind,
    ): SessionPathGrantRecord {
        validateScope(scope);
        const grant = this.grants.get(grantId);
        if (
            !grant
            || grant.sessionId !== scope.sessionId
            || grant.sessionEpoch !== scope.sessionEpoch
            || grant.revokedAt
            || (expectedKind !== undefined && grant.kind !== expectedKind)
        ) {
            throw managedError('PATH_NOT_GRANTED', 'The requested path capability is not active.');
        }
        return grant;
    }

    private mac(record: Omit<SessionPathGrantRecord, 'authorityMac'> | SessionPathGrantRecord): string {
        const unsigned = { ...record } as Record<string, unknown>;
        delete unsigned.authorityMac;
        return createHmac('sha256', this.options.authoritySecret)
            .update(canonicalJson(unsigned, 256 * 1024))
            .digest('base64url');
    }

    private outputPublication(
        journal: OutputPublicationJournal,
        journalPath: string,
    ): StagedOutputPublication {
        const record: OutputPublicationRecord = {
            schemaVersion: 1,
            publicationId: journal.publicationId,
            grantId: journal.grantId,
            sessionId: journal.sessionId,
            byteLength: journal.byteLength,
            digest: journal.digest,
            createdAt: journal.createdAt,
        };
        let settled = false;
        const finish = async (removeTarget: boolean) => {
            if (settled) return;
            if (removeTarget) {
                await removeIfIdentityMatches(journal.targetPath, journal.finalIdentity)
                    .catch(() => undefined);
                await fsyncDirectory(dirname(journal.targetPath)).catch(() => undefined);
            }
            await removeIfIdentityMatches(journal.privatePath, journal.finalIdentity)
                .catch(() => undefined);
            await rm(journalPath, { force: true });
            await fsyncDirectory(dirname(journalPath)).catch(() => undefined);
            settled = true;
        };
        return {
            record,
            registryWrite: {
                relativePath: `outputs/${record.publicationId}.json`,
                value: record,
            },
            accept: () => finish(false),
            reject: () => finish(true),
        };
    }

    private async createRenderStage(
        stagingRoot: string,
        sessionRoot: string,
    ): Promise<{
        privatePath: string;
        stagingHandle: FileHandle;
        stagingIdentity: FileIdentity;
    }> {
        const previous = this.renderQuotaQueue;
        let unlock!: () => void;
        this.renderQuotaQueue = new Promise<void>((resolve) => {
            unlock = resolve;
        });
        await previous;
        try {
            await ensurePrivateDirectory(stagingRoot);
            await ensurePrivateDirectory(sessionRoot);
            const inventory = await renderStagingInventory(stagingRoot, sessionRoot);
            if (
                this.activeRenderStages.size >= this.renderStagingQuotas.maximumConcurrentStages
                || inventory.sessionCount + 1 > this.renderStagingQuotas.maximumSessionCount
                || inventory.globalCount + 1 > this.renderStagingQuotas.maximumGlobalCount
                || inventory.sessionBytes > this.renderStagingQuotas.maximumSessionBytes
                || inventory.globalBytes > this.renderStagingQuotas.maximumGlobalBytes
            ) {
                this.options.diagnostics?.record('limitRejections');
                throw managedError(
                    'PAYLOAD_TOO_LARGE',
                    'The private render-staging quota was reached.',
                );
            }
            const privatePath = join(sessionRoot, `${randomUUID()}.partial`);
            const stagingHandle = await open(
                privatePath,
                constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
                0o600,
            );
            try {
                const stagingIdentity = fileIdentity(
                    await stagingHandle.stat({ bigint: true }),
                );
                this.activeRenderStages.set(privatePath, {
                    sessionKey: basename(sessionRoot),
                    byteLength: 0,
                });
                this.refreshRenderDiagnostics();
                return { privatePath, stagingHandle, stagingIdentity };
            } catch (error) {
                await stagingHandle.close().catch(() => undefined);
                await rm(privatePath, { force: true }).catch(() => undefined);
                throw error;
            }
        } finally {
            unlock();
        }
    }

    private async runRenderWrite<T>(
        privatePath: string,
        sessionRoot: string,
        projectedSize: (currentBytes: number) => number,
        operation: () => Promise<T>,
        isSettled: () => boolean,
    ): Promise<T> {
        const previous = this.renderQuotaQueue;
        let unlock!: () => void;
        this.renderQuotaQueue = new Promise<void>((resolve) => {
            unlock = resolve;
        });
        await previous;
        try {
            if (isSettled() || !this.activeRenderStages.has(privatePath)) {
                throw managedError('PATH_NOT_GRANTED', 'The render staging handle is closed.');
            }
            const before = await lstat(privatePath, { bigint: true });
            validateRegularFile(before);
            const currentBytes = toSafeNumber(before.size, 'file size');
            const nextBytes = projectedSize(currentBytes);
            if (!Number.isSafeInteger(nextBytes) || nextBytes < 0) {
                throw managedError('INVALID_REQUEST', 'The render staging write range is invalid.');
            }
            const stagingRoot = dirname(sessionRoot);
            const inventory = await renderStagingInventory(stagingRoot, sessionRoot);
            if (
                nextBytes > this.renderStagingQuotas.maximumOutputBytes
                || inventory.sessionBytes - currentBytes + nextBytes
                    > this.renderStagingQuotas.maximumSessionBytes
                || inventory.globalBytes - currentBytes + nextBytes
                    > this.renderStagingQuotas.maximumGlobalBytes
            ) {
                this.options.diagnostics?.record('limitRejections');
                throw managedError(
                    'PAYLOAD_TOO_LARGE',
                    'The private render output exceeds its byte quota.',
                );
            }
            const result = await operation();
            const after = await lstat(privatePath, { bigint: true });
            validateRegularFile(after);
            const actualBytes = toSafeNumber(after.size, 'file size');
            if (actualBytes > nextBytes) {
                throw managedError(
                    'PATH_IDENTITY_CHANGED',
                    'The private render output grew outside its managed handle.',
                );
            }
            const active = this.activeRenderStages.get(privatePath);
            if (active) active.byteLength = actualBytes;
            this.refreshRenderDiagnostics();
            return result;
        } finally {
            unlock();
        }
    }

    private async validateRenderStageSize(
        privatePath: string,
        sessionRoot: string,
    ): Promise<void> {
        await this.runRenderWrite(
            privatePath,
            sessionRoot,
            (currentBytes) => currentBytes,
            async () => undefined,
            () => false,
        );
    }

    private releaseRenderStage(privatePath: string): void {
        this.activeRenderStages.delete(privatePath);
        this.refreshRenderDiagnostics();
    }

    private refreshRenderDiagnostics(): void {
        this.options.diagnostics?.set('renderStagesInFlight', this.activeRenderStages.size);
        this.options.diagnostics?.set(
            'renderStageBytesInFlight',
            Array.from(this.activeRenderStages.values())
                .reduce((total, stage) => total + stage.byteLength, 0),
        );
    }

    private async materializeSource(
        grant: SessionPathGrantRecord,
        requestedPath: string,
        options: { signal?: AbortSignal; deadlineMilliseconds?: number },
    ): Promise<MaterializedSource> {
        const deadline = deadlineFrom(options.deadlineMilliseconds, 5 * 60 * 1000);
        assertNotCancelled(options.signal, deadline);
        const bound = await openBoundPath(requestedPath, false);
        let temporary: string | undefined;
        let output: FileHandle | undefined;
        let reservation: SourceCopyReservation | undefined;
        try {
            assertContained(grant.canonicalPath, bound.canonicalPath);
            await validateReadRootIdentity(grant);
            if (grant.identity && bound.canonicalPath === grant.canonicalPath) {
                validateStoredIdentity(grant.identity, fileIdentity(bound.metadata));
            }
            const expectedBytes = toSafeNumber(bound.metadata.size, 'file size');
            reservation = await this.reserveSourceCopy(grant.sessionId, expectedBytes);
            const copyRoot = sourceCopySessionRoot(this.options.privateCopyRoot, grant.sessionId);
            await ensurePrivateDirectory(copyRoot);
            temporary = join(copyRoot, `.${randomUUID()}.partial`);
            output = await open(
                temporary,
                constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
                0o600,
            );
            const hash = createHash('sha256');
            const buffer = Buffer.allocUnsafe(1024 * 1024);
            let position = 0;
            while (true) {
                assertNotCancelled(options.signal, deadline);
                const { bytesRead } = await bound.handle.read(
                    buffer,
                    0,
                    buffer.byteLength,
                    position,
                );
                if (bytesRead === 0) break;
                const chunk = buffer.subarray(0, bytesRead);
                await reservation.growTo(position + bytesRead);
                await writeBufferAt(output, chunk, position);
                hash.update(chunk);
                position += bytesRead;
                if (
                    !Number.isSafeInteger(position)
                    || position > this.sourceCopyQuotas.maximumSourceBytes
                ) {
                    throw managedError('PAYLOAD_TOO_LARGE', 'The managed source is oversized.');
                }
            }
            await validateBoundPath(bound);
            await validateReadRootIdentity(grant);
            const digest = `sha256:${hash.digest('hex')}`;
            const verification = await digestHandle(bound.handle, options.signal, deadline);
            if (verification.digest !== digest || verification.bytes !== position) {
                throw managedError(
                    'SOURCE_CHANGED',
                    'The source changed while its immutable version was materialized.',
                );
            }
            if (grant.sourceDigest && grant.sourceDigest !== digest) {
                throw managedError('SOURCE_CHANGED', 'The source changed after the grant was issued.');
            }
            await output.sync();
            await output.close();
            output = undefined;
            const finalPath = join(copyRoot, `${digest.slice(7)}.source`);
            const existing = await lstatOrNull(finalPath);
            if (existing) {
                validateRegularFile(existing);
                if (toSafeNumber(existing.size, 'file size') !== position) {
                    throw managedError('SOURCE_CHANGED', 'The immutable source cache is corrupt.');
                }
                await rm(temporary);
            } else {
                // Both operands live in the private 0700 authority namespace. No untrusted path is
                // reopened and a digest collision is checked before reuse.
                await rename(temporary, finalPath);
                await fsyncDirectory(copyRoot);
            }
            temporary = undefined;
            return { path: finalPath, digest, byteLength: position };
        } finally {
            await Promise.all([
                bound.handle.close().catch(() => undefined),
                output?.close().catch(() => undefined),
            ]);
            if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
            reservation?.release();
        }
    }

    private async reserveSourceCopy(
        sessionId: string,
        expectedBytes: number,
    ): Promise<SourceCopyReservation> {
        const previous = this.sourceQuotaQueue;
        let unlock!: () => void;
        this.sourceQuotaQueue = new Promise<void>((resolve) => {
            unlock = resolve;
        });
        await previous;
        try {
            if (
                !Number.isSafeInteger(expectedBytes)
                || expectedBytes < 0
                || expectedBytes > this.sourceCopyQuotas.maximumSourceBytes
            ) {
                throw managedError('PAYLOAD_TOO_LARGE', 'The managed source exceeds its byte quota.');
            }
            const sessionKey = sourceCopySessionKey(sessionId);
            const inventory = await sourceCopyInventory(this.options.privateCopyRoot, sessionKey);
            if (
                this.activeSourceCount >= this.sourceCopyQuotas.maximumConcurrentCopies
                || inventory.sessionCount
                    + (this.activeSessionCount.get(sessionKey) ?? 0)
                    + 1
                    > this.sourceCopyQuotas.maximumSessionCount
                || inventory.globalCount
                    + this.activeSourceCount
                    + 1
                    > this.sourceCopyQuotas.maximumGlobalCount
                || inventory.sessionBytes
                    + (this.activeSessionBytes.get(sessionKey) ?? 0)
                    + expectedBytes
                    > this.sourceCopyQuotas.maximumSessionBytes
                || inventory.globalBytes
                    + this.activeSourceBytes
                    + expectedBytes
                    > this.sourceCopyQuotas.maximumGlobalBytes
            ) {
                throw managedError('PAYLOAD_TOO_LARGE', 'The immutable source-copy quota was reached.');
            }
            this.activeSourceCount += 1;
            this.activeSourceBytes += expectedBytes;
            updateCounter(this.activeSessionCount, sessionKey, 1);
            updateCounter(this.activeSessionBytes, sessionKey, expectedBytes);
            this.options.diagnostics?.set('sourceCopiesInFlight', this.activeSourceCount);
            this.options.diagnostics?.set('sourceCopyBytesInFlight', this.activeSourceBytes);
            let released = false;
            let reservedBytes = expectedBytes;
            return {
                growTo: async (byteLength) => {
                    if (released || byteLength <= reservedBytes) return;
                    if (
                        !Number.isSafeInteger(byteLength)
                        || byteLength > this.sourceCopyQuotas.maximumSourceBytes
                    ) {
                        throw managedError(
                            'PAYLOAD_TOO_LARGE',
                            'The managed source exceeds its byte quota.',
                        );
                    }
                    const queued = this.sourceQuotaQueue;
                    let releaseQueue!: () => void;
                    this.sourceQuotaQueue = new Promise<void>((resolve) => {
                        releaseQueue = resolve;
                    });
                    await queued;
                    try {
                        if (released || byteLength <= reservedBytes) return;
                        const delta = byteLength - reservedBytes;
                        const latest = await sourceCopyInventory(
                            this.options.privateCopyRoot,
                            sessionKey,
                        );
                        if (
                            latest.sessionBytes
                                + (this.activeSessionBytes.get(sessionKey) ?? 0)
                                + delta
                                > this.sourceCopyQuotas.maximumSessionBytes
                            || latest.globalBytes
                                + this.activeSourceBytes
                                + delta
                                > this.sourceCopyQuotas.maximumGlobalBytes
                        ) {
                            throw managedError(
                                'PAYLOAD_TOO_LARGE',
                                'The immutable source-copy quota was reached.',
                            );
                        }
                        reservedBytes = byteLength;
                        this.activeSourceBytes += delta;
                        updateCounter(this.activeSessionBytes, sessionKey, delta);
                        this.options.diagnostics?.set(
                            'sourceCopyBytesInFlight',
                            this.activeSourceBytes,
                        );
                    } finally {
                        releaseQueue();
                    }
                },
                release: () => {
                    if (released) return;
                    released = true;
                    this.activeSourceCount = Math.max(0, this.activeSourceCount - 1);
                    this.activeSourceBytes = Math.max(0, this.activeSourceBytes - reservedBytes);
                    updateCounter(this.activeSessionCount, sessionKey, -1);
                    updateCounter(this.activeSessionBytes, sessionKey, -reservedBytes);
                    this.options.diagnostics?.set('sourceCopiesInFlight', this.activeSourceCount);
                    this.options.diagnostics?.set(
                        'sourceCopyBytesInFlight',
                        this.activeSourceBytes,
                    );
                },
            };
        } finally {
            unlock();
        }
    }
}

export async function hashVerifiedRead(
    verified: VerifiedReadHandle,
    maxBufferBytes = 8 * 1024 * 1024,
): Promise<{ digest: string; bytes: number }> {
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes <= 0) {
        throw managedError('INVALID_REQUEST', 'The source hash buffer limit is invalid.');
    }
    await verified.verifyUnchanged();
    return { digest: verified.digest, bytes: verified.identity.size };
}

async function openBoundPath(requestedPath: string, allowDirectory: boolean): Promise<BoundPath> {
    validateAbsolutePath(requestedPath);
    const before = await lstat(requestedPath, { bigint: true });
    if (before.isSymbolicLink()) {
        throw managedError('PATH_NOT_GRANTED', 'Symbolic links cannot be granted or opened.');
    }
    if (!before.isFile() && !(allowDirectory && before.isDirectory())) {
        // This pre-open gate is essential for FIFOs: O_NONBLOCK is defense in depth, while the
        // type check ensures a special file never consumes a libuv worker waiting for a peer.
        throw managedError('SOURCE_UNREADABLE', 'Managed sources must be regular files.');
    }
    const handle = await openNoFollow(
        requestedPath,
        constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
        const metadata = await handle.stat({ bigint: true });
        if (metadata.dev !== before.dev || metadata.ino !== before.ino) {
            throw managedError(
                'PATH_IDENTITY_CHANGED',
                'The filesystem object changed between inspection and open.',
            );
        }
        if (metadata.isDirectory()) {
            if (!allowDirectory) {
                throw managedError('SOURCE_UNREADABLE', 'Managed sources must be regular files.');
            }
        } else {
            validateRegularFile(metadata);
        }
        const canonicalPath = await realpath(requestedPath);
        const canonicalMetadata = await lstat(canonicalPath, { bigint: true });
        validateSameIdentity(metadata, canonicalMetadata, allowDirectory);
        const bound = { canonicalPath, handle, metadata };
        await validateBoundPath(bound);
        return bound;
    } catch (error) {
        await handle.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw managedError(
                'PATH_IDENTITY_CHANGED',
                'The filesystem object changed during access.',
            );
        }
        throw error;
    }
}

async function openBoundDirectory(path: string): Promise<BoundPath> {
    const bound = await openBoundPath(path, true);
    if (!bound.metadata.isDirectory()) {
        await bound.handle.close();
        throw managedError('PATH_IDENTITY_CHANGED', 'The destination parent is not a directory.');
    }
    return bound;
}

async function validateBoundPath(bound: BoundPath): Promise<void> {
    try {
        const [descriptor, pathMetadata] = await Promise.all([
            bound.handle.stat({ bigint: true }),
            lstat(bound.canonicalPath, { bigint: true }),
        ]);
        validateSameIdentity(descriptor, pathMetadata, bound.metadata.isDirectory());
        if (
            descriptor.dev !== bound.metadata.dev
            || descriptor.ino !== bound.metadata.ino
        ) {
            throw managedError('PATH_IDENTITY_CHANGED', 'The filesystem object changed during access.');
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw managedError('PATH_IDENTITY_CHANGED', 'The filesystem object changed during access.');
        }
        throw error;
    }
}

async function validateReadRootIdentity(grant: SessionPathGrantRecord): Promise<void> {
    if (!grant.rootIdentity) {
        throw managedError('PATH_IDENTITY_CHANGED', 'The read grant has no captured root identity.');
    }
    const metadata = await lstat(grant.canonicalPath, { bigint: true });
    if (
        metadata.isSymbolicLink()
        || metadata.dev.toString() !== grant.rootIdentity.device
        || metadata.ino.toString() !== grant.rootIdentity.inode
    ) {
        throw managedError('PATH_IDENTITY_CHANGED', 'The granted read root was replaced.');
    }
}

async function validateTargetIdentity(
    targetPath: string,
    descriptor: Awaited<ReturnType<FileHandle['stat']>>,
): Promise<void> {
    try {
        const current = await lstat(targetPath, { bigint: true });
        validateSameIdentity(descriptor, current, false);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw managedError('PATH_IDENTITY_CHANGED', 'The filesystem object changed during access.');
        }
        throw error;
    }
}

async function validateCurrentParentIdentity(
    targetPath: string,
    expected: Pick<FileIdentity, 'device' | 'inode'>,
): Promise<void> {
    const current = await openBoundDirectory(dirname(targetPath));
    try {
        validateIdentityPair(expected, identityPair(current.metadata));
        await validateBoundPath(current);
    } finally {
        await current.handle.close().catch(() => undefined);
    }
}

async function removeIfIdentityMatches(
    path: string,
    expected: FileIdentity,
): Promise<void> {
    let handle: FileHandle | undefined;
    const quarantined = `${path}.waptions-remove-${randomUUID()}`;
    let renamed = false;
    try {
        handle = await openNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK);
        const current = await handle.stat({ bigint: true });
        if (
            !current.isFile()
            || current.isSymbolicLink()
            || current.dev.toString() !== expected.device
            || current.ino.toString() !== expected.inode
        ) {
            return;
        }
        await rename(path, quarantined);
        renamed = true;
        const moved = await openNoFollow(
            quarantined,
            constants.O_RDONLY | constants.O_NONBLOCK,
        );
        try {
            const movedMetadata = await moved.stat({ bigint: true });
            if (
                movedMetadata.dev.toString() !== expected.device
                || movedMetadata.ino.toString() !== expected.inode
            ) {
                await restoreWithoutOverwrite(quarantined, path);
                renamed = false;
                return;
            }
        } finally {
            await moved.close();
        }
        await rm(quarantined);
        renamed = false;
        await fsyncDirectory(dirname(path));
    } catch (error) {
        if (renamed) await restoreWithoutOverwrite(quarantined, path).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

async function restoreWithoutOverwrite(quarantined: string, destination: string): Promise<void> {
    try {
        await link(quarantined, destination);
        await rm(quarantined);
        await fsyncDirectory(dirname(destination));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
}

async function digestHandle(
    handle: FileHandle,
    signal?: AbortSignal,
    deadline = Number.MAX_SAFE_INTEGER,
): Promise<{ digest: string; bytes: number }> {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
        assertNotCancelled(signal, deadline);
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
        if (!Number.isSafeInteger(position)) {
            throw managedError('PAYLOAD_TOO_LARGE', 'The managed source is oversized.');
        }
    }
    return { digest: `sha256:${hash.digest('hex')}`, bytes: position };
}

async function writeBufferAt(
    handle: FileHandle,
    data: Uint8Array,
    position: number,
): Promise<void> {
    let written = 0;
    while (written < data.byteLength) {
        const result = await handle.write(
            data,
            written,
            data.byteLength - written,
            position + written,
        );
        if (result.bytesWritten <= 0) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The render staging write made no progress.',
            );
        }
        written += result.bytesWritten;
    }
}

function assertContained(root: string, candidate: string): void {
    const nested = relative(root, candidate);
    if (nested === '..' || nested.startsWith(`..${sep}`) || resolve(nested) === nested) {
        throw managedError('PATH_NOT_GRANTED', 'The path is outside the granted read root.');
    }
}

async function openNoFollow(path: string, flags: number): Promise<FileHandle> {
    try {
        return await open(path, flags | constants.O_NOFOLLOW);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (['ELOOP', 'EMLINK'].includes(code ?? '')) {
            throw managedError('PATH_IDENTITY_CHANGED', 'A symbolic link replaced the granted source.');
        }
        throw error;
    }
}

function validateRegularFile(
    metadata: Awaited<ReturnType<FileHandle['stat']>> | Awaited<ReturnType<typeof lstat>>,
): void {
    if (!metadata.isFile() || metadata.isSymbolicLink() || Number(metadata.nlink) !== 1) {
        throw managedError(
            'SOURCE_UNREADABLE',
            'Managed sources and destinations must be unlinked regular files.',
        );
    }
    toSafeNumber(metadata.size, 'file size');
}

function validatePublishedFile(
    metadata: Awaited<ReturnType<FileHandle['stat']>>,
): void {
    if (!metadata.isFile() || metadata.isSymbolicLink() || Number(metadata.nlink) !== 2) {
        throw managedError(
            'PATH_IDENTITY_CHANGED',
            'The atomically published output has an unexpected link identity.',
        );
    }
    toSafeNumber(metadata.size, 'file size');
}

function validateRecoveredPublishedFile(
    metadata: Awaited<ReturnType<FileHandle['stat']>>,
): void {
    const links = Number(metadata.nlink);
    if (
        !metadata.isFile()
        || metadata.isSymbolicLink()
        || !Number.isSafeInteger(links)
        || links < 1
        || links > 2
    ) {
        throw managedError(
            'PATH_IDENTITY_CHANGED',
            'The recovered output publication has an unexpected link identity.',
        );
    }
    toSafeNumber(metadata.size, 'file size');
}

function validateSameIdentity(
    left: Awaited<ReturnType<FileHandle['stat']>>,
    right: Awaited<ReturnType<typeof lstat>>,
    allowDirectory: boolean,
): void {
    if (
        left.dev !== right.dev
        || left.ino !== right.ino
        || right.isSymbolicLink()
        || (!right.isFile() && !(allowDirectory && right.isDirectory()))
    ) {
        throw managedError('PATH_IDENTITY_CHANGED', 'The filesystem object changed during access.');
    }
}

function validateSameDescriptorIdentity(
    before: Awaited<ReturnType<FileHandle['stat']>>,
    after: Awaited<ReturnType<FileHandle['stat']>>,
): void {
    if (
        before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
    ) {
        throw managedError(
            'PATH_IDENTITY_CHANGED',
            'The managed descriptor changed during access.',
        );
    }
}

function validateStoredIdentity(expected: FileIdentity, actual: FileIdentity): void {
    if (
        expected.device !== actual.device
        || expected.inode !== actual.inode
        || expected.size !== actual.size
        || expected.modifiedMilliseconds !== actual.modifiedMilliseconds
    ) {
        throw managedError('SOURCE_CHANGED', 'The granted filesystem object no longer matches.');
    }
}

function validateIdentityPair(
    expected: Pick<FileIdentity, 'device' | 'inode'>,
    actual: Pick<FileIdentity, 'device' | 'inode'>,
): void {
    if (expected.device !== actual.device || expected.inode !== actual.inode) {
        throw managedError('PATH_IDENTITY_CHANGED', 'The granted filesystem object was replaced.');
    }
}

function fileIdentity(
    metadata: Awaited<ReturnType<FileHandle['stat']>> | Awaited<ReturnType<typeof lstat>>,
): FileIdentity {
    return {
        device: metadata.dev.toString(),
        inode: metadata.ino.toString(),
        size: toSafeNumber(metadata.size, 'file size'),
        modifiedMilliseconds: finiteNumber(metadata.mtimeMs, 'file modification time'),
    };
}

function identityPair(
    metadata: Awaited<ReturnType<FileHandle['stat']>> | Awaited<ReturnType<typeof lstat>>,
): Pick<FileIdentity, 'device' | 'inode'> {
    return { device: metadata.dev.toString(), inode: metadata.ino.toString() };
}

function validateGrantRecord(record: unknown): asserts record is SessionPathGrantRecord {
    if (
        !record
        || typeof record !== 'object'
        || !('schemaVersion' in record)
        || !('grantId' in record)
        || !('sessionId' in record)
        || !('sessionEpoch' in record)
        || !('authorityMac' in record)
        || !('kind' in record)
        || !('canonicalPath' in record)
        || record.schemaVersion !== 2
        || typeof record.grantId !== 'string'
        || record.grantId.length === 0
        || typeof record.sessionId !== 'string'
        || record.sessionId.length === 0
        || typeof record.sessionEpoch !== 'string'
        || record.sessionEpoch.length === 0
        || typeof record.authorityMac !== 'string'
        || record.authorityMac.length === 0
        || typeof record.kind !== 'string'
        || !['read-root', 'create-only-destination', 'exact-overwrite'].includes(record.kind)
        || typeof record.canonicalPath !== 'string'
    ) {
        throw managedError('INVALID_REQUEST', 'The managed path grant record is invalid.');
    }
    validateAbsolutePath(record.canonicalPath);
}

function validateOutputPublicationJournal(
    journal: OutputPublicationJournal,
): void {
    if (
        journal.schemaVersion !== 1
        || !/^[a-f0-9]{64}$/.test(journal.publicationId)
        || !journal.grantId
        || !journal.sessionId
        || !Number.isSafeInteger(journal.byteLength)
        || journal.byteLength < 0
        || !/^sha256:[a-f0-9]{64}$/.test(journal.digest)
        || !['prepared', 'published'].includes(journal.state)
    ) {
        throw managedError(
            'PATH_IDENTITY_CHANGED',
            'The durable output publication journal is invalid.',
        );
    }
    validateAbsolutePath(journal.targetPath);
    validateAbsolutePath(journal.privatePath);
    toSafeNumber(journal.finalIdentity.size, 'output publication size');
}

function withGrantMac(
    record: SessionPathGrantRecord,
    secret: Uint8Array,
): SessionPathGrantRecord {
    const unsigned = { ...record } as Record<string, unknown>;
    delete unsigned.authorityMac;
    return {
        ...(unsigned as unknown as Omit<SessionPathGrantRecord, 'authorityMac'>),
        authorityMac: createHmac('sha256', secret)
            .update(canonicalJson(unsigned, 256 * 1024))
            .digest('base64url'),
    };
}

function validateScope(scope: PathGrantScope): void {
    if (!scope.sessionId || !scope.sessionEpoch) {
        throw managedError('PATH_NOT_GRANTED', 'The requested path capability scope is invalid.');
    }
}

function sourceCopySessionKey(sessionId: string): string {
    return createHash('sha256').update(sessionId).digest('hex');
}

function sourceCopySessionRoot(privateCopyRoot: string, sessionId: string): string {
    return join(privateCopyRoot, sourceCopySessionKey(sessionId));
}

async function sourceCopyInventory(
    privateCopyRoot: string,
    requestedSessionKey: string,
): Promise<{
    sessionBytes: number;
    sessionCount: number;
    globalBytes: number;
    globalCount: number;
}> {
    await ensurePrivateDirectory(privateCopyRoot);
    let sessionBytes = 0;
    let sessionCount = 0;
    let globalBytes = 0;
    let globalCount = 0;
    for (const session of await readdir(privateCopyRoot, { withFileTypes: true })) {
        if (!session.isDirectory() || !/^[a-f0-9]{64}$/.test(session.name)) continue;
        for (const name of await readdir(join(privateCopyRoot, session.name))) {
            if (!/^[a-f0-9]{64}\.source$/.test(name)) continue;
            const metadata = await lstat(join(privateCopyRoot, session.name, name), { bigint: true });
            validateRegularFile(metadata);
            const bytes = toSafeNumber(metadata.size, 'source copy size');
            globalBytes = safeSum(globalBytes, bytes, 'global source-copy bytes');
            globalCount = safeSum(globalCount, 1, 'global source-copy count');
            if (session.name === requestedSessionKey) {
                sessionBytes = safeSum(sessionBytes, bytes, 'session source-copy bytes');
                sessionCount = safeSum(sessionCount, 1, 'session source-copy count');
            }
        }
    }
    return { sessionBytes, sessionCount, globalBytes, globalCount };
}

async function renderStagingInventory(
    stagingRoot: string,
    requestedSessionRoot: string,
): Promise<{
    sessionBytes: number;
    sessionCount: number;
    globalBytes: number;
    globalCount: number;
}> {
    await ensurePrivateDirectory(stagingRoot);
    let sessionBytes = 0;
    let sessionCount = 0;
    let globalBytes = 0;
    let globalCount = 0;
    for (const session of await readdir(stagingRoot, { withFileTypes: true })) {
        if (!session.isDirectory() || !/^[a-f0-9]{64}$/.test(session.name)) continue;
        const sessionRoot = join(stagingRoot, session.name);
        for (const name of await readdir(sessionRoot)) {
            if (!/^[a-f0-9-]+\.partial$/.test(name)) continue;
            const metadata = await lstat(join(sessionRoot, name), { bigint: true });
            validateRegularFile(metadata);
            const bytes = toSafeNumber(metadata.size, 'render staging size');
            globalBytes = safeSum(globalBytes, bytes, 'global render-staging bytes');
            globalCount = safeSum(globalCount, 1, 'global render-staging count');
            if (sessionRoot === requestedSessionRoot) {
                sessionBytes = safeSum(sessionBytes, bytes, 'session render-staging bytes');
                sessionCount = safeSum(sessionCount, 1, 'session render-staging count');
            }
        }
    }
    return { sessionBytes, sessionCount, globalBytes, globalCount };
}

function validateSourceCopyQuotaPolicy(policy: SourceCopyQuotaPolicy): void {
    for (const [name, value] of Object.entries(policy)) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw managedError('INVALID_REQUEST', `The source-copy ${name} quota is invalid.`);
        }
    }
    if (
        policy.maximumSourceBytes > policy.maximumSessionBytes
        || policy.maximumSessionBytes > policy.maximumGlobalBytes
        || policy.maximumSessionCount > policy.maximumGlobalCount
        || policy.maximumConcurrentCopies > policy.maximumGlobalCount
    ) {
        throw managedError('INVALID_REQUEST', 'The source-copy quota hierarchy is invalid.');
    }
}

function validateRenderStagingQuotaPolicy(policy: RenderStagingQuotaPolicy): void {
    for (const [name, value] of Object.entries(policy)) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw managedError('INVALID_REQUEST', `The render-staging ${name} quota is invalid.`);
        }
    }
    if (
        policy.maximumOutputBytes > policy.maximumSessionBytes
        || policy.maximumSessionBytes > policy.maximumGlobalBytes
        || policy.maximumSessionCount > policy.maximumGlobalCount
        || policy.maximumConcurrentStages > policy.maximumGlobalCount
        || policy.maximumLifetimeMilliseconds > 24 * 60 * 60 * 1000
    ) {
        throw managedError('INVALID_REQUEST', 'The render-staging quota hierarchy is invalid.');
    }
}

function updateCounter(map: Map<string, number>, key: string, delta: number): void {
    const next = Math.max(0, (map.get(key) ?? 0) + delta);
    if (next === 0) map.delete(key);
    else map.set(key, next);
}

function safeSum(left: number, right: number, label: string): number {
    const sum = left + right;
    if (!Number.isSafeInteger(sum) || sum < 0) {
        throw managedError('PAYLOAD_TOO_LARGE', `The ${label} exceeded its safe limit.`);
    }
    return sum;
}

function validateAbsolutePath(path: string): void {
    if (!path || path.includes('\0') || resolve(path) !== path) {
        throw managedError('PATH_NOT_GRANTED', 'Path grants require an absolute local path.');
    }
}

function deadlineFrom(value: number | undefined, fallback: number): number {
    const duration = value ?? fallback;
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 30 * 60 * 1000) {
        throw managedError('INVALID_REQUEST', 'The managed filesystem deadline is invalid.');
    }
    return Date.now() + duration;
}

function assertNotCancelled(signal: AbortSignal | undefined, deadline: number): void {
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    if (Date.now() > deadline) {
        throw managedError('COORDINATOR_UNAVAILABLE', 'The managed filesystem operation timed out.', true);
    }
}

function toSafeNumber(value: number | bigint, field: string): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw managedError('SOURCE_UNREADABLE', `The ${field} is outside the supported range.`);
    }
    return number;
}

function finiteNumber(value: number | bigint, field: string): number {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw managedError('SOURCE_UNREADABLE', `The ${field} is outside the supported range.`);
    }
    return number;
}

async function syncDirectoryHandle(handle: FileHandle): Promise<void> {
    try {
        await handle.sync();
    } catch (error) {
        if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM', 'EACCES'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
        )) {
            throw error;
        }
    }
}

async function lstatOrNull(path: string) {
    try {
        return await lstat(path, { bigint: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}
