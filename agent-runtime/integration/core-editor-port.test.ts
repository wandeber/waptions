import { describe, expect, it } from 'vitest';
import { createVideoSourceFingerprint } from '../../src/lib/video-timeline';
import {
    EditorCommandError,
    type EditorAssetHydration,
    type EditorCommandBatchRequest,
    type EditorEngineSnapshot,
    type EditorIdempotencyReceipt,
    type EditorMediaImportRequest,
    type EditorPersistenceCommit,
    type EditorPersistencePort,
} from '../../src/lib/editor-engine';
import type { VideoSourceDescriptorV3 } from '../../src/types/video';
import type {
    ManagedEditorPort,
    ManagedEditorPublicationPort,
    ManagedEditorSnapshot,
} from '../coordinator/managed-editor-port';
import {
    MANAGED_RUNTIME_API_VERSION,
    type ManagedMutationEnvelope,
} from '../coordinator/types';
import {
    CoreEditorPortFactory,
    createEmptyManagedCoreSnapshot,
    type ManagedCoreAssetAuthority,
    type ManagedCoreAssetAuthorityRequest,
    type ManagedCoreCommand,
    type ManagedCoreEditorState,
    type ManagedCoreResult,
} from './core-editor-port';

const PROJECT_ID = 'managed-core-project';
const SESSION_EPOCH = 'managed-core-epoch';
const NOW_ISO = '2026-07-25T16:00:00.000Z';

type CorePort = ManagedEditorPort<
    ManagedCoreEditorState,
    ManagedCoreCommand,
    ManagedCoreResult
>;

class MemoryPersistence implements EditorPersistencePort {
    readonly commits: EditorPersistenceCommit[] = [];
    readonly receipts = new Map<string, EditorIdempotencyReceipt>();

    async getReceipt(
        projectId: string,
        toolName: EditorPersistenceCommit['toolName'],
        idempotencyKey: string,
    ): Promise<EditorIdempotencyReceipt | null> {
        return structuredClone(
            this.receipts.get(receiptKey(projectId, toolName, idempotencyKey)) ?? null,
        );
    }

    async commit(input: EditorPersistenceCommit): Promise<void> {
        const commit = structuredClone(input);
        this.commits.push(commit);
        this.receipts.set(
            receiptKey(input.projectId, input.receipt.toolName, input.receipt.key),
            structuredClone(input.receipt.value),
        );
    }
}

class ExactAssetAuthority implements ManagedCoreAssetAuthority {
    readonly calls: ManagedCoreAssetAuthorityRequest[] = [];
    readonly videoSources = new Map<
        string,
        EditorAssetHydration['videoSources'][number]
    >();
    rejectSourceId: string | null = null;

    remember(hydration: EditorAssetHydration): void {
        hydration.videoSources.forEach((source) => {
            this.videoSources.set(source.id, structuredClone(source));
        });
    }

    async resolve(request: ManagedCoreAssetAuthorityRequest): Promise<EditorAssetHydration> {
        this.calls.push(structuredClone(request));
        if (
            this.rejectSourceId
            && (
                request.videoSourceIds.includes(this.rejectSourceId)
                || request.audioSourceIds.includes(this.rejectSourceId)
            )
        ) {
            throw new EditorCommandError(
                'SOURCE_CHANGED',
                'The retained source no longer matches its registered immutable identity.',
                { details: { ids: [this.rejectSourceId] } },
            );
        }
        return {
            videoSources: request.videoSourceIds.flatMap((sourceId) => {
                const source = this.videoSources.get(sourceId);
                return source ? [structuredClone(source)] : [];
            }),
            audioSources: [],
        };
    }
}

const publication: ManagedEditorPublicationPort = {
    publish: () => undefined,
};

describe('CoreEditorPort managed asset authority', () => {
    it('hydrates a newly imported source from the current project head for a same-process edit', async () => {
        const source = videoDescriptor('same-process-source');
        const sourceHydration = hydration(source);
        const authority = new ExactAssetAuthority();
        authority.remember(sourceHydration);
        const persistence = new MemoryPersistence();
        const port = await createPort(persistence, authority);

        const imported = await dispatch(
            port,
            importCommand(port.snapshot(), source, sourceHydration, 'same-process-import'),
        );
        expect(imported).toMatchObject({ ok: true, noOp: false });

        const edited = await dispatch(
            port,
            insertVideoCommand(port.snapshot(), source.id, 'same-process-edit'),
        );

        expect(edited).toMatchObject({ ok: true, noOp: false });
        expect(persistence.commits).toHaveLength(2);
        expect(authority.calls).toHaveLength(1);
        expect(authority.calls[0]).toMatchObject({
            projectId: PROJECT_ID,
            videoSourceIds: [source.id],
            audioSourceIds: [],
        });
        expect(
            authority.calls[0].head.state.snapshot.manifest.videoSourceDescriptors,
        ).toContainEqual(source);
        expect(port.snapshot().state.snapshot.manifest.videoClips).toHaveLength(1);

        await port.close();
    });

    it('reimports against the exact retained identity after a port restart', async () => {
        const source = videoDescriptor('restart-source');
        const sourceHydration = hydration(source);
        const authority = new ExactAssetAuthority();
        authority.remember(sourceHydration);
        const persistence = new MemoryPersistence();
        const factory = new CoreEditorPortFactory(authority);
        const first = await factory.create(
            createEmptyManagedCoreSnapshot(PROJECT_ID, SESSION_EPOCH),
            persistence,
            publication,
        );

        const imported = await dispatch(
            first,
            importCommand(first.snapshot(), source, sourceHydration, 'restart-import'),
        );
        expect(imported).toMatchObject({ ok: true, noOp: false });
        const restartedSnapshot = first.rebaseSession?.(first.snapshot(), {
            sessionEpoch: 'managed-core-restart-epoch',
            sessionRevision: first.snapshot().state.snapshot.revisions.sessionRevision,
        });
        expect(restartedSnapshot).toBeDefined();
        await first.close();

        const restarted = await factory.create(
            restartedSnapshot!,
            persistence,
            publication,
        );
        const reimported = await dispatch(
            restarted,
            importCommand(restarted.snapshot(), source, sourceHydration, 'restart-reimport'),
        );

        expect(reimported).toMatchObject({
            ok: true,
            noOp: true,
            noOpReason: 'sources-already-registered',
        });
        expect(authority.calls).toHaveLength(1);
        expect(authority.calls[0].head.state.snapshot.revisions.sessionEpoch)
            .toBe('managed-core-restart-epoch');
        expect(persistence.commits).toHaveLength(2);

        await restarted.close();
    });

    it('rejects changed retained media and fails closed when no authority is installed', async () => {
        const source = videoDescriptor('changed-source');
        const sourceHydration = hydration(source);
        const authority = new ExactAssetAuthority();
        authority.remember(sourceHydration);
        const persistence = new MemoryPersistence();
        const port = await createPort(persistence, authority);

        await dispatch(
            port,
            importCommand(port.snapshot(), source, sourceHydration, 'changed-import'),
        );
        authority.rejectSourceId = source.id;
        const rejected = await dispatch(
            port,
            insertVideoCommand(port.snapshot(), source.id, 'changed-edit'),
        );
        expect(rejected).toMatchObject({
            ok: false,
            error: { code: 'SOURCE_CHANGED' },
        });
        expect(persistence.commits).toHaveLength(1);

        const importedHead = port.snapshot();
        await port.close();
        const unavailablePersistence = new MemoryPersistence();
        const unavailable = await new CoreEditorPortFactory().create(
            importedHead,
            unavailablePersistence,
            publication,
        );
        const failedClosed = await dispatch(
            unavailable,
            insertVideoCommand(unavailable.snapshot(), source.id, 'authority-missing-edit'),
        );
        expect(failedClosed).toMatchObject({
            ok: false,
            error: { code: 'COORDINATOR_UNAVAILABLE' },
        });
        expect(unavailablePersistence.commits).toHaveLength(0);

        await unavailable.close();
    });

    it('preserves current, history-only, and redo-only source and transcript pins on rebase', async () => {
        const snapshot = createEmptyManagedCoreSnapshot(PROJECT_ID, SESSION_EPOCH);
        snapshot.state.snapshot.assetReferences = {
            videoSourceIds: ['source-current'],
            audioSourceIds: [],
            transcriptRecordIds: ['transcript-current'],
        };
        snapshot.state.sourcePins = {
            current: {
                videoSourceIds: ['source-current'],
                audioSourceIds: [],
            },
            history: {
                videoSourceIds: ['source-history'],
                audioSourceIds: ['audio-history'],
            },
            redo: {
                videoSourceIds: ['source-redo'],
                audioSourceIds: ['audio-redo'],
            },
        };
        snapshot.state.transcriptPins = {
            durableRecordIds: ['transcript-current'],
            historyRecordIds: ['transcript-history'],
            redoRecordIds: ['transcript-redo'],
        };
        const port = await createPort(new MemoryPersistence());

        const rebased = port.rebaseSession?.(snapshot, {
            sessionEpoch: 'rebased-epoch',
            sessionRevision: 7,
            eventSequence: 9,
        });

        expect(rebased?.reachableSourceIds).toEqual([
            'source-current',
            'source-history',
            'audio-history',
            'source-redo',
            'audio-redo',
        ]);
        expect(rebased?.transcriptRecordIds).toEqual([
            'transcript-current',
            'transcript-history',
            'transcript-redo',
        ]);

        await port.close();
    });
});

async function createPort(
    persistence: EditorPersistencePort,
    authority?: ManagedCoreAssetAuthority,
): Promise<CorePort> {
    return new CoreEditorPortFactory(authority).create(
        createEmptyManagedCoreSnapshot(PROJECT_ID, SESSION_EPOCH),
        persistence,
        publication,
    );
}

async function dispatch(
    port: CorePort,
    command: Exclude<ManagedCoreCommand, { kind: 'plan' }>,
): Promise<ManagedCoreResult> {
    const request = command.request;
    const envelope: ManagedMutationEnvelope<ManagedCoreCommand> = {
        apiVersion: MANAGED_RUNTIME_API_VERSION,
        sessionId: 'managed-core-session',
        sessionEpoch: request.sessionEpoch,
        expected: {
            sessionRevision: request.expected.sessionRevision,
            documentRevision: request.expected.documentRevision,
            audioGraphRevision: request.expected.audioGraphRevision,
            narrativeRevision: request.expected.narrativeRevision,
        },
        idempotencyKey: request.idempotencyKey,
        toolName: request.toolName,
        canonicalRequestHash: `sha256:${'a'.repeat(64)}`,
        command,
    };
    return port.dispatch({ command, request: envelope });
}

function importCommand(
    snapshot: ManagedEditorSnapshot<ManagedCoreEditorState>,
    source: VideoSourceDescriptorV3,
    sourceHydration: EditorAssetHydration,
    idempotencyKey: string,
): Extract<ManagedCoreCommand, { kind: 'import' }> {
    const request: EditorMediaImportRequest = {
        apiVersion: '2026-07-25',
        toolName: 'waptions_media_import',
        sessionEpoch: snapshot.state.snapshot.revisions.sessionEpoch,
        expected: expectedRevisions(snapshot.state.snapshot),
        idempotencyKey,
        sources: {
            videoSourceDescriptors: [structuredClone(source)],
            audioSourceDescriptors: [],
        },
        placement: { kind: 'register-only' },
    };
    return {
        kind: 'import',
        request,
        hydration: structuredClone(sourceHydration),
    };
}

function insertVideoCommand(
    snapshot: ManagedEditorSnapshot<ManagedCoreEditorState>,
    sourceId: string,
    idempotencyKey: string,
): Extract<ManagedCoreCommand, { kind: 'dispatch' }> {
    const request: EditorCommandBatchRequest = {
        apiVersion: '2026-07-25',
        toolName: 'waptions_edit_apply',
        sessionEpoch: snapshot.state.snapshot.revisions.sessionEpoch,
        expected: expectedRevisions(snapshot.state.snapshot),
        idempotencyKey,
        operations: [{
            operationId: 'insert-video',
            type: 'video-clip.insert',
            payload: {
                clipId: 'video-clip-1',
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

function expectedRevisions(
    snapshot: EditorEngineSnapshot,
): EditorCommandBatchRequest['expected'] {
    return {
        sessionRevision: snapshot.revisions.sessionRevision,
        documentRevision: snapshot.revisions.documentRevision,
        audioGraphRevision: snapshot.revisions.audioGraphRevision,
        ...(snapshot.revisions.narrativeRevision === undefined
            ? {}
            : { narrativeRevision: snapshot.revisions.narrativeRevision }),
    };
}

function videoDescriptor(id: string): VideoSourceDescriptorV3 {
    const metadata = {
        name: `${id}.mp4`,
        type: 'video/mp4',
        size: 1_000 + id.length,
        lastModified: 1_700_000_000_000 + id.length,
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

function hydration(
    source: VideoSourceDescriptorV3,
): EditorAssetHydration {
    return {
        videoSources: [{
            ...structuredClone(source),
            handle: {
                schemaVersion: 1,
                handleId: `handle-${source.id}`,
                capabilityId: `capability-${source.id}`,
                identity: {
                    schemaVersion: 1,
                    contentDigest: `sha256:${'b'.repeat(64)}`,
                    descriptorFingerprint: source.fingerprint,
                    byteLength: source.size,
                    immutableVersion: `immutable-${source.id}`,
                    streamMetadataRefs: [],
                },
                verifiedAt: NOW_ISO,
            },
            fileMetadata: {
                name: source.originalName,
                type: source.mimeType,
                size: source.size,
                lastModified: source.lastModified,
            },
        }],
        audioSources: [],
    };
}

function receiptKey(projectId: string, toolName: string, idempotencyKey: string): string {
    return `${projectId}\u0000${toolName}\u0000${idempotencyKey}`;
}
