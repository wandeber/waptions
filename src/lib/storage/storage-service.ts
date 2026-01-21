import { TProject } from "@/types/project";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import { SerializedProject, StorageConfig } from "./types";
import { SubtitleTrack } from "@/types/timeline";

class StorageService {
    private projectsAdapter: IndexedDBAdapter<SerializedProject>;
    private config: StorageConfig;

    constructor() {
        this.config = {
            projectsDb: "waptions-projects",
            timelineDb: "waptions-timelines",
            version: 1,
        };

        this.projectsAdapter = new IndexedDBAdapter<SerializedProject>(
            this.config.projectsDb,
            "projects",
            this.config.version
        );
    }

    private getProjectDbAdapter<T>(projectId: string) {
        return new IndexedDBAdapter<T>(
            `${this.config.timelineDb}-${projectId}`,
            "timeline",
            this.config.version
        );
    }

    // Project operations
    async saveProject(project: TProject): Promise<void> {
        const serializedProject: SerializedProject = {
            id: project.id,
            name: project.name,
            thumbnail: project.thumbnail,
            duration: project.duration,
            createdAt: project.createdAt.toISOString(),
            updatedAt: project.updatedAt.toISOString(),
        };

        await this.projectsAdapter.set(project.id, serializedProject);
    }

    async loadProject(id: string): Promise<TProject | null> {
        const serializedProject = await this.projectsAdapter.get(id);

        if (!serializedProject) return null;

        return {
            id: serializedProject.id,
            name: serializedProject.name,
            thumbnail: serializedProject.thumbnail,
            duration: serializedProject.duration,
            createdAt: new Date(serializedProject.createdAt),
            updatedAt: new Date(serializedProject.updatedAt),
        };
    }

    async loadAllProjects(): Promise<TProject[]> {
        const projectIds = await this.projectsAdapter.list();
        const projects: TProject[] = [];

        for (const id of projectIds) {
            const project = await this.loadProject(id);
            if (project) {
                projects.push(project);
            }
        }

        return projects.sort(
            (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
        );
    }

    async deleteProject(id: string): Promise<void> {
        await this.projectsAdapter.remove(id);
        await this.projectsAdapter.remove(id);
        const dbAdapter = this.getProjectDbAdapter(id);
        await dbAdapter.clear(); // We can't delete the DB easily, but clearing store is good enough
    }

    // Timeline operations
    async saveTimeline(projectId: string, tracks: SubtitleTrack[]): Promise<void> {
        const adapter = this.getProjectDbAdapter<SubtitleTrack[]>(projectId);
        await adapter.set("tracks", tracks);
    }

    async loadTimeline(projectId: string): Promise<SubtitleTrack[] | null> {
        const adapter = this.getProjectDbAdapter<SubtitleTrack[]>(projectId);
        return await adapter.get("tracks");
    }

    // Video operations
    async saveVideo(projectId: string, file: File): Promise<void> {
        const adapter = this.getProjectDbAdapter<File>(projectId);
        await adapter.set("video-file", file);
    }

    async loadVideo(projectId: string): Promise<File | null> {
        const adapter = this.getProjectDbAdapter<File>(projectId);
        return await adapter.get("video-file");
    }

    async deleteVideo(projectId: string): Promise<void> {
        const adapter = this.getProjectDbAdapter<File>(projectId);
        await adapter.remove("video-file");
    }
}

export const storageService = new StorageService();
