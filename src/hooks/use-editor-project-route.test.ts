import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TProject } from '@/types/project';
import type { EditorDocumentV3 } from '@/types/video';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import { editorPersistenceRegistry } from '@/lib/storage/editor-persistence';
import { storageService } from '@/lib/storage/storage-service';
import { useProjectStore } from '@/stores/project-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { beginEditorProjectRoute } from './use-editor-project-route';

const project = (id: string): TProject => ({
    id,
    name: id,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    duration: 0,
});

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

const deferred = <T,>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};

describe('editor project route synchronization', () => {
    beforeEach(() => {
        const current = useProjectStore.getState();
        if (current.activeProject) current.closeProject();
        useProjectStore.setState({
            activeProject: null,
            persistenceGeneration: 0,
            isProjectLoading: false,
            loadingProjectId: null,
            projectRouteIntentId: null,
            projectRouteIntentToken: 0,
            projectLoadError: null,
            persistenceError: null,
            persistenceRetryKind: null,
        });
        vi.spyOn(editorPersistenceRegistry, 'settleBeforeOpen').mockResolvedValue(null);
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
        const current = useProjectStore.getState();
        if (current.activeProject) current.closeProject();
        vi.restoreAllMocks();
    });

    it('keeps active A mounted when slow B succeeds after the route returns to A', async () => {
        const activeId = 'route_active_a';
        const slowId = 'route_slow_b';
        const slowProject = deferred<TProject | null>();
        const attach = vi.spyOn(editorPersistenceRegistry, 'attach');
        vi.spyOn(storageService, 'loadProject').mockImplementation((id) => (
            id === activeId ? Promise.resolve(project(activeId)) : slowProject.promise
        ));
        const loadEditorDocument = vi.spyOn(storageService, 'loadEditorDocument')
            .mockImplementation(async (id) => emptyDocument(id === activeId ? 1 : 2));

        const activeRoute = beginEditorProjectRoute(activeId);
        await activeRoute.settled;
        activeRoute.release();
        const slowRoute = beginEditorProjectRoute(slowId);
        await vi.waitFor(() => expect(storageService.loadProject).toHaveBeenCalledWith(slowId));

        slowRoute.release();
        const returnedRoute = beginEditorProjectRoute(activeId);
        await returnedRoute.settled;
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id: activeId },
            projectRouteIntentId: activeId,
            projectRouteIntentToken: returnedRoute.token,
            loadingProjectId: null,
            isProjectLoading: false,
            projectLoadError: null,
        });
        expect(useTimelineStore.getState().revision).toBe(1);

        slowProject.resolve(project(slowId));
        await slowRoute.settled;
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id: activeId },
            projectRouteIntentId: activeId,
            projectLoadError: null,
        });
        expect(useTimelineStore.getState().revision).toBe(1);
        expect(loadEditorDocument).toHaveBeenCalledTimes(1);
        expect(loadEditorDocument).toHaveBeenCalledWith(activeId);
        expect(attach).toHaveBeenCalledTimes(1);
        expect(attach).toHaveBeenCalledWith(activeId);
    });

    it('ignores slow B failure after returning to A and leaves no stale retry action', async () => {
        const activeId = 'route_failure_active_a';
        const slowId = 'route_failure_slow_b';
        const slowProject = deferred<TProject | null>();
        const loadProject = vi.spyOn(storageService, 'loadProject').mockImplementation((id) => (
            id === activeId ? Promise.resolve(project(activeId)) : slowProject.promise
        ));
        vi.spyOn(storageService, 'loadEditorDocument').mockResolvedValue(emptyDocument(3));

        const activeRoute = beginEditorProjectRoute(activeId);
        await activeRoute.settled;
        activeRoute.release();
        const slowRoute = beginEditorProjectRoute(slowId);
        await vi.waitFor(() => expect(loadProject).toHaveBeenCalledWith(slowId));
        slowRoute.release();
        const returnedRoute = beginEditorProjectRoute(activeId);
        await returnedRoute.settled;

        slowProject.reject(new Error('slow B failed'));
        await slowRoute.settled;
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id: activeId },
            projectRouteIntentId: activeId,
            loadingProjectId: null,
            isProjectLoading: false,
            projectLoadError: null,
        });
        expect(useTimelineStore.getState().revision).toBe(3);

        await useProjectStore.getState().retryProjectLoad();
        expect(loadProject).toHaveBeenCalledTimes(2);
    });

    it('preserves the active project save state across an abandoned B navigation', async () => {
        const activeId = 'route_saving_active_a';
        const slowId = 'route_saving_slow_b';
        const slowProject = deferred<TProject | null>();
        const activeMetadataSave = deferred<void>();
        vi.spyOn(storageService, 'loadProject').mockImplementation((id) => (
            id === activeId ? Promise.resolve(project(activeId)) : slowProject.promise
        ));
        vi.spyOn(storageService, 'loadEditorDocument').mockResolvedValue(emptyDocument(4));
        vi.spyOn(storageService, 'saveProject').mockReturnValue(activeMetadataSave.promise);
        vi.spyOn(storageService, 'loadAllProjects').mockResolvedValue([]);

        const activeRoute = beginEditorProjectRoute(activeId);
        await activeRoute.settled;
        const activeSave = useProjectStore.getState().saveCurrentProject();
        await vi.waitFor(() => expect(storageService.saveProject).toHaveBeenCalledTimes(1));
        expect(useProjectStore.getState().isSaving).toBe(true);

        activeRoute.release();
        const slowRoute = beginEditorProjectRoute(slowId);
        await vi.waitFor(() => expect(storageService.loadProject).toHaveBeenCalledWith(slowId));
        slowRoute.release();
        const returnedRoute = beginEditorProjectRoute(activeId);
        await returnedRoute.settled;
        slowProject.resolve(project(slowId));
        await slowRoute.settled;
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id: activeId },
            projectRouteIntentId: activeId,
            isSaving: true,
        });

        activeMetadataSave.resolve();
        await activeSave;
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id: activeId },
            isSaving: false,
        });
    });

    it('invalidates slow B success when the editor unmounts to the dashboard', async () => {
        const activeId = 'route_unmount_success_a';
        const slowId = 'route_unmount_success_b';
        const slowProject = deferred<TProject | null>();
        const attach = vi.spyOn(editorPersistenceRegistry, 'attach');
        const loadProject = vi.spyOn(storageService, 'loadProject').mockImplementation((id) => (
            id === activeId ? Promise.resolve(project(activeId)) : slowProject.promise
        ));
        vi.spyOn(storageService, 'loadEditorDocument')
            .mockImplementation(async (id) => emptyDocument(id === activeId ? 5 : 6));

        const activeRoute = beginEditorProjectRoute(activeId);
        await activeRoute.settled;
        activeRoute.release();
        const slowRoute = beginEditorProjectRoute(slowId);
        await vi.waitFor(() => expect(loadProject).toHaveBeenCalledWith(slowId));

        slowRoute.release();
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id: activeId },
            projectRouteIntentId: null,
            projectRouteIntentToken: 0,
            loadingProjectId: null,
            isProjectLoading: false,
            projectLoadError: null,
        });
        slowProject.resolve(project(slowId));
        await slowRoute.settled;

        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id: activeId },
            projectRouteIntentId: null,
            projectLoadError: null,
        });
        expect(useTimelineStore.getState().revision).toBe(5);
        expect(attach).toHaveBeenCalledTimes(1);
        await useProjectStore.getState().retryProjectLoad();
        expect(loadProject).toHaveBeenCalledTimes(2);
    });

    it('invalidates slow B failure when the editor unmounts to the dashboard', async () => {
        const activeId = 'route_unmount_failure_a';
        const slowId = 'route_unmount_failure_b';
        const slowProject = deferred<TProject | null>();
        const loadProject = vi.spyOn(storageService, 'loadProject').mockImplementation((id) => (
            id === activeId ? Promise.resolve(project(activeId)) : slowProject.promise
        ));
        vi.spyOn(storageService, 'loadEditorDocument').mockResolvedValue(emptyDocument(7));

        const activeRoute = beginEditorProjectRoute(activeId);
        await activeRoute.settled;
        activeRoute.release();
        const slowRoute = beginEditorProjectRoute(slowId);
        await vi.waitFor(() => expect(loadProject).toHaveBeenCalledWith(slowId));

        slowRoute.release();
        slowProject.reject(new Error('B failed after dashboard navigation'));
        await slowRoute.settled;
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id: activeId },
            projectRouteIntentId: null,
            projectRouteIntentToken: 0,
            loadingProjectId: null,
            isProjectLoading: false,
            projectLoadError: null,
        });
        expect(useTimelineStore.getState().revision).toBe(7);
        await useProjectStore.getState().retryProjectLoad();
        expect(loadProject).toHaveBeenCalledTimes(2);
    });

    it('does not let an old cleanup cancel a newer remount of the same route', async () => {
        const activeId = 'route_remount_a';
        const remountId = 'route_remount_b';
        const firstLoad = deferred<TProject | null>();
        const secondLoad = deferred<TProject | null>();
        let remountAttempt = 0;
        vi.spyOn(storageService, 'loadProject').mockImplementation((id) => {
            if (id === activeId) return Promise.resolve(project(activeId));
            remountAttempt += 1;
            return remountAttempt === 1 ? firstLoad.promise : secondLoad.promise;
        });
        vi.spyOn(storageService, 'loadEditorDocument')
            .mockImplementation(async (id) => emptyDocument(id === activeId ? 8 : 9));

        const activeRoute = beginEditorProjectRoute(activeId);
        await activeRoute.settled;
        activeRoute.release();
        const firstRoute = beginEditorProjectRoute(remountId);
        await vi.waitFor(() => expect(remountAttempt).toBe(1));
        firstRoute.release();

        const secondRoute = beginEditorProjectRoute(remountId);
        await vi.waitFor(() => expect(remountAttempt).toBe(2));
        firstRoute.release();
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id: activeId },
            projectRouteIntentId: remountId,
            projectRouteIntentToken: secondRoute.token,
            loadingProjectId: remountId,
            isProjectLoading: true,
            projectLoadError: null,
        });

        firstLoad.reject(new Error('obsolete StrictMode load failed'));
        await firstRoute.settled;
        expect(useProjectStore.getState()).toMatchObject({
            projectRouteIntentId: remountId,
            projectRouteIntentToken: secondRoute.token,
            loadingProjectId: remountId,
            projectLoadError: null,
        });

        secondLoad.resolve(project(remountId));
        await secondRoute.settled;
        expect(useProjectStore.getState()).toMatchObject({
            activeProject: { id: remountId },
            projectRouteIntentId: remountId,
            projectRouteIntentToken: secondRoute.token,
            loadingProjectId: null,
            isProjectLoading: false,
            projectLoadError: null,
        });
        expect(useTimelineStore.getState().revision).toBe(9);
    });
});
