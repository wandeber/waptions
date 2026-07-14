import { describe, expect, it, vi } from 'vitest';
import type { EditorManifestV3, VideoSourceDescriptorV3 } from '@/types/video';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import type { EditorPersistentAsset } from './storage-service';
import {
    EditorPersistenceRegistry,
    type EditorPersistenceStatusEvent,
    type EditorPersistenceWriter,
} from './editor-persistence';

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
): EditorManifestV3 => ({
    version: 3,
    revision,
    audioGraphRevision: 0,
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

describe('editor persistence coordination', () => {
    it('retains a failed source and retries it with a later manifest revision', async () => {
        const calls: { manifest: EditorManifestV3; assets: readonly EditorPersistentAsset[] }[] = [];
        let shouldFail = true;
        const writer: EditorPersistenceWriter = {
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

        registry.enqueue('project_a', attachment.generation, manifest(1, [source]), [asset(source)]);
        await expect(attachment.coordinator.drain({ retryFailed: false })).rejects.toThrow('disk full');
        expect(attachment.coordinator.getSnapshot().pendingAssetPairs).toHaveLength(1);

        registry.enqueue('project_a', attachment.generation, manifest(2, [source]), []);
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
            saveEditorDocument: async (_projectId, nextManifest) => {
                started.push(nextManifest.revision);
                await new Promise<void>((resolve) => completions.push(resolve));
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_a');

        registry.enqueue('project_a', attachment.generation, manifest(1, [firstSource]), [asset(firstSource)]);
        registry.enqueue('project_a', attachment.generation, manifest(2, [secondSource]), [asset(secondSource)]);
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
            saveEditorDocument: async (_projectId, nextManifest) => {
                revisions.push(nextManifest.revision);
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_a');

        registry.enqueue('project_a', attachment.generation, manifest(3), []);
        await registry.flush('project_a');
        registry.enqueue('project_a', attachment.generation, manifest(2), []);
        registry.enqueue('project_a', attachment.generation, manifest(3), []);
        await registry.flush('project_a');

        expect(revisions).toEqual([3]);
    });

    it('does not duplicate a legacy-resolved File after its migrated v3 manifest is marked durable', async () => {
        const source = descriptor('source_a', 'fingerprint_a');
        const calls: Array<readonly EditorPersistentAsset[]> = [];
        const writer: EditorPersistenceWriter = {
            saveEditorDocument: async (_projectId, _manifest, sourceAssets) => {
                calls.push(sourceAssets);
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_a');
        attachment.coordinator.markManifestDurable(manifest(1, [source]));

        registry.enqueue('project_a', attachment.generation, manifest(2, [source]), []);
        await registry.flush('project_a');

        expect(calls).toEqual([[]]);
        expect(attachment.coordinator.getSnapshot().durableFingerprints).toEqual({
            'video-source:source_a': 'fingerprint_a',
        });
    });

    it('isolates late status notifications by active project and generation', async () => {
        const completions: (() => void)[] = [];
        const writer: EditorPersistenceWriter = {
            saveEditorDocument: async () => {
                await new Promise<void>((resolve) => completions.push(resolve));
            },
        };
        const events: EditorPersistenceStatusEvent[] = [];
        const registry = new EditorPersistenceRegistry(writer, noopDelete, (event) => events.push(event));
        const first = registry.attach('project_a');
        registry.enqueue('project_a', first.generation, manifest(1), []);

        const second = registry.attach('project_b');
        events.length = 0;
        completions.shift()?.();
        await first.coordinator.drain({ retryFailed: false });
        expect(events).toEqual([]);

        registry.enqueue('project_b', second.generation, manifest(1), []);
        expect(events.map((event) => event.status)).toEqual(['saving']);
        completions.shift()?.();
        await second.coordinator.drain({ retryFailed: false });
        expect(events.map((event) => event.status)).toEqual(['saving', 'saved']);
    });

    it('keeps failed state and pending assets observable across close and reopen', async () => {
        const writer: EditorPersistenceWriter = {
            saveEditorDocument: async () => {
                throw new Error('offline');
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const first = registry.attach('project_a');
        const source = descriptor('source_a', 'fingerprint_a');
        registry.enqueue('project_a', first.generation, manifest(2, [source]), [asset(source)]);
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

    it('waits for an in-flight write before preparing the same project to reopen', async () => {
        let resolveWrite: () => void = () => { throw new Error('Write did not start.'); };
        const writer: EditorPersistenceWriter = {
            saveEditorDocument: async () => {
                await new Promise<void>((resolve) => { resolveWrite = resolve; });
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_a');
        registry.enqueue('project_a', attachment.generation, manifest(1), []);

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
            saveEditorDocument: async () => {
                attempts += 1;
                throw new Error('offline');
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_a');
        const source = descriptor('source_a', 'fingerprint_a');
        registry.enqueue('project_a', attachment.generation, manifest(2, [source]), [asset(source)]);

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
            { saveEditorDocument: async () => {} },
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
        expect(() => registry.enqueue('project_a', attachment.generation, manifest(1), [])).toThrow(/deletion is pending/);
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
        registry.enqueue('project_a', initial.generation, manifest(1, [source]), [asset(source)]);
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
        registry.enqueue('project_a', reopened.generation, manifest(2, [source]), []);
        await registry.flush('project_a');
        expect(saveAttempts).toBe(2);

        await registry.deleteProject('project_a');
        expect(deleteAttempts).toBe(2);
        expect(registry.get('project_a')).toBeNull();
    });

    it('drains an in-flight save before disposal and then rejects future saves', async () => {
        let resolveSave: () => void = () => { throw new Error('Save did not start.'); };
        const writer: EditorPersistenceWriter = {
            saveEditorDocument: async () => {
                await new Promise<void>((resolve) => { resolveSave = resolve; });
            },
        };
        const registry = new EditorPersistenceRegistry(writer, noopDelete);
        const attachment = registry.attach('project_a');
        registry.enqueue('project_a', attachment.generation, manifest(1), []);

        const disposal = attachment.coordinator.dispose();
        expect(attachment.coordinator.getSnapshot().disposed).toBe(false);
        resolveSave();
        await disposal;

        expect(attachment.coordinator.getSnapshot().disposed).toBe(true);
        expect(() => attachment.coordinator.enqueue(manifest(2), [], attachment.generation)).toThrow(/cannot be opened/);
    });
});
