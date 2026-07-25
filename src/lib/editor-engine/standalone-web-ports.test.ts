import { describe, expect, it, vi } from 'vitest';
import type { EditorialTranscriptRepository } from '@/lib/storage/editorial-transcript-repository';
import type {
    StandaloneEditorEngineHeadV1,
} from '@/lib/storage/storage-service';
import type { StorageService } from '@/lib/storage/storage-service';
import {
    createEditorialTranscriptBodyFixture,
    createEditorialTranscriptDescriptorFixture,
    createEditorManifestV4Fixture,
    createVideoSourceAssetV4Fixture,
} from '@/types/editorial.test-fixtures';
import type {
    AudioSourceAsset,
    EditorManifestV4,
    TransientMediaSelectionV4,
    VideoSourceAssetV3,
} from '@/types/video';
import type { EditorPersistenceCommit } from './editor-ports';
import {
    StandaloneEditorAssetRepositoryPort,
    StandaloneEditorPersistencePort,
    StandaloneEditorialTranscriptRepositoryPort,
} from './standalone-web-ports';

const PROJECT_ID = 'standalone-project';
const RECORD_ID = `sha256:${'a'.repeat(64)}` as const;

function sourceWithFile(
    file: File,
    overrides: Partial<VideoSourceAssetV3> = {},
): VideoSourceAssetV3 {
    return createVideoSourceAssetV4Fixture({
        id: 'video_source_editorial',
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: 'fingerprint-primary',
        file,
        ...overrides,
    });
}

function withoutFile<T extends VideoSourceAssetV3 | AudioSourceAsset>(
    source: T,
): Omit<T, 'file'> {
    const { file, ...descriptor } = source;
    void file;
    return descriptor;
}

function manifestWithSources(
    videoSources: VideoSourceAssetV3[],
    overrides: Partial<EditorManifestV4> = {},
): EditorManifestV4 {
    return createEditorManifestV4Fixture({
        videoSourceDescriptors: videoSources.map(withoutFile),
        editorialTranscriptDescriptors: [],
        narrative: null,
        dependentLinks: [],
        ...overrides,
    });
}

function persistenceCommit(
    overrides: Partial<EditorPersistenceCommit> = {},
): EditorPersistenceCommit {
    const manifest = createEditorManifestV4Fixture({
        editorialTranscriptDescriptors: [],
        narrative: null,
        dependentLinks: [],
    });
    const revisions = {
        sessionEpoch: 'standalone-epoch',
        sessionRevision: 1,
        documentRevision: manifest.revision,
        audioGraphRevision: manifest.audioGraphRevision,
    };
    const summary = {
        id: 'history-entry-1',
        label: 'Rename video track',
        category: 'track',
        occurredAt: '2026-07-25T12:00:00.000Z',
        operationIds: ['rename-track'],
        from: {
            sessionRevision: 0,
            documentRevision: Math.max(0, manifest.revision - 1),
            audioGraphRevision: manifest.audioGraphRevision,
        },
        to: {
            sessionRevision: 1,
            documentRevision: manifest.revision,
            audioGraphRevision: manifest.audioGraphRevision,
        },
    };
    const history = {
        past: [{
            summary,
            patches: [],
            inversePatches: [],
            byteSize: 1,
            transcriptRecordIds: [RECORD_ID],
            sourceReferences: {
                videoSourceIds: manifest.videoSourceDescriptors.map((source) => source.id),
                audioSourceIds: [],
            },
            projectMetadata: null,
        }],
        future: [],
    };
    const snapshot = {
        projectId: PROJECT_ID,
        project: { name: 'Standalone project' },
        manifest,
        revisions,
        history: {
            past: [summary],
            future: [],
            currentIndex: 1,
        },
        assetReferences: {
            videoSourceIds: manifest.videoSourceDescriptors.map((source) => source.id),
            audioSourceIds: [],
            transcriptRecordIds: [],
        },
    };
    const event = {
        id: 'event-1',
        sequence: 1,
        type: 'project.mutated' as const,
        projectId: PROJECT_ID,
        occurredAt: '2026-07-25T12:00:00.000Z',
        commandId: 'command-1',
        operationIds: ['rename-track'],
        historyEntryId: summary.id,
        revisions,
    };
    return {
        schemaVersion: 1,
        projectId: PROJECT_ID,
        toolName: 'waptions_edit_apply',
        commandId: 'command-1',
        transaction: {
            walTransactionId: 'wal-1',
            preparedAt: '2026-07-25T12:00:00.000Z',
            operationIds: ['rename-track'],
            fromDocumentRevision: Math.max(0, manifest.revision - 1),
            toDocumentRevision: manifest.revision,
        },
        sessionState: {
            sessionEpoch: revisions.sessionEpoch,
            sessionRevision: revisions.sessionRevision,
            eventSequence: event.sequence,
            projectName: snapshot.project.name,
            documentRevision: revisions.documentRevision,
            audioGraphRevision: revisions.audioGraphRevision,
        },
        previous: snapshot,
        next: snapshot,
        history,
        transcriptPins: {
            durableRecordIds: [RECORD_ID],
            historyRecordIds: [RECORD_ID],
            redoRecordIds: [],
        },
        sourcePins: {
            current: {
                videoSourceIds: manifest.videoSourceDescriptors.map((source) => source.id),
                audioSourceIds: [],
            },
            history: {
                videoSourceIds: manifest.videoSourceDescriptors.map((source) => source.id),
                audioSourceIds: [],
            },
            redo: {
                videoSourceIds: [],
                audioSourceIds: [],
            },
        },
        sourceRegistrations: {
            videoSources: [],
            audioSources: [],
        },
        event,
        receipt: {
            toolName: 'waptions_edit_apply',
            key: 'idempotency-1',
            value: {
                toolName: 'waptions_edit_apply',
                idempotencyKey: 'idempotency-1',
                requestHash: 'request-hash-1',
                result: {
                    ok: true,
                    commandId: 'command-1',
                    noOp: false,
                    historyEntryId: summary.id,
                    eventId: event.id,
                    aliases: {},
                    warnings: [],
                },
            },
        },
        ...overrides,
    };
}

function persistenceDoubles(input: {
    commit?: (head: {
        projectId: string;
        head: StandaloneEditorEngineHeadV1;
    }) => Promise<void>;
    publish?: () => Promise<void>;
} = {}) {
    const order: string[] = [];
    const commitStandaloneEditorEngineHead = vi.fn(async (
        value: {
            projectId: string;
            head: StandaloneEditorEngineHeadV1;
        },
    ) => {
        order.push(`commit:${value.head.pinGeneration}`);
        await input.commit?.(value);
    });
    const setPendingGenerationPins = vi.fn(async (
        _projectId: string,
        generation: number,
    ) => {
        order.push(`pending:${generation}`);
    });
    const clearPendingGenerationPins = vi.fn(async (
        _projectId: string,
        generation: number,
    ) => {
        order.push(`clear:${generation}`);
    });
    const publishDurableProjectPins = vi.fn(async (value: { generation: number }) => {
        order.push(`publish:${value.generation}`);
        await input.publish?.();
    });
    return {
        order,
        storage: {
            commitStandaloneEditorEngineHead,
            getStandaloneEditorEngineReceipt: vi.fn(async () => null),
        } as unknown as StorageService,
        transcripts: {
            setPendingGenerationPins,
            clearPendingGenerationPins,
            publishDurableProjectPins,
        } as unknown as EditorialTranscriptRepository,
        commitStandaloneEditorEngineHead,
        setPendingGenerationPins,
        clearPendingGenerationPins,
        publishDurableProjectPins,
    };
}

describe('StandaloneEditorAssetRepositoryPort', () => {
    it('hydrates only requested Files, preserves their runtime identity, and hashes actual bytes', async () => {
        const primaryFile = new File(['abc'], 'primary.webm', {
            type: 'video/webm',
            lastModified: 10,
        });
        const unusedFile = new File(['unused'], 'unused.webm', {
            type: 'video/webm',
            lastModified: 20,
        });
        const primaryStream = vi.spyOn(primaryFile, 'stream');
        const unusedStream = vi.spyOn(unusedFile, 'stream');
        const primary = sourceWithFile(primaryFile);
        const unused = sourceWithFile(unusedFile, {
            id: 'video_source_unused',
            fingerprint: 'fingerprint-unused',
        });
        const manifest = manifestWithSources([primary, unused]);
        const port = new StandaloneEditorAssetRepositoryPort({
            videoSources: [primary, unused],
            audioSources: [],
        });

        const hydration = await port.hydrate({
            manifest,
            videoSourceIds: [primary.id],
            audioSourceIds: [],
        });

        expect(hydration.videoSources).toHaveLength(1);
        expect(hydration.videoSources[0]).toMatchObject({
            id: primary.id,
            fileMetadata: {
                name: primaryFile.name,
                type: primaryFile.type,
                size: primaryFile.size,
                lastModified: primaryFile.lastModified,
            },
            handle: {
                identity: {
                    contentDigest: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
                    descriptorFingerprint: primary.fingerprint,
                    byteLength: 3,
                },
            },
        });
        expect(primaryStream).toHaveBeenCalledTimes(1);
        expect(unusedStream).not.toHaveBeenCalled();

        await port.hydrate({
            manifest,
            videoSourceIds: [primary.id],
            audioSourceIds: [],
        });
        expect(primaryStream).toHaveBeenCalledTimes(1);

        const runtime = port.hydrateRuntimeDocument(manifest, { kind: 'none' });
        expect(runtime.videoSources[0].file).toBe(primaryFile);
        expect(runtime.videoSources[1].file).toBe(unusedFile);
    });

    it('rejects any descriptor drift before exposing a File-backed handle', async () => {
        const file = new File(['abc'], 'primary.webm', {
            type: 'video/webm',
            lastModified: 10,
        });
        const source = sourceWithFile(file);
        const manifest = manifestWithSources([source]);
        manifest.videoSourceDescriptors[0] = {
            ...manifest.videoSourceDescriptors[0],
            originalName: 'renamed.webm',
        };
        const port = new StandaloneEditorAssetRepositoryPort({
            videoSources: [source],
            audioSources: [],
        });

        await expect(port.hydrate({
            manifest,
            videoSourceIds: [source.id],
            audioSourceIds: [],
        })).rejects.toThrow('no longer matches its immutable descriptor');
    });

    it('rehashes a repeated import candidate instead of reusing the committed File capability', async () => {
        const committedFile = new File(['abc'], 'primary.webm', {
            type: 'video/webm',
            lastModified: 10,
        });
        const candidateFile = new File(['xyz'], 'primary.webm', {
            type: 'video/webm',
            lastModified: 10,
        });
        const committed = sourceWithFile(committedFile);
        const candidate = sourceWithFile(candidateFile);
        const manifest = manifestWithSources([committed]);
        const port = new StandaloneEditorAssetRepositoryPort({
            videoSources: [committed],
            audioSources: [],
        });

        const existing = await port.hydrate({
            manifest,
            videoSourceIds: [committed.id],
            audioSourceIds: [],
        });
        const repeated = await port.prepareMediaImport([candidate], []);

        expect(existing.videoSources[0].handle.identity.contentDigest)
            .toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(repeated.videoSources[0].handle.identity.contentDigest)
            .toBe('sha256:3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282');
    });
});

describe('StandaloneEditorialTranscriptRepositoryPort', () => {
    it('hydrates the exact referenced CAS body with descriptor verification enabled', async () => {
        const descriptor = createEditorialTranscriptDescriptorFixture();
        const body = createEditorialTranscriptBodyFixture();
        const getRecord = vi.fn(async () => body);
        const port = new StandaloneEditorialTranscriptRepositoryPort({
            getRecord,
        } as unknown as EditorialTranscriptRepository);

        const result = await port.hydrate({
            references: [{
                recordId: descriptor.recordId,
                descriptorVersion: descriptor.version,
                sourceId: descriptor.sourceId,
                descriptor: descriptor as unknown as Readonly<Record<string, unknown>>,
            }],
        });

        expect(getRecord).toHaveBeenCalledWith(descriptor.recordId, {
            descriptor,
            referenced: true,
        });
        expect(result[descriptor.recordId]).toBe(body);
        expect(Object.isFrozen(result)).toBe(true);
    });

    it('fails closed when a referenced CAS body is missing', async () => {
        const descriptor = createEditorialTranscriptDescriptorFixture();
        const port = new StandaloneEditorialTranscriptRepositoryPort({
            getRecord: vi.fn(async () => null),
        } as unknown as EditorialTranscriptRepository);

        await expect(port.hydrate({
            references: [{
                recordId: descriptor.recordId,
                descriptorVersion: descriptor.version,
                sourceId: descriptor.sourceId,
                descriptor: descriptor as unknown as Readonly<Record<string, unknown>>,
            }],
        })).rejects.toThrow(`Transcript record "${descriptor.recordId}" is unavailable.`);
    });
});

describe('StandaloneEditorPersistencePort', () => {
    it('persists selection with the head between pending and durable pin publication', async () => {
        const pins = persistenceDoubles();
        const before: TransientMediaSelectionV4 = { kind: 'none' };
        const after: TransientMediaSelectionV4 = {
            kind: 'video-clip',
            clipId: 'video_clip_editorial',
        };
        const port = new StandaloneEditorPersistencePort(
            pins.storage,
            pins.transcripts,
            PROJECT_ID,
            null,
        );
        port.stageSelection(before, after);
        const commit = persistenceCommit();

        await port.commit(commit);

        expect(pins.order).toEqual(['pending:1', 'commit:1', 'publish:1']);
        const stored = pins.commitStandaloneEditorEngineHead.mock.calls[0][0];
        expect(stored.head.selectionByHistoryEntryId['history-entry-1']).toEqual({
            before,
            after,
        });
        expect(stored.head.sourcePins).toEqual(commit.sourcePins);
        expect(port.selectionForEvent(
            commit.event!,
            before,
            commit.next.history,
        )).toEqual(after);
        expect(port.selectionForHistory('history-entry-1', 'before', after)).toEqual(before);
    });

    it('clears conservative pins and leaves its generation unadvanced when the head commit fails', async () => {
        let failCommit = true;
        const pins = persistenceDoubles({
            commit: async () => {
                if (failCommit) throw new Error('atomic project transaction failed');
            },
        });
        const port = new StandaloneEditorPersistencePort(
            pins.storage,
            pins.transcripts,
            PROJECT_ID,
            null,
        );
        port.stageSelection(
            { kind: 'none' },
            { kind: 'video-clip', clipId: 'video_clip_editorial' },
        );
        const commit = persistenceCommit();

        await expect(port.commit(commit)).rejects.toThrow('atomic project transaction failed');
        expect(pins.order).toEqual(['pending:1', 'commit:1', 'clear:1']);
        expect(pins.publishDurableProjectPins).not.toHaveBeenCalled();
        expect(port.getHistory()).toEqual({ past: [], future: [] });

        failCommit = false;
        await port.commit(commit);
        expect(pins.order.slice(3)).toEqual(['pending:1', 'commit:1', 'publish:1']);
        expect(pins.commitStandaloneEditorEngineHead.mock.calls[1][0]
            .head.selectionByHistoryEntryId['history-entry-1']).toEqual({
            before: { kind: 'none' },
            after: { kind: 'video-clip', clipId: 'video_clip_editorial' },
        });
    });

    it('reports pin finalization failure without turning a durable head into an engine failure', async () => {
        const publicationError = new Error('transcript pin database unavailable');
        const pins = persistenceDoubles({
            publish: async () => {
                throw publicationError;
            },
        });
        const onPostCommitError = vi.fn();
        const port = new StandaloneEditorPersistencePort(
            pins.storage,
            pins.transcripts,
            PROJECT_ID,
            null,
            onPostCommitError,
        );

        await expect(port.commit(persistenceCommit())).resolves.toBeUndefined();

        expect(pins.order).toEqual(['pending:1', 'commit:1', 'publish:1']);
        expect(pins.clearPendingGenerationPins).not.toHaveBeenCalled();
        expect(onPostCommitError).toHaveBeenCalledWith(publicationError);
        expect(port.getHistory().past).toHaveLength(1);
    });
});
