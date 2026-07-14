import JSZip from 'jszip';
import type { TProject } from '@/types/project';
import type { Subtitle, SubtitleTrack } from '@/types/timeline';
import type {
    EditorDocumentV3,
    EditorManifestV2,
    EditorManifestV3,
    VideoSourceAssetV3,
} from '@/types/video';
import type { StylePreset } from '@/components/video-editor/subtitle-editor/types';
import { getStylePresets, saveStylePreset } from '@/components/video-editor/subtitle-editor/presetUtils';
import { validateEditorDocument } from './video-timeline';
import { inspectVideoSource } from './video-source';
import {
    createEditorManifestV3,
    hydrateEditorDocumentV3,
    migrateEditorDocumentV2ToV3,
    migrateLegacyEditorDocumentToV3,
} from './editor-document-migration';
import { storageService, type EditorPersistentAsset } from './storage/storage-service';

export const PROJECT_BUNDLE_VERSION = '3.0';

interface SerializedProject extends Omit<TProject, 'createdAt' | 'updatedAt'> {
    createdAt: string;
    updatedAt: string;
}

export interface ProjectBundleMetadataV3 {
    version: '3.0';
    project: SerializedProject;
    editorManifest: EditorManifestV3;
    sourceFiles: {
        video: Record<string, string>;
        audio: Record<string, string>;
    };
    presets: StylePreset[];
}

export interface ProjectBundleMetadataV2 {
    version: '2.0';
    project: SerializedProject;
    editorManifest: EditorManifestV2;
    sourceFiles: Record<string, string>;
    presets: StylePreset[];
}

export interface ProjectBundleMetadataV1 {
    version: string;
    project: SerializedProject;
    timeline: {
        tracks: SubtitleTrack[];
        rawTranscription: Subtitle[] | null;
        transcriptionGroups: Record<string, Subtitle[]> | null;
        transcriptionContainerIds: string[] | null;
    };
    presets: StylePreset[];
}

export type ProjectBundleMetadata =
    | ProjectBundleMetadataV3
    | ProjectBundleMetadataV2
    | ProjectBundleMetadataV1;

/** Exports the canonical graph. Detached video audio references its existing video source File. */
export async function exportProjectBundle(projectId: string): Promise<Blob> {
    const [project, document] = await Promise.all([
        storageService.loadProject(projectId),
        storageService.loadEditorDocument(projectId),
    ]);
    if (!project) throw new Error('Project not found.');
    if (!document) throw new Error('The project has no durable editor document.');

    const zip = new JSZip();
    const sourceFiles: ProjectBundleMetadataV3['sourceFiles'] = { video: {}, audio: {} };
    document.videoSources.forEach((source) => {
        const path = sourcePath('video', source.id, source.originalName);
        sourceFiles.video[source.id] = path;
        zip.file(path, source.file);
    });
    document.audioSources.forEach((source) => {
        const path = sourcePath('audio', source.id, source.originalName);
        sourceFiles.audio[source.id] = path;
        zip.file(path, source.file);
    });
    const metadata: ProjectBundleMetadataV3 = {
        version: PROJECT_BUNDLE_VERSION,
        project: {
            ...project,
            createdAt: project.createdAt.toISOString(),
            updatedAt: project.updatedAt.toISOString(),
        },
        editorManifest: createEditorManifestV3(document),
        sourceFiles,
        presets: getStylePresets().filter((preset) => !preset.isDefault),
    };
    zip.file('metadata.json', JSON.stringify(metadata, null, 2));
    return zip.generateAsync({ type: 'blob' });
}

export async function peekProjectBundle(blob: Blob): Promise<ProjectBundleMetadata> {
    return readMetadata(await JSZip.loadAsync(blob));
}

/**
 * Restores the complete project database before publishing dashboard discovery metadata. This
 * ordering prevents a half-imported project from becoming visible; cleanup removes the temporary
 * document database if validation, Blob persistence, or the later index publication fails.
 */
export async function importProjectBundle(blob: Blob): Promise<{ projectId: string; versionMismatch: boolean }> {
    const zip = await JSZip.loadAsync(blob);
    const metadata = await readMetadata(zip);
    const newProjectId = crypto.randomUUID();
    const importedProject = createImportedProject(metadata, newProjectId);

    try {
        if (isV3Metadata(metadata)) await restoreV3Document(zip, metadata, newProjectId);
        else if (isV2Metadata(metadata)) await restoreV2Document(zip, metadata, newProjectId);
        else await restoreV1Document(zip, metadata, newProjectId);
        await storageService.saveProject(importedProject);
    } catch (error) {
        await storageService.deleteProjectDatabase(newProjectId).catch(() => undefined);
        await storageService.deleteProjectIndex(newProjectId).catch(() => undefined);
        throw error;
    }

    const existingPresets = getStylePresets();
    metadata.presets.forEach((preset) => {
        if (!existingPresets.some((existing) => existing.name === preset.name)) {
            saveStylePreset(preset.name, preset.style);
        }
    });
    return { projectId: newProjectId, versionMismatch: metadata.version !== PROJECT_BUNDLE_VERSION };
}

async function restoreV3Document(
    zip: JSZip,
    metadata: ProjectBundleMetadataV3,
    projectId: string,
): Promise<void> {
    const videoSources = await Promise.all(metadata.editorManifest.videoSourceDescriptors.map((descriptor) => (
        restoreSourceFile(zip, metadata.sourceFiles.video[descriptor.id], descriptor)
    )));
    const audioSources = await Promise.all(metadata.editorManifest.audioSourceDescriptors.map((descriptor) => (
        restoreSourceFile(zip, metadata.sourceFiles.audio[descriptor.id], descriptor)
    )));
    // Hydration validates descriptors, Files, clip references, detached-audio references, and
    // transcription freshness before the first IndexedDB transaction is allowed to begin.
    hydrateEditorDocumentV3(metadata.editorManifest, videoSources, audioSources);
    await storageService.saveEditorDocument(projectId, metadata.editorManifest, [
        ...videoSources.map((asset): EditorPersistentAsset => ({ kind: 'video-source', asset })),
        ...audioSources.map((asset): EditorPersistentAsset => ({ kind: 'audio-source', asset })),
    ]);
}

async function restoreV2Document(
    zip: JSZip,
    metadata: ProjectBundleMetadataV2,
    projectId: string,
): Promise<void> {
    const videoSources = await Promise.all(metadata.editorManifest.sourceDescriptors.map((descriptor) => (
        restoreSourceFile(zip, metadata.sourceFiles[descriptor.id], descriptor)
    )));
    const legacyDocument = {
        revision: metadata.editorManifest.revision,
        projectFps: metadata.editorManifest.projectFps,
        tracks: metadata.editorManifest.tracks,
        videoSources,
        videoClips: metadata.editorManifest.videoClips,
        activeTrackId: metadata.editorManifest.activeTrackId,
        selectedSubtitleIds: [],
        selectedClipId: null,
        transcriptionByTrackId: metadata.editorManifest.transcriptionByTrackId,
    };
    const validation = validateEditorDocument(legacyDocument);
    if (!validation.valid) {
        const details = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
        throw new Error(`Invalid v2 editor document: ${details}`);
    }
    const document = migrateEditorDocumentV2ToV3({
        manifest: metadata.editorManifest,
        loadedVideoSources: videoSources,
    });
    await saveCompleteDocument(projectId, document);
}

async function restoreV1Document(
    zip: JSZip,
    metadata: ProjectBundleMetadataV1,
    projectId: string,
): Promise<void> {
    const videoEntry = zip.file(/^video\./)[0] ?? null;
    let source: VideoSourceAssetV3 | null = null;
    if (videoEntry) {
        const blob = await videoEntry.async('blob');
        source = await inspectVideoSource(new File([blob], baseName(videoEntry.name), {
            type: getMimeTypeFromFileName(videoEntry.name),
        }));
    }
    const document = migrateLegacyEditorDocumentToV3({
        tracks: metadata.timeline.tracks,
        rawTranscription: metadata.timeline.rawTranscription,
        transcriptionGroups: metadata.timeline.transcriptionGroups,
        transcriptionContainerIds: metadata.timeline.transcriptionContainerIds,
        loadedVideoSource: source,
    });
    await saveCompleteDocument(projectId, document);
}

async function saveCompleteDocument(projectId: string, document: EditorDocumentV3): Promise<void> {
    await storageService.saveEditorDocument(projectId, createEditorManifestV3(document), [
        ...document.videoSources.map((asset): EditorPersistentAsset => ({ kind: 'video-source', asset })),
        ...document.audioSources.map((asset): EditorPersistentAsset => ({ kind: 'audio-source', asset })),
    ]);
}

async function restoreSourceFile<T extends { id: string; originalName: string; mimeType: string; lastModified: number }>(
    zip: JSZip,
    path: string | undefined,
    descriptor: T,
): Promise<T & { file: File }> {
    const entry = path ? zip.file(path) : null;
    if (!entry) throw new Error(`Bundle source file "${descriptor.id}" is missing.`);
    const blob = await entry.async('blob');
    return {
        ...descriptor,
        file: new File([blob], descriptor.originalName, {
            type: descriptor.mimeType,
            lastModified: descriptor.lastModified,
        }),
    };
}

function createImportedProject(metadata: ProjectBundleMetadata, newProjectId: string): TProject {
    return {
        ...metadata.project,
        id: newProjectId,
        name: `${metadata.project.name} (Imported)`,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
}

async function readMetadata(zip: JSZip): Promise<ProjectBundleMetadata> {
    const metadataFile = zip.file('metadata.json');
    if (!metadataFile) throw new Error('Invalid .waptions file: missing metadata.');
    const value = JSON.parse(await metadataFile.async('text')) as unknown;
    if (!isMetadataBase(value)) throw new Error('Invalid .waptions file: malformed metadata.');
    const major = parseMajorVersion(value.version);
    if (major > 3) throw new Error(`Unsupported newer project bundle version "${value.version}".`);
    if (value.version === '3.0' && 'editorManifest' in value && 'sourceFiles' in value) {
        return value as ProjectBundleMetadataV3;
    }
    if (value.version === '2.0' && 'editorManifest' in value && 'sourceFiles' in value) {
        return value as ProjectBundleMetadataV2;
    }
    if (major <= 1 && 'timeline' in value) return value as ProjectBundleMetadataV1;
    throw new Error(`Unsupported project bundle version "${value.version}".`);
}

function isMetadataBase(value: unknown): value is { version: string; project: SerializedProject; presets: StylePreset[] } {
    return typeof value === 'object'
        && value !== null
        && 'version' in value
        && typeof value.version === 'string'
        && 'project' in value
        && typeof value.project === 'object'
        && value.project !== null
        && 'presets' in value
        && Array.isArray(value.presets);
}

function parseMajorVersion(version: string): number {
    if (!/^\d+(?:\.\d+)*$/.test(version)) throw new Error(`Invalid project bundle version "${version}".`);
    return Number(version.split('.')[0]);
}

function isV3Metadata(metadata: ProjectBundleMetadata): metadata is ProjectBundleMetadataV3 {
    return metadata.version === '3.0' && 'editorManifest' in metadata;
}

function isV2Metadata(metadata: ProjectBundleMetadata): metadata is ProjectBundleMetadataV2 {
    return metadata.version === '2.0' && 'editorManifest' in metadata;
}

function sourcePath(kind: 'video' | 'audio', id: string, filename: string): string {
    return `sources/${kind}/${id}${getExtension(filename)}`;
}

function getExtension(filename: string): string {
    const parts = filename.split('.');
    return parts.length > 1 ? `.${parts.pop()}` : '';
}

function baseName(path: string): string {
    return path.split('/').pop() ?? path;
}

function getMimeTypeFromFileName(filename: string): string {
    switch (getExtension(filename).toLowerCase()) {
        case '.webm': return 'video/webm';
        case '.mov': return 'video/quicktime';
        case '.avi': return 'video/x-msvideo';
        case '.mkv': return 'video/x-matroska';
        default: return 'video/mp4';
    }
}
