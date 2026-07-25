import { afterEach, describe, expect, it } from 'vitest';
import {
    STANDALONE_EDITOR_ENGINE_HEAD_KEY,
    StorageService,
} from '@/lib/storage/storage-service';
import type { IndexedDBBatchOperation } from '@/lib/storage/indexeddb-adapter';
import {
    createEditorDocumentV4Fixture,
    createSubtitleTrackV4Fixture,
} from '@/types/editorial.test-fixtures';
import { createStandaloneSemanticOperation } from './standalone-editor-operation-mapping';
import { StandaloneEditorEngineAdapter } from './standalone-editor-engine-adapter';
import { timelineEditorialRuntime } from './timeline-editorial-runtime';
import { useTimelineStore } from './timeline-store';

afterEach(async () => {
    await timelineEditorialRuntime.detachProject().catch(() => undefined);
    useTimelineStore.getState().resetEditorDocument();
});

describe('StandaloneEditorEngineAdapter', () => {
    it('commits before projection and preserves the authoritative projection on failure', async () => {
        const document = createEditorDocumentV4Fixture({
            narrative: null,
            editorialTranscriptDescriptors: [],
            videoSources: [],
            videoClips: [],
            subtitleTracks: [createSubtitleTrackV4Fixture({
                id: 'subtitle_track',
                subtitles: [{
                    id: 'subtitle',
                    startTime: 0,
                    endTime: 1,
                    text: 'Before',
                }],
            })],
            activeSubtitleTrackId: 'subtitle_track',
        });
        useTimelineStore.getState().hydrateEditorDocument(document);
        timelineEditorialRuntime.attachProject({
            projectId: 'standalone_project',
            persistenceGeneration: 1,
            sessionId: 'standalone_session',
        });
        timelineEditorialRuntime.injectResolvedBodies({});

        const adapterStorage = new MemoryAdapter();
        const storage = new StorageService();
        let retryVisible = false;
        Object.defineProperty(storage, 'getProjectDbAdapter', {
            value: () => adapterStorage,
        });
        const adapter = await StandaloneEditorEngineAdapter.create({
            projectId: 'standalone_project',
            projectName: 'Standalone',
            state: useTimelineStore.getState(),
            storage,
            onError: () => {
                retryVisible = true;
            },
            onProjection: () => {
                retryVisible = false;
            },
        });
        const selection = useTimelineStore.getState().transientSelection;
        const options = {
            history: { label: 'Set background', category: 'render' },
            selectionBefore: selection,
            selectionAfter: selection,
            compatibilityResult: {
                kind: 'success' as const,
                command: 'set-background',
                playhead: { kind: 'keep' as const, reason: 'non-structural' as const },
            },
        };

        const success = await adapter.dispatchOperations([
            createStandaloneSemanticOperation('render.set-background', { color: '#A1B2C3' }),
        ], options);

        expect(success.kind).toBe('success');
        expect(adapterStorage.values.get(STANDALONE_EDITOR_ENGINE_HEAD_KEY)).toMatchObject({
            snapshot: { manifest: { renderBackgroundColor: '#a1b2c3' } },
        });
        expect(useTimelineStore.getState().renderBackgroundColor).toBe('#a1b2c3');
        await adapter.undo();
        expect(useTimelineStore.getState().renderBackgroundColor).toBe('#000000');
        await adapter.redo();
        expect(useTimelineStore.getState().renderBackgroundColor).toBe('#a1b2c3');
        await adapter.dispatchOperations([
            createStandaloneSemanticOperation('subtitle.bulk-replace', {
                trackId: 'subtitle_track',
                subtitles: [{
                    id: 'subtitle',
                    startOutputSample: 0,
                    endOutputSample: 48_000,
                    text: 'After',
                }],
            }),
        ], {
            ...options,
            history: { label: 'Edit subtitle', category: 'subtitle' },
        });
        expect(useTimelineStore.getState().tracks[0].subtitles[0].text).toBe('After');
        await adapter.undo();
        expect(useTimelineStore.getState().tracks[0].subtitles[0].text).toBe('Before');
        await adapter.redo();
        expect(useTimelineStore.getState().tracks[0].subtitles[0].text).toBe('After');

        adapterStorage.failKey = STANDALONE_EDITOR_ENGINE_HEAD_KEY;
        // A drag or typed-input preview may still be visible when its terminal command fails.
        // Failure projection must restore Core's prior authoritative snapshot.
        useTimelineStore.setState({ renderBackgroundColor: '#fedcba' });
        const failure = await adapter.dispatchOperations([
            createStandaloneSemanticOperation('render.set-background', { color: '#123456' }),
        ], options);

        expect(failure).toMatchObject({
            kind: 'error',
            error: { code: 'INTERNAL_ERROR' },
        });
        expect(retryVisible).toBe(true);
        expect(useTimelineStore.getState().renderBackgroundColor).toBe('#a1b2c3');
        expect(adapterStorage.values.get(STANDALONE_EDITOR_ENGINE_HEAD_KEY)).toMatchObject({
            snapshot: { manifest: { renderBackgroundColor: '#a1b2c3' } },
        });
        useTimelineStore.setState({ renderBackgroundColor: '#abcdef' });
        await expect(adapter.dispatchOperations([
            createStandaloneSemanticOperation('render.set-background', { color: '#654321' }),
        ], options)).rejects.toThrow(
            'A failed standalone editor command must be retried before another durable command.',
        );
        expect(retryVisible).toBe(true);
        expect(useTimelineStore.getState().renderBackgroundColor).toBe('#a1b2c3');
        adapterStorage.failKey = null;
        expect(await adapter.retryLastFailure()).toBe(true);
        await expect(adapter.flush()).resolves.toBeUndefined();
        expect(useTimelineStore.getState().renderBackgroundColor).toBe('#123456');
        await adapter.close();

        useTimelineStore.setState({ renderBackgroundColor: '#fedcba' });
        const reopened = await StandaloneEditorEngineAdapter.create({
            projectId: 'standalone_project',
            projectName: 'Standalone',
            state: useTimelineStore.getState(),
            storage,
        });
        expect(useTimelineStore.getState().renderBackgroundColor).toBe('#123456');
        await reopened.close();
    });
});

class MemoryAdapter {
    values = new Map<string, unknown>();
    failKey: string | null = null;

    async get(key: string): Promise<unknown | null> {
        return this.values.get(key) ?? null;
    }

    async batch(operations: readonly IndexedDBBatchOperation<unknown>[]): Promise<void> {
        const staged = new Map(this.values);
        for (const operation of operations) {
            if (operation.key === this.failKey) throw new Error('simulated transaction abort');
            if (operation.type === 'put') staged.set(operation.key, operation.value);
            else staged.delete(operation.key);
        }
        this.values = staged;
    }
}
