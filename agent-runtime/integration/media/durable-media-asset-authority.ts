import { createHash } from 'node:crypto';
import { EditorCommandError, type EditorAssetHydration } from '../../../src/lib/editor-engine';
import type {
    AudioSourceDescriptor,
    VideoSourceDescriptorV3,
} from '../../../src/types/video';
import type {
    ImmutableMediaIdentityV1,
    VerifiedMediaHandleV1,
} from '../../../src/types/waptions-agent-protocol';
import type {
    ManagedCoreAssetAuthority,
    ManagedCoreAssetAuthorityRequest,
} from '../core-editor-port';
import type { ManagedSourceRegistryRecord } from '../../coordinator/types';
import { ManagedMediaError } from '../../media/errors';
import { canonicalDigest } from '../../persistence/canonical-json';
import type { PathGrantAuthority, PathGrantScope, SessionPathGrantRecord } from '../../path-grants/path-grant-authority';
import type { RegisteredImmutableMediaIdentity, MediaProbeMetadata } from '../../source-registry/contracts';
import type {
    ManagedMediaCatalogRecord,
    ManagedMediaHandleCatalogPort,
    ManagedMediaOpenLease,
} from './contracts';
import { descriptorVersion, PathGrantMediaAdapter } from './path-grant-media-adapter';

export const DURABLE_MANAGED_MEDIA_CATALOG_VERSION = 1 as const;

/**
 * Path-free media material that the runtime composition persists alongside a Core import commit.
 * Handles are deliberately recreated on recovery so a previous process cannot be impersonated.
 */
export interface DurableManagedMediaCatalogRecord {
    readonly schemaVersion: typeof DURABLE_MANAGED_MEDIA_CATALOG_VERSION;
    readonly sourceId: string;
    readonly grantId: string;
    readonly displayName: string;
    readonly mimeType: string;
    readonly lastModified: number;
    readonly registeredIdentity: RegisteredImmutableMediaIdentity;
    readonly identity: ImmutableMediaIdentityV1;
    readonly verifiedAt: string;
    readonly metadata: MediaProbeMetadata;
    readonly class: 'video' | 'audio';
    readonly videoDescriptor?: VideoSourceDescriptorV3;
    readonly audioDescriptor?: AudioSourceDescriptor;
}

export interface DurableManagedMediaCatalog {
    readonly schemaVersion: typeof DURABLE_MANAGED_MEDIA_CATALOG_VERSION;
    readonly records: readonly DurableManagedMediaCatalogRecord[];
}

export interface RestoreDurableManagedMediaCatalogInput {
    readonly projectId: string;
    readonly scope: PathGrantScope;
    readonly sourceRegistry: readonly ManagedSourceRegistryRecord[];
    /** Durable path-grant records already registered with the supplied authority. */
    readonly grants: readonly SessionPathGrantRecord[];
    readonly catalog: DurableManagedMediaCatalog;
    readonly pathGrants: PathGrantAuthority;
    /** Shared process catalog used by production review/render/transcription. */
    readonly media?: PathGrantMediaAdapter;
}

export interface RestoredDurableManagedMediaCatalog {
    readonly media: PathGrantMediaAdapter;
    readonly assetAuthority: DurableManagedMediaAssetAuthority;
    close(): Promise<void>;
}

/**
 * Produces the path-free durable value that composition writes with a successful media import.
 * `grantId` is opaque authority metadata; callers must never include the grant's canonical path.
 */
export function createDurableManagedMediaCatalogRecord(input: {
    readonly grantId: string;
    readonly record: ManagedMediaCatalogRecord;
}): DurableManagedMediaCatalogRecord {
    const record = input.record;
    const durable: DurableManagedMediaCatalogRecord = {
        schemaVersion: DURABLE_MANAGED_MEDIA_CATALOG_VERSION,
        sourceId: record.sourceId,
        grantId: input.grantId,
        displayName: record.displayName,
        mimeType: record.mimeType,
        lastModified: record.lastModified,
        registeredIdentity: structuredClone(record.registeredIdentity),
        identity: structuredClone(record.handle.identity),
        verifiedAt: record.handle.verifiedAt,
        metadata: structuredClone(record.metadata),
        class: record.class,
        ...(record.videoDescriptor
            ? { videoDescriptor: structuredClone(record.videoDescriptor) }
            : {}),
        ...(record.audioDescriptor
            ? { audioDescriptor: structuredClone(record.audioDescriptor) }
            : {}),
    };
    assertDurableRecord(durable);
    return Object.freeze(durable);
}

export function createDurableManagedMediaCatalog(
    records: readonly DurableManagedMediaCatalogRecord[],
): DurableManagedMediaCatalog {
    const cloned = records.map((record) => structuredClone(record));
    const sourceIds = new Set<string>();
    for (const record of cloned) {
        assertDurableRecord(record);
        if (sourceIds.has(record.sourceId)) {
            throw new ManagedMediaError('INVALID_REQUEST', 'The durable media catalog has duplicate sources.');
        }
        sourceIds.add(record.sourceId);
    }
    return Object.freeze({
        schemaVersion: DURABLE_MANAGED_MEDIA_CATALOG_VERSION,
        records: Object.freeze(cloned),
    });
}

/**
 * Rebuilds the in-memory capability catalog from durable, path-free material. The supplied
 * PathGrantAuthority must already have registered the recovered grant records for this session.
 */
export function restoreDurableManagedMediaCatalog(
    input: RestoreDurableManagedMediaCatalogInput,
): RestoredDurableManagedMediaCatalog {
    assertRestoreInput(input);
    const media = input.media ?? new PathGrantMediaAdapter(input.pathGrants);
    const registry = activeRegistryBySource(input.sourceRegistry);
    const grants = grantsById(input.grants, input.scope);
    const durable = createDurableManagedMediaCatalog(input.catalog.records);

    if (registry.size !== durable.records.length) {
        throw new ManagedMediaError(
            'SOURCE_UNREADABLE',
            'The durable media catalog does not cover every active registered source.',
        );
    }

    for (const persisted of durable.records) {
        const source = registry.get(persisted.sourceId);
        const grant = grants.get(persisted.grantId);
        if (!source || !grant) {
            throw new ManagedMediaError(
                'SOURCE_UNREADABLE',
                'A restored media source is missing its immutable registry or grant binding.',
            );
        }
        assertRegistryIdentity(persisted, source);
        input.pathGrants.assertActiveGrant(persisted.grantId, input.scope, 'read-root');
        media.restoreCommitted({
            grantId: persisted.grantId,
            scope: input.scope,
            record: toManagedCatalogRecord(persisted, input.scope),
        });
    }

    const assetAuthority = new DurableManagedMediaAssetAuthority({
        projectId: input.projectId,
        scope: input.scope,
        catalog: media,
    });
    return Object.freeze({
        media,
        assetAuthority,
        close: () => assetAuthority.close(),
    });
}

/**
 * Project-scoped authority passed to CoreEditorPortFactory. It opens no source until Core asks
 * for its source ID, and leases are always closed before Core receives hydration descriptors.
 */
export class DurableManagedMediaAssetAuthority implements ManagedCoreAssetAuthority {
    private closed = false;

    constructor(private readonly input: {
        readonly projectId: string;
        readonly scope: PathGrantScope;
        readonly catalog: ManagedMediaHandleCatalogPort;
    }) {}

    async resolve(request: ManagedCoreAssetAuthorityRequest): Promise<EditorAssetHydration> {
        if (this.closed) {
            throw new EditorCommandError('COORDINATOR_UNAVAILABLE', 'Managed media authority is closed.');
        }
        if (request.projectId !== this.input.projectId
            || request.head.state.snapshot.projectId !== this.input.projectId
            || request.head.state.sessionState.sessionEpoch !== this.input.scope.sessionEpoch) {
            throw new EditorCommandError('SOURCE_CHANGED', 'Managed media authority scope does not match Core.');
        }
        const required = requestedSources(request);
        const leases: ManagedMediaOpenLease[] = [];
        let failure: unknown;
        try {
            const videoSources = await this.hydrateKind(
                request,
                required.videoSourceIds,
                'video',
                leases,
            ) as EditorAssetHydration['videoSources'];
            const audioSources = await this.hydrateKind(
                request,
                required.audioSourceIds,
                'audio',
                leases,
            ) as EditorAssetHydration['audioSources'];
            return { videoSources, audioSources };
        } catch (error) {
            failure = error;
            throw asCoreAssetError(error);
        } finally {
            const closeFailures = await closeLeases(leases);
            if (!failure && closeFailures.length > 0) {
                throw new AggregateError(closeFailures, 'Managed media hydration could not close its leases.');
            }
        }
    }

    async close(): Promise<void> {
        this.closed = true;
    }

    private async hydrateKind(
        request: ManagedCoreAssetAuthorityRequest,
        sourceIds: readonly string[],
        kind: 'video' | 'audio',
        leases: ManagedMediaOpenLease[],
    ): Promise<EditorAssetHydration['videoSources'] | EditorAssetHydration['audioSources']> {
        const descriptors = new Map((kind === 'video'
            ? request.head.state.snapshot.manifest.videoSourceDescriptors
            : request.head.state.snapshot.manifest.audioSourceDescriptors
        ).map((descriptor) => [descriptor.id, descriptor]));
        const hydrated = [] as EditorAssetHydration['videoSources'];
        for (const sourceId of sourceIds) {
            const descriptor = descriptors.get(sourceId);
            const record = this.input.catalog.getBySourceId(sourceId);
            if (!descriptor || !record || record.class !== kind) {
                throw new ManagedMediaError('SOURCE_UNREADABLE', 'A requested managed media source is unavailable.');
            }
            assertRecordMatchesDescriptor(record, descriptor, kind);
            let lease: ManagedMediaOpenLease;
            try {
                lease = await this.input.catalog.open(record.handle.handleId);
            } catch (error) {
                throw unavailableSource(error);
            }
            leases.push(lease);
            await lease.assertCurrent();
            assertLeaseMatchesRecord(lease, record);
            hydrated.push(recordHydration(record) as EditorAssetHydration['videoSources'][number]);
        }
        return hydrated;
    }
}

function toManagedCatalogRecord(
    persisted: DurableManagedMediaCatalogRecord,
    scope: PathGrantScope,
): ManagedMediaCatalogRecord {
    const stableSuffix = createHash('sha256')
        .update(scope.sessionId)
        .update('\0')
        .update(scope.sessionEpoch)
        .update('\0')
        .update(persisted.sourceId)
        .digest('hex')
        .slice(0, 32);
    const handle: VerifiedMediaHandleV1 = {
        schemaVersion: 1,
        handleId: `recovered-media:${stableSuffix}`,
        capabilityId: `recovered-capability:${stableSuffix}`,
        identity: structuredClone(persisted.identity),
        verifiedAt: persisted.verifiedAt,
    };
    return Object.freeze({
        handle: Object.freeze(handle),
        sourceId: persisted.sourceId,
        displayName: persisted.displayName,
        mimeType: persisted.mimeType,
        lastModified: persisted.lastModified,
        registeredIdentity: structuredClone(persisted.registeredIdentity),
        metadata: structuredClone(persisted.metadata),
        class: persisted.class,
        ...(persisted.videoDescriptor
            ? { videoDescriptor: structuredClone(persisted.videoDescriptor) }
            : {}),
        ...(persisted.audioDescriptor
            ? { audioDescriptor: structuredClone(persisted.audioDescriptor) }
            : {}),
    });
}

function requestedSources(request: ManagedCoreAssetAuthorityRequest): {
    readonly videoSourceIds: readonly string[];
    readonly audioSourceIds: readonly string[];
} {
    const videoSourceIds = uniqueSourceIds(request.videoSourceIds);
    const audioSourceIds = uniqueSourceIds(request.audioSourceIds);
    if (videoSourceIds.some((sourceId) => audioSourceIds.includes(sourceId))) {
        throw new ManagedMediaError('INVALID_REQUEST', 'One source cannot hydrate as both video and audio.');
    }
    return { videoSourceIds, audioSourceIds };
}

function uniqueSourceIds(sourceIds: readonly string[]): readonly string[] {
    if (new Set(sourceIds).size !== sourceIds.length || sourceIds.some((sourceId) => !validId(sourceId))) {
        throw new ManagedMediaError('INVALID_REQUEST', 'Managed media hydration source IDs are invalid.');
    }
    return [...sourceIds];
}

function recordHydration(record: ManagedMediaCatalogRecord) {
    const descriptor = record.videoDescriptor ?? record.audioDescriptor;
    if (!descriptor) {
        throw new ManagedMediaError('SOURCE_UNREADABLE', 'Managed media source has no descriptor.');
    }
    return {
        ...structuredClone(descriptor),
        handle: structuredClone(record.handle),
        fileMetadata: {
            name: descriptor.originalName,
            type: descriptor.mimeType,
            size: descriptor.size,
            lastModified: descriptor.lastModified,
        },
    };
}

function assertRestoreInput(input: RestoreDurableManagedMediaCatalogInput): void {
    if (!validId(input.projectId)
        || !validId(input.scope.sessionId)
        || !validId(input.scope.sessionEpoch)
        || input.catalog.schemaVersion !== DURABLE_MANAGED_MEDIA_CATALOG_VERSION) {
        throw new ManagedMediaError('INVALID_REQUEST', 'The durable media recovery input is invalid.');
    }
}

function activeRegistryBySource(
    records: readonly ManagedSourceRegistryRecord[],
): Map<string, ManagedSourceRegistryRecord> {
    const active = new Map<string, ManagedSourceRegistryRecord>();
    for (const record of records) {
        if (record.releasedAt) continue;
        if (!validId(record.sourceId) || active.has(record.sourceId)) {
            throw new ManagedMediaError('INVALID_REQUEST', 'The durable source registry is invalid.');
        }
        active.set(record.sourceId, record);
    }
    return active;
}

function grantsById(
    records: readonly SessionPathGrantRecord[],
    scope: PathGrantScope,
): Map<string, SessionPathGrantRecord> {
    const grants = new Map<string, SessionPathGrantRecord>();
    for (const record of records) {
        if (record.kind !== 'read-root' || record.revokedAt) continue;
        if (record.sessionId !== scope.sessionId
            || record.sessionEpoch !== scope.sessionEpoch
            || grants.has(record.grantId)) {
            throw new ManagedMediaError('PATH_NOT_GRANTED', 'The durable media grant binding is invalid.');
        }
        grants.set(record.grantId, record);
    }
    return grants;
}

function assertDurableRecord(record: DurableManagedMediaCatalogRecord): void {
    if (record.schemaVersion !== DURABLE_MANAGED_MEDIA_CATALOG_VERSION
        || !validId(record.sourceId)
        || !validId(record.grantId)
        || !validDisplayName(record.displayName)
        || !validMimeType(record.mimeType)
        || !Number.isSafeInteger(record.lastModified)
        || record.lastModified < 0
        || !validIdentity(record.registeredIdentity)
        || !validPublicIdentity(record.identity)
        || !validMetadata(record.metadata)
        || !Number.isFinite(Date.parse(record.verifiedAt))) {
        throw new ManagedMediaError('INVALID_REQUEST', 'The durable media catalog record is invalid.');
    }
    if (record.class === 'video') {
        if (!record.videoDescriptor || record.audioDescriptor || record.metadata.videoStreams.length === 0) {
            throw new ManagedMediaError('INVALID_REQUEST', 'The durable video catalog record is invalid.');
        }
        assertRecordMatchesDescriptor(toManagedCatalogRecord(record, {
            sessionId: 'validation',
            sessionEpoch: 'validation',
        }), record.videoDescriptor, 'video');
    } else if (record.class === 'audio') {
        if (!record.audioDescriptor || record.videoDescriptor || record.metadata.audioStreams.length === 0) {
            throw new ManagedMediaError('INVALID_REQUEST', 'The durable audio catalog record is invalid.');
        }
        assertRecordMatchesDescriptor(toManagedCatalogRecord(record, {
            sessionId: 'validation',
            sessionEpoch: 'validation',
        }), record.audioDescriptor, 'audio');
    } else {
        throw new ManagedMediaError('INVALID_REQUEST', 'The durable media class is invalid.');
    }
    if (record.identity.contentDigest !== record.registeredIdentity.sha256
        || record.identity.byteLength !== record.registeredIdentity.byteLength
        || record.identity.immutableVersion !== descriptorVersion(record.registeredIdentity)) {
        throw new ManagedMediaError('SOURCE_CHANGED', 'The durable media identity is inconsistent.');
    }
}

function assertRegistryIdentity(
    persisted: DurableManagedMediaCatalogRecord,
    source: ManagedSourceRegistryRecord,
): void {
    if (source.digest !== persisted.registeredIdentity.sha256
        || source.byteLength !== persisted.registeredIdentity.byteLength
        || source.immutableVersion !== persisted.identity.immutableVersion
        || source.streamSignature !== persisted.identity.descriptorFingerprint) {
        throw new ManagedMediaError('SOURCE_CHANGED', 'The durable source registry identity changed.');
    }
}

function assertRecordMatchesDescriptor(
    record: ManagedMediaCatalogRecord,
    descriptor: VideoSourceDescriptorV3 | AudioSourceDescriptor,
    kind: 'video' | 'audio',
): void {
    const recordedDescriptor = kind === 'video' ? record.videoDescriptor : record.audioDescriptor;
    if (!recordedDescriptor
        || record.class !== kind
        || canonicalDigest(recordedDescriptor) !== canonicalDigest(descriptor)
        || record.sourceId !== descriptor.id
        || record.displayName !== descriptor.originalName
        || record.mimeType !== descriptor.mimeType
        || record.lastModified !== descriptor.lastModified
        || record.registeredIdentity.byteLength !== descriptor.size
        || record.handle.identity.contentDigest !== record.registeredIdentity.sha256
        || record.handle.identity.byteLength !== record.registeredIdentity.byteLength
        || record.handle.identity.descriptorFingerprint !== descriptor.fingerprint
        || record.handle.identity.immutableVersion !== descriptorVersion(record.registeredIdentity)) {
        throw new ManagedMediaError('SOURCE_CHANGED', 'Managed media descriptor identity changed.');
    }
}

function assertLeaseMatchesRecord(
    lease: ManagedMediaOpenLease,
    record: ManagedMediaCatalogRecord,
): void {
    const expected = record.registeredIdentity;
    const actual = lease.identity;
    if (lease.handleId.length === 0
        || lease.sourceCapabilityId !== record.handle.capabilityId
        || expected.sha256 !== actual.sha256
        || expected.byteLength !== actual.byteLength
        || expected.statIdentity !== actual.statIdentity) {
        throw new ManagedMediaError('SOURCE_CHANGED', 'Managed media changed during Core hydration.');
    }
}

async function closeLeases(leases: readonly ManagedMediaOpenLease[]): Promise<unknown[]> {
    const settled = await Promise.allSettled(leases.map((lease) => lease.close()));
    return settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
}

function validIdentity(identity: RegisteredImmutableMediaIdentity): boolean {
    return Boolean(identity)
        && identity.version === 1
        && /^sha256:[a-f0-9]{64}$/.test(identity.sha256)
        && Number.isSafeInteger(identity.byteLength)
        && identity.byteLength >= 0
        && typeof identity.statIdentity === 'string'
        && identity.statIdentity.length > 0
        && identity.statIdentity.length <= 512;
}

function validPublicIdentity(identity: ImmutableMediaIdentityV1): boolean {
    return Boolean(identity)
        && identity.schemaVersion === 1
        && /^sha256:[a-f0-9]{64}$/.test(identity.contentDigest)
        && Number.isSafeInteger(identity.byteLength)
        && identity.byteLength >= 0
        && typeof identity.descriptorFingerprint === 'string'
        && identity.descriptorFingerprint.length > 0
        && identity.descriptorFingerprint.length <= 512
        && typeof identity.immutableVersion === 'string'
        && identity.immutableVersion.length > 0
        && identity.immutableVersion.length <= 512
        && Array.isArray(identity.streamMetadataRefs);
}

function validMetadata(metadata: MediaProbeMetadata): boolean {
    return Boolean(metadata)
        && Array.isArray(metadata.containerFormats)
        && Number.isSafeInteger(metadata.durationUs)
        && metadata.durationUs > 0
        && Array.isArray(metadata.videoStreams)
        && Array.isArray(metadata.audioStreams);
}

function validId(value: string): boolean {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 200
        && !value.includes('\0')
        && !value.includes('/')
        && !value.includes('\\');
}

function validDisplayName(value: string): boolean {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 512
        && !value.includes('\0')
        && !value.includes('/')
        && !value.includes('\\');
}

function validMimeType(value: string): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= 255;
}

function unavailableSource(error: unknown): unknown {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        return new ManagedMediaError('SOURCE_UNREADABLE', 'The retained managed media source is missing.');
    }
    return error;
}

function asCoreAssetError(error: unknown): Error {
    if (error instanceof EditorCommandError) return error;
    if ((error as { code?: unknown } | undefined)?.code === 'SOURCE_CHANGED') {
        return new EditorCommandError('SOURCE_CHANGED', 'The retained managed media source changed.', {
            cause: error,
        });
    }
    if (error instanceof ManagedMediaError) {
        if (error.code === 'SOURCE_CHANGED' || error.code === 'SOURCE_UNREADABLE') {
            return new EditorCommandError('SOURCE_CHANGED', error.message, {
                retryable: error.retryable,
                cause: error,
            });
        }
        if (error.code === 'INVALID_REQUEST') {
            return new EditorCommandError('INVALID_DOCUMENT', error.message, { cause: error });
        }
    }
    return new EditorCommandError('INTERNAL_ERROR', 'Managed media hydration failed.', { cause: error });
}
