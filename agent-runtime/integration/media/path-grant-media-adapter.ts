import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type {
    MediaByteSource,
    MediaByteSourceFactoryPort,
    ManagedJobOpenMediaHandle,
    VerifiedMediaCandidate,
    VerifiedMediaGrantPort,
} from '../../media/contracts';
import { ManagedMediaError } from '../../media/errors';
import type { ByteRange } from '../../media/accounting';
import type {
    OpenMediaSnapshot,
    RegisteredImmutableMediaIdentity,
} from '../../source-registry/contracts';
import type {
    PathGrantAuthority,
    PathGrantScope,
    VerifiedReadHandle,
} from '../../path-grants/path-grant-authority';
import {
    compareCanonicalNaturalNames,
    hasSupportedVideoExtension,
    isSafeCandidateName,
} from '../../source-registry/natural-sort';
import type {
    ManagedMediaCatalogRecord,
    ManagedMediaHandleCatalogPort,
    ManagedMediaOpenLease,
} from './contracts';

const STREAM_CHUNK_BYTES = 1024 * 1024;
const UNCOMMITTED_CAPABILITY_LIFETIME_MS = 15 * 60 * 1000;

interface PendingCapability {
    readonly capabilityId: string;
    readonly grantId: string;
    readonly displayName: string;
    readonly scope: PathGrantScope;
    requestedPath?: string;
    retained?: {
        readonly sessionId: string;
        readonly sourceId: string;
        readonly digest: `sha256:${string}`;
        readonly byteLength: number;
    };
    lastVerifiedIdentity?: VerifiedReadHandle['identity'];
    lastVerifiedDigest?: `sha256:${string}`;
    expiryTimer?: ReturnType<typeof setTimeout>;
    pinCount: number;
    expired: boolean;
    revoked: boolean;
}

interface ActiveHandle {
    readonly capability: PendingCapability;
    readonly verified: VerifiedReadHandle;
    closed: boolean;
}

/**
 * Descriptor-bound adapter from PathGrantAuthority to the modern media ports.
 *
 * Requested paths stay private to this class. Every worker receives an already-open immutable
 * retained copy, and every new decode re-enters the grant authority so revocation fails closed.
 */
export class PathGrantMediaAdapter implements
    VerifiedMediaGrantPort,
    MediaByteSourceFactoryPort,
    ManagedMediaHandleCatalogPort {
    private readonly capabilities = new Map<string, PendingCapability>();
    private readonly active = new Map<string, ActiveHandle>();
    private readonly catalog = new Map<string, ManagedMediaCatalogRecord>();
    private readonly catalogBySource = new Map<string, ManagedMediaCatalogRecord>();
    private readonly committedSourceIds = new Set<string>();

    constructor(private readonly paths: PathGrantAuthority) {}

    registerProbePath(input: {
        grantId: string;
        requestedPath: string;
        displayName: string;
        scope: PathGrantScope;
    }): string {
        const capabilityId = `media-cap:${randomUUID()}`;
        const capability: PendingCapability = {
            capabilityId,
            grantId: input.grantId,
            requestedPath: input.requestedPath,
            displayName: boundedDisplayName(input.displayName),
            scope: structuredClone(input.scope),
            pinCount: 0,
            expired: false,
            revoked: false,
        };
        capability.expiryTimer = setTimeout(() => {
            void this.expireUncommittedCapability(capabilityId).catch(() => undefined);
        }, UNCOMMITTED_CAPABILITY_LIFETIME_MS);
        capability.expiryTimer.unref?.();
        this.capabilities.set(capabilityId, capability);
        return capabilityId;
    }

    async registerProbeDirectory(input: {
        grantId: string;
        scope: PathGrantScope;
        maximumCandidates: number;
        requireVideo: boolean;
    }): Promise<readonly {
        readonly requestedPath: string;
        readonly capabilityId: string;
    }[]> {
        const listed = await this.paths.listReadRootFiles(
            input.grantId,
            input.scope,
            input.maximumCandidates,
        );
        return Object.freeze(listed
            .filter((entry) => (
                isSafeCandidateName(entry.displayName)
                && (!input.requireVideo || hasSupportedVideoExtension(entry.displayName))
            ))
            .sort((left, right) => (
                compareCanonicalNaturalNames(left.displayName, right.displayName)
            ))
            .map((entry) => Object.freeze({
                requestedPath: entry.requestedPath,
                capabilityId: this.registerProbePath({
                    grantId: input.grantId,
                    requestedPath: entry.requestedPath,
                    displayName: entry.displayName,
                    scope: input.scope,
                }),
            })));
    }

    publishCatalogRecord(
        capabilityId: string,
        record: ManagedMediaCatalogRecord,
    ): void {
        const capability = this.requireCapability(capabilityId);
        if (record.handle.capabilityId !== capability.capabilityId) {
            throw new ManagedMediaError(
                'INTERNAL_ERROR',
                'The media handle was bound to a different capability.',
            );
        }
        if (this.catalog.has(record.handle.handleId)
            || this.catalogBySource.has(record.sourceId)) {
            throw new ManagedMediaError('INVALID_REQUEST', 'The media handle identity is duplicated.');
        }
        this.catalog.set(record.handle.handleId, Object.freeze(structuredClone(record)));
        this.catalogBySource.set(record.sourceId, Object.freeze(structuredClone(record)));
    }

    capabilityIdentity(capabilityId: string): VerifiedReadHandle['identity'] {
        const capability = this.requireCapability(capabilityId);
        if (!capability.lastVerifiedIdentity) {
            throw new ManagedMediaError(
                'INTERNAL_ERROR',
                'Media capability has not completed verification.',
            );
        }
        return structuredClone(capability.lastVerifiedIdentity);
    }

    get(handleId: string): ManagedMediaCatalogRecord | undefined {
        const value = this.catalog.get(handleId);
        return value ? structuredClone(value) : undefined;
    }

    getBySourceId(sourceId: string): ManagedMediaCatalogRecord | undefined {
        if (!this.committedSourceIds.has(sourceId)) return undefined;
        const value = this.catalogBySource.get(sourceId);
        return value ? structuredClone(value) : undefined;
    }

    getCatalogRecord(
        sourceId: string,
    ): ManagedMediaCatalogRecord | undefined {
        const value = this.catalogBySource.get(sourceId);
        return value ? structuredClone(value) : undefined;
    }

    grantIdForSource(sourceId: string): string {
        const record = this.catalogBySource.get(sourceId);
        if (!record) {
            throw new ManagedMediaError(
                'SOURCE_UNREADABLE',
                'Managed media source was not found in the capability catalog.',
            );
        }
        return this.requireCapability(record.handle.capabilityId).grantId;
    }

    markCommitted(sourceIds: readonly string[]): void {
        if (sourceIds.length === 0 || new Set(sourceIds).size !== sourceIds.length) {
            throw new ManagedMediaError(
                'INTERNAL_ERROR',
                'Core committed an invalid managed media source set.',
            );
        }
        const selected = sourceIds.map((sourceId) => {
            const record = this.catalogBySource.get(sourceId);
            if (!record) {
                throw new ManagedMediaError(
                    'INTERNAL_ERROR',
                    'Core committed an unknown managed media source.',
                );
            }
            const capability = this.requireCapability(record.handle.capabilityId);
            this.assertCapabilityActive(capability);
            if (capability.pinCount < 1 || capability.retained) {
                throw new ManagedMediaError(
                    'INTERNAL_ERROR',
                    'Managed media authority was not pinned exactly once for commit.',
                );
            }
            return { sourceId, record, capability };
        });
        for (const { sourceId, record, capability } of selected) {
            capability.retained = {
                sessionId: capability.scope.sessionId,
                sourceId,
                digest: record.registeredIdentity.sha256,
                byteLength: record.registeredIdentity.byteLength,
            };
            capability.requestedPath = undefined;
            if (capability.expiryTimer) clearTimeout(capability.expiryTimer);
            capability.expiryTimer = undefined;
        }
        sourceIds.forEach((sourceId) => this.committedSourceIds.add(sourceId));
    }

    restoreCommitted(input: {
        readonly grantId: string;
        readonly scope: PathGrantScope;
        readonly record: ManagedMediaCatalogRecord;
    }): void {
        const capabilityId = input.record.handle.capabilityId;
        if (this.capabilities.has(capabilityId)
            || this.catalog.has(input.record.handle.handleId)
            || this.catalogBySource.has(input.record.sourceId)) {
            throw new ManagedMediaError(
                'INVALID_REQUEST',
                'Restored media authority is duplicated.',
            );
        }
        this.paths.assertActiveGrant(input.grantId, input.scope, 'read-root');
        this.capabilities.set(capabilityId, {
            capabilityId,
            grantId: input.grantId,
            displayName: boundedDisplayName(input.record.displayName),
            scope: structuredClone(input.scope),
            retained: {
                sessionId: input.scope.sessionId,
                sourceId: input.record.sourceId,
                digest: input.record.registeredIdentity.sha256,
                byteLength: input.record.registeredIdentity.byteLength,
            },
            pinCount: 0,
            expired: false,
            revoked: false,
        });
        this.publishCatalogRecord(capabilityId, input.record);
        this.committedSourceIds.add(input.record.sourceId);
    }

    revoke(handleId: string): void {
        const record = this.catalog.get(handleId);
        if (!record) return;
        const capability = this.capabilities.get(record.handle.capabilityId);
        if (capability) capability.revoked = true;
    }

    revokeCapability(capabilityId: string): void {
        const capability = this.capabilities.get(capabilityId);
        if (capability) capability.revoked = true;
    }

    pinUncommitted(handleIds: readonly string[]): () => Promise<void> {
        const capabilities = handleIds.map((handleId) => {
            const record = this.catalog.get(handleId);
            if (!record || this.committedSourceIds.has(record.sourceId)) {
                throw new ManagedMediaError(
                    'SOURCE_UNREADABLE',
                    'Only active uncommitted media handles can be pinned.',
                );
            }
            return this.requireCapability(record.handle.capabilityId);
        });
        capabilities.forEach((capability) => {
            this.assertCapabilityActive(capability);
            capability.pinCount += 1;
        });
        let released = false;
        return async () => {
            if (released) return;
            released = true;
            const expired: string[] = [];
            for (const capability of capabilities) {
                capability.pinCount = Math.max(0, capability.pinCount - 1);
                if (capability.pinCount === 0
                    && capability.expired
                    && !capability.retained) {
                    expired.push(capability.capabilityId);
                }
            }
            if (expired.length > 0) {
                await this.discardUncommittedCapabilities(expired);
            }
        };
    }

    async releaseUncommitted(handleIds: readonly string[]): Promise<void> {
        const capabilityIds = handleIds.map((handleId) => {
            const record = this.catalog.get(handleId);
            if (!record) {
                throw new ManagedMediaError(
                    'SOURCE_UNREADABLE',
                    'Managed media handle was not found.',
                );
            }
            if (this.committedSourceIds.has(record.sourceId)) {
                throw new ManagedMediaError(
                    'INVALID_REQUEST',
                    'Committed media must be released through reachability-safe source GC.',
                );
            }
            return record.handle.capabilityId;
        });
        await this.discardUncommittedCapabilities(capabilityIds);
    }

    async openSource(
        sourceCapabilityId: string,
        signal?: AbortSignal,
    ): Promise<ManagedJobOpenMediaHandle> {
        return this.openCapability(sourceCapabilityId, signal);
    }

    async *listDirectory(): AsyncIterable<VerifiedMediaCandidate> {
        throw new ManagedMediaError(
            'INVALID_REQUEST',
            'The canonical media probe tool requires explicit granted paths.',
        );
    }

    async revalidateOpenSource(
        handle: ManagedJobOpenMediaHandle,
        signal?: AbortSignal,
    ): Promise<OpenMediaSnapshot> {
        throwIfAborted(signal);
        const active = this.requireActive(handle.handleId);
        this.assertCapabilityActive(active.capability);
        this.paths.assertActiveGrant(
            active.capability.grantId,
            active.capability.scope,
            'read-root',
        );
        await active.verified.verifyUnchanged();
        this.paths.assertActiveGrant(
            active.capability.grantId,
            active.capability.scope,
            'read-root',
        );
        return snapshot(active.verified);
    }

    async open(
        handleId: string,
        signal?: AbortSignal,
    ): Promise<ManagedMediaOpenLease>;
    async open(
        handle: ManagedJobOpenMediaHandle,
        signal?: AbortSignal,
    ): Promise<MediaByteSource>;
    async open(
        handleOrId: ManagedJobOpenMediaHandle | string,
        signal?: AbortSignal,
    ): Promise<MediaByteSource | ManagedMediaOpenLease> {
        if (typeof handleOrId === 'string') {
            const record = this.catalog.get(handleOrId);
            if (!record) {
                throw new ManagedMediaError('SOURCE_UNREADABLE', 'Managed media handle was not found.');
            }
            const opened = await this.openCapability(record.handle.capabilityId, signal);
            return {
                handleId: opened.handleId,
                sourceCapabilityId: record.handle.capabilityId,
                displayName: record.displayName,
                identity: record.registeredIdentity,
                fileHandle: this.requireActive(opened.handleId).verified.handle,
                assertCurrent: (assertSignal) => (
                    this.revalidateOpenSource(opened, assertSignal).then(() => undefined)
                ),
                close: opened.close,
            };
        }
        const active = this.requireActive(handleOrId.handleId);
        if (active.capability.capabilityId !== handleOrId.sourceCapabilityId) {
            throw new ManagedMediaError('PATH_NOT_GRANTED', 'Open media capability mismatch.');
        }
        let closed = false;
        const assertOpen = () => {
            if (closed) {
                throw new ManagedMediaError('SOURCE_UNREADABLE', 'Media byte source is closed.');
            }
        };
        return {
            identity: handleOrId.snapshot,
            size: async () => {
                assertOpen();
                return active.verified.identity.size;
            },
            read: async (range, readSignal) => {
                assertOpen();
                throwIfAborted(readSignal);
                assertRange(range, active.verified.identity.size);
                const bytes = Buffer.allocUnsafe(range.endExclusive - range.start);
                const result = await active.verified.handle.read(
                    bytes,
                    0,
                    bytes.byteLength,
                    range.start,
                );
                if (result.bytesRead !== bytes.byteLength) {
                    throw new ManagedMediaError('SOURCE_CHANGED', 'Media range was truncated.');
                }
                return bytes;
            },
            stream: (range = {
                start: 0,
                endExclusive: active.verified.identity.size,
            }, streamSignal) => {
                assertOpen();
                assertRange(range, active.verified.identity.size);
                return streamHandle(active.verified.handle, range, streamSignal);
            },
            verify: async (verifySignal) => {
                assertOpen();
                return this.revalidateOpenSource(handleOrId, verifySignal);
            },
            close: async () => {
                closed = true;
            },
        };
    }

    resolveProcessHandle(handleId: string): {
        readonly fileHandle: import('node:fs/promises').FileHandle;
        readonly snapshot: OpenMediaSnapshot;
        assertCurrent(signal?: AbortSignal): Promise<void>;
    } {
        const active = this.requireActive(handleId);
        return {
            fileHandle: active.verified.handle,
            snapshot: snapshot(active.verified),
            assertCurrent: async (signal) => {
                throwIfAborted(signal);
                this.assertCapabilityActive(active.capability);
                this.paths.assertActiveGrant(
                    active.capability.grantId,
                    active.capability.scope,
                    'read-root',
                );
                await active.verified.verifyUnchanged();
                this.paths.assertActiveGrant(
                    active.capability.grantId,
                    active.capability.scope,
                    'read-root',
                );
            },
        };
    }

    private async openCapability(
        sourceCapabilityId: string,
        signal?: AbortSignal,
    ): Promise<ManagedJobOpenMediaHandle> {
        throwIfAborted(signal);
        const capability = this.requireCapability(sourceCapabilityId);
        this.assertCapabilityActive(capability);
        this.paths.assertActiveGrant(capability.grantId, capability.scope, 'read-root');
        const verified = capability.retained
            ? await this.paths.openRetainedSource(
                capability.retained.sessionId,
                capability.retained.sourceId,
                capability.retained.digest,
                capability.retained.byteLength,
                { signal },
            )
            : await this.paths.openRead(
                capability.grantId,
                capability.scope,
                requireRequestedPath(capability),
                { signal },
            );
        capability.lastVerifiedDigest = normalizeDigest(verified.digest);
        try {
            this.paths.assertActiveGrant(capability.grantId, capability.scope, 'read-root');
        } catch (error) {
            await verified.close().catch(() => undefined);
            throw error;
        }
        capability.lastVerifiedIdentity = structuredClone(verified.identity);
        this.assertCapabilityActive(capability);
        const handleId = `open-media:${randomUUID()}`;
        const active: ActiveHandle = { capability, verified, closed: false };
        this.active.set(handleId, active);
        return Object.freeze({
            handleId,
            sourceCapabilityId,
            displayName: capability.displayName,
            snapshot: snapshot(verified),
            processInputCapabilityId: handleId,
            close: async () => {
                if (active.closed) return;
                active.closed = true;
                this.active.delete(handleId);
                await verified.close();
            },
        });
    }

    async discardUncommittedCapabilities(
        capabilityIds: readonly string[],
    ): Promise<void> {
        const selected = new Set(capabilityIds);
        const digestsBySession = new Map<string, Set<`sha256:${string}`>>();
        for (const capabilityId of selected) {
            const capability = this.capabilities.get(capabilityId);
            if (!capability) continue;
            const record = Array.from(this.catalog.values()).find((candidate) => (
                candidate.handle.capabilityId === capabilityId
            ));
            if (record && this.committedSourceIds.has(record.sourceId)) continue;
            if (capability.pinCount > 0) {
                capability.expired = true;
                continue;
            }
            capability.revoked = true;
            if (capability.expiryTimer) clearTimeout(capability.expiryTimer);
            if (capability.lastVerifiedDigest) {
                const digests = digestsBySession.get(capability.scope.sessionId)
                    ?? new Set<`sha256:${string}`>();
                digests.add(capability.lastVerifiedDigest);
                digestsBySession.set(capability.scope.sessionId, digests);
            }
            for (const [handleId, active] of this.active) {
                if (active.capability.capabilityId !== capabilityId) continue;
                active.closed = true;
                this.active.delete(handleId);
                await active.verified.close().catch(() => undefined);
            }
            if (record) {
                this.catalog.delete(record.handle.handleId);
                this.catalogBySource.delete(record.sourceId);
            }
            this.capabilities.delete(capabilityId);
        }
        for (const [sessionId, digests] of digestsBySession) {
            const stillReferenced = new Set(Array.from(this.capabilities.values())
                .filter((capability) => capability.scope.sessionId === sessionId)
                .flatMap((capability) => capability.lastVerifiedDigest
                    ? [capability.lastVerifiedDigest]
                    : []));
            const releasable = Array.from(digests)
                .filter((digest) => !stillReferenced.has(digest));
            if (releasable.length > 0) {
                await this.paths.releaseSourceCopies(sessionId, releasable);
            }
        }
    }

    private async expireUncommittedCapability(capabilityId: string): Promise<void> {
        const capability = this.capabilities.get(capabilityId);
        if (!capability || capability.retained) return;
        capability.expired = true;
        if (capability.pinCount === 0) {
            await this.discardUncommittedCapabilities([capabilityId]);
        }
    }

    private requireCapability(capabilityId: string): PendingCapability {
        const capability = this.capabilities.get(capabilityId);
        if (!capability) {
            throw new ManagedMediaError('PATH_NOT_GRANTED', 'Media capability was not found.');
        }
        return capability;
    }

    private requireActive(handleId: string): ActiveHandle {
        const active = this.active.get(handleId);
        if (!active || active.closed) {
            throw new ManagedMediaError('SOURCE_UNREADABLE', 'Open media handle is no longer active.');
        }
        return active;
    }

    private assertCapabilityActive(capability: PendingCapability): void {
        if (capability.revoked) {
            throw new ManagedMediaError('PATH_NOT_GRANTED', 'Media capability has been revoked.');
        }
    }
}

function requireRequestedPath(capability: PendingCapability): string {
    if (!capability.requestedPath) {
        throw new ManagedMediaError(
            'SOURCE_UNREADABLE',
            'Managed media capability has no retained or granted source.',
        );
    }
    return capability.requestedPath;
}

function snapshot(handle: VerifiedReadHandle): RegisteredImmutableMediaIdentity {
    return {
        version: 1,
        sha256: normalizeDigest(handle.digest),
        byteLength: handle.identity.size,
        statIdentity: [
            handle.identity.device,
            handle.identity.inode,
            handle.identity.size,
            handle.identity.modifiedMilliseconds,
        ].join(':'),
    };
}

function normalizeDigest(value: string): `sha256:${string}` {
    const normalized = value.startsWith('sha256:') ? value : `sha256:${value}`;
    if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
        throw new ManagedMediaError('INTERNAL_ERROR', 'Managed source digest is invalid.');
    }
    return normalized as `sha256:${string}`;
}

function boundedDisplayName(value: string): string {
    const name = value.trim();
    if (!name || name.length > 512 || name.includes('\0')) {
        throw new ManagedMediaError('INVALID_REQUEST', 'Media display name is invalid.');
    }
    return name;
}

export function inferMediaMimeType(displayName: string, mediaClass?: 'video' | 'audio'): string {
    const extension = extname(displayName).toLowerCase();
    const known: Readonly<Record<string, string>> = {
        '.aac': 'audio/aac',
        '.flac': 'audio/flac',
        '.m4a': 'audio/mp4',
        '.mkv': 'video/x-matroska',
        '.mov': 'video/quicktime',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.ogg': mediaClass === 'video' ? 'video/ogg' : 'audio/ogg',
        '.wav': 'audio/wav',
        '.webm': mediaClass === 'audio' ? 'audio/webm' : 'video/webm',
    };
    return known[extension] ?? (mediaClass === 'audio'
        ? 'application/octet-stream'
        : 'application/octet-stream');
}

export function descriptorVersion(
    identity: RegisteredImmutableMediaIdentity,
): string {
    return createHash('sha256')
        .update(`${identity.sha256}\0${identity.byteLength}\0${identity.statIdentity}`)
        .digest('hex');
}

function assertRange(range: ByteRange, size: number): void {
    if (!Number.isSafeInteger(range.start)
        || !Number.isSafeInteger(range.endExclusive)
        || range.start < 0
        || range.endExclusive <= range.start
        || range.endExclusive > size) {
        throw new RangeError('Media byte range is invalid.');
    }
}

function streamHandle(
    handle: import('node:fs/promises').FileHandle,
    range: ByteRange,
    signal?: AbortSignal,
): ReadableStream<Uint8Array> {
    let position = range.start;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                throwIfAborted(signal);
                if (position >= range.endExclusive) {
                    controller.close();
                    return;
                }
                const length = Math.min(STREAM_CHUNK_BYTES, range.endExclusive - position);
                const bytes = Buffer.allocUnsafe(length);
                const result = await handle.read(bytes, 0, length, position);
                if (result.bytesRead !== length) {
                    throw new ManagedMediaError('SOURCE_CHANGED', 'Media stream was truncated.');
                }
                position += result.bytesRead;
                controller.enqueue(bytes);
            } catch (error) {
                controller.error(error);
            }
        },
    });
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
}
