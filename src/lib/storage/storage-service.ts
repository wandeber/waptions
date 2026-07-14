import type { Subtitle, SubtitleTrack } from '@/types/timeline';
import type {
    AudioSourceAsset,
    EditorDocumentV3,
    EditorDocumentV2,
    EditorManifestV2,
    EditorManifestV3,
    VideoSourceAssetV3,
} from '@/types/video';
import type { TProject } from '@/types/project';
import {
    createVideoSourceFingerprint,
    validateEditorDocument,
} from '@/lib/video-timeline';
import { getEditorMediaAssetKey } from '@/lib/media-asset-ref';
import { validateEditorManifestV3 } from '@/lib/editor-document-v3';
import {
    createEditorManifestV3,
    hydrateEditorDocumentV3,
    migrateEditorDocumentV2ToV3,
    migrateLegacyEditorDocumentToV3,
} from '@/lib/editor-document-migration';
import { resolveEditorManifestAssets, resolveEditorVideoAsset } from './editor-asset-resolver';
import { IndexedDBAdapter, type IndexedDBBatchOperation } from './indexeddb-adapter';
import type { SerializedProject, StorageConfig } from './types';

export const EDITOR_DOCUMENT_V2_KEY = 'editor-document-v2';
export const EDITOR_DOCUMENT_V3_KEY = 'editor-document-v3';
export const VIDEO_SOURCE_KEY_PREFIX = 'source:';

export type EditorPersistentAsset =
    | { kind: 'video-source'; asset: VideoSourceAssetV3 }
    | { kind: 'audio-source'; asset: AudioSourceAsset };

export interface LoadEditorDocumentOptions {
    /**
     * Scalar v1 records contain only a File. The caller supplies inspection so this storage
     * layer never invents stream metadata and the pure migration module remains decoder-free.
     */
    inspectLegacyVideo?: (file: File) => Promise<VideoSourceAssetV3>;
}

export interface LegacyProjectPayload {
    tracks: SubtitleTrack[] | null;
    rawTranscription: Subtitle[] | null;
    transcriptionGroups: Record<string, Subtitle[]> | null;
    transcriptionContainerIds: string[] | null;
    videoFile: File | null;
}

export type ProjectDeletionBlockedCallback = (projectId: string) => void;

export class StorageService {
    private projectsAdapter: IndexedDBAdapter<SerializedProject>;
    private config: StorageConfig;

    constructor() {
        this.config = {
            projectsDb: 'waptions-projects',
            timelineDb: 'waptions-timelines',
            version: 1,
        };

        this.projectsAdapter = new IndexedDBAdapter<SerializedProject>(
            this.config.projectsDb,
            'projects',
            this.config.version,
        );
    }

    private getProjectDbAdapter<T>(projectId: string): IndexedDBAdapter<T> {
        return new IndexedDBAdapter<T>(
            `${this.config.timelineDb}-${projectId}`,
            'timeline',
            this.config.version,
        );
    }

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
            if (project) projects.push(project);
        }
        return projects.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    }

    async deleteProjectIndex(id: string): Promise<void> {
        await this.projectsAdapter.remove(id);
    }

    /**
     * Deletes only the project document database. A blocked notification is informational and
     * non-terminal: the same long-lived IDB request remains pending until success or error.
     * Callers remove the project index only after this promise resolves.
     */
    async deleteProjectDatabase(
        id: string,
        onBlocked?: ProjectDeletionBlockedCallback,
    ): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(`${this.config.timelineDb}-${id}`);
            request.onblocked = () => onBlocked?.(id);
            request.onerror = () => reject(request.error ?? new Error(`Failed to delete project database ${id}.`));
            request.onsuccess = () => resolve();
        });
    }

    /** Temporary compatibility wrapper; new deletion flows call database then index explicitly. */
    async deleteProject(id: string, onBlocked?: ProjectDeletionBlockedCallback): Promise<void> {
        await this.deleteProjectDatabase(id, onBlocked);
        await this.deleteProjectIndex(id);
    }

    async saveEditorDocument(
        projectId: string,
        manifest: EditorManifestV3,
        sourceAssets: readonly EditorPersistentAsset[],
    ): Promise<void> {
        const validation = validateEditorManifestV3(manifest);
        if (!validation.valid) {
            const details = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
            throw new Error(`Cannot save invalid v3 editor manifest: ${details}`);
        }
        const videoDescriptors = new Map(manifest.videoSourceDescriptors.map((item) => [item.id, item]));
        const audioDescriptors = new Map(manifest.audioSourceDescriptors.map((item) => [item.id, item]));
        const operations: IndexedDBBatchOperation<EditorManifestV3 | File>[] = [
            { type: 'put', key: EDITOR_DOCUMENT_V3_KEY, value: manifest },
        ];

        sourceAssets.forEach((entry) => {
            const descriptor = entry.kind === 'video-source'
                ? videoDescriptors.get(entry.asset.id)
                : audioDescriptors.get(entry.asset.id);
            assertAssetMatchesDescriptor(entry.asset, descriptor, entry.kind);
            const key = entry.kind === 'video-source'
                ? getEditorMediaAssetKey({ kind: 'video-source', videoSourceId: entry.asset.id })
                : getEditorMediaAssetKey({ kind: 'audio-source', audioSourceId: entry.asset.id });
            operations.push({ type: 'put', key, value: entry.asset.file });
        });

        // Manifest and only the genuinely new Files selected by the coordinator commit together.
        // If quota or cloning fails, IndexedDB aborts the whole batch and the prior v3/v2/v1
        // project remains intact and reopenable.
        await this.getProjectDbAdapter<EditorManifestV3 | File>(projectId).batch(operations);
    }

    async loadEditorDocument(
        projectId: string,
        options: LoadEditorDocumentOptions = {},
    ): Promise<EditorDocumentV3 | null> {
        const adapter = this.getProjectDbAdapter<unknown>(projectId);
        const v3Value = await adapter.get(EDITOR_DOCUMENT_V3_KEY);
        if (v3Value !== null) {
            if (!isEditorManifestV3(v3Value)) {
                throw new Error(`Project ${projectId} contains an invalid editor-document-v3 manifest.`);
            }
            const validation = validateEditorManifestV3(v3Value);
            if (!validation.valid) {
                const details = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
                throw new Error(`Project ${projectId} v3 manifest failed validation: ${details}`);
            }
            const assets = await resolveEditorManifestAssets(adapter, v3Value);
            return hydrateEditorDocumentV3(v3Value, assets.videoSources, assets.audioSources);
        }

        const v2Value = await adapter.get(EDITOR_DOCUMENT_V2_KEY);
        if (v2Value !== null) {
            if (!isEditorManifestV2(v2Value)) {
                throw new Error(`Project ${projectId} contains an invalid editor-document-v2 manifest.`);
            }
            const loadedVideoSources = await Promise.all(v2Value.sourceDescriptors.map(async (descriptor) => (
                (await resolveEditorVideoAsset(adapter, descriptor, v2Value.sourceDescriptors.length)).asset
            )));
            const legacyDocument: EditorDocumentV2 = {
                revision: v2Value.revision,
                projectFps: v2Value.projectFps,
                tracks: v2Value.tracks,
                videoSources: loadedVideoSources,
                videoClips: v2Value.videoClips,
                activeTrackId: v2Value.activeTrackId,
                selectedSubtitleIds: [],
                selectedClipId: null,
                transcriptionByTrackId: v2Value.transcriptionByTrackId,
            };
            assertValidV2Document(projectId, legacyDocument);
            const document = migrateEditorDocumentV2ToV3({ manifest: v2Value, loadedVideoSources });
            await adapter.batch([{ type: 'put', key: EDITOR_DOCUMENT_V3_KEY, value: createEditorManifestV3(document) }]);
            return document;
        }

        const legacy = await this.loadLegacyProjectPayload(projectId);
        const hasLegacyTimeline = legacy.tracks !== null
            || legacy.rawTranscription !== null
            || legacy.transcriptionGroups !== null
            || legacy.transcriptionContainerIds !== null;
        if (!legacy.videoFile && !hasLegacyTimeline) return null;
        const inspectLegacyVideo = options.inspectLegacyVideo ?? (async (file: File) => {
            // The heavy media probe is loaded only for a real scalar-v1 project. The migration
            // transform itself still receives an already-inspected asset and remains pure.
            const { inspectVideoSource } = await import('@/lib/video-source');
            return inspectVideoSource(file);
        });
        const inspectedSource = legacy.videoFile ? await inspectLegacyVideo(legacy.videoFile) : null;
        const document = migrateLegacyEditorDocumentToV3({
            tracks: legacy.tracks ?? [],
            rawTranscription: legacy.rawTranscription,
            transcriptionGroups: legacy.transcriptionGroups,
            transcriptionContainerIds: legacy.transcriptionContainerIds,
            loadedVideoSource: inspectedSource,
        });
        await adapter.batch([{ type: 'put', key: EDITOR_DOCUMENT_V3_KEY, value: createEditorManifestV3(document) }]);
        return document;
    }

    /** Migration-only legacy timeline writer retained until reserved consumers move to v2. */
    async saveTimeline(
        projectId: string,
        tracks: SubtitleTrack[],
        rawTranscription?: Subtitle[] | null,
        groups?: Record<string, Subtitle[]> | null,
        containerIds?: string[] | null,
    ): Promise<void> {
        const tracksAdapter = this.getProjectDbAdapter<SubtitleTrack[]>(projectId);
        const rawAdapter = this.getProjectDbAdapter<Subtitle[]>(projectId);
        const groupsAdapter = this.getProjectDbAdapter<Record<string, Subtitle[]>>(projectId);
        const idsAdapter = this.getProjectDbAdapter<string[]>(projectId);

        await Promise.all([
            tracksAdapter.set('tracks', tracks),
            rawTranscription
                ? rawAdapter.set('raw-transcription', rawTranscription)
                : rawAdapter.remove('raw-transcription'),
            groups
                ? groupsAdapter.set('transcription-groups', groups)
                : groupsAdapter.remove('transcription-groups'),
            containerIds
                ? idsAdapter.set('transcription-container-ids', containerIds)
                : idsAdapter.remove('transcription-container-ids'),
        ]);
    }

    /** Migration-only legacy timeline reader retained for WP2.5 project conversion. */
    async loadTimeline(projectId: string): Promise<Omit<LegacyProjectPayload, 'videoFile'>> {
        const adapter = this.getProjectDbAdapter<unknown>(projectId);
        const values = await adapter.getMany<unknown>([
            'tracks',
            'raw-transcription',
            'transcription-groups',
            'transcription-container-ids',
        ]);
        return {
            tracks: values.get('tracks') as SubtitleTrack[] | null,
            rawTranscription: values.get('raw-transcription') as Subtitle[] | null,
            transcriptionGroups: values.get('transcription-groups') as Record<string, Subtitle[]> | null,
            transcriptionContainerIds: values.get('transcription-container-ids') as string[] | null,
        };
    }

    /** Read-only migration payload; it intentionally does not guess missing v2 media metadata. */
    async loadLegacyProjectPayload(projectId: string): Promise<LegacyProjectPayload> {
        const [timeline, videoFile] = await Promise.all([
            this.loadTimeline(projectId),
            this.loadVideo(projectId),
        ]);
        return { ...timeline, videoFile };
    }

    /** Migration-only scalar video writer retained for the temporary facade. */
    async saveVideo(projectId: string, file: File): Promise<void> {
        await this.getProjectDbAdapter<File>(projectId).set('video-file', file);
    }

    /** Migration-only scalar video reader retained for the temporary facade. */
    async loadVideo(projectId: string): Promise<File | null> {
        return this.getProjectDbAdapter<File>(projectId).get('video-file');
    }

    /** Migration-only scalar video remover retained for the temporary facade. */
    async deleteVideo(projectId: string): Promise<void> {
        await this.getProjectDbAdapter<File>(projectId).remove('video-file');
    }

    async getProjectStorageSize(projectId: string): Promise<number> {
        try {
            return await this.getProjectDbAdapter(projectId).calculateSize();
        } catch (error) {
            console.error('Error calculating project size:', error);
            return 0;
        }
    }

    async getTotalStorageSize(): Promise<number> {
        try {
            const allDbs = await IndexedDBAdapter.listDatabases();
            const relevantDbs = allDbs.filter((db) => (
                db === this.config.projectsDb || db.startsWith(`${this.config.timelineDb}-`)
            ));
            let totalSize = 0;
            for (const dbName of relevantDbs) {
                const storeName = dbName === this.config.projectsDb ? 'projects' : 'timeline';
                totalSize += await new IndexedDBAdapter<unknown>(
                    dbName,
                    storeName,
                    this.config.version,
                ).calculateSize();
            }
            return totalSize;
        } catch (error) {
            console.error('Error calculating total storage size:', error);
            return 0;
        }
    }

    async getOrphanedDatabases(): Promise<{ id: string; size: number }[]> {
        const allDbs = await IndexedDBAdapter.listDatabases();
        const timelinePrefix = `${this.config.timelineDb}-`;
        const projectIds = await this.projectsAdapter.list();
        const potentialOrphans = allDbs.filter((db) => (
            db.startsWith(timelinePrefix) && !projectIds.includes(db.replace(timelinePrefix, ''))
        ));
        const orphaned: { id: string; size: number }[] = [];
        for (const dbName of potentialOrphans) {
            const projectId = dbName.replace(timelinePrefix, '');
            orphaned.push({ id: projectId, size: await this.getProjectStorageSize(projectId) });
        }
        return orphaned;
    }

    async deleteOrphanedData(id: string, onBlocked?: ProjectDeletionBlockedCallback): Promise<void> {
        await this.deleteProjectDatabase(id, onBlocked);
    }
}

function isEditorManifestV3(value: unknown): value is EditorManifestV3 {
    return typeof value === 'object'
        && value !== null
        && 'version' in value
        && value.version === 3
        && 'videoSourceDescriptors' in value
        && Array.isArray(value.videoSourceDescriptors)
        && 'audioSourceDescriptors' in value
        && Array.isArray(value.audioSourceDescriptors)
        && 'videoClips' in value
        && Array.isArray(value.videoClips)
        && 'audioTracks' in value
        && Array.isArray(value.audioTracks);
}

function isEditorManifestV2(value: unknown): value is EditorManifestV2 {
    return typeof value === 'object'
        && value !== null
        && 'version' in value
        && value.version === 2
        && 'sourceDescriptors' in value
        && Array.isArray(value.sourceDescriptors)
        && 'videoClips' in value
        && Array.isArray(value.videoClips);
}

function assertAssetMatchesDescriptor(
    asset: VideoSourceAssetV3 | AudioSourceAsset,
    descriptor: Omit<VideoSourceAssetV3, 'file'> | Omit<AudioSourceAsset, 'file'> | undefined,
    kind: EditorPersistentAsset['kind'],
): void {
    if (!descriptor || descriptor.fingerprint !== asset.fingerprint) {
        throw new Error(`${kind} asset "${asset.id}" does not match the manifest descriptor.`);
    }
    const descriptorFingerprint = createVideoSourceFingerprint({
        name: descriptor.originalName,
        type: descriptor.mimeType,
        size: descriptor.size,
        lastModified: descriptor.lastModified,
    });
    const fileFingerprint = createVideoSourceFingerprint({
        name: asset.file.name,
        type: asset.file.type,
        size: asset.file.size,
        lastModified: asset.file.lastModified,
    });
    if (
        descriptorFingerprint !== descriptor.fingerprint
        || fileFingerprint !== descriptor.fingerprint
        || asset.file.name !== descriptor.originalName
        || asset.file.type !== descriptor.mimeType
        || asset.file.size !== descriptor.size
        || asset.file.lastModified !== descriptor.lastModified
    ) {
        throw new Error(`${kind} asset "${asset.id}" File does not match its descriptor.`);
    }
}

function assertValidV2Document(projectId: string, document: EditorDocumentV2): void {
    const validation = validateEditorDocument(document);
    if (!validation.valid) {
        const details = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
        throw new Error(`Project ${projectId} v2 editor document failed validation: ${details}`);
    }
}

export const storageService = new StorageService();
