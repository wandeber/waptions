import { createHash } from 'node:crypto';
import type { EditorManifestV4 } from '../../../src/types/video';
import type { HeadlessRenderSnapshotV1 } from '../../../src/lib/render-plan';
import type { ArtifactRegistry } from '../../artifacts/artifact-registry';
import { NodeFfprobeMp4Verifier } from '../../export/node-ffprobe-verifier';
import type { DurableJobScheduler } from '../../jobs/durable-job-scheduler';
import type { ManagedCoordinator } from '../../coordinator/managed-coordinator';
import { managedError } from '../../coordinator/errors';
import {
    FfmpegResolvedPlanRenderBackend,
} from '../../render/ffmpeg-backend';
import {
    NodeFfmpegResolvedPlanExecutor,
} from '../../render/node-ffmpeg-resolved-plan-executor';
import {
    HeadlessRenderError,
    type HeadlessRenderBackendPort,
} from '../../render/contracts';
import {
    NodeBoundedChromiumWorkerHostPort,
} from '../../render/node-bounded-chromium-worker-host';
import { canonicalDigest, canonicalJson } from '../../persistence/canonical-json';
import type { DurableReceipt } from '../../persistence/managed-filesystem-store';
import type { CanonicalToolCall, CoordinatorResult, JsonObject } from '../../mcp/contracts';
import type { ManagedMutationEnvelope } from '../../coordinator/types';
import type {
    ManagedCoreCommand,
    ManagedCoreEditorState,
    ManagedCoreResult,
} from '../core-editor-port';
import { projectJobRecord } from '../canonical-projections';
import {
    type ManagedExportKind,
    type ManagedExportMaterial,
    type ManagedExportRequest,
    type ManagedReferenceSourceV1,
    type ManagedStreamingEntry,
} from '../export/contracts';
import {
    createManagedExportDurableJobInput,
    registerManagedExportDurableJobHandlers,
} from '../export/durable-export-job-handler';
import { ExactCompositionRenderRouter } from '../export/exact-render-router';
import { ProductionManagedExportJobService } from '../export/managed-export-job-service';
import { NodeFfmpegWebmRenderPort } from '../export/node-webm-renderer';
import type { PathGrantOutputAuthority } from '../export/path-grant-output-authority';
import { ManagedRenderSourceAdapter } from '../export/render-source-adapter';
import type { PathGrantMediaAdapter } from '../media/path-grant-media-adapter';
import type { ManagedMediaCatalogRecord } from '../media/contracts';
import type { ProductionResourceBudget } from './resource-budget';
import { PrivateMp4ScratchAuthority } from './private-mp4-scratch';
import type { ProductionTranscriptionRuntime } from './transcription-runtime';

type ProductionCoordinator = ManagedCoordinator<
    ManagedCoreEditorState,
    ManagedCoreCommand,
    ManagedCoreResult
>;

export interface ProductionExportRuntime {
    registerJobHandlers(scheduler: DurableJobScheduler): void;
    start(call: CanonicalToolCall): Promise<CoordinatorResult>;
    close(): Promise<void>;
}

export function createProductionExportRuntime(input: {
    coordinator: ProductionCoordinator;
    media: PathGrantMediaAdapter;
    outputs: PathGrantOutputAuthority;
    budget: ProductionResourceBudget;
    dataRoot: string;
    transcription: ProductionTranscriptionRuntime;
}): ProductionExportRuntime {
    const renderSources = new ManagedRenderSourceAdapter(input.media);
    const ffmpegExecutor = new NodeFfmpegResolvedPlanExecutor(
        renderSources,
        input.outputs,
        { ffmpegExecutable: 'ffmpeg', ffprobeExecutable: 'ffprobe' },
    );
    const ffmpeg = new FfmpegResolvedPlanRenderBackend(
        ffmpegExecutor,
        input.budget,
        renderSources,
    );
    const chromiumHost = new NodeBoundedChromiumWorkerHostPort(input.outputs, {
        ffmpegExecutable: 'ffmpeg',
    });
    const chromium: HeadlessRenderBackendPort = {
        name: 'chromium-webcodecs',
        probe: async (_plan, signal) => {
            const capability = await chromiumHost.probe(signal);
            return {
                supported: false,
                backend: 'chromium-webcodecs',
                resolvedPlanVersion: 1,
                container: 'mp4',
                videoCodec: 'h264',
                audioCodec: 'aac',
                reason: capability.reason
                    ?? 'The packaged runtime has no canonical Node subtitle compositor.',
            };
        },
        render: async () => {
            throw new HeadlessRenderError(
                'CODEC_UNAVAILABLE',
                'Exact subtitle composition requires the canonical browser compositor.',
            );
        },
    };
    const renderer = new ExactCompositionRenderRouter(ffmpeg, chromium);
    const verifier = new NodeFfprobeMp4Verifier(input.outputs, {
        ffprobeExecutable: 'ffprobe',
    });
    const scratchBackendRef: { current?: HeadlessRenderBackendPort } = {};
    const scratch = new PrivateMp4ScratchAuthority(
        join(input.dataRoot, 'coordinator', 'export-scratch'),
        () => {
            if (!scratchBackendRef.current) {
                throw new Error('The private scratch renderer is not initialized.');
            }
            return scratchBackendRef.current;
        },
    );
    const scratchExecutor = new NodeFfmpegResolvedPlanExecutor(
        renderSources,
        scratch,
        { ffmpegExecutable: 'ffmpeg', ffprobeExecutable: 'ffprobe' },
    );
    const scratchBackend = new FfmpegResolvedPlanRenderBackend(
        scratchExecutor,
        input.budget,
        renderSources,
    );
    scratchBackendRef.current = scratchBackend;
    const webm = new NodeFfmpegWebmRenderPort(
        scratch,
        input.outputs,
        { ffmpegExecutable: 'ffmpeg', ffprobeExecutable: 'ffprobe' },
    );
    const service = new ProductionManagedExportJobService(
        input.outputs,
        input.coordinator.artifacts,
        renderer,
        verifier,
        webm,
    );

    return {
        registerJobHandlers: (scheduler) => {
            registerManagedExportDurableJobHandlers(scheduler, {
                service,
                materials: {
                    resolveMaterial: async (job) => {
                        const current = input.coordinator.getProject(
                            job.projectId,
                        );
                        if (
                            current.state.sessionRevision
                                !== job.capturedState.sessionRevision
                            || current.state.documentRevision
                                !== job.capturedState.documentRevision
                            || current.state.audioGraphRevision
                                !== job.capturedState.audioGraphRevision
                        ) {
                            throw managedError(
                                'SESSION_REVISION_CONFLICT',
                                'The project changed before the durable export ran.',
                                true,
                            );
                        }
                        if (
                            !input.outputs.hasDestination(
                                job.destination.stagingHandleId,
                            )
                        ) {
                            const staged =
                                await input.coordinator.pathGrants.stageCreate(
                                    job.destination.grantId,
                                    {
                                        sessionId:
                                            current.envelope.sessionId,
                                        sessionEpoch:
                                            current.state.sessionEpoch,
                                    },
                                );
                            input.outputs.register(job.destination, staged);
                        }
                        return createExportMaterial(
                            input.coordinator,
                            input.media,
                            job.projectId,
                            exportKindForJob(job.kind),
                            input.coordinator.artifacts,
                            input.transcription,
                        );
                    },
                },
            });
        },
        start: async (call) => {
            const projectId = input.coordinator.resolveProjectId(
                requiredString(call.request, 'sessionId'),
            );
            const exportKind = requiredString(call.request, 'exportKind') as ManagedExportKind;
            if (!exportKinds().includes(exportKind)) {
                throw managedError('INVALID_REQUEST', 'The export kind is unsupported.');
            }
            const destination = requiredObject(call.request, 'destination') as unknown as
                ManagedExportRequest['destination'];
            const jobId = `export:${call.requestHash.slice(7, 31)}`;
            const project = input.coordinator.getProject(projectId);
            const jobKind = `export:${exportKind}` as const;
            const result = await input.coordinator.enqueueJob(
                projectId,
                managedRequest(call),
                {
                    jobId,
                    kind: jobKind,
                    input: createManagedExportDurableJobInput({
                        schemaVersion: 1,
                        kind: jobKind,
                        projectId,
                        jobId,
                        capturedState: project.state,
                        destination,
                        materialReference:
                            `export-material:${call.requestHash.slice(7, 39)}`,
                    }),
                    inputDigest: call.requestHash,
                    cancellable: true,
                    resumable: true,
                },
            );
            if (!result.ok) return result;
            return {
                ok: true,
                data: {
                    jobId: result.data.job.jobId,
                    job: projectJobRecord(result.data.job) as unknown as JsonObject,
                },
                state: result.state,
                committedState: result.committedState,
                warnings: [],
                replayed: result.replayed,
            };
        },
        close: () => scratch.close(),
    };
}

function exportKindForJob(
    kind: `export:${ManagedExportKind}`,
): ManagedExportKind {
    return kind.slice('export:'.length) as ManagedExportKind;
}

async function createExportMaterial(
    coordinator: ProductionCoordinator,
    media: PathGrantMediaAdapter,
    projectId: string,
    kind: ManagedExportKind,
    artifacts: ArtifactRegistry,
    transcription: ProductionTranscriptionRuntime,
): Promise<ManagedExportMaterial> {
    const project = coordinator.getProject(projectId);
    const manifest = project.envelope.editor.state.snapshot.manifest;
    const sources = referenceSources(project.envelope.sourceRegistry, manifest, media);
    if (kind === 'mp4-h264-aac' || kind === 'webm') {
        return { renderSnapshot: renderSnapshot(manifest, media) };
    }
    if (kind === 'portable-bundle') {
        const transcriptSidecars = await transcription.preparePortableBundleSidecars({
            projectId,
            manifest,
        });
        const sourceBundle = portableBundleSources(
            project.envelope.sourceRegistry,
            transcriptSidecars.manifest,
            media,
        );
        const metadata = {
            version: '4.0',
            project: {
                id: project.envelope.projectId,
                name: project.envelope.name,
                thumbnail: null,
                duration: 0,
                createdAt: project.envelope.createdAt,
                updatedAt: project.envelope.updatedAt,
            },
            editorManifest: transcriptSidecars.manifest,
            sourceFiles: sourceBundle.sourceFiles,
            sourceDigests: sourceBundle.sourceDigests,
            editorialTranscriptFiles: transcriptSidecars.editorialTranscriptFiles,
            editorialCoverageFiles: transcriptSidecars.editorialCoverageFiles,
            editorialChunkFiles: transcriptSidecars.editorialChunkFiles,
            presets: [],
        };
        const metadataBytes = Buffer.from(canonicalJson(metadata, 4 * 1024 * 1024));
        return {
            portableBundle: {
                entries: [
                    staticBundleEntry('metadata.json', metadataBytes, async () => {
                        const current = coordinator.getProject(projectId);
                        if (
                            canonicalDigest(
                                current.envelope.editor.state.snapshot.manifest,
                            ) !== canonicalDigest(manifest)
                        ) {
                            throw managedError(
                                'SESSION_REVISION_CONFLICT',
                                'The project changed during bundle export.',
                                true,
                            );
                        }
                    }),
                    ...sourceBundle.entries,
                    ...transcriptSidecars.entries,
                ],
            },
        };
    }
    if (kind === 'reference-snapshot') {
        return {
            referenceSnapshot: {
                schemaVersion: 1,
                apiVersion: '2026-07-25',
                runtimeVersion: 'managed-runtime-v1',
                schemaBundleDigest: canonicalDigest('2026-07-25') as `sha256:${string}`,
                state: project.state,
                manifestDigest: canonicalDigest(manifest) as `sha256:${string}`,
                manifest,
                sources,
                transcriptRecordIds:
                    project.envelope.editor.state.transcriptPins.durableRecordIds as
                        `sha256:${string}`[],
                historyEntryIds: project.envelope.editor.state.history.past.map(
                    (entry) => entry.summary.id,
                ),
            },
        };
    }
    const [artifactRecords, receipts] = await Promise.all([
        artifacts.list(projectId),
        coordinator.store.readNamespace<DurableReceipt>(projectId, 'receipts'),
    ]);
    return {
        proof: {
            schemaVersion: 1,
            runtimeVersion: 'managed-runtime-v1',
            pluginVersion: '2026-07-25',
            schemaBundleDigest: canonicalDigest('2026-07-25') as `sha256:${string}`,
            state: project.state,
            sources,
            operations: proofOperations(receipts),
            editSummary: {
                clips: manifest.videoClips.length,
                tracks: manifest.videoTracks.length + manifest.audioTracks.length,
                subtitleCues: manifest.subtitleTracks.reduce(
                    (count, track) => count + track.subtitles.length,
                    0,
                ),
            },
            undoRedoEvidence: {
                undoCount: project.envelope.editor.state.history.past.length,
                redoCount: project.envelope.editor.state.history.future.length,
            },
            reconnectEvidence: {
                recoveryCount: project.envelope.recoveryCount,
                restoredSources: project.envelope.sourceRegistry.length,
            },
            memoryCaps: {
                maximumDecodedBytes:
                    coordinator.decodedMemoryBudget.snapshot().limitBytes,
                peakDecodedBytes:
                    coordinator.decodedMemoryBudget.snapshot().peakBytes,
                artifacts: artifactRecords.length,
            },
        },
    };
}

const BUNDLE_MEDIA_CHUNK_BYTES = 1024 * 1024;

function portableBundleSources(
    registry: readonly {
        sourceId: string;
        byteLength: number;
        digest: string;
        releasedAt?: string;
    }[],
    manifest: EditorManifestV4,
    media: PathGrantMediaAdapter,
): {
    readonly entries: readonly ManagedStreamingEntry[];
    readonly sourceFiles: {
        readonly video: Record<string, string>;
        readonly audio: Record<string, string>;
    };
    readonly sourceDigests: {
        readonly video: Record<string, `sha256:${string}`>;
        readonly audio: Record<string, `sha256:${string}`>;
    };
} {
    const activeBySourceId = new Map(
        registry
            .filter((source) => source.releasedAt === undefined)
            .map((source) => [source.sourceId, source]),
    );
    const sourceFiles = {
        video: {} as Record<string, string>,
        audio: {} as Record<string, string>,
    };
    const sourceDigests = {
        video: {} as Record<string, `sha256:${string}`>,
        audio: {} as Record<string, `sha256:${string}`>,
    };
    const entries: ManagedStreamingEntry[] = [];
    const declared = new Set<string>();

    for (const [kind, descriptors] of [
        ['video', manifest.videoSourceDescriptors],
        ['audio', manifest.audioSourceDescriptors],
    ] as const) {
        for (const descriptor of descriptors) {
            if (declared.has(descriptor.id)) {
                throw managedError(
                    'INVALID_REQUEST',
                    'The portable bundle manifest reuses a source identifier.',
                );
            }
            declared.add(descriptor.id);
            const source = activeBySourceId.get(descriptor.id);
            const record = media.getBySourceId(descriptor.id);
            if (!source || !record || record.class !== kind) {
                throw managedError(
                    'SOURCE_CHANGED',
                    'A portable bundle source is no longer retained.',
                    true,
                );
            }
            if (
                source.byteLength !== record.registeredIdentity.byteLength
                || source.digest !== record.registeredIdentity.sha256
            ) {
                throw managedError(
                    'SOURCE_CHANGED',
                    'A portable bundle source identity no longer matches the project.',
                    true,
                );
            }
            const entryName = 'sources/' + kind + '/'
                + canonicalDigest({ sourceId: descriptor.id }).slice(7)
                + '.media';
            sourceFiles[kind][descriptor.id] = entryName;
            sourceDigests[kind][descriptor.id] = source.digest as `sha256:${string}`;
            entries.push(streamingMediaBundleEntry(
                entryName,
                source.digest as `sha256:${string}`,
                source.byteLength,
                record,
                media,
            ));
        }
    }
    return { entries, sourceFiles, sourceDigests };
}

function streamingMediaBundleEntry(
    name: string,
    digest: `sha256:${string}`,
    byteLength: number,
    record: ManagedMediaCatalogRecord,
    media: PathGrantMediaAdapter,
): ManagedStreamingEntry {
    return {
        name,
        byteLength,
        expectedDigest: digest,
        stream: (signal) => streamRetainedMedia(record, media, byteLength, digest, signal),
        revalidate: async (signal) => {
            const lease = await media.open(record.handle.handleId, signal);
            try {
                await lease.assertCurrent(signal);
                if (
                    lease.identity.byteLength !== byteLength
                    || lease.identity.sha256 !== digest
                ) {
                    throw managedError(
                        'SOURCE_CHANGED',
                        'A portable bundle source identity changed during export.',
                        true,
                    );
                }
            } finally {
                await lease.close();
            }
        },
    };
}

async function* streamRetainedMedia(
    record: ManagedMediaCatalogRecord,
    media: PathGrantMediaAdapter,
    byteLength: number,
    digest: `sha256:${string}`,
    signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
    const lease = await media.open(record.handle.handleId, signal);
    try {
        await lease.assertCurrent(signal);
        if (
            lease.identity.byteLength !== byteLength
            || lease.identity.sha256 !== digest
        ) {
            throw managedError(
                'SOURCE_CHANGED',
                'A portable bundle source identity changed during export.',
                true,
            );
        }
        for (let position = 0; position < byteLength;) {
            signal?.throwIfAborted();
            const chunk = Buffer.allocUnsafe(
                Math.min(BUNDLE_MEDIA_CHUNK_BYTES, byteLength - position),
            );
            const read = await lease.fileHandle.read(
                chunk,
                0,
                chunk.byteLength,
                position,
            );
            if (read.bytesRead !== chunk.byteLength) {
                throw managedError(
                    'SOURCE_CHANGED',
                    'A portable bundle source was truncated during export.',
                    true,
                );
            }
            position += read.bytesRead;
            yield chunk;
        }
        await lease.assertCurrent(signal);
    } finally {
        await lease.close();
    }
}

function staticBundleEntry(
    name: string,
    bytes: Uint8Array,
    revalidate?: (signal?: AbortSignal) => Promise<void>,
): ManagedStreamingEntry {
    const digest = sha256Bytes(bytes);
    return {
        name,
        byteLength: bytes.byteLength,
        expectedDigest: digest,
        stream: async function* () {
            yield* splitBundleBytes(bytes);
        },
        revalidate: async (signal) => revalidate?.(signal),
    };
}

function* splitBundleBytes(bytes: Uint8Array): Iterable<Uint8Array> {
    for (let offset = 0; offset < bytes.byteLength; offset += BUNDLE_MEDIA_CHUNK_BYTES) {
        yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + BUNDLE_MEDIA_CHUNK_BYTES));
    }
}

function sha256Bytes(bytes: Uint8Array): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function proofOperations(
    receipts: readonly DurableReceipt[],
): NonNullable<ManagedExportMaterial['proof']>['operations'] {
    return receipts
        .map((receipt) => ({
            toolName: receipt.toolName,
            idempotencyKey: receipt.idempotencyKey,
            requestDigest: receipt.canonicalRequestHash as `sha256:${string}`,
            resultingSessionRevision: receipt.committedSessionRevision,
            jobIds: receiptResultIdentifiers(receipt.result, [
                'jobId',
                'jobIds',
            ]),
            artifactIds: receiptResultIdentifiers(receipt.result, [
                'artifactId',
                'artifactIds',
                'resultArtifactIds',
            ]),
            createdAt: receipt.createdAt,
        }))
        .sort((left, right) => (
            left.createdAt.localeCompare(right.createdAt)
            || left.toolName.localeCompare(right.toolName)
            || left.idempotencyKey.localeCompare(right.idempotencyKey)
            || left.requestDigest.localeCompare(right.requestDigest)
        ))
        .map((value) => {
            const { createdAt, ...operation } = value;
            void createdAt;
            return operation;
        });
}

function receiptResultIdentifiers(
    value: unknown,
    fields: readonly string[],
): readonly string[] {
    const values = new Set<string>();
    const visit = (candidate: unknown, depth: number): void => {
        if (depth > 6 || !candidate || typeof candidate !== 'object') return;
        if (Array.isArray(candidate)) {
            candidate.slice(0, 512).forEach((item) => visit(item, depth + 1));
            return;
        }
        for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
            if (fields.includes(key)) {
                const identifiers = typeof item === 'string'
                    ? [item]
                    : Array.isArray(item) ? item : [];
                for (const identifier of identifiers) {
                    if (
                        typeof identifier === 'string'
                        && /^[A-Za-z0-9:_-]{1,512}$/u.test(identifier)
                    ) {
                        values.add(identifier);
                    }
                }
            }
            if (key === 'data' || key === 'job' || key === 'jobs' || key === 'result') {
                visit(item, depth + 1);
            }
        }
    };
    visit(value, 0);
    return Object.freeze([...values].sort());
}

function renderSnapshot(
    manifest: EditorManifestV4,
    media: PathGrantMediaAdapter,
): HeadlessRenderSnapshotV1 {
    const descriptors = [
        ...manifest.videoSourceDescriptors.map((descriptor) => ({
            descriptor,
            kind: 'video' as const,
        })),
        ...manifest.audioSourceDescriptors.map((descriptor) => ({
            descriptor,
            kind: 'audio' as const,
        })),
    ];
    return {
        version: 1,
        snapshotId: canonicalDigest(manifest),
        manifest: structuredClone(manifest),
        sourceIdentities: descriptors.map(({ descriptor, kind }) => {
            const record = media.getBySourceId(descriptor.id);
            if (!record) {
                throw managedError(
                    'SOURCE_CHANGED',
                    'A render source is unavailable from retained authority.',
                    true,
                );
            }
            return {
                sourceId: descriptor.id,
                kind,
                byteSourceCapabilityId: record.handle.capabilityId,
                fingerprint: descriptor.fingerprint,
                size: descriptor.size,
                lastModified: descriptor.lastModified,
            };
        }),
    };
}

function referenceSources(
    registry: readonly {
        sourceId: string;
        byteLength: number;
        digest: string;
        streamSignature: string;
        releasedAt?: string;
    }[],
    manifest: EditorManifestV4,
    media: PathGrantMediaAdapter,
): ManagedReferenceSourceV1[] {
    return registry.filter((source) => !source.releasedAt).map((source) => {
        const record = media.getBySourceId(source.sourceId);
        const descriptor = [
            ...manifest.videoSourceDescriptors,
            ...manifest.audioSourceDescriptors,
        ].find((candidate) => candidate.id === source.sourceId);
        if (!record || !descriptor) {
            throw managedError(
                'SOURCE_CHANGED',
                'A reference source is unavailable.',
                true,
            );
        }
        return {
            sourceId: source.sourceId,
            displayName: record.displayName,
            mediaClass: record.class,
            contentDigest: source.digest as `sha256:${string}`,
            byteLength: source.byteLength,
            descriptorFingerprint: descriptor.fingerprint,
            probe: record.metadata,
        };
    });
}

function exportKinds(): ManagedExportKind[] {
    return [
        'mp4-h264-aac',
        'webm',
        'portable-bundle',
        'reference-snapshot',
        'proof-record',
    ];
}

function managedRequest(call: CanonicalToolCall): ManagedMutationEnvelope {
    return {
        apiVersion: '2026-07-25',
        sessionId: requiredString(call.request, 'sessionId'),
        sessionEpoch: requiredString(call.request, 'sessionEpoch'),
        expected: requiredObject(call.request, 'expected') as never,
        idempotencyKey: requiredString(call.request, 'idempotencyKey'),
        toolName: call.toolName,
        canonicalRequestHash: call.requestHash,
        command: {},
    };
}

function requiredObject(
    value: Readonly<Record<string, unknown>>,
    key: string,
): Record<string, unknown> {
    const candidate = value[key];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw managedError('INVALID_REQUEST', `${key} must be an object.`);
    }
    return candidate as Record<string, unknown>;
}

function requiredString(value: Readonly<Record<string, unknown>>, key: string): string {
    const candidate = value[key];
    if (typeof candidate !== 'string' || candidate.length === 0) {
        throw managedError('INVALID_REQUEST', `${key} must be a non-empty string.`);
    }
    return candidate;
}
import { join } from 'node:path';
