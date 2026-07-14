import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type {
    AudioSourceAsset,
    EditorDocumentV3,
    EditorManifestV2,
    VideoSourceAssetV3,
} from '@/types/video';
import { storageService } from './storage/storage-service';
import { createVideoSourceFingerprint } from './video-timeline';
import { migrateEditorDocumentV2ToV3, createEditorManifestV3 } from './editor-document-migration';
import * as mediaUtils from './mediabunny-utils';
import {
    exportProjectBundle,
    importProjectBundle,
    peekProjectBundle,
    PROJECT_BUNDLE_VERSION,
    type ProjectBundleMetadataV1,
    type ProjectBundleMetadataV2,
    type ProjectBundleMetadataV3,
} from './project-bundle';

const file = (name: string, type: string, contents: string, lastModified = 7): File => {
    const bytes = new TextEncoder().encode(contents);
    return Object.assign(bytes, {
        name,
        type,
        size: bytes.byteLength,
        lastModified,
    }) as unknown as File;
};

const video = (id = 'video'): VideoSourceAssetV3 => {
    const sourceFile = file(`${id}.mp4`, 'video/mp4', 'video-content');
    return {
        id,
        originalName: sourceFile.name,
        mimeType: sourceFile.type,
        size: sourceFile.size,
        lastModified: sourceFile.lastModified,
        fingerprint: createVideoSourceFingerprint(sourceFile),
        duration: 2,
        fps: 30,
        width: 1920,
        height: 1080,
        bitrate: null,
        hasAudio: true,
        file: sourceFile,
    };
};

const audio = (id = 'audio'): AudioSourceAsset => {
    const sourceFile = file(`${id}.wav`, 'audio/wav', 'audio-content');
    return {
        id,
        originalName: sourceFile.name,
        mimeType: sourceFile.type,
        size: sourceFile.size,
        lastModified: sourceFile.lastModified,
        fingerprint: createVideoSourceFingerprint(sourceFile),
        duration: 1,
        nativeSampleRate: 48_000,
        nativeSampleCount: 48_000,
        nativeChannelCount: 2,
        bitrate: null,
        codec: 'pcm',
        file: sourceFile,
    };
};

const v2Manifest = (asset: VideoSourceAssetV3): EditorManifestV2 => {
    const { file: ignored, ...descriptor } = asset;
    void ignored;
    return {
        version: 2,
        revision: 3,
        projectFps: 30,
        tracks: [],
        sourceDescriptors: [descriptor],
        videoClips: [{ id: 'clip', sourceId: asset.id, sourceStart: 0, sourceEnd: 1 }],
        activeTrackId: null,
        transcriptionByTrackId: {},
    };
};

const document = (includeImportedAudio = true): EditorDocumentV3 => {
    const videoSource = video();
    const result = migrateEditorDocumentV2ToV3({
        manifest: v2Manifest(videoSource),
        loadedVideoSources: [videoSource],
    });
    result.videoClips[0].audio!.linkState = 'detached';
    result.audioTracks.push({
        id: 'detached_track',
        name: 'Detached',
        muted: false,
        solo: false,
        locked: false,
        gainDb: 0,
        clips: [{
            id: 'detached_clip',
            source: { kind: 'video-source-audio', videoSourceId: videoSource.id },
            timelineStartFrame: 0,
            sourceStart: 0,
            sourceEnd: 1,
            muted: false,
            gainDb: 0,
            fadeInFrames: 0,
            fadeOutFrames: 0,
        }],
    });
    if (includeImportedAudio) {
        const audioSource = audio();
        result.audioSources.push(audioSource);
        result.audioTracks.push({
            id: 'imported_track',
            name: 'Imported',
            muted: false,
            solo: false,
            locked: false,
            gainDb: 0,
            clips: [{
                id: 'imported_clip',
                source: { kind: 'audio-source', audioSourceId: audioSource.id },
                timelineStartFrame: 30,
                sourceStartSample: 0,
                sourceEndSample: 48_000,
                muted: false,
                gainDb: 0,
                fadeInSamples: 0,
                fadeOutSamples: 0,
            }],
        });
    }
    return result;
};

const project = {
    id: 'project',
    name: 'Project',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const projectMetadata = () => ({
    id: 'old-project',
    name: 'Imported project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('project bundle v3', () => {
    afterEach(() => vi.restoreAllMocks());

    it('exports separate video/audio maps while detached video audio reuses the video File', async () => {
        const editorDocument = document(false);
        vi.spyOn(storageService, 'loadProject').mockResolvedValue(project);
        vi.spyOn(storageService, 'loadEditorDocument').mockResolvedValue(editorDocument);

        const zip = await JSZip.loadAsync(await (await exportProjectBundle('project')).arrayBuffer());
        const metadata = JSON.parse(await zip.file('metadata.json')!.async('text')) as ProjectBundleMetadataV3;

        expect(metadata.version).toBe(PROJECT_BUNDLE_VERSION);
        expect(metadata.sourceFiles.video).toEqual({ video: 'sources/video/video.mp4' });
        expect(metadata.sourceFiles.audio).toEqual({});
        expect(metadata.editorManifest.audioTracks[0].clips[0].source.kind).toBe('video-source-audio');
        expect(zip.file('sources/video/video.mp4')).toBeTruthy();
        expect(zip.file(/^sources\/audio\//)).toEqual([]);
    });

    it('imports v3 video and audio sources in one complete document write before publication', async () => {
        const editorDocument = document(true);
        const metadata: ProjectBundleMetadataV3 = {
            version: '3.0',
            project: projectMetadata(),
            editorManifest: createEditorManifestV3(editorDocument),
            sourceFiles: {
                video: { video: 'sources/video/video.mp4' },
                audio: { audio: 'sources/audio/audio.wav' },
            },
            presets: [],
        };
        const zip = new JSZip();
        zip.file('metadata.json', JSON.stringify(metadata));
        zip.file(metadata.sourceFiles.video.video, new Uint8Array(editorDocument.videoSources[0].file as unknown as Uint8Array));
        zip.file(metadata.sourceFiles.audio.audio, new Uint8Array(editorDocument.audioSources[0].file as unknown as Uint8Array));
        const saveDocument = vi.spyOn(storageService, 'saveEditorDocument').mockResolvedValue();
        const saveProject = vi.spyOn(storageService, 'saveProject').mockResolvedValue();

        const result = await importProjectBundle(await zip.generateAsync({ type: 'uint8array' }) as unknown as Blob);

        expect(result.versionMismatch).toBe(false);
        expect(saveDocument.mock.calls[0][1].version).toBe(3);
        expect(saveDocument.mock.calls[0][2].map((entry) => entry.kind)).toEqual(['video-source', 'audio-source']);
        expect(saveDocument.mock.invocationCallOrder[0]).toBeLessThan(saveProject.mock.invocationCallOrder[0]);
    });

    it('imports v2 through the pure v3 migration and reports a version mismatch', async () => {
        const source = video('legacy');
        const metadata: ProjectBundleMetadataV2 = {
            version: '2.0',
            project: projectMetadata(),
            editorManifest: v2Manifest(source),
            sourceFiles: { legacy: 'sources/legacy.mp4' },
            presets: [],
        };
        const zip = new JSZip();
        zip.file('metadata.json', JSON.stringify(metadata));
        zip.file('sources/legacy.mp4', new Uint8Array(source.file as unknown as Uint8Array));
        const saveDocument = vi.spyOn(storageService, 'saveEditorDocument').mockResolvedValue();
        vi.spyOn(storageService, 'saveProject').mockResolvedValue();

        const result = await importProjectBundle(await zip.generateAsync({ type: 'uint8array' }) as unknown as Blob);

        expect(result.versionMismatch).toBe(true);
        expect(saveDocument.mock.calls[0][1]).toMatchObject({
            version: 3,
            videoClips: [{ audio: { linkState: 'linked' } }],
            audioSourceDescriptors: [],
        });
    });

    it('imports v1 after inspecting its scalar video and rejects unknown newer versions', async () => {
        const metadata: ProjectBundleMetadataV1 = {
            version: '1.0',
            project: projectMetadata(),
            timeline: {
                tracks: [],
                rawTranscription: null,
                transcriptionGroups: null,
                transcriptionContainerIds: null,
            },
            presets: [],
        };
        const zip = new JSZip();
        zip.file('metadata.json', JSON.stringify(metadata));
        zip.file('video.webm', new Uint8Array([1, 2, 3]));
        vi.spyOn(mediaUtils, 'getVideoInfo').mockResolvedValue({
            duration: 2,
            width: 1280,
            height: 720,
            fps: 24,
            bitrate: 100,
            hasAudio: true,
        });
        const saveDocument = vi.spyOn(storageService, 'saveEditorDocument').mockResolvedValue();
        vi.spyOn(storageService, 'saveProject').mockResolvedValue();

        await expect(importProjectBundle(
            await zip.generateAsync({ type: 'uint8array' }) as unknown as Blob,
        )).resolves.toMatchObject({ versionMismatch: true });
        expect(saveDocument.mock.calls[0][1]).toMatchObject({ version: 3 });
        expect(saveDocument.mock.calls[0][1].videoSourceDescriptors[0].fingerprint)
            .toMatch(/^v2_/);

        const newer = new JSZip();
        newer.file('metadata.json', JSON.stringify({ ...metadata, version: '4.0' }));
        await expect(peekProjectBundle(
            await newer.generateAsync({ type: 'uint8array' }) as unknown as Blob,
        )).rejects.toThrow('Unsupported newer');
    });
});
