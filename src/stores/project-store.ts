import { create } from 'zustand';
import { TProject } from '@/types/project';
import { storageService } from '@/lib/storage/storage-service';
import { setTimelinePersistenceBinding, useTimelineStore } from './timeline-store';
import { usePlaybackStore } from './playback-store';
import type { EditorDocumentV3, TrackTranscriptionState } from '@/types/video';
import { inspectVideoSource } from '@/lib/video-source';
import { migrateLegacyEditorDocumentToV3 } from '@/lib/editor-document-migration';
import type { EditorPersistentAsset } from '@/lib/storage/storage-service';
import { getTimelineDurations } from '@/lib/video-timeline';
import {
    editorPersistenceRegistry,
    type EditorPersistenceStatus,
} from '@/lib/storage/editor-persistence';

interface ProjectStore {
    activeProject: TProject | null;
    savedProjects: TProject[];
    isProjectLoading: boolean;
    isListLoading: boolean;
    isSaving: boolean;
    isInitialized: boolean;
    isDirty: boolean;
    lastSavedState: string;
    persistenceGeneration: number;
    persistenceStatus: EditorPersistenceStatus | null;
    persistenceError: unknown | null;

    // Actions
    createProject: (name: string) => Promise<string>;
    loadProject: (id: string) => Promise<void>;
    saveCurrentProject: () => Promise<void>;
    loadAllProjects: () => Promise<void>;
    deleteProject: (id: string) => Promise<void>;
    closeProject: () => void;
    updateProjectName: (name: string) => Promise<void>;
    updateThumbnail: (thumbnail: string) => Promise<void>;
    updateProjectDuration: (duration: number) => Promise<void>;
    setIsDirty: (isDirty: boolean) => void;
    checkDirty: () => void;
    updateLastSavedState: () => void;
}

const attachProjectPersistence = (projectId: string) => {
    const attachment = editorPersistenceRegistry.attach(projectId);
    setTimelinePersistenceBinding({
        projectId,
        generation: attachment.generation,
        enqueue: (manifest, sourceAssets) => editorPersistenceRegistry.enqueue(
            projectId,
            attachment.generation,
            manifest,
            sourceAssets,
        ),
    });
    return attachment;
};

const getPersistentAssets = (timeline: ReturnType<typeof useTimelineStore.getState>): EditorPersistentAsset[] => [
    ...timeline.videoSources.map((asset): EditorPersistentAsset => ({ kind: 'video-source', asset })),
    ...timeline.audioSources.map((asset): EditorPersistentAsset => ({ kind: 'audio-source', asset })),
];

const serializeDirtyState = (project: TProject): string => {
    const timeline = useTimelineStore.getState();
    return JSON.stringify({
        name: project.name,
        editorManifest: timeline.buildEditorManifest(),
    });
};

const buildLegacyEditorDocument = async (
    legacy: Awaited<ReturnType<typeof storageService.loadLegacyProjectPayload>>,
): Promise<EditorDocumentV3> => {
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
    return migrateLegacyEditorDocumentToV3({
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
    lastSavedState: '',
    persistenceGeneration: 0,
    persistenceStatus: null,
    persistenceError: null,

    setIsDirty: (isDirty) => {
        // Deprecated manual setter, but kept for compatibility. 
        // Ideally we rely on checkDirty, but if something explicitly wants to set dirty (like a new action), we allow it?
        // Actually, let's make setIsDirty trigger a check or just force it?
        // For now, let's replace its usage with checkDirty in consumers, or assume consumers call explicit actions.
        set({ isDirty });
    },

    checkDirty: () => {
        const { activeProject, lastSavedState } = get();
        if (!activeProject) {
            set({ isDirty: false });
            return;
        }

        set({ isDirty: serializeDirtyState(activeProject) !== lastSavedState });
    },

    updateLastSavedState: () => {
        const { activeProject } = get();
        if (!activeProject) return;

        set({ lastSavedState: serializeDirtyState(activeProject), isDirty: false });
    },

    createProject: async (name: string) => {
        const newProject: TProject = {
            id: crypto.randomUUID(),
            name,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const attachment = attachProjectPersistence(newProject.id);
        set({
            activeProject: newProject,
            persistenceGeneration: attachment.generation,
            persistenceStatus: null,
            persistenceError: null,
        });

        const timelineStore = useTimelineStore.getState();
        timelineStore.resetEditorDocument();

        // Reset playback
        usePlaybackStore.getState().reset();

        // Initial state for new project (empty tracks)
        get().updateLastSavedState();

        try {
            await storageService.saveProject(newProject);
            editorPersistenceRegistry.enqueue(
                newProject.id,
                attachment.generation,
                timelineStore.buildEditorManifest(),
                getPersistentAssets(timelineStore),
            );
            await editorPersistenceRegistry.flush(newProject.id);
            await get().loadAllProjects();
            return newProject.id;
        } catch (error) {
            editorPersistenceRegistry.close(newProject.id, attachment.generation);
            setTimelinePersistenceBinding(null);
            // Project discovery is created before the first document flush. If that flush fails,
            // remove both records so the dashboard cannot expose an empty, unreopenable project.
            await editorPersistenceRegistry.deleteProject(newProject.id).catch(() => undefined);
            await storageService.deleteProjectIndex(newProject.id).catch(() => undefined);
            timelineStore.resetEditorDocument();
            usePlaybackStore.getState().reset();
            set({ activeProject: null, persistenceGeneration: 0, persistenceError: error });
            console.error('Failed to create project:', error);
            throw error;
        }
    },

    loadProject: async (id: string) => {
        set({ isProjectLoading: true });
        let persistenceGeneration = 0;
        let recoveredPersistenceFailure: unknown | null = null;
        try {
            recoveredPersistenceFailure = await editorPersistenceRegistry.settleBeforeOpen(id);
            const project = await storageService.loadProject(id);
            if (!project) throw new Error(`Project ${id} not found`);
            const previous = get();
            if (previous.activeProject) {
                editorPersistenceRegistry.close(previous.activeProject.id, previous.persistenceGeneration);
                setTimelinePersistenceBinding(null);
            }
            set({ activeProject: null });

            const attachment = editorPersistenceRegistry.attach(id);
            persistenceGeneration = attachment.generation;
            let document = await storageService.loadEditorDocument(id);
            const legacy = document ? null : await storageService.loadLegacyProjectPayload(id);
            const timelineStore = useTimelineStore.getState();
            let migratedLegacy = false;

            if (document) {
                timelineStore.hydrateEditorDocument(document);
                editorPersistenceRegistry.markManifestDurable(id, timelineStore.buildEditorManifest());
            } else {
                document = await buildLegacyEditorDocument(legacy!);
                timelineStore.hydrateEditorDocument(document);
                migratedLegacy = true;
            }

            set({
                activeProject: project,
                persistenceGeneration,
                persistenceStatus: null,
                persistenceError: recoveredPersistenceFailure ?? attachment.coordinator.observeFailure(),
            });

            setTimelinePersistenceBinding({
                projectId: id,
                generation: attachment.generation,
                enqueue: (manifest, sourceAssets) => editorPersistenceRegistry.enqueue(
                    id,
                    attachment.generation,
                    manifest,
                    sourceAssets,
                ),
            });

            if (migratedLegacy) {
                // The manifest and its File are committed in one IndexedDB transaction. Legacy
                // records remain as a harmless fallback until the V3 transaction is durable.
                const migratedTimeline = useTimelineStore.getState();
                editorPersistenceRegistry.enqueue(
                    id,
                    attachment.generation,
                    migratedTimeline.buildEditorManifest(),
                    getPersistentAssets(migratedTimeline),
                );
                await editorPersistenceRegistry.flush(id);
                // A successful migration must not erase a failure recovered from a previous
                // session before the user has had a chance to see it.
                set({ persistenceError: recoveredPersistenceFailure });
            }

            const hydratedTimeline = useTimelineStore.getState();
            const contentDuration = getTimelineDurations(
                hydratedTimeline.videoClips,
                hydratedTimeline.tracks,
                {
                    audioTracks: hydratedTimeline.audioTracks,
                    videoSources: hydratedTimeline.videoSources,
                    audioSources: hydratedTimeline.audioSources,
                    renderProfile: hydratedTimeline.renderProfile,
                },
            ).contentDuration;
            const primarySource = document.videoSources[0];
            if (project.duration !== contentDuration) {
                // Dashboard duration reflects the complete edit, including audio tails and a
                // still-editable audio-only graph after every video clip has been removed.
                set((state) => state.activeProject
                    ? { activeProject: { ...state.activeProject, duration: contentDuration } }
                    : state);
                void get().updateProjectDuration(contentDuration);
            }
            if (primarySource && !project.thumbnail) {
                const { generateThumbnail } = await import('@/lib/mediabunny-utils');
                void generateThumbnail(primarySource.file, 0)
                    .then((thumbnail) => get().updateThumbnail(thumbnail))
                    .catch((error) => console.error('Failed to generate missing thumbnail', error));
            }
            get().updateLastSavedState();
        } catch (error) {
            if (persistenceGeneration) editorPersistenceRegistry.close(id, persistenceGeneration);
            setTimelinePersistenceBinding(null);
            set({ persistenceError: recoveredPersistenceFailure ?? error });
            console.error('Failed to load project:', error);
            throw error;
        } finally {
            set({ isProjectLoading: false });
        }
    },

    saveCurrentProject: async () => {
        const { activeProject, persistenceGeneration } = get();
        if (!activeProject) return;

        set({ isSaving: true });
        const timelineStore = useTimelineStore.getState();

        const updatedProject = {
            ...activeProject,
            updatedAt: new Date(),
        };

        try {
            await storageService.saveProject(updatedProject);
            if (!persistenceGeneration) {
                throw new Error(`Project ${updatedProject.id} has no active persistence generation.`);
            }
            editorPersistenceRegistry.enqueue(
                updatedProject.id,
                persistenceGeneration,
                timelineStore.buildEditorManifest(),
                getPersistentAssets(timelineStore),
            );
            await editorPersistenceRegistry.flush(updatedProject.id);
            set({ activeProject: updatedProject });
            get().updateLastSavedState();
            await get().loadAllProjects();
        } catch (error) {
            set({ persistenceError: error });
            console.error('Failed to save project:', error);
        } finally {
            set({ isSaving: false });
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
            set({ persistenceError: error });
            console.error('Failed to delete project:', error);
            throw error;
        }
    },

    closeProject: () => {
        const { activeProject, persistenceGeneration } = get();
        if (activeProject) editorPersistenceRegistry.close(activeProject.id, persistenceGeneration);
        setTimelinePersistenceBinding(null);
        set({
            activeProject: null,
            persistenceGeneration: 0,
            persistenceStatus: null,
            persistenceError: null,
        });
        const timelineStore = useTimelineStore.getState();
        timelineStore.resetEditorDocument();
        usePlaybackStore.getState().reset();
    },

    updateProjectName: async (name: string) => {
        const { activeProject } = get();
        if (!activeProject) return;

        const updatedProject = {
            ...activeProject,
            name,
            updatedAt: new Date(),
        };

        try {
            await storageService.saveProject(updatedProject);
            set({ activeProject: updatedProject });
            get().checkDirty(); // Check dirty instead of blindly setting true
            await get().loadAllProjects();
        } catch (error) {
            console.error('Failed to update project name:', error);
        }
    },

    updateThumbnail: async (thumbnail: string) => {
        const { activeProject } = get();
        if (!activeProject) return;

        const updatedProject = {
            ...activeProject,
            thumbnail,
            updatedAt: new Date(),
        };

        try {
            await storageService.saveProject(updatedProject);
            set({ activeProject: updatedProject });
            await get().loadAllProjects();
        } catch (error) {
            console.error('Failed to update thumbnail:', error);
        }
    },

    updateProjectDuration: async (duration: number) => {
        const { activeProject } = get();
        if (!activeProject) return;

        const updatedProject = {
            ...activeProject,
            duration,
            updatedAt: new Date(),
        };

        try {
            await storageService.saveProject(updatedProject);
            set({ activeProject: updatedProject });
            await get().loadAllProjects();
        } catch (error) {
            console.error('Failed to update project duration:', error);
        }
    }
}));

editorPersistenceRegistry.setActiveStatusListener((event) => {
    useProjectStore.setState({
        persistenceStatus: event.status,
        persistenceError: event.status === 'error' ? event.error ?? new Error('Persistence failed.') : null,
    });
});
