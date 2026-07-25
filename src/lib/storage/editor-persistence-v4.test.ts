import { describe, expect, it, vi } from 'vitest';
import { createSerializablePatches } from '@/lib/serializable-patch';
import {
    createEditorDocumentV4Fixture,
    createEditorManifestV4Fixture,
    EDITORIAL_TEST_RECORD_ID,
} from '@/types/editorial.test-fixtures';
import type { Sha256Digest } from '@/types/editorial';
import type {
    TimelineHistoryEntry,
    TimelineHistoryProjection,
    TimelineHistoryRuntimeState,
} from '@/stores/timeline-store-types';
import { TIMELINE_HISTORY_ROOTS } from '@/stores/timeline-history-projection';
import type {
    EditorialTranscriptRepository,
    PublishEditorialProjectPinsInput,
} from './editorial-transcript-repository';
import {
    EditorPersistenceRegistry,
    type EditorPersistenceWriter,
} from './editor-persistence';
import { projectEditorDocumentHistoryV4 } from './editor-history-storage-v4';

const recordB = `sha256:${'e'.repeat(64)}` as Sha256Digest;
const recordC = `sha256:${'f'.repeat(64)}` as Sha256Digest;
const noopDelete = async () => {};

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const runtimeForRevision = (
    revision: number,
    globalEditingMode: 'ripple' | 'absolute' = 'ripple',
): TimelineHistoryRuntimeState => ({
    history: [],
    redoStack: [],
    projection: projectEditorDocumentHistoryV4(createEditorDocumentV4Fixture({
        revision,
        globalEditingMode,
    })),
});

const createRepositoryDouble = () => {
    const setPendingGenerationPins = vi.fn(async (
        _projectId: string,
        _generation: number,
        _recordIds: readonly Sha256Digest[],
    ) => {
        void _projectId;
        void _generation;
        void _recordIds;
    });
    const clearPendingGenerationPins = vi.fn(async (
        _projectId: string,
        _generation: number,
    ) => {
        void _projectId;
        void _generation;
    });
    const publishDurableProjectPins = vi.fn(async (
        _input: Omit<PublishEditorialProjectPinsInput, 'updatedAt'>,
    ) => {
        void _input;
    });
    const deleteProjectPins = vi.fn(async (_projectId: string) => {
        void _projectId;
    });
    const repository = {
        setPendingGenerationPins,
        clearPendingGenerationPins,
        publishDurableProjectPins,
        deleteProjectPins,
    } as unknown as EditorialTranscriptRepository;
    return {
        repository,
        setPendingGenerationPins,
        clearPendingGenerationPins,
        publishDurableProjectPins,
        deleteProjectPins,
    };
};

const makeHistoryEntry = (
    id: string,
    sequence: number,
    before: TimelineHistoryProjection,
    after: TimelineHistoryProjection,
): TimelineHistoryEntry => {
    const pair = createSerializablePatches(
        before,
        after,
        TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
    );
    return {
        id,
        sequence,
        label: id,
        mergeKey: null,
        timestamp: sequence,
        patches: pair.patches,
        inversePatches: pair.inversePatches,
        audioGraphMutationImpact: 'preserve-transcription',
        recalculatesContentBoundary: false,
        byteSize: 1,
        oversized: false,
    };
};

const projectionWithOnlyRecord = (
    projection: TimelineHistoryProjection,
    recordId: Sha256Digest,
): TimelineHistoryProjection => ({
    ...structuredClone(projection),
    editorialTranscriptDescriptors: (projection.editorialTranscriptDescriptors ?? []).map((descriptor) => ({
        ...descriptor,
        recordId,
    })),
    narrative: null,
    dependentLinks: [],
});

describe('V4 editor persistence transcript pins', () => {
    it('uses one pin generation per save and clears a superseded queued generation', async () => {
        const pins = createRepositoryDouble();
        const writes: number[] = [];
        const gates = new Map([[2, deferred()], [4, deferred()]]);
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async () => {},
            saveEditorDocument: async () => {
                throw new Error('V3 writer must not receive a V4 manifest.');
            },
            saveEditorDocumentV4: async (_projectId, manifest) => {
                writes.push(manifest.revision);
                await gates.get(manifest.revision)?.promise;
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete, null, pins.repository);
        const attachment = registry.attach('project_pin_generations');
        attachment.coordinator.markManifestDurable(
            createEditorManifestV4Fixture({ revision: 1 }),
            runtimeForRevision(1),
        );

        registry.enqueue(
            attachment.projectId,
            attachment.generation,
            createEditorManifestV4Fixture({ revision: 2 }),
            [],
            runtimeForRevision(2),
        );
        await vi.waitFor(() => expect(writes).toEqual([2]));
        registry.enqueue(
            attachment.projectId,
            attachment.generation,
            createEditorManifestV4Fixture({ revision: 3 }),
            [],
            runtimeForRevision(3),
        );
        registry.enqueue(
            attachment.projectId,
            attachment.generation,
            createEditorManifestV4Fixture({ revision: 4 }),
            [],
            runtimeForRevision(4),
        );

        expect(pins.setPendingGenerationPins.mock.calls.map((call) => call[1])).toEqual([1, 2, 3]);
        await vi.waitFor(() => expect(pins.clearPendingGenerationPins).toHaveBeenCalledWith(
            'project_pin_generations',
            2,
        ));
        gates.get(2)?.resolve();
        await vi.waitFor(() => expect(writes).toEqual([2, 4]));
        gates.get(4)?.resolve();
        await registry.flush(attachment.projectId);

        expect(pins.publishDurableProjectPins.mock.calls.map((call) => call[0].generation)).toEqual([1, 3]);
    });

    it('recreates the failed pending pin attempt before retrying the exact retained V4 request', async () => {
        const pins = createRepositoryDouble();
        let attempt = 0;
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async () => {},
            saveEditorDocument: async () => {
                throw new Error('V3 writer must not receive a V4 manifest.');
            },
            saveEditorDocumentV4: async () => {
                attempt += 1;
                if (attempt === 1) throw new Error('offline');
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete, null, pins.repository);
        const attachment = registry.attach('project_pin_retry');
        attachment.coordinator.markManifestDurable(
            createEditorManifestV4Fixture({ revision: 1 }),
            runtimeForRevision(1),
        );
        registry.enqueue(
            attachment.projectId,
            attachment.generation,
            createEditorManifestV4Fixture({ revision: 2 }),
            [],
            runtimeForRevision(2),
        );
        await expect(attachment.coordinator.settleCurrentWork()).resolves.toBeInstanceOf(Error);

        await expect(registry.retry(attachment.projectId, attachment.generation)).resolves.toBe(true);

        expect(attempt).toBe(2);
        expect(pins.setPendingGenerationPins.mock.calls.map((call) => ({
            generation: call[1],
            recordIds: call[2],
        }))).toEqual([{
            generation: 1,
            recordIds: [EDITORIAL_TEST_RECORD_ID],
        }, {
            generation: 1,
            recordIds: [EDITORIAL_TEST_RECORD_ID],
        }]);
        expect(pins.publishDurableProjectPins).toHaveBeenCalledTimes(1);
    });

    it('publishes empty durable sets after the final descriptor is removed', async () => {
        const pins = createRepositoryDouble();
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async () => {},
            saveEditorDocument: async () => {
                throw new Error('V3 writer must not receive a V4 manifest.');
            },
            saveEditorDocumentV4: async () => {},
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete, null, pins.repository);
        const attachment = registry.attach('project_pin_empty');
        attachment.coordinator.markManifestDurable(
            createEditorManifestV4Fixture({ revision: 1 }),
            runtimeForRevision(1),
        );
        const emptyDocument = createEditorDocumentV4Fixture({
            revision: 2,
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
        });
        const emptyRuntime: TimelineHistoryRuntimeState = {
            history: [],
            redoStack: [],
            projection: projectEditorDocumentHistoryV4(emptyDocument),
        };

        registry.enqueue(
            attachment.projectId,
            attachment.generation,
            createEditorManifestV4Fixture({
                revision: 2,
                editorialTranscriptDescriptors: [],
                narrative: null,
                dependentLinks: [],
            }),
            [],
            emptyRuntime,
        );
        await registry.flush(attachment.projectId);

        expect(pins.setPendingGenerationPins).not.toHaveBeenCalled();
        expect(pins.publishDurableProjectPins).toHaveBeenCalledWith({
            projectId: 'project_pin_empty',
            generation: 1,
            durableRecordIds: [],
            historyRecordIds: [],
            redoRecordIds: [],
            walRecordIds: [],
        });
    });

    it('pins exact current, Undo, Redo, and WAL record unions before checkpoint publication', async () => {
        const pins = createRepositoryDouble();
        const recoveryIndexes: unknown[] = [];
        const checkpoints: unknown[] = [];
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async (_projectId, index) => {
                recoveryIndexes.push(index);
            },
            saveEditorDocument: async () => {
                throw new Error('V3 writer must not receive a V4 manifest.');
            },
            saveEditorDocumentV4: async (_projectId, _manifest, _assets, checkpoint) => {
                checkpoints.push(checkpoint);
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete, null, pins.repository);
        const attachment = registry.attach('project_pin_unions');
        const baseline = runtimeForRevision(1, 'ripple');
        attachment.coordinator.markManifestDurable(
            createEditorManifestV4Fixture({ revision: 1, globalEditingMode: 'ripple' }),
            baseline,
        );
        const currentProjection = runtimeForRevision(2, 'absolute').projection;
        const historyProjection = projectionWithOnlyRecord(currentProjection, recordB);
        const redoProjection = projectionWithOnlyRecord(currentProjection, recordC);
        const historyEntry = makeHistoryEntry('history-record-b', 1, historyProjection, currentProjection);
        const redoEntry = makeHistoryEntry('redo-record-c', 2, currentProjection, redoProjection);
        const runtime: TimelineHistoryRuntimeState = {
            history: [historyEntry],
            redoStack: [redoEntry],
            projection: currentProjection,
        };

        registry.enqueue(
            attachment.projectId,
            attachment.generation,
            createEditorManifestV4Fixture({ revision: 2, globalEditingMode: 'absolute' }),
            [],
            runtime,
        );
        await registry.flush(attachment.projectId);

        expect(pins.setPendingGenerationPins).toHaveBeenCalledWith(
            'project_pin_unions',
            1,
            [EDITORIAL_TEST_RECORD_ID, recordB, recordC].sort(),
        );
        expect(recoveryIndexes).toEqual([
            expect.objectContaining({
                version: 3,
                walRecordIds: [EDITORIAL_TEST_RECORD_ID, recordB, recordC].sort(),
            }),
        ]);
        expect(checkpoints).toEqual([
            expect.objectContaining({
                index: expect.objectContaining({
                    currentRecordIds: [EDITORIAL_TEST_RECORD_ID],
                    historyRecordIds: [recordB],
                    redoRecordIds: [recordC],
                }),
            }),
        ]);
        expect(pins.publishDurableProjectPins).toHaveBeenCalledWith({
            projectId: 'project_pin_unions',
            generation: 1,
            durableRecordIds: [EDITORIAL_TEST_RECORD_ID],
            historyRecordIds: [recordB],
            redoRecordIds: [recordC],
            walRecordIds: [EDITORIAL_TEST_RECORD_ID, recordB, recordC].sort(),
        });
    });
});
