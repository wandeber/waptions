import JSZip from 'jszip';
import { TProject } from '@/types/project';
import { SubtitleTrack, Subtitle } from '@/types/timeline';
import { StylePreset } from '@/components/video-editor/subtitle-editor/types';
import { getStylePresets, saveStylePreset } from '@/components/video-editor/subtitle-editor/presetUtils';
import { storageService } from './storage/storage-service';

export const PROJECT_BUNDLE_VERSION = '1.0';

export interface ProjectBundleMetadata {
    version: string;
    project: Omit<TProject, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string };
    timeline: {
        tracks: SubtitleTrack[];
        rawTranscription: Subtitle[] | null;
        transcriptionGroups: { [key: string]: Subtitle[] } | null;
        transcriptionContainerIds: string[] | null;
    };
    presets: StylePreset[];
}

/**
 * Exports a project, its timeline, video and custom presets as a .waptions (ZIP) file.
 */
export async function exportProjectBundle(projectId: string): Promise<Blob> {
    const zip = new JSZip();

    // 1. Get project info
    const project = await storageService.loadProject(projectId);
    if (!project) throw new Error('Project not found');

    // 2. Get timeline info
    const timeline = await storageService.loadTimeline(projectId);

    // 3. Get video file
    const videoFile = await storageService.loadVideo(projectId);

    // 4. Get custom presets
    const allPresets = getStylePresets();
    const customPresets = allPresets.filter(p => !p.isDefault);

    const metadata: ProjectBundleMetadata = {
        version: PROJECT_BUNDLE_VERSION,
        project: {
            ...project,
            createdAt: project.createdAt.toISOString(),
            updatedAt: project.updatedAt.toISOString(),
        },
        timeline: {
            tracks: timeline.tracks || [],
            rawTranscription: timeline.rawTranscription,
            transcriptionGroups: timeline.transcriptionGroups,
            transcriptionContainerIds: timeline.transcriptionContainerIds,
        },
        presets: customPresets
    };

    zip.file('metadata.json', JSON.stringify(metadata, null, 2));

    if (videoFile) {
        // We keep the original extension to help with MIME type detection on import
        const ext = getExtension(videoFile.name);
        zip.file(`video${ext}`, videoFile);
    }

    return await zip.generateAsync({ type: 'blob' });
}

/**
 * Peeks at the metadata of a .waptions file without importing it.
 */
export async function peekProjectBundle(blob: Blob): Promise<ProjectBundleMetadata> {
    const zip = await JSZip.loadAsync(blob);
    const metadataFile = zip.file('metadata.json');
    if (!metadataFile) throw new Error('Invalid .waptions file: missing metadata');

    const metadataText = await metadataFile.async('text');
    return JSON.parse(metadataText);
}

/**
 * Imports a project from a .waptions (ZIP) file.
 */
export async function importProjectBundle(blob: Blob): Promise<{ projectId: string, versionMismatch: boolean }> {
    const zip = await JSZip.loadAsync(blob);
    const metadataFile = zip.file('metadata.json');
    if (!metadataFile) throw new Error('Invalid .waptions file: missing metadata');

    const metadataText = await metadataFile.async('text');
    const metadata: ProjectBundleMetadata = JSON.parse(metadataText);

    const versionMismatch = metadata.version !== PROJECT_BUNDLE_VERSION;

    // Create a NEW project ID to avoid overwriting existing projects with same ID
    const newProjectId = crypto.randomUUID();
    const importedProject: TProject = {
        ...metadata.project,
        id: newProjectId,
        name: `${metadata.project.name} (Imported)`,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    // 1. Save project metadata
    await storageService.saveProject(importedProject);

    // 2. Save timeline data
    await storageService.saveTimeline(
        newProjectId,
        metadata.timeline.tracks,
        metadata.timeline.rawTranscription,
        metadata.timeline.transcriptionGroups,
        metadata.timeline.transcriptionContainerIds
    );

    // 3. Restore custom presets (avoiding duplicates by name)
    const existingPresets = getStylePresets();
    for (const preset of metadata.presets) {
        const exists = existingPresets.some(p => p.name === preset.name);
        if (!exists) {
            saveStylePreset(preset.name, preset.style);
        }
    }

    // 4. Extract and save video file
    const videoFiles = zip.file(/^video\./);
    if (videoFiles.length > 0) {
        const videoZipFile = videoFiles[0];
        const videoBlob = await videoZipFile.async('blob');

        // Create File object from blob
        const fileName = videoZipFile.name;
        const type = getMimeTypeFromFileName(fileName);
        const videoFile = new File([videoBlob], fileName, { type });

        await storageService.saveVideo(newProjectId, videoFile);
    }

    return { projectId: newProjectId, versionMismatch };
}

function getExtension(filename: string): string {
    const parts = filename.split('.');
    return parts.length > 1 ? `.${parts.pop()}` : '';
}

function getMimeTypeFromFileName(filename: string): string {
    const ext = getExtension(filename).toLowerCase();
    switch (ext) {
        case '.mp4': return 'video/mp4';
        case '.webm': return 'video/webm';
        case '.mov': return 'video/quicktime';
        case '.avi': return 'video/x-msvideo';
        case '.mkv': return 'video/x-matroska';
        default: return 'video/mp4'; // Fallback
    }
}
