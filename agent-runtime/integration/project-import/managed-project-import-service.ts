import {
    assertEditorialDescriptorMatchesBody,
    createEditorialTranscriptRequestKey,
} from '../../../src/lib/editorial-transcription/identity';
import { verifyCanonicalEditorialTranscriptRecord } from '../../../src/lib/editorial-transcription/transcript-body';
import { validateEditorManifestV4 } from '../../../src/lib/editor-document-v4';
import { migrateEditorManifestV3ToV4 } from '../../../src/lib/editor-document-v4-migration';
import type { EditorManifestV3, EditorManifestV4 } from '../../../src/types/video';
import type { JsonObject, ScopedMutationToolCall } from '../../mcp/contracts';
import {
    DEFAULT_MANAGED_PROJECT_IMPORT_LIMITS,
    type ManagedProjectImportDelegatedHandler,
    type ManagedProjectImportDetachedTranscript,
    type ManagedProjectImportLimits,
    type ManagedProjectImportMedia,
    type ManagedProjectImportReadLease,
    type ManagedProjectImportServiceDependencies,
    type PreparedManagedProjectImport,
} from './contracts';
import { ManagedProjectImportZip } from './managed-zip-reader';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const V4_KEYS = new Set([
    'version', 'project', 'editorManifest', 'sourceFiles', 'sourceDigests',
    'editorialTranscriptFiles', 'editorialCoverageFiles', 'editorialChunkFiles', 'presets',
]);
const V3_KEYS = new Set(['version', 'project', 'editorManifest', 'sourceFiles', 'presets']);
const V2_KEYS = new Set(['version', 'project', 'editorManifest', 'sourceFiles', 'presets']);
const V1_KEYS = new Set(['version', 'project', 'timeline', 'presets']);
const PROJECT_KEYS = new Set(['id', 'name', 'thumbnail', 'duration', 'createdAt', 'updatedAt']);
const COVERAGE_KEYS = new Set([
    'version', 'recordId', 'sourceFingerprint', 'sourceSampleRate', 'sourceSampleCount',
    'acquisitionProfileDigest', 'endpointIdentityDigest', 'contextSamples', 'requestedModel',
    'responseSchema', 'pcmAlgorithmVersion', 'providerProfileVersion', 'language', 'speakerMode',
    'mergeAlgorithmVersion', 'coreCoverage', 'acquisitionWindows', 'mergedTranscriptRecordId',
]);
const CHUNK_KEYS = new Set([
    'version', 'recordId', 'sourceFingerprint', 'acquisitionProfileDigest', 'windowId', 'decoded', 'words',
]);
const privateEntryNames = new WeakMap<ManagedProjectImportMedia, string>();

/**
 * Validates every bundle byte before asking the injected coordinator boundary to publish it.
 * The service has no project-store access, so it cannot accidentally replace a live project or
 * bypass receipt-first persistence while it is being wired into production composition.
 */
export class ManagedProjectImportService {
    private readonly limits: ManagedProjectImportLimits;

    constructor(private readonly dependencies: ManagedProjectImportServiceDependencies) {
        this.limits = Object.freeze({
            ...DEFAULT_MANAGED_PROJECT_IMPORT_LIMITS,
            ...dependencies.limits,
        });
    }

    readonly handler: ManagedProjectImportDelegatedHandler = async (call, context) => {
        const scoped = scopedCall(call);
        if (scoped.toolName !== 'waptions_project_import') {
            throw new Error('Managed project import service received the wrong tool.');
        }
        // Receipt lookup intentionally precedes all grant/path work. A lost response therefore
        // replays even after the original read grant expired or was revoked.
        const replay = await this.dependencies.receipts.replay(scoped, context.signal);
        if (replay) return replay;

        const request = object(scoped.request, 'project import request');
        const source = object(request.source, 'project import source');
        const sessionId = string(request.sessionId, 'project import session ID');
        const sessionEpoch = string(request.sessionEpoch, 'project import session epoch');
        const kind = string(source.kind, 'project import source kind');
        if (kind === 'inline-manifest') {
            assertExactKeys(source, new Set(['kind', 'manifest']), 'inline project manifest source');
            const prepared = prepareInlineManifest(object(source.manifest, 'inline project manifest'));
            return this.dependencies.receipts.publishReceiptFirst({
                call: scoped,
                prepared,
                signal: context.signal,
            });
        }
        if (kind !== 'bundle-path' && kind !== 'manifest-path') {
            throw new Error('Project import source kind is unsupported.');
        }
        assertExactKeys(source, new Set(['kind', 'grantId', 'path']), 'project import path source');
        const lease = await this.dependencies.paths.openPath({
            grantId: string(source.grantId, 'project import grant ID'),
            path: string(source.path, 'project import path'),
            sessionId,
            sessionEpoch,
            signal: context.signal,
        });
        try {
            const prepared = kind === 'bundle-path'
                ? await this.prepareBundle(lease, context.signal)
                : await this.prepareManifestLease(lease, context.signal);
            await lease.assertCurrent(context.signal);
            return await this.dependencies.receipts.publishReceiptFirst({
                call: scoped,
                prepared,
                signal: context.signal,
            });
        } finally {
            await lease.close().catch(() => undefined);
        }
    };

    private async prepareBundle(
        lease: ManagedProjectImportReadLease,
        signal?: AbortSignal,
    ): Promise<PreparedManagedProjectImport> {
        const zip = await ManagedProjectImportZip.open(lease, this.limits, signal);
        const metadataBytes = await zip.readBytes('metadata.json', this.limits.maximumMetadataBytes, signal);
        const metadata = parseJson(metadataBytes, 'project bundle metadata');
        const version = string(metadata.version, 'project bundle version');
        switch (version) {
            case '4.0':
                return this.prepareV4(zip, metadata, signal);
            case '3.0':
                return this.prepareV3(zip, metadata, signal);
            case '2.0':
                return this.prepareLegacy(zip, metadata, 2, signal);
            case '1.0':
                return this.prepareLegacy(zip, metadata, 1, signal);
            default:
                throw new Error('Project bundle version is unsupported.');
        }
    }

    private async prepareManifestLease(
        lease: ManagedProjectImportReadLease,
        signal?: AbortSignal,
    ): Promise<PreparedManagedProjectImport> {
        if (lease.byteLength > this.limits.maximumMetadataBytes) {
            throw new Error('Managed project manifest exceeds its byte limit.');
        }
        const bytes = await readLeaseBytes(lease, lease.byteLength, this.limits, signal);
        return prepareInlineManifest(parseJson(bytes, 'managed project manifest'));
    }

    private async prepareV4(
        zip: ManagedProjectImportZip,
        metadata: JsonObject,
        signal?: AbortSignal,
    ): Promise<PreparedManagedProjectImport> {
        assertExactKeys(metadata, V4_KEYS, 'V4 project bundle metadata');
        const project = projectMetadata(metadata.project, 'V4 bundle project');
        const manifest = object(metadata.editorManifest, 'V4 editor manifest') as unknown as EditorManifestV4;
        const validation = validateEditorManifestV4(manifest);
        if (!validation.valid) throw new Error('V4 project bundle manifest is invalid.');
        const sourceFiles = typedSourceMaps(metadata.sourceFiles, 'V4 source files');
        const sourceDigests = metadata.sourceDigests === undefined
            ? undefined
            : typedDigestMaps(metadata.sourceDigests, 'V4 source digests');
        const media = await collectTypedMedia(zip, manifest, sourceFiles, sourceDigests, this.limits, signal);
        const transcripts = await collectTranscripts(zip, metadata, manifest, this.limits, signal);
        const rangeRecords = await collectRangeRecords(zip, metadata, manifest, this.limits, signal);
        assertDeclaredEntries(zip, new Set([
            'metadata.json',
            ...Object.values(sourceFiles.video),
            ...Object.values(sourceFiles.audio),
            ...objectValues(object(metadata.editorialTranscriptFiles, 'V4 transcript declarations')),
            ...optionalObjectValues(metadata.editorialCoverageFiles, 'V4 coverage declarations'),
            ...optionalObjectValues(metadata.editorialChunkFiles, 'V4 chunk declarations'),
        ]));
        return Object.freeze({
            formatVersion: 4,
            project: structuredClone(project),
            manifest: structuredClone(manifest),
            media: Object.freeze(media),
            transcripts: Object.freeze(transcripts),
            rangeRecords: Object.freeze(rangeRecords),
        });
    }

    private async prepareV3(
        zip: ManagedProjectImportZip,
        metadata: JsonObject,
        signal?: AbortSignal,
    ): Promise<PreparedManagedProjectImport> {
        assertExactKeys(metadata, V3_KEYS, 'V3 project bundle metadata');
        const project = projectMetadata(metadata.project, 'V3 bundle project');
        const sourceFiles = typedSourceMaps(metadata.sourceFiles, 'V3 source files');
        let manifest: EditorManifestV4;
        try {
            manifest = migrateEditorManifestV3ToV4(
                object(metadata.editorManifest, 'V3 editor manifest') as unknown as EditorManifestV3,
            );
        } catch {
            throw new Error('V3 project bundle manifest is invalid.');
        }
        const media = await collectTypedMedia(zip, manifest, sourceFiles, undefined, this.limits, signal);
        assertDeclaredEntries(zip, new Set([
            'metadata.json', ...Object.values(sourceFiles.video), ...Object.values(sourceFiles.audio),
        ]));
        return Object.freeze({
            formatVersion: 3,
            project: structuredClone(project),
            manifest,
            media: Object.freeze(media),
            transcripts: Object.freeze([]),
            rangeRecords: Object.freeze([]),
        });
    }

    private async prepareLegacy(
        zip: ManagedProjectImportZip,
        metadata: JsonObject,
        formatVersion: 1 | 2,
        signal?: AbortSignal,
    ): Promise<PreparedManagedProjectImport> {
        assertExactKeys(metadata, formatVersion === 2 ? V2_KEYS : V1_KEYS, 'legacy project bundle metadata');
        if (!this.dependencies.legacy) {
            throw new Error('Legacy project bundle conversion is not configured.');
        }
        const media = formatVersion === 2
            ? await collectV2Media(zip, object(metadata.sourceFiles, 'V2 source files'), this.limits, signal)
            : await collectV1Media(zip, this.limits, signal);
        const declared = new Set(['metadata.json', ...media.map((media) => mediaEntryName(media))]);
        assertDeclaredEntries(zip, declared);
        const manifest = await this.dependencies.legacy.convert({
            formatVersion,
            metadata: sanitizedLegacyMetadata(metadata),
            media,
            signal,
        });
        const validation = validateEditorManifestV4(manifest);
        if (!validation.valid) throw new Error('Legacy project bundle conversion produced an invalid manifest.');
        return Object.freeze({
            formatVersion,
            project: projectMetadata(metadata.project, 'legacy bundle project'),
            manifest,
            media: Object.freeze(media),
            transcripts: Object.freeze([]),
            rangeRecords: Object.freeze([]),
        });
    }
}

export function createManagedProjectImportDelegatedService(
    dependencies: ManagedProjectImportServiceDependencies,
): ManagedProjectImportDelegatedHandler {
    return new ManagedProjectImportService(dependencies).handler;
}

function prepareInlineManifest(manifest: JsonObject): PreparedManagedProjectImport {
    const candidate = Object.hasOwn(manifest, 'editorManifest')
        ? object(manifest.editorManifest, 'managed project editor manifest')
        : manifest;
    const validation = validateEditorManifestV4(candidate);
    if (!validation.valid) throw new Error('Managed project manifest is invalid.');
    const project = Object.hasOwn(manifest, 'project')
        ? projectMetadata(manifest.project, 'managed project metadata')
        : {};
    return Object.freeze({
        formatVersion: 4,
        project: structuredClone(project),
        manifest: structuredClone(candidate as unknown as EditorManifestV4),
        media: Object.freeze([]),
        transcripts: Object.freeze([]),
        rangeRecords: Object.freeze([]),
    });
}

async function collectTypedMedia(
    zip: ManagedProjectImportZip,
    manifest: EditorManifestV4,
    sourceFiles: { video: Record<string, string>; audio: Record<string, string> },
    sourceDigests: { video: Record<string, `sha256:${string}`>; audio: Record<string, `sha256:${string}`> } | undefined,
    limits: ManagedProjectImportLimits,
    signal?: AbortSignal,
): Promise<ManagedProjectImportMedia[]> {
    const media: ManagedProjectImportMedia[] = [];
    for (const [kind, descriptors, paths, digests] of [
        ['video', manifest.videoSourceDescriptors, sourceFiles.video, sourceDigests?.video] as const,
        ['audio', manifest.audioSourceDescriptors, sourceFiles.audio, sourceDigests?.audio] as const,
    ]) {
        assertSameIds(paths, descriptors.map((descriptor) => descriptor.id), `${kind} source file declarations`);
        if (digests) assertSameIds(digests, descriptors.map((descriptor) => descriptor.id), `${kind} source digest declarations`);
        for (const descriptor of descriptors) {
            const entryName = paths[descriptor.id]!;
            assertCanonicalEntryName(entryName, `${kind} source declaration`);
            const entryBytes = zip.entrySize(entryName);
            if (entryBytes > limits.maximumEntryBytes) throw new Error('Project media entry exceeds its byte limit.');
            const digest = await zip.digest(entryName, signal);
            if (digests?.[descriptor.id] && digests[descriptor.id] !== digest) {
                throw new Error('Project media digest does not match its declaration.');
            }
            media.push(createMedia(zip, entryName, descriptor.id, kind, entryBytes, digest, descriptor as unknown as JsonObject));
        }
    }
    return media;
}

async function collectV2Media(
    zip: ManagedProjectImportZip,
    sourceFiles: JsonObject,
    limits: ManagedProjectImportLimits,
    signal?: AbortSignal,
): Promise<ManagedProjectImportMedia[]> {
    const media: ManagedProjectImportMedia[] = [];
    for (const [sourceId, value] of Object.entries(sourceFiles)) {
        const entryName = string(value, 'V2 source declaration');
        assertCanonicalEntryName(entryName, 'V2 source declaration');
        const byteLength = zip.entrySize(entryName);
        if (byteLength > limits.maximumEntryBytes) throw new Error('Legacy project media exceeds its byte limit.');
        media.push(createMedia(zip, entryName, sourceId, 'legacy-video', byteLength, await zip.digest(entryName, signal), {}));
    }
    return media;
}

async function collectV1Media(
    zip: ManagedProjectImportZip,
    limits: ManagedProjectImportLimits,
    signal?: AbortSignal,
): Promise<ManagedProjectImportMedia[]> {
    const entries = zip.entries().filter((entry) => /^video\.[A-Za-z0-9]{1,16}$/u.test(entry.name));
    if (entries.length > 1) throw new Error('Legacy project bundle contains multiple video bodies.');
    if (entries.length === 0) return [];
    const entry = entries[0]!;
    if (entry.byteLength > limits.maximumEntryBytes) throw new Error('Legacy project media exceeds its byte limit.');
    return [createMedia(zip, entry.name, 'legacy-video', 'legacy-video', entry.byteLength, await zip.digest(entry.name, signal), {})];
}

async function collectTranscripts(
    zip: ManagedProjectImportZip,
    metadata: JsonObject,
    manifest: EditorManifestV4,
    limits: ManagedProjectImportLimits,
    signal?: AbortSignal,
): Promise<ManagedProjectImportDetachedTranscript[]> {
    const declarations = stringRecord(metadata.editorialTranscriptFiles, 'V4 transcript declarations');
    const descriptors = new Map<string, typeof manifest.editorialTranscriptDescriptors>();
    for (const descriptor of manifest.editorialTranscriptDescriptors) {
        const same = descriptors.get(descriptor.recordId) ?? [];
        same.push(descriptor);
        descriptors.set(descriptor.recordId, same);
    }
    assertSameIds(declarations, Array.from(descriptors.keys()), 'V4 transcript declarations');
    let aggregate = 0;
    const transcripts: ManagedProjectImportDetachedTranscript[] = [];
    for (const [recordId, entryName] of Object.entries(declarations)) {
        if (!SHA256.test(recordId)) throw new Error('V4 transcript declaration has an invalid record ID.');
        assertCanonicalEntryName(entryName, 'V4 transcript declaration');
        const raw = await zip.readBytes(entryName, limits.maximumDetachedBodyBytes, signal);
        aggregate = addBounded(aggregate, raw.byteLength, limits.maximumAggregateDetachedBodyBytes);
        const parsed = parseJson(raw, 'editorial transcript sidecar');
        const record = await verifyCanonicalEditorialTranscriptRecord(parsed, recordId as `sha256:${string}`)
            .catch(() => { throw new Error('Editorial transcript sidecar is corrupt.'); });
        if (!equalBytes(record.canonicalBytes, raw)) {
            throw new Error('Editorial transcript sidecar is not canonical JSON.');
        }
        const recordDescriptors = descriptors.get(recordId) ?? [];
        for (const descriptor of recordDescriptors) {
            try {
                assertEditorialDescriptorMatchesBody(descriptor, record.body);
                const requestKey = await createEditorialTranscriptRequestKey({
                    sourceFingerprint: descriptor.sourceFingerprint,
                    sampleCount: descriptor.sampleCount,
                    language: descriptor.language,
                    speakerMode: descriptor.speakerMode,
                    endpointIdentityDigest: descriptor.endpointIdentityDigest,
                });
                if (requestKey !== descriptor.requestKey) throw new Error('request key mismatch');
            } catch {
                throw new Error('Editorial transcript sidecar provenance does not match its descriptor.');
            }
        }
        transcripts.push(Object.freeze({ record, descriptorIds: Object.freeze(recordDescriptors.map((descriptor) => descriptor.recordId)) }));
    }
    return transcripts;
}

async function collectRangeRecords(
    zip: ManagedProjectImportZip,
    metadata: JsonObject,
    manifest: EditorManifestV4,
    limits: ManagedProjectImportLimits,
    signal?: AbortSignal,
): Promise<JsonObject[]> {
    const coverageDeclarations = metadata.editorialCoverageFiles === undefined
        ? {} : stringRecord(metadata.editorialCoverageFiles, 'V4 coverage declarations');
    const chunkDeclarations = metadata.editorialChunkFiles === undefined
        ? {} : stringRecord(metadata.editorialChunkFiles, 'V4 chunk declarations');
    const descriptors = manifest.editorialTranscriptDescriptors.filter((descriptor) => descriptor.version === 2);
    const descriptorsByCoverage = new Map(descriptors.map((descriptor) => [descriptor.coverageRecordId, descriptor]));
    assertSameIds(coverageDeclarations, Array.from(descriptorsByCoverage.keys()), 'V4 coverage declarations');
    let aggregate = 0;
    const records: JsonObject[] = [];
    const expectedChunks = new Map<string, { sourceFingerprint: string; acquisitionProfileDigest: string }>();
    for (const [coverageId, entryName] of Object.entries(coverageDeclarations).sort(([left], [right]) => left.localeCompare(right))) {
        if (!SHA256.test(coverageId)) throw new Error('V4 coverage declaration has an invalid record ID.');
        assertCanonicalEntryName(entryName, 'V4 range declaration');
        const raw = await zip.readBytes(entryName, limits.maximumDetachedBodyBytes, signal);
        aggregate = addBounded(aggregate, raw.byteLength, limits.maximumAggregateDetachedBodyBytes);
        const coverage = parseJson(raw, 'editorial coverage sidecar');
        assertExactKeys(coverage, COVERAGE_KEYS, 'editorial coverage sidecar');
        const descriptor = descriptorsByCoverage.get(coverageId as `sha256:${string}`)!;
        if (string(coverage.recordId, 'coverage record ID') !== coverageId
            || string(coverage.mergedTranscriptRecordId, 'coverage transcript record ID') !== descriptor.recordId
            || string(coverage.sourceFingerprint, 'coverage source fingerprint') !== descriptor.sourceFingerprint
            || string(coverage.acquisitionProfileDigest, 'coverage acquisition profile digest') !== descriptor.acquisitionProfileDigest
            || string(coverage.endpointIdentityDigest, 'coverage endpoint identity digest') !== descriptor.endpointIdentityDigest) {
            throw new Error('Editorial coverage sidecar provenance does not match its descriptor.');
        }
        const windows = coverage.acquisitionWindows;
        if (!Array.isArray(windows)) throw new Error('Editorial coverage sidecar has invalid acquisition windows.');
        for (const window of windows) {
            const chunks = object(window, 'coverage acquisition window').chunkRecordIds;
            if (!Array.isArray(chunks)) throw new Error('Editorial coverage sidecar has invalid chunk references.');
            for (const chunkId of chunks) {
                const id = string(chunkId, 'coverage chunk record ID');
                const prior = expectedChunks.get(id);
                const expected = {
                    sourceFingerprint: descriptor.sourceFingerprint,
                    acquisitionProfileDigest: descriptor.acquisitionProfileDigest,
                };
                if (prior && (prior.sourceFingerprint !== expected.sourceFingerprint
                    || prior.acquisitionProfileDigest !== expected.acquisitionProfileDigest)) {
                    throw new Error('Editorial coverage sidecar reuses a chunk across incompatible sources.');
                }
                expectedChunks.set(id, expected);
            }
        }
        records.push(coverage);
    }
    assertSameIds(chunkDeclarations, Array.from(expectedChunks.keys()), 'V4 chunk declarations');
    for (const [chunkId, entryName] of Object.entries(chunkDeclarations).sort(([left], [right]) => left.localeCompare(right))) {
        assertCanonicalEntryName(entryName, 'V4 range declaration');
        const raw = await zip.readBytes(entryName, limits.maximumDetachedBodyBytes, signal);
        aggregate = addBounded(aggregate, raw.byteLength, limits.maximumAggregateDetachedBodyBytes);
        const chunk = parseJson(raw, 'editorial range chunk sidecar');
        assertExactKeys(chunk, CHUNK_KEYS, 'editorial range chunk sidecar');
        const expected = expectedChunks.get(chunkId)!;
        if (string(chunk.recordId, 'chunk record ID') !== chunkId
            || string(chunk.sourceFingerprint, 'chunk source fingerprint') !== expected.sourceFingerprint
            || string(chunk.acquisitionProfileDigest, 'chunk acquisition profile digest') !== expected.acquisitionProfileDigest) {
            throw new Error('Editorial range chunk provenance does not match its coverage record.');
        }
        records.push(chunk);
    }
    return records;
}

function createMedia(
    zip: ManagedProjectImportZip,
    entryName: string,
    sourceId: string,
    mediaKind: ManagedProjectImportMedia['mediaKind'],
    byteLength: number,
    contentDigest: `sha256:${string}`,
    descriptor: JsonObject,
): ManagedProjectImportMedia {
    // The archive entry name stays in this closure and is never serialized into the Core proposal.
    const media = Object.freeze({
        sourceId,
        mediaKind,
        byteLength,
        contentDigest,
        descriptor: structuredClone(descriptor),
        stream: (signal?: AbortSignal) => zip.stream(entryName, signal),
    });
    privateEntryNames.set(media, entryName);
    return media;
}

function assertDeclaredEntries(zip: ManagedProjectImportZip, expected: ReadonlySet<string>): void {
    const actual = zip.entries().map((entry) => entry.name);
    if (actual.length !== expected.size || actual.some((entry) => !expected.has(entry))) {
        throw new Error('Project bundle contains undeclared or missing entries.');
    }
}

function typedSourceMaps(value: unknown, label: string): { video: Record<string, string>; audio: Record<string, string> } {
    const map = object(value, label);
    assertExactKeys(map, new Set(['video', 'audio']), label);
    return { video: stringRecord(map.video, `${label} video`), audio: stringRecord(map.audio, `${label} audio`) };
}

function typedDigestMaps(value: unknown, label: string): { video: Record<string, `sha256:${string}`>; audio: Record<string, `sha256:${string}`> } {
    const source = typedSourceMaps(value, label);
    const ensure = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([key, digest]) => {
        if (!SHA256.test(digest)) throw new Error(`${label} contains an invalid SHA-256 digest.`);
        return [key, digest as `sha256:${string}`];
    }));
    return { video: ensure(source.video), audio: ensure(source.audio) };
}

function scopedCall(call: object): ScopedMutationToolCall {
    const candidate = call as Partial<ScopedMutationToolCall>;
    if (candidate.mutation !== true || !candidate.receiptScope || !candidate.identity) {
        throw new Error('Managed project import requires an authenticated receipt scope.');
    }
    return candidate as ScopedMutationToolCall;
}

function object(value: unknown, label: string): JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
    return value as JsonObject;
}

function string(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value || value.length > 16_384 || value.includes('\0')) {
        throw new Error(`${label} is invalid.`);
    }
    return value;
}

function parseJson(bytes: Uint8Array, label: string): JsonObject {
    try {
        return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), label);
    } catch {
        throw new Error(`${label} is not valid UTF-8 JSON.`);
    }
}

function stringRecord(value: unknown, label: string): Record<string, string> {
    const record = object(value, label);
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [string(key, label), string(item, label)]));
}

function objectValues(value: JsonObject): string[] {
    return Object.values(stringRecord(value, 'project bundle declarations'));
}

function optionalObjectValues(value: unknown, label: string): string[] {
    return value === undefined ? [] : Object.values(stringRecord(value, label));
}

function assertExactKeys(value: JsonObject, expected: ReadonlySet<string>, label: string): void {
    if (Object.keys(value).some((key) => !expected.has(key))) throw new Error(`${label} has unsupported fields.`);
}

function projectMetadata(value: unknown, label: string): JsonObject {
    const project = object(value, label);
    assertExactKeys(project, PROJECT_KEYS, label);
    for (const field of Object.values(project)) {
        if (field !== null && typeof field !== 'string' && typeof field !== 'number') {
            throw new Error(`${label} contains a non-portable field.`);
        }
    }
    return structuredClone(project);
}

function sanitizedLegacyMetadata(metadata: JsonObject): JsonObject {
    const { sourceFiles: _sourceFiles, project, ...rest } = metadata;
    void _sourceFiles;
    return {
        ...structuredClone(rest),
        project: projectMetadata(project, 'legacy bundle project'),
    };
}

function assertSameIds(record: Record<string, unknown>, ids: readonly string[], label: string): void {
    const actual = Object.keys(record).sort();
    const expected = [...ids].sort();
    if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
        throw new Error(`${label} do not match their manifest descriptors.`);
    }
}

function assertCanonicalEntryName(name: string, label: string): void {
    if (!name || name !== name.normalize('NFC') || name.normalize('NFKC').toLocaleLowerCase('und') !== name.toLocaleLowerCase('und')) {
        throw new Error(`${label} contains a Unicode-conflicting path.`);
    }
}

function addBounded(total: number, added: number, maximum: number): number {
    const result = total + added;
    if (!Number.isSafeInteger(result) || result > maximum) throw new Error('Detached project bodies exceed their aggregate byte limit.');
    return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function readLeaseBytes(
    lease: ManagedProjectImportReadLease,
    length: number,
    limits: ManagedProjectImportLimits,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0 || length > limits.maximumMetadataBytes) {
        throw new Error('Managed project manifest exceeds its byte limit.');
    }
    const output = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += limits.maximumReadChunkBytes) {
        if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        const size = Math.min(limits.maximumReadChunkBytes, length - offset);
        output.set(await lease.read(offset, size, signal), offset);
    }
    await lease.assertCurrent(signal);
    return output;
}

function mediaEntryName(media: ManagedProjectImportMedia): string {
    const entryName = privateEntryNames.get(media);
    if (!entryName) throw new Error('Managed project media has no private archive entry.');
    return entryName;
}
