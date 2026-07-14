import { describe, expect, it } from 'vitest';
import type {
    AudioSourceAsset,
    EditorDocumentV3,
    EditorManifestV2,
    EditorManifestV3,
    VideoSourceAssetV3,
} from '@/types/video';
import { createVideoSourceFingerprint } from '@/lib/video-timeline';
import { createEditorManifestV3, migrateEditorDocumentV2ToV3 } from '@/lib/editor-document-migration';
import { createSerializablePatches } from '@/lib/serializable-patch';
import { recordTimelineHistory } from '@/stores/timeline-history';
import { TIMELINE_HISTORY_ROOTS } from '@/stores/timeline-history-projection';
import type { IndexedDBBatchOperation } from './indexeddb-adapter';
import {
    EDITOR_RECOVERY_INDEX_KEY,
    createHistoryIndex,
    getManifestSourceSignature,
    historyEntryStorageKey,
    projectEditorDocumentHistory,
    recoveryEntryStorageKey,
} from './editor-history-storage';
import {
    EDITOR_DOCUMENT_V2_KEY,
    EDITOR_DOCUMENT_V3_KEY,
    StorageService,
    type EditorPersistentAsset,
} from './storage-service';

class MemoryAdapter {
    values = new Map<string, unknown>();
    batches: Array<readonly IndexedDBBatchOperation<unknown>[]> = [];
    failKey: string | null = null;

    async get(key: string): Promise<unknown | null> {
        return this.values.get(key) ?? null;
    }

    async getMany<T>(keys: readonly string[]): Promise<Map<string, T | null>> {
        return new Map(keys.map((key) => [key, (this.values.get(key) as T | undefined) ?? null]));
    }

    async set(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
    async remove(key: string): Promise<void> { this.values.delete(key); }
    async list(): Promise<string[]> { return Array.from(this.values.keys()); }
    async clear(): Promise<void> { this.values.clear(); }
    async calculateSize(): Promise<number> { return 0; }

    async batch(operations: readonly IndexedDBBatchOperation<unknown>[]): Promise<void> {
        this.batches.push(operations);
        const staged = new Map(this.values);
        for (const operation of operations) {
            if (operation.key === this.failKey) throw new Error('simulated transaction abort');
            if (operation.type === 'put') staged.set(operation.key, operation.value);
            else staged.delete(operation.key);
        }
        this.values = staged;
    }
}

const makeFile = (name: string, type: string, size = 12, lastModified = 3): File => ({
    name, type, size, lastModified,
} as File);

const videoAsset = (id = 'shared'): VideoSourceAssetV3 => {
    const file = makeFile('video.mp4', 'video/mp4');
    return {
        id,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: createVideoSourceFingerprint(file),
        duration: 4,
        fps: 30,
        width: 1920,
        height: 1080,
        bitrate: null,
        hasAudio: true,
        file,
    };
};

const audioAsset = (id = 'shared'): AudioSourceAsset => {
    const file = makeFile('audio.wav', 'audio/wav', 16, 5);
    return {
        id,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: createVideoSourceFingerprint(file),
        duration: 2,
        nativeSampleRate: 48_000,
        nativeSampleCount: 96_000,
        nativeChannelCount: 2,
        bitrate: null,
        codec: 'pcm',
        file,
    };
};

const v2Manifest = (video: VideoSourceAssetV3): EditorManifestV2 => {
    const { file, ...descriptor } = video;
    void file;
    return {
        version: 2,
        revision: 2,
        projectFps: 30,
        tracks: [],
        sourceDescriptors: [descriptor],
        videoClips: [{ id: 'video_clip', sourceId: video.id, sourceStart: 0, sourceEnd: 2 }],
        activeTrackId: null,
        transcriptionByTrackId: {},
    };
};

const v3Document = (): EditorDocumentV3 => {
    const video = videoAsset();
    const audio = audioAsset();
    const document = migrateEditorDocumentV2ToV3({ manifest: v2Manifest(video), loadedVideoSources: [video] });
    document.videoClips[0].audio!.linkState = 'detached';
    document.audioSources = [audio];
    document.audioTracks = [{
        id: 'detached_track',
        name: 'Detached',
        muted: false,
        solo: false,
        locked: false,
        gainDb: 0,
        clips: [{
            id: 'detached_clip',
            source: { kind: 'video-source-audio', videoSourceId: video.id },
            timelineStartFrame: 0,
            sourceStart: 0,
            sourceEnd: 1,
            muted: false,
            gainDb: 0,
            fadeInFrames: 0,
            fadeOutFrames: 0,
        }],
    }, {
        id: 'imported_track',
        name: 'Imported',
        muted: false,
        solo: false,
        locked: false,
        gainDb: 0,
        clips: [{
            id: 'imported_clip',
            source: { kind: 'audio-source', audioSourceId: audio.id },
            timelineStartFrame: 30,
            sourceStartSample: 0,
            sourceEndSample: 48_000,
            muted: false,
            gainDb: 0,
            fadeInSamples: 0,
            fadeOutSamples: 0,
        }],
    }];
    return document;
};

const setup = () => {
    const adapter = new MemoryAdapter();
    const service = new StorageService();
    Object.defineProperty(service, 'getProjectDbAdapter', { value: () => adapter });
    return { service, adapter };
};

describe('v3 storage service', () => {
    it('reloads detached and imported audio with typed same-ID media isolation', async () => {
        const { service, adapter } = setup();
        const document = v3Document();
        adapter.values.set(EDITOR_DOCUMENT_V3_KEY, createEditorManifestV3(document));
        adapter.values.set('video-source:shared', document.videoSources[0].file);
        adapter.values.set('audio-source:shared', document.audioSources[0].file);

        const loaded = await service.loadEditorDocument('project');
        const reloaded = await service.loadEditorDocument('project');

        expect(loaded?.audioTracks).toEqual(document.audioTracks);
        expect(loaded?.videoSources[0].file).toBe(document.videoSources[0].file);
        expect(loaded?.audioSources[0].file).toBe(document.audioSources[0].file);
        expect(loaded?.transientSelection).toEqual({ kind: 'none' });
        expect(loaded?.videoSources[0].fingerprint).toMatch(/^v2_/);
        expect(loaded?.audioSources[0].fingerprint).toMatch(/^v2_/);
        expect(reloaded?.videoSources[0].fingerprint).toBe(loaded?.videoSources[0].fingerprint);
        expect(reloaded?.audioSources[0].fingerprint).toBe(loaded?.audioSources[0].fingerprint);
        expect(adapter.batches).toHaveLength(1);
        const persisted = adapter.values.get(EDITOR_DOCUMENT_V3_KEY) as EditorManifestV3;
        expect(persisted.videoSourceDescriptors[0].fingerprint).toBe(loaded?.videoSources[0].fingerprint);
        expect(persisted.audioSourceDescriptors[0].fingerprint).toBe(loaded?.audioSources[0].fingerprint);
    });

    it('isolates identical legacy source metadata across projects while keeping each upgrade stable', async () => {
        const firstSetup = setup();
        const secondSetup = setup();
        const firstDocument = v3Document();
        const secondDocument = v3Document();
        firstSetup.adapter.values.set(EDITOR_DOCUMENT_V3_KEY, createEditorManifestV3(firstDocument));
        firstSetup.adapter.values.set('video-source:shared', firstDocument.videoSources[0].file);
        firstSetup.adapter.values.set('audio-source:shared', firstDocument.audioSources[0].file);
        secondSetup.adapter.values.set(EDITOR_DOCUMENT_V3_KEY, createEditorManifestV3(secondDocument));
        secondSetup.adapter.values.set('video-source:shared', secondDocument.videoSources[0].file);
        secondSetup.adapter.values.set('audio-source:shared', secondDocument.audioSources[0].file);

        expect(firstDocument.videoSources[0].file).not.toBe(secondDocument.videoSources[0].file);
        expect(firstDocument.videoSources[0].fingerprint).toBe(secondDocument.videoSources[0].fingerprint);
        const firstLoaded = await firstSetup.service.loadEditorDocument('project_a');
        const secondLoaded = await secondSetup.service.loadEditorDocument('project_b');
        const firstReloaded = await firstSetup.service.loadEditorDocument('project_a');

        expect(firstLoaded?.videoSources[0].fingerprint).not.toBe(secondLoaded?.videoSources[0].fingerprint);
        expect(firstReloaded?.videoSources[0].fingerprint).toBe(firstLoaded?.videoSources[0].fingerprint);
    });

    it('migrates v2 from a legacy source key without duplicating its Blob', async () => {
        const { service, adapter } = setup();
        const video = videoAsset('video_a');
        adapter.values.set(EDITOR_DOCUMENT_V2_KEY, v2Manifest(video));
        adapter.values.set('source:video_a', video.file);

        const loaded = await service.loadEditorDocument('project');

        expect(loaded?.version).toBe(3);
        expect(loaded?.videoSources[0].fingerprint).toMatch(/^v2_/);
        expect((adapter.values.get(EDITOR_DOCUMENT_V3_KEY) as EditorManifestV3)
            .videoSourceDescriptors[0].fingerprint).toBe(loaded?.videoSources[0].fingerprint);
        expect(adapter.values.get('source:video_a')).toBe(video.file);
        expect(adapter.values.has('video-source:video_a')).toBe(false);
        expect(adapter.batches.at(-1)).toEqual([expect.objectContaining({
            type: 'put', key: EDITOR_DOCUMENT_V3_KEY,
        })]);
    });

    it('migrates v1 only after caller-supplied inspection and retains scalar records', async () => {
        const { service, adapter } = setup();
        const inspected = videoAsset('legacy_video');
        adapter.values.set('video-file', inspected.file);
        adapter.values.set('tracks', []);

        const loaded = await service.loadEditorDocument('project', {
            inspectLegacyVideo: async (sourceFile) => ({ ...inspected, file: sourceFile }),
        });

        expect(loaded).toMatchObject({ version: 3, videoSources: [{ id: 'legacy_video' }] });
        expect(loaded?.videoSources[0].fingerprint).toMatch(/^v2_/);
        expect(adapter.values.get('video-file')).toBe(inspected.file);
        expect(adapter.values.has('video-source:legacy_video')).toBe(false);
    });

    it('keeps v2 data authoritative if the migration manifest transaction aborts', async () => {
        const { service, adapter } = setup();
        const video = videoAsset('video_a');
        const legacyManifest = v2Manifest(video);
        adapter.values.set(EDITOR_DOCUMENT_V2_KEY, legacyManifest);
        adapter.values.set('source:video_a', video.file);
        adapter.failKey = EDITOR_DOCUMENT_V3_KEY;

        await expect(service.loadEditorDocument('project')).rejects.toThrow('simulated transaction abort');

        expect(adapter.values.get(EDITOR_DOCUMENT_V2_KEY)).toBe(legacyManifest);
        expect(adapter.values.get('source:video_a')).toBe(video.file);
        expect(adapter.values.has(EDITOR_DOCUMENT_V3_KEY)).toBe(false);
    });

    it('writes only supplied new typed Files and keeps equal IDs isolated by kind', async () => {
        const { service, adapter } = setup();
        const document = v3Document();
        const audioEntry: EditorPersistentAsset = { kind: 'audio-source', asset: document.audioSources[0] };

        await service.saveEditorDocument('project', createEditorManifestV3(document), [audioEntry]);

        expect(adapter.values.has('audio-source:shared')).toBe(true);
        expect(adapter.values.has('video-source:shared')).toBe(false);
        expect(adapter.batches[0].map((operation) => operation.key)).toEqual([
            EDITOR_DOCUMENT_V3_KEY,
            'audio-source:shared',
        ]);
    });

    it('leaves the previous manifest and assets untouched when the atomic batch fails', async () => {
        const { service, adapter } = setup();
        const document = v3Document();
        const previous = { ...createEditorManifestV3(document), revision: 1 };
        adapter.values.set(EDITOR_DOCUMENT_V3_KEY, previous);
        adapter.failKey = 'audio-source:shared';

        await expect(service.saveEditorDocument('project', createEditorManifestV3(document), [{
            kind: 'audio-source', asset: document.audioSources[0],
        }])).rejects.toThrow('simulated transaction abort');

        expect(adapter.values.get(EDITOR_DOCUMENT_V3_KEY)).toBe(previous);
        expect(adapter.values.has('audio-source:shared')).toBe(false);
    });

    it('materializes recovered history, removes evicted payloads, and survives a second reload', async () => {
        const { service, adapter } = setup();
        const baseline = v3Document();
        const manifest = createEditorManifestV3(baseline);
        adapter.values.set(EDITOR_DOCUMENT_V3_KEY, manifest);
        const before = projectEditorDocumentHistory(baseline);
        const after = structuredClone(before);
        after.tracks = [{
            id: 'captions',
            name: 'Captions',
            style: {} as import('@/types/timeline').AnimationStyle,
            subtitles: [],
            isVisible: true,
            isLocked: false,
        }];
        after.activeTrackId = 'captions';
        const history = recordTimelineHistory(
            { history: [], redoStack: [], historySequence: 0, historyBytes: 0 },
            before,
            after,
            {
                metadata: { label: 'Add subtitle track' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 1,
            },
        );
        const recoveredRevision = baseline.revision + 1;
        const recoveredManifest = { ...manifest, revision: recoveredRevision };
        const recoveredIndex = createHistoryIndex(recoveredManifest, {
            history: history.history,
            redoStack: [],
            projection: after,
        });
        const recoveryKey = recoveryEntryStorageKey(recoveredRevision);
        adapter.values.set(EDITOR_RECOVERY_INDEX_KEY, {
            version: 1,
            documentRevision: baseline.revision,
            sourceSignature: getManifestSourceSignature(manifest),
            entryKeys: [recoveryKey],
        });
        adapter.values.set(recoveryKey, {
            version: 1,
            fromRevision: baseline.revision,
            toRevision: recoveredRevision,
            fromAudioGraphRevision: baseline.audioGraphRevision,
            toAudioGraphRevision: baseline.audioGraphRevision,
            patches: createSerializablePatches(
                before,
                after,
                TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
            ).patches,
            historyIndex: recoveredIndex,
            historyEntries: history.history,
        });
        adapter.values.set(historyEntryStorageKey('history-evicted'), { stale: true });

        const recovered = await service.loadEditorRuntimeState('project', baseline);
        expect(recovered.recovered).toBe(true);
        expect(recovered.recoveryEntryKeys).toEqual([recoveryKey]);
        expect(recovered.durableHistory.history).toEqual([]);
        expect(recovered.history.history.map((entry) => entry.id)).toEqual(['history-1']);

        const checkpointManifest = createEditorManifestV3(recovered.document);
        await service.saveEditorDocument('project', checkpointManifest, [], {
            index: createHistoryIndex(checkpointManifest, {
                history: recovered.history.history,
                redoStack: recovered.history.redoStack,
                projection: after,
            }),
            changedEntries: recovered.history.history,
            deletedEntryIds: ['history-evicted'],
            recoveryKeysToDelete: [recoveryKey],
            clearRecoveryIndex: true,
        });

        expect(adapter.values.has(historyEntryStorageKey('history-evicted'))).toBe(false);
        expect(adapter.values.has(historyEntryStorageKey('history-1'))).toBe(true);
        expect(adapter.values.has(EDITOR_RECOVERY_INDEX_KEY)).toBe(false);
        expect(adapter.values.has(recoveryKey)).toBe(false);

        const secondReload = await service.loadEditorRuntimeState('project', recovered.document);
        expect(secondReload.recovered).toBe(false);
        expect(secondReload.history.history.map((entry) => entry.id)).toEqual(['history-1']);
        expect(secondReload.durableHistory.history.map((entry) => entry.id)).toEqual(['history-1']);
    });

    it('removes a rejected two-entry recovery chain in the next atomic checkpoint', async () => {
        const { service, adapter } = setup();
        const baseline = { ...v3Document(), revision: 4 };
        const manifest = createEditorManifestV3(baseline);
        const firstKey = recoveryEntryStorageKey(5);
        const secondKey = recoveryEntryStorageKey(6);
        adapter.values.set(EDITOR_DOCUMENT_V3_KEY, manifest);
        adapter.values.set(EDITOR_RECOVERY_INDEX_KEY, {
            version: 1,
            documentRevision: baseline.revision,
            sourceSignature: getManifestSourceSignature(manifest),
            entryKeys: [firstKey, secondKey],
        });
        // The first broken revision link rejects the entire chain; both indexed payloads still
        // remain owned garbage and must be removed together by the following checkpoint.
        adapter.values.set(firstKey, {
            version: 1,
            fromRevision: 99,
            toRevision: 5,
            fromAudioGraphRevision: baseline.audioGraphRevision,
            toAudioGraphRevision: baseline.audioGraphRevision,
            patches: [],
            historyIndex: createHistoryIndex({ ...manifest, revision: 5 }, {
                history: [],
                redoStack: [],
                projection: projectEditorDocumentHistory(baseline),
            }),
            historyEntries: [],
        });
        adapter.values.set(secondKey, { invalid: true });

        const loaded = await service.loadEditorRuntimeState('project', baseline);
        expect(loaded.recovered).toBe(false);
        expect(loaded.recoveryEntryKeys).toEqual([firstKey, secondKey]);

        const nextManifest = { ...manifest, revision: 5 };
        await service.saveEditorDocument('project', nextManifest, [], {
            index: createHistoryIndex(nextManifest, {
                history: [],
                redoStack: [],
                projection: projectEditorDocumentHistory(baseline),
            }),
            changedEntries: [],
            deletedEntryIds: [],
            recoveryKeysToDelete: loaded.recoveryEntryKeys,
            clearRecoveryIndex: true,
        });

        expect(adapter.values.has(EDITOR_RECOVERY_INDEX_KEY)).toBe(false);
        expect(adapter.values.has(firstKey)).toBe(false);
        expect(adapter.values.has(secondKey)).toBe(false);
    });
});
