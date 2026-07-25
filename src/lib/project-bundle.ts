import type { TProject } from '@/types/project';
import type { Subtitle, SubtitleTrack } from '@/types/timeline';
import {
    isSha256Digest,
    type EditorialTranscriptDescriptor,
    type ResolvedEditorialTranscriptMapV1,
    type Sha256Digest,
    type TranscriptionCoverageRecordV2,
} from '@/types/editorial';
import type {
    EditorDocumentV4,
    EditorManifestV2,
    EditorManifestV3,
    EditorManifestV4,
    VideoSourceAssetV3,
} from '@/types/video';
import type { StylePreset } from '@/components/video-editor/subtitle-editor/types';
import {
    deleteStylePreset,
    getStylePresets,
    saveStylePreset,
} from '@/components/video-editor/subtitle-editor/presetUtils';
import { validateEditorDocument } from './video-timeline';
import { inspectVideoSource } from './video-source';
import {
    hydrateEditorDocumentV3,
    normalizeLegacyEditorManifestV3,
} from './editor-document-migration';
import { validateEditorManifestV3 } from './editor-document-v3';
import {
    createEditorManifestV4,
    hydrateEditorDocumentV4,
    migrateEditorDocumentV2ToV4,
    migrateEditorDocumentV3ToV4,
    migrateLegacyEditorDocumentToV4,
    normalizeLegacyEditorManifestV4,
} from './editor-document-v4-migration';
import {
    validateEditorManifestV4,
    validateHydratedEditorDocumentV4,
} from './editor-document-v4';
import {
    assertEditorialDescriptorMatchesBody,
    createEditorialTranscriptRequestKey,
} from './editorial-transcription/identity';
import {
    verifyCanonicalEditorialTranscriptRecord,
    type CanonicalEditorialTranscriptRecordV1,
} from './editorial-transcription/transcript-body';
import { EditorialTranscriptRepository } from './storage/editorial-transcript-repository';
import {
    IndexedRangeTranscriptionRepository,
} from './editorial-transcription/range-repository';
import type { RangeTranscriptChunkRecordV2 } from './editorial-transcription/range-orchestrator';
import { createCanonicalMergedRangeRecord } from './editorial-transcription/orchestrator';
import { mergeRangeTranscriptChunks } from './editorial-transcription/range-merge';
import {
    createAcquisitionProfileDigest,
    createRangeTranscriptionRequestKey,
    verifyTranscriptionCoverageRecordV2,
} from './editorial-transcription/range-coverage';
import { sha256CanonicalJson, canonicalizeJson } from './editorial-transcription/canonical-json';
import { storageService, type EditorPersistentAsset } from './storage/storage-service';
import {
    addBoundedZipEntryBytes,
    inspectProjectBundleZipBlob,
} from './project-bundle-zip';
import {
    MAX_IN_MEMORY_BUNDLE_BYTES,
    createBoundedMemoryZipSink,
    createWritableStreamZipSink,
    openRangeBackedProjectBundleArchive,
    writeStoredProjectBundleZip,
    type ProjectBundleArchive,
    type ProjectBundleArchiveEntry,
    type StoredProjectBundleEntry,
} from './project-bundle-streaming';
import { sha256Blob } from './project-bundle-digest';

export const PROJECT_BUNDLE_VERSION = '4.0';
export const PROJECT_BUNDLE_METADATA_MAX_BYTES = 4 * 1024 * 1024;
export const PROJECT_BUNDLE_TRANSCRIPT_MAX_RECORD_BYTES = 64 * 1024 * 1024;
export const PROJECT_BUNDLE_TRANSCRIPT_MAX_AGGREGATE_BYTES = 256 * 1024 * 1024;
const PROJECT_BUNDLE_MAX_ENTRIES = 8_192;
const IMPORT_PIN_GENERATION = 0;
const EDITORIAL_TRANSCRIPT_DIRECTORY = 'editorial-transcripts/';
const COVERAGE_RECORD_KEYS = new Set([
    'version',
    'recordId',
    'sourceFingerprint',
    'sourceSampleRate',
    'sourceSampleCount',
    'acquisitionProfileDigest',
    'endpointIdentityDigest',
    'contextSamples',
    'requestedModel',
    'responseSchema',
    'pcmAlgorithmVersion',
    'providerProfileVersion',
    'language',
    'speakerMode',
    'mergeAlgorithmVersion',
    'coreCoverage',
    'acquisitionWindows',
    'mergedTranscriptRecordId',
]);
const CHUNK_RECORD_KEYS = new Set([
    'version',
    'recordId',
    'sourceFingerprint',
    'acquisitionProfileDigest',
    'windowId',
    'decoded',
    'words',
]);
const V4_METADATA_KEYS = new Set([
    'version',
    'project',
    'editorManifest',
    'sourceFiles',
    'editorialTranscriptFiles',
    'editorialCoverageFiles',
    'editorialChunkFiles',
    'sourceDigests',
    'presets',
]);
const SERIALIZED_PROJECT_KEYS = new Set([
    'id',
    'name',
    'thumbnail',
    'duration',
    'createdAt',
    'updatedAt',
]);
const TYPED_SOURCE_MAP_KEYS = new Set(['video', 'audio']);

interface SerializedProject extends Omit<TProject, 'createdAt' | 'updatedAt'> {
    createdAt: string;
    updatedAt: string;
}

type MetadataBaseValue = {
    version: string;
    project: SerializedProject;
    presets: StylePreset[];
} & Record<string, unknown>;

export interface ProjectBundleMetadataV4 {
    version: '4.0';
    project: SerializedProject;
    /** Descriptor-only project graph. Canonical record bodies live in the declared sidecars. */
    editorManifest: EditorManifestV4;
    sourceFiles: {
        video: Record<string, string>;
        audio: Record<string, string>;
    };
    /** Streaming SHA-256 of every source. Optional only for legacy 4.0 compatibility. */
    sourceDigests?: {
        video: Record<string, Sha256Digest>;
        audio: Record<string, Sha256Digest>;
    };
    /** One unique canonical sidecar path for every record ID described by the current manifest. */
    editorialTranscriptFiles: Record<Sha256Digest, string>;
    /** V2 range proof and immutable chunk sidecars; omitted by legacy V1-only 4.0 bundles. */
    editorialCoverageFiles?: Record<Sha256Digest, string>;
    editorialChunkFiles?: Record<Sha256Digest, string>;
    presets: StylePreset[];
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
    | ProjectBundleMetadataV4
    | ProjectBundleMetadataV3
    | ProjectBundleMetadataV2
    | ProjectBundleMetadataV1;

interface PreparedProjectImport {
    manifest: EditorManifestV4;
    sourceAssets: EditorPersistentAsset[];
    transcriptRecords: CanonicalEditorialTranscriptRecordV1[];
    coverageRecords: TranscriptionCoverageRecordV2[];
    chunkRecords: RangeTranscriptChunkRecordV2[];
    recordIds: Sha256Digest[];
}

/**
 * Exports only the current descriptor-only V4 graph, typed source Files, and verified canonical
 * transcript bodies referenced by that graph. Local history, request indexes, pin state, derived
 * PCM/cache data, endpoint preferences, and credentials are never queried and therefore cannot
 * enter the archive accidentally.
 */
export async function exportProjectBundle(projectId: string): Promise<Blob> {
    const entries = await prepareProjectBundleExportEntries(
        projectId,
        undefined,
        MAX_IN_MEMORY_BUNDLE_BYTES,
    );
    const projectedBytes = entries.reduce((total, entry) => total + entry.data.size, 0);
    if (!Number.isSafeInteger(projectedBytes)
        || projectedBytes + 1024 * 1024 > MAX_IN_MEMORY_BUNDLE_BYTES) {
        throw new Error(
            'Project bundle exceeds the in-memory compatibility limit; use streaming export.',
        );
    }
    const memory = createBoundedMemoryZipSink();
    await writeStoredProjectBundleZip({ entries, sink: memory.sink });
    return memory.toBlob();
}

/** Streams a .waptions archive to a file-backed destination with cancellation and backpressure. */
export async function exportProjectBundleToWritableStream(
    projectId: string,
    stream: WritableStream<Uint8Array>,
    signal?: AbortSignal,
): Promise<void> {
    const sink = createWritableStreamZipSink(stream);
    try {
        const entries = await prepareProjectBundleExportEntries(projectId, signal);
        await writeStoredProjectBundleZip({ entries, sink, signal });
    } catch (error) {
        await sink.abort?.(error).catch(() => undefined);
        throw error;
    }
}

async function prepareProjectBundleExportEntries(
    projectId: string,
    signal?: AbortSignal,
    maximumArchiveBytes?: number,
): Promise<StoredProjectBundleEntry[]> {
    const [project, document] = await Promise.all([
        storageService.loadProject(projectId),
        storageService.loadEditorDocument(projectId, { targetVersion: 4 }),
    ]);
    if (!project) throw new Error('Project not found.');
    if (!document) throw new Error('The project has no durable editor document.');
    const sourceBytes = [...document.videoSources, ...document.audioSources]
        .reduce((total, source) => total + source.file.size, 0);
    if (!Number.isSafeInteger(sourceBytes)
        || (maximumArchiveBytes !== undefined
            && sourceBytes + 1024 * 1024 > maximumArchiveBytes)) {
        throw new Error(
            'Project bundle exceeds the in-memory compatibility limit; use streaming export.',
        );
    }

    const manifest = createEditorManifestV4(document);
    const transcriptRepository = new EditorialTranscriptRepository();
    const transcriptRecords = await resolveCurrentTranscriptRecords(
        document,
        manifest.editorialTranscriptDescriptors,
        transcriptRepository,
    );
    const rangeRepository = new IndexedRangeTranscriptionRepository();
    const { coverageRecords, chunkRecords } = await resolveCurrentRangeRecords(
        manifest.editorialTranscriptDescriptors,
        rangeRepository,
        transcriptRecords,
    );
    const entries: StoredProjectBundleEntry[] = [];
    const sourceFiles: ProjectBundleMetadataV4['sourceFiles'] = { video: {}, audio: {} };
    const sourceDigests: NonNullable<ProjectBundleMetadataV4['sourceDigests']> = {
        video: {},
        audio: {},
    };
    for (const source of document.videoSources) {
        throwIfAborted(signal);
        const path = sourcePath('video', source.id, source.originalName);
        sourceFiles.video[source.id] = path;
        sourceDigests.video[source.id] = await sha256Blob(source.file, signal);
        entries.push({ name: path, data: source.file });
    }
    for (const source of document.audioSources) {
        throwIfAborted(signal);
        const path = sourcePath('audio', source.id, source.originalName);
        sourceFiles.audio[source.id] = path;
        sourceDigests.audio[source.id] = await sha256Blob(source.file, signal);
        entries.push({ name: path, data: source.file });
    }

    const editorialTranscriptFiles = {} as Record<Sha256Digest, string>;
    const editorialCoverageFiles = {} as Record<Sha256Digest, string>;
    const editorialChunkFiles = {} as Record<Sha256Digest, string>;
    transcriptRecords.forEach((record) => {
        const path = editorialTranscriptPath(record.recordId);
        editorialTranscriptFiles[record.recordId] = path;
        // `canonicalJson` is the exact byte-domain string used to compute recordId. Pretty
        // printing or adding a newline here would make a nominally valid sidecar non-canonical.
        entries.push({
            name: path,
            data: new Blob([record.canonicalJson], { type: 'application/json' }),
        });
    });
    coverageRecords.forEach((record) => {
        const path = editorialCoveragePath(record.recordId);
        editorialCoverageFiles[record.recordId] = path;
        entries.push({
            name: path,
            data: new Blob([canonicalizeJson(record)], { type: 'application/json' }),
        });
    });
    chunkRecords.forEach((record) => {
        const path = editorialChunkPath(record.recordId);
        editorialChunkFiles[record.recordId] = path;
        entries.push({
            name: path,
            data: new Blob([canonicalizeJson(record)], { type: 'application/json' }),
        });
    });
    const metadata: ProjectBundleMetadataV4 = {
        version: PROJECT_BUNDLE_VERSION,
        project: {
            ...project,
            createdAt: project.createdAt.toISOString(),
            updatedAt: project.updatedAt.toISOString(),
        },
        editorManifest: manifest,
        sourceFiles,
        sourceDigests,
        editorialTranscriptFiles,
        ...(coverageRecords.length > 0 ? { editorialCoverageFiles } : {}),
        ...(chunkRecords.length > 0 ? { editorialChunkFiles } : {}),
        presets: getStylePresets().filter((preset) => !preset.isDefault),
    };
    const metadataJson = JSON.stringify(metadata, null, 2);
    if (new TextEncoder().encode(metadataJson).byteLength > PROJECT_BUNDLE_METADATA_MAX_BYTES) {
        throw new Error('Project bundle metadata exceeds the supported byte limit.');
    }
    entries.push({
        name: 'metadata.json',
        data: new Blob([metadataJson], { type: 'application/json' }),
    });
    if (entries.length > PROJECT_BUNDLE_MAX_ENTRIES) {
        throw new Error('Project bundle contains too many source or transcript entries.');
    }
    return entries;
}

export async function peekProjectBundle(blob: Blob): Promise<ProjectBundleMetadata> {
    const zip = await loadProjectBundleZip(blob);
    const metadata = await readMetadata(zip);
    validateDeclaredArchiveEntries(zip, metadata);
    return metadata;
}

/**
 * Builds and validates the entire import before committing any project reference. Canonical CAS
 * records are immutable cache candidates, so a failed import retains successfully verified bytes
 * while releasing only its own pending project generation. The temporary project database and
 * dashboard index are both removed before the original failure is returned.
 */
export async function importProjectBundle(
    blob: Blob,
    signal?: AbortSignal,
): Promise<{ projectId: string; versionMismatch: boolean }> {
    throwIfAborted(signal);
    const zip = await loadProjectBundleZip(blob, signal);
    const metadata = await readMetadata(zip);
    validateDeclaredArchiveEntries(zip, metadata);
    throwIfAborted(signal);
    const newProjectId = crypto.randomUUID();
    const importedProject = createImportedProject(metadata, newProjectId);
    const prepared = await prepareProjectImport(zip, metadata, signal);
    const transcriptRepository = new EditorialTranscriptRepository();
    const rangeRepository = new IndexedRangeTranscriptionRepository();
    let pendingPinsOwned = false;
    let durablePinsPublished = false;
    const importedPresetIds: string[] = [];

    try {
        // Imported bodies are verified again by the repository write boundary. Existing equal
        // bytes are an idempotent dedupe; conflicting bytes under one hash fail without overwrite.
        for (const record of prepared.transcriptRecords) {
            throwIfAborted(signal);
            await transcriptRepository.putRecord(record);
        }
        for (const record of prepared.chunkRecords) {
            throwIfAborted(signal);
            await rangeRepository.putChunk(record);
        }
        for (const record of prepared.coverageRecords) {
            throwIfAborted(signal);
            await rangeRepository.putCoverage(record);
        }
        throwIfAborted(signal);
        if (prepared.recordIds.length > 0) {
            await transcriptRepository.setPendingGenerationPins(
                newProjectId,
                IMPORT_PIN_GENERATION,
                prepared.recordIds,
            );
            pendingPinsOwned = true;
        }

        // Manifest and source Blobs commit in one project-database transaction. The dashboard
        // index is written only after that succeeds, so consumers cannot open a source-incomplete
        // project. The import promise does not resolve until durable CAS pins are also visible.
        await storageService.saveEditorDocument(
            newProjectId,
            prepared.manifest,
            prepared.sourceAssets,
        );
        await storageService.saveProject(importedProject);
        throwIfAborted(signal);
        if (prepared.recordIds.length > 0) {
            await transcriptRepository.publishDurableProjectPins({
                projectId: newProjectId,
                generation: IMPORT_PIN_GENERATION,
                durableRecordIds: prepared.recordIds,
                historyRecordIds: [],
                redoRecordIds: [],
                walRecordIds: [],
            });
            pendingPinsOwned = false;
            durablePinsPublished = true;
        }
        const existingPresets = getStylePresets();
        metadata.presets.forEach((preset) => {
            if (!existingPresets.some((existing) => existing.name === preset.name)) {
                importedPresetIds.push(saveStylePreset(preset.name, preset.style).id);
            }
        });
        return { projectId: newProjectId, versionMismatch: metadata.version !== PROJECT_BUNDLE_VERSION };
    } catch (error) {
        // Cleanup is deliberately scoped to the random temporary project and its exact pending
        // generation. CAS records may have existed before import (or may be useful verified cache
        // candidates now), so failure must never delete record bytes or another project's pins.
        await Promise.allSettled([
            storageService.deleteProjectDatabase(newProjectId),
            storageService.deleteProjectIndex(newProjectId),
            pendingPinsOwned
                ? transcriptRepository.clearPendingGenerationPins(newProjectId, IMPORT_PIN_GENERATION)
                : Promise.resolve(),
            durablePinsPublished
                ? transcriptRepository.deleteProjectPins(newProjectId)
                : Promise.resolve(),
        ]);
        importedPresetIds.forEach((presetId) => {
            try {
                deleteStylePreset(presetId);
            } catch {
                // Project and pin cleanup remain authoritative even if localStorage is unavailable.
            }
        });
        throw error;
    }
}

async function prepareProjectImport(
    zip: ProjectBundleArchive,
    metadata: ProjectBundleMetadata,
    signal?: AbortSignal,
): Promise<PreparedProjectImport> {
    if (isV4Metadata(metadata)) return prepareV4Import(zip, metadata, signal);
    if (isV3Metadata(metadata)) return prepareV3Import(zip, metadata, signal);
    if (isV2Metadata(metadata)) return prepareV2Import(zip, metadata, signal);
    return prepareV1Import(zip, metadata, signal);
}

async function prepareV4Import(
    zip: ProjectBundleArchive,
    metadata: ProjectBundleMetadataV4,
    signal?: AbortSignal,
): Promise<PreparedProjectImport> {
    const manifest = normalizeLegacyEditorManifestV4(metadata.editorManifest);
    assertValidManifestV4(manifest, 'bundle V4 manifest');
    assertTypedSourceMaps(
        metadata.sourceFiles,
        manifest.videoSourceDescriptors,
        manifest.audioSourceDescriptors,
        'V4',
    );
    assertSourceDigestMaps(
        metadata.sourceDigests,
        manifest.videoSourceDescriptors,
        manifest.audioSourceDescriptors,
    );
    const videoSources = [];
    for (const descriptor of manifest.videoSourceDescriptors) {
        videoSources.push(await restoreSourceFile(
            zip,
            metadata.sourceFiles.video[descriptor.id],
            descriptor,
            metadata.sourceDigests?.video[descriptor.id],
            signal,
        ));
    }
    const audioSources = [];
    for (const descriptor of manifest.audioSourceDescriptors) {
        audioSources.push(await restoreSourceFile(
            zip,
            metadata.sourceFiles.audio[descriptor.id],
            descriptor,
            metadata.sourceDigests?.audio[descriptor.id],
            signal,
        ));
    }
    const document = hydrateEditorDocumentV4(manifest, videoSources, audioSources);
    const transcriptRecords = await readAndValidateTranscriptSidecars(zip, metadata, document);
    const { coverageRecords, chunkRecords } = await readAndValidateRangeSidecars(
        zip,
        metadata,
        transcriptRecords,
    );
    return {
        manifest: createEditorManifestV4(document),
        sourceAssets: persistentAssets(videoSources, audioSources),
        transcriptRecords,
        coverageRecords,
        chunkRecords,
        recordIds: transcriptRecords.map((record) => record.recordId),
    };
}

async function prepareV3Import(
    zip: ProjectBundleArchive,
    metadata: ProjectBundleMetadataV3,
    signal?: AbortSignal,
): Promise<PreparedProjectImport> {
    const normalizedManifest = normalizeLegacyEditorManifestV3(metadata.editorManifest);
    const validation = validateEditorManifestV3(normalizedManifest);
    if (!validation.valid) throwValidationError('bundle V3 manifest', validation.issues);
    assertTypedSourceMaps(
        metadata.sourceFiles,
        normalizedManifest.videoSourceDescriptors,
        normalizedManifest.audioSourceDescriptors,
        'V3',
    );
    const videoSources = [];
    for (const descriptor of normalizedManifest.videoSourceDescriptors) {
        videoSources.push(await restoreSourceFile(
            zip,
            metadata.sourceFiles.video[descriptor.id],
            descriptor,
            undefined,
            signal,
        ));
    }
    const audioSources = [];
    for (const descriptor of normalizedManifest.audioSourceDescriptors) {
        audioSources.push(await restoreSourceFile(
            zip,
            metadata.sourceFiles.audio[descriptor.id],
            descriptor,
            undefined,
            signal,
        ));
    }
    // The existing reader establishes a valid hydrated V3 graph first; the one authoritative pure
    // migration then supplies explicit V4 placement and subtitle response policy.
    const v3Document = hydrateEditorDocumentV3(normalizedManifest, videoSources, audioSources);
    const document = migrateEditorDocumentV3ToV4(v3Document);
    return {
        manifest: createEditorManifestV4(document),
        sourceAssets: persistentAssets(videoSources, audioSources),
        transcriptRecords: [],
        coverageRecords: [],
        chunkRecords: [],
        recordIds: [],
    };
}

async function prepareV2Import(
    zip: ProjectBundleArchive,
    metadata: ProjectBundleMetadataV2,
    signal?: AbortSignal,
): Promise<PreparedProjectImport> {
    assertV2ManifestSourceShape(metadata.editorManifest);
    assertLegacySourceMap(metadata.sourceFiles, metadata.editorManifest.sourceDescriptors, 'V2');
    const videoSources = [];
    for (const descriptor of metadata.editorManifest.sourceDescriptors) {
        videoSources.push(await restoreSourceFile(
            zip,
            metadata.sourceFiles[descriptor.id],
            descriptor,
            undefined,
            signal,
        ));
    }
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
    if (!validation.valid) throwValidationError('bundle V2 editor document', validation.issues);
    const document = migrateEditorDocumentV2ToV4({
        manifest: metadata.editorManifest,
        loadedVideoSources: videoSources,
    });
    return {
        manifest: createEditorManifestV4(document),
        sourceAssets: persistentAssets(videoSources, []),
        transcriptRecords: [],
        coverageRecords: [],
        chunkRecords: [],
        recordIds: [],
    };
}

async function prepareV1Import(
    zip: ProjectBundleArchive,
    metadata: ProjectBundleMetadataV1,
    signal?: AbortSignal,
): Promise<PreparedProjectImport> {
    const videoEntry = Array.from(zip.entries.values())
        .find(entry => /^video\./.test(entry.name) && !entry.directory) ?? null;
    let source: VideoSourceAssetV3 | null = null;
    if (videoEntry) {
        throwIfAborted(signal);
        const blob = await videoEntry.readBlob();
        throwIfAborted(signal);
        source = await inspectVideoSource(new File([blob], baseName(videoEntry.name), {
            type: getMimeTypeFromFileName(videoEntry.name),
        }));
    }
    const document = migrateLegacyEditorDocumentToV4({
        tracks: metadata.timeline.tracks,
        rawTranscription: metadata.timeline.rawTranscription,
        transcriptionGroups: metadata.timeline.transcriptionGroups,
        transcriptionContainerIds: metadata.timeline.transcriptionContainerIds,
        loadedVideoSource: source,
    });
    return {
        manifest: createEditorManifestV4(document),
        sourceAssets: persistentAssets(source ? [source] : [], []),
        transcriptRecords: [],
        coverageRecords: [],
        chunkRecords: [],
        recordIds: [],
    };
}

async function resolveCurrentTranscriptRecords(
    document: EditorDocumentV4,
    descriptors: readonly EditorialTranscriptDescriptor[],
    repository: EditorialTranscriptRepository,
): Promise<CanonicalEditorialTranscriptRecordV1[]> {
    const descriptorsByRecordId = groupDescriptorsByRecordId(descriptors);
    const resolvedBodies = {} as Record<Sha256Digest, ResolvedEditorialTranscriptMapV1[Sha256Digest]>;
    const records: CanonicalEditorialTranscriptRecordV1[] = [];
    let aggregateBytes = 0;
    for (const [recordId, recordDescriptors] of Array.from(descriptorsByRecordId.entries())) {
        const body = await repository.getRecord(recordId, { referenced: true });
        if (!body) throw new Error('A transcript body required for bundle export is missing.');
        for (const descriptor of recordDescriptors) {
            assertEditorialDescriptorMatchesBody(descriptor, body);
            await assertEditorialDescriptorRequestKey(descriptor);
        }
        const record = await verifyCanonicalEditorialTranscriptRecord(body, recordId);
        aggregateBytes = addTranscriptSidecarBytes(aggregateBytes, record.canonicalBytes.byteLength);
        resolvedBodies[recordId] = record.body;
        records.push(record);
    }
    const validation = validateHydratedEditorDocumentV4(document, resolvedBodies);
    if (!validation.valid) throwValidationError('hydrated bundle export graph', validation.issues);
    return records;
}

async function resolveCurrentRangeRecords(
    descriptors: readonly EditorialTranscriptDescriptor[],
    repository: IndexedRangeTranscriptionRepository,
    transcriptRecords: readonly CanonicalEditorialTranscriptRecordV1[],
): Promise<{
    coverageRecords: TranscriptionCoverageRecordV2[];
    chunkRecords: RangeTranscriptChunkRecordV2[];
}> {
    const coverageById = new Map<Sha256Digest, TranscriptionCoverageRecordV2>();
    const chunksById = new Map<Sha256Digest, RangeTranscriptChunkRecordV2>();
    for (const descriptor of descriptors) {
        if (descriptor.version !== 2) continue;
        const coverage = await repository.getCoverage(descriptor.coverageRecordId);
        if (!coverage
            || coverage.mergedTranscriptRecordId !== descriptor.recordId
            || coverage.sourceFingerprint !== descriptor.sourceFingerprint
            || coverage.acquisitionProfileDigest !== descriptor.acquisitionProfileDigest
            || coverage.mergeAlgorithmVersion !== descriptor.mergeAlgorithmVersion) {
            throw new Error('A coverage record required for bundle export is missing or inconsistent.');
        }
        coverageById.set(coverage.recordId, coverage);
        for (const chunkId of coverage.acquisitionWindows.flatMap(window => window.chunkRecordIds)) {
            const chunk = await repository.getChunk(chunkId);
            if (!chunk
                || chunk.sourceFingerprint !== descriptor.sourceFingerprint
                || chunk.acquisitionProfileDigest !== descriptor.acquisitionProfileDigest) {
                throw new Error('A range chunk required for bundle export is missing or inconsistent.');
            }
            chunksById.set(chunk.recordId, chunk);
        }
    }
    await assertRangeSidecarsReproduceMergedRecords({
        descriptors,
        coverageRecords: Array.from(coverageById.values()),
        chunkRecords: Array.from(chunksById.values()),
        transcriptRecords,
    });
    return {
        coverageRecords: Array.from(coverageById.values())
            .sort((left, right) => left.recordId.localeCompare(right.recordId)),
        chunkRecords: Array.from(chunksById.values())
            .sort((left, right) => left.recordId.localeCompare(right.recordId)),
    };
}

async function readAndValidateTranscriptSidecars(
    zip: ProjectBundleArchive,
    metadata: ProjectBundleMetadataV4,
    document: EditorDocumentV4,
): Promise<CanonicalEditorialTranscriptRecordV1[]> {
    const descriptorsByRecordId = groupDescriptorsByRecordId(metadata.editorManifest.editorialTranscriptDescriptors);
    const declarations = validateTranscriptDeclarations(zip, metadata.editorialTranscriptFiles, descriptorsByRecordId);
    const resolvedBodies = {} as Record<Sha256Digest, ResolvedEditorialTranscriptMapV1[Sha256Digest]>;
    const records: CanonicalEditorialTranscriptRecordV1[] = [];
    for (const declaration of declarations) {
        const bounded = await readBoundedArchiveUtf8(
            declaration.entry,
            PROJECT_BUNDLE_TRANSCRIPT_MAX_RECORD_BYTES,
            'editorial transcript sidecar',
        );
        let parsed: unknown;
        try {
            parsed = JSON.parse(bounded.text) as unknown;
        } catch {
            throw new Error('Invalid editorial transcript sidecar: malformed JSON.');
        }
        let record: CanonicalEditorialTranscriptRecordV1;
        try {
            record = await verifyCanonicalEditorialTranscriptRecord(parsed, declaration.recordId);
        } catch {
            throw new Error('Invalid editorial transcript sidecar: corrupt body or record hash mismatch.');
        }
        if (!equalBytes(record.canonicalBytes, bounded.bytes)) {
            throw new Error('Invalid editorial transcript sidecar: bytes are not canonical JSON.');
        }
        try {
            for (const descriptor of descriptorsByRecordId.get(declaration.recordId) ?? []) {
                assertEditorialDescriptorMatchesBody(descriptor, record.body);
                await assertEditorialDescriptorRequestKey(descriptor);
            }
        } catch {
            throw new Error('Invalid editorial transcript sidecar: descriptor or source identity mismatch.');
        }
        resolvedBodies[declaration.recordId] = record.body;
        records.push(record);
    }
    const validation = validateHydratedEditorDocumentV4(document, resolvedBodies);
    if (!validation.valid) throwValidationError('hydrated bundle import graph', validation.issues);
    return records;
}

async function readAndValidateRangeSidecars(
    zip: ProjectBundleArchive,
    metadata: ProjectBundleMetadataV4,
    transcriptRecords: readonly CanonicalEditorialTranscriptRecordV1[],
): Promise<{
    coverageRecords: TranscriptionCoverageRecordV2[];
    chunkRecords: RangeTranscriptChunkRecordV2[];
}> {
    const descriptors = metadata.editorManifest.editorialTranscriptDescriptors
        .filter(descriptor => descriptor.version === 2);
    const expectedCoverageIds = new Set(descriptors.map(descriptor => descriptor.coverageRecordId));
    const coverageDeclarations = validateRangeDeclarations({
        zip,
        declarations: metadata.editorialCoverageFiles ?? {},
        expectedIds: expectedCoverageIds,
        directory: 'editorial-coverage/',
        pathForId: editorialCoveragePath,
        label: 'coverage',
    });
    const coverageRecords: TranscriptionCoverageRecordV2[] = [];
    for (const declaration of coverageDeclarations) {
        const value = await readCanonicalRangeJson(
            declaration.entry,
            PROJECT_BUNDLE_TRANSCRIPT_MAX_RECORD_BYTES,
            'editorial coverage sidecar',
        );
        assertOnlyObjectKeys(value, COVERAGE_RECORD_KEYS, 'editorial coverage sidecar');
        const coverage = value as unknown as TranscriptionCoverageRecordV2;
        if (coverage.recordId !== declaration.recordId) {
            throw new Error('Invalid editorial coverage sidecar: record ID mismatch.');
        }
        await verifyTranscriptionCoverageRecordV2(coverage);
        const descriptor = descriptors.find(
            candidate => candidate.coverageRecordId === coverage.recordId,
        );
        if (!descriptor
            || coverage.mergedTranscriptRecordId !== descriptor.recordId
            || coverage.sourceFingerprint !== descriptor.sourceFingerprint
            || coverage.acquisitionProfileDigest !== descriptor.acquisitionProfileDigest
            || coverage.endpointIdentityDigest !== descriptor.endpointIdentityDigest) {
            throw new Error('Invalid editorial coverage sidecar: descriptor mismatch.');
        }
        const profile = {
            sourceFingerprint: coverage.sourceFingerprint,
            sourceSampleRate: coverage.sourceSampleRate,
            sourceSampleCount: coverage.sourceSampleCount,
            coreCoverage: coverage.coreCoverage,
            contextSamples: coverage.contextSamples,
            language: descriptor.language,
            speakerMode: coverage.speakerMode,
            endpointIdentityDigest: coverage.endpointIdentityDigest,
            requestedModel: coverage.requestedModel,
            responseSchema: coverage.responseSchema,
            pcmAlgorithmVersion: coverage.pcmAlgorithmVersion,
            providerProfileVersion: coverage.providerProfileVersion,
            mergeAlgorithmVersion: coverage.mergeAlgorithmVersion,
        };
        if (await createAcquisitionProfileDigest(profile) !== coverage.acquisitionProfileDigest
            || await createRangeTranscriptionRequestKey(profile) !== descriptor.requestKey) {
            throw new Error('Invalid editorial coverage sidecar: acquisition identity mismatch.');
        }
        coverageRecords.push(coverage);
    }

    const expectedChunkIds = new Set(coverageRecords.flatMap(record => (
        record.acquisitionWindows.flatMap(window => window.chunkRecordIds)
    )));
    const chunkDeclarations = validateRangeDeclarations({
        zip,
        declarations: metadata.editorialChunkFiles ?? {},
        expectedIds: expectedChunkIds,
        directory: 'editorial-chunks/',
        pathForId: editorialChunkPath,
        label: 'chunk',
    });
    const chunkRecords: RangeTranscriptChunkRecordV2[] = [];
    for (const declaration of chunkDeclarations) {
        const value = await readCanonicalRangeJson(
            declaration.entry,
            PROJECT_BUNDLE_TRANSCRIPT_MAX_RECORD_BYTES,
            'editorial chunk sidecar',
        );
        assertOnlyObjectKeys(value, CHUNK_RECORD_KEYS, 'editorial chunk sidecar');
        const chunk = value as unknown as RangeTranscriptChunkRecordV2;
        if (chunk.recordId !== declaration.recordId) {
            throw new Error('Invalid editorial chunk sidecar: record ID mismatch.');
        }
        const { recordId, ...body } = chunk;
        if (await sha256CanonicalJson(body) !== recordId
            || !coverageRecords.some(record => (
                record.sourceFingerprint === chunk.sourceFingerprint
                && record.acquisitionProfileDigest === chunk.acquisitionProfileDigest
                && record.acquisitionWindows.some(window => (
                    window.windowId === chunk.windowId
                    && window.chunkRecordIds.includes(chunk.recordId)
                ))
            ))) {
            throw new Error('Invalid editorial chunk sidecar: hash or coverage mismatch.');
        }
        chunkRecords.push(chunk);
    }
    await assertRangeSidecarsReproduceMergedRecords({
        descriptors,
        coverageRecords,
        chunkRecords,
        transcriptRecords,
    });
    return { coverageRecords, chunkRecords };
}

async function assertRangeSidecarsReproduceMergedRecords(input: {
    descriptors: readonly EditorialTranscriptDescriptor[];
    coverageRecords: readonly TranscriptionCoverageRecordV2[];
    chunkRecords: readonly RangeTranscriptChunkRecordV2[];
    transcriptRecords: readonly CanonicalEditorialTranscriptRecordV1[];
}): Promise<void> {
    const chunks = new Map(input.chunkRecords.map(record => [record.recordId, record]));
    const transcripts = new Map(input.transcriptRecords.map(record => [record.recordId, record]));
    for (const coverage of input.coverageRecords) {
        const descriptor = input.descriptors.find(candidate => (
            candidate.version === 2 && candidate.coverageRecordId === coverage.recordId
        ));
        const transcript = transcripts.get(coverage.mergedTranscriptRecordId);
        if (!descriptor || !transcript) {
            throw new Error('Invalid editorial coverage sidecar: merged transcript is missing.');
        }
        const referencedChunks = coverage.acquisitionWindows.flatMap(window => (
            window.chunkRecordIds.map((recordId) => {
                const chunk = chunks.get(recordId);
                if (!chunk) {
                    throw new Error('Invalid editorial coverage sidecar: range chunk is missing.');
                }
                return chunk;
            })
        ));
        if (descriptor.acquisition === 'local-no-audio') {
            if (!transcript.body.noAudioStream
                || referencedChunks.some(chunk => chunk.words.length > 0)) {
                throw new Error('Invalid editorial coverage sidecar: no-audio proof is contradictory.');
            }
            continue;
        }
        const merged = mergeRangeTranscriptChunks(referencedChunks, coverage.coreCoverage);
        const rebuilt = await createCanonicalMergedRangeRecord({
            sourceFingerprint: coverage.sourceFingerprint,
            sampleCount: coverage.sourceSampleCount,
            language: descriptor.language,
            speakerMode: descriptor.speakerMode,
            canonicalModel: descriptor.canonicalModel,
            words: merged.words,
        });
        if (rebuilt.recordId !== coverage.mergedTranscriptRecordId
            || rebuilt.canonicalJson !== transcript.canonicalJson) {
            throw new Error(
                'Invalid editorial coverage sidecar: chunks do not reproduce the merged transcript.',
            );
        }
    }
}

function validateRangeDeclarations(input: {
    zip: ProjectBundleArchive;
    declarations: Record<Sha256Digest, string>;
    expectedIds: ReadonlySet<Sha256Digest>;
    directory: string;
    pathForId: (recordId: Sha256Digest) => string;
    label: string;
}): Array<{ recordId: Sha256Digest; entry: ProjectBundleArchiveEntry }> {
    const declaredIds = new Set<Sha256Digest>();
    const declaredPaths = new Set<string>();
    const result: Array<{ recordId: Sha256Digest; entry: ProjectBundleArchiveEntry }> = [];
    Object.entries(input.declarations).forEach(([candidateId, path]) => {
        if (!isSha256Digest(candidateId)
            || !input.expectedIds.has(candidateId)
            || path !== input.pathForId(candidateId)
            || declaredIds.has(candidateId)
            || declaredPaths.has(path)) {
            throw new Error(`Invalid bundle ${input.label} declaration.`);
        }
        const entry = input.zip.get(path);
        if (!entry || entry.directory) {
            throw new Error(`Invalid bundle ${input.label} declaration: sidecar is missing.`);
        }
        declaredIds.add(candidateId);
        declaredPaths.add(path);
        result.push({ recordId: candidateId, entry });
    });
    input.expectedIds.forEach((recordId) => {
        if (!declaredIds.has(recordId)) {
            throw new Error(`Invalid bundle ${input.label} declaration: descriptor has no sidecar.`);
        }
    });
    input.zip.entries.forEach((entry) => {
        if (!entry.directory && entry.name.startsWith(input.directory)
            && !declaredPaths.has(entry.name)) {
            throw new Error(`Invalid bundle ${input.label} declaration: undeclared sidecar.`);
        }
    });
    return result.sort((left, right) => left.recordId.localeCompare(right.recordId));
}

async function readCanonicalRangeJson(
    entry: ProjectBundleArchiveEntry,
    maximumBytes: number,
    label: string,
): Promise<unknown> {
    const bounded = await readBoundedArchiveUtf8(entry, maximumBytes, label);
    let value: unknown;
    try {
        value = JSON.parse(bounded.text) as unknown;
    } catch {
        throw new Error(`Invalid ${label}: malformed JSON.`);
    }
    if (canonicalizeJson(value) !== bounded.text) {
        throw new Error(`Invalid ${label}: bytes are not canonical JSON.`);
    }
    return value;
}

function validateTranscriptDeclarations(
    zip: ProjectBundleArchive,
    declarationMap: Record<Sha256Digest, string>,
    descriptorsByRecordId: Map<Sha256Digest, EditorialTranscriptDescriptor[]>,
): Array<{ recordId: Sha256Digest; path: string; entry: ProjectBundleArchiveEntry }> {
    const entries = Object.entries(declarationMap);
    const declaredRecordIds = new Set<Sha256Digest>();
    const declaredPaths = new Set<string>();
    const declarations: Array<{
        recordId: Sha256Digest;
        path: string;
        entry: ProjectBundleArchiveEntry;
    }> = [];
    let aggregateBytes = 0;

    for (const [candidateRecordId, path] of entries) {
        if (!isSha256Digest(candidateRecordId)) {
            throw new Error('Invalid bundle transcript declaration: record ID is malformed.');
        }
        const recordId = candidateRecordId;
        if (!descriptorsByRecordId.has(recordId)) {
            throw new Error('Invalid bundle transcript declaration: sidecar has no manifest descriptor.');
        }
        if (declaredRecordIds.has(recordId)) {
            throw new Error('Invalid bundle transcript declaration: duplicate record ID.');
        }
        if (declaredPaths.has(path)) {
            throw new Error('Invalid bundle transcript declaration: duplicate sidecar path.');
        }
        const expectedPath = editorialTranscriptPath(recordId);
        if (path !== expectedPath) {
            throw new Error('Invalid bundle transcript declaration: sidecar path does not match its record ID.');
        }
        const entry = zip.get(path);
        if (!entry || entry.directory) {
            throw new Error('Invalid bundle transcript declaration: required sidecar is missing.');
        }
        aggregateBytes = addTranscriptSidecarBytes(aggregateBytes, entry.uncompressedBytes);
        declaredRecordIds.add(recordId);
        declaredPaths.add(path);
        declarations.push({ recordId, path, entry });
    }
    for (const recordId of Array.from(descriptorsByRecordId.keys())) {
        if (!declaredRecordIds.has(recordId)) {
            throw new Error('Invalid bundle transcript declaration: manifest descriptor has no sidecar.');
        }
    }
    zip.entries.forEach((entry) => {
        if (!entry.directory && entry.name.startsWith(EDITORIAL_TRANSCRIPT_DIRECTORY)
            && !declaredPaths.has(entry.name)) {
            throw new Error('Invalid bundle transcript declaration: undeclared transcript sidecar.');
        }
    });
    return declarations.sort((left, right) => left.recordId.localeCompare(right.recordId));
}

function groupDescriptorsByRecordId(
    descriptors: readonly EditorialTranscriptDescriptor[],
): Map<Sha256Digest, EditorialTranscriptDescriptor[]> {
    const grouped = new Map<Sha256Digest, EditorialTranscriptDescriptor[]>();
    descriptors.forEach((descriptor) => {
        const current = grouped.get(descriptor.recordId) ?? [];
        current.push(descriptor);
        grouped.set(descriptor.recordId, current);
    });
    return new Map(Array.from(grouped.entries()).sort(([left], [right]) => left.localeCompare(right)));
}

async function assertEditorialDescriptorRequestKey(
    descriptor: EditorialTranscriptDescriptor,
): Promise<void> {
    if (descriptor.version === 2) return;
    const expectedRequestKey = await createEditorialTranscriptRequestKey({
        sourceFingerprint: descriptor.sourceFingerprint,
        sampleCount: descriptor.sampleCount,
        language: descriptor.language,
        speakerMode: descriptor.speakerMode,
        endpointIdentityDigest: descriptor.endpointIdentityDigest,
    });
    if (descriptor.requestKey !== expectedRequestKey) {
        throw new Error('Editorial transcript descriptor request provenance is invalid.');
    }
}

function addTranscriptSidecarBytes(aggregateBytes: number, recordBytes: number): number {
    return addBoundedZipEntryBytes(
        aggregateBytes,
        recordBytes,
        PROJECT_BUNDLE_TRANSCRIPT_MAX_RECORD_BYTES,
        PROJECT_BUNDLE_TRANSCRIPT_MAX_AGGREGATE_BYTES,
        'editorial transcript sidecars',
    );
}

async function restoreSourceFile<T extends {
    id: string;
    originalName: string;
    mimeType: string;
    size: number;
    lastModified: number;
}>(
    zip: ProjectBundleArchive,
    path: string | undefined,
    descriptor: T,
    expectedDigest?: Sha256Digest,
    signal?: AbortSignal,
): Promise<T & { file: File }> {
    throwIfAborted(signal);
    const entry = path ? zip.get(path) : null;
    if (!entry || entry.directory) throw new Error(`Bundle source file "${descriptor.id}" is missing.`);
    if (entry.uncompressedBytes !== descriptor.size) {
        throw new Error('Invalid bundle source file: ZIP byte size does not match its descriptor.');
    }
    const blob = await entry.readBlob(
        expectedDigest ? { expectedSha256: expectedDigest } : undefined,
    );
    throwIfAborted(signal);
    if (blob.size !== descriptor.size) {
        throw new Error(`Bundle source file "${descriptor.id}" has an invalid byte size.`);
    }
    return {
        ...descriptor,
        file: new File([blob], descriptor.originalName, {
            type: descriptor.mimeType,
            lastModified: descriptor.lastModified,
        }),
    };
}

function persistentAssets(
    videoSources: readonly VideoSourceAssetV3[],
    audioSources: ReadonlyArray<EditorDocumentV4['audioSources'][number]>,
): EditorPersistentAsset[] {
    return [
        ...videoSources.map((asset): EditorPersistentAsset => ({ kind: 'video-source', asset })),
        ...audioSources.map((asset): EditorPersistentAsset => ({ kind: 'audio-source', asset })),
    ];
}

function createImportedProject(metadata: ProjectBundleMetadata, newProjectId: string): TProject {
    return {
        id: newProjectId,
        name: `${metadata.project.name} (Imported)`,
        ...(metadata.project.thumbnail === undefined ? {} : { thumbnail: metadata.project.thumbnail }),
        ...(metadata.project.duration === undefined ? {} : { duration: metadata.project.duration }),
        createdAt: new Date(),
        updatedAt: new Date(),
    };
}

async function loadProjectBundleZip(
    blob: Blob,
    signal?: AbortSignal,
): Promise<ProjectBundleArchive> {
    throwIfAborted(signal);
    const normalized = ArrayBuffer.isView(blob)
        ? new Blob([
            new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength),
        ])
        : blob;
    await inspectProjectBundleZipBlob(normalized, PROJECT_BUNDLE_MAX_ENTRIES);
    return openRangeBackedProjectBundleArchive(normalized, PROJECT_BUNDLE_MAX_ENTRIES, signal);
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new DOMException('Project bundle operation was cancelled.', 'AbortError');
    }
}

async function readMetadata(zip: ProjectBundleArchive): Promise<ProjectBundleMetadata> {
    const metadataFile = zip.get('metadata.json');
    if (!metadataFile || metadataFile.directory) {
        throw new Error('Invalid .waptions file: missing metadata.');
    }
    const bounded = await readBoundedArchiveUtf8(
        metadataFile,
        PROJECT_BUNDLE_METADATA_MAX_BYTES,
        '.waptions metadata',
    );
    let value: unknown;
    try {
        value = JSON.parse(bounded.text) as unknown;
    } catch {
        throw new Error('Invalid .waptions file: malformed metadata JSON.');
    }
    if (!isMetadataBase(value)) throw new Error('Invalid .waptions file: malformed metadata.');
    const major = parseMajorVersion(value.version);
    if (major > 4) throw new Error(`Unsupported newer project bundle version "${value.version}".`);
    if (value.version === '4.0' && isV4MetadataShape(value)) return value;
    if (value.version === '3.0' && isV3MetadataShape(value)) return value;
    if (value.version === '2.0' && isV2MetadataShape(value)) return value;
    if (major <= 1 && isV1MetadataShape(value)) return value;
    throw new Error(`Unsupported project bundle version "${value.version}".`);
}

async function readBoundedArchiveUtf8(
    entry: ProjectBundleArchiveEntry,
    maximumBytes: number,
    label: string,
): Promise<{ bytes: Uint8Array; text: string }> {
    if (entry.uncompressedBytes > maximumBytes) {
        throw new Error(`Invalid ${label}: exceeds the ${maximumBytes}-byte limit.`);
    }
    const bytes = await entry.readBytes(maximumBytes);
    try {
        return {
            bytes,
            text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        };
    } catch {
        throw new Error(`Invalid ${label}: content is not valid UTF-8.`);
    }
}

function isMetadataBase(value: unknown): value is MetadataBaseValue {
    if (!isRecord(value) || typeof value.version !== 'string' || !isSerializedProject(value.project)
        || !Array.isArray(value.presets)) return false;
    return value.presets.every((preset) => isRecord(preset)
        && typeof preset.name === 'string'
        && preset.name.length > 0
        && isRecord(preset.style));
}

function isV4MetadataShape(
    value: MetadataBaseValue,
): value is ProjectBundleMetadataV4 & Record<string, unknown> {
    return hasOnlyKeys(value, V4_METADATA_KEYS)
        && hasOnlyKeys(value.project, SERIALIZED_PROJECT_KEYS)
        && isRecord(value.editorManifest)
        && isTypedSourceMapValue(value.sourceFiles)
        && (value.sourceDigests === undefined || isTypedSourceMapValue(value.sourceDigests))
        && isStringRecord(value.editorialTranscriptFiles)
        && (value.editorialCoverageFiles === undefined
            || isStringRecord(value.editorialCoverageFiles))
        && (value.editorialChunkFiles === undefined
            || isStringRecord(value.editorialChunkFiles));
}

function isV3MetadataShape(
    value: MetadataBaseValue,
): value is ProjectBundleMetadataV3 & Record<string, unknown> {
    return isRecord(value.editorManifest) && isTypedSourceMapValue(value.sourceFiles);
}

function isV2MetadataShape(
    value: MetadataBaseValue,
): value is ProjectBundleMetadataV2 & Record<string, unknown> {
    return isRecord(value.editorManifest) && isStringRecord(value.sourceFiles);
}

function isV1MetadataShape(
    value: MetadataBaseValue,
): value is ProjectBundleMetadataV1 & Record<string, unknown> {
    return isRecord(value.timeline)
        && Array.isArray(value.timeline.tracks)
        && (value.timeline.rawTranscription === null || Array.isArray(value.timeline.rawTranscription))
        && (value.timeline.transcriptionGroups === null || isRecord(value.timeline.transcriptionGroups))
        && (value.timeline.transcriptionContainerIds === null
            || Array.isArray(value.timeline.transcriptionContainerIds));
}

function validateDeclaredArchiveEntries(
    zip: ProjectBundleArchive,
    metadata: ProjectBundleMetadata,
): void {
    const expectedFiles = new Set<string>(['metadata.json']);
    if (isV4Metadata(metadata)) {
        Object.values(metadata.sourceFiles.video).forEach(path => expectedFiles.add(path));
        Object.values(metadata.sourceFiles.audio).forEach(path => expectedFiles.add(path));
        Object.values(metadata.editorialTranscriptFiles).forEach(path => expectedFiles.add(path));
        Object.values(metadata.editorialCoverageFiles ?? {}).forEach(path => expectedFiles.add(path));
        Object.values(metadata.editorialChunkFiles ?? {}).forEach(path => expectedFiles.add(path));
    } else if (isV3Metadata(metadata)) {
        Object.values(metadata.sourceFiles.video).forEach(path => expectedFiles.add(path));
        Object.values(metadata.sourceFiles.audio).forEach(path => expectedFiles.add(path));
    } else if (isV2Metadata(metadata)) {
        Object.values(metadata.sourceFiles).forEach(path => expectedFiles.add(path));
    } else {
        const legacyVideoFiles = Array.from(zip.entries.values())
            .filter(entry => !entry.directory && /^video\.[^/]+$/.test(entry.name));
        if (legacyVideoFiles.length > 1) {
            throw new Error('Invalid .waptions file: multiple legacy video entries are unsupported.');
        }
        legacyVideoFiles.forEach(entry => expectedFiles.add(entry.name));
    }
    const expectedDirectories = new Set<string>();
    expectedFiles.forEach((path) => {
        const segments = path.split('/');
        for (let index = 1; index < segments.length; index += 1) {
            expectedDirectories.add(`${segments.slice(0, index).join('/')}/`);
        }
    });
    zip.entries.forEach((entry) => {
        const specializedV4Sidecar = isV4Metadata(metadata)
            && (
                entry.name.startsWith(EDITORIAL_TRANSCRIPT_DIRECTORY)
                || entry.name.startsWith('editorial-coverage/')
                || entry.name.startsWith('editorial-chunks/')
            );
        const expected = specializedV4Sidecar || (entry.directory
            ? expectedDirectories.has(entry.name)
            : expectedFiles.has(entry.name));
        if (!expected) {
            throw new Error('Invalid .waptions file: archive contains an undeclared entry.');
        }
    });
}

function isSerializedProject(value: unknown): value is SerializedProject {
    if (!isRecord(value)
        || typeof value.id !== 'string'
        || typeof value.name !== 'string'
        || !value.name.trim()
        || typeof value.createdAt !== 'string'
        || Number.isNaN(Date.parse(value.createdAt))
        || typeof value.updatedAt !== 'string'
        || Number.isNaN(Date.parse(value.updatedAt))) return false;
    if (value.thumbnail !== undefined && typeof value.thumbnail !== 'string') return false;
    return value.duration === undefined
        || (typeof value.duration === 'number' && Number.isFinite(value.duration) && value.duration >= 0);
}

function isTypedSourceMapValue(value: unknown): value is ProjectBundleMetadataV4['sourceFiles'] {
    return isRecord(value)
        && hasOnlyKeys(value, TYPED_SOURCE_MAP_KEYS)
        && isStringRecord(value.video)
        && isStringRecord(value.audio);
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function assertTypedSourceMaps(
    sourceFiles: ProjectBundleMetadataV4['sourceFiles'],
    videoDescriptors: readonly { id: string }[],
    audioDescriptors: readonly { id: string }[],
    versionLabel: string,
): void {
    assertDeclaredSourceMap(sourceFiles.video, videoDescriptors, `sources/video/`, `${versionLabel} video`);
    assertDeclaredSourceMap(sourceFiles.audio, audioDescriptors, `sources/audio/`, `${versionLabel} audio`);
    const paths = [...Object.values(sourceFiles.video), ...Object.values(sourceFiles.audio)];
    if (new Set(paths).size !== paths.length) {
        throw new Error(`Invalid ${versionLabel} bundle source map: duplicate source path.`);
    }
}

function assertSourceDigestMaps(
    sourceDigests: ProjectBundleMetadataV4['sourceDigests'],
    videoDescriptors: readonly { id: string }[],
    audioDescriptors: readonly { id: string }[],
): void {
    if (!sourceDigests) return;
    assertDigestMap(sourceDigests.video, videoDescriptors, 'V4 video');
    assertDigestMap(sourceDigests.audio, audioDescriptors, 'V4 audio');
}

function assertDigestMap(
    digests: Record<string, string>,
    descriptors: readonly { id: string }[],
    label: string,
): void {
    const expectedIds = new Set(descriptors.map(descriptor => descriptor.id));
    const actualIds = Object.keys(digests);
    if (actualIds.length !== expectedIds.size
        || actualIds.some(id => !expectedIds.has(id) || !isSha256Digest(digests[id]))) {
        throw new Error(`Invalid ${label} bundle source digest map.`);
    }
}

function assertLegacySourceMap(
    sourceFiles: Record<string, string>,
    descriptors: readonly { id: string }[],
    versionLabel: string,
): void {
    assertDeclaredSourceMap(sourceFiles, descriptors, 'sources/', versionLabel);
}

function assertDeclaredSourceMap(
    sourceFiles: Record<string, string>,
    descriptors: readonly { id: string }[],
    requiredPrefix: string,
    label: string,
): void {
    const expectedIds = new Set(descriptors.map((descriptor) => descriptor.id));
    const actualIds = Object.keys(sourceFiles);
    if (actualIds.length !== expectedIds.size
        || actualIds.some((id) => !expectedIds.has(id))) {
        throw new Error(`Invalid ${label} bundle source map: descriptor declarations do not match.`);
    }
    const paths = actualIds.map((id) => sourceFiles[id]);
    if (paths.some((path) => !isSafeDeclaredFilePath(path) || !path.startsWith(requiredPrefix))) {
        throw new Error(`Invalid ${label} bundle source map: source path is unsafe.`);
    }
    if (new Set(paths).size !== paths.length) {
        throw new Error(`Invalid ${label} bundle source map: duplicate source path.`);
    }
}

function assertV2ManifestSourceShape(manifest: EditorManifestV2): void {
    if (!Array.isArray(manifest.sourceDescriptors)
        || !Array.isArray(manifest.tracks)
        || !Array.isArray(manifest.videoClips)
        || !isRecord(manifest.transcriptionByTrackId)) {
        throw new Error('Invalid V2 bundle editor manifest.');
    }
}

function assertValidManifestV4(manifest: unknown, label: string): asserts manifest is EditorManifestV4 {
    const validation = validateEditorManifestV4(manifest);
    if (!validation.valid) throwValidationError(label, validation.issues);
}

function throwValidationError(
    label: string,
    issues: readonly { path: string; message: string }[],
): never {
    const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new Error(`Invalid ${label}: ${details}`);
}

function parseMajorVersion(version: string): number {
    if (!/^\d+(?:\.\d+)*$/.test(version)) throw new Error(`Invalid project bundle version "${version}".`);
    const major = Number(version.split('.')[0]);
    if (!Number.isSafeInteger(major)) throw new Error(`Invalid project bundle version "${version}".`);
    return major;
}

function isV4Metadata(metadata: ProjectBundleMetadata): metadata is ProjectBundleMetadataV4 {
    return metadata.version === '4.0' && 'editorialTranscriptFiles' in metadata;
}

function isV3Metadata(metadata: ProjectBundleMetadata): metadata is ProjectBundleMetadataV3 {
    return metadata.version === '3.0' && 'editorManifest' in metadata;
}

function isV2Metadata(metadata: ProjectBundleMetadata): metadata is ProjectBundleMetadataV2 {
    return metadata.version === '2.0' && 'editorManifest' in metadata;
}

function editorialTranscriptPath(recordId: Sha256Digest): string {
    return `${EDITORIAL_TRANSCRIPT_DIRECTORY}${recordId.slice('sha256:'.length)}.json`;
}

function editorialCoveragePath(recordId: Sha256Digest): string {
    return `editorial-coverage/${recordId.slice('sha256:'.length)}.json`;
}

function editorialChunkPath(recordId: Sha256Digest): string {
    return `editorial-chunks/${recordId.slice('sha256:'.length)}.json`;
}

function sourcePath(kind: 'video' | 'audio', id: string, filename: string): string {
    return `sources/${kind}/${id}${getExtension(filename)}`;
}

function getExtension(filename: string): string {
    const parts = filename.split('.');
    const candidate = parts.length > 1 ? `.${parts.pop()}` : '';
    // File names are metadata, never archive paths. Restricting the optional extension prevents a
    // slash or traversal token in a crafted File name from changing the source entry location.
    return /^\.[A-Za-z0-9]{1,10}$/.test(candidate) ? candidate : '';
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

function isSafeDeclaredFilePath(path: string): boolean {
    return path.length > 0
        && !path.startsWith('/')
        && !path.endsWith('/')
        && !path.includes('\\')
        && !path.includes('\0')
        && path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
    const keys = Object.keys(value);
    return keys.length <= allowed.size && keys.every(key => allowed.has(key));
}

function assertOnlyObjectKeys(
    value: unknown,
    allowed: ReadonlySet<string>,
    label: string,
): asserts value is Record<string, unknown> {
    if (!isRecord(value) || !hasOnlyKeys(value, allowed)) {
        throw new Error(`Invalid ${label}: contains unsupported fields.`);
    }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}
