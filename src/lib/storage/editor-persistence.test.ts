import { describe, expect, it, vi } from 'vitest';
import type { EditorManifestV3, VideoSourceDescriptorV3 } from '@/types/video';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import type { EditorPersistentAsset } from './storage-service';
import type { TimelineHistoryEntry, TimelineHistoryRuntimeState } from '@/stores/timeline-store-types';
import type { AnimationStyle } from '@/types/timeline';
import {
    EditorPersistenceRegistry,
    type EditorPersistenceStatusEvent,
    type EditorPersistenceWriter,
} from './editor-persistence';
import { recoveryEntryStorageKey } from './editor-history-storage';

const fakeFile = (name: string, lastModified: number): File => ({
    name,
    type: 'video/mp4',
    size: 100,
    lastModified,
} as File);

const descriptor = (id: string, fingerprint: string): VideoSourceDescriptorV3 => ({
    id,
    originalName: `${id}.mp4`,
    mimeType: 'video/mp4',
    size: 100,
    lastModified: fingerprint === 'fingerprint_a' ? 1 : 2,
    fingerprint,
    duration: 2,
    fps: 30,
    width: 1920,
    height: 1080,
    bitrate: null,
    hasAudio: true,
});

const asset = (sourceDescriptor: VideoSourceDescriptorV3): EditorPersistentAsset => ({
    kind: 'video-source',
    asset: {
        ...sourceDescriptor,
        file: fakeFile(sourceDescriptor.originalName, sourceDescriptor.lastModified),
    },
});

const manifest = (
    revision: number,
    sourceDescriptors: VideoSourceDescriptorV3[] = [],
    audioGraphRevision = 0,
): EditorManifestV3 => ({
    version: 3,
    revision,
    audioGraphRevision,
    renderProfile: createDefaultRenderProfile(),
    subtitleTracks: [],
    videoSourceDescriptors: sourceDescriptors,
    videoClips: [],
    audioSourceDescriptors: [],
    audioTracks: [],
    activeSubtitleTrackId: null,
    transcriptionByTrackId: {},
});

const noopDelete = async () => {};

const historyRuntime = (): TimelineHistoryRuntimeState => ({
    history: [],
    redoStack: [],
    projection: {
        tracks: [],
        videoClips: [],
        renderProfile: createDefaultRenderProfile(),
        audioTracks: [],
        transientSelection: { kind: 'none' as const },
        activeTrackId: null,
        selectedSubtitleIds: [],
        lastSelectedId: null,
        selectedClipId: null,
        isVideoSelected: false,
        transcriptionByTrackId: {},
        rawTranscription: null,
        transcriptionGroups: null,
        transcriptionContainerIds: null,
    },
});

const historyEntry = (id: string, sequence: number): TimelineHistoryEntry => ({
    id,
    sequence,
    label: `Command ${sequence}`,
    mergeKey: null,
    timestamp: sequence,
    patches: [],
    inversePatches: [],
    audioGraphMutationImpact: 'preserve-transcription',
    recalculatesContentBoundary: false,
    byteSize: 100,
    oversized: false,
});

const deferred = () => {
    let resolve!: () => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};

const historyRuntimeWithTrack = (name: string): TimelineHistoryRuntimeState => {
    const runtime = historyRuntime();
    runtime.projection.tracks = [{
        id: 'captions',
        name,
        style: {} as AnimationStyle,
        subtitles: [],
        isVisible: true,
        isLocked: false,
    }];
    return runtime;
};

describe('editor persistence coordination', () => {
    it('writes source-stable WAL before checkpoint and treats asset mutations as barriers', async () => {
        const recoveryWrites: Array<{ index: { documentRevision: number }; entry: { fromRevision: number; toRevision: number } }> = [];
        const checkpoints: EditorManifestV3[] = [];
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async (_projectId, index, _entryKey, entry) => {
                recoveryWrites.push({ index, entry });
            },
            saveEditorDocument: async (_projectId, nextManifest) => {
                checkpoints.push(nextManifest);
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_wal');
        const baseline = historyRuntime();
        attachment.coordinator.markManifestDurable(manifest(4, [], 2), baseline);
        const edited = historyRuntime();
        edited.projection.tracks = [{
            id: 'captions',
            name: 'Captions',
            style: {} as AnimationStyle,
            subtitles: [],
            isVisible: true,
            isLocked: false,
        }];

        registry.enqueue('project_wal', attachment.generation, manifest(5, [], 3), [], edited);
        await registry.flush('project_wal');
        expect(recoveryWrites).toEqual([{
            index: expect.objectContaining({ documentRevision: 4 }),
            entry: expect.objectContaining({
                fromRevision: 4,
                toRevision: 5,
                fromAudioGraphRevision: 2,
                toAudioGraphRevision: 3,
            }),
        }]);
        expect(checkpoints.map((entry) => entry.revision)).toEqual([5]);

        const source = descriptor('barrier_source', 'fingerprint_a');
        registry.enqueue(
            'project_wal',
            attachment.generation,
            manifest(6, [source], 3),
            [asset(source)],
            edited,
        );
        await registry.flush('project_wal');
        expect(recoveryWrites).toHaveLength(1);
        expect(checkpoints.map((entry) => entry.revision)).toEqual([5, 6]);
    });

    it('upserts every recovery-only history entry and deletes evicted durable payloads', async () => {
        const checkpoints: Array<{
            changedEntryIds: string[];
            deletedEntryIds: string[];
        }> = [];
        const recoveryHistoryIds: string[][] = [];
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async (_projectId, _index, _entryKey, entry) => {
                recoveryHistoryIds.push(entry.historyEntries.map((history) => history.id));
            },
            saveEditorDocument: async (_projectId, _manifest, _assets, checkpoint) => {
                checkpoints.push({
                    changedEntryIds: checkpoint.changedEntries.map((entry) => entry.id),
                    deletedEntryIds: checkpoint.deletedEntryIds,
                });
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_history_delta');
        const retained = historyEntry('history-1', 1);
        const evicted = historyEntry('history-2', 2);
        const recovered = historyEntry('history-3', 3);
        const baseline = historyRuntime();
        baseline.history = [retained, evicted];
        attachment.coordinator.markManifestDurable(manifest(4), baseline);
        const edited = historyRuntime();
        edited.history = [retained, recovered];
        edited.projection.tracks = [{
            id: 'captions',
            name: 'Captions',
            style: {} as AnimationStyle,
            subtitles: [],
            isVisible: true,
            isLocked: false,
        }];

        registry.enqueue('project_history_delta', attachment.generation, manifest(5), [], edited);
        await registry.flush('project_history_delta');

        expect(recoveryHistoryIds).toEqual([['history-3']]);
        expect(checkpoints).toEqual([{
            changedEntryIds: ['history-3'],
            deletedEntryIds: ['history-2'],
        }]);
    });

    it('retries the exact WAL payload after its IndexedDB attempt fails', async () => {
        const recoveryRevisions: number[] = [];
        const checkpointRevisions: number[] = [];
        let failRecovery = true;
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async (_projectId, _index, _entryKey, entry) => {
                recoveryRevisions.push(entry.toRevision);
                if (failRecovery) throw new Error('recovery transaction failed');
            },
            saveEditorDocument: async (_projectId, nextManifest) => {
                checkpointRevisions.push(nextManifest.revision);
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_wal_retry');
        const baseline = historyRuntime();
        attachment.coordinator.markManifestDurable(manifest(4), baseline);
        const edited = historyRuntime();
        edited.projection.tracks = [{
            id: 'captions',
            name: 'Captions',
            style: {} as AnimationStyle,
            subtitles: [],
            isVisible: true,
            isLocked: false,
        }];

        registry.enqueue('project_wal_retry', attachment.generation, manifest(5), [], edited);
        await expect(attachment.coordinator.drain({ retryFailed: false }))
            .rejects.toThrow('recovery transaction failed');

        failRecovery = false;
        await registry.retry('project_wal_retry', attachment.generation);

        expect(recoveryRevisions).toEqual([5, 5]);
        expect(checkpointRevisions).toEqual([5]);
        expect(attachment.coordinator.getSnapshot()).toMatchObject({
            lastSavedRevision: 5,
            lastFailure: null,
        });
    });

    it('rebases a successor after WAL failure without publishing a missing predecessor key', async () => {
        const recoveryWrites: Array<{
            revision: number;
            fromRevision: number;
            entryKeys: string[];
        }> = [];
        const checkpoints: Array<{ revision: number; deletedRecoveryKeys: string[] }> = [];
        let failFirstWal = true;
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async (_projectId, index, _entryKey, entry) => {
                recoveryWrites.push({
                    revision: entry.toRevision,
                    fromRevision: entry.fromRevision,
                    entryKeys: index.entryKeys,
                });
                if (failFirstWal) {
                    failFirstWal = false;
                    throw new Error('WAL unavailable');
                }
            },
            saveEditorDocument: async (_projectId, nextManifest, _assets, checkpoint) => {
                checkpoints.push({
                    revision: nextManifest.revision,
                    deletedRecoveryKeys: checkpoint.recoveryKeysToDelete,
                });
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_wal_successor');
        attachment.coordinator.markManifestDurable(manifest(4), historyRuntime());

        registry.enqueue(
            'project_wal_successor',
            attachment.generation,
            manifest(5),
            [],
            historyRuntimeWithTrack('Revision 5'),
        );
        registry.enqueue(
            'project_wal_successor',
            attachment.generation,
            manifest(6),
            [],
            historyRuntimeWithTrack('Revision 6'),
        );
        await attachment.coordinator.drain({ retryFailed: false });

        expect(recoveryWrites).toEqual([
            {
                revision: 5,
                fromRevision: 4,
                entryKeys: [recoveryEntryStorageKey(5)],
            },
            {
                revision: 6,
                fromRevision: 4,
                entryKeys: [recoveryEntryStorageKey(6)],
            },
        ]);
        expect(checkpoints).toEqual([{
            revision: 6,
            deletedRecoveryKeys: [recoveryEntryStorageKey(5), recoveryEntryStorageKey(6)],
        }]);
    });

    it('starts a later successor from durable state after the predecessor failure has settled', async () => {
        const recoveryWrites: Array<{ revision: number; fromRevision: number; entryKeys: string[] }> = [];
        let failFirstWal = true;
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async (_projectId, index, _entryKey, entry) => {
                recoveryWrites.push({
                    revision: entry.toRevision,
                    fromRevision: entry.fromRevision,
                    entryKeys: index.entryKeys,
                });
                if (failFirstWal) {
                    failFirstWal = false;
                    throw new Error('WAL unavailable');
                }
            },
            saveEditorDocument: async () => undefined,
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_late_wal_successor');
        attachment.coordinator.markManifestDurable(manifest(4), historyRuntime());

        registry.enqueue(
            'project_late_wal_successor', attachment.generation, manifest(5), [], historyRuntimeWithTrack('N'),
        );
        await expect(attachment.coordinator.drain({ retryFailed: false })).rejects.toThrow('WAL unavailable');
        registry.enqueue(
            'project_late_wal_successor', attachment.generation, manifest(6), [], historyRuntimeWithTrack('N + 1'),
        );
        await attachment.coordinator.drain({ retryFailed: false });

        expect(recoveryWrites.at(-1)).toEqual({
            revision: 6,
            fromRevision: 4,
            entryKeys: [recoveryEntryStorageKey(6)],
        });
    });

    it('deletes WAL keys abandoned by A/B/C coalescing in the final atomic checkpoint', async () => {
        const firstCheckpoint = deferred();
        const recoveryRevisions: number[] = [];
        const checkpoints: Array<{ revision: number; deletedRecoveryKeys: string[] }> = [];
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async (_projectId, _index, _entryKey, entry) => {
                recoveryRevisions.push(entry.toRevision);
            },
            saveEditorDocument: async (_projectId, nextManifest, _assets, checkpoint) => {
                checkpoints.push({
                    revision: nextManifest.revision,
                    deletedRecoveryKeys: checkpoint.recoveryKeysToDelete,
                });
                if (nextManifest.revision === 5) await firstCheckpoint.promise;
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_wal_coalescing');
        attachment.coordinator.markManifestDurable(manifest(4), historyRuntime());

        registry.enqueue(
            'project_wal_coalescing', attachment.generation, manifest(5), [], historyRuntimeWithTrack('A'),
        );
        await vi.waitFor(() => expect(checkpoints.map((entry) => entry.revision)).toEqual([5]));
        registry.enqueue(
            'project_wal_coalescing', attachment.generation, manifest(6), [], historyRuntimeWithTrack('B'),
        );
        registry.enqueue(
            'project_wal_coalescing', attachment.generation, manifest(7), [], historyRuntimeWithTrack('C'),
        );
        await vi.waitFor(() => expect(recoveryRevisions).toEqual([5, 6, 7]));

        firstCheckpoint.resolve();
        await attachment.coordinator.drain({ retryFailed: false });

        expect(checkpoints).toEqual([
            { revision: 5, deletedRecoveryKeys: [recoveryEntryStorageKey(5)] },
            {
                revision: 7,
                deletedRecoveryKeys: [recoveryEntryStorageKey(6), recoveryEntryStorageKey(7)],
            },
        ]);
        expect(recoveryRevisions).toEqual([5, 6, 7, 7]);
    });

    it('waits for a newly durable rebased WAL when an old superseded write fails late', async () => {
        const firstCheckpoint = deferred();
        const oldWal = deferred();
        const replacementWal = deferred();
        const recoveryRevisions: number[] = [];
        const checkpointRevisions: number[] = [];
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async (_projectId, _index, _entryKey, entry) => {
                recoveryRevisions.push(entry.toRevision);
                if (entry.toRevision === 6) await oldWal.promise;
                if (entry.toRevision === 7) await replacementWal.promise;
            },
            saveEditorDocument: async (_projectId, nextManifest) => {
                checkpointRevisions.push(nextManifest.revision);
                if (nextManifest.revision === 5) await firstCheckpoint.promise;
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_wal_generation_race');
        attachment.coordinator.markManifestDurable(manifest(4), historyRuntime());

        registry.enqueue(
            'project_wal_generation_race', attachment.generation, manifest(5), [], historyRuntimeWithTrack('A'),
        );
        await vi.waitFor(() => expect(checkpointRevisions).toEqual([5]));
        registry.enqueue(
            'project_wal_generation_race', attachment.generation, manifest(6), [], historyRuntimeWithTrack('B'),
        );
        await vi.waitFor(() => expect(recoveryRevisions).toContain(6));
        registry.enqueue(
            'project_wal_generation_race', attachment.generation, manifest(7), [], historyRuntimeWithTrack('C'),
        );

        firstCheckpoint.resolve();
        oldWal.reject(new Error('Superseded WAL failed late'));
        await vi.waitFor(() => expect(recoveryRevisions).toContain(7));
        expect(checkpointRevisions).toEqual([5]);

        replacementWal.resolve();
        await attachment.coordinator.drain({ retryFailed: false });
        expect(checkpointRevisions).toEqual([5, 7]);
    });

    it('collects every recovery key observed before restart in the next checkpoint', async () => {
        const deletedRecoveryKeys: string[][] = [];
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async () => undefined,
            saveEditorDocument: async (_projectId, _manifest, _assets, checkpoint) => {
                deletedRecoveryKeys.push(checkpoint.recoveryKeysToDelete);
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_restarted_recovery');
        const staleKeys = [recoveryEntryStorageKey(5), recoveryEntryStorageKey(6)];
        attachment.coordinator.markManifestDurable(manifest(4), historyRuntime(), staleKeys);

        registry.enqueue(
            'project_restarted_recovery',
            attachment.generation,
            manifest(7),
            [],
            historyRuntimeWithTrack('After restart'),
        );
        await attachment.coordinator.drain({ retryFailed: false });

        expect(deletedRecoveryKeys).toEqual([expect.arrayContaining([
            ...staleKeys,
            recoveryEntryStorageKey(7),
        ])]);
    });

    it('retains a failed source and retries it with a later manifest revision', async () => {
        const calls: { manifest: EditorManifestV3; assets: readonly EditorPersistentAsset[] }[] = [];
        let shouldFail = true;
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async () => {},
            saveEditorDocument: async (_projectId, nextManifest, assets) => {
                calls.push({ manifest: nextManifest, assets });
                if (shouldFail) {
                    shouldFail = false;
                    throw new Error('disk full');
                }
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_a');
        const source = descriptor('source_a', 'fingerprint_a');

        registry.enqueue('project_a', attachment.generation, manifest(1, [source]), [asset(source)], historyRuntime());
        await expect(attachment.coordinator.drain({ retryFailed: false })).rejects.toThrow('disk full');
        expect(attachment.coordinator.getSnapshot().pendingAssetPairs).toHaveLength(1);

        registry.enqueue('project_a', attachment.generation, manifest(2, [source]), [], historyRuntime());
        await registry.flush('project_a');

        expect(calls.map((call) => call.manifest.revision)).toEqual([1, 2]);
        expect(calls[1].assets.map((item) => item.asset.id)).toEqual(['source_a']);
        expect(attachment.coordinator.getSnapshot()).toMatchObject({
            lastSavedRevision: 2,
            pendingAssetPairs: [],
            lastFailure: null,
        });
    });

    it('clears only the exact source ID and fingerprint completed by a transaction', async () => {
        const firstSource = descriptor('source_a', 'fingerprint_a');
        const secondSource = descriptor('source_a', 'fingerprint_b');
        const completions: (() => void)[] = [];
        const started: number[] = [];
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async () => {},
            saveEditorDocument: async (_projectId, nextManifest) => {
                started.push(nextManifest.revision);
                await new Promise<void>((resolve) => completions.push(resolve));
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_a');

        registry.enqueue('project_a', attachment.generation, manifest(1, [firstSource]), [asset(firstSource)], historyRuntime());
        registry.enqueue('project_a', attachment.generation, manifest(2, [secondSource]), [asset(secondSource)], historyRuntime());
        expect(started).toEqual([1]);

        completions.shift()?.();
        await vi.waitFor(() => expect(started).toEqual([1, 2]));
        expect(attachment.coordinator.getSnapshot().pendingAssetPairs).toEqual([
            'video-source:source_a\u0000fingerprint_b',
        ]);

        completions.shift()?.();
        await attachment.coordinator.drain({ retryFailed: false });
        expect(attachment.coordinator.getSnapshot()).toMatchObject({
            lastSavedRevision: 2,
            pendingAssetPairs: [],
            durableFingerprints: { 'video-source:source_a': 'fingerprint_b' },
        });
    });

    it('never writes stale or equal revisions after a newer revision completes', async () => {
        const revisions: number[] = [];
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async () => {},
            saveEditorDocument: async (_projectId, nextManifest) => {
                revisions.push(nextManifest.revision);
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_a');

        registry.enqueue('project_a', attachment.generation, manifest(3), [], historyRuntime());
        await registry.flush('project_a');
        registry.enqueue('project_a', attachment.generation, manifest(2), [], historyRuntime());
        registry.enqueue('project_a', attachment.generation, manifest(3), [], historyRuntime());
        await registry.flush('project_a');

        expect(revisions).toEqual([3]);
    });

    it('does not duplicate a legacy-resolved File after its migrated v3 manifest is marked durable', async () => {
        const source = descriptor('source_a', 'fingerprint_a');
        const calls: Array<readonly EditorPersistentAsset[]> = [];
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async () => {},
            saveEditorDocument: async (_projectId, _manifest, sourceAssets) => {
                calls.push(sourceAssets);
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_a');
        attachment.coordinator.markManifestDurable(manifest(1, [source]));

        registry.enqueue('project_a', attachment.generation, manifest(2, [source]), [], historyRuntime());
        await registry.flush('project_a');

        expect(calls).toEqual([[]]);
        expect(attachment.coordinator.getSnapshot().durableFingerprints).toEqual({
            'video-source:source_a': 'fingerprint_a',
        });
    });

    it('isolates late status notifications by active project and generation', async () => {
        const completions: (() => void)[] = [];
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async () => {},
            saveEditorDocument: async () => {
                await new Promise<void>((resolve) => completions.push(resolve));
            },
        };
        const events: EditorPersistenceStatusEvent[] = [];
        const registry = new EditorPersistenceRegistry(writer, noopDelete, (event) => events.push(event));
        const first = registry.attach('project_a');
        registry.enqueue('project_a', first.generation, manifest(1), [], historyRuntime());

        const second = registry.attach('project_b');
        events.length = 0;
        completions.shift()?.();
        await first.coordinator.drain({ retryFailed: false });
        expect(events).toEqual([]);

        registry.enqueue('project_b', second.generation, manifest(1), [], historyRuntime());
        expect(events.map((event) => event.status)).toEqual(['saving']);
        completions.shift()?.();
        await second.coordinator.drain({ retryFailed: false });
        expect(events.map((event) => event.status)).toEqual(['saving', 'saved']);
    });

    it('keeps failed state and pending assets observable across close and reopen', async () => {
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async () => {},
            saveEditorDocument: async () => {
                throw new Error('offline');
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const first = registry.attach('project_a');
        const source = descriptor('source_a', 'fingerprint_a');
        registry.enqueue('project_a', first.generation, manifest(2, [source]), [asset(source)], historyRuntime());
        await expect(first.coordinator.drain({ retryFailed: false })).rejects.toThrow('offline');

        registry.close('project_a', first.generation);
        const reopened = registry.attach('project_a');
        reopened.coordinator.markManifestDurable(manifest(1));

        expect(reopened.coordinator).toBe(first.coordinator);
        expect(registry.observeFailure('project_a')).toBeInstanceOf(Error);
        expect(reopened.coordinator.getSnapshot()).toMatchObject({
            lastSavedRevision: 1,
            pendingAssetPairs: ['video-source:source_a\u0000fingerprint_a'],
            hasNondurableDocument: true,
        });
    });

    it('retries only the newest failed manifest once and rebinds status to the reopened generation', async () => {
        const calls: Array<{ revision: number; assetIds: string[] }> = [];
        let shouldSucceed = false;
        const events: EditorPersistenceStatusEvent[] = [];
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async () => {},
            saveEditorDocument: async (_projectId, nextManifest, sourceAssets) => {
                calls.push({
                    revision: nextManifest.revision,
                    assetIds: sourceAssets.map((item) => item.asset.id),
                });
                if (!shouldSucceed) throw new Error(`offline-${nextManifest.revision}`);
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete, (event) => events.push(event));
        const first = registry.attach('project_retry');
        const source = descriptor('source_a', 'fingerprint_a');

        registry.enqueue('project_retry', first.generation, manifest(1, [source]), [asset(source)], historyRuntime());
        await expect(first.coordinator.settleCurrentWork()).resolves.toBeInstanceOf(Error);
        registry.enqueue('project_retry', first.generation, manifest(2, [source]), [], historyRuntime());
        await expect(first.coordinator.settleCurrentWork()).resolves.toBeInstanceOf(Error);

        registry.close('project_retry', first.generation);
        const reopened = registry.attach('project_retry');
        events.length = 0;
        shouldSucceed = true;

        await expect(registry.retry('project_retry', reopened.generation)).resolves.toBe(true);

        expect(calls).toEqual([
            { revision: 1, assetIds: ['source_a'] },
            { revision: 2, assetIds: ['source_a'] },
            { revision: 2, assetIds: ['source_a'] },
        ]);
        expect(events).toMatchObject([
            { generation: reopened.generation, status: 'saving', revision: 2 },
            { generation: reopened.generation, status: 'saved', revision: 2 },
        ]);
        expect(reopened.coordinator.getSnapshot()).toMatchObject({
            lastSavedRevision: 2,
            pendingAssetPairs: [],
            lastFailure: null,
            hasNondurableDocument: false,
        });
    });

    it('waits for an in-flight write before preparing the same project to reopen', async () => {
        let resolveWrite: () => void = () => { throw new Error('Write did not start.'); };
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async () => {},
            saveEditorDocument: async () => {
                await new Promise<void>((resolve) => { resolveWrite = resolve; });
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_a');
        registry.enqueue('project_a', attachment.generation, manifest(1), [], historyRuntime());

        let prepared = false;
        const preparation = registry.settleBeforeOpen('project_a').then((failure) => {
            prepared = true;
            return failure;
        });
        await Promise.resolve();
        expect(prepared).toBe(false);

        resolveWrite();
        await expect(preparation).resolves.toBeNull();
        expect(prepared).toBe(true);
    });

    it('does not implicitly retry a settled failed request while preparing reopen', async () => {
        let attempts = 0;
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async () => {},
            saveEditorDocument: async () => {
                attempts += 1;
                throw new Error('offline');
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_a');
        const source = descriptor('source_a', 'fingerprint_a');
        registry.enqueue('project_a', attachment.generation, manifest(2, [source]), [asset(source)], historyRuntime());

        const firstFailure = await registry.settleBeforeOpen('project_a');
        const secondFailure = await registry.settleBeforeOpen('project_a');

        expect(attempts).toBe(1);
        expect(firstFailure).toBeInstanceOf(Error);
        expect(secondFailure).toBe(firstFailure);
        expect(registry.get('project_a')?.getSnapshot()).toMatchObject({
            pendingAssetPairs: ['video-source:source_a\u0000fingerprint_a'],
            hasNondurableDocument: true,
        });
    });
});

describe('editor persistence deletion lifecycle', () => {
    it('keeps blocked deletion pending until eventual success and rejects new opens/saves', async () => {
        let resolveDeletion: () => void = () => { throw new Error('Deletion did not start.'); };
        const events: EditorPersistenceStatusEvent[] = [];
        const registry = new EditorPersistenceRegistry(
            { writeEditorRecovery: async () => {}, saveEditorDocument: async () => {} },
            async (_projectId, onBlocked) => {
                onBlocked();
                await new Promise<void>((resolve) => { resolveDeletion = resolve; });
            },
            (event) => events.push(event),
        );
        const attachment = registry.attach('project_a');
        const deletion = registry.deleteProject('project_a');

        await vi.waitFor(() => expect(events.map((event) => event.status)).toEqual([
            'deletion-pending',
            'deletion-blocked',
        ]));
        expect(() => registry.attach('project_a')).toThrow(/deletion is pending/);
        expect(() => registry.enqueue(
            'project_a',
            attachment.generation,
            manifest(1),
            [],
            historyRuntime(),
        )).toThrow(/deletion is pending/);
        await expect(registry.settleBeforeOpen('project_a')).rejects.toThrow(/deletion is pending/);

        resolveDeletion();
        await deletion;
        expect(events.at(-1)?.status).toBe('deleted');
        expect(registry.get('project_a')).toBeNull();
    });

    it('reactivates the coordinator after delete error and allows save plus delete retry', async () => {
        let deleteAttempts = 0;
        let saveAttempts = 0;
        const events: EditorPersistenceStatusEvent[] = [];
        const registry = new EditorPersistenceRegistry(
            {
                writeEditorRecovery: async () => {},
                saveEditorDocument: async () => {
                    saveAttempts += 1;
                    if (saveAttempts === 1) throw new Error('offline');
                },
            },
            async () => {
                deleteAttempts += 1;
                if (deleteAttempts === 1) throw new Error('delete failed');
            },
            (event) => events.push(event),
        );
        const initial = registry.attach('project_a');
        const source = descriptor('source_a', 'fingerprint_a');
        registry.enqueue('project_a', initial.generation, manifest(1, [source]), [asset(source)], historyRuntime());
        const priorSaveFailure = await registry.settleBeforeOpen('project_a');

        await expect(registry.deleteProject('project_a')).rejects.toThrow('delete failed');
        expect(registry.get('project_a')?.getSnapshot()).toMatchObject({
            deletionPending: false,
            disposed: false,
            pendingAssetPairs: ['video-source:source_a\u0000fingerprint_a'],
        });
        expect(registry.observeFailure('project_a')).toBe(priorSaveFailure);
        expect(events.some((event) => event.status === 'deleted')).toBe(false);

        const reopened = registry.attach('project_a');
        registry.enqueue('project_a', reopened.generation, manifest(2, [source]), [], historyRuntime());
        await registry.flush('project_a');
        expect(saveAttempts).toBe(2);

        await registry.deleteProject('project_a');
        expect(deleteAttempts).toBe(2);
        expect(registry.get('project_a')).toBeNull();
    });

    it('drains an in-flight save before disposal and then rejects future saves', async () => {
        let resolveSave: () => void = () => { throw new Error('Save did not start.'); };
        const writer: EditorPersistenceWriter = {
            writeEditorRecovery: async () => {},
            saveEditorDocument: async () => {
                await new Promise<void>((resolve) => { resolveSave = resolve; });
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_a');
        registry.enqueue('project_a', attachment.generation, manifest(1), [], historyRuntime());

        const disposal = attachment.coordinator.dispose();
        expect(attachment.coordinator.getSnapshot().disposed).toBe(false);
        resolveSave();
        await disposal;

        expect(attachment.coordinator.getSnapshot().disposed).toBe(true);
        expect(() => attachment.coordinator.enqueue(
            manifest(2),
            [],
            attachment.generation,
            historyRuntime(),
        )).toThrow(/cannot be opened/);
    });
});
