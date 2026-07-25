import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type {
    EditorDocumentV3,
    EditorDocumentV4,
    EditorManifestV2,
    EditorManifestV4,
    VideoSourceAssetV3,
} from '@/types/video';
import type { AnimationStyle } from '@/types/timeline';
import type { EditorialTranscriptDescriptorV1, Sha256Digest } from '@/types/editorial';
import {
    createEditorDocumentV4Fixture,
    createEditorialDependentLinkFixture,
    createNarrativeDocumentFixture,
    createNarrativeSpeechBlockFixture,
    createSubtitleTrackV4Fixture,
} from '@/types/editorial.test-fixtures';
import { storageService } from './storage/storage-service';
import { EditorialTranscriptRepository } from './storage/editorial-transcript-repository';
import { createVideoSourceFingerprint } from './video-timeline';
import { getEditorAudioGraphSignature } from './editor-document-v3';
import { createEditorManifestV3, migrateEditorDocumentV2ToV3 } from './editor-document-migration';
import {
    createEditorManifestV4,
    hydrateEditorDocumentV4,
    migrateEditorDocumentV3ToV4,
} from './editor-document-v4-migration';
import {
    createEditorialTranscriptDescriptor,
    createEditorialTranscriptRequestKey,
} from './editorial-transcription/identity';
import {
    createCanonicalEditorialTranscriptRecord,
    type CanonicalEditorialTranscriptRecordV1,
} from './editorial-transcription/transcript-body';
import * as mediaUtils from './mediabunny-utils';
import {
    exportProjectBundle,
    importProjectBundle,
    peekProjectBundle,
    PROJECT_BUNDLE_VERSION,
    type ProjectBundleMetadataV1,
    type ProjectBundleMetadataV2,
    type ProjectBundleMetadataV3,
    type ProjectBundleMetadataV4,
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

const audio = (id = 'audio') => {
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
    } as const;
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

const v3Document = (includeImportedAudio = true): EditorDocumentV3 => {
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

interface EditorialBundleFixture {
    document: EditorDocumentV4;
    record: CanonicalEditorialTranscriptRecordV1;
    descriptor: EditorialTranscriptDescriptorV1;
    secondaryRecord: CanonicalEditorialTranscriptRecordV1;
    secondaryDescriptor: EditorialTranscriptDescriptorV1;
}

let editorialFixture: EditorialBundleFixture;

beforeAll(async () => {
    editorialFixture = await createEditorialBundleFixture();
});

afterEach(() => vi.restoreAllMocks());

describe('project bundle 4.0', () => {
    it('keeps detached video audio on the video File and exports imported audio only in its typed map', async () => {
        const document = migrateEditorDocumentV3ToV4(v3Document(true));
        vi.spyOn(storageService, 'loadProject').mockResolvedValue(project);
        vi.spyOn(storageService, 'loadEditorDocument').mockResolvedValue(document as never);
        const getRecord = vi.spyOn(EditorialTranscriptRepository.prototype, 'getRecord');

        const zip = await JSZip.loadAsync(await (await exportProjectBundle('project')).arrayBuffer());
        const metadata = JSON.parse(await zip.file('metadata.json')!.async('text')) as ProjectBundleMetadataV4;

        expect(metadata.sourceFiles.video).toEqual({ video: 'sources/video/video.mp4' });
        expect(metadata.sourceFiles.audio).toEqual({ audio: 'sources/audio/audio.wav' });
        expect(metadata.editorManifest.audioTracks[0].clips[0].source.kind).toBe('video-source-audio');
        expect(zip.file('sources/video/video.mp4')).toBeTruthy();
        expect(zip.file('sources/audio/audio.wav')).toBeTruthy();
        expect(getRecord).not.toHaveBeenCalled();
    });

    it('exports a descriptor-only manifest, typed sources, and exact canonical current-record sidecars', async () => {
        vi.spyOn(storageService, 'loadProject').mockResolvedValue(project);
        const loadDocument = vi.spyOn(storageService, 'loadEditorDocument')
            .mockResolvedValue(editorialFixture.document as never);
        const getRecord = vi.spyOn(EditorialTranscriptRepository.prototype, 'getRecord')
            .mockResolvedValue(editorialFixture.record.body);

        const bundle = await exportProjectBundle('project');
        const zip = await JSZip.loadAsync(await bundle.arrayBuffer());
        const metadataText = await zip.file('metadata.json')!.async('text');
        const metadata = JSON.parse(metadataText) as ProjectBundleMetadataV4;
        const sidecarPath = transcriptPath(editorialFixture.record.recordId);

        expect(loadDocument).toHaveBeenCalledWith('project', { targetVersion: 4 });
        expect(getRecord).toHaveBeenCalledWith(editorialFixture.record.recordId, { referenced: true });
        expect(metadata.version).toBe(PROJECT_BUNDLE_VERSION);
        expect(metadata.editorManifest.version).toBe(4);
        expect(metadata.sourceFiles.video).toEqual({ video: 'sources/video/video.mp4' });
        expect(metadata.sourceFiles.audio).toEqual({});
        expect(metadata.editorialTranscriptFiles).toEqual({
            [editorialFixture.record.recordId]: sidecarPath,
        });
        expect(await zip.file(sidecarPath)!.async('text')).toBe(editorialFixture.record.canonicalJson);
        expect(metadata.editorManifest).toEqual(createEditorManifestV4(editorialFixture.document));
        expect(metadataText).not.toContain('"words"');
        expect(metadataText).not.toContain('"speechRegions"');
        expect(metadataText).not.toContain('sentinel-secret');
        expect(Object.keys(zip.files).filter((path) => (
            /history|pcm|waveform|request-index|pins|preferences|authorization/i.test(path)
        ))).toEqual([]);
    });

    it('refuses to export a CAS body that does not verify against the current descriptor and record hash', async () => {
        vi.spyOn(storageService, 'loadProject').mockResolvedValue(project);
        vi.spyOn(storageService, 'loadEditorDocument')
            .mockResolvedValue(editorialFixture.document as never);
        vi.spyOn(EditorialTranscriptRepository.prototype, 'getRecord')
            .mockResolvedValue(editorialFixture.secondaryRecord.body);

        await expect(exportProjectBundle('project')).rejects.toThrow(
            'descriptor does not match its immutable body',
        );
    });

    it('imports and re-exports the same repeated occurrences, seams, margins, overrides, binding, descriptor, and hash', async () => {
        const loadProject = vi.spyOn(storageService, 'loadProject').mockResolvedValue(project);
        const loadDocument = vi.spyOn(storageService, 'loadEditorDocument')
            .mockResolvedValueOnce(editorialFixture.document as never);
        vi.spyOn(EditorialTranscriptRepository.prototype, 'getRecord')
            .mockResolvedValue(editorialFixture.record.body);
        const putRecord = vi.spyOn(EditorialTranscriptRepository.prototype, 'putRecord').mockResolvedValue();
        const setPending = vi.spyOn(EditorialTranscriptRepository.prototype, 'setPendingGenerationPins')
            .mockResolvedValue();
        const publishPins = vi.spyOn(EditorialTranscriptRepository.prototype, 'publishDurableProjectPins')
            .mockResolvedValue();
        vi.spyOn(EditorialTranscriptRepository.prototype, 'clearPendingGenerationPins').mockResolvedValue();
        const saveDocument = vi.spyOn(storageService, 'saveEditorDocument').mockResolvedValue();
        const saveProject = vi.spyOn(storageService, 'saveProject').mockResolvedValue();
        vi.spyOn(storageService, 'deleteProjectDatabase').mockResolvedValue();
        vi.spyOn(storageService, 'deleteProjectIndex').mockResolvedValue();

        const firstBundle = await exportProjectBundle('project');
        const imported = await importProjectBundle(firstBundle);
        const savedManifest = saveDocument.mock.calls[0][1] as EditorManifestV4;
        const restoredDocument = hydrateEditorDocumentV4(
            savedManifest,
            editorialFixture.document.videoSources,
            editorialFixture.document.audioSources,
        );
        loadDocument.mockResolvedValueOnce(restoredDocument as never);
        loadProject.mockResolvedValueOnce(saveProject.mock.calls[0][0]);
        const secondBundle = await exportProjectBundle(imported.projectId);
        const [firstZip, secondZip] = await Promise.all([
            JSZip.loadAsync(await firstBundle.arrayBuffer()),
            JSZip.loadAsync(await secondBundle.arrayBuffer()),
        ]);
        const firstMetadata = JSON.parse(await firstZip.file('metadata.json')!.async('text')) as ProjectBundleMetadataV4;
        const secondMetadata = JSON.parse(await secondZip.file('metadata.json')!.async('text')) as ProjectBundleMetadataV4;
        const sidecarPath = transcriptPath(editorialFixture.record.recordId);

        expect(imported.versionMismatch).toBe(false);
        expect(putRecord).toHaveBeenCalledWith(expect.objectContaining({
            recordId: editorialFixture.record.recordId,
            canonicalJson: editorialFixture.record.canonicalJson,
        }));
        expect(setPending).toHaveBeenCalledWith(imported.projectId, 0, [editorialFixture.record.recordId]);
        expect(publishPins).toHaveBeenCalledWith({
            projectId: imported.projectId,
            generation: 0,
            durableRecordIds: [editorialFixture.record.recordId],
            historyRecordIds: [],
            redoRecordIds: [],
            walRecordIds: [],
        });
        expect(putRecord.mock.invocationCallOrder[0]).toBeLessThan(setPending.mock.invocationCallOrder[0]);
        expect(setPending.mock.invocationCallOrder[0]).toBeLessThan(saveDocument.mock.invocationCallOrder[0]);
        expect(saveDocument.mock.invocationCallOrder[0]).toBeLessThan(saveProject.mock.invocationCallOrder[0]);
        expect(saveProject.mock.invocationCallOrder[0]).toBeLessThan(publishPins.mock.invocationCallOrder[0]);
        expect(secondMetadata.editorManifest).toEqual(firstMetadata.editorManifest);
        expect(secondMetadata.editorManifest.narrative?.blockIds).toEqual(['block_left', 'block_right', 'block_repeat']);
        expect(secondMetadata.editorManifest.narrative?.blocks.block_left.materialization.postBoundary)
            .toEqual({ kind: 'partition-seam', seamId: 'seam_one' });
        expect(secondMetadata.editorManifest.narrative?.blocks.block_repeat.sourceWordIds)
            .toEqual(secondMetadata.editorManifest.narrative?.blocks.block_left.sourceWordIds);
        expect(secondMetadata.editorManifest.dependentLinks[0].association.kind).toBe('transcript-bound');
        expect(secondMetadata.editorialTranscriptFiles).toEqual(firstMetadata.editorialTranscriptFiles);
        expect(await secondZip.file(sidecarPath)!.async('text'))
            .toBe(await firstZip.file(sidecarPath)!.async('text'));
    });

    it('rejects missing declarations, missing files, duplicate paths, and undeclared sidecars before CAS writes', async () => {
        const putRecord = vi.spyOn(EditorialTranscriptRepository.prototype, 'putRecord').mockResolvedValue();

        const noDeclaration = createV4Metadata(editorialFixture.document);
        noDeclaration.editorialTranscriptFiles = {};
        await expect(importProjectBundle(await generateV4Bundle(
            noDeclaration,
            editorialFixture.document,
            [editorialFixture.record],
        ))).rejects.toThrow('descriptor has no sidecar');

        const missingSidecar = createV4Metadata(editorialFixture.document);
        await expect(importProjectBundle(await generateV4Bundle(
            missingSidecar,
            editorialFixture.document,
            [],
        ))).rejects.toThrow('required sidecar is missing');

        const duplicateDocument: EditorDocumentV4 = {
            ...editorialFixture.document,
            editorialTranscriptDescriptors: [
                editorialFixture.descriptor,
                editorialFixture.secondaryDescriptor,
            ],
        };
        const duplicatePath = createV4Metadata(duplicateDocument);
        duplicatePath.editorialTranscriptFiles[editorialFixture.secondaryRecord.recordId]
            = transcriptPath(editorialFixture.record.recordId);
        await expect(importProjectBundle(await generateV4Bundle(
            duplicatePath,
            duplicateDocument,
            [editorialFixture.record, editorialFixture.secondaryRecord],
        ))).rejects.toThrow('duplicate sidecar path');

        const undeclared = createV4Metadata(editorialFixture.document);
        await expect(importProjectBundle(await generateV4Bundle(
            undeclared,
            editorialFixture.document,
            [editorialFixture.record],
            { extraFiles: { 'editorial-transcripts/undeclared.json': '{}' } },
        ))).rejects.toThrow('undeclared transcript sidecar');
        expect(putRecord).not.toHaveBeenCalled();
    });

    it('rejects non-canonical, corrupt/hash-mismatched, source-mismatched, and deeply dangling sidecars', async () => {
        const metadata = createV4Metadata(editorialFixture.document);
        await expect(importProjectBundle(await generateV4Bundle(
            metadata,
            editorialFixture.document,
            [editorialFixture.record],
            { sidecarText: { [editorialFixture.record.recordId]: JSON.stringify(editorialFixture.record.body, null, 2) } },
        ))).rejects.toThrow('not canonical JSON');

        await expect(importProjectBundle(await generateV4Bundle(
            createV4Metadata(editorialFixture.document),
            editorialFixture.document,
            [editorialFixture.record],
            {
                sidecarText: {
                    [editorialFixture.record.recordId]: JSON.stringify({
                        ...editorialFixture.record.body,
                        canonicalModel: 'tampered-model',
                    }),
                },
            },
        ))).rejects.toThrow('record hash mismatch');

        const mismatchedRecord = await createCanonicalEditorialTranscriptRecord({
            ...canonicalBodyInput(editorialFixture.document.videoSources[0].fingerprint),
            sourceFingerprint: 'different-source-fingerprint',
        });
        const sourceMismatchMetadata = createV4Metadata(editorialFixture.document);
        const sourceMismatchDescriptor = {
            ...editorialFixture.descriptor,
            recordId: mismatchedRecord.recordId,
            canonicalModel: mismatchedRecord.body.canonicalModel,
        };
        sourceMismatchMetadata.editorManifest.editorialTranscriptDescriptors = [sourceMismatchDescriptor];
        retargetManifestRecord(sourceMismatchMetadata.editorManifest, mismatchedRecord.recordId);
        sourceMismatchMetadata.editorialTranscriptFiles = {
            [mismatchedRecord.recordId]: transcriptPath(mismatchedRecord.recordId),
        };
        await expect(importProjectBundle(await generateV4Bundle(
            sourceMismatchMetadata,
            editorialFixture.document,
            [mismatchedRecord],
        ))).rejects.toThrow('source identity mismatch');

        const danglingMetadata = createV4Metadata(editorialFixture.document);
        const missingWordId = `sha256:${'f'.repeat(64)}`;
        const firstBlockId = danglingMetadata.editorManifest.narrative!.blockIds[0];
        const firstBlock = danglingMetadata.editorManifest.narrative!.blocks[firstBlockId];
        if (firstBlock.kind !== 'speech') throw new Error('Expected speech fixture.');
        firstBlock.sourceWordIds = [missingWordId];
        firstBlock.wordTextOverrides = {};
        firstBlock.speakerOverrides = {};
        await expect(importProjectBundle(await generateV4Bundle(
            danglingMetadata,
            editorialFixture.document,
            [editorialFixture.record],
        ))).rejects.toThrow('hydrated bundle import graph');
    });

    it('cleans a temporary project and only its pending import generation after a project-write failure', async () => {
        const bundle = await generateV4Bundle(
            createV4Metadata(editorialFixture.document),
            editorialFixture.document,
            [editorialFixture.record],
        );
        vi.spyOn(EditorialTranscriptRepository.prototype, 'putRecord').mockResolvedValue();
        vi.spyOn(EditorialTranscriptRepository.prototype, 'setPendingGenerationPins').mockResolvedValue();
        const clearPending = vi.spyOn(EditorialTranscriptRepository.prototype, 'clearPendingGenerationPins')
            .mockResolvedValue();
        const publish = vi.spyOn(EditorialTranscriptRepository.prototype, 'publishDurableProjectPins')
            .mockResolvedValue();
        vi.spyOn(storageService, 'saveEditorDocument').mockRejectedValue(new Error('project quota exceeded'));
        vi.spyOn(storageService, 'saveProject').mockResolvedValue();
        const deleteDatabase = vi.spyOn(storageService, 'deleteProjectDatabase').mockResolvedValue();
        const deleteIndex = vi.spyOn(storageService, 'deleteProjectIndex').mockResolvedValue();

        await expect(importProjectBundle(bundle)).rejects.toThrow('project quota exceeded');

        const temporaryProjectId = clearPending.mock.calls[0][0];
        expect(clearPending).toHaveBeenCalledWith(temporaryProjectId, 0);
        expect(deleteDatabase).toHaveBeenCalledWith(temporaryProjectId);
        expect(deleteIndex).toHaveBeenCalledWith(temporaryProjectId);
        expect(publish).not.toHaveBeenCalled();
    });

    it('removes the temporary project and pending generation when durable pin publication fails', async () => {
        const bundle = await generateV4Bundle(
            createV4Metadata(editorialFixture.document),
            editorialFixture.document,
            [editorialFixture.record],
        );
        vi.spyOn(EditorialTranscriptRepository.prototype, 'putRecord').mockResolvedValue();
        vi.spyOn(EditorialTranscriptRepository.prototype, 'setPendingGenerationPins').mockResolvedValue();
        const clearPending = vi.spyOn(EditorialTranscriptRepository.prototype, 'clearPendingGenerationPins')
            .mockResolvedValue();
        vi.spyOn(EditorialTranscriptRepository.prototype, 'publishDurableProjectPins')
            .mockRejectedValue(new Error('pin publication failed'));
        vi.spyOn(storageService, 'saveEditorDocument').mockResolvedValue();
        vi.spyOn(storageService, 'saveProject').mockResolvedValue();
        const deleteDatabase = vi.spyOn(storageService, 'deleteProjectDatabase').mockResolvedValue();
        const deleteIndex = vi.spyOn(storageService, 'deleteProjectIndex').mockResolvedValue();

        await expect(importProjectBundle(bundle)).rejects.toThrow('pin publication failed');

        const temporaryProjectId = clearPending.mock.calls[0][0];
        expect(clearPending).toHaveBeenCalledWith(temporaryProjectId, 0);
        expect(deleteDatabase).toHaveBeenCalledWith(temporaryProjectId);
        expect(deleteIndex).toHaveBeenCalledWith(temporaryProjectId);
    });

    it('retains verified CAS bytes and publishes no pins when immutable record storage fails', async () => {
        const bundle = await generateV4Bundle(
            createV4Metadata(editorialFixture.document),
            editorialFixture.document,
            [editorialFixture.record],
        );
        vi.spyOn(EditorialTranscriptRepository.prototype, 'putRecord')
            .mockRejectedValue(new Error('CAS quota exceeded'));
        const setPending = vi.spyOn(EditorialTranscriptRepository.prototype, 'setPendingGenerationPins')
            .mockResolvedValue();
        const clearPending = vi.spyOn(EditorialTranscriptRepository.prototype, 'clearPendingGenerationPins')
            .mockResolvedValue();
        vi.spyOn(storageService, 'deleteProjectDatabase').mockResolvedValue();
        vi.spyOn(storageService, 'deleteProjectIndex').mockResolvedValue();

        await expect(importProjectBundle(bundle)).rejects.toThrow('CAS quota exceeded');
        expect(setPending).not.toHaveBeenCalled();
        expect(clearPending).not.toHaveBeenCalled();
    });

    it('imports V3 sources and subtitle provenance through the pure V4 migration', async () => {
        const editorDocument = v3Document(true);
        editorDocument.subtitleTracks = ['speaker_track_1', 'speaker_track_2'].map((id, ordinal) => ({
            id,
            name: ordinal === 0 ? 'Captions' : 'Speaker 2',
            style: {} as AnimationStyle,
            subtitles: [{ id: `speaker_subtitle_${ordinal}`, startTime: ordinal, endTime: ordinal + 1, text: `S${ordinal}` }],
            isVisible: true,
            isLocked: false,
            timingDomain: ordinal === 0 ? 'video-ripple' as const : 'absolute' as const,
        }));
        editorDocument.activeSubtitleTrackId = 'speaker_track_1';
        const signature = getEditorAudioGraphSignature(editorDocument);
        editorDocument.transcriptionByTrackId = Object.fromEntries(editorDocument.subtitleTracks.map((track, ordinal) => {
            const subtitle = track.subtitles[0];
            const groupId = `speaker_group_${ordinal}`;
            return [track.id, {
                raw: [subtitle],
                groups: { [groupId]: [subtitle] },
                containerIds: [groupId],
                provider: 'custom-openai-compatible',
                model: 'whisper-1',
                generatedAt: '2026-07-17T20:00:00.000Z',
                sourceDocumentRevision: editorDocument.revision,
                sourceAudioGraphRevision: editorDocument.audioGraphRevision,
                sourceAudioGraphSignature: signature,
                stale: false,
                extensions: {
                    'waptions.transcription.diarization': {
                        version: 1,
                        setId: 'bundle_speaker_set',
                        targetTrackId: 'speaker_track_1',
                        speakerOrdinal: ordinal,
                        sourceSpeakerLabel: `SPEAKER_0${ordinal}`,
                        audioScope: 'audible-project-mix',
                    },
                },
            }];
        }));
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
        zip.file(metadata.sourceFiles.video.video, editorDocument.videoSources[0].file as unknown as Uint8Array);
        zip.file(metadata.sourceFiles.audio.audio, editorDocument.audioSources[0].file as unknown as Uint8Array);
        const saveDocument = vi.spyOn(storageService, 'saveEditorDocument').mockResolvedValue();
        vi.spyOn(storageService, 'saveProject').mockResolvedValue();

        const result = await importProjectBundle(await toBundleBlob(zip));
        const manifest = saveDocument.mock.calls[0][1] as EditorManifestV4;

        expect(result.versionMismatch).toBe(true);
        expect(manifest.version).toBe(4);
        expect(manifest.subtitleTracks.map((track) => track.unlinkedVideoEditResponse))
            .toEqual(['follow-project-ripple', 'stay-absolute']);
        expect(manifest.transcriptionByTrackId.speaker_track_2.extensions).toMatchObject({
            'waptions.transcription.diarization': {
                setId: 'bundle_speaker_set', targetTrackId: 'speaker_track_1', speakerOrdinal: 1,
            },
        });
        expect(saveDocument.mock.calls[0][2].map((entry) => entry.kind))
            .toEqual(['video-source', 'audio-source']);
    });

    it('normalizes a pre-lane V3 bundle and imports V2 through the same pure V4 chain', async () => {
        const editorDocument = v3Document(false);
        const legacyManifest = createEditorManifestV3(editorDocument) as unknown as Record<string, unknown>;
        delete legacyManifest.videoTracks;
        const legacyMetadata = {
            version: '3.0',
            project: projectMetadata(),
            editorManifest: legacyManifest,
            sourceFiles: { video: { video: 'sources/video/video.mp4' }, audio: {} },
            presets: [],
        };
        const legacyZip = new JSZip();
        legacyZip.file('metadata.json', JSON.stringify(legacyMetadata));
        legacyZip.file('sources/video/video.mp4', editorDocument.videoSources[0].file as unknown as Uint8Array);
        const saveDocument = vi.spyOn(storageService, 'saveEditorDocument').mockResolvedValue();
        vi.spyOn(storageService, 'saveProject').mockResolvedValue();

        await importProjectBundle(await toBundleBlob(legacyZip));
        expect((saveDocument.mock.calls[0][1] as EditorManifestV4).videoTracks).toEqual([{
            id: 'video_track_1', name: 'Video 1', visible: true, locked: false,
        }]);

        saveDocument.mockClear();
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
        zip.file('sources/legacy.mp4', source.file as unknown as Uint8Array);
        const result = await importProjectBundle(await toBundleBlob(zip));

        expect(result.versionMismatch).toBe(true);
        expect(saveDocument.mock.calls[0][1]).toMatchObject({
            version: 4,
            globalEditingMode: 'ripple',
            editorialTranscriptDescriptors: [],
            narrative: null,
            videoClips: [{ audio: { linkState: 'linked' }, trackId: 'video_track_1', timelineStartFrame: 0 }],
        });
    });

    it('imports V1 after scalar inspection, rejects newer versions, and emits 4.0 for old-client rejection', async () => {
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

        await expect(importProjectBundle(await toBundleBlob(zip)))
            .resolves.toMatchObject({ versionMismatch: true });
        expect(saveDocument.mock.calls[0][1]).toMatchObject({ version: 4 });
        expect((saveDocument.mock.calls[0][1] as EditorManifestV4).videoSourceDescriptors[0].fingerprint)
            .toMatch(/^v2_/);

        const newer = new JSZip();
        newer.file('metadata.json', JSON.stringify({ ...metadata, version: '5.0' }));
        await expect(peekProjectBundle(await toBundleBlob(newer))).rejects.toThrow('Unsupported newer');

        vi.restoreAllMocks();
        vi.spyOn(storageService, 'loadProject').mockResolvedValue(project);
        vi.spyOn(storageService, 'loadEditorDocument')
            .mockResolvedValue(migrateEditorDocumentV3ToV4(v3Document(false)) as never);
        const currentBundle = await exportProjectBundle('project');
        const currentMetadata = await peekProjectBundle(currentBundle);
        expect(currentMetadata.version).toBe('4.0');
        expect(() => assertLegacyV3ClientAccepts(currentMetadata.version)).toThrow('Unsupported newer');
    });
});

async function createEditorialBundleFixture(): Promise<EditorialBundleFixture> {
    const source = video();
    const record = await createCanonicalEditorialTranscriptRecord(canonicalBodyInput(source.fingerprint));
    const requestKey = await createEditorialTranscriptRequestKey({
        sourceFingerprint: source.fingerprint,
        sampleCount: record.body.sampleCount,
        language: record.body.language,
        speakerMode: record.body.speakerMode,
        endpointIdentityDigest: digest('d'),
    });
    const descriptor = createEditorialTranscriptDescriptor({
        recordId: record.recordId,
        requestKey,
        sourceId: source.id,
        sourceFingerprint: source.fingerprint,
        endpointIdentityDigest: digest('d'),
        body: record.body,
        acquisition: 'provider',
        createdAt: '2026-01-01T00:00:00.000Z',
    });
    const secondaryRecord = await createCanonicalEditorialTranscriptRecord({
        ...canonicalBodyInput(source.fingerprint),
        canonicalModel: 'qwen-1.7b-edit-max-secondary',
    });
    const secondaryRequestKey = await createEditorialTranscriptRequestKey({
        sourceFingerprint: source.fingerprint,
        sampleCount: secondaryRecord.body.sampleCount,
        language: secondaryRecord.body.language,
        speakerMode: secondaryRecord.body.speakerMode,
        endpointIdentityDigest: digest('e'),
    });
    const secondaryDescriptor = createEditorialTranscriptDescriptor({
        recordId: secondaryRecord.recordId,
        requestKey: secondaryRequestKey,
        sourceId: source.id,
        sourceFingerprint: source.fingerprint,
        endpointIdentityDigest: digest('e'),
        body: secondaryRecord.body,
        acquisition: 'provider',
        createdAt: '2026-01-01T00:00:00.000Z',
    });
    const [firstWord, secondWord] = record.body.words;
    const left = createNarrativeSpeechBlockFixture({
        id: 'block_left',
        instanceId: 'instance_left',
        lineageRootId: 'lineage_split',
        parentInstanceIds: ['instance_parent'],
        clipId: 'clip_left',
        trackId: 'track_main',
        sourceId: source.id,
        transcriptRecordId: record.recordId,
        sourceIntervalId: 'interval_left',
        coreStartSample: 0,
        coreEndSample: 16_000,
        materialization: {
            sourceStartFrame: 0,
            sourceEndFrame: 30,
            preBoundary: { kind: 'margin', mode: 'explicit', requestedSamples: 0 },
            postBoundary: { kind: 'partition-seam', seamId: 'seam_one' },
        },
        timelineStartFrame: 0,
        sourceWordIds: [firstWord.id],
        wordTextOverrides: { [firstWord.id]: 'Hello corrected' },
        speakerOverrides: { [firstWord.id]: 'Narrator' },
    });
    const right = createNarrativeSpeechBlockFixture({
        id: 'block_right',
        instanceId: 'instance_right',
        lineageRootId: 'lineage_split',
        parentInstanceIds: ['instance_parent'],
        clipId: 'clip_right',
        trackId: 'track_main',
        sourceId: source.id,
        transcriptRecordId: record.recordId,
        sourceIntervalId: 'interval_right',
        coreStartSample: 16_000,
        coreEndSample: 32_000,
        materialization: {
            sourceStartFrame: 30,
            sourceEndFrame: 60,
            preBoundary: { kind: 'partition-seam', seamId: 'seam_one' },
            postBoundary: { kind: 'margin', mode: 'inherit-global', requestedSamples: null },
        },
        timelineStartFrame: 30,
        sourceWordIds: [secondWord.id],
        wordTextOverrides: {},
        speakerOverrides: {},
    });
    const repeated = createNarrativeSpeechBlockFixture({
        id: 'block_repeat',
        instanceId: 'instance_repeat',
        lineageRootId: 'lineage_repeat',
        parentInstanceIds: [],
        clipId: 'clip_repeat',
        trackId: 'track_main',
        sourceId: source.id,
        transcriptRecordId: record.recordId,
        sourceIntervalId: 'interval_repeat',
        coreStartSample: 0,
        coreEndSample: 16_000,
        materialization: {
            sourceStartFrame: 0,
            sourceEndFrame: 30,
            preBoundary: { kind: 'margin', mode: 'inherit-global', requestedSamples: null },
            postBoundary: { kind: 'margin', mode: 'explicit', requestedSamples: 0 },
        },
        timelineStartFrame: 60,
        sourceWordIds: [firstWord.id],
        wordTextOverrides: {},
        speakerOverrides: {},
    });
    const narrative = createNarrativeDocumentFixture({
        id: 'narrative_main',
        controlledTrackIds: ['track_main'],
        blockIds: [left.id, right.id, repeated.id],
        blocks: { [left.id]: left, [right.id]: right, [repeated.id]: repeated },
        sourceRecordIds: [record.recordId],
        settings: {
            globalPreMarginSamples: 0,
            globalPostMarginSamples: 0,
            boundaryRefinementEnabled: true,
            showSpeakers: true,
        },
    });
    const subtitleTrack = createSubtitleTrackV4Fixture({
        id: 'subtitle_track',
        subtitles: [{ id: 'subtitle_bound', startTime: 0, endTime: 1, text: 'Bound subtitle' }],
    });
    const link = createEditorialDependentLinkFixture({
        id: 'link_bound',
        anchorBlockId: left.id,
        target: { kind: 'subtitle', trackId: subtitleTrack.id, subtitleId: 'subtitle_bound' },
        association: {
            kind: 'transcript-bound',
            binding: {
                version: 1,
                bindingId: 'binding_bound',
                transcriptRecordId: record.recordId,
                sourceIntervalId: left.sourceIntervalId,
                activeStartSample: left.coreStartSample,
                activeEndSample: left.coreEndSample,
                lineageRootId: left.lineageRootId,
                createdFromBlockId: left.id,
            },
        },
        relativeStartOutputSample: 0,
        relativeEndOutputSample: 48_000,
    });
    const clipAudio = {
        linkState: 'linked' as const,
        muted: false,
        gainDb: 0,
        fadeInFrames: 0,
        fadeOutFrames: 0,
    };
    const document = createEditorDocumentV4Fixture({
        revision: 2,
        videoSources: [source],
        videoTracks: [{ id: 'track_main', name: 'Main', visible: true, locked: false }],
        videoClips: [{
            id: left.clipId,
            sourceId: source.id,
            trackId: left.trackId,
            timelineStartFrame: left.timelineStartFrame,
            sourceStart: 0,
            sourceEnd: 1,
            audio: { ...clipAudio },
        }, {
            id: right.clipId,
            sourceId: source.id,
            trackId: right.trackId,
            timelineStartFrame: right.timelineStartFrame,
            sourceStart: 1,
            sourceEnd: 2,
            audio: { ...clipAudio },
        }, {
            id: repeated.clipId,
            sourceId: source.id,
            trackId: repeated.trackId,
            timelineStartFrame: repeated.timelineStartFrame,
            sourceStart: 0,
            sourceEnd: 1,
            audio: { ...clipAudio },
        }],
        subtitleTracks: [subtitleTrack],
        activeSubtitleTrackId: subtitleTrack.id,
        editorialTranscriptDescriptors: [descriptor],
        narrative,
        dependentLinks: [link],
    });
    return { document, record, descriptor, secondaryRecord, secondaryDescriptor };
}

function canonicalBodyInput(sourceFingerprint: string) {
    return {
        sourceFingerprint,
        sampleCount: 32_000,
        canonicalModel: 'qwen-1.7b-edit-max-runtime',
        language: 'en',
        speakerMode: 'none' as const,
        noAudioStream: false,
        words: [{
            text: 'Hello',
            alignedStartSample: 0,
            alignedEndSample: 16_000,
            editableStartSample: 0,
            editableEndSample: 16_000,
            probability: 0.99,
            speakerLabel: null,
        }, {
            text: 'world',
            alignedStartSample: 16_000,
            alignedEndSample: 32_000,
            editableStartSample: 16_000,
            editableEndSample: 32_000,
            probability: 0.98,
            speakerLabel: null,
        }],
        speechRegions: [{
            providerRegionId: 1,
            startSample: 0,
            endSample: 32_000,
            evidence: 'alignment_acoustic' as const,
            wordStartIndex: 0,
            wordEndIndex: 2,
            vadPeakProbability: 0.99,
            vadMeanProbability: 0.95,
            startEnergyConfirmed: true,
            endEnergyConfirmed: true,
        }],
        editBoundaries: [{
            providerRegionId: 1,
            type: 'speech_start' as const,
            sample: 0,
            evidence: 'alignment_acoustic' as const,
            energyConfirmed: true,
        }, {
            providerRegionId: 1,
            type: 'speech_end' as const,
            sample: 32_000,
            evidence: 'alignment_acoustic' as const,
            energyConfirmed: true,
        }],
        speakers: [],
    };
}

function createV4Metadata(document: EditorDocumentV4): ProjectBundleMetadataV4 {
    return {
        version: '4.0',
        project: projectMetadata(),
        editorManifest: structuredClone(createEditorManifestV4(document)),
        sourceFiles: {
            video: Object.fromEntries(document.videoSources.map((source) => [
                source.id,
                `sources/video/${source.id}.mp4`,
            ])),
            audio: Object.fromEntries(document.audioSources.map((source) => [
                source.id,
                `sources/audio/${source.id}.wav`,
            ])),
        },
        editorialTranscriptFiles: Object.fromEntries(document.editorialTranscriptDescriptors.map((descriptor) => [
            descriptor.recordId,
            transcriptPath(descriptor.recordId),
        ])) as Record<Sha256Digest, string>,
        presets: [],
    };
}

async function generateV4Bundle(
    metadata: ProjectBundleMetadataV4,
    sourceDocument: EditorDocumentV4,
    records: readonly CanonicalEditorialTranscriptRecordV1[],
    options: {
        sidecarText?: Partial<Record<Sha256Digest, string>>;
        extraFiles?: Record<string, string>;
    } = {},
): Promise<Blob> {
    const zip = new JSZip();
    zip.file('metadata.json', JSON.stringify(metadata));
    sourceDocument.videoSources.forEach((source) => {
        const path = metadata.sourceFiles.video[source.id];
        if (path) zip.file(path, source.file as unknown as Uint8Array);
    });
    sourceDocument.audioSources.forEach((source) => {
        const path = metadata.sourceFiles.audio[source.id];
        if (path) zip.file(path, source.file as unknown as Uint8Array);
    });
    records.forEach((record) => {
        zip.file(
            transcriptPath(record.recordId),
            options.sidecarText?.[record.recordId] ?? record.canonicalJson,
        );
    });
    Object.entries(options.extraFiles ?? {}).forEach(([path, contents]) => zip.file(path, contents));
    return toBundleBlob(zip);
}

async function toBundleBlob(zip: JSZip): Promise<Blob> {
    return await zip.generateAsync({ type: 'uint8array' }) as unknown as Blob;
}

function transcriptPath(recordId: Sha256Digest): string {
    return `editorial-transcripts/${recordId.slice('sha256:'.length)}.json`;
}

function digest(character: string): Sha256Digest {
    return `sha256:${character.repeat(64)}` as Sha256Digest;
}

function retargetManifestRecord(manifest: EditorManifestV4, recordId: Sha256Digest): void {
    if (!manifest.narrative) throw new Error('Expected narrative fixture.');
    manifest.narrative.sourceRecordIds = [recordId];
    Object.values(manifest.narrative.blocks).forEach((block) => {
        block.transcriptRecordId = recordId;
    });
    manifest.dependentLinks.forEach((link) => {
        if (link.association.kind === 'transcript-bound') {
            link.association.binding.transcriptRecordId = recordId;
        }
    });
}

function assertLegacyV3ClientAccepts(version: string): void {
    if (Number(version.split('.')[0]) > 3) {
        throw new Error(`Unsupported newer project bundle version "${version}".`);
    }
}
