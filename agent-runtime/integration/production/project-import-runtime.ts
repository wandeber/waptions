import { createHash } from 'node:crypto';

import type {
    AudioSourceDescriptor,
    VideoSourceDescriptorV3,
} from '../../../src/types/video';
import type {
    ImmutableMediaIdentityV1,
    VerifiedMediaHandleV1,
} from '../../../src/types/waptions-agent-protocol';
import type { ManagedCoordinator } from '../../coordinator/managed-coordinator';
import { managedError } from '../../coordinator/errors';
import type {
    ManagedMutationEnvelope,
    ManagedMutationResult,
    ManagedSourceRegistryRecord,
} from '../../coordinator/types';
import type { DurableJobRecord } from '../../jobs/durable-job-scheduler';
import type {
    CanonicalToolCall,
    CoordinatorResult,
    JsonObject,
    ScopedMutationToolCall,
} from '../../mcp/contracts';
import { canonicalDigest } from '../../persistence/canonical-json';
import type { PreparedRetainedSource } from '../../path-grants/path-grant-authority';
import type { CoordinatorCallContext } from '../../server/coordinator-adapter';
import {
    createImportedManagedCoreSnapshot,
    type ManagedCoreCommand,
    type ManagedCoreEditorState,
    type ManagedCoreResult,
} from '../core-editor-port';
import { projectJobRecord } from '../canonical-projections';
import {
    createDurableManagedMediaCatalogRecord,
    DurableManagedMediaAssetAuthority,
} from '../media/durable-media-asset-authority';
import type { ManagedMediaCatalogRecord } from '../media/contracts';
import {
    descriptorVersion,
    PathGrantMediaAdapter,
} from '../media/path-grant-media-adapter';
import {
    createManagedProjectImportDelegatedService,
    type PreparedManagedProjectImport,
} from '../project-import';
import { PathGrantProjectImportSourceAuthority } from '../project-import/path-grant-source-authority';

type ProductionCoordinator = ManagedCoordinator<
    ManagedCoreEditorState,
    ManagedCoreCommand,
    ManagedCoreResult
>;

export interface ProjectImportMediaAssetRegistry {
    register(
        projectId: string,
        authority: DurableManagedMediaAssetAuthority,
    ): Promise<void>;
}

export interface ProjectImportTranscriptionAuthority {
    prepareImportedRanges(input: {
        readonly projectId: string;
        readonly manifest: import('../../../src/types/video').EditorManifestV4;
        readonly records: readonly Readonly<Record<string, unknown>>[];
        readonly signal: AbortSignal;
    }): Promise<{
        readonly manifest: import('../../../src/types/video').EditorManifestV4;
        readonly writes: readonly import(
            '../../persistence/managed-filesystem-store'
        ).DurableWrite[];
        accept(): Promise<void>;
        reject(): Promise<void>;
    }>;
}

export interface ProductionProjectImportRuntime {
    handle(
        call: CanonicalToolCall,
        context: CoordinatorCallContext,
    ): Promise<CoordinatorResult>;
}

/**
 * Composes the bounded reader with the coordinator's one project-import
 * publication transaction. No archive path, stream, or raw body enters a job
 * record or receipt.
 */
export function createProductionProjectImportRuntime(input: {
    readonly coordinator: ProductionCoordinator;
    readonly media: PathGrantMediaAdapter;
    readonly mediaAssets: ProjectImportMediaAssetRegistry;
    readonly transcription: ProjectImportTranscriptionAuthority;
}): ProductionProjectImportRuntime {
    const handler = createManagedProjectImportDelegatedService({
        paths: new PathGrantProjectImportSourceAuthority(
            input.coordinator.pathGrants,
        ),
        receipts: {
            replay: async (call) => {
                const projectId = input.coordinator.resolveProjectId(
                    string(call.request.sessionId, 'sessionId'),
                );
                const replay = await input.coordinator.replayMutationReceipt<{
                    readonly job: DurableJobRecord;
                }>(projectId, managedRequest(call));
                return replay ? projectImportResult(replay) : null;
            },
            publishReceiptFirst: async ({ call, prepared, signal }) => {
                const projectId = input.coordinator.resolveProjectId(
                    string(call.request.sessionId, 'sessionId'),
                );
                const project = input.coordinator.getProject(projectId);
                const source = call.request.source as
                    | { kind: 'inline-manifest' }
                    | { kind: 'bundle-path' | 'manifest-path'; grantId: string };
                const grantId = source.kind === 'inline-manifest'
                    ? undefined
                    : source.grantId;
                const staged = await stageImportedMedia({
                    coordinator: input.coordinator,
                    media: input.media,
                    projectId,
                    prepared,
                    grantId,
                    signal,
                });
                let ranges: Awaited<
                    ReturnType<
                        ProjectImportTranscriptionAuthority[
                            'prepareImportedRanges'
                        ]
                    >
                >;
                try {
                    ranges = await input.transcription.prepareImportedRanges({
                        projectId,
                        manifest: prepared.manifest,
                        records: prepared.rangeRecords,
                        signal: signal ?? new AbortController().signal,
                    });
                } catch (error) {
                    await Promise.allSettled(
                        staged.retained.map(
                            ({ prepared }) => prepared.reject(),
                        ),
                    );
                    throw error;
                }
                const projectName = typeof prepared.project.name === 'string'
                    ? prepared.project.name
                    : project.envelope.name;
                const nextEditor = createImportedManagedCoreSnapshot({
                    current: project.envelope.editor,
                    manifest: ranges.manifest,
                    projectName,
                });
                const transcriptWrites = prepared.transcripts.map(
                    ({ record }) => ({
                        relativePath:
                            `transcription/editorial-records/${record.recordId.slice(7)}.json`,
                        value: {
                            recordId: record.recordId,
                            body: structuredClone(record.body),
                        },
                    }),
                );
                const result =
                    await input.coordinator.publishProjectImportReceiptFirst(
                        projectId,
                        managedRequest(call),
                        {
                            nextEditor,
                            nextName: projectName,
                            sourceRegistryAdditions:
                                staged.sourceRegistryAdditions,
                            writes: [
                                ...staged.catalogWrites,
                                ...transcriptWrites,
                                ...ranges.writes,
                            ],
                            jobId:
                                `bundle-import:${call.requestHash.slice(7, 31)}`,
                            formatVersion: prepared.formatVersion,
                            verify: async () => {
                                signal?.throwIfAborted();
                                for (const retained of staged.retained) {
                                    const opened =
                                        await input.coordinator.pathGrants
                                            .openRetainedSource(
                                                project.envelope.sessionId,
                                                retained.sourceId,
                                                retained.prepared.digest,
                                                retained.prepared.byteLength,
                                                { signal },
                                            );
                                    try {
                                        await opened.verifyUnchanged();
                                    } finally {
                                        await opened.close();
                                    }
                                }
                            },
                            accept: async () => {
                                await ranges.accept();
                                staged.retained.forEach(
                                    ({ prepared }) => prepared.accept(),
                                );
                                for (const restored of staged.catalogRecords) {
                                    input.media.restoreCommitted({
                                        grantId: restored.grantId,
                                        scope: {
                                            sessionId:
                                                project.envelope.sessionId,
                                            sessionEpoch:
                                                project.state.sessionEpoch,
                                        },
                                        record: restored.record,
                                    });
                                }
                                await input.mediaAssets.register(
                                    projectId,
                                    new DurableManagedMediaAssetAuthority({
                                        projectId,
                                        scope: {
                                            sessionId:
                                                project.envelope.sessionId,
                                            sessionEpoch:
                                                project.state.sessionEpoch,
                                        },
                                        catalog: input.media,
                                    }),
                                );
                            },
                            reject: async () => {
                                await Promise.allSettled([
                                    ranges.reject(),
                                    ...staged.retained.map(
                                        ({ prepared }) => prepared.reject(),
                                    ),
                                ]);
                            },
                        },
                    );
                return projectImportResult(result);
            },
        },
    });
    return { handle: handler };
}

async function stageImportedMedia(input: {
    readonly coordinator: ProductionCoordinator;
    readonly media: PathGrantMediaAdapter;
    readonly projectId: string;
    readonly prepared: PreparedManagedProjectImport;
    readonly grantId?: string;
    readonly signal?: AbortSignal;
}): Promise<{
    readonly retained: readonly {
        sourceId: string;
        prepared: PreparedRetainedSource;
    }[];
    readonly catalogRecords: readonly {
        grantId: string;
        record: ManagedMediaCatalogRecord;
    }[];
    readonly catalogWrites: readonly {
        relativePath: string;
        value: ReturnType<typeof createDurableManagedMediaCatalogRecord>;
    }[];
    readonly sourceRegistryAdditions: readonly ManagedSourceRegistryRecord[];
}> {
    const project = input.coordinator.getProject(input.projectId);
    const existing = new Map(
        project.envelope.sourceRegistry
            .filter((source) => source.releasedAt === undefined)
            .map((source) => [source.sourceId, source]),
    );
    const retained: Array<{
        sourceId: string;
        prepared: PreparedRetainedSource;
    }> = [];
    const catalogRecords: Array<{
        grantId: string;
        record: ManagedMediaCatalogRecord;
    }> = [];
    try {
        for (const media of input.prepared.media) {
            input.signal?.throwIfAborted();
            const descriptor = descriptorFor(input.prepared, media.sourceId);
            const previous = existing.get(media.sourceId);
            if (previous) {
                if (
                    previous.digest !== media.contentDigest
                    || previous.byteLength !== media.byteLength
                    || previous.streamSignature !== descriptor.fingerprint
                ) {
                    throw managedError(
                        'SOURCE_CHANGED',
                        'An imported source conflicts with the retained project source.',
                        true,
                    );
                }
                continue;
            }
            if (!input.grantId) {
                throw managedError(
                    'PATH_NOT_GRANTED',
                    'Imported media requires a granted bundle or manifest path.',
                );
            }
            const preparedSource =
                await input.coordinator.pathGrants.retainVerifiedSourceStream({
                    sessionId: project.envelope.sessionId,
                    sourceId: media.sourceId,
                    expectedDigest: media.contentDigest,
                    expectedBytes: media.byteLength,
                    stream: media.stream(input.signal),
                    signal: input.signal,
                });
            retained.push({
                sourceId: media.sourceId,
                prepared: preparedSource,
            });
            catalogRecords.push({
                grantId: input.grantId,
                record: importedCatalogRecord(
                    descriptor,
                    media.contentDigest,
                    preparedSource,
                ),
            });
        }
        const importedIds = new Set(input.prepared.media.map(
            (media) => media.sourceId,
        ));
        for (const descriptor of [
            ...input.prepared.manifest.videoSourceDescriptors,
            ...input.prepared.manifest.audioSourceDescriptors,
        ]) {
            if (!importedIds.has(descriptor.id) && !existing.has(descriptor.id)) {
                throw managedError(
                    'SOURCE_CHANGED',
                    'A descriptor-only import references an unavailable source.',
                    true,
                );
            }
        }
        const durable = catalogRecords.map(({ grantId, record }) => ({
            grantId,
            record,
            durable: createDurableManagedMediaCatalogRecord({
                grantId,
                record,
            }),
        }));
        return {
            retained,
            catalogRecords,
            catalogWrites: durable.map(({ durable: value }) => ({
                relativePath:
                    `media/catalog/${canonicalDigest({ sourceId: value.sourceId }).slice(7)}.json`,
                value,
            })),
            sourceRegistryAdditions: durable.map(({ durable: value }) => ({
                sourceId: value.sourceId,
                immutableVersion: value.identity.immutableVersion,
                byteLength: value.identity.byteLength,
                digest: value.identity.contentDigest,
                streamSignature: value.identity.descriptorFingerprint,
                registeredAt: value.verifiedAt,
            })),
        };
    } catch (error) {
        await Promise.allSettled(
            retained.map(({ prepared }) => prepared.reject()),
        );
        throw error;
    }
}

function descriptorFor(
    prepared: PreparedManagedProjectImport,
    sourceId: string,
): VideoSourceDescriptorV3 | AudioSourceDescriptor {
    const descriptor = [
        ...prepared.manifest.videoSourceDescriptors,
        ...prepared.manifest.audioSourceDescriptors,
    ].find((candidate) => candidate.id === sourceId);
    if (!descriptor) {
        throw managedError(
            'INVALID_REQUEST',
            'Imported media has no matching descriptor.',
        );
    }
    return descriptor;
}

function importedCatalogRecord(
    descriptor: VideoSourceDescriptorV3 | AudioSourceDescriptor,
    digest: `sha256:${string}`,
    retained: PreparedRetainedSource,
): ManagedMediaCatalogRecord {
    const registeredIdentity = {
        version: 1 as const,
        sha256: digest,
        byteLength: retained.byteLength,
        statIdentity: [
            retained.identity.device,
            retained.identity.inode,
            retained.identity.size,
            retained.identity.modifiedMilliseconds,
        ].join(':'),
    };
    const immutableVersion = descriptorVersion(registeredIdentity);
    const suffix = canonicalDigest({
        sourceId: descriptor.id,
        digest,
        immutableVersion,
    }).slice(7, 39);
    const metadata = 'fps' in descriptor
        ? {
            containerFormats: [containerFormat(descriptor.mimeType)],
            durationUs: Math.max(1, Math.round(descriptor.duration * 1_000_000)),
            ...(descriptor.bitrate === null
                ? {}
                : { bitRate: descriptor.bitrate }),
            videoStreams: [{
                index: 0,
                codec: 'unknown',
                width: descriptor.width,
                height: descriptor.height,
                frameRate: {
                    numerator: Math.max(1, Math.round(descriptor.fps * 1_000)),
                    denominator: 1_000,
                },
            }],
            audioStreams: descriptor.hasAudio
                ? [{
                    index: 1,
                    codec: 'unknown',
                    sampleRate: 48_000,
                    channels: 2,
                }]
                : [],
            primaryVideoStreamIndex: 0,
            ...(descriptor.hasAudio
                ? { primaryAudioStreamIndex: 1 }
                : {}),
        }
        : {
            containerFormats: [containerFormat(descriptor.mimeType)],
            durationUs: Math.max(1, Math.round(descriptor.duration * 1_000_000)),
            ...(descriptor.bitrate === null
                ? {}
                : { bitRate: descriptor.bitrate }),
            videoStreams: [],
            audioStreams: [{
                index: 0,
                codec: descriptor.codec ?? 'unknown',
                sampleRate: descriptor.nativeSampleRate,
                channels: descriptor.nativeChannelCount,
            }],
            primaryAudioStreamIndex: 0,
        };
    const metadataDigest = `sha256:${createHash('sha256')
        .update(JSON.stringify(metadata))
        .digest('hex')}` as const;
    const identity: ImmutableMediaIdentityV1 = {
        schemaVersion: 1,
        contentDigest: digest,
        descriptorFingerprint: descriptor.fingerprint,
        byteLength: retained.byteLength,
        immutableVersion,
        stableStatIdentity: {
            device: retained.identity.device,
            fileId: retained.identity.inode,
            modifiedNanoseconds: String(Math.max(
                0,
                Math.round(
                    retained.identity.modifiedMilliseconds * 1_000_000,
                ),
            )),
        },
        streamMetadataRefs: [{
            kind: 'probe',
            ref: `import:${suffix}`,
            digest: metadataDigest,
        }],
    };
    const handle: VerifiedMediaHandleV1 = {
        schemaVersion: 1,
        handleId: `imported-media:${suffix}`,
        capabilityId: `imported-capability:${suffix}`,
        identity,
        verifiedAt: new Date().toISOString(),
    };
    return {
        handle,
        sourceId: descriptor.id,
        displayName: descriptor.originalName,
        mimeType: descriptor.mimeType,
        lastModified: descriptor.lastModified,
        registeredIdentity,
        metadata,
        class: 'fps' in descriptor ? 'video' : 'audio',
        ...('fps' in descriptor
            ? { videoDescriptor: structuredClone(descriptor) }
            : { audioDescriptor: structuredClone(descriptor) }),
    };
}

function containerFormat(mimeType: string): string {
    const subtype = mimeType.split('/')[1];
    return subtype && /^[a-z0-9.+-]+$/i.test(subtype)
        ? subtype.toLowerCase()
        : 'unknown';
}

function managedRequest(
    call: ScopedMutationToolCall,
): ManagedMutationEnvelope<{ readonly kind: 'project-import' }> {
    return {
        apiVersion: '2026-07-25',
        sessionId: string(call.request.sessionId, 'sessionId'),
        sessionEpoch: string(call.request.sessionEpoch, 'sessionEpoch'),
        expected: call.request.expected as unknown as
            ManagedMutationEnvelope['expected'],
        idempotencyKey: string(
            call.request.idempotencyKey,
            'idempotencyKey',
        ),
        toolName: call.toolName,
        canonicalRequestHash: call.requestHash,
        command: { kind: 'project-import' },
    };
}

function projectImportResult(
    result: ManagedMutationResult<{ readonly job: DurableJobRecord }>,
): CoordinatorResult {
    if (!result.ok) {
        return {
            ok: false,
            error: result.error,
            ...(result.state ? { state: result.state } : {}),
        };
    }
    const job = projectJobRecord(result.data.job);
    return {
        ok: true,
        data: {
            jobId: job.jobId,
            job: job as unknown as JsonObject,
        },
        state: result.state,
        ...(result.committedState
            ? { committedState: result.committedState }
            : {}),
        warnings: result.warnings.map((message) => ({
            code: 'PARTIAL_RESULT',
            message,
        })),
        replayed: result.replayed,
    };
}

function string(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw managedError(
            'INVALID_REQUEST',
            `Project import ${label} is invalid.`,
        );
    }
    return value;
}
