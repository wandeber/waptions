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
import type { ProductionResourceBudget } from './resource-budget';
import { PrivateMp4ScratchAuthority } from './private-mp4-scratch';

type ProductionCoordinator = ManagedCoordinator<
    ManagedCoreEditorState,
    ManagedCoreCommand,
    ManagedCoreResult
>;

export interface ProductionExportRuntime {
    registerJobHandlers(scheduler: DurableJobScheduler): void;
    start(call: CanonicalToolCall): Promise<CoordinatorResult>;
}

export function createProductionExportRuntime(input: {
    coordinator: ProductionCoordinator;
    media: PathGrantMediaAdapter;
    outputs: PathGrantOutputAuthority;
    budget: ProductionResourceBudget;
    dataRoot: string;
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
): Promise<ManagedExportMaterial> {
    const project = coordinator.getProject(projectId);
    const manifest = project.envelope.editor.state.snapshot.manifest;
    const sources = referenceSources(project.envelope.sourceRegistry, manifest, media);
    if (kind === 'mp4-h264-aac' || kind === 'webm') {
        return { renderSnapshot: renderSnapshot(manifest, media) };
    }
    if (kind === 'portable-bundle') {
        const manifestBytes = Buffer.from(canonicalJson(manifest));
        return {
            portableBundle: {
                entries: [{
                    name: 'manifest.json',
                    byteLength: manifestBytes.byteLength,
                    expectedDigest: canonicalDigest(manifest) as `sha256:${string}`,
                    stream: async function* () {
                        yield manifestBytes;
                    },
                    revalidate: async () => {
                        const current = coordinator.getProject(projectId);
                        if (canonicalDigest(current.envelope.editor.state.snapshot.manifest)
                            !== canonicalDigest(manifest)) {
                            throw managedError(
                                'SESSION_REVISION_CONFLICT',
                                'The project changed during bundle export.',
                                true,
                            );
                        }
                    },
                }],
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
    const artifactRecords = await artifacts.list(projectId);
    return {
        proof: {
            schemaVersion: 1,
            runtimeVersion: 'managed-runtime-v1',
            pluginVersion: '2026-07-25',
            schemaBundleDigest: canonicalDigest('2026-07-25') as `sha256:${string}`,
            state: project.state,
            sources,
            operations: [],
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
