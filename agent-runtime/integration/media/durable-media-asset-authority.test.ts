import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVideoSourceFingerprint } from '../../../src/lib/video-timeline';
import type {
    EditorAssetHydration,
    EditorCommandBatchRequest,
    EditorIdempotencyReceipt,
    EditorMediaImportRequest,
    EditorPersistenceCommit,
    EditorPersistencePort,
} from '../../../src/lib/editor-engine';
import type { VideoSourceDescriptorV3 } from '../../../src/types/video';
import type {
    ManagedEditorPort,
    ManagedEditorPublicationPort,
    ManagedEditorSnapshot,
} from '../../coordinator/managed-editor-port';
import {
    MANAGED_RUNTIME_API_VERSION,
    type ManagedMutationEnvelope,
    type ManagedSourceRegistryRecord,
} from '../../coordinator/types';
import {
    CoreEditorPortFactory,
    createEmptyManagedCoreSnapshot,
    type ManagedCoreCommand,
    type ManagedCoreEditorState,
    type ManagedCoreResult,
} from '../core-editor-port';
import type {
    ManagedMediaCatalogRecord,
    ManagedMediaHandleCatalogPort,
    ManagedMediaOpenLease,
} from './contracts';
import {
    createDurableManagedMediaCatalog,
    createDurableManagedMediaCatalogRecord,
    DurableManagedMediaAssetAuthority,
    restoreDurableManagedMediaCatalog,
} from './durable-media-asset-authority';
import { descriptorVersion, PathGrantMediaAdapter } from './path-grant-media-adapter';
import { PathGrantAuthority } from '../../path-grants/path-grant-authority';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

const PROJECT_ID = 'durable-media-project';
const SESSION_ID = 'durable-media-session';
const SESSION_EPOCH = 'durable-media-epoch';
const VERIFIED_AT = '2026-07-25T16:00:00.000Z';
const publication: ManagedEditorPublicationPort = { publish: () => undefined };

type CorePort = ManagedEditorPort<ManagedCoreEditorState, ManagedCoreCommand, ManagedCoreResult>;

class MemoryPersistence implements EditorPersistencePort {
    readonly commits: EditorPersistenceCommit[] = [];
    private readonly receipts = new Map<string, EditorIdempotencyReceipt>();

    async getReceipt(
        projectId: string,
        toolName: EditorPersistenceCommit['toolName'],
        idempotencyKey: string,
    ): Promise<EditorIdempotencyReceipt | null> {
        return structuredClone(this.receipts.get(receiptKey(projectId, toolName, idempotencyKey)) ?? null);
    }

    async commit(input: EditorPersistenceCommit): Promise<void> {
        this.commits.push(structuredClone(input));
        this.receipts.set(
            receiptKey(input.projectId, input.receipt.toolName, input.receipt.key),
            structuredClone(input.receipt.value),
        );
    }
}

class CountingCatalog implements ManagedMediaHandleCatalogPort {
    readonly opened: string[] = [];
    readonly closed: string[] = [];
    readonly asserted: string[] = [];
    private readonly records = new Map<string, ManagedMediaCatalogRecord>();
    actualIdentity?: ManagedMediaCatalogRecord['registeredIdentity'];

    constructor(records: readonly ManagedMediaCatalogRecord[]) {
        records.forEach((record) => this.records.set(record.sourceId, structuredClone(record)));
    }

    get(handleId: string): ManagedMediaCatalogRecord | undefined {
        return Array.from(this.records.values()).find((record) => record.handle.handleId === handleId);
    }

    getBySourceId(sourceId: string): ManagedMediaCatalogRecord | undefined {
        const record = this.records.get(sourceId);
        return record ? structuredClone(record) : undefined;
    }

    async open(handleId: string): Promise<ManagedMediaOpenLease> {
        const record = this.get(handleId);
        if (!record) throw new Error('Unexpected source open.');
        this.opened.push(record.sourceId);
        let didClose = false;
        return {
            handleId: `lease-${record.sourceId}`,
            sourceCapabilityId: record.handle.capabilityId,
            displayName: record.displayName,
            identity: structuredClone(this.actualIdentity ?? record.registeredIdentity),
            // Core hydration must never touch source bytes. Any such access fails this test.
            fileHandle: { read: async () => { throw new Error('Hydration read source bytes.'); } } as never,
            assertCurrent: async () => { this.asserted.push(record.sourceId); },
            close: async () => {
                if (didClose) return;
                didClose = true;
                this.closed.push(record.sourceId);
            },
        };
    }

    restoreCommitted(): void {}

    pinUncommitted(): () => Promise<void> {
        return async () => undefined;
    }

    async releaseUncommitted(): Promise<void> {}

    markCommitted(): void {}

    revoke(): void {}
}

describe('durable managed media asset authority', () => {
    it('recovers retained media into Core, reads only a requested range, and keeps paths out of Core data', async () => {
        const fixture = await committedFixture();
        await rm(fixture.sourcePath);

        const restartedPaths = new PathGrantAuthority({
            privateCopyRoot: fixture.privateRoot,
            authoritySecret: Buffer.alloc(32, 5),
        });
        restartedPaths.register(fixture.grant);
        const restored = restoreDurableManagedMediaCatalog({
            projectId: PROJECT_ID,
            scope: fixture.scope,
            sourceRegistry: [sourceRegistryRecord(fixture.record)],
            grants: [fixture.grant],
            catalog: createDurableManagedMediaCatalog([
                createDurableManagedMediaCatalogRecord({
                    grantId: fixture.grant.grantId,
                    record: fixture.record,
                }),
            ]),
            pathGrants: restartedPaths,
        });
        const persistence = new MemoryPersistence();
        const port = await new CoreEditorPortFactory(restored.assetAuthority).create(
            fixture.head,
            persistence,
            publication,
        );

        const result = await dispatch(port, insertVideoCommand(port.snapshot(), fixture.record.sourceId));
        expect(result).toMatchObject({ ok: true, noOp: false });
        expect(persistence.commits).toHaveLength(1);

        const recoveredRecord = restored.media.getBySourceId(fixture.record.sourceId)!;
        const opened = await restored.media.openSource(recoveredRecord.handle.capabilityId);
        const bytes = await restored.media.open(opened);
        try {
            const range = await bytes.read({ start: 32, endExclusive: 96 });
            expect(range).toEqual(fixture.contents.subarray(32, 96));
            expect(range.byteLength).toBe(64);
        } finally {
            await bytes.close();
            await opened.close();
        }

        const exposed = JSON.stringify({ result, commits: persistence.commits, recoveredRecord });
        expect(exposed).not.toContain(fixture.root);
        expect(exposed).not.toContain(fixture.privateRoot);

        await port.close();
        await restored.close();
    });

    it('fails Core hydration before a commit when the retained copy was deleted', async () => {
        const fixture = await committedFixture();
        const retainedPath = join(
            fixture.privateRoot,
            createHash('sha256').update(SESSION_ID).digest('hex'),
            `${fixture.record.registeredIdentity.sha256.slice(7)}.source`,
        );
        await rm(retainedPath);
        const restartedPaths = new PathGrantAuthority({
            privateCopyRoot: fixture.privateRoot,
            authoritySecret: Buffer.alloc(32, 5),
        });
        restartedPaths.register(fixture.grant);
        const restored = restoreDurableManagedMediaCatalog({
            projectId: PROJECT_ID,
            scope: fixture.scope,
            sourceRegistry: [sourceRegistryRecord(fixture.record)],
            grants: [fixture.grant],
            catalog: createDurableManagedMediaCatalog([
                createDurableManagedMediaCatalogRecord({
                    grantId: fixture.grant.grantId,
                    record: fixture.record,
                }),
            ]),
            pathGrants: restartedPaths,
        });
        const persistence = new MemoryPersistence();
        const port = await new CoreEditorPortFactory(restored.assetAuthority).create(
            fixture.head,
            persistence,
            publication,
        );

        await expect(dispatch(port, insertVideoCommand(port.snapshot(), fixture.record.sourceId)))
            .resolves.toMatchObject({ ok: false, error: { code: 'SOURCE_CHANGED' } });
        expect(persistence.commits).toHaveLength(0);

        await port.close();
        await restored.close();
    });

    it('fails Core hydration before a commit when the retained copy changed', async () => {
        const fixture = await committedFixture();
        const retainedPath = join(
            fixture.privateRoot,
            createHash('sha256').update(SESSION_ID).digest('hex'),
            `${fixture.record.registeredIdentity.sha256.slice(7)}.source`,
        );
        const changed = Buffer.from(fixture.contents);
        changed[0] = changed[0] === 0x61 ? 0x62 : 0x61;
        await writeFile(retainedPath, changed);
        const restartedPaths = new PathGrantAuthority({
            privateCopyRoot: fixture.privateRoot,
            authoritySecret: Buffer.alloc(32, 5),
        });
        restartedPaths.register(fixture.grant);
        const restored = restoreDurableManagedMediaCatalog({
            projectId: PROJECT_ID,
            scope: fixture.scope,
            sourceRegistry: [sourceRegistryRecord(fixture.record)],
            grants: [fixture.grant],
            catalog: createDurableManagedMediaCatalog([
                createDurableManagedMediaCatalogRecord({
                    grantId: fixture.grant.grantId,
                    record: fixture.record,
                }),
            ]),
            pathGrants: restartedPaths,
        });
        const persistence = new MemoryPersistence();
        const port = await new CoreEditorPortFactory(restored.assetAuthority).create(
            fixture.head,
            persistence,
            publication,
        );

        await expect(dispatch(port, insertVideoCommand(port.snapshot(), fixture.record.sourceId)))
            .resolves.toMatchObject({ ok: false, error: { code: 'SOURCE_CHANGED' } });
        expect(persistence.commits).toHaveLength(0);

        await port.close();
        await restored.close();
    });

    it('hydrates only requested sources, never reads source bodies, and closes every lease on failure', async () => {
        const first = managedRecord('video-one', 'video');
        const second = managedRecord('video-two', 'video');
        const catalog = new CountingCatalog([first, second]);
        const authority = new DurableManagedMediaAssetAuthority({
            projectId: PROJECT_ID,
            scope: { sessionId: SESSION_ID, sessionEpoch: SESSION_EPOCH },
            catalog,
        });
        const head = createEmptyManagedCoreSnapshot(PROJECT_ID, SESSION_EPOCH);
        head.state.snapshot.manifest.videoSourceDescriptors = [
            first.videoDescriptor!,
            second.videoDescriptor!,
        ];
        const selected = await authority.resolve({
            projectId: PROJECT_ID,
            head,
            videoSourceIds: [first.sourceId],
            audioSourceIds: [],
        });
        expect(selected.videoSources.map((source) => source.id)).toEqual([first.sourceId]);
        expect(catalog.opened).toEqual([first.sourceId]);
        expect(catalog.asserted).toEqual([first.sourceId]);
        expect(catalog.closed).toEqual([first.sourceId]);

        catalog.actualIdentity = {
            ...first.registeredIdentity,
            statIdentity: 'changed-stat-identity',
        };
        await expect(authority.resolve({
            projectId: PROJECT_ID,
            head,
            videoSourceIds: [first.sourceId],
            audioSourceIds: [],
        })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
        expect(catalog.opened).toEqual([first.sourceId, first.sourceId]);
        expect(catalog.closed).toEqual([first.sourceId, first.sourceId]);

        await authority.close();
    });
});

async function committedFixture() {
    const root = await mkdtemp(join(tmpdir(), 'waptions-durable-media-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const inputs = join(root, 'inputs');
    const privateRoot = join(root, 'private');
    await mkdir(inputs);
    const sourcePath = join(inputs, 'clip.mp4');
    const contents = Buffer.alloc(2 * 1024 * 1024 + 97, 0x61);
    contents.write('range-boundary', 32, 'utf8');
    await writeFile(sourcePath, contents);
    const scope = { sessionId: SESSION_ID, sessionEpoch: SESSION_EPOCH };
    const paths = new PathGrantAuthority({
        privateCopyRoot: privateRoot,
        authoritySecret: Buffer.alloc(32, 5),
    });
    const grant = await paths.create(scope.sessionId, scope.sessionEpoch, 'read-root', inputs);
    const media = new PathGrantMediaAdapter(paths);
    const record = await createCommittedRecord(media, grant.grantId, scope, sourcePath);

    const initialPersistence = new MemoryPersistence();
    const initial = await new CoreEditorPortFactory().create(
        createEmptyManagedCoreSnapshot(PROJECT_ID, SESSION_EPOCH),
        initialPersistence,
        publication,
    );
    const imported = await dispatch(initial, importCommand(initial.snapshot(), record));
    expect(imported).toMatchObject({ ok: true, noOp: false });
    const head = initial.snapshot();
    await initial.close();
    return { root, privateRoot, sourcePath, contents, scope, grant, record, head };
}

async function createCommittedRecord(
    media: PathGrantMediaAdapter,
    grantId: string,
    scope: { sessionId: string; sessionEpoch: string },
    sourcePath: string,
): Promise<ManagedMediaCatalogRecord> {
    const capabilityId = media.registerProbePath({
        grantId,
        requestedPath: sourcePath,
        displayName: 'clip.mp4',
        scope,
    });
    const opened = await media.openSource(capabilityId);
    if (!opened.snapshot.sha256) throw new Error('The retained source was not digested.');
    const identity = {
        ...opened.snapshot,
        sha256: opened.snapshot.sha256,
    };
    await opened.close();
    const fileIdentity = media.capabilityIdentity(capabilityId);
    const descriptor = videoDescriptor('video-source', identity.byteLength, Math.round(fileIdentity.modifiedMilliseconds));
    const publicIdentity = {
        schemaVersion: 1 as const,
        contentDigest: identity.sha256,
        descriptorFingerprint: descriptor.fingerprint,
        byteLength: identity.byteLength,
        immutableVersion: descriptorVersion(identity),
        stableStatIdentity: {
            device: fileIdentity.device,
            fileId: fileIdentity.inode,
            modifiedNanoseconds: String(Math.round(fileIdentity.modifiedMilliseconds * 1_000_000)),
        },
        streamMetadataRefs: [{ kind: 'probe' as const, ref: 'probe:video-source' }],
    };
    const record: ManagedMediaCatalogRecord = {
        handle: {
            schemaVersion: 1,
            handleId: 'original-video-handle',
            capabilityId,
            identity: publicIdentity,
            verifiedAt: VERIFIED_AT,
        },
        sourceId: descriptor.id,
        displayName: descriptor.originalName,
        mimeType: descriptor.mimeType,
        lastModified: descriptor.lastModified,
        registeredIdentity: identity,
        metadata: videoMetadata(),
        class: 'video',
        videoDescriptor: descriptor,
    };
    media.publishCatalogRecord(capabilityId, record);
    const release = media.pinUncommitted([record.handle.handleId]);
    media.markCommitted([record.sourceId]);
    await release();
    return record;
}

function managedRecord(sourceId: string, kind: 'video'): ManagedMediaCatalogRecord {
    const descriptor = videoDescriptor(sourceId, 512, 1_700_000_000_000);
    const registeredIdentity = {
        version: 1 as const,
        sha256: `sha256:${sourceId.includes('one') ? 'a'.repeat(64) : 'b'.repeat(64)}` as `sha256:${string}`,
        byteLength: descriptor.size,
        statIdentity: `stat:${sourceId}`,
    };
    return {
        handle: {
            schemaVersion: 1,
            handleId: `handle-${sourceId}`,
            capabilityId: `capability-${sourceId}`,
            identity: {
                schemaVersion: 1,
                contentDigest: registeredIdentity.sha256,
                descriptorFingerprint: descriptor.fingerprint,
                byteLength: registeredIdentity.byteLength,
                immutableVersion: descriptorVersion(registeredIdentity),
                streamMetadataRefs: [],
            },
            verifiedAt: VERIFIED_AT,
        },
        sourceId,
        displayName: descriptor.originalName,
        mimeType: descriptor.mimeType,
        lastModified: descriptor.lastModified,
        registeredIdentity,
        metadata: videoMetadata(),
        class: kind,
        videoDescriptor: descriptor,
    };
}

function videoDescriptor(
    id: string,
    size: number,
    lastModified: number,
): VideoSourceDescriptorV3 {
    const metadata = {
        name: 'clip.mp4',
        type: 'video/mp4',
        size,
        lastModified,
    };
    return {
        id,
        originalName: metadata.name,
        mimeType: metadata.type,
        size: metadata.size,
        lastModified: metadata.lastModified,
        fingerprint: createVideoSourceFingerprint(metadata),
        duration: 1,
        fps: 30,
        width: 1_920,
        height: 1_080,
        bitrate: 5_000_000,
        hasAudio: false,
    };
}

function videoMetadata() {
    return {
        containerFormats: ['mov', 'mp4'],
        durationUs: 1_000_000,
        bitRate: 5_000_000,
        videoStreams: [{
            index: 0,
            codec: 'h264',
            width: 1_920,
            height: 1_080,
            frameRate: { numerator: 30, denominator: 1 },
            durationUs: 1_000_000,
            bitRate: 5_000_000,
        }],
        audioStreams: [],
        primaryVideoStreamIndex: 0,
    };
}

function sourceRegistryRecord(record: ManagedMediaCatalogRecord): ManagedSourceRegistryRecord {
    return {
        sourceId: record.sourceId,
        immutableVersion: record.handle.identity.immutableVersion,
        byteLength: record.registeredIdentity.byteLength,
        digest: record.registeredIdentity.sha256,
        streamSignature: record.handle.identity.descriptorFingerprint,
        registeredAt: record.handle.verifiedAt,
    };
}

function importCommand(
    snapshot: ManagedEditorSnapshot<ManagedCoreEditorState>,
    record: ManagedMediaCatalogRecord,
): Extract<ManagedCoreCommand, { kind: 'import' }> {
    const descriptor = record.videoDescriptor!;
    const hydration: EditorAssetHydration = {
        videoSources: [{
            ...descriptor,
            handle: structuredClone(record.handle),
            fileMetadata: {
                name: descriptor.originalName,
                type: descriptor.mimeType,
                size: descriptor.size,
                lastModified: descriptor.lastModified,
            },
        }],
        audioSources: [],
    };
    const request: EditorMediaImportRequest = {
        apiVersion: MANAGED_RUNTIME_API_VERSION,
        toolName: 'waptions_media_import',
        sessionEpoch: snapshot.state.snapshot.revisions.sessionEpoch,
        expected: expectedRevisions(snapshot),
        idempotencyKey: 'initial-import',
        sources: { videoSourceDescriptors: [descriptor], audioSourceDescriptors: [] },
        placement: { kind: 'register-only' },
    };
    return { kind: 'import', request, hydration };
}

function insertVideoCommand(
    snapshot: ManagedEditorSnapshot<ManagedCoreEditorState>,
    sourceId: string,
): Extract<ManagedCoreCommand, { kind: 'dispatch' }> {
    const request: EditorCommandBatchRequest = {
        apiVersion: MANAGED_RUNTIME_API_VERSION,
        toolName: 'waptions_edit_apply',
        sessionEpoch: snapshot.state.snapshot.revisions.sessionEpoch,
        expected: expectedRevisions(snapshot),
        idempotencyKey: `insert-${sourceId}`,
        operations: [{
            operationId: 'insert-video',
            type: 'video-clip.insert',
            payload: {
                clipId: 'clip-1',
                sourceId,
                trackId: 'video-track-1',
                timelineStartFrame: 0,
                sourceStartSeconds: 0,
                sourceEndSeconds: 1,
                audio: null,
            },
        }],
    };
    return { kind: 'dispatch', request };
}

async function dispatch(
    port: CorePort,
    command: Exclude<ManagedCoreCommand, { kind: 'plan' }>,
): Promise<ManagedCoreResult> {
    const request = command.request;
    const envelope: ManagedMutationEnvelope<ManagedCoreCommand> = {
        apiVersion: MANAGED_RUNTIME_API_VERSION,
        sessionId: SESSION_ID,
        sessionEpoch: request.sessionEpoch,
        expected: expectedRevisions(port.snapshot()),
        idempotencyKey: request.idempotencyKey,
        toolName: request.toolName,
        canonicalRequestHash: `sha256:${'c'.repeat(64)}`,
        command,
    };
    return port.dispatch({ command, request: envelope });
}

function expectedRevisions(
    snapshot: ManagedEditorSnapshot<ManagedCoreEditorState>,
): EditorCommandBatchRequest['expected'] {
    return {
        sessionRevision: snapshot.state.snapshot.revisions.sessionRevision,
        documentRevision: snapshot.state.snapshot.revisions.documentRevision,
        audioGraphRevision: snapshot.state.snapshot.revisions.audioGraphRevision,
    };
}

function receiptKey(projectId: string, toolName: string, idempotencyKey: string): string {
    return `${projectId}\0${toolName}\0${idempotencyKey}`;
}
