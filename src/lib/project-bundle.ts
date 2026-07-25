import JSZip from 'jszip';
import type { TProject } from '@/types/project';
import type { Subtitle, SubtitleTrack } from '@/types/timeline';
import {
    isSha256Digest,
    type EditorialTranscriptDescriptorV1,
    type ResolvedEditorialTranscriptMapV1,
    type Sha256Digest,
} from '@/types/editorial';
import type {
    EditorDocumentV4,
    EditorManifestV2,
    EditorManifestV3,
    EditorManifestV4,
    VideoSourceAssetV3,
} from '@/types/video';
import type { StylePreset } from '@/components/video-editor/subtitle-editor/types';
import { getStylePresets, saveStylePreset } from '@/components/video-editor/subtitle-editor/presetUtils';
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
import { storageService, type EditorPersistentAsset } from './storage/storage-service';
import {
    addBoundedZipEntryBytes,
    assertSafeProjectBundleEntries,
    assertZipEntryExactSize,
    getDeclaredZipEntrySize,
    readBoundedZipUtf8,
} from './project-bundle-zip';

export const PROJECT_BUNDLE_VERSION = '4.0';
export const PROJECT_BUNDLE_METADATA_MAX_BYTES = 4 * 1024 * 1024;
export const PROJECT_BUNDLE_TRANSCRIPT_MAX_RECORD_BYTES = 64 * 1024 * 1024;
export const PROJECT_BUNDLE_TRANSCRIPT_MAX_AGGREGATE_BYTES = 256 * 1024 * 1024;
const PROJECT_BUNDLE_MAX_ENTRIES = 8_192;
const IMPORT_PIN_GENERATION = 0;
const EDITORIAL_TRANSCRIPT_DIRECTORY = 'editorial-transcripts/';
const V4_METADATA_KEYS = new Set([
    'version',
    'project',
    'editorManifest',
    'sourceFiles',
    'editorialTranscriptFiles',
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
    /** One unique canonical sidecar path for every record ID described by the current manifest. */
    editorialTranscriptFiles: Record<Sha256Digest, string>;
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
    recordIds: Sha256Digest[];
}

/**
 * Exports only the current descriptor-only V4 graph, typed source Files, and verified canonical
 * transcript bodies referenced by that graph. Local history, request indexes, pin state, derived
 * PCM/cache data, endpoint preferences, and credentials are never queried and therefore cannot
 * enter the archive accidentally.
 */
export async function exportProjectBundle(projectId: string): Promise<Blob> {
    const [project, document] = await Promise.all([
        storageService.loadProject(projectId),
        storageService.loadEditorDocument(projectId, { targetVersion: 4 }),
    ]);
    if (!project) throw new Error('Project not found.');
    if (!document) throw new Error('The project has no durable editor document.');

    const manifest = createEditorManifestV4(document);
    const transcriptRepository = new EditorialTranscriptRepository();
    const transcriptRecords = await resolveCurrentTranscriptRecords(
        document,
        manifest.editorialTranscriptDescriptors,
        transcriptRepository,
    );
    const zip = new JSZip();
    const sourceFiles: ProjectBundleMetadataV4['sourceFiles'] = { video: {}, audio: {} };
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

    const editorialTranscriptFiles = {} as Record<Sha256Digest, string>;
    transcriptRecords.forEach((record) => {
        const path = editorialTranscriptPath(record.recordId);
        editorialTranscriptFiles[record.recordId] = path;
        // `canonicalJson` is the exact byte-domain string used to compute recordId. Pretty
        // printing or adding a newline here would make a nominally valid sidecar non-canonical.
        zip.file(path, record.canonicalJson);
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
        editorialTranscriptFiles,
        presets: getStylePresets().filter((preset) => !preset.isDefault),
    };
    const metadataJson = JSON.stringify(metadata, null, 2);
    if (new TextEncoder().encode(metadataJson).byteLength > PROJECT_BUNDLE_METADATA_MAX_BYTES) {
        throw new Error('Project bundle metadata exceeds the supported byte limit.');
    }
    zip.file('metadata.json', metadataJson);
    if (Object.keys(zip.files).length > PROJECT_BUNDLE_MAX_ENTRIES) {
        throw new Error('Project bundle contains too many source or transcript entries.');
    }
    return zip.generateAsync({ type: 'blob' });
}

export async function peekProjectBundle(blob: Blob): Promise<ProjectBundleMetadata> {
    const zip = await loadProjectBundleZip(blob);
    return readMetadata(zip);
}

/**
 * Builds and validates the entire import before committing any project reference. Canonical CAS
 * records are immutable cache candidates, so a failed import retains successfully verified bytes
 * while releasing only its own pending project generation. The temporary project database and
 * dashboard index are both removed before the original failure is returned.
 */
export async function importProjectBundle(blob: Blob): Promise<{ projectId: string; versionMismatch: boolean }> {
    const zip = await loadProjectBundleZip(blob);
    const metadata = await readMetadata(zip);
    const newProjectId = crypto.randomUUID();
    const importedProject = createImportedProject(metadata, newProjectId);
    const prepared = await prepareProjectImport(zip, metadata);
    const transcriptRepository = new EditorialTranscriptRepository();
    let pendingPinsOwned = false;

    try {
        // Imported bodies are verified again by the repository write boundary. Existing equal
        // bytes are an idempotent dedupe; conflicting bytes under one hash fail without overwrite.
        for (const record of prepared.transcriptRecords) {
            await transcriptRepository.putRecord(record);
        }
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
        }
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
        ]);
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

async function prepareProjectImport(
    zip: JSZip,
    metadata: ProjectBundleMetadata,
): Promise<PreparedProjectImport> {
    if (isV4Metadata(metadata)) return prepareV4Import(zip, metadata);
    if (isV3Metadata(metadata)) return prepareV3Import(zip, metadata);
    if (isV2Metadata(metadata)) return prepareV2Import(zip, metadata);
    return prepareV1Import(zip, metadata);
}

async function prepareV4Import(
    zip: JSZip,
    metadata: ProjectBundleMetadataV4,
): Promise<PreparedProjectImport> {
    assertValidManifestV4(metadata.editorManifest, 'bundle V4 manifest');
    assertTypedSourceMaps(
        metadata.sourceFiles,
        metadata.editorManifest.videoSourceDescriptors,
        metadata.editorManifest.audioSourceDescriptors,
        'V4',
    );
    const videoSources = await Promise.all(metadata.editorManifest.videoSourceDescriptors.map((descriptor) => (
        restoreSourceFile(zip, metadata.sourceFiles.video[descriptor.id], descriptor)
    )));
    const audioSources = await Promise.all(metadata.editorManifest.audioSourceDescriptors.map((descriptor) => (
        restoreSourceFile(zip, metadata.sourceFiles.audio[descriptor.id], descriptor)
    )));
    const document = hydrateEditorDocumentV4(metadata.editorManifest, videoSources, audioSources);
    const transcriptRecords = await readAndValidateTranscriptSidecars(zip, metadata, document);
    return {
        manifest: createEditorManifestV4(document),
        sourceAssets: persistentAssets(videoSources, audioSources),
        transcriptRecords,
        recordIds: transcriptRecords.map((record) => record.recordId),
    };
}

async function prepareV3Import(
    zip: JSZip,
    metadata: ProjectBundleMetadataV3,
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
    const videoSources = await Promise.all(normalizedManifest.videoSourceDescriptors.map((descriptor) => (
        restoreSourceFile(zip, metadata.sourceFiles.video[descriptor.id], descriptor)
    )));
    const audioSources = await Promise.all(normalizedManifest.audioSourceDescriptors.map((descriptor) => (
        restoreSourceFile(zip, metadata.sourceFiles.audio[descriptor.id], descriptor)
    )));
    // The existing reader establishes a valid hydrated V3 graph first; the one authoritative pure
    // migration then supplies explicit V4 placement and subtitle response policy.
    const v3Document = hydrateEditorDocumentV3(normalizedManifest, videoSources, audioSources);
    const document = migrateEditorDocumentV3ToV4(v3Document);
    return {
        manifest: createEditorManifestV4(document),
        sourceAssets: persistentAssets(videoSources, audioSources),
        transcriptRecords: [],
        recordIds: [],
    };
}

async function prepareV2Import(
    zip: JSZip,
    metadata: ProjectBundleMetadataV2,
): Promise<PreparedProjectImport> {
    assertV2ManifestSourceShape(metadata.editorManifest);
    assertLegacySourceMap(metadata.sourceFiles, metadata.editorManifest.sourceDescriptors, 'V2');
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
    if (!validation.valid) throwValidationError('bundle V2 editor document', validation.issues);
    const document = migrateEditorDocumentV2ToV4({
        manifest: metadata.editorManifest,
        loadedVideoSources: videoSources,
    });
    return {
        manifest: createEditorManifestV4(document),
        sourceAssets: persistentAssets(videoSources, []),
        transcriptRecords: [],
        recordIds: [],
    };
}

async function prepareV1Import(
    zip: JSZip,
    metadata: ProjectBundleMetadataV1,
): Promise<PreparedProjectImport> {
    const videoEntry = zip.file(/^video\./)[0] ?? null;
    let source: VideoSourceAssetV3 | null = null;
    if (videoEntry) {
        const blob = await videoEntry.async('blob');
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
        recordIds: [],
    };
}

async function resolveCurrentTranscriptRecords(
    document: EditorDocumentV4,
    descriptors: readonly EditorialTranscriptDescriptorV1[],
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

async function readAndValidateTranscriptSidecars(
    zip: JSZip,
    metadata: ProjectBundleMetadataV4,
    document: EditorDocumentV4,
): Promise<CanonicalEditorialTranscriptRecordV1[]> {
    const descriptorsByRecordId = groupDescriptorsByRecordId(metadata.editorManifest.editorialTranscriptDescriptors);
    const declarations = validateTranscriptDeclarations(zip, metadata.editorialTranscriptFiles, descriptorsByRecordId);
    const resolvedBodies = {} as Record<Sha256Digest, ResolvedEditorialTranscriptMapV1[Sha256Digest]>;
    const records: CanonicalEditorialTranscriptRecordV1[] = [];
    for (const declaration of declarations) {
        const bounded = await readBoundedZipUtf8(
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

function validateTranscriptDeclarations(
    zip: JSZip,
    declarationMap: Record<Sha256Digest, string>,
    descriptorsByRecordId: Map<Sha256Digest, EditorialTranscriptDescriptorV1[]>,
): Array<{ recordId: Sha256Digest; path: string; entry: JSZip.JSZipObject }> {
    const entries = Object.entries(declarationMap);
    const declaredRecordIds = new Set<Sha256Digest>();
    const declaredPaths = new Set<string>();
    const declarations: Array<{ recordId: Sha256Digest; path: string; entry: JSZip.JSZipObject }> = [];
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
        const entry = zip.files[path];
        if (!entry || entry.dir) {
            throw new Error('Invalid bundle transcript declaration: required sidecar is missing.');
        }
        aggregateBytes = addTranscriptSidecarBytes(aggregateBytes, getDeclaredZipEntrySize(entry));
        declaredRecordIds.add(recordId);
        declaredPaths.add(path);
        declarations.push({ recordId, path, entry });
    }
    for (const recordId of Array.from(descriptorsByRecordId.keys())) {
        if (!declaredRecordIds.has(recordId)) {
            throw new Error('Invalid bundle transcript declaration: manifest descriptor has no sidecar.');
        }
    }
    Object.values(zip.files).forEach((entry) => {
        if (!entry.dir && entry.name.startsWith(EDITORIAL_TRANSCRIPT_DIRECTORY)
            && !declaredPaths.has(entry.name)) {
            throw new Error('Invalid bundle transcript declaration: undeclared transcript sidecar.');
        }
    });
    return declarations.sort((left, right) => left.recordId.localeCompare(right.recordId));
}

function groupDescriptorsByRecordId(
    descriptors: readonly EditorialTranscriptDescriptorV1[],
): Map<Sha256Digest, EditorialTranscriptDescriptorV1[]> {
    const grouped = new Map<Sha256Digest, EditorialTranscriptDescriptorV1[]>();
    descriptors.forEach((descriptor) => {
        const current = grouped.get(descriptor.recordId) ?? [];
        current.push(descriptor);
        grouped.set(descriptor.recordId, current);
    });
    return new Map(Array.from(grouped.entries()).sort(([left], [right]) => left.localeCompare(right)));
}

async function assertEditorialDescriptorRequestKey(
    descriptor: EditorialTranscriptDescriptorV1,
): Promise<void> {
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
    zip: JSZip,
    path: string | undefined,
    descriptor: T,
): Promise<T & { file: File }> {
    const entry = path ? zip.files[path] : null;
    if (!entry || entry.dir) throw new Error(`Bundle source file "${descriptor.id}" is missing.`);
    assertZipEntryExactSize(entry, descriptor.size, 'bundle source file');
    const blob = await entry.async('blob');
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

async function loadProjectBundleZip(blob: Blob): Promise<JSZip> {
    // ArrayBuffer is supported consistently by JSZip in browsers and in the Node-based unit
    // environment. Browser Blob handling ultimately performs the same whole compressed-archive
    // read before central-directory parsing, so normalizing here does not decompress any entry.
    const input = typeof Blob !== 'undefined' && blob instanceof Blob
        ? await blob.arrayBuffer()
        : blob;
    const zip = await JSZip.loadAsync(input);
    assertSafeProjectBundleEntries(zip, PROJECT_BUNDLE_MAX_ENTRIES);
    return zip;
}

async function readMetadata(zip: JSZip): Promise<ProjectBundleMetadata> {
    const metadataFile = zip.files['metadata.json'];
    if (!metadataFile || metadataFile.dir) throw new Error('Invalid .waptions file: missing metadata.');
    const bounded = await readBoundedZipUtf8(
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
        && isStringRecord(value.editorialTranscriptFiles);
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}
