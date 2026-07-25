import { afterEach, describe, expect, it } from 'vitest';
import {
    STANDALONE_EDITOR_ENGINE_HEAD_KEY,
    StorageService,
} from '@/lib/storage/storage-service';
import { getEditorMediaAssetKey } from '@/lib/media-asset-ref';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import { createVideoSourceFingerprint } from '@/lib/video-timeline';
import type { IndexedDBBatchOperation } from '@/lib/storage/indexeddb-adapter';
import {
    createEditorDocumentV4Fixture,
    createSubtitleTrackV4Fixture,
} from '@/types/editorial.test-fixtures';
import type { AudioSourceAsset, VideoSourceAssetV3 } from '@/types/video';
import { createStandaloneSemanticOperation } from './standalone-editor-operation-mapping';
import { StandaloneEditorEngineAdapter } from './standalone-editor-engine-adapter';
import { StandaloneEditorUnsupportedError } from './standalone-editor-engine-registry';
import { timelineEditorialRuntime } from './timeline-editorial-runtime';
import { useTimelineStore } from './timeline-store';
import { usePlaybackStore } from './playback-store';

afterEach(async () => {
    await timelineEditorialRuntime.detachProject().catch(() => undefined);
    useTimelineStore.getState().resetEditorDocument();
    usePlaybackStore.getState().reset();
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

    it('atomically imports mixed browser Files and preserves pinned Undo/Redo sources across reopen', async () => {
        const document = emptyUnlockedDocument();
        useTimelineStore.getState().hydrateEditorDocument(document);
        timelineEditorialRuntime.attachProject({
            projectId: 'standalone_import_project',
            persistenceGeneration: 1,
            sessionId: 'standalone_import_session',
        });
        timelineEditorialRuntime.injectResolvedBodies({});
        const adapterStorage = new MemoryAdapter();
        const storage = storageWithAdapter(adapterStorage);
        const video = videoAsset('video_import', 'Scene 1.mp4');
        const audio = audioAsset('audio_import', 'Scene 2.wav');
        usePlaybackStore.getState().setCurrentTime(4);
        const adapter = await StandaloneEditorEngineAdapter.create({
            projectId: 'standalone_import_project',
            projectName: 'Standalone import',
            state: useTimelineStore.getState(),
            storage,
        });
        const selection = useTimelineStore.getState().transientSelection;

        adapter.enqueueMediaImport({
            videoSources: [video],
            audioSources: [audio],
            timelineStartFrame: 10,
            selectionBefore: selection,
            selectionAfter: selection,
        });
        await adapter.flush();

        const state = useTimelineStore.getState();
        expect(state.renderProfile).toMatchObject({
            fps: { numerator: 25, denominator: 1 },
            width: 1_280,
            height: 720,
            isFrameRateLocked: true,
            isCanvasSizeLocked: true,
        });
        expect(state.videoSources).toHaveLength(1);
        expect(state.audioSources).toHaveLength(1);
        expect(usePlaybackStore.getState().currentTime).toBe(4);
        expect(state.videoClips[0]).toMatchObject({
            sourceId: video.id,
            timelineStartFrame: 10,
        });
        expect(state.audioTracks[0].clips[0]).toMatchObject({
            timelineStartFrame: 60,
            source: { kind: 'audio-source', audioSourceId: audio.id },
        });
        expect(adapterStorage.values.get(getEditorMediaAssetKey({
            kind: 'video-source',
            videoSourceId: video.id,
        }))).toBe(video.file);
        expect(adapterStorage.values.get(getEditorMediaAssetKey({
            kind: 'audio-source',
            audioSourceId: audio.id,
        }))).toBe(audio.file);
        expect(adapterStorage.values.get(STANDALONE_EDITOR_ENGINE_HEAD_KEY)).toMatchObject({
            sessionState: { sessionRevision: 1, eventSequence: 1 },
            sourcePins: {
                current: {
                    videoSourceIds: [video.id],
                    audioSourceIds: [audio.id],
                },
                history: {
                    videoSourceIds: [video.id],
                    audioSourceIds: [audio.id],
                },
                redo: {
                    videoSourceIds: [],
                    audioSourceIds: [],
                },
            },
        });

        await adapter.undo();
        expect(usePlaybackStore.getState().currentTime).toBe(4);
        expect(useTimelineStore.getState().videoSources).toEqual([]);
        expect(useTimelineStore.getState().audioSources).toEqual([]);
        expect(adapterStorage.values.get(STANDALONE_EDITOR_ENGINE_HEAD_KEY)).toMatchObject({
            sourcePins: {
                current: { videoSourceIds: [], audioSourceIds: [] },
                history: { videoSourceIds: [], audioSourceIds: [] },
                redo: {
                    videoSourceIds: [video.id],
                    audioSourceIds: [audio.id],
                },
            },
        });
        await adapter.close();

        const reopened = await StandaloneEditorEngineAdapter.create({
            projectId: 'standalone_import_project',
            projectName: 'Standalone import',
            state: useTimelineStore.getState(),
            storage,
        });
        await reopened.redo();
        expect(usePlaybackStore.getState().currentTime).toBe(4);
        expect(useTimelineStore.getState().videoSources[0].file).toBe(video.file);
        expect(useTimelineStore.getState().audioSources[0].file).toBe(audio.file);

        reopened.enqueueMediaImport({
            videoSources: [video],
            audioSources: [],
            timelineStartFrame: 200,
            selectionBefore: selection,
            selectionAfter: selection,
        });
        await reopened.flush();
        expect(useTimelineStore.getState().videoSources).toHaveLength(1);
        expect(useTimelineStore.getState().videoClips).toHaveLength(2);
        expect(adapterStorage.sourcePutKeys).toEqual([
            `video-source:${video.id}`,
            `audio-source:${audio.id}`,
        ]);
        await reopened.close();

        const currentHead = structuredClone(
            adapterStorage.values.get(STANDALONE_EDITOR_ENGINE_HEAD_KEY),
        ) as Record<string, unknown>;
        const legacyHead = structuredClone(currentHead);
        delete legacyHead.sourcePins;
        adapterStorage.values.set(STANDALONE_EDITOR_ENGINE_HEAD_KEY, legacyHead);
        await expect(storage.loadStandaloneEditorEngineHead('standalone_import_project'))
            .resolves.toMatchObject({ sourcePins: currentHead.sourcePins });

        const inconsistentHead = structuredClone(currentHead) as {
            sourcePins: { current: { videoSourceIds: string[] } };
        };
        inconsistentHead.sourcePins.current.videoSourceIds = [];
        adapterStorage.values.set(STANDALONE_EDITOR_ENGINE_HEAD_KEY, inconsistentHead);
        await expect(storage.loadStandaloneEditorEngineHead('standalone_import_project'))
            .rejects.toThrow('source pins do not match');
    });

    it('leaves no provisional File durable on failure and retries the exact import', async () => {
        useTimelineStore.getState().hydrateEditorDocument(emptyUnlockedDocument());
        timelineEditorialRuntime.attachProject({
            projectId: 'standalone_import_retry',
            persistenceGeneration: 1,
            sessionId: 'standalone_import_retry_session',
        });
        timelineEditorialRuntime.injectResolvedBodies({});
        const adapterStorage = new MemoryAdapter();
        const storage = storageWithAdapter(adapterStorage);
        const video = videoAsset('video_retry', 'Retry.mp4');
        const adapter = await StandaloneEditorEngineAdapter.create({
            projectId: 'standalone_import_retry',
            projectName: 'Standalone retry',
            state: useTimelineStore.getState(),
            storage,
        });
        const selection = useTimelineStore.getState().transientSelection;
        adapterStorage.failKey = STANDALONE_EDITOR_ENGINE_HEAD_KEY;

        adapter.enqueueMediaImport({
            videoSources: [video],
            audioSources: [],
            timelineStartFrame: 0,
            selectionBefore: selection,
            selectionAfter: selection,
        });
        await expect(adapter.flush()).rejects.toThrow(
            'Standalone editor persistence still has a failed command.',
        );
        expect(adapterStorage.values.has(getEditorMediaAssetKey({
            kind: 'video-source',
            videoSourceId: video.id,
        }))).toBe(false);
        expect(useTimelineStore.getState().videoSources).toEqual([]);
        expect(useTimelineStore.getState().renderProfile).toEqual(createDefaultRenderProfile());

        adapterStorage.failKey = null;
        expect(await adapter.retryLastFailure()).toBe(true);
        await expect(adapter.flush()).resolves.toBeUndefined();
        expect(useTimelineStore.getState().videoSources[0].file).toBe(video.file);
        expect(adapterStorage.values.get(getEditorMediaAssetKey({
            kind: 'video-source',
            videoSourceId: video.id,
        }))).toBe(video.file);
        await adapter.close();
    });

    it('releases a terminal import rejection so a valid first-video import can follow', async () => {
        useTimelineStore.getState().hydrateEditorDocument(emptyUnlockedDocument());
        timelineEditorialRuntime.attachProject({
            projectId: 'standalone_import_terminal',
            persistenceGeneration: 1,
            sessionId: 'standalone_import_terminal_session',
        });
        timelineEditorialRuntime.injectResolvedBodies({});
        const adapterStorage = new MemoryAdapter();
        const storage = storageWithAdapter(adapterStorage);
        const errors: unknown[] = [];
        const adapter = await StandaloneEditorEngineAdapter.create({
            projectId: 'standalone_import_terminal',
            projectName: 'Standalone terminal failure',
            state: useTimelineStore.getState(),
            storage,
            onError: (error) => errors.push(error),
        });
        const selection = useTimelineStore.getState().transientSelection;

        adapter.enqueueMediaImport({
            videoSources: [],
            audioSources: [audioAsset('audio_first', 'Audio first.wav')],
            timelineStartFrame: 0,
            selectionBefore: selection,
            selectionAfter: selection,
        });
        await expect(adapter.flush()).resolves.toBeUndefined();
        expect(errors.at(-1)).toBeInstanceOf(StandaloneEditorUnsupportedError);
        expect(useTimelineStore.getState().audioSources).toEqual([]);

        const video = videoAsset('video_after_audio', 'Video after audio.mp4');
        adapter.enqueueMediaImport({
            videoSources: [video],
            audioSources: [],
            timelineStartFrame: 0,
            selectionBefore: selection,
            selectionAfter: selection,
        });
        await expect(adapter.flush()).resolves.toBeUndefined();
        expect(useTimelineStore.getState().videoSources[0].file).toBe(video.file);
        await adapter.close();
    });
});

function emptyUnlockedDocument() {
    return createEditorDocumentV4Fixture({
        renderProfile: createDefaultRenderProfile(),
        narrative: null,
        editorialTranscriptDescriptors: [],
        videoSources: [],
        videoClips: [],
        videoTracks: [{
            id: 'video_track_empty',
            name: 'Video 1',
            visible: true,
            locked: false,
        }],
        audioSources: [],
        audioTracks: [],
        subtitleTracks: [],
        activeSubtitleTrackId: null,
    });
}

function videoAsset(id: string, name: string): VideoSourceAssetV3 {
    const file = new File(['video'], name, {
        type: 'video/mp4',
        lastModified: 100,
    });
    return {
        id,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: createVideoSourceFingerprint(file),
        duration: 2,
        fps: 25,
        width: 1_280,
        height: 720,
        bitrate: 1_000_000,
        hasAudio: true,
        file,
    };
}

function audioAsset(id: string, name: string): AudioSourceAsset {
    const file = new File(['audio'], name, {
        type: 'audio/wav',
        lastModified: 200,
    });
    return {
        id,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: createVideoSourceFingerprint(file),
        duration: 1,
        nativeSampleRate: 48_000,
        nativeSampleCount: 48_000,
        nativeChannelCount: 2,
        bitrate: 1_536_000,
        codec: 'pcm_s16le',
        file,
    };
}

function storageWithAdapter(adapter: MemoryAdapter): StorageService {
    const storage = new StorageService();
    Object.defineProperty(storage, 'getProjectDbAdapter', {
        value: () => adapter,
    });
    return storage;
}

class MemoryAdapter {
    values = new Map<string, unknown>();
    sourcePutKeys: string[] = [];
    failKey: string | null = null;

    async get(key: string): Promise<unknown | null> {
        return this.values.get(key) ?? null;
    }

    async batch(operations: readonly IndexedDBBatchOperation<unknown>[]): Promise<void> {
        const staged = new Map(this.values);
        const sourcePutKeys: string[] = [];
        for (const operation of operations) {
            if (operation.key === this.failKey) throw new Error('simulated transaction abort');
            if (operation.type === 'put') {
                staged.set(operation.key, operation.value);
                if (operation.key.startsWith('video-source:')
                    || operation.key.startsWith('audio-source:')) {
                    sourcePutKeys.push(operation.key);
                }
            }
            else staged.delete(operation.key);
        }
        this.values = staged;
        this.sourcePutKeys.push(...sourcePutKeys);
    }
}
