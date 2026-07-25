import { create } from 'zustand';
import { TProject } from '@/types/project';
import { storageService } from '@/lib/storage/storage-service';
import {
    createTimelinePersistencePayload,
    setTimelinePersistenceBinding,
    useTimelineStore,
} from './timeline-store';
import { usePlaybackStore } from './playback-store';
import type { EditorDocumentV4, TrackTranscriptionState } from '@/types/video';
import { inspectVideoSource } from '@/lib/video-source';
import {
    createEditorManifestV4,
    migrateLoadedEditorDocumentToV4,
    migrateLegacyEditorDocumentToV4,
} from '@/lib/editor-document-v4-migration';
import type { EditorPersistentAsset } from '@/lib/storage/storage-service';
import {
    selectPersistentEditorAssets,
    selectTimelineContentDuration,
} from './timeline-store-selectors';
import {
    editorPersistenceRegistry,
    type EditorPersistenceStatus,
} from '@/lib/storage/editor-persistence';
import { validateEditorDocumentV4 } from '@/lib/editor-document-v4';
import { projectEditorDocumentHistoryV4 } from '@/lib/storage/editor-history-storage-v4';
import { timelineEditorialRuntime } from './timeline-editorial-runtime';
import { createMediabunnyEditorialPcmWindowDecoder } from '@/lib/editorial-transcription/pcm-window-decoder';
import { approximateSecondsAsRationalDuration } from './timeline-editorial-runtime';
import { StandaloneEditorEngineAdapter } from './standalone-editor-engine-adapter';
import {
    getStandaloneEditorEngineBridge,
    setStandaloneEditorEngineBridge,
    StandaloneEditorUnsupportedError,
} from './standalone-editor-engine-registry';
import { mapStandaloneProjectName } from './standalone-editor-operation-mapping';

// Bounded quiet-boundary decoding resolves the currently mounted immutable source by fingerprint.
// The closure reads Files only on demand and never copies them into the runtime service, history,
// transcript CAS, or the derived PCM cache.
const editorPcmWindowDecoder = createMediabunnyEditorialPcmWindowDecoder({
    resolveSource: (sourceFingerprint) => {
        const source = useTimelineStore.getState().videoSources.find((candidate) => (
            candidate.fingerprint === sourceFingerprint
        ));
        return source ? {
            file: source.file,
            declaredDuration: approximateSecondsAsRationalDuration(source.duration),
        } : null;
    },
});
timelineEditorialRuntime.configure({ quietWindowDecoder: editorPcmWindowDecoder });

export type PersistenceRetryKind =
    | 'editor-document'
    | 'project-save'
    | 'recovery-load'
    | 'standalone-engine';
export type ProjectLoadErrorKind = 'not-found' | 'unreadable';

export interface ProjectLoadError {
    projectId: string;
    kind: ProjectLoadErrorKind;
    cause: unknown;
}

export interface ProjectOperationContext {
    projectId: string;
    generation: number;
}

interface ProjectSaveIdentity extends ProjectOperationContext {
    projectName: string;
    timelineRevision: number;
}

interface ProjectStore {
    activeProject: TProject | null;
    savedProjects: TProject[];
    isProjectLoading: boolean;
    isListLoading: boolean;
    isSaving: boolean;
    isInitialized: boolean;
    isDirty: boolean;
    lastSavedIdentity: ProjectSaveIdentity | null;
    persistenceGeneration: number;
    persistenceStatus: EditorPersistenceStatus | null;
    persistenceError: unknown | null;
    persistenceRetryKind: PersistenceRetryKind | null;
    projectRouteIntentId: string | null;
    projectRouteIntentToken: number;
    loadingProjectId: string | null;
    projectLoadError: ProjectLoadError | null;
    recoveryDocumentRevision: number | null;

    // Actions
    createProject: (name: string) => Promise<string>;
    beginProjectRouteIntent: (id: string) => number;
    clearProjectRouteIntent: (id: string, token: number) => void;
    loadProject: (id: string) => Promise<void>;
    retryProjectLoad: () => Promise<void>;
    saveCurrentProject: () => Promise<void>;
    retryPersistence: () => Promise<void>;
    loadAllProjects: () => Promise<void>;
    deleteProject: (id: string) => Promise<void>;
    closeProject: () => void;
    updateProjectName: (name: string) => Promise<void>;
    updateThumbnail: (context: ProjectOperationContext, thumbnail: string) => Promise<void>;
    updateProjectDuration: (context: ProjectOperationContext, duration: number) => Promise<void>;
    setIsDirty: (isDirty: boolean) => void;
    checkDirty: (timelineRevision?: number) => void;
    updateLastSavedState: () => void;
}

let latestProjectLoadRequest = 0;
let latestProjectRouteIntent = 0;
let activeStandaloneEditorAdapter: StandaloneEditorEngineAdapter | null = null;

const closeStandaloneEditorAdapter = async (): Promise<void> => {
    const adapter = activeStandaloneEditorAdapter;
    activeStandaloneEditorAdapter = null;
    setStandaloneEditorEngineBridge(null);
    await adapter?.close().catch(() => undefined);
};

const attachStandaloneEditorAdapter = async (
    project: TProject,
): Promise<StandaloneEditorEngineAdapter | null> => {
    if (typeof indexedDB === 'undefined') return null;
    const adapter = await StandaloneEditorEngineAdapter.create({
        projectId: project.id,
        projectName: project.name,
        state: useTimelineStore.getState(),
        onError: (error) => {
            if (useProjectStore.getState().activeProject?.id !== project.id) return;
            useProjectStore.setState({
                persistenceStatus: 'error',
                persistenceError: error,
                persistenceRetryKind: error instanceof StandaloneEditorUnsupportedError
                    ? null
                    : 'standalone-engine',
            });
        },
        onProjection: async ({ revision, projectName }) => {
            const projectStore = useProjectStore.getState();
            if (projectStore.activeProject?.id !== project.id) return;
            projectStore.checkDirty(revision);
            if (projectStore.activeProject.name !== projectName) {
                const context = {
                    projectId: project.id,
                    generation: projectStore.persistenceGeneration,
                };
                const authoritativeProject = {
                    ...projectStore.activeProject,
                    name: projectName,
                };
                useProjectStore.setState({ activeProject: authoritativeProject });
                try {
                    await enqueueProjectMetadataWrite(
                        context,
                        authoritativeProject,
                        (current) => ({
                            ...current,
                            name: projectName,
                            updatedAt: new Date(),
                        }),
                    );
                } catch (error) {
                    if (isProjectContextActive(useProjectStore.getState(), context)) {
                        useProjectStore.setState({
                            persistenceStatus: 'error',
                            persistenceError: error,
                            persistenceRetryKind: 'project-save',
                        });
                    }
                    return;
                }
            } else if (projectStore.persistenceRetryKind === 'project-save') {
                return;
            }
            useProjectStore.setState({
                persistenceStatus: 'saved',
                persistenceError: null,
                persistenceRetryKind: null,
            });
        },
    });
    activeStandaloneEditorAdapter = adapter;
    setStandaloneEditorEngineBridge(adapter);
    return adapter;
};

class ProjectNotFoundError extends Error {
    constructor(projectId: string) {
        super(`Project ${projectId} not found`);
        this.name = 'ProjectNotFoundError';
    }
}

const invalidateProjectLoadRequests = (): void => {
    latestProjectLoadRequest += 1;
};

const attachProjectPersistence = (projectId: string) => {
    const attachment = editorPersistenceRegistry.attach(projectId);
    setTimelinePersistenceBinding({
        projectId,
        generation: attachment.generation,
        enqueue: (manifest, sourceAssets, history) => editorPersistenceRegistry.enqueue(
            projectId,
            attachment.generation,
            manifest,
            sourceAssets,
            history,
        ),
        enqueueV4: (manifest, sourceAssets, history) => editorPersistenceRegistry.enqueue(
            projectId,
            attachment.generation,
            manifest,
            sourceAssets,
            history,
        ),
    });
    return attachment;
};

const getPersistentAssets = (timeline: ReturnType<typeof useTimelineStore.getState>): EditorPersistentAsset[] => (
    selectPersistentEditorAssets(timeline)
);

const createProjectSaveIdentity = (
    project: TProject,
    generation: number,
    timelineRevision: number,
): ProjectSaveIdentity => ({
    projectId: project.id,
    generation,
    projectName: project.name,
    timelineRevision,
});

const projectSaveIdentitiesEqual = (
    left: ProjectSaveIdentity | null,
    right: ProjectSaveIdentity,
): boolean => Boolean(left
    && left.projectId === right.projectId
    && left.generation === right.generation
    && left.projectName === right.projectName
    && left.timelineRevision === right.timelineRevision);

const isProjectContextActive = (
    state: Pick<ProjectStore, 'activeProject' | 'persistenceGeneration'>,
    context: ProjectOperationContext,
): boolean => state.activeProject?.id === context.projectId
    && state.persistenceGeneration === context.generation;

interface ProjectMetadataWriteQueue {
    tail: Promise<void>;
    latestProject: TProject | null;
}

const projectMetadataWriteQueues = new Map<string, ProjectMetadataWriteQueue>();

const projectMetadataQueueKey = (context: ProjectOperationContext): string => (
    `${context.projectId}\u0000${context.generation}`
);

/**
 * Serializes whole-record project-index writes within one persistence generation.
 *
 * IndexedDB stores project metadata as one object. Without this queue, a duration write and a
 * thumbnail/name write that start from the same snapshot can finish out of order and erase each
 * other's fields. Publishing the completed record inside the queue also guarantees the next
 * operation observes every field committed by its predecessor.
 */
const enqueueProjectMetadataWrite = (
    context: ProjectOperationContext,
    fallbackProject: TProject,
    update: (project: TProject) => TProject,
): Promise<TProject> => {
    const key = projectMetadataQueueKey(context);
    const queue = projectMetadataWriteQueues.get(key) ?? {
        tail: Promise.resolve(),
        latestProject: null,
    };
    projectMetadataWriteQueues.set(key, queue);

    const write = queue.tail.catch(() => undefined).then(async () => {
        const state = useProjectStore.getState();
        const baseProject = isProjectContextActive(state, context) && state.activeProject
            ? state.activeProject
            : queue.latestProject ?? fallbackProject;
        const updatedProject = update(baseProject);
        await storageService.saveProject(updatedProject);
        queue.latestProject = updatedProject;
        if (isProjectContextActive(useProjectStore.getState(), context)) {
            useProjectStore.setState({ activeProject: updatedProject });
        }
        return updatedProject;
    });
    const settledTail = write.then(() => undefined, () => undefined);
    queue.tail = settledTail;
    void settledTail.finally(() => {
        if (projectMetadataWriteQueues.get(key)?.tail === settledTail) {
            projectMetadataWriteQueues.delete(key);
        }
    });
    return write;
};

const buildLegacyEditorDocument = async (
    legacy: Awaited<ReturnType<typeof storageService.loadLegacyProjectPayload>>,
): Promise<EditorDocumentV4> => {
    const tracks = legacy.tracks ?? [];
    const activeTrackId = tracks[0]?.id ?? null;
    const transcriptionByTrackId: Record<string, TrackTranscriptionState> = {};

    if (activeTrackId && legacy.transcriptionGroups && legacy.transcriptionContainerIds) {
        transcriptionByTrackId[activeTrackId] = {
            raw: legacy.rawTranscription ?? [],
            groups: legacy.transcriptionGroups,
            containerIds: legacy.transcriptionContainerIds,
        };
    }

    // A scalar legacy project has no stream descriptor. Inspection is the only safe way to
    // recover its audio flag and render profile before the pure V3 migration is applied.
    const source = legacy.videoFile ? await inspectVideoSource(legacy.videoFile) : null;
    return migrateLegacyEditorDocumentToV4({
        tracks,
        rawTranscription: activeTrackId ? transcriptionByTrackId[activeTrackId]?.raw ?? null : null,
        transcriptionGroups: activeTrackId ? transcriptionByTrackId[activeTrackId]?.groups ?? null : null,
        transcriptionContainerIds: activeTrackId ? transcriptionByTrackId[activeTrackId]?.containerIds ?? null : null,
        loadedVideoSource: source,
    });
};

export const useProjectStore = create<ProjectStore>((set, get) => ({
    activeProject: null,
    savedProjects: [],
    isProjectLoading: false,
    isListLoading: false,
    isSaving: false,
    isInitialized: false,
    isDirty: false,
    lastSavedIdentity: null,
    persistenceGeneration: 0,
    persistenceStatus: null,
    persistenceError: null,
    persistenceRetryKind: null,
    projectRouteIntentId: null,
    projectRouteIntentToken: 0,
    loadingProjectId: null,
    projectLoadError: null,
    recoveryDocumentRevision: null,

    setIsDirty: (isDirty) => {
        // Deprecated manual setter, but kept for compatibility. 
        // Ideally we rely on checkDirty, but if something explicitly wants to set dirty (like a new action), we allow it?
        // Actually, let's make setIsDirty trigger a check or just force it?
        // For now, let's replace its usage with checkDirty in consumers, or assume consumers call explicit actions.
        set({ isDirty });
    },

    checkDirty: (timelineRevision = useTimelineStore.getState().revision) => {
        const { activeProject, lastSavedIdentity, persistenceGeneration } = get();
        if (!activeProject) {
            set({ isDirty: false });
            return;
        }

        const currentIdentity = createProjectSaveIdentity(
            activeProject,
            persistenceGeneration,
            timelineRevision,
        );
        set({ isDirty: !projectSaveIdentitiesEqual(lastSavedIdentity, currentIdentity) });
    },

    updateLastSavedState: () => {
        const { activeProject, persistenceGeneration } = get();
        if (!activeProject) return;

        set({
            lastSavedIdentity: createProjectSaveIdentity(
                activeProject,
                persistenceGeneration,
                useTimelineStore.getState().revision,
            ),
            isDirty: false,
        });
    },

    createProject: async (name: string) => {
        invalidateProjectLoadRequests();
        const previous = get();
        const newProject: TProject = {
            id: crypto.randomUUID(),
            name,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        // A newly created editor is a real project switch. Clear the previous session credential/
        // body cache before installing the new persistence and transcript publication guards.
        await closeStandaloneEditorAdapter();
        await timelineEditorialRuntime.detachProject().catch(() => undefined);
        if (previous.activeProject) {
            editorPersistenceRegistry.close(previous.activeProject.id, previous.persistenceGeneration);
        }
        const attachment = attachProjectPersistence(newProject.id);
        timelineEditorialRuntime.attachProject({
            projectId: newProject.id,
            persistenceGeneration: attachment.generation,
            sessionId: `editor-${attachment.generation}-${crypto.randomUUID()}`,
        });
        set({
            activeProject: newProject,
            persistenceGeneration: attachment.generation,
            persistenceStatus: null,
            persistenceError: null,
            persistenceRetryKind: null,
            projectRouteIntentId: null,
            projectRouteIntentToken: 0,
            isSaving: false,
            isProjectLoading: false,
            loadingProjectId: null,
            projectLoadError: null,
            recoveryDocumentRevision: null,
        });

        useTimelineStore.getState().resetEditorDocument();
        const timelineStore = useTimelineStore.getState();

        // Reset playback
        usePlaybackStore.getState().reset();

        // Initial state for new project (empty tracks)
        get().updateLastSavedState();

        try {
            await storageService.saveProject(newProject);
            const initialPayload = createTimelinePersistencePayload(
                timelineStore,
                getPersistentAssets(timelineStore),
            );
            editorPersistenceRegistry.enqueue(
                newProject.id,
                attachment.generation,
                initialPayload.manifest,
                initialPayload.sourceAssets,
                initialPayload.history,
            );
            await editorPersistenceRegistry.flush(newProject.id);
            await attachStandaloneEditorAdapter(newProject);
            await get().loadAllProjects();
            return newProject.id;
        } catch (error) {
            editorPersistenceRegistry.close(newProject.id, attachment.generation);
            await closeStandaloneEditorAdapter();
            await timelineEditorialRuntime.detachProject().catch(() => undefined);
            setTimelinePersistenceBinding(null);
            // Project discovery is created before the first document flush. If that flush fails,
            // remove both records so the dashboard cannot expose an empty, unreopenable project.
            await editorPersistenceRegistry.deleteProject(newProject.id).catch(() => undefined);
            await storageService.deleteProjectIndex(newProject.id).catch(() => undefined);
            timelineStore.resetEditorDocument();
            usePlaybackStore.getState().reset();
            set({
                activeProject: null,
                persistenceGeneration: 0,
                persistenceError: error,
                persistenceRetryKind: null,
                lastSavedIdentity: null,
                projectRouteIntentId: null,
                projectRouteIntentToken: 0,
                recoveryDocumentRevision: null,
            });
            console.error('Failed to create project:', error);
            throw error;
        }
    },

    beginProjectRouteIntent: (id: string) => {
        const current = get();
        const token = ++latestProjectRouteIntent;

        // Route intent is authoritative even when the requested project is already active. A
        // slow load for another route must lose ownership immediately when browser navigation
        // returns to the active editor, without clearing or rehydrating that editor first.
        invalidateProjectLoadRequests();
        set({
            projectRouteIntentId: id,
            projectRouteIntentToken: token,
            isProjectLoading: false,
            loadingProjectId: null,
            projectLoadError: current.projectLoadError?.projectId === id
                ? current.projectLoadError
                : null,
        });
        return token;
    },

    clearProjectRouteIntent: (id: string, token: number) => {
        const current = get();
        if (
            current.projectRouteIntentId !== id
            || current.projectRouteIntentToken !== token
        ) return;

        // Effect cleanup can arrive after a newer mount has already claimed the same route ID.
        // The per-mount token prevents that stale cleanup from cancelling the newer load.
        invalidateProjectLoadRequests();
        set({
            projectRouteIntentId: null,
            projectRouteIntentToken: 0,
            isProjectLoading: false,
            loadingProjectId: null,
            projectLoadError: current.projectLoadError?.projectId === id
                ? null
                : current.projectLoadError,
        });
    },

    loadProject: async (id: string) => {
        if (get().projectRouteIntentId !== id) get().beginProjectRouteIntent(id);
        const routeIntentToken = get().projectRouteIntentToken;
        const request = ++latestProjectLoadRequest;
        const isLatestRequest = () => request === latestProjectLoadRequest
            && get().projectRouteIntentId === id
            && get().projectRouteIntentToken === routeIntentToken;
        set({
            isProjectLoading: true,
            loadingProjectId: id,
            projectLoadError: null,
        });

        try {
            const recoveredPersistenceFailure = await editorPersistenceRegistry.settleBeforeOpen(id);
            if (!isLatestRequest()) return;

            const project = await storageService.loadProject(id);
            if (!isLatestRequest()) return;
            if (!project) throw new ProjectNotFoundError(id);

            const loadedDocument = await storageService.loadEditorDocument(id, { targetVersion: 4 });
            let document = loadedDocument ? migrateLoadedEditorDocumentToV4(loadedDocument) : null;
            if (!isLatestRequest()) return;
            const legacy = document ? null : await storageService.loadLegacyProjectPayload(id);
            if (!isLatestRequest()) return;
            let migratedLegacy = false;

            if (!document) {
                document = await buildLegacyEditorDocument(legacy!);
                if (!isLatestRequest()) return;
                migratedLegacy = true;
            }
            const validation = validateEditorDocumentV4(document);
            if (!validation.valid) {
                throw new Error(validation.issues
                    .map((issue) => `${issue.path}: ${issue.message}`)
                    .join('; '));
            }

            // No active project, timeline graph, or persistence binding is changed until every
            // asynchronous read has completed and this request is still the newest route intent.
            // The remaining commit is synchronous, so an older request cannot publish between
            // the final token check and the new generation becoming active.
            const durableDocument = document;
            const runtimeState = migratedLegacy
                ? null
                : await storageService.loadEditorRuntimeState(id, document);
            if (!isLatestRequest()) return;
            if (runtimeState) document = migrateLoadedEditorDocumentToV4(runtimeState.document);
            const resolvedEditorialBodies = await timelineEditorialRuntime.resolveDocumentDetached(document);
            if (!isLatestRequest()) return;

            const previous = get();
            await closeStandaloneEditorAdapter();
            await timelineEditorialRuntime.detachProject().catch(() => undefined);
            if (!isLatestRequest()) return;
            const attachment = attachProjectPersistence(id);
            timelineEditorialRuntime.attachProject({
                projectId: id,
                persistenceGeneration: attachment.generation,
                sessionId: `editor-${attachment.generation}-${crypto.randomUUID()}`,
            });
            timelineEditorialRuntime.injectResolvedBodies(resolvedEditorialBodies);
            if (previous.activeProject) {
                editorPersistenceRegistry.close(previous.activeProject.id, previous.persistenceGeneration);
            }
            const timelineStore = useTimelineStore.getState();
            timelineStore.hydrateEditorDocument(document, runtimeState?.history);
            if (!migratedLegacy) {
                editorPersistenceRegistry.markManifestDurable(
                    id,
                    createEditorManifestV4(durableDocument),
                    {
                        // WAL history entries are not durable until the recovery checkpoint writes
                        // their editor-history payloads. Mark only the materialized checkpoint as
                        // durable so the immediate recovery enqueue upserts every recovered entry
                        // before atomically clearing the WAL.
                        history: runtimeState?.durableHistory.history ?? [],
                        redoStack: runtimeState?.durableHistory.redoStack ?? [],
                        projection: projectEditorDocumentHistoryV4(durableDocument),
                    },
                    runtimeState?.recoveryEntryKeys ?? [],
                );
                if (runtimeState?.recovered) {
                    // Zustand replaces the state object during hydration. Re-read it here: the
                    // pre-hydration snapshot above still contains the default revision/history and
                    // would checkpoint an empty document while clearing a valid recovery WAL.
                    const recoveredPayload = createTimelinePersistencePayload(
                        useTimelineStore.getState(),
                    );
                    editorPersistenceRegistry.enqueue(
                        id,
                        attachment.generation,
                        recoveredPayload.manifest,
                        recoveredPayload.sourceAssets,
                        recoveredPayload.history,
                    );
                }
            }

            const standaloneAdapter = await attachStandaloneEditorAdapter(project);
            if (!isLatestRequest()) {
                if (activeStandaloneEditorAdapter === standaloneAdapter) {
                    await closeStandaloneEditorAdapter();
                }
                return;
            }
            const engineProjectName = standaloneAdapter?.getSnapshot().project.name;
            const authoritativeProject = engineProjectName && engineProjectName !== project.name
                ? { ...project, name: engineProjectName }
                : project;
            let metadataReconciliationFailure: unknown = null;
            if (authoritativeProject !== project) {
                try {
                    await storageService.saveProject(authoritativeProject);
                } catch (error) {
                    metadataReconciliationFailure = error;
                }
                if (!isLatestRequest()) return;
            }
            const visiblePersistenceFailure = metadataReconciliationFailure
                ?? recoveredPersistenceFailure
                ?? attachment.coordinator.observeFailure();
            set({
                activeProject: authoritativeProject,
                persistenceGeneration: attachment.generation,
                persistenceStatus: null,
                persistenceError: visiblePersistenceFailure,
                persistenceRetryKind: metadataReconciliationFailure
                    ? 'project-save'
                    : visiblePersistenceFailure
                        ? 'editor-document'
                        : null,
                isSaving: false,
                projectLoadError: null,
                recoveryDocumentRevision: null,
            });
            get().updateLastSavedState();

            if (migratedLegacy) {
                // The manifest and its File are committed in one IndexedDB transaction. Legacy
                // records remain as a harmless fallback until the V3 transaction is durable.
                const migratedTimeline = useTimelineStore.getState();
                const migratedPayload = createTimelinePersistencePayload(
                    migratedTimeline,
                    getPersistentAssets(migratedTimeline),
                );
                editorPersistenceRegistry.enqueue(
                    id,
                    attachment.generation,
                    migratedPayload.manifest,
                    migratedPayload.sourceAssets,
                    migratedPayload.history,
                );
                try {
                    await editorPersistenceRegistry.flush(id);
                } catch {
                    // The editor is already usable. The coordinator owns the exact failed
                    // migration manifest and exposes it through the normal persistence retry.
                }
                if (!isLatestRequest()) return;
                if (isProjectContextActive(get(), {
                    projectId: id,
                    generation: attachment.generation,
                })) {
                    // A successful migration must not erase a failure recovered from a previous
                    // session before the user has had a chance to see it.
                    set({
                        persistenceError: recoveredPersistenceFailure
                            ?? attachment.coordinator.observeFailure(),
                        persistenceRetryKind: recoveredPersistenceFailure
                            || attachment.coordinator.observeFailure()
                            ? 'editor-document'
                            : null,
                    });
                }
            }

            if (!isLatestRequest()) return;
            const hydratedTimeline = useTimelineStore.getState();
            const contentDuration = selectTimelineContentDuration(hydratedTimeline);
            const primarySource = document.videoSources[0];
            const context = { projectId: id, generation: attachment.generation };
            if (project.duration !== contentDuration) {
                // Dashboard duration reflects the complete edit, including audio tails and a
                // still-editable audio-only graph after every video clip has been removed.
                set((state) => isProjectContextActive(state, context) && state.activeProject
                    ? { activeProject: { ...state.activeProject, duration: contentDuration } }
                    : state);
                void get().updateProjectDuration(context, contentDuration);
            }
            if (primarySource && !project.thumbnail) {
                void import('@/lib/mediabunny-utils')
                    .then(({ generateThumbnail }) => generateThumbnail(primarySource.file, 0))
                    .then((thumbnail) => get().updateThumbnail(context, thumbnail))
                    .catch((error) => console.error('Failed to generate missing thumbnail', error));
            }
        } catch (error) {
            if (!isLatestRequest()) return;
            set({
                projectLoadError: {
                    projectId: id,
                    kind: error instanceof ProjectNotFoundError ? 'not-found' : 'unreadable',
                    cause: error,
                },
            });
            console.error('Failed to load project:', error);
            throw error;
        } finally {
            if (isLatestRequest()) {
                set({ isProjectLoading: false, loadingProjectId: null });
            }
        }
    },

    retryProjectLoad: async () => {
        const { projectLoadError, projectRouteIntentId } = get();
        if (!projectLoadError || projectLoadError.projectId !== projectRouteIntentId) return;
        await get().loadProject(projectLoadError.projectId);
    },

    saveCurrentProject: async () => {
        const { activeProject, persistenceGeneration } = get();
        if (!activeProject) return;
        if (!persistenceGeneration) {
            const error = new Error(`Project ${activeProject.id} has no active persistence generation.`);
            set({
                persistenceStatus: 'error',
                persistenceError: error,
                persistenceRetryKind: null,
            });
            return;
        }

        set({ isSaving: true });
        const context = { projectId: activeProject.id, generation: persistenceGeneration };
        const isStillActive = () => isProjectContextActive(get(), context);

        try {
            await enqueueProjectMetadataWrite(context, activeProject, (project) => ({
                ...project,
                updatedAt: new Date(),
            }));
            const standaloneEngine = getStandaloneEditorEngineBridge();
            if (standaloneEngine) {
                await standaloneEngine.flush();
                if (!isStillActive()) return;
                const currentProject = get().activeProject!;
                const currentRevision = useTimelineStore.getState().revision;
                set({
                    lastSavedIdentity: createProjectSaveIdentity(
                        currentProject,
                        persistenceGeneration,
                        currentRevision,
                    ),
                    isDirty: false,
                    persistenceStatus: 'saved',
                    persistenceError: null,
                    persistenceRetryKind: null,
                });
                await get().loadAllProjects();
                return;
            }
            const timelineStore = useTimelineStore.getState();
            const persistencePayload = createTimelinePersistencePayload(
                timelineStore,
                getPersistentAssets(timelineStore),
            );
            const { manifest, sourceAssets } = persistencePayload;
            editorPersistenceRegistry.enqueue(
                context.projectId,
                persistenceGeneration,
                manifest,
                sourceAssets,
                persistencePayload.history,
            );
            await editorPersistenceRegistry.flush(context.projectId);
            if (isStillActive()) {
                const currentProject = get().activeProject!;
                const savedIdentity = createProjectSaveIdentity(
                    currentProject,
                    persistenceGeneration,
                    manifest.revision,
                );
                const currentTimelineRevision = useTimelineStore.getState().revision;
                set({
                    lastSavedIdentity: savedIdentity,
                    isDirty: !projectSaveIdentitiesEqual(
                        savedIdentity,
                        createProjectSaveIdentity(
                            currentProject,
                            persistenceGeneration,
                            currentTimelineRevision,
                        ),
                    ),
                    persistenceStatus: 'saved',
                    persistenceError: null,
                    persistenceRetryKind: null,
                });
            }
            await get().loadAllProjects();
        } catch (error) {
            if (isStillActive()) {
                const coordinatorFailure = editorPersistenceRegistry.observeFailure(context.projectId);
                set({
                    persistenceStatus: 'error',
                    persistenceError: coordinatorFailure ?? error,
                    persistenceRetryKind: getStandaloneEditorEngineBridge()
                        ? 'standalone-engine'
                        : coordinatorFailure
                            ? 'editor-document'
                            : 'project-save',
                });
            }
            console.error('Failed to save project:', error);
        } finally {
            if (isStillActive()) set({ isSaving: false });
        }
    },

    retryPersistence: async () => {
        const { activeProject, persistenceGeneration, persistenceRetryKind } = get();
        if (!activeProject || !persistenceGeneration || !persistenceRetryKind) return;
        if (persistenceRetryKind === 'standalone-engine') {
            set({ isSaving: true });
            try {
                const retried = await getStandaloneEditorEngineBridge()?.retryLastFailure();
                if (retried) {
                    set({
                        persistenceStatus: 'saved',
                        persistenceError: null,
                        persistenceRetryKind: null,
                    });
                }
            } finally {
                set({ isSaving: false });
            }
            return;
        }
        if (persistenceRetryKind === 'project-save') {
            // Metadata failures happen before the coordinator retains a document request. Running
            // the normal save path again captures the latest project and manifest for this exact
            // still-active generation instead of presenting a Retry button with no recovery work.
            await get().saveCurrentProject();
            return;
        }

        set({ isSaving: true });
        const projectId = activeProject.id;
        const isStillActive = () => {
            const current = get();
            return current.activeProject?.id === projectId
                && current.persistenceGeneration === persistenceGeneration;
        };

        if (persistenceRetryKind === 'recovery-load') {
            const recoveryRevision = get().recoveryDocumentRevision;
            const ownsRecoveryLoadAttempt = () => {
                const current = get();
                return isStillActive()
                    && current.persistenceRetryKind === 'recovery-load'
                    && current.recoveryDocumentRevision === recoveryRevision;
            };
            try {
                if (!recoveryRevision) throw new Error('Recovered document revision is unavailable.');
                const recoveredDocument = await storageService.loadEditorDocument(projectId, { targetVersion: 4 });
                if (!recoveredDocument || recoveredDocument.revision !== recoveryRevision) {
                    throw new Error(`Recovered revision ${recoveryRevision} could not be loaded.`);
                }
                const recoveredRuntime = await storageService.loadEditorRuntimeState(
                    projectId,
                    recoveredDocument,
                );
                const recoveredEditorDocument = migrateLoadedEditorDocumentToV4(
                    recoveredRuntime.document,
                );
                if (recoveredEditorDocument.revision !== recoveryRevision) {
                    throw new Error(`Recovered runtime revision ${recoveryRevision} could not be loaded.`);
                }
                const runtimeContext = timelineEditorialRuntime.getProjectContext();
                const resolvedEditorialBodies = await timelineEditorialRuntime.resolveDocumentDetached(
                    recoveredEditorDocument,
                );
                const liveRevision = useTimelineStore.getState().revision;
                if (
                    ownsRecoveryLoadAttempt()
                    && liveRevision === recoveryRevision
                ) {
                    const published = timelineEditorialRuntime.publishResolvedDocument(
                        recoveredEditorDocument,
                        resolvedEditorialBodies,
                        runtimeContext,
                        () => useTimelineStore.getState().hydrateEditorDocument(
                            recoveredEditorDocument,
                            recoveredRuntime.history,
                        ),
                    );
                    if (!published) {
                        throw new DOMException(
                            'Recovered editorial transcript hydration became stale.',
                            'AbortError',
                        );
                    }
                    get().updateLastSavedState();
                }
                if (ownsRecoveryLoadAttempt()) {
                    set({
                        // A newer live revision can already be pending behind this recovered read.
                        // Preserve that coordinator status instead of briefly claiming it is saved.
                        ...(liveRevision === recoveryRevision
                            ? { persistenceStatus: 'saved' as const }
                            : {}),
                        persistenceError: null,
                        persistenceRetryKind: null,
                        recoveryDocumentRevision: null,
                    });
                }
            } catch (error) {
                if (ownsRecoveryLoadAttempt()) {
                    set({
                        persistenceStatus: 'error',
                        persistenceError: error,
                        persistenceRetryKind: 'recovery-load',
                    });
                }
            } finally {
                if (isStillActive()) set({ isSaving: false });
            }
            return;
        }

        let recoveryReadRevision: number | null = null;
        try {
            const failedManifest = editorPersistenceRegistry.getFailedManifestV4(projectId)
                ?? editorPersistenceRegistry.getFailedManifest(projectId);
            const liveRevisionBeforeRetry = useTimelineStore.getState().revision;
            const shouldHydrateRecoveredManifest = Boolean(
                failedManifest && liveRevisionBeforeRetry < failedManifest.revision,
            );
            if (failedManifest) {
                // A failure can outlive the editor instance that created it. Reserve its revision
                // before retrying so edits made while the write is in flight are necessarily newer
                // and cannot be dropped by the coordinator's monotonic revision filter.
                useTimelineStore.getState().ensureRevisionAtLeast(failedManifest.revision);
            }
            const retried = await editorPersistenceRegistry.retry(projectId, persistenceGeneration);
            if (!retried && isStillActive()) {
                // False means this generation no longer owns a failed request. Treat it as an
                // already-recovered terminal state instead of leaving an error with no action.
                set({
                    persistenceStatus: 'saved',
                    persistenceError: null,
                    persistenceRetryKind: null,
                    recoveryDocumentRevision: null,
                });
            } else if (
                // retry() drains edits queued behind the retained manifest. If the live revision
                // advanced, that newer document is already durable and supersedes recovery of N.
                retried
                && failedManifest
                && shouldHydrateRecoveredManifest
                && isStillActive()
                && useTimelineStore.getState().revision === failedManifest.revision
            ) {
                recoveryReadRevision = failedManifest.revision;
                set({ recoveryDocumentRevision: recoveryReadRevision });
                const recoveredDocument = await storageService.loadEditorDocument(projectId, { targetVersion: 4 });
                const ownsRecoveryRead = () => isStillActive()
                    && get().recoveryDocumentRevision === recoveryReadRevision;
                if (!ownsRecoveryRead()) return;
                if (!recoveredDocument || recoveredDocument.revision !== recoveryReadRevision) {
                    throw new Error(`Recovered revision ${recoveryReadRevision} could not be loaded.`);
                }
                const recoveredRuntime = await storageService.loadEditorRuntimeState(
                    projectId,
                    recoveredDocument,
                );
                const recoveredEditorDocument = migrateLoadedEditorDocumentToV4(
                    recoveredRuntime.document,
                );
                if (recoveredEditorDocument.revision !== recoveryReadRevision) {
                    throw new Error(`Recovered runtime revision ${recoveryReadRevision} could not be loaded.`);
                }
                const runtimeContext = timelineEditorialRuntime.getProjectContext();
                const resolvedEditorialBodies = await timelineEditorialRuntime.resolveDocumentDetached(
                    recoveredEditorDocument,
                );
                const currentTimeline = useTimelineStore.getState();
                if (
                    ownsRecoveryRead()
                    && currentTimeline.revision === recoveryReadRevision
                ) {
                    // No live edit raced the retry, so the exact recovered document can safely
                    // become the visible graph. A newer live revision always wins and is already
                    // queued behind the retained failure by the coordinator.
                    const published = timelineEditorialRuntime.publishResolvedDocument(
                        recoveredEditorDocument,
                        resolvedEditorialBodies,
                        runtimeContext,
                        () => currentTimeline.hydrateEditorDocument(
                            recoveredEditorDocument,
                            recoveredRuntime.history,
                        ),
                    );
                    if (!published) {
                        throw new DOMException(
                            'Recovered editorial transcript hydration became stale.',
                            'AbortError',
                        );
                    }
                    get().updateLastSavedState();
                }
                if (ownsRecoveryRead()) set({ recoveryDocumentRevision: null });
            }
        } catch (error) {
            // A retained write failure remains coordinator-retryable. If that write already
            // succeeded but reading it back failed, preserve a distinct hydration retry instead.
            if (isStillActive()) {
                if (
                    recoveryReadRevision !== null
                    && get().recoveryDocumentRevision !== recoveryReadRevision
                ) return;
                set({
                    persistenceError: error,
                    persistenceRetryKind: recoveryReadRevision !== null
                        ? 'recovery-load'
                        : 'editor-document',
                });
            }
        } finally {
            if (isStillActive()) set({ isSaving: false });
        }
    },

    loadAllProjects: async () => {
        set({ isListLoading: true });
        try {
            const projects = await storageService.loadAllProjects();
            set({ savedProjects: projects, isInitialized: true });
        } catch (error) {
            console.error('Failed to load projects:', error);
        } finally {
            set({ isListLoading: false });
        }
    },

    deleteProject: async (id: string) => {
        try {
            await editorPersistenceRegistry.deleteProject(id);
            // Project discovery is removed last, only after the long-lived database deletion
            // request has actually succeeded rather than merely reporting onblocked.
            await storageService.deleteProjectIndex(id);
            await get().loadAllProjects();

            const { activeProject } = get();
            if (activeProject?.id === id) {
                get().closeProject();
            }
        } catch (error) {
            set({ persistenceError: error, persistenceRetryKind: null });
            console.error('Failed to delete project:', error);
            throw error;
        }
    },

    closeProject: () => {
        invalidateProjectLoadRequests();
        const { activeProject, persistenceGeneration } = get();
        const adapter = activeStandaloneEditorAdapter;
        activeStandaloneEditorAdapter = null;
        setStandaloneEditorEngineBridge(null);
        void adapter?.close().catch(() => undefined);
        if (activeProject) editorPersistenceRegistry.close(activeProject.id, persistenceGeneration);
        void timelineEditorialRuntime.detachProject().catch(() => undefined);
        setTimelinePersistenceBinding(null);
        set({
            activeProject: null,
            persistenceGeneration: 0,
            persistenceStatus: null,
            persistenceError: null,
            persistenceRetryKind: null,
            isSaving: false,
            isProjectLoading: false,
            projectRouteIntentId: null,
            projectRouteIntentToken: 0,
            loadingProjectId: null,
            projectLoadError: null,
            lastSavedIdentity: null,
            isDirty: false,
            recoveryDocumentRevision: null,
        });
        const timelineStore = useTimelineStore.getState();
        timelineStore.resetEditorDocument();
        usePlaybackStore.getState().reset();
    },

    updateProjectName: async (name: string) => {
        const { activeProject, persistenceGeneration } = get();
        if (!activeProject) return;
        const context = { projectId: activeProject.id, generation: persistenceGeneration };

        try {
            const standaloneEngine = getStandaloneEditorEngineBridge();
            if (standaloneEngine) {
                const selection = useTimelineStore.getState().transientSelection;
                const result = await standaloneEngine.dispatchOperations(
                    mapStandaloneProjectName(name),
                    {
                        history: { label: 'Rename project', category: 'project' },
                        selectionBefore: selection,
                        selectionAfter: selection,
                        compatibilityResult: {
                            kind: 'success',
                            command: 'rename-project',
                            playhead: { kind: 'keep', reason: 'non-structural' },
                        },
                    },
                );
                if (result.kind === 'error') throw new Error(result.error.message);
            } else {
                await enqueueProjectMetadataWrite(
                    context,
                    activeProject,
                    (project) => ({ ...project, name, updatedAt: new Date() }),
                );
            }
            if (!isProjectContextActive(get(), context)) return;
            if (get().activeProject?.name !== name) return;
            set((state) => ({
                lastSavedIdentity: state.lastSavedIdentity
                    && state.lastSavedIdentity.projectId === context.projectId
                    && state.lastSavedIdentity.generation === context.generation
                    ? { ...state.lastSavedIdentity, projectName: name }
                    : state.lastSavedIdentity,
            }));
            get().checkDirty();
            await get().loadAllProjects();
        } catch (error) {
            console.error('Failed to update project name:', error);
        }
    },

    updateThumbnail: async (context, thumbnail) => {
        const { activeProject } = get();
        if (!activeProject || !isProjectContextActive(get(), context)) return;

        try {
            await enqueueProjectMetadataWrite(
                context,
                activeProject,
                (project) => ({ ...project, thumbnail, updatedAt: new Date() }),
            );
            if (!isProjectContextActive(get(), context)) return;
            await get().loadAllProjects();
        } catch (error) {
            console.error('Failed to update thumbnail:', error);
        }
    },

    updateProjectDuration: async (context, duration) => {
        const { activeProject } = get();
        if (!activeProject || !isProjectContextActive(get(), context)) return;

        try {
            await enqueueProjectMetadataWrite(
                context,
                activeProject,
                (project) => ({ ...project, duration, updatedAt: new Date() }),
            );
            if (!isProjectContextActive(get(), context)) return;
            await get().loadAllProjects();
        } catch (error) {
            console.error('Failed to update project duration:', error);
        }
    }
}));

editorPersistenceRegistry.setActiveStatusListener((event) => {
    const runtimeContext = timelineEditorialRuntime.getProjectContext();
    if (event.status === 'saved'
        && runtimeContext?.projectId === event.projectId
        && runtimeContext.persistenceGeneration === event.generation) {
        void timelineEditorialRuntime.releaseCurrentSessionPins().catch(() => undefined);
    }
    useProjectStore.setState((state) => {
        if (event.status === 'error') {
            return {
                persistenceStatus: event.status,
                persistenceError: event.error ?? new Error('Persistence failed.'),
                // A pending project-save retry subsumes an editor-document failure: rerunning the
                // full save first commits metadata and then lets the coordinator retry its graph.
                persistenceRetryKind: state.persistenceRetryKind === 'project-save'
                    ? 'project-save'
                    : 'editor-document',
                // A coordinator result belongs to a newer durable mutation than any in-flight
                // recovery read. Invalidate that read so its later completion cannot erase this
                // actionable failure or misclassify a subsequent retry.
                recoveryDocumentRevision: null,
            };
        }
        if (event.status === 'saved' && state.persistenceRetryKind !== 'project-save') {
            return {
                persistenceStatus: event.status,
                persistenceError: null,
                persistenceRetryKind: null,
                recoveryDocumentRevision: null,
            };
        }
        return { persistenceStatus: event.status };
    });
});
