import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TProject } from '@/types/project';
import { editorPersistenceRegistry } from '@/lib/storage/editor-persistence';
import { recoveryEntryStorageKey } from '@/lib/storage/editor-history-storage';
import { storageService } from '@/lib/storage/storage-service';
import * as mediaUtils from '@/lib/mediabunny-utils';
import { useProjectStore } from './project-store';
import { createTimelinePersistencePayload, useTimelineStore } from './timeline-store';
import type { SubtitleTrack } from '@/types/timeline';
import type { AudioSourceAsset, EditorDocumentV3 } from '@/types/video';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import { createEditorManifestV3 } from '@/lib/editor-document-migration';
import type { TimelineHistoryEntry } from './timeline-store-types';

const project = (id: string): TProject => ({
    id,
    name: id,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
});

const emptyLegacyPayload = {
    tracks: null,
    rawTranscription: null,
    transcriptionGroups: null,
    transcriptionContainerIds: null,
    videoFile: null,
};

const emptyDocument = (revision: number): EditorDocumentV3 => ({
    version: 3,
    revision,
    audioGraphRevision: 0,
    renderProfile: createDefaultRenderProfile(),
    subtitleTracks: [],
    videoSources: [],
    videoClips: [],
    videoTracks: [{ id: 'video_track_1', name: 'Video 1', clipIds: [] }],
    audioSources: [],
    audioTracks: [],
    activeSubtitleTrackId: null,
    transientSelection: { kind: 'none' },
    transcriptionByTrackId: {},
});

const emptyRuntimeHistory = () => ({
    history: [],
    redoStack: [],
    historySequence: 0,
    historyBytes: 0,
});

const subtitleDocument = (revision: number, text: string): EditorDocumentV3 => ({
    ...emptyDocument(revision),
    subtitleTracks: [{
        id: 'captions',
        name: 'Captions',
        style: {} as SubtitleTrack['style'],
        subtitles: [{ id: 'subtitle', startTime: 0, endTime: 1, text }],
        isVisible: true,
        isLocked: false,
        timingDomain: 'absolute',
    }],
    activeSubtitleTrackId: 'captions',
});

const deferred = <T,>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};

describe('project persistence lifecycle integration', () => {
    beforeEach(() => {
        useProjectStore.setState({
            activeProject: null,
            persistenceGeneration: 0,
            persistenceStatus: null,
            persistenceError: null,
            persistenceRetryKind: null,
            projectRouteIntentId: null,
            projectRouteIntentToken: 0,
            projectLoadError: null,
            loadingProjectId: null,
            lastSavedIdentity: null,
            recoveryDocumentRevision: null,
            isProjectLoading: false,
            isSaving: false,
        });
        vi.spyOn(storageService, 'saveEditorDocument').mockResolvedValue();
        vi.spyOn(storageService, 'writeEditorRecovery').mockResolvedValue();
        vi.spyOn(storageService, 'loadEditorRuntimeState').mockImplementation(async (_id, document) => ({
            document,
            durableHistory: emptyRuntimeHistory(),
            history: emptyRuntimeHistory(),
            recovered: false,
            recoveryEntryKeys: [],
        }));
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        const state = useProjectStore.getState();
        if (state.activeProject) state.closeProject();
        vi.restoreAllMocks();
    });

    it('settles before reading and keeps a recovered save failure visible after attach', async () => {
        const id = 'project_reopen_success';
        const recoveredFailure = new Error('previous save failed');
        const settle = vi.spyOn(editorPersistenceRegistry, 'settleBeforeOpen').mockResolvedValue(recoveredFailure);
        const loadProject = vi.spyOn(storageService, 'loadProject').mockResolvedValue(project(id));
        vi.spyOn(storageService, 'loadEditorDocument').mockResolvedValue(null);
        vi.spyOn(storageService, 'loadLegacyProjectPayload').mockResolvedValue(emptyLegacyPayload);

        await useProjectStore.getState().loadProject(id);

        expect(settle).toHaveBeenCalledWith(id);
        expect(settle.mock.invocationCallOrder[0]).toBeLessThan(loadProject.mock.invocationCallOrder[0]);
        expect(useProjectStore.getState().persistenceError).toBe(recoveredFailure);
        expect(useProjectStore.getState().activeProject?.id).toBe(id);
    });

    it('keeps a document read failure separate from recovered persistence state', async () => {
        const id = 'project_reopen_read_error';
        const recoveredFailure = new Error('previous save failed');
        vi.spyOn(editorPersistenceRegistry, 'settleBeforeOpen').mockResolvedValue(recoveredFailure);
        vi.spyOn(storageService, 'loadProject').mockResolvedValue(project(id));
        const readFailure = new Error('read failed');
        vi.spyOn(storageService, 'loadEditorDocument').mockRejectedValue(readFailure);

        await expect(useProjectStore.getState().loadProject(id)).rejects.toThrow('read failed');
        expect(useProjectStore.getState()).toMatchObject({
            persistenceError: null,
            projectLoadError: { projectId: id, kind: 'unreadable', cause: readFailure },
            isProjectLoading: false,
        });
    });

    it('marks only checkpoint history durable before enqueueing every recovered entry', async () => {
        const id = 'project_recovered_history_checkpoint';
        const durableDocument = subtitleDocument(4, 'Before recovery');
        const recoveredDocument = subtitleDocument(5, 'Recovered');
        const recoveredEntry: TimelineHistoryEntry = {
            id: 'history-1',
            sequence: 1,
            label: 'Edit subtitle',
            mergeKey: null,
            timestamp: 1,
            patches: [],
            inversePatches: [],
            audioGraphMutationImpact: 'preserve-transcription',
            recalculatesContentBoundary: false,
            byteSize: 100,
            oversized: false,
        };
        const recoveredHistory = {
            history: [recoveredEntry],
            redoStack: [],
            historySequence: 1,
            historyBytes: 100,
        };
        vi.spyOn(editorPersistenceRegistry, 'settleBeforeOpen').mockResolvedValue(null);
        vi.spyOn(storageService, 'loadProject').mockResolvedValue(project(id));
        vi.spyOn(storageService, 'loadEditorDocument').mockResolvedValue(durableDocument);
        vi.spyOn(storageService, 'saveProject').mockResolvedValue();
        vi.mocked(storageService.loadEditorRuntimeState).mockResolvedValue({
            document: recoveredDocument,
            durableHistory: emptyRuntimeHistory(),
            history: recoveredHistory,
            recovered: true,
            recoveryEntryKeys: [recoveryEntryStorageKey(5)],
        });
        const markDurable = vi.spyOn(editorPersistenceRegistry, 'markManifestDurable')
            .mockImplementation(() => undefined);
        const enqueue = vi.spyOn(editorPersistenceRegistry, 'enqueue')
            .mockImplementation(() => undefined);

        await useProjectStore.getState().loadProject(id);

        expect(markDurable).toHaveBeenCalledWith(
            id,
            expect.objectContaining({ revision: 4 }),
            expect.objectContaining({ history: [], redoStack: [] }),
            [recoveryEntryStorageKey(5)],
        );
        expect(enqueue).toHaveBeenCalledWith(
            id,
            expect.any(Number),
            expect.objectContaining({ revision: 5 }),
            [],
            expect.objectContaining({ history: [recoveredEntry] }),
        );
    });

    it('publishes only the latest project when an older load resolves last', async () => {
        const slowId = 'project_slow_a';
        const fastId = 'project_fast_b';
        const slowProject = deferred<TProject | null>();
        const fastProject = deferred<TProject | null>();
        vi.spyOn(editorPersistenceRegistry, 'settleBeforeOpen').mockResolvedValue(null);
        const attach = vi.spyOn(editorPersistenceRegistry, 'attach');
        vi.spyOn(storageService, 'loadProject').mockImplementation((id) => (
            id === slowId ? slowProject.promise : fastProject.promise
        ));
        vi.spyOn(storageService, 'loadEditorDocument').mockImplementation(async (id) => (
            emptyDocument(id === fastId ? 22 : 11)
        ));

        const slowLoad = useProjectStore.getState().loadProject(slowId);
        await vi.waitFor(() => expect(storageService.loadProject).toHaveBeenCalledWith(slowId));
        const fastLoad = useProjectStore.getState().loadProject(fastId);
        fastProject.resolve(project(fastId));
        await fastLoad;
        slowProject.resolve(project(slowId));
        await slowLoad;

        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id: fastId },
            loadingProjectId: null,
            projectLoadError: null,
            isProjectLoading: false,
        });
        expect(useTimelineStore.getState().revision).toBe(22);
        expect(attach).toHaveBeenCalledTimes(1);
        expect(attach).toHaveBeenCalledWith(fastId);
    });

    it('keeps a missing route actionable and retries that exact requested project id', async () => {
        const id = 'project_appears_after_retry';
        vi.spyOn(editorPersistenceRegistry, 'settleBeforeOpen').mockResolvedValue(null);
        const loadProject = vi.spyOn(storageService, 'loadProject')
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(project(id));
        vi.spyOn(storageService, 'loadEditorDocument').mockResolvedValue(emptyDocument(7));

        await expect(useProjectStore.getState().loadProject(id)).rejects.toThrow('not found');
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: null,
            projectRouteIntentId: id,
            projectLoadError: { projectId: id, kind: 'not-found' },
            isProjectLoading: false,
        });

        await useProjectStore.getState().retryProjectLoad();
        expect(loadProject).toHaveBeenNthCalledWith(2, id);
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id },
            projectRouteIntentId: id,
            projectLoadError: null,
        });
    });

    it('leaves the project index untouched when database deletion fails', async () => {
        vi.spyOn(editorPersistenceRegistry, 'deleteProject').mockRejectedValue(new Error('delete failed'));
        const deleteIndex = vi.spyOn(storageService, 'deleteProjectIndex').mockResolvedValue();

        await expect(useProjectStore.getState().deleteProject('project_a')).rejects.toThrow('delete failed');
        expect(deleteIndex).not.toHaveBeenCalled();
    });

    it('migrates a legacy scalar video and transcription into one durable V3 document', async () => {
        const id = 'legacy_project';
        const file = {
            name: 'legacy.mp4',
            type: 'video/mp4',
            size: 1_024,
            lastModified: 12,
        } as File;
        const legacyTrack = {
            id: 'track-1',
            name: 'Captions',
            style: {} as SubtitleTrack['style'],
            subtitles: [],
            isVisible: true,
            isLocked: false,
        } satisfies SubtitleTrack;
        vi.spyOn(editorPersistenceRegistry, 'settleBeforeOpen').mockResolvedValue(null);
        vi.spyOn(storageService, 'loadProject').mockResolvedValue({
            ...project(id),
            thumbnail: 'data:image/jpeg;base64,thumbnail',
            duration: 2,
        });
        vi.spyOn(storageService, 'loadEditorDocument').mockResolvedValue(null);
        vi.spyOn(storageService, 'loadLegacyProjectPayload').mockResolvedValue({
            tracks: [legacyTrack],
            rawTranscription: [],
            transcriptionGroups: { group: [] },
            transcriptionContainerIds: ['group'],
            videoFile: file,
        });
        vi.spyOn(mediaUtils, 'getVideoInfo').mockResolvedValue({
            duration: 2,
            width: 1920,
            height: 1080,
            fps: 24,
            bitrate: 1_000_000,
            hasAudio: true,
        });

        await useProjectStore.getState().loadProject(id);

        expect(useTimelineStore.getState()).toMatchObject({
            projectFps: 24,
            videoSources: [{ originalName: 'legacy.mp4', hasAudio: true }],
            videoClips: [{
                sourceStart: 0,
                sourceEnd: 2,
                audio: { linkState: 'linked' },
            }],
            transcriptionByTrackId: {
                'track-1': { groups: { group: [] }, containerIds: ['group'] },
            },
        });
        expect(storageService.saveEditorDocument).toHaveBeenCalled();
    });

    it('hydrates a typed V3 audio graph and derives project duration from its audio tail', async () => {
        const id = 'project_v3_audio_tail';
        const audioSource: AudioSourceAsset = {
            id: 'shared_id',
            originalName: 'music.wav',
            mimeType: 'audio/wav',
            size: 100,
            lastModified: 10,
            fingerprint: 'audio_fingerprint',
            duration: 2,
            nativeSampleRate: 48_000,
            nativeSampleCount: 96_000,
            nativeChannelCount: 2,
            bitrate: null,
            codec: 'pcm_s16le',
            file: { name: 'music.wav', type: 'audio/wav', size: 100, lastModified: 10 } as File,
        };
        const document: EditorDocumentV3 = {
            version: 3,
            revision: 4,
            audioGraphRevision: 2,
            renderProfile: createDefaultRenderProfile({
                isFrameRateLocked: true,
                isCanvasSizeLocked: true,
            }),
            subtitleTracks: [],
            videoSources: [],
            videoClips: [],
            videoTracks: [{ id: 'video_track_1', name: 'Video 1', clipIds: [] }],
            audioSources: [audioSource],
            audioTracks: [{
                id: 'audio_track',
                name: 'Music',
                muted: false,
                solo: false,
                locked: false,
                gainDb: 0,
                clips: [{
                    id: 'audio_clip',
                    source: { kind: 'audio-source', audioSourceId: audioSource.id },
                    timelineStartFrame: 30,
                    sourceStartSample: 0,
                    sourceEndSample: audioSource.nativeSampleCount,
                    muted: false,
                    gainDb: 0,
                    fadeInSamples: 0,
                    fadeOutSamples: 0,
                }],
            }],
            activeSubtitleTrackId: null,
            transientSelection: { kind: 'none' },
            transcriptionByTrackId: {},
        };
        vi.spyOn(editorPersistenceRegistry, 'settleBeforeOpen').mockResolvedValue(null);
        vi.spyOn(storageService, 'loadProject').mockResolvedValue(project(id));
        vi.spyOn(storageService, 'loadEditorDocument').mockResolvedValue(document);
        vi.spyOn(storageService, 'saveProject').mockResolvedValue();
        vi.spyOn(storageService, 'loadAllProjects').mockResolvedValue([]);

        await useProjectStore.getState().loadProject(id);

        expect(useTimelineStore.getState()).toMatchObject({
            revision: 4,
            audioGraphRevision: 2,
            audioSources: [{ id: 'shared_id' }],
            audioTracks: [{ clips: [{ id: 'audio_clip' }] }],
        });
        expect(useProjectStore.getState().activeProject?.duration).toBe(3);
        expect(useTimelineStore.getState().buildEditorManifest()).toMatchObject({
            version: 3,
            audioSourceDescriptors: [{ id: 'shared_id' }],
        });
    });

    it('keeps a persistence failure visible while retrying and clears it only after save succeeds', async () => {
        const id = 'project_explicit_retry';
        const attachment = editorPersistenceRegistry.attach(id);
        const initialFailure = new Error('offline');
        let attempt = 0;
        let resolveRetry: () => void = () => { throw new Error('Retry did not start.'); };
        vi.mocked(storageService.saveEditorDocument).mockImplementation(async () => {
            attempt += 1;
            if (attempt === 1) throw initialFailure;
            await new Promise<void>((resolve) => { resolveRetry = resolve; });
        });
        useProjectStore.setState({
            activeProject: project(id),
            persistenceGeneration: attachment.generation,
            persistenceStatus: null,
            persistenceError: null,
        });

        editorPersistenceRegistry.enqueue(
            id,
            attachment.generation,
            useTimelineStore.getState().buildEditorManifest(),
            [],
            createTimelinePersistencePayload(useTimelineStore.getState()).history,
        );
        await attachment.coordinator.settleCurrentWork();
        expect(useProjectStore.getState().persistenceError).toBe(initialFailure);

        const retry = useProjectStore.getState().retryPersistence();
        await vi.waitFor(() => expect(useProjectStore.getState().persistenceStatus).toBe('saving'));
        expect(useProjectStore.getState().persistenceError).toBe(initialFailure);

        resolveRetry();
        await retry;
        expect(attempt).toBe(2);
        expect(useProjectStore.getState()).toMatchObject({
            persistenceStatus: 'saved',
            persistenceError: null,
            persistenceRetryKind: null,
            isSaving: false,
        });
    });

    it('clears a stale persistence error when retry reports that recovery already completed', async () => {
        const id = 'project_retry_already_recovered';
        const attachment = editorPersistenceRegistry.attach(id);
        const staleFailure = new Error('already recovered');
        vi.spyOn(editorPersistenceRegistry, 'retry').mockResolvedValue(false);
        useProjectStore.setState({
            activeProject: project(id),
            persistenceGeneration: attachment.generation,
            persistenceStatus: 'error',
            persistenceError: staleFailure,
            persistenceRetryKind: 'editor-document',
        });

        await useProjectStore.getState().retryPersistence();

        expect(useProjectStore.getState()).toMatchObject({
            persistenceStatus: 'saved',
            persistenceError: null,
            persistenceRetryKind: null,
            isSaving: false,
        });
    });

    it('discards late thumbnail metadata after the active project generation changes', async () => {
        const firstId = 'project_thumbnail_a';
        const secondId = 'project_thumbnail_b';
        const first = editorPersistenceRegistry.attach(firstId);
        const save = deferred<void>();
        vi.spyOn(storageService, 'saveProject').mockReturnValue(save.promise);
        vi.spyOn(storageService, 'loadAllProjects').mockResolvedValue([]);
        useProjectStore.setState({
            activeProject: project(firstId),
            persistenceGeneration: first.generation,
        });

        const update = useProjectStore.getState().updateThumbnail({
            projectId: firstId,
            generation: first.generation,
        }, 'data:image/jpeg;base64,late');
        await vi.waitFor(() => expect(storageService.saveProject).toHaveBeenCalled());
        const second = editorPersistenceRegistry.attach(secondId);
        useProjectStore.setState({
            activeProject: project(secondId),
            persistenceGeneration: second.generation,
        });

        save.resolve();
        await update;
        expect(useProjectStore.getState().activeProject).toMatchObject({ id: secondId });
        expect(useProjectStore.getState().activeProject).not.toHaveProperty('thumbnail');
    });

    it('discards late duration metadata after the active project generation changes', async () => {
        const firstId = 'project_duration_a';
        const secondId = 'project_duration_b';
        const first = editorPersistenceRegistry.attach(firstId);
        const save = deferred<void>();
        vi.spyOn(storageService, 'saveProject').mockReturnValue(save.promise);
        vi.spyOn(storageService, 'loadAllProjects').mockResolvedValue([]);
        useProjectStore.setState({
            activeProject: project(firstId),
            persistenceGeneration: first.generation,
        });

        const update = useProjectStore.getState().updateProjectDuration({
            projectId: firstId,
            generation: first.generation,
        }, 42);
        await vi.waitFor(() => expect(storageService.saveProject).toHaveBeenCalled());
        const second = editorPersistenceRegistry.attach(secondId);
        useProjectStore.setState({
            activeProject: project(secondId),
            persistenceGeneration: second.generation,
        });

        save.resolve();
        await update;
        expect(useProjectStore.getState().activeProject).toMatchObject({ id: secondId });
        expect(useProjectStore.getState().activeProject).not.toHaveProperty('duration');
    });

    it('discards a late project-name save after the active generation changes', async () => {
        const firstId = 'project_name_a';
        const secondId = 'project_name_b';
        const first = editorPersistenceRegistry.attach(firstId);
        const save = deferred<void>();
        vi.spyOn(storageService, 'saveProject').mockReturnValue(save.promise);
        vi.spyOn(storageService, 'loadAllProjects').mockResolvedValue([]);
        useProjectStore.setState({
            activeProject: project(firstId),
            persistenceGeneration: first.generation,
        });

        const update = useProjectStore.getState().updateProjectName('Late name');
        await vi.waitFor(() => expect(storageService.saveProject).toHaveBeenCalled());
        const second = editorPersistenceRegistry.attach(secondId);
        useProjectStore.setState({
            activeProject: project(secondId),
            persistenceGeneration: second.generation,
        });

        save.resolve();
        await update;
        expect(useProjectStore.getState().activeProject).toMatchObject({
            id: secondId,
            name: secondId,
        });
    });

    it('serializes duration and thumbnail writes so whole-record metadata fields compose', async () => {
        const id = 'project_metadata_composition';
        const attachment = editorPersistenceRegistry.attach(id);
        const firstWrite = deferred<void>();
        const secondWrite = deferred<void>();
        const saveProject = vi.spyOn(storageService, 'saveProject')
            .mockReturnValueOnce(firstWrite.promise)
            .mockReturnValueOnce(secondWrite.promise);
        vi.spyOn(storageService, 'loadAllProjects').mockResolvedValue([]);
        useProjectStore.setState({
            activeProject: project(id),
            persistenceGeneration: attachment.generation,
        });
        const context = { projectId: id, generation: attachment.generation };

        const durationUpdate = useProjectStore.getState().updateProjectDuration(context, 42);
        await vi.waitFor(() => expect(saveProject).toHaveBeenCalledTimes(1));
        const thumbnailUpdate = useProjectStore.getState().updateThumbnail(
            context,
            'data:image/jpeg;base64,thumbnail',
        );
        expect(saveProject).toHaveBeenCalledTimes(1);

        firstWrite.resolve();
        await vi.waitFor(() => expect(saveProject).toHaveBeenCalledTimes(2));
        expect(saveProject.mock.calls[1][0]).toMatchObject({
            id,
            duration: 42,
            thumbnail: 'data:image/jpeg;base64,thumbnail',
        });
        secondWrite.resolve();
        await Promise.all([durationUpdate, thumbnailUpdate]);
        expect(useProjectStore.getState().activeProject).toMatchObject({
            id,
            duration: 42,
            thumbnail: 'data:image/jpeg;base64,thumbnail',
        });
    });

    it('does not let an older document save completion restore a pre-rename project snapshot', async () => {
        const id = 'project_save_during_rename';
        const attachment = editorPersistenceRegistry.attach(id);
        const documentWrite = deferred<void>();
        vi.spyOn(storageService, 'saveProject').mockResolvedValue();
        vi.mocked(storageService.saveEditorDocument).mockReturnValue(documentWrite.promise);
        vi.spyOn(storageService, 'loadAllProjects').mockResolvedValue([]);
        useProjectStore.setState({
            activeProject: project(id),
            persistenceGeneration: attachment.generation,
            lastSavedIdentity: null,
        });

        const save = useProjectStore.getState().saveCurrentProject();
        await vi.waitFor(() => expect(storageService.saveEditorDocument).toHaveBeenCalledTimes(1));
        await useProjectStore.getState().updateProjectName('Renamed while saving');
        expect(useProjectStore.getState().activeProject?.name).toBe('Renamed while saving');

        documentWrite.resolve();
        await save;
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id, name: 'Renamed while saving' },
            lastSavedIdentity: { projectId: id, projectName: 'Renamed while saving' },
            isDirty: false,
        });
    });

    it('hydrates a retained failed revision before the next reopened edit advances beyond it', async () => {
        const id = 'project_reopen_failed_revision';
        const durableDocument = subtitleDocument(8, 'Durable');
        const retainedDocument = subtitleDocument(9, 'Recovered');
        const retainedFailure = new Error('offline');
        const recoveryReadFailure = new Error('temporary read failure');
        const retainedHistoryEntry: TimelineHistoryEntry = {
            id: 'history-1',
            sequence: 1,
            label: 'Recovered edit',
            mergeKey: null,
            timestamp: 1,
            patches: [],
            inversePatches: [],
            audioGraphMutationImpact: 'preserve-transcription',
            recalculatesContentBoundary: false,
            byteSize: 100,
            oversized: false,
        };
        const retainedHistory = {
            history: [retainedHistoryEntry],
            redoStack: [],
            historySequence: 1,
            historyBytes: 100,
        };
        vi.mocked(storageService.loadEditorRuntimeState).mockImplementation(async (_projectId, loadedDocument) => ({
            document: loadedDocument,
            durableHistory: loadedDocument.revision === 9 ? retainedHistory : emptyRuntimeHistory(),
            history: loadedDocument.revision === 9 ? retainedHistory : emptyRuntimeHistory(),
            recovered: false,
            recoveryEntryKeys: [],
        }));
        let writeAttempt = 0;
        vi.mocked(storageService.saveEditorDocument).mockImplementation(async () => {
            writeAttempt += 1;
            if (writeAttempt === 1) throw retainedFailure;
        });

        const first = editorPersistenceRegistry.attach(id);
        editorPersistenceRegistry.enqueue(
            id,
            first.generation,
            createEditorManifestV3(retainedDocument),
            [],
            createTimelinePersistencePayload(useTimelineStore.getState()).history,
        );
        await first.coordinator.settleCurrentWork();
        editorPersistenceRegistry.close(id, first.generation);

        vi.spyOn(storageService, 'loadProject').mockResolvedValue(project(id));
        vi.spyOn(storageService, 'loadEditorDocument')
            .mockResolvedValueOnce(durableDocument)
            .mockRejectedValueOnce(recoveryReadFailure)
            .mockResolvedValueOnce(retainedDocument);
        await useProjectStore.getState().loadProject(id);
        expect(useTimelineStore.getState()).toMatchObject({
            revision: 8,
            tracks: [{ subtitles: [{ text: 'Durable' }] }],
        });
        expect(useProjectStore.getState().persistenceError).toBe(retainedFailure);

        await useProjectStore.getState().retryPersistence();
        expect(useProjectStore.getState()).toMatchObject({
            persistenceError: recoveryReadFailure,
            persistenceRetryKind: 'recovery-load',
            recoveryDocumentRevision: 9,
        });
        expect(useTimelineStore.getState()).toMatchObject({
            revision: 9,
            tracks: [{ subtitles: [{ text: 'Durable' }] }],
        });

        await useProjectStore.getState().retryPersistence();
        expect(useTimelineStore.getState()).toMatchObject({
            revision: 9,
            tracks: [{ subtitles: [{ text: 'Recovered' }] }],
            history: [{ id: 'history-1' }],
            historySequence: 1,
        });
        useTimelineStore.getState().updateSubtitleInTrack(
            'captions',
            'subtitle',
            { text: 'Next edit' },
        );
        await vi.waitFor(() => expect(storageService.saveEditorDocument).toHaveBeenCalledTimes(3));
        expect(vi.mocked(storageService.saveEditorDocument).mock.calls[2][1].revision).toBe(10);
        expect(useTimelineStore.getState().revision).toBe(10);
        expect(useTimelineStore.getState().history.map((entry) => entry.id)).toEqual([
            'history-1',
            'history-2',
        ]);
    });

    it('does not let a late recovery read erase a newer failed editor mutation', async () => {
        const id = 'project_recovery_read_race';
        const durableDocument = subtitleDocument(8, 'Durable');
        const retainedDocument = subtitleDocument(9, 'Recovered');
        const retainedFailure = new Error('retained write failed');
        const recoveryReadFailure = new Error('temporary recovery read failure');
        const newerWriteFailure = new Error('newer write failed');
        const deferredRecoveryRead = deferred<EditorDocumentV3 | null>();
        let writeAttempt = 0;
        vi.mocked(storageService.saveEditorDocument).mockImplementation(async () => {
            writeAttempt += 1;
            if (writeAttempt === 1) throw retainedFailure;
            if (writeAttempt === 3) throw newerWriteFailure;
        });

        const first = editorPersistenceRegistry.attach(id);
        editorPersistenceRegistry.enqueue(
            id,
            first.generation,
            createEditorManifestV3(retainedDocument),
            [],
            createTimelinePersistencePayload(useTimelineStore.getState()).history,
        );
        await first.coordinator.settleCurrentWork();
        editorPersistenceRegistry.close(id, first.generation);

        vi.spyOn(storageService, 'loadProject').mockResolvedValue({
            ...project(id),
            duration: 1,
        });
        vi.spyOn(storageService, 'loadEditorDocument')
            .mockResolvedValueOnce(durableDocument)
            .mockRejectedValueOnce(recoveryReadFailure)
            .mockReturnValueOnce(deferredRecoveryRead.promise);
        await useProjectStore.getState().loadProject(id);
        await useProjectStore.getState().retryPersistence();
        expect(useProjectStore.getState()).toMatchObject({
            persistenceRetryKind: 'recovery-load',
            recoveryDocumentRevision: 9,
        });

        const recoveryRead = useProjectStore.getState().retryPersistence();
        await vi.waitFor(() => expect(storageService.loadEditorDocument).toHaveBeenCalledTimes(3));
        useTimelineStore.getState().updateSubtitleInTrack(
            'captions',
            'subtitle',
            { text: 'Newer live edit' },
        );
        await vi.waitFor(() => expect(useProjectStore.getState()).toMatchObject({
            persistenceError: newerWriteFailure,
            persistenceRetryKind: 'editor-document',
            recoveryDocumentRevision: null,
        }));

        deferredRecoveryRead.resolve(retainedDocument);
        await recoveryRead;
        expect(useProjectStore.getState()).toMatchObject({
            persistenceStatus: 'error',
            persistenceError: newerWriteFailure,
            persistenceRetryKind: 'editor-document',
            recoveryDocumentRevision: null,
        });
        expect(useTimelineStore.getState()).toMatchObject({
            revision: 10,
            tracks: [{ subtitles: [{ text: 'Newer live edit' }] }],
        });

        await useProjectStore.getState().retryPersistence();
        expect(vi.mocked(storageService.saveEditorDocument).mock.calls.at(-1)?.[1].revision).toBe(10);
        expect(useProjectStore.getState()).toMatchObject({
            persistenceStatus: 'saved',
            persistenceError: null,
            persistenceRetryKind: null,
        });
    });

    it('hydrates runtime history together with the retained document after a successful retry', async () => {
        const id = 'project_retry_history_readback';
        const durableDocument = subtitleDocument(8, 'Durable');
        const retainedDocument = subtitleDocument(9, 'Retained');
        const retainedEntry: TimelineHistoryEntry = {
            id: 'history-4',
            sequence: 4,
            label: 'Retained edit',
            mergeKey: null,
            timestamp: 4,
            patches: [],
            inversePatches: [],
            audioGraphMutationImpact: 'preserve-transcription',
            recalculatesContentBoundary: false,
            byteSize: 100,
            oversized: false,
        };
        const retainedHistory = {
            history: [retainedEntry],
            redoStack: [],
            historySequence: 4,
            historyBytes: 100,
        };
        useTimelineStore.getState().hydrateEditorDocument(durableDocument);
        useProjectStore.setState({
            activeProject: project(id),
            persistenceGeneration: 7,
            persistenceStatus: 'error',
            persistenceError: new Error('offline'),
            persistenceRetryKind: 'editor-document',
        });
        vi.spyOn(editorPersistenceRegistry, 'getFailedManifest')
            .mockReturnValue(createEditorManifestV3(retainedDocument));
        vi.spyOn(editorPersistenceRegistry, 'retry').mockResolvedValue(true);
        vi.spyOn(storageService, 'loadEditorDocument').mockResolvedValue(retainedDocument);
        vi.mocked(storageService.loadEditorRuntimeState).mockResolvedValue({
            document: retainedDocument,
            durableHistory: retainedHistory,
            history: retainedHistory,
            recovered: false,
            recoveryEntryKeys: [],
        });

        await useProjectStore.getState().retryPersistence();

        expect(useTimelineStore.getState()).toMatchObject({
            revision: 9,
            tracks: [{ subtitles: [{ text: 'Retained' }] }],
            history: [{ id: 'history-4' }],
            historySequence: 4,
        });
    });

    it('skips retained-document hydration when retry drains a newer successful mutation', async () => {
        const id = 'project_recovery_newer_success';
        const durableDocument = subtitleDocument(8, 'Durable');
        const retainedDocument = subtitleDocument(9, 'Recovered');
        const retainedFailure = new Error('retained write failed');
        const retainedRetryWrite = deferred<void>();
        let writeAttempt = 0;
        vi.mocked(storageService.saveEditorDocument).mockImplementation(async () => {
            writeAttempt += 1;
            if (writeAttempt === 1) throw retainedFailure;
            if (writeAttempt === 2) await retainedRetryWrite.promise;
        });

        const first = editorPersistenceRegistry.attach(id);
        editorPersistenceRegistry.enqueue(
            id,
            first.generation,
            createEditorManifestV3(retainedDocument),
            [],
            createTimelinePersistencePayload(useTimelineStore.getState()).history,
        );
        await first.coordinator.settleCurrentWork();
        editorPersistenceRegistry.close(id, first.generation);

        vi.spyOn(storageService, 'loadProject').mockResolvedValue({
            ...project(id),
            duration: 1,
        });
        const loadEditorDocument = vi.spyOn(storageService, 'loadEditorDocument')
            .mockResolvedValueOnce(durableDocument);
        await useProjectStore.getState().loadProject(id);

        const retry = useProjectStore.getState().retryPersistence();
        await vi.waitFor(() => expect(storageService.saveEditorDocument).toHaveBeenCalledTimes(2));
        useTimelineStore.getState().updateSubtitleInTrack(
            'captions',
            'subtitle',
            { text: 'Newer durable edit' },
        );
        retainedRetryWrite.resolve();
        await retry;

        expect(vi.mocked(storageService.saveEditorDocument).mock.calls[1][1].revision).toBe(9);
        expect(vi.mocked(storageService.saveEditorDocument).mock.calls[2][1].revision).toBe(10);
        expect(loadEditorDocument).toHaveBeenCalledTimes(1);
        expect(useTimelineStore.getState()).toMatchObject({
            revision: 10,
            tracks: [{ subtitles: [{ text: 'Newer durable edit' }] }],
        });
        expect(useProjectStore.getState()).toMatchObject({
            persistenceStatus: 'saved',
            persistenceError: null,
            persistenceRetryKind: null,
            recoveryDocumentRevision: null,
        });
    });

    it('offers a functional project-save retry when metadata fails before coordinator enqueue', async () => {
        const id = 'project_metadata_retry';
        const attachment = editorPersistenceRegistry.attach(id);
        const metadataFailure = new Error('project index offline');
        const saveProject = vi.spyOn(storageService, 'saveProject')
            .mockRejectedValueOnce(metadataFailure)
            .mockResolvedValueOnce();
        vi.spyOn(storageService, 'loadAllProjects').mockResolvedValue([]);
        useProjectStore.setState({
            activeProject: project(id),
            persistenceGeneration: attachment.generation,
            persistenceStatus: null,
            persistenceError: null,
            persistenceRetryKind: null,
        });

        await useProjectStore.getState().saveCurrentProject();
        expect(useProjectStore.getState()).toMatchObject({
            persistenceStatus: 'error',
            persistenceError: metadataFailure,
            persistenceRetryKind: 'project-save',
            isSaving: false,
        });
        expect(storageService.saveEditorDocument).not.toHaveBeenCalled();

        await useProjectStore.getState().retryPersistence();
        expect(saveProject).toHaveBeenCalledTimes(2);
        expect(storageService.saveEditorDocument).toHaveBeenCalledTimes(1);
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id },
            persistenceStatus: 'saved',
            persistenceError: null,
            persistenceRetryKind: null,
            isSaving: false,
        });
    });

    it('does not apply a late save completion to a newly active project generation', async () => {
        const firstId = 'project_late_save_a';
        const secondId = 'project_late_save_b';
        const first = editorPersistenceRegistry.attach(firstId);
        let resolveMetadata: () => void = () => { throw new Error('Save did not start.'); };
        vi.spyOn(storageService, 'saveProject').mockImplementation(async () => {
            await new Promise<void>((resolve) => { resolveMetadata = resolve; });
        });
        vi.spyOn(storageService, 'loadAllProjects').mockResolvedValue([]);
        useProjectStore.setState({
            activeProject: project(firstId),
            persistenceGeneration: first.generation,
            persistenceStatus: null,
            persistenceError: null,
            persistenceRetryKind: null,
        });

        const save = useProjectStore.getState().saveCurrentProject();
        await vi.waitFor(() => expect(storageService.saveProject).toHaveBeenCalledTimes(1));
        const second = editorPersistenceRegistry.attach(secondId);
        useProjectStore.setState({
            activeProject: project(secondId),
            persistenceGeneration: second.generation,
            persistenceStatus: null,
            persistenceError: null,
            persistenceRetryKind: null,
            isSaving: false,
        });

        resolveMetadata();
        await save;
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id: secondId },
            persistenceGeneration: second.generation,
            persistenceStatus: null,
            persistenceError: null,
            persistenceRetryKind: null,
            isSaving: false,
        });
    });

    it('does not apply a late metadata retry completion to a newly active project generation', async () => {
        const firstId = 'project_late_retry_a';
        const secondId = 'project_late_retry_b';
        const first = editorPersistenceRegistry.attach(firstId);
        let attempt = 0;
        let resolveRetry: () => void = () => { throw new Error('Retry did not start.'); };
        vi.spyOn(storageService, 'saveProject').mockImplementation(async () => {
            attempt += 1;
            if (attempt === 1) throw new Error('metadata offline');
            await new Promise<void>((resolve) => { resolveRetry = resolve; });
        });
        vi.spyOn(storageService, 'loadAllProjects').mockResolvedValue([]);
        useProjectStore.setState({
            activeProject: project(firstId),
            persistenceGeneration: first.generation,
            persistenceStatus: null,
            persistenceError: null,
            persistenceRetryKind: null,
        });
        await useProjectStore.getState().saveCurrentProject();
        expect(useProjectStore.getState().persistenceRetryKind).toBe('project-save');

        const retry = useProjectStore.getState().retryPersistence();
        await vi.waitFor(() => expect(attempt).toBe(2));
        const second = editorPersistenceRegistry.attach(secondId);
        useProjectStore.setState({
            activeProject: project(secondId),
            persistenceGeneration: second.generation,
            persistenceStatus: null,
            persistenceError: null,
            persistenceRetryKind: null,
            isSaving: false,
        });

        resolveRetry();
        await retry;
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id: secondId },
            persistenceGeneration: second.generation,
            persistenceStatus: null,
            persistenceError: null,
            persistenceRetryKind: null,
            isSaving: false,
        });
    });
});
