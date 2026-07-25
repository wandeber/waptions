import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    CoreEditorPortFactory,
    type ManagedCoreCommand,
    type ManagedCoreAssetAuthority,
    type ManagedCoreAssetAuthorityRequest,
    type ManagedCoreEditorState,
    type ManagedCoreResult,
} from '../core-editor-port';
import { CanonicalToolRouter } from '../canonical-tool-router';
import {
    createManagedToolHandlers,
    type ManagedDelegatedToolPort,
    type ManagedStagedOutputAuthority,
} from '../managed-tool-handlers';
import { ManagedRuntimeHost } from '../runtime-host';
import { ManagedCoordinator } from '../../coordinator/managed-coordinator';
import { managedError } from '../../coordinator/errors';
import type {
    CoordinatorCallContext,
    ManagedCoordinatorAdapter,
} from '../../server/coordinator-adapter';
import type {
    ManagedCoordinatorServiceAuthority,
    ManagedCoordinatorServiceOptions,
} from '../../transport/managed-coordinator-service';
import type { ProductionManagedRuntimeOptions } from '../production-runtime';
import type {
    CanonicalToolCall,
    CoordinatorResult,
    JsonObject,
} from '../../mcp/contracts';
import type { ManagedMutationEnvelope } from '../../coordinator/types';
import { ManagedMediaProbeService } from '../../media/probe';
import { NodeBoundedMediaProcessPort } from '../media/node-bounded-media-process';
import { PathGrantMediaAdapter } from '../media/path-grant-media-adapter';
import { PrivateReviewArtifactStager } from '../media/review-artifact-staging';
import { ManagedMediaReviewJobHandler } from '../media/review-job-handler';
import { ManagedMediaToolService } from '../media/managed-media-tools';
import {
    createDurableManagedMediaCatalog,
    createDurableManagedMediaCatalogRecord,
    DurableManagedMediaAssetAuthority,
    restoreDurableManagedMediaCatalog,
    type DurableManagedMediaCatalogRecord,
} from '../media/durable-media-asset-authority';
import type { SessionPathGrantRecord } from '../../path-grants/path-grant-authority';
import { EditorCommandError } from '../../../src/lib/editor-engine';
import {
    ProductionResourceBudget,
    ProductionRuntimeMetrics,
} from './resource-budget';
import { PathGrantOutputAuthority } from '../export/path-grant-output-authority';
import type { DurableJobScheduler } from '../../jobs/durable-job-scheduler';
import { canonicalDigest } from '../../persistence/canonical-json';
import { projectJobRecord } from '../canonical-projections';
import { createProductionRuntimeAuthorities } from './factories';
import {
    createProductionRuntimeAuthorityPorts,
} from './runtime-authority-ports';
import {
    createProductionTranscriptionRuntime,
    type ProductionTranscriptionRuntime,
} from './transcription-runtime';
import {
    createProductionBridgeRuntime,
    type ProductionBridgeRuntime,
} from './bridge-runtime';
import {
    createProductionExportRuntime,
    type ProductionExportRuntime,
} from './export-runtime';
import {
    createProductionProjectImportRuntime,
    type ProductionProjectImportRuntime,
} from './project-import-runtime';

type ProductionCoordinator = ManagedCoordinator<
    ManagedCoreEditorState,
    ManagedCoreCommand,
    ManagedCoreResult
>;

export interface ProductionRuntimeComposition {
    readonly authority: ManagedCoordinatorServiceAuthority;
    readonly adapter: ManagedCoordinatorAdapter;
    readonly serviceOptions?: ManagedCoordinatorServiceOptions;
}

/**
 * Composes the persistent authority and the exact canonical router used by the
 * packaged runtime. Service-specific authorities are installed before project
 * and durable-job recovery.
 */
export async function createProductionRuntimeComposition(
    options: ProductionManagedRuntimeOptions,
): Promise<ProductionRuntimeComposition> {
    let services: ProductionServices | undefined;
    const mediaAssets = new ProductionMediaAssetAuthority();
    let coordinator: ProductionCoordinator;
    try {
        coordinator = await ManagedCoordinator.start(
            options.dataRoot,
            new CoreEditorPortFactory(mediaAssets),
            {
            configureRuntime: (authority) => {
                return createProductionServices(
                    options,
                    authority,
                    mediaAssets,
                ).then((created) => {
                    services = created;
                });
            },
            registerJobHandlers: (scheduler) => {
                requireServices(services).registerJobHandlers(scheduler);
            },
            beforeJobRecovery: async (_authority, projectIds) => {
                await requireServices(services).restoreMediaCatalogs(projectIds);
            },
            mediaCatalogPublicationAuthority: {
                prepare: (input) => (
                    requireServices(services).prepareMediaCatalog(input)
                ),
            },
            },
        );
    } catch (error) {
        // Service construction starts the local bridge before project/job recovery. Never leave a
        // partially composed process holding its fixed private port when recovery rejects.
        await Promise.allSettled([
            services?.bridge.close() ?? Promise.resolve(),
            mediaAssets.close(),
        ]);
        throw error;
    }
    const runtimeServices = requireServices(services);
    const delegated = createDelegatedTools(coordinator, runtimeServices);
    const runtimeAuthorities = createProductionRuntimeAuthorities(
        createProductionRuntimeAuthorityPorts({
            coordinator,
            mediaAssets,
            media: runtimeServices.media,
            budget: runtimeServices.budget,
            metrics: runtimeServices.metrics,
            transcription: runtimeServices.transcription,
        }),
    );
    const router = new CanonicalToolRouter({
        handlers: createManagedToolHandlers({
            coordinator,
            delegated,
            editorRender: runtimeServices.bridge.editorRender,
            stagedOutput: runtimeServices.stagedOutput,
            projectValidation: runtimeAuthorities.projectValidation,
            artifactAccess: runtimeServices.bridge.artifactAccess,
            diagnostics: runtimeAuthorities.diagnostics,
        }),
    });
    const authority = new ProductionCoordinatorAuthority(
        coordinator,
        runtimeServices.bridge,
        mediaAssets,
        runtimeServices.export,
    );
    return {
        authority,
        adapter: new ManagedRuntimeHost(authority, router),
    };
}

class ProductionCoordinatorAuthority implements ManagedCoordinatorServiceAuthority {
    readonly epoch: string;
    readonly diagnostics;
    readonly httpBridgeEndpoint = {
        host: 'localhost' as const,
        port: 59941 as const,
    };

    constructor(
        private readonly coordinator: ProductionCoordinator,
        private readonly bridge: ProductionBridgeRuntime,
        private readonly mediaAssets: ProductionMediaAssetAuthority,
        private readonly exportRuntime: ProductionExportRuntime,
    ) {
        this.epoch = coordinator.epoch;
        this.diagnostics = coordinator.diagnostics;
    }

    resolveProjectId(sessionId: string): string {
        return this.coordinator.resolveProjectId(sessionId);
    }

    async subscribeToEvents(
        sessionId: string,
        onEventAvailable: () => void,
        context: CoordinatorCallContext,
    ) {
        const projectId = this.coordinator.resolveProjectId(sessionId);
        const subscription = this.coordinator.events.subscribe(projectId, sessionId);
        let closed = false;
        void subscription.next(context.signal).then(() => {
            if (!closed) onEventAvailable();
        }).catch(() => undefined);
        return {
            close: async () => {
                closed = true;
                subscription.close();
            },
        };
    }

    canGracefullyShutdown(): boolean {
        return this.coordinator.canGracefullyShutdown();
    }

    async close(): Promise<void> {
        await this.bridge.close();
        await this.coordinator.close();
        await this.exportRuntime.close();
        await this.mediaAssets.close();
    }
}

interface ProductionServices {
    readonly media: PathGrantMediaAdapter;
    readonly probes: ManagedMediaProbeService;
    readonly output: PathGrantOutputAuthority;
    readonly stagedOutput: ManagedStagedOutputAuthority;
    readonly transcription: ProductionTranscriptionRuntime;
    readonly bridge: ProductionBridgeRuntime;
    readonly export: ProductionExportRuntime;
    readonly projectImport: ProductionProjectImportRuntime;
    readonly budget: ProductionResourceBudget;
    readonly metrics: ProductionRuntimeMetrics;
    registerJobHandlers(scheduler: DurableJobScheduler): void;
    restoreMediaCatalogs(projectIds: readonly string[]): Promise<void>;
    prepareMediaCatalog(input: {
        readonly projectId: string;
        readonly sessionId: string;
        readonly sessionEpoch: string;
        readonly additions: readonly import('../../coordinator/types').ManagedSourceRegistryRecord[];
    }): Promise<{
        readonly writes: readonly import('../../persistence/managed-filesystem-store').DurableWrite[];
        accept(): Promise<void>;
        reject(): void;
    }>;
}

async function createProductionServices(
    options: ProductionManagedRuntimeOptions,
    coordinator: ProductionCoordinator,
    mediaAssets: ProductionMediaAssetAuthority,
): Promise<ProductionServices> {
    const { dataRoot } = options;
    const media = new PathGrantMediaAdapter(coordinator.pathGrants);
    const reviewStaging = new PrivateReviewArtifactStager(
        join(dataRoot, 'coordinator', 'review-staging'),
    );
    const processes = new NodeBoundedMediaProcessPort(
        media,
        reviewStaging,
        { ffmpegExecutable: 'ffmpeg', ffprobeExecutable: 'ffprobe' },
    );
    const metrics = new ProductionRuntimeMetrics();
    const probes = new ManagedMediaProbeService(
        media,
        media,
        processes,
        { record: (event) => metrics.record(event) },
    );
    const budget = new ProductionResourceBudget(coordinator.decodedMemoryBudget);
    const output = new PathGrantOutputAuthority();
    const transcription = await createProductionTranscriptionRuntime(
        dataRoot,
        coordinator,
    );
    const bridge = await createProductionBridgeRuntime(
        coordinator,
        options.appResource,
    );
    const exportRuntime = createProductionExportRuntime({
        coordinator,
        media,
        outputs: output,
        budget,
        dataRoot,
        transcription,
    });
    const projectImport = createProductionProjectImportRuntime({
        coordinator,
        media,
        mediaAssets,
        transcription,
    });
    const stagedOutput: ManagedStagedOutputAuthority = {
        stageWriteDestination: async (projectId, input) => {
            const project = coordinator.getProject(projectId);
            const staged = await coordinator.pathGrants.stageCreate(
                input.grantId,
                {
                    sessionId: project.envelope.sessionId,
                    sessionEpoch: project.state.sessionEpoch,
                },
            );
            const capability = {
                schemaVersion: 1 as const,
                destinationId: `output:${randomUUID()}`,
                grantId: input.grantId,
                stagingHandleId: `staging:${randomUUID()}`,
                mode: 'create-only' as const,
                outputName: input.outputName,
                verifiedParentIdentity: canonicalDigest({
                    grantId: input.grantId,
                    outputName: input.outputName,
                }),
                expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
            };
            output.register(capability, staged);
            return capability;
        },
    };
    return {
        media,
        probes,
        output,
        stagedOutput,
        transcription,
        bridge,
        export: exportRuntime,
        projectImport,
        budget,
        metrics,
        registerJobHandlers: (scheduler) => {
            const handler = new ManagedMediaReviewJobHandler(
                media,
                processes,
                reviewStaging,
                coordinator.artifacts,
                budget,
            );
            for (const kind of [
                'contact-sheet',
                'thumbnail-strip',
                'waveform-audio-map',
                'silence-speech-map',
                'scene-cut-candidates',
                'review-proxy',
            ]) {
                scheduler.register(kind, handler);
            }
            transcription.registerJobHandlers(scheduler);
            exportRuntime.registerJobHandlers(scheduler);
        },
        restoreMediaCatalogs: async (projectIds) => {
            for (const projectId of projectIds) {
                const project = coordinator.getProject(projectId);
                const activeSources = project.envelope.sourceRegistry.filter(
                    (source) => source.releasedAt === undefined,
                );
                const durable = await coordinator.store.readNamespace<
                    DurableManagedMediaCatalogRecord
                >(projectId, 'media/catalog');
                const recordsBySource = new Map(
                    durable.map((record) => [record.sourceId, record]),
                );
                const grants = await coordinator.store.readNamespace<
                    SessionPathGrantRecord
                >(projectId, 'grants');
                const grantsById = new Map(
                    grants.map((grant) => [grant.grantId, grant]),
                );

                for (const source of activeSources) {
                    const record = recordsBySource.get(source.sourceId);
                    const grant = record
                        ? grantsById.get(record.grantId)
                        : undefined;
                    if (!record || !grant) {
                        throw managedError(
                            'SOURCE_CHANGED',
                            'A retained source is missing its durable media authority.',
                            true,
                        );
                    }
                    const restored = restoreDurableManagedMediaCatalog({
                        projectId,
                        // A path grant remains bound to the epoch in which it
                        // authorized the immutable private copy. Core receives
                        // a fresh project-scoped authority below.
                        scope: {
                            sessionId: grant.sessionId,
                            sessionEpoch: grant.sessionEpoch,
                        },
                        sourceRegistry: [source],
                        grants: [grant],
                        catalog: createDurableManagedMediaCatalog([record]),
                        pathGrants: coordinator.pathGrants,
                        media,
                    });
                    await restored.assetAuthority.close();
                }

                await mediaAssets.register(
                    projectId,
                    new DurableManagedMediaAssetAuthority({
                        projectId,
                        scope: {
                            sessionId: project.envelope.sessionId,
                            sessionEpoch: project.state.sessionEpoch,
                        },
                        catalog: media,
                    }),
                );
            }
        },
        prepareMediaCatalog: async (input) => {
            const records = input.additions.map((addition) => {
                const catalogRecord = media.getCatalogRecord(addition.sourceId);
                if (!catalogRecord) {
                    throw managedError(
                        'SOURCE_CHANGED',
                        'Core imported a source without retained media authority.',
                        true,
                    );
                }
                const durable = createDurableManagedMediaCatalogRecord({
                    grantId: media.grantIdForSource(addition.sourceId),
                    record: catalogRecord,
                });
                if (
                    durable.sourceId !== addition.sourceId
                    || durable.registeredIdentity.sha256 !== addition.digest
                    || durable.registeredIdentity.byteLength !== addition.byteLength
                    || durable.identity.immutableVersion !== addition.immutableVersion
                    || durable.identity.descriptorFingerprint !== addition.streamSignature
                ) {
                    throw managedError(
                        'SOURCE_CHANGED',
                        'The durable media catalog does not match Core source registration.',
                        true,
                    );
                }
                return durable;
            });
            const writes = records.map((record) => ({
                relativePath:
                    `media/catalog/${canonicalDigest({ sourceId: record.sourceId }).slice(7)}.json`,
                value: record,
            }));
            return {
                writes,
                accept: async () => {
                    await mediaAssets.register(
                        input.projectId,
                        new DurableManagedMediaAssetAuthority({
                            projectId: input.projectId,
                            scope: {
                                sessionId: input.sessionId,
                                sessionEpoch: input.sessionEpoch,
                            },
                            catalog: media,
                        }),
                    );
                },
                reject: () => undefined,
            };
        },
    };
}

/**
 * Core receives one stable process authority while each project receives an
 * independently recovered, epoch-scoped media catalog behind it.
 */
class ProductionMediaAssetAuthority implements ManagedCoreAssetAuthority {
    private readonly projects = new Map<string, DurableManagedMediaAssetAuthority>();
    private closed = false;

    async resolve(
        request: ManagedCoreAssetAuthorityRequest,
    ): Promise<import('../../../src/lib/editor-engine').EditorAssetHydration> {
        if (this.closed) {
            throw new EditorCommandError(
                'COORDINATOR_UNAVAILABLE',
                'Managed media authority is closed.',
            );
        }
        const authority = this.projects.get(request.projectId);
        if (!authority) {
            if (
                request.videoSourceIds.length === 0
                && request.audioSourceIds.length === 0
            ) {
                return { videoSources: [], audioSources: [] };
            }
            throw new EditorCommandError(
                'SOURCE_CHANGED',
                'The project media authority is unavailable.',
                { retryable: true },
            );
        }
        return authority.resolve(request);
    }

    async register(
        projectId: string,
        authority: DurableManagedMediaAssetAuthority,
    ): Promise<void> {
        if (this.closed) {
            await authority.close();
            throw new EditorCommandError(
                'COORDINATOR_UNAVAILABLE',
                'Managed media authority is closed.',
            );
        }
        const previous = this.projects.get(projectId);
        this.projects.set(projectId, authority);
        await previous?.close();
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        const authorities = [...this.projects.values()];
        this.projects.clear();
        await Promise.all(authorities.map((authority) => authority.close()));
    }
}

function createDelegatedTools(
    coordinator: ProductionCoordinator,
    services: ProductionServices,
): ManagedDelegatedToolPort {
    return {
        waptions_project_import: (call, context) => (
            services.projectImport.handle(call, context)
        ),
        waptions_media_probe: async (call, context) => {
            const projectId = projectIdForCall(coordinator, call);
            const project = coordinator.getProject(projectId);
            const tool = new ManagedMediaToolService(
                services.media,
                services.probes,
                {
                    importMedia: async () => {
                        throw managedError(
                            'INVALID_REQUEST',
                            'Media import is not part of a probe operation.',
                        );
                    },
                },
            );
            const response = await tool.probe({
                operationId: `probe:${call.requestHash.slice(7, 23)}`,
                sessionId: project.envelope.sessionId,
                sessionEpoch: project.state.sessionEpoch,
                grantId: requiredString(call.request, 'grantId'),
                paths: requiredStringArray(call.request, 'paths'),
                hashPolicy: optionalString(call.request, 'hashPolicy') as
                    | 'always'
                    | 'if-needed'
                    | undefined,
                signal: context.signal,
            });
            return success({
                handles: response.handles as unknown as JsonObject[],
                media: response.media as unknown as JsonObject[],
                jobIds: [],
            }, project.state);
        },
        waptions_media_import: async (call, context) => {
            const projectId = projectIdForCall(coordinator, call);
            const tool = new ManagedMediaToolService(
                services.media,
                services.probes,
                {
                    replayImport: async () => {
                        const replay = await coordinator.replayMutationReceipt<
                            import('../../../src/lib/editor-engine').EditorMediaImportResult
                        >(
                            projectId,
                            managedRequest(call, {}),
                        );
                        if (!replay) return null;
                        if (!replay.ok) {
                            throw managedError(
                                replay.error.code,
                                replay.error.message,
                                replay.error.retryable,
                                replay.error.details,
                            );
                        }
                        return replay.data;
                    },
                    importMedia: async (input) => {
                        const command: ManagedCoreCommand = {
                            kind: 'import',
                            request: input.request,
                            hydration: input.hydration,
                        };
                        const result = await coordinator.importMediaThroughCore(
                            projectId,
                            managedRequest(call, command),
                            command,
                            {
                                revalidate: () => input.revalidate(context.signal),
                                commitAuthority: input.commitAuthority,
                            },
                        );
                        if (!result.ok) {
                            throw managedError(
                                result.error.code,
                                result.error.message,
                                result.error.retryable,
                                result.error.details,
                            );
                        }
                        return result.data as unknown as
                            import('../../../src/lib/editor-engine').EditorMediaImportResult;
                    },
                },
            );
            const response = await tool.import({
                request: {
                    apiVersion: '2026-07-25',
                    toolName: 'waptions_media_import',
                    sessionEpoch: requiredString(call.request, 'sessionEpoch'),
                    expected: requiredObject(call.request, 'expected') as never,
                    idempotencyKey: requiredString(call.request, 'idempotencyKey'),
                },
                mediaHandles: requiredStringArray(call.request, 'mediaHandles'),
                placement: requiredObject(call.request, 'placement') as never,
                signal: context.signal,
            });
            const project = coordinator.getProject(projectId);
            return {
                ok: true,
                data: {
                    sourceIds: [...response.sourceIds],
                    placedClipIds: [...response.placedClipIds],
                },
                state: project.state,
                warnings: [],
                replayed: response.result.ok && response.result.replayed,
            };
        },
        waptions_media_review: async (call) => enqueueReview(coordinator, call),
        waptions_media_release: async (call) => releaseMedia(coordinator, call),
        waptions_transcription_start: (call, context) => (
            services.transcription.start(call, context)
        ),
        waptions_export_start: (call) => services.export.start(call),
    };
}

async function enqueueReview(
    coordinator: ProductionCoordinator,
    call: CanonicalToolCall,
): Promise<CoordinatorResult> {
    const projectId = projectIdForCall(coordinator, call);
    const result = await coordinator.enqueueJob(
        projectId,
        managedRequest(call, {}),
        {
            kind: requiredString(call.request, 'reviewKind'),
            input: {
                projectId,
                jobId: `review:${call.requestHash.slice(7, 23)}`,
                sourceIds: requiredStringArray(call.request, 'sourceIds'),
                reviewKind: requiredString(call.request, 'reviewKind'),
                ...(Array.isArray(call.request.intervalsSeconds)
                    ? { intervalsSeconds: call.request.intervalsSeconds }
                    : {}),
                ...(typeof call.request.maximumSamples === 'number'
                    ? { maximumSamples: call.request.maximumSamples }
                    : {}),
            },
            inputDigest: call.requestHash,
            cancellable: true,
            resumable: false,
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
}

async function releaseMedia(
    coordinator: ProductionCoordinator,
    call: CanonicalToolCall,
): Promise<CoordinatorResult> {
    const projectId = projectIdForCall(coordinator, call);
    const plan = await coordinator.planSourceRelease(projectId);
    const mode = requiredString(call.request, 'mode');
    const retainedRoots = plan.retained.flatMap((source) => (
        source.reasons.map((reason) => ({
            sourceId: source.sourceId,
            rootKind: reason,
            // Reachability currently collapses equivalent roots by reason. The
            // source ID is the stable public identity for that retained root.
            rootId: source.sourceId,
        }))
    ));
    if (call.request.dryRun === true) {
        const project = coordinator.getProject(projectId);
        return success({
            mode,
            dryRun: true,
            releasedIds: [...plan.releasableSourceIds],
            retainedRoots,
        }, project.state);
    }
    const result = await coordinator.applySourceRelease(
        projectId,
        managedRequest(call, {}),
        plan,
    );
    if (!result.ok) return result;
    return {
        ok: true,
        data: {
            mode,
            dryRun: false,
            releasedIds: [...result.data.releasedSourceIds],
            retainedRoots,
        },
        state: result.state,
        committedState: result.committedState,
        warnings: [],
        replayed: result.replayed,
    };
}

function success(data: JsonObject, state: import('../../mcp/contracts').StateToken): CoordinatorResult {
    return { ok: true, data, state, warnings: [], replayed: false };
}

function projectIdForCall(
    coordinator: ProductionCoordinator,
    call: CanonicalToolCall,
): string {
    return coordinator.resolveProjectId(requiredString(call.request, 'sessionId'));
}

function managedRequest<Command>(
    call: CanonicalToolCall,
    command: Command,
): ManagedMutationEnvelope<Command> {
    return {
        apiVersion: '2026-07-25',
        sessionId: requiredString(call.request, 'sessionId'),
        sessionEpoch: requiredString(call.request, 'sessionEpoch'),
        expected: requiredObject(call.request, 'expected') as unknown as
            ManagedMutationEnvelope['expected'],
        idempotencyKey: requiredString(call.request, 'idempotencyKey'),
        toolName: call.toolName,
        canonicalRequestHash: call.requestHash,
        command,
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

function requiredString(
    value: Readonly<Record<string, unknown>>,
    key: string,
): string {
    const candidate = value[key];
    if (typeof candidate !== 'string' || candidate.length === 0) {
        throw managedError('INVALID_REQUEST', `${key} must be a non-empty string.`);
    }
    return candidate;
}

function optionalString(
    value: Readonly<Record<string, unknown>>,
    key: string,
): string | undefined {
    const candidate = value[key];
    if (candidate === undefined) return undefined;
    if (typeof candidate !== 'string') {
        throw managedError('INVALID_REQUEST', `${key} must be a string.`);
    }
    return candidate;
}

function requiredStringArray(
    value: Readonly<Record<string, unknown>>,
    key: string,
): string[] {
    const candidate = value[key];
    if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== 'string')) {
        throw managedError('INVALID_REQUEST', `${key} must be a string array.`);
    }
    return [...candidate] as string[];
}

function requireServices(
    services: ProductionServices | undefined,
): ProductionServices {
    if (!services) {
        throw managedError(
            'INTERNAL_ERROR',
            'Production services were not configured before recovery.',
        );
    }
    return services;
}
