import { create } from 'zustand';
import { TProject } from '@/types/project';
import { storageService } from '@/lib/storage/storage-service';
import { useTimelineStore } from './timeline-store';
import { useVideoStore } from './video-store';
import { usePlaybackStore } from './playback-store';
import { getVideoInfo } from '@/lib/mediabunny-utils';

interface ProjectStore {
    activeProject: TProject | null;
    savedProjects: TProject[];
    isLoading: boolean;
    isInitialized: boolean;
    isDirty: boolean;
    lastSavedState: string;

    // Actions
    createProject: (name: string) => Promise<string>;
    loadProject: (id: string) => Promise<void>;
    saveCurrentProject: () => Promise<void>;
    loadAllProjects: () => Promise<void>;
    deleteProject: (id: string) => Promise<void>;
    closeProject: () => void;
    updateProjectName: (name: string) => Promise<void>;
    setIsDirty: (isDirty: boolean) => void;
    checkDirty: () => void;
    updateLastSavedState: () => void;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
    activeProject: null,
    savedProjects: [],
    isLoading: false,
    isInitialized: false,
    isDirty: false,
    lastSavedState: '',

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

        // Dynamically import timeline store to avoid circular dependency at module level if possible, 
        // or just use the imported one. The import at top is fine as long as we use .getState() inside functions.
        // But we need to use the actual store instance.
        const timelineStore = useTimelineStore.getState();
        const videoFile = useVideoStore.getState().videoFile;
        const videoState = videoFile ? `${videoFile.name}-${videoFile.size}-${videoFile.type}` : 'no-video';

        const currentState = JSON.stringify({
            name: activeProject.name,
            tracks: timelineStore.tracks,
            video: videoState
        });

        set({ isDirty: currentState !== lastSavedState });
    },

    updateLastSavedState: () => {
        const { activeProject } = get();
        if (!activeProject) return;

        const timelineStore = useTimelineStore.getState();
        const videoFile = useVideoStore.getState().videoFile;
        const videoState = videoFile ? `${videoFile.name}-${videoFile.size}-${videoFile.type}` : 'no-video';

        const currentState = JSON.stringify({
            name: activeProject.name,
            tracks: timelineStore.tracks,
            video: videoState
        });

        set({ lastSavedState: currentState, isDirty: false });
    },

    createProject: async (name: string) => {
        const newProject: TProject = {
            id: crypto.randomUUID(),
            name,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        set({ activeProject: newProject });

        // Reset timeline
        const timelineStore = useTimelineStore.getState();
        timelineStore.setTracks([]);

        // Reset video
        useVideoStore.getState().clearVideo();

        // Reset playback
        usePlaybackStore.getState().reset();

        // Initial state for new project (empty tracks)
        get().updateLastSavedState();

        try {
            await storageService.saveProject(newProject);
            await storageService.saveTimeline(newProject.id, []);
            await get().loadAllProjects();
            return newProject.id;
        } catch (error) {
            console.error('Failed to create project:', error);
            throw error;
        }
    },

    loadProject: async (id: string) => {
        set({ isLoading: true });
        try {
            const project = await storageService.loadProject(id);
            if (!project) throw new Error(`Project ${id} not found`);

            const tracks = await storageService.loadTimeline(id);

            set({ activeProject: project });

            const timelineStore = useTimelineStore.getState();
            timelineStore.setTracks(tracks || []);

            get().updateLastSavedState();

            // Load video if exists
            const videoFile = await storageService.loadVideo(id);
            const videoStore = useVideoStore.getState();

            if (videoFile) {
                try {
                    const info = await getVideoInfo(videoFile);
                    videoStore.loadVideo(videoFile, info);
                } catch (e) {
                    console.error("Failed to load video metadata", e);
                    videoStore.clearVideo();
                }
            } else {
                videoStore.clearVideo();
            }

        } catch (error) {
            console.error('Failed to load project:', error);
            throw error;
        } finally {
            set({ isLoading: false });
        }
    },

    saveCurrentProject: async () => {
        const { activeProject } = get();
        if (!activeProject) return;

        const timelineStore = useTimelineStore.getState();
        const tracks = timelineStore.tracks;

        const updatedProject = {
            ...activeProject,
            updatedAt: new Date(),
        };

        try {
            await storageService.saveProject(updatedProject);
            await storageService.saveTimeline(updatedProject.id, tracks);
            set({ activeProject: updatedProject });
            get().updateLastSavedState();
            await get().loadAllProjects();
        } catch (error) {
            console.error('Failed to save project:', error);
        }
    },

    loadAllProjects: async () => {
        set({ isLoading: true });
        try {
            const projects = await storageService.loadAllProjects();
            set({ savedProjects: projects, isInitialized: true });
        } catch (error) {
            console.error('Failed to load projects:', error);
        } finally {
            set({ isLoading: false });
        }
    },

    deleteProject: async (id: string) => {
        try {
            await storageService.deleteProject(id);
            await get().loadAllProjects();

            const { activeProject } = get();
            if (activeProject?.id === id) {
                get().closeProject();
            }
        } catch (error) {
            console.error('Failed to delete project:', error);
        }
    },

    closeProject: () => {
        set({ activeProject: null });
        const timelineStore = useTimelineStore.getState();
        timelineStore.setTracks([]);
        useVideoStore.getState().clearVideo();
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
    }
}));
