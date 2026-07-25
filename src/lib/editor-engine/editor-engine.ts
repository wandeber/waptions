import { canonicalizeJson } from '@/lib/editorial-transcription/canonical-json';
import {
    validateEditorManifestV4,
    validateHydratedEditorDocumentV4,
} from '@/lib/editor-document-v4';
import type { ResolvedEditorialTranscriptMapV1, Sha256Digest } from '@/types/editorial';
import type { EditorManifestV4 } from '@/types/video';
import {
    EDITOR_APPLY_TOOL_NAME,
    EDITOR_ENGINE_API_VERSION,
    EDITOR_ENGINE_MAX_REQUEST_BYTES,
    EDITOR_HISTORY_TOOL_NAME,
    EDITOR_MEDIA_IMPORT_TOOL_NAME,
    EDITOR_PLAN_TOOL_NAME,
    EDITORIAL_TRANSCRIPTION_PUBLICATION_TOOL_NAME,
    SUBTITLE_TRANSCRIPTION_PUBLICATION_TOOL_NAME,
    parseEditorCommandBatchRequest,
    type EditorCommandBatchRequest,
    type EditorExpectedRevisions,
    type EditorMutationToolName,
    type EditorSemanticOperation,
} from './editor-command';
import {
    applyEditorOperationBatch,
    assertAssetHydration,
    createDescriptorAssetHydration,
    getEditorEngineAudioGraphSignature,
    manifestToPlanningDocument,
} from './editor-command-planner';
import {
    EditorCommandError,
    toEditorCommandFailure,
} from './editor-command-errors';
import {
    appendEditorHistory,
    cloneHistoryState,
    collectHistoryPins,
    collectManifestSourceIds,
    collectManifestTranscriptRecordIds,
    collectSourcePins,
    createEditorHistoryEntry,
    jumpEditorHistory,
    moveEditorHistory,
    validateEditorHistoryState,
} from './editor-history';
import type {
    EditorCommandPlan,
    EditorCommandPlanSuccess,
    EditorCommandResult,
    EditorCommandSuccess,
    EditorEngine,
    EditorEngineOptions,
    EditorProjectMetadata,
    EditorEngineRevisions,
    EditorEngineSnapshot,
    EditorHistoryState,
    HistoryJumpRequest,
    HistoryMutationRequest,
    EditorMediaImportRequest,
    EditorMediaImportResult,
    EditorMediaImportSuccess,
    EditorialTranscriptionPublicationResult,
    EditorialTranscriptionPublicationSuccess,
    SubtitleTranscriptionPublicationResult,
    SubtitleTranscriptionPublicationSuccess,
} from './editor-engine-types';
import type { EditorEngineEvent, EditorEngineListener } from './editor-events';
import type {
    EditorAssetHydration,
    EditorIdempotencyReceipt,
    EditorPersistenceCommit,
} from './editor-ports';
import {
    applyPreparedEditorMediaImport,
    prepareEditorMediaImport,
} from './editor-media-import';
import {
    parseEditorialTranscriptionPublicationRequest,
    parseSubtitleTranscriptionPublicationRequest,
    prepareEditorialTranscriptionPublication,
    prepareSubtitleTranscriptionPublication,
    type EditorialTranscriptionPublicationHydration,
    type EditorialTranscriptionPublicationRequest,
    type EditorTranscriptionPublicationCommitV1,
    type SubtitleTranscriptionPublicationRequest,
} from './editor-transcription-publication';

const DEFAULT_PLAN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_HISTORY_SUMMARY_LIMIT = 200;

interface StoredPlan {
    plan: EditorCommandPlanSuccess;
    operations: EditorSemanticOperation[];
    expiresAtMs: number;
}

export function createEditorEngine(options: EditorEngineOptions): EditorEngine {
    return new EditorEngineImplementation(options);
}

class EditorEngineImplementation implements EditorEngine {
    private manifest: EditorManifestV4;
    private projectMetadata: EditorProjectMetadata;
    private history: EditorHistoryState;
    private readonly listeners = new Set<EditorEngineListener>();
    private readonly plans = new Map<string, StoredPlan>();
    private readonly historySummaryLimit: number;
    private readonly planTtlMs: number;
    private eventSequence = 0;
    private sessionRevision = 0;
    private queue: Promise<void> = Promise.resolve();
    private closing = false;
    private closed = false;
    private closePromise: Promise<void> | null = null;

    constructor(private readonly options: EditorEngineOptions) {
        const initialManifest = structuredClone(options.initialManifest);
        if (typeof initialManifest.renderBackgroundColor === 'string') {
            initialManifest.renderBackgroundColor = initialManifest.renderBackgroundColor.toLowerCase();
        }
        const validation = validateEditorManifestV4(initialManifest);
        if (!validation.valid) {
            throw new EditorCommandError('INVALID_DOCUMENT', 'Initial V4 manifest is invalid.', {
                details: { issues: validation.issues.slice(0, 50) },
            });
        }
        if (!options.projectId || options.projectId.length > 256
            || !options.sessionEpoch || options.sessionEpoch.length > 256) {
            throw new EditorCommandError('INVALID_REQUEST', 'Engine project and session identities are required.');
        }
        this.manifest = initialManifest;
        this.projectMetadata = structuredClone(options.initialProjectMetadata ?? {
            name: options.projectId,
        });
        if (!this.projectMetadata.name.trim() || this.projectMetadata.name.length > 256) {
            throw new EditorCommandError('INVALID_REQUEST', 'Initial project name is invalid.');
        }
        this.projectMetadata.name = this.projectMetadata.name.trim();
        const initialHistory = options.initialHistory ?? { past: [], future: [] };
        validateEditorHistoryState(initialHistory);
        this.history = cloneHistoryState(initialHistory);
        if (!Number.isSafeInteger(options.initialEventSequence ?? 0)
            || (options.initialEventSequence ?? 0) < 0) {
            throw new EditorCommandError('INVALID_REQUEST', 'Initial event sequence must be non-negative.');
        }
        this.eventSequence = options.initialEventSequence ?? 0;
        if (!Number.isSafeInteger(options.initialSessionRevision ?? 0)
            || (options.initialSessionRevision ?? 0) < 0) {
            throw new EditorCommandError('INVALID_REQUEST', 'Initial session revision must be non-negative.');
        }
        this.sessionRevision = options.initialSessionRevision ?? 0;
        if (!Number.isSafeInteger(options.historySummaryLimit ?? DEFAULT_HISTORY_SUMMARY_LIMIT)
            || (options.historySummaryLimit ?? DEFAULT_HISTORY_SUMMARY_LIMIT) <= 0
            || (options.historySummaryLimit ?? DEFAULT_HISTORY_SUMMARY_LIMIT) > 500) {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                'History summary limit must be between 1 and 500.',
            );
        }
        if (!Number.isSafeInteger(options.planTtlMs ?? DEFAULT_PLAN_TTL_MS)
            || (options.planTtlMs ?? DEFAULT_PLAN_TTL_MS) <= 0
            || (options.planTtlMs ?? DEFAULT_PLAN_TTL_MS) > 24 * 60 * 60 * 1000) {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                'Plan lifetime must be between 1 millisecond and 24 hours.',
            );
        }
        this.historySummaryLimit = options.historySummaryLimit ?? DEFAULT_HISTORY_SUMMARY_LIMIT;
        this.planTtlMs = options.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
    }

    getSnapshot(): EditorEngineSnapshot {
        return this.snapshot();
    }

    plan(rawRequest: EditorCommandBatchRequest): EditorCommandPlan {
        try {
            this.assertOpen();
            const request = parseEditorCommandBatchRequest(rawRequest);
            if (request.toolName !== EDITOR_PLAN_TOOL_NAME) {
                throw new EditorCommandError(
                    'INVALID_REQUEST',
                    `Planning requires toolName "${EDITOR_PLAN_TOOL_NAME}".`,
                );
            }
            if (!request.operations) {
                throw new EditorCommandError('INVALID_REQUEST', 'Planning requires inline operations.');
            }
            this.assertGuards(request.sessionEpoch, request.expected);
            this.assertRequiredDomainGuards(request.expected, request.operations);
            const now = this.options.ports.clock.now();
            const requestHash = canonicalRequestDigest(request);
            const planId = this.options.ports.ids.generate(
                'plan',
                `${this.options.projectId}:${request.toolName}:${requestHash}`,
            );
            const expiresAtMs = now.epochMs + this.planTtlMs;
            const requiredAssets = collectRequiredAssetIds(this.manifest, request.operations);
            const hasDocumentOperation = request.operations.some(
                (operation) => operation.type !== 'project.set-name',
            );
            const requiresBodyHydration = request.operations.some(requiresTranscriptHydration);
            const preliminaryAliases = preallocateAliases(
                request.operations,
                this.options,
                requestHash,
            );
            const staticProposal = requiresBodyHydration
                ? null
                : this.createStaticPlanProposal(request.operations, requestHash, now.iso);
            const domains = predictDomains(this.manifest, request.operations);
            const projectChanged = staticProposal
                ? staticProposal.projectMetadata.name !== this.projectMetadata.name
                : request.operations.some((operation) => operation.type === 'project.set-name');
            const changed = staticProposal
                ? staticProposal.planned.changed || projectChanged
                : !detectStableNoop(this.manifest, this.projectMetadata, request.operations);
            const noOpReason = staticProposal && !changed
                ? staticProposal.planned.noOpReason ?? 'unchanged'
                : detectStableNoop(this.manifest, this.projectMetadata, request.operations);
            const plannedManifest = staticProposal?.planned.manifest;
            const plan: EditorCommandPlanSuccess = {
                ok: true,
                planId,
                requestHash,
                expiresAt: new Date(expiresAtMs).toISOString(),
                base: currentRevisions(
                    this.manifest,
                    this.options.sessionEpoch,
                    this.sessionRevision,
                ),
                normalizedOperations: structuredClone(request.operations),
                aliases: staticProposal?.planned.aliases ?? preliminaryAliases,
                predicted: {
                    sessionRevision: this.sessionRevision + (changed ? 1 : 0),
                    documentRevision: plannedManifest?.revision ?? (
                        this.manifest.revision + (changed && hasDocumentOperation ? 1 : 0)
                    ),
                    audioGraphRevision: plannedManifest?.audioGraphRevision ?? (
                        this.manifest.audioGraphRevision + (changed && domains.audio ? 1 : 0)
                    ),
                    ...(plannedManifest?.narrative
                        ? { narrativeRevision: plannedManifest.narrative.revision }
                        : this.manifest.narrative || domains.narrative
                        ? {
                            narrativeRevision: (this.manifest.narrative?.revision
                                ?? this.manifest.revision) + (changed && domains.narrative ? 1 : 0),
                        }
                        : {}),
                },
                affectedIds: staticProposal?.planned.affectedIds
                    ?? collectOperationIds(request.operations),
                history: request.history ?? {
                    label: staticProposal?.planned.label ?? (
                        request.operations.length === 1
                            ? request.operations[0].type
                            : `Apply ${request.operations.length} editor operations`
                    ),
                    category: staticProposal?.planned.category ?? (
                        request.operations.length === 1
                            ? request.operations[0].type.split('.')[0]
                            : 'compound-edit'
                    ),
                },
                ...(noOpReason ? { noOpReason } : {}),
                requiresHydration: requiresBodyHydration
                    || Boolean(this.manifest.narrative && hasDocumentOperation)
                    || requiredAssets.videoSourceIds.length > 0
                    || requiredAssets.audioSourceIds.length > 0,
                warnings: [],
            };
            this.plans.set(planId, {
                plan: structuredClone(plan),
                operations: structuredClone(request.operations),
                expiresAtMs,
            });
            return structuredClone(plan);
        } catch (error) {
            return toEditorCommandFailure(error);
        }
    }

    private createStaticPlanProposal(
        operations: readonly EditorSemanticOperation[],
        requestHash: string,
        nowIso: string,
    ): {
        projectMetadata: EditorProjectMetadata;
        planned: ReturnType<typeof applyEditorOperationBatch>;
    } {
        const projectMetadata = applyProjectMetadataOperations(this.projectMetadata, operations);
        const manifestOperations = operations.filter(
            (operation) => operation.type !== 'project.set-name',
        );
        if (manifestOperations.length === 0) {
            return {
                projectMetadata,
                planned: {
                    manifest: structuredClone(this.manifest),
                    aliases: {},
                    affectedIds: [],
                    changed: false,
                    noOpReason: 'unchanged',
                    label: 'No changes',
                    category: 'no-op',
                    audioGraphChanged: false,
                    narrativeChanged: false,
                },
            };
        }
        return {
            projectMetadata,
            planned: applyEditorOperationBatch(this.manifest, manifestOperations, {
                commandScope: `${this.options.projectId}:${requestHash}`,
                nowIso,
                ids: this.options.ports.ids,
                assets: createDescriptorAssetHydration(this.manifest),
                bodies: {} as ResolvedEditorialTranscriptMapV1,
                validationMode: 'structural',
            }),
        };
    }

    dispatch(rawRequest: EditorCommandBatchRequest): Promise<EditorCommandResult> {
        if (this.closing || this.closed) {
            return Promise.resolve(toEditorCommandFailure(new EditorCommandError(
                'COORDINATOR_UNAVAILABLE',
                'The editor engine is closing or closed.',
            )));
        }
        return this.enqueue(() => this.dispatchSerial(rawRequest));
    }

    importMedia(
        rawRequest: EditorMediaImportRequest,
        hydration?: EditorAssetHydration,
    ): Promise<EditorMediaImportResult> {
        if (this.closing || this.closed) {
            return Promise.resolve(toEditorCommandFailure(new EditorCommandError(
                'COORDINATOR_UNAVAILABLE',
                'The editor engine is closing or closed.',
            )));
        }
        return this.enqueue(() => this.importMediaSerial(rawRequest, hydration));
    }

    publishEditorialTranscription(
        rawRequest: EditorialTranscriptionPublicationRequest,
        hydration?: EditorialTranscriptionPublicationHydration,
    ): Promise<EditorialTranscriptionPublicationResult> {
        if (this.closing || this.closed) {
            return Promise.resolve(toEditorCommandFailure(new EditorCommandError(
                'COORDINATOR_UNAVAILABLE',
                'The editor engine is closing or closed.',
            )));
        }
        return this.enqueue(
            () => this.publishEditorialTranscriptionSerial(rawRequest, hydration),
        );
    }

    publishSubtitleTranscription(
        rawRequest: SubtitleTranscriptionPublicationRequest,
    ): Promise<SubtitleTranscriptionPublicationResult> {
        if (this.closing || this.closed) {
            return Promise.resolve(toEditorCommandFailure(new EditorCommandError(
                'COORDINATOR_UNAVAILABLE',
                'The editor engine is closing or closed.',
            )));
        }
        return this.enqueue(() => this.publishSubtitleTranscriptionSerial(rawRequest));
    }

    undo(rawRequest: HistoryMutationRequest): Promise<EditorCommandResult> {
        return this.historyMutation('undo', rawRequest);
    }

    redo(rawRequest: HistoryMutationRequest): Promise<EditorCommandResult> {
        return this.historyMutation('redo', rawRequest);
    }

    jumpToHistory(rawRequest: HistoryJumpRequest): Promise<EditorCommandResult> {
        if (this.closing || this.closed) {
            return Promise.resolve(toEditorCommandFailure(new EditorCommandError(
                'COORDINATOR_UNAVAILABLE',
                'The editor engine is closing or closed.',
            )));
        }
        return this.enqueue(() => this.historyMutationSerial('jump', rawRequest));
    }

    subscribe(listener: EditorEngineListener): () => void {
        this.assertOpen();
        this.listeners.add(listener);
        let subscribed = true;
        return () => {
            if (!subscribed) return;
            subscribed = false;
            this.listeners.delete(listener);
        };
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        this.closePromise = this.queue.then(async () => {
            this.listeners.clear();
            this.plans.clear();
            if (this.options.closePorts ?? true) {
                const closers = [
                    () => this.options.ports.playback?.close?.(),
                    () => this.options.ports.events.close?.(),
                    () => this.options.ports.transcripts.close?.(),
                    () => this.options.ports.assets.close?.(),
                    () => this.options.ports.persistence.close?.(),
                    () => this.options.ports.diagnostics?.close?.(),
                ].map((close) => Promise.resolve().then(close));
                const results = await Promise.allSettled(closers);
                const rejected = results.find((result) => result.status === 'rejected');
                if (rejected?.status === 'rejected') {
                    this.recordDiagnostics({
                        kind: 'close',
                        projectId: this.options.projectId,
                        message: 'One or more editor ports failed to close.',
                    });
                }
            }
            this.closed = true;
            this.closing = false;
            this.recordDiagnostics({
                kind: 'close',
                projectId: this.options.projectId,
            });
        });
        return this.closePromise;
    }

    private async dispatchSerial(rawRequest: EditorCommandBatchRequest): Promise<EditorCommandResult> {
        let commandId: string | undefined;
        try {
            const request = parseEditorCommandBatchRequest(rawRequest);
            if (request.toolName !== EDITOR_APPLY_TOOL_NAME) {
                throw new EditorCommandError(
                    'INVALID_REQUEST',
                    `Dispatch requires toolName "${EDITOR_APPLY_TOOL_NAME}".`,
                );
            }
            const requestHash = canonicalRequestDigest(request);

            // Durable receipt resolution intentionally precedes epoch and every revision guard.
            const replay = await this.resolveReceipt(
                request.toolName,
                request.idempotencyKey,
                requestHash,
            );
            if (replay) return replay;

            const resolved = this.resolveDispatchOperations(request);
            const operations = resolved.operations;
            this.assertGuards(request.sessionEpoch, request.expected);
            this.assertRequiredDomainGuards(request.expected, operations);
            commandId = this.options.ports.ids.generate(
                'command',
                `${this.options.projectId}:${request.toolName}:${request.idempotencyKey}`,
            );
            const now = this.options.ports.clock.now();
            const before = this.snapshot();
            const nextProjectMetadata = applyProjectMetadataOperations(
                this.projectMetadata,
                operations,
            );
            const manifestOperations = operations.filter(
                (operation) => operation.type !== 'project.set-name',
            );
            const assets = await this.hydrateAssets(
                this.manifest,
                collectRequiredAssetIds(this.manifest, manifestOperations),
            );
            const bodies = await this.hydrateTranscripts(this.manifest, manifestOperations);
            const planned = manifestOperations.length === 0
                ? {
                    manifest: structuredClone(this.manifest),
                    aliases: {},
                    affectedIds: [],
                    changed: false,
                    noOpReason: 'unchanged',
                    label: 'No changes',
                    category: 'no-op',
                    audioGraphChanged: false,
                    narrativeChanged: false,
                }
                : applyEditorOperationBatch(this.manifest, manifestOperations, {
                    commandScope: resolved.planRequestHash
                        ? `${this.options.projectId}:${resolved.planRequestHash}`
                        : `${this.options.projectId}:${commandId}`,
                    nowIso: now.iso,
                    ids: this.options.ports.ids,
                    assets,
                    bodies,
                });
            const projectChanged = nextProjectMetadata.name !== this.projectMetadata.name;
            if (!planned.changed && !projectChanged) {
                const semanticResult: Omit<EditorCommandSuccess, 'snapshot' | 'replayed'> = {
                    ok: true,
                    commandId,
                    ...(request.planId ? { planId: request.planId } : {}),
                    noOp: true,
                    noOpReason: planned.noOpReason ?? 'unchanged',
                    historyEntryId: null,
                    eventId: null,
                    aliases: planned.aliases,
                    warnings: [],
                };
                const receipt: EditorIdempotencyReceipt = {
                    toolName: request.toolName,
                    idempotencyKey: request.idempotencyKey,
                    requestHash,
                    result: semanticResult,
                };
                await this.options.ports.persistence.commit(this.createCommit({
                    toolName: request.toolName,
                    commandId,
                    operationIds: operations.map((operation) => operation.operationId),
                    preparedAt: now.iso,
                    previous: before,
                    next: before,
                    history: this.history,
                    event: null,
                    idempotencyKey: request.idempotencyKey,
                    receipt,
                }));
                this.recordDiagnostics({
                    kind: 'noop',
                    projectId: this.options.projectId,
                    commandId,
                });
                return {
                    ...semanticResult,
                    replayed: false,
                    snapshot: this.snapshot(),
                };
            }

            const summary = createHistorySummary({
                id: this.options.ports.ids.generate(
                    'history',
                    `${this.options.projectId}:${commandId}`,
                ),
                label: request.history?.label ?? (
                    projectChanged && !planned.changed ? 'Set project name' : planned.label
                ),
                category: request.history?.category ?? (
                    projectChanged && !planned.changed ? 'project' : planned.category
                ),
                operationIds: operations.map((operation) => operation.operationId),
                occurredAt: now.iso,
                before: this.manifest,
                after: planned.manifest,
                fromSessionRevision: this.sessionRevision,
                toSessionRevision: this.sessionRevision + 1,
            });
            const historyEntry = createEditorHistoryEntry({
                before: this.manifest,
                after: planned.manifest,
                beforeProject: this.projectMetadata,
                afterProject: nextProjectMetadata,
                summary,
            });
            const nextHistory = appendEditorHistory(this.history, historyEntry);
            const next = createSnapshot(
                this.options.projectId,
                this.options.sessionEpoch,
                this.sessionRevision + 1,
                nextProjectMetadata,
                planned.manifest,
                nextHistory,
                this.historySummaryLimit,
            );
            const event = this.createMutationEvent(
                commandId,
                operations.map((operation) => operation.operationId),
                summary.id,
                next.revisions,
                now.iso,
            );
            const semanticResult: Omit<EditorCommandSuccess, 'snapshot' | 'replayed'> = {
                ok: true,
                commandId,
                ...(request.planId ? { planId: request.planId } : {}),
                noOp: false,
                historyEntryId: summary.id,
                eventId: event.id,
                aliases: planned.aliases,
                warnings: [],
            };
            const receipt: EditorIdempotencyReceipt = {
                toolName: request.toolName,
                idempotencyKey: request.idempotencyKey,
                requestHash,
                result: semanticResult,
            };
            const commit = this.createCommit({
                toolName: request.toolName,
                commandId,
                operationIds: operations.map((operation) => operation.operationId),
                preparedAt: now.iso,
                previous: before,
                next,
                history: nextHistory,
                event,
                idempotencyKey: request.idempotencyKey,
                receipt,
            });

            // This is the only mutation durability boundary. Nothing becomes visible before it.
            await this.options.ports.persistence.commit(commit);
            this.eventSequence = event.sequence;
            this.sessionRevision += 1;
            this.projectMetadata = structuredClone(nextProjectMetadata);
            this.manifest = structuredClone(planned.manifest);
            this.history = cloneHistoryState(nextHistory);
            await this.publish(next, event);
            this.recordDiagnostics({
                kind: 'commit',
                projectId: this.options.projectId,
                commandId,
            });
            return { ...semanticResult, replayed: false, snapshot: this.snapshot() };
        } catch (error) {
            this.recordDiagnostics({
                kind: 'failure',
                projectId: this.options.projectId,
                ...(commandId ? { commandId } : {}),
                message: error instanceof Error ? error.message : 'Unknown engine failure.',
            });
            return toEditorCommandFailure(error);
        }
    }

    private async importMediaSerial(
        rawRequest: EditorMediaImportRequest,
        hydration?: EditorAssetHydration,
    ): Promise<EditorMediaImportResult> {
        let commandId: string | undefined;
        try {
            const request = parseMediaImportRequest(rawRequest);
            const requestHash = canonicalRequestDigest(request);

            // An exact replay does not need a still-live media capability or current revisions.
            const replay = await this.resolveReceipt(
                request.toolName,
                request.idempotencyKey,
                requestHash,
            );
            if (replay) {
                if (!replay.ok
                    || !('sourceIds' in replay)
                    || !Array.isArray(replay.sourceIds)
                    || !('placedClipIds' in replay)
                    || !Array.isArray(replay.placedClipIds)) {
                    throw new EditorCommandError(
                        'INTERNAL_ERROR',
                        'The durable media-import receipt is invalid.',
                    );
                }
                return replay as EditorMediaImportSuccess;
            }

            this.assertGuards(request.sessionEpoch, request.expected);
            this.assertMediaImportDomainGuards(request);
            if (!hydration) {
                throw new EditorCommandError(
                    'INVALID_REQUEST',
                    'A new media import requires verified source hydration.',
                );
            }
            commandId = this.options.ports.ids.generate(
                'command',
                `${this.options.projectId}:${request.toolName}:${request.idempotencyKey}`,
            );
            const now = this.options.ports.clock.now();
            const before = this.snapshot();
            const reused = collectReusedImportSourceIds(this.manifest, request);
            const existingHydration = await this.hydrateAssets(this.manifest, reused);
            const prepared = prepareEditorMediaImport({
                current: this.manifest,
                request,
                hydration,
                existingHydration,
            });
            const bodies = prepared.descriptorChanged || request.placement.kind === 'place'
                ? await this.hydrateTranscripts(this.manifest, [], true)
                : {} as ResolvedEditorialTranscriptMapV1;
            const proposal = applyPreparedEditorMediaImport({
                prepared,
                placement: request.placement,
                commandScope: `${this.options.projectId}:${commandId}`,
                nowIso: now.iso,
                ids: this.options.ports.ids,
                bodies,
            });

            if (!proposal.changed) {
                const semanticResult: Omit<EditorMediaImportSuccess, 'snapshot' | 'replayed'> = {
                    ok: true,
                    commandId,
                    noOp: true,
                    noOpReason: proposal.noOpReason ?? 'sources-already-registered',
                    historyEntryId: null,
                    eventId: null,
                    aliases: {},
                    warnings: [],
                    sourceIds: [...proposal.sourceIds],
                    placedClipIds: [],
                };
                const receipt: EditorIdempotencyReceipt = {
                    toolName: request.toolName,
                    idempotencyKey: request.idempotencyKey,
                    requestHash,
                    result: semanticResult,
                };
                await this.options.ports.persistence.commit(this.createCommit({
                    toolName: request.toolName,
                    commandId,
                    operationIds: ['media.import'],
                    preparedAt: now.iso,
                    previous: before,
                    next: before,
                    history: this.history,
                    event: null,
                    idempotencyKey: request.idempotencyKey,
                    receipt,
                }));
                this.recordDiagnostics({
                    kind: 'noop',
                    projectId: this.options.projectId,
                    commandId,
                });
                return {
                    ...semanticResult,
                    replayed: false,
                    snapshot: this.snapshot(),
                };
            }

            const summary = createHistorySummary({
                id: this.options.ports.ids.generate(
                    'history',
                    `${this.options.projectId}:${commandId}`,
                ),
                label: 'Import media',
                category: 'media',
                operationIds: ['media.import'],
                occurredAt: now.iso,
                before: this.manifest,
                after: proposal.manifest,
                fromSessionRevision: this.sessionRevision,
                toSessionRevision: this.sessionRevision + 1,
            });
            const historyEntry = createEditorHistoryEntry({
                before: this.manifest,
                after: proposal.manifest,
                beforeProject: this.projectMetadata,
                afterProject: this.projectMetadata,
                summary,
            });
            const nextHistory = appendEditorHistory(this.history, historyEntry);
            const next = createSnapshot(
                this.options.projectId,
                this.options.sessionEpoch,
                this.sessionRevision + 1,
                this.projectMetadata,
                proposal.manifest,
                nextHistory,
                this.historySummaryLimit,
            );
            const event = this.createMutationEvent(
                commandId,
                ['media.import'],
                summary.id,
                next.revisions,
                now.iso,
            );
            const semanticResult: Omit<EditorMediaImportSuccess, 'snapshot' | 'replayed'> = {
                ok: true,
                commandId,
                noOp: false,
                historyEntryId: summary.id,
                eventId: event.id,
                aliases: {},
                warnings: [],
                sourceIds: [...proposal.sourceIds],
                placedClipIds: [...proposal.placedClipIds],
            };
            const receipt: EditorIdempotencyReceipt = {
                toolName: request.toolName,
                idempotencyKey: request.idempotencyKey,
                requestHash,
                result: semanticResult,
            };
            await this.options.ports.persistence.commit(this.createCommit({
                toolName: request.toolName,
                commandId,
                operationIds: ['media.import'],
                preparedAt: now.iso,
                previous: before,
                next,
                history: nextHistory,
                event,
                idempotencyKey: request.idempotencyKey,
                receipt,
                sourceRegistrations: proposal.sourceRegistrations,
            }));
            this.eventSequence = event.sequence;
            this.sessionRevision += 1;
            this.manifest = structuredClone(proposal.manifest);
            this.history = cloneHistoryState(nextHistory);
            await this.publish(next, event);
            this.recordDiagnostics({
                kind: 'commit',
                projectId: this.options.projectId,
                commandId,
            });
            return {
                ...semanticResult,
                replayed: false,
                snapshot: this.snapshot(),
            };
        } catch (error) {
            this.recordDiagnostics({
                kind: 'failure',
                projectId: this.options.projectId,
                ...(commandId ? { commandId } : {}),
                message: error instanceof Error ? error.message : 'Unknown media-import failure.',
            });
            return toEditorCommandFailure(error);
        }
    }

    private async publishEditorialTranscriptionSerial(
        rawRequest: EditorialTranscriptionPublicationRequest,
        hydration?: EditorialTranscriptionPublicationHydration,
    ): Promise<EditorialTranscriptionPublicationResult> {
        let commandId: string | undefined;
        try {
            const request = parseEditorialTranscriptionPublicationRequest(rawRequest);
            const requestHash = canonicalRequestDigest(request);

            // Replays intentionally require neither live transcript bodies nor current guards.
            const replay = await this.resolveReceipt<EditorialTranscriptionPublicationResult>(
                request.toolName,
                request.idempotencyKey,
                requestHash,
            );
            if (replay) {
                if (!replay.ok
                    || !('publicationKind' in replay)
                    || replay.publicationKind !== 'editorial'
                    || !('recordIds' in replay)
                    || !Array.isArray(replay.recordIds)
                    || !('coverageRecordIds' in replay)
                    || !Array.isArray(replay.coverageRecordIds)) {
                    throw new EditorCommandError(
                        'INTERNAL_ERROR',
                        'The durable editorial transcription receipt is invalid.',
                    );
                }
                return replay as EditorialTranscriptionPublicationSuccess;
            }

            this.assertTranscriptionPublicationCapability();
            this.assertGuards(request.sessionEpoch, request.expected);
            this.assertTranscriptionPublicationDomainGuards(request.expected);
            if (!hydration) {
                throw new EditorCommandError(
                    'INVALID_REQUEST',
                    'A new editorial transcription publication requires verified hydration.',
                );
            }
            commandId = this.options.ports.ids.generate(
                'command',
                `${this.options.projectId}:${request.toolName}:${request.idempotencyKey}`,
            );
            const prepared = await prepareEditorialTranscriptionPublication({
                current: this.manifest,
                request,
                hydration,
            });
            await this.validateTranscriptionCandidate(prepared.manifest, prepared.bodies);
            return await this.commitTranscriptionPublication({
                toolName: request.toolName,
                commandId,
                idempotencyKey: request.idempotencyKey,
                requestHash,
                manifest: prepared.manifest,
                changed: prepared.changed,
                noOpReason: 'editorial-transcription-already-published',
                operationIds: prepared.recordIds.map(
                    (recordId) => `transcription.publish.editorial:${recordId}`,
                ),
                label: prepared.recordIds.length === 1
                    ? 'Publish editorial transcription'
                    : `Publish ${prepared.recordIds.length} editorial transcriptions`,
                category: 'transcription',
                publication: prepared.commit,
                extras: {
                    publicationKind: 'editorial' as const,
                    recordIds: prepared.recordIds,
                    coverageRecordIds: prepared.coverageRecordIds,
                },
            });
        } catch (error) {
            this.recordDiagnostics({
                kind: 'failure',
                projectId: this.options.projectId,
                ...(commandId ? { commandId } : {}),
                message: error instanceof Error
                    ? error.message
                    : 'Unknown editorial transcription publication failure.',
            });
            return toEditorCommandFailure(error);
        }
    }

    private async publishSubtitleTranscriptionSerial(
        rawRequest: SubtitleTranscriptionPublicationRequest,
    ): Promise<SubtitleTranscriptionPublicationResult> {
        let commandId: string | undefined;
        try {
            const request = parseSubtitleTranscriptionPublicationRequest(rawRequest);
            const requestHash = canonicalRequestDigest(request);

            const replay = await this.resolveReceipt<SubtitleTranscriptionPublicationResult>(
                request.toolName,
                request.idempotencyKey,
                requestHash,
            );
            if (replay) {
                if (!replay.ok
                    || !('publicationKind' in replay)
                    || replay.publicationKind !== 'subtitle'
                    || !('trackIds' in replay)
                    || !Array.isArray(replay.trackIds)) {
                    throw new EditorCommandError(
                        'INTERNAL_ERROR',
                        'The durable subtitle transcription receipt is invalid.',
                    );
                }
                return replay as SubtitleTranscriptionPublicationSuccess;
            }

            this.assertTranscriptionPublicationCapability();
            this.assertGuards(request.sessionEpoch, request.expected);
            this.assertTranscriptionPublicationDomainGuards(request.expected);
            commandId = this.options.ports.ids.generate(
                'command',
                `${this.options.projectId}:${request.toolName}:${request.idempotencyKey}`,
            );
            const prepared = prepareSubtitleTranscriptionPublication({
                current: this.manifest,
                request,
                commandScope: `${this.options.projectId}:${commandId}`,
                ids: this.options.ports.ids,
            });
            return await this.commitTranscriptionPublication({
                toolName: request.toolName,
                commandId,
                idempotencyKey: request.idempotencyKey,
                requestHash,
                manifest: prepared.manifest,
                changed: prepared.changed,
                noOpReason: 'subtitle-transcription-already-published',
                operationIds: prepared.trackIds.map(
                    (trackId) => `transcription.publish.subtitle:${trackId}`,
                ),
                label: prepared.trackIds.length === 1
                    ? 'Publish subtitle transcription'
                    : `Publish subtitle transcription to ${prepared.trackIds.length} tracks`,
                category: 'transcription',
                publication: prepared.commit,
                extras: {
                    publicationKind: 'subtitle' as const,
                    trackIds: prepared.trackIds,
                },
            });
        } catch (error) {
            this.recordDiagnostics({
                kind: 'failure',
                projectId: this.options.projectId,
                ...(commandId ? { commandId } : {}),
                message: error instanceof Error
                    ? error.message
                    : 'Unknown subtitle transcription publication failure.',
            });
            return toEditorCommandFailure(error);
        }
    }

    private async commitTranscriptionPublication<
        TExtras extends {
            publicationKind: 'editorial' | 'subtitle';
        },
    >(input: {
        toolName:
            | typeof EDITORIAL_TRANSCRIPTION_PUBLICATION_TOOL_NAME
            | typeof SUBTITLE_TRANSCRIPTION_PUBLICATION_TOOL_NAME;
        commandId: string;
        idempotencyKey: string;
        requestHash: string;
        manifest: EditorManifestV4;
        changed: boolean;
        noOpReason: string;
        operationIds: string[];
        label: string;
        category: string;
        publication: EditorTranscriptionPublicationCommitV1;
        extras: TExtras;
    }): Promise<EditorCommandSuccess & TExtras> {
        const now = this.options.ports.clock.now();
        const before = this.snapshot();
        if (!input.changed) {
            const durableSemanticResult: Omit<
                EditorCommandSuccess & TExtras,
                'snapshot' | 'replayed'
            > = {
                ok: true,
                commandId: input.commandId,
                noOp: true,
                noOpReason: input.noOpReason,
                historyEntryId: null,
                eventId: null,
                aliases: {},
                warnings: [],
                ...structuredClone(input.extras),
            } as Omit<EditorCommandSuccess & TExtras, 'snapshot' | 'replayed'>;
            const receipt: EditorIdempotencyReceipt = {
                toolName: input.toolName,
                idempotencyKey: input.idempotencyKey,
                requestHash: input.requestHash,
                result: durableSemanticResult,
            };
            await this.options.ports.persistence.commit(this.createCommit({
                toolName: input.toolName,
                commandId: input.commandId,
                operationIds: input.operationIds,
                preparedAt: now.iso,
                previous: before,
                next: before,
                history: this.history,
                event: null,
                idempotencyKey: input.idempotencyKey,
                receipt,
                transcriptionPublication: input.publication,
            }));
            this.recordDiagnostics({
                kind: 'noop',
                projectId: this.options.projectId,
                commandId: input.commandId,
            });
            return {
                ...durableSemanticResult,
                replayed: false,
                snapshot: this.snapshot(),
            } as EditorCommandSuccess & TExtras;
        }

        const summary = createHistorySummary({
            id: this.options.ports.ids.generate(
                'history',
                `${this.options.projectId}:${input.commandId}`,
            ),
            label: input.label,
            category: input.category,
            operationIds: input.operationIds,
            occurredAt: now.iso,
            before: this.manifest,
            after: input.manifest,
            fromSessionRevision: this.sessionRevision,
            toSessionRevision: this.sessionRevision + 1,
        });
        const historyEntry = createEditorHistoryEntry({
            before: this.manifest,
            after: input.manifest,
            beforeProject: this.projectMetadata,
            afterProject: this.projectMetadata,
            summary,
        });
        const nextHistory = appendEditorHistory(this.history, historyEntry);
        const next = createSnapshot(
            this.options.projectId,
            this.options.sessionEpoch,
            this.sessionRevision + 1,
            this.projectMetadata,
            input.manifest,
            nextHistory,
            this.historySummaryLimit,
        );
        const event = this.createMutationEvent(
            input.commandId,
            input.operationIds,
            summary.id,
            next.revisions,
            now.iso,
        );
        const semanticResult: Omit<
            EditorCommandSuccess & TExtras,
            'snapshot' | 'replayed'
        > = {
            ok: true,
            commandId: input.commandId,
            noOp: false,
            historyEntryId: summary.id,
            eventId: event.id,
            aliases: {},
            warnings: [],
            ...structuredClone(input.extras),
        } as Omit<EditorCommandSuccess & TExtras, 'snapshot' | 'replayed'>;
        const receipt: EditorIdempotencyReceipt = {
            toolName: input.toolName,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            result: semanticResult,
        };
        await this.options.ports.persistence.commit(this.createCommit({
            toolName: input.toolName,
            commandId: input.commandId,
            operationIds: input.operationIds,
            preparedAt: now.iso,
            previous: before,
            next,
            history: nextHistory,
            event,
            idempotencyKey: input.idempotencyKey,
            receipt,
            transcriptionPublication: input.publication,
        }));
        this.eventSequence = event.sequence;
        this.sessionRevision += 1;
        this.manifest = structuredClone(input.manifest);
        this.history = cloneHistoryState(nextHistory);
        await this.publish(next, event);
        this.recordDiagnostics({
            kind: 'commit',
            projectId: this.options.projectId,
            commandId: input.commandId,
        });
        return {
            ...semanticResult,
            replayed: false,
            snapshot: this.snapshot(),
        } as EditorCommandSuccess & TExtras;
    }

    private historyMutation(
        action: 'undo' | 'redo',
        rawRequest: HistoryMutationRequest,
    ): Promise<EditorCommandResult> {
        if (this.closing || this.closed) {
            return Promise.resolve(toEditorCommandFailure(new EditorCommandError(
                'COORDINATOR_UNAVAILABLE',
                'The editor engine is closing or closed.',
            )));
        }
        return this.enqueue(() => this.historyMutationSerial(action, rawRequest));
    }

    private async historyMutationSerial(
        action: 'undo' | 'redo' | 'jump',
        rawRequest: HistoryMutationRequest | HistoryJumpRequest,
    ): Promise<EditorCommandResult> {
        let commandId: string | undefined;
        try {
            const request = parseHistoryRequest(rawRequest, action);
            const requestHash = canonicalRequestDigest(request);
            const replay = await this.resolveReceipt(
                request.toolName,
                request.idempotencyKey,
                requestHash,
            );
            if (replay) return replay;
            this.assertGuards(request.sessionEpoch, request.expected);
            this.assertHistoryDomainGuards(request.expected);
            commandId = this.options.ports.ids.generate(
                'command',
                `${this.options.projectId}:${request.toolName}:${request.idempotencyKey}`,
            );
            const moved = action === 'jump'
                ? jumpEditorHistory({
                    manifest: this.manifest,
                    projectMetadata: this.projectMetadata,
                    state: this.history,
                    entryId: (request as HistoryJumpRequest).entryId,
                    position: (request as HistoryJumpRequest).position,
                })
                : moveEditorHistory({
                    manifest: this.manifest,
                    projectMetadata: this.projectMetadata,
                    state: this.history,
                    direction: action,
                    steps: request.steps ?? 1,
                });
            if (!moved.changed) {
                const now = this.options.ports.clock.now();
                const snapshot = this.snapshot();
                const semanticResult: Omit<EditorCommandSuccess, 'snapshot' | 'replayed'> = {
                    ok: true,
                    commandId,
                    noOp: true,
                    noOpReason: action === 'undo' ? 'nothing-to-undo'
                        : action === 'redo' ? 'nothing-to-redo' : 'already-at-history-position',
                    historyEntryId: null,
                    eventId: null,
                    aliases: {},
                    warnings: [],
                };
                const receipt: EditorIdempotencyReceipt = {
                    toolName: request.toolName,
                    idempotencyKey: request.idempotencyKey,
                    requestHash,
                    result: semanticResult,
                };
                await this.options.ports.persistence.commit(this.createCommit({
                    toolName: request.toolName,
                    commandId,
                    operationIds: [`history.${action}`],
                    preparedAt: now.iso,
                    previous: snapshot,
                    next: snapshot,
                    history: this.history,
                    event: null,
                    idempotencyKey: request.idempotencyKey,
                    receipt,
                }));
                return {
                    ...semanticResult,
                    replayed: false,
                    snapshot,
                };
            }
            const candidate = await this.finalizeHistoryManifest(moved.manifest);
            const now = this.options.ports.clock.now();
            const before = this.snapshot();
            const next = createSnapshot(
                this.options.projectId,
                this.options.sessionEpoch,
                this.sessionRevision + 1,
                moved.projectMetadata,
                candidate,
                moved.state,
                this.historySummaryLimit,
            );
            const event = this.createHistoryEvent(
                commandId,
                action,
                moved.entryId,
                next.revisions,
                now.iso,
            );
            const semanticResult: Omit<EditorCommandSuccess, 'snapshot' | 'replayed'> = {
                ok: true,
                commandId,
                noOp: false,
                historyEntryId: moved.entryId,
                eventId: event.id,
                aliases: {},
                warnings: [],
            };
            const receipt: EditorIdempotencyReceipt = {
                toolName: request.toolName,
                idempotencyKey: request.idempotencyKey,
                requestHash,
                result: semanticResult,
            };
            await this.options.ports.persistence.commit(this.createCommit({
                toolName: request.toolName,
                commandId,
                operationIds: [`history.${action}`],
                preparedAt: now.iso,
                previous: before,
                next,
                history: moved.state,
                event,
                idempotencyKey: request.idempotencyKey,
                receipt,
            }));
            this.eventSequence = event.sequence;
            this.sessionRevision += 1;
            this.projectMetadata = structuredClone(moved.projectMetadata);
            this.manifest = structuredClone(candidate);
            this.history = cloneHistoryState(moved.state);
            await this.publish(next, event);
            return { ...semanticResult, replayed: false, snapshot: this.snapshot() };
        } catch (error) {
            return toEditorCommandFailure(error);
        }
    }

    private async resolveReceipt<
        TResult extends
            | EditorCommandResult
            | EditorialTranscriptionPublicationResult
            | SubtitleTranscriptionPublicationResult = EditorCommandResult,
    >(
        toolName: EditorMutationToolName,
        idempotencyKey: string,
        requestHash: string,
    ): Promise<TResult | null> {
        const receipt = await this.options.ports.persistence.getReceipt(
            this.options.projectId,
            toolName,
            idempotencyKey,
        );
        if (!receipt) return null;
        if (receipt.requestHash !== requestHash) {
            throw new EditorCommandError(
                'IDEMPOTENCY_KEY_CONFLICT',
                'The idempotency key was already used for a different request.',
            );
        }
        return {
            ...structuredClone(receipt.result),
            ok: true,
            replayed: true,
            snapshot: this.snapshot(),
        } as TResult;
    }

    private resolveDispatchOperations(request: EditorCommandBatchRequest): {
        operations: EditorSemanticOperation[];
        planRequestHash?: string;
    } {
        if (request.operations) return { operations: structuredClone(request.operations) };
        const stored = this.plans.get(request.planId!);
        if (!stored) throw new EditorCommandError('PLAN_NOT_FOUND', 'The editor plan does not exist.');
        const now = this.options.ports.clock.now();
        if (stored.expiresAtMs < now.epochMs) {
            this.plans.delete(request.planId!);
            throw new EditorCommandError('PLAN_EXPIRED', 'The editor plan has expired.');
        }
        if (!sameRevisions(stored.plan.base, currentRevisions(
            this.manifest,
            this.options.sessionEpoch,
            this.sessionRevision,
        ))) {
            throw new EditorCommandError('PLAN_INPUT_CHANGED', 'The editor plan base state has changed.');
        }
        return {
            operations: structuredClone(stored.operations),
            planRequestHash: stored.plan.requestHash,
        };
    }

    private assertGuards(sessionEpoch: string, expected: EditorExpectedRevisions): void {
        if (sessionEpoch !== this.options.sessionEpoch) {
            throw new EditorCommandError('SESSION_EPOCH_MISMATCH', 'The editor session epoch changed.', {
                retryable: true,
            });
        }
        if (expected.sessionRevision !== this.sessionRevision) {
            throw new EditorCommandError('SESSION_REVISION_CONFLICT', 'The editor session revision changed.', {
                retryable: true,
            });
        }
        if (expected.documentRevision !== this.manifest.revision) {
            throw new EditorCommandError('REVISION_CONFLICT', 'The editor document revision changed.', {
                retryable: true,
            });
        }
        if (expected.audioGraphRevision !== undefined
            && expected.audioGraphRevision !== this.manifest.audioGraphRevision) {
            throw new EditorCommandError('AUDIO_REVISION_CONFLICT', 'The editor audio graph revision changed.', {
                retryable: true,
            });
        }
        const narrativeRevision = this.manifest.narrative?.revision;
        if (expected.narrativeRevision !== undefined
            && expected.narrativeRevision !== narrativeRevision) {
            throw new EditorCommandError('NARRATIVE_REVISION_CONFLICT', 'The editor narrative revision changed.', {
                retryable: true,
            });
        }
    }

    private assertRequiredDomainGuards(
        expected: EditorExpectedRevisions,
        operations: readonly EditorSemanticOperation[],
    ): void {
        const domains = predictDomains(this.manifest, operations);
        if (domains.audio && expected.audioGraphRevision === undefined) {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                'Audio-dependent editor operations require expected.audioGraphRevision.',
            );
        }
        const dependsOnActiveNarrative = Boolean(this.manifest.narrative)
            && operations.some((operation) => (
                operation.type !== 'project.set-name'
                && operation.type !== 'render.set-background'
                && operation.type !== 'render.set-profile'
            ));
        if ((domains.narrative || dependsOnActiveNarrative)
            && this.manifest.narrative
            && expected.narrativeRevision === undefined) {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                'Narrative-dependent editor operations require expected.narrativeRevision.',
            );
        }
    }

    private assertHistoryDomainGuards(expected: EditorExpectedRevisions): void {
        if (expected.audioGraphRevision === undefined) {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                'History mutations require expected.audioGraphRevision.',
            );
        }
        if (this.manifest.narrative && expected.narrativeRevision === undefined) {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                'History mutations require expected.narrativeRevision for an active narrative.',
            );
        }
    }

    private assertMediaImportDomainGuards(request: EditorMediaImportRequest): void {
        if (request.placement.kind !== 'place') return;
        if (request.expected.audioGraphRevision === undefined) {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                'Placed media imports require expected.audioGraphRevision.',
            );
        }
        if (this.manifest.narrative && request.expected.narrativeRevision === undefined) {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                'Placed media imports require expected.narrativeRevision for an active narrative.',
            );
        }
    }

    private assertTranscriptionPublicationCapability(): void {
        if (!this.options.ports.persistence.capabilities?.transcriptionPublication) {
            throw new EditorCommandError(
                'COORDINATOR_UNAVAILABLE',
                'This editor persistence adapter does not support atomic transcription publication.',
            );
        }
    }

    private assertTranscriptionPublicationDomainGuards(
        expected: EditorExpectedRevisions,
    ): void {
        if (expected.audioGraphRevision === undefined) {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                'Transcription publication requires expected.audioGraphRevision.',
            );
        }
        if (this.manifest.narrative && expected.narrativeRevision === undefined) {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                'Transcription publication requires expected.narrativeRevision for an active narrative.',
            );
        }
    }

    private async validateTranscriptionCandidate(
        candidate: EditorManifestV4,
        publicationBodies: Record<string, import('@/types/editorial').EditorialTranscriptRecordBodyV1> = {},
    ): Promise<void> {
        const existingBodies = await this.hydrateTranscripts(this.manifest, [], true);
        const hydrated = validateHydratedEditorDocumentV4(
            manifestToPlanningDocument(
                candidate,
                createDescriptorAssetHydration(candidate),
            ),
            {
                ...existingBodies,
                ...publicationBodies,
            } as ResolvedEditorialTranscriptMapV1,
        );
        if (!hydrated.valid) {
            throw new EditorCommandError(
                'INVALID_DOCUMENT',
                'Transcription publication hydration validation failed.',
                { details: { issues: hydrated.issues.slice(0, 50) } },
            );
        }
    }

    private async hydrateAssets(
        manifest: EditorManifestV4,
        required: {
            videoSourceIds: readonly string[];
            audioSourceIds: readonly string[];
        },
    ): Promise<EditorAssetHydration> {
        const descriptorHydration = createDescriptorAssetHydration(manifest);
        if (required.videoSourceIds.length === 0 && required.audioSourceIds.length === 0) {
            return descriptorHydration;
        }
        const verified = await this.options.ports.assets.hydrate({
            manifest: structuredClone(manifest),
            videoSourceIds: [...required.videoSourceIds],
            audioSourceIds: [...required.audioSourceIds],
        });
        assertAssetHydration(manifest, verified, required);
        const verifiedVideo = new Map(verified.videoSources.map((source) => [source.id, source]));
        const verifiedAudio = new Map(verified.audioSources.map((source) => [source.id, source]));
        return {
            videoSources: descriptorHydration.videoSources.map((source) => (
                verifiedVideo.get(source.id) ?? source
            )),
            audioSources: descriptorHydration.audioSources.map((source) => (
                verifiedAudio.get(source.id) ?? source
            )),
        };
    }

    private async hydrateTranscripts(
        manifest: EditorManifestV4,
        operations: readonly EditorSemanticOperation[],
        force = false,
    ): Promise<ResolvedEditorialTranscriptMapV1> {
        if (!force && operations.length === 0) {
            return {} as unknown as ResolvedEditorialTranscriptMapV1;
        }
        const required = collectRequiredTranscriptIds(manifest, operations);
        if (required.length === 0) return {} as unknown as ResolvedEditorialTranscriptMapV1;
        const descriptors = new Map(manifest.editorialTranscriptDescriptors.map((value) => [
            value.recordId,
            value,
        ]));
        return this.options.ports.transcripts.hydrate({
            references: required.map((recordId) => {
                const descriptor = descriptors.get(recordId as Sha256Digest);
                return {
                    recordId,
                    descriptorVersion: descriptor?.version ?? 1,
                    sourceId: descriptor?.sourceId ?? 'unknown',
                    descriptor: structuredClone(descriptor ?? {}),
                };
            }),
        });
    }

    private async finalizeHistoryManifest(candidateValue: EditorManifestV4): Promise<EditorManifestV4> {
        const candidate = structuredClone(candidateValue);
        if (sameManifestSemantics(candidate, this.manifest)) {
            return structuredClone(this.manifest);
        }
        const assets = await this.hydrateAssets(
            candidate,
            collectChangedHistoryAssetIds(this.manifest, candidate),
        );
        const beforeDocument = manifestToPlanningDocument(
            this.manifest,
            createDescriptorAssetHydration(this.manifest),
        );
        const candidateDocument = manifestToPlanningDocument(candidate, assets);
        const audioChanged = getEditorEngineAudioGraphSignature(beforeDocument)
            !== getEditorEngineAudioGraphSignature(candidateDocument);
        const narrativeChanged = canonicalizeJson(this.manifest.narrative)
            !== canonicalizeJson(candidate.narrative);
        candidate.revision = this.manifest.revision + 1;
        candidate.audioGraphRevision = this.manifest.audioGraphRevision + (audioChanged ? 1 : 0);
        if (candidate.narrative && narrativeChanged) {
            candidate.narrative.revision = (this.manifest.narrative?.revision
                ?? this.manifest.revision) + 1;
        }
        const structural = validateEditorManifestV4(candidate);
        if (!structural.valid) {
            throw new EditorCommandError('INVALID_DOCUMENT', 'History produced an invalid V4 manifest.', {
                details: { issues: structural.issues.slice(0, 50) },
            });
        }
        const bodies = await this.hydrateTranscripts(candidate, [], true);
        const hydrated = validateHydratedEditorDocumentV4(
            manifestToPlanningDocument(candidate, assets),
            bodies,
        );
        if (!hydrated.valid) {
            throw new EditorCommandError('INVALID_DOCUMENT', 'History hydration validation failed.', {
                details: { issues: hydrated.issues.slice(0, 50) },
            });
        }
        return candidate;
    }

    private createCommit(input: {
        toolName: EditorMutationToolName;
        commandId: string;
        operationIds: string[];
        preparedAt: string;
        previous: EditorEngineSnapshot;
        next: EditorEngineSnapshot;
        history: EditorHistoryState;
        event: EditorEngineEvent | null;
        idempotencyKey: string;
        receipt: EditorIdempotencyReceipt;
        sourceRegistrations?: EditorAssetHydration;
        transcriptionPublication?: EditorTranscriptionPublicationCommitV1;
    }): EditorPersistenceCommit {
        const pins = collectHistoryPins(input.history);
        const sourcePins = collectSourcePins(input.history);
        return {
            schemaVersion: 1,
            projectId: this.options.projectId,
            toolName: input.toolName,
            commandId: input.commandId,
            transaction: {
                walTransactionId: this.options.ports.ids.generate(
                    'wal',
                    `${this.options.projectId}:${input.commandId}`,
                ),
                preparedAt: input.preparedAt,
                operationIds: [...input.operationIds],
                fromDocumentRevision: input.previous.revisions.documentRevision,
                toDocumentRevision: input.next.revisions.documentRevision,
            },
            sessionState: {
                sessionEpoch: this.options.sessionEpoch,
                sessionRevision: input.next.revisions.sessionRevision,
                eventSequence: input.event?.sequence ?? this.eventSequence,
                projectName: input.next.project.name,
                documentRevision: input.next.revisions.documentRevision,
                audioGraphRevision: input.next.revisions.audioGraphRevision,
                ...(input.next.revisions.narrativeRevision === undefined
                    ? {}
                    : { narrativeRevision: input.next.revisions.narrativeRevision }),
            },
            previous: structuredClone(input.previous),
            next: structuredClone(input.next),
            history: cloneHistoryState(input.history),
            transcriptPins: {
                durableRecordIds: collectManifestTranscriptRecordIds(input.next.manifest),
                ...pins,
            },
            sourcePins: {
                current: collectManifestSourceIds(input.next.manifest),
                history: sourcePins.history,
                redo: sourcePins.redo,
            },
            sourceRegistrations: structuredClone(input.sourceRegistrations ?? {
                videoSources: [],
                audioSources: [],
            }),
            transcriptionPublication: structuredClone(input.transcriptionPublication ?? null),
            event: structuredClone(input.event),
            receipt: {
                toolName: input.toolName,
                key: input.idempotencyKey,
                value: structuredClone(input.receipt),
            },
        };
    }

    private createMutationEvent(
        commandId: string,
        operationIds: string[],
        historyEntryId: string,
        revisions: EditorEngineRevisions,
        occurredAt: string,
    ): Extract<EditorEngineEvent, { type: 'project.mutated' }> {
        return {
            id: this.options.ports.ids.generate(
                'event',
                `${this.options.projectId}:${commandId}:mutation`,
            ),
            sequence: this.eventSequence + 1,
            type: 'project.mutated',
            projectId: this.options.projectId,
            occurredAt,
            commandId,
            operationIds: [...operationIds],
            historyEntryId,
            revisions: structuredClone(revisions),
        };
    }

    private createHistoryEvent(
        commandId: string,
        action: 'undo' | 'redo' | 'jump',
        historyEntryId: string | null,
        revisions: EditorEngineRevisions,
        occurredAt: string,
    ): Extract<EditorEngineEvent, { type: 'history.changed' }> {
        return {
            id: this.options.ports.ids.generate(
                'event',
                `${this.options.projectId}:${commandId}:history`,
            ),
            sequence: this.eventSequence + 1,
            type: 'history.changed',
            projectId: this.options.projectId,
            occurredAt,
            commandId,
            action,
            historyEntryId,
            revisions: structuredClone(revisions),
        };
    }

    private async publish(snapshot: EditorEngineSnapshot, event: EditorEngineEvent): Promise<void> {
        this.listeners.forEach((listener) => {
            try {
                listener(structuredClone(snapshot), structuredClone(event));
            } catch {
                // A listener cannot roll back an already durable engine transaction.
            }
        });
        await Promise.allSettled([
            Promise.resolve().then(() => this.options.ports.events.emit(structuredClone(event))),
            Promise.resolve().then(() => this.options.ports.playback?.onCommitted?.(
                structuredClone(snapshot),
                structuredClone(event),
            )),
        ]);
    }

    private recordDiagnostics(
        entry: {
            kind: 'commit' | 'noop' | 'failure' | 'close';
            projectId: string;
            commandId?: string;
            message?: string;
        },
    ): void {
        try {
            this.options.ports.diagnostics?.record?.(entry);
        } catch {
            // Diagnostics are observational and cannot affect authoritative editor state.
        }
    }

    private snapshot(): EditorEngineSnapshot {
        return createSnapshot(
            this.options.projectId,
            this.options.sessionEpoch,
            this.sessionRevision,
            this.projectMetadata,
            this.manifest,
            this.history,
            this.historySummaryLimit,
        );
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation, operation);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    private assertOpen(): void {
        if (this.closing || this.closed) {
            throw new EditorCommandError('COORDINATOR_UNAVAILABLE', 'The editor engine is closing or closed.');
        }
    }
}

function createSnapshot(
    projectId: string,
    sessionEpoch: string,
    sessionRevision: number,
    projectMetadata: EditorProjectMetadata,
    manifest: EditorManifestV4,
    history: EditorHistoryState,
    summaryLimit: number,
): EditorEngineSnapshot {
    const cloned = structuredClone(manifest);
    return {
        projectId,
        project: structuredClone(projectMetadata),
        manifest: cloned,
        revisions: currentRevisions(cloned, sessionEpoch, sessionRevision),
        history: {
            past: history.past.slice(-summaryLimit).map((entry) => structuredClone(entry.summary)),
            future: [...history.future].reverse().slice(0, summaryLimit)
                .map((entry) => structuredClone(entry.summary)),
            currentIndex: history.past.length,
        },
        assetReferences: {
            videoSourceIds: cloned.videoSourceDescriptors.map((source) => source.id),
            audioSourceIds: cloned.audioSourceDescriptors.map((source) => source.id),
            transcriptRecordIds: collectManifestTranscriptRecordIds(cloned),
        },
    };
}

function currentRevisions(
    manifest: EditorManifestV4,
    sessionEpoch: string,
    sessionRevision: number,
): EditorEngineRevisions {
    return {
        sessionEpoch,
        sessionRevision,
        documentRevision: manifest.revision,
        audioGraphRevision: manifest.audioGraphRevision,
        ...(manifest.narrative ? { narrativeRevision: manifest.narrative.revision } : {}),
    };
}

function createHistorySummary(input: {
    id: string;
    label: string;
    category: string;
    operationIds: string[];
    occurredAt: string;
    before: EditorManifestV4;
    after: EditorManifestV4;
    fromSessionRevision: number;
    toSessionRevision: number;
}): import('./editor-engine-types').EditorHistorySummary {
    return {
        id: input.id,
        label: input.label,
        category: input.category,
        operationIds: [...input.operationIds],
        occurredAt: input.occurredAt,
        from: {
            sessionRevision: input.fromSessionRevision,
            documentRevision: input.before.revision,
            audioGraphRevision: input.before.audioGraphRevision,
            ...(input.before.narrative ? { narrativeRevision: input.before.narrative.revision } : {}),
        },
        to: {
            sessionRevision: input.toSessionRevision,
            documentRevision: input.after.revision,
            audioGraphRevision: input.after.audioGraphRevision,
            ...(input.after.narrative ? { narrativeRevision: input.after.narrative.revision } : {}),
        },
    };
}

function parseHistoryRequest<T extends HistoryMutationRequest | HistoryJumpRequest>(
    raw: T,
    action: 'undo' | 'redo' | 'jump',
): T {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new EditorCommandError('INVALID_REQUEST', 'History request must be an object.');
    }
    const allowed = new Set([
        'apiVersion', 'toolName', 'sessionEpoch', 'expected', 'idempotencyKey', 'steps',
        ...(action === 'jump' ? ['entryId', 'position'] : []),
    ]);
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
        throw new EditorCommandError('INVALID_REQUEST', `History request contains unsupported field "${unknown[0]}".`);
    }
    if (raw.apiVersion !== EDITOR_ENGINE_API_VERSION
        || raw.toolName !== EDITOR_HISTORY_TOOL_NAME
        || typeof raw.sessionEpoch !== 'string' || raw.sessionEpoch.length === 0
        || typeof raw.idempotencyKey !== 'string' || raw.idempotencyKey.length === 0) {
        throw new EditorCommandError('INVALID_REQUEST', 'History request envelope is invalid.');
    }
    const expected = raw.expected;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
        throw new EditorCommandError('INVALID_REQUEST', 'History expected revisions must be an object.');
    }
    const expectedKeys = new Set([
        'sessionRevision',
        'documentRevision',
        'audioGraphRevision',
        'narrativeRevision',
    ]);
    if (Object.keys(expected).some((key) => !expectedKeys.has(key))
        || !Number.isSafeInteger(expected.sessionRevision)
        || expected.sessionRevision < 0
        || !Number.isSafeInteger(expected.documentRevision)
        || expected.documentRevision < 0
        || (expected.audioGraphRevision !== undefined
            && (!Number.isSafeInteger(expected.audioGraphRevision)
                || expected.audioGraphRevision < 0))
        || (expected.narrativeRevision !== undefined
            && (!Number.isSafeInteger(expected.narrativeRevision)
                || expected.narrativeRevision < 0))) {
        throw new EditorCommandError('INVALID_REQUEST', 'History revision guards are invalid.');
    }
    if (raw.steps !== undefined && (!Number.isSafeInteger(raw.steps) || raw.steps <= 0 || raw.steps > 500)) {
        throw new EditorCommandError('INVALID_REQUEST', 'History steps must be between 1 and 500.');
    }
    if (action === 'jump') {
        const jump = raw as HistoryJumpRequest;
        if (!jump.entryId || (jump.position !== 'before' && jump.position !== 'after')) {
            throw new EditorCommandError('INVALID_REQUEST', 'History jump target is invalid.');
        }
    }
    return structuredClone(raw);
}

function parseMediaImportRequest(raw: unknown): EditorMediaImportRequest {
    const encodedLength = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
    if (encodedLength > EDITOR_ENGINE_MAX_REQUEST_BYTES) {
        throw new EditorCommandError('PAYLOAD_TOO_LARGE', 'Media import request exceeds 512 KiB.');
    }
    const request = requireImportRecord(raw, 'Media import request');
    rejectImportKeys(request, new Set([
        'apiVersion',
        'toolName',
        'sessionEpoch',
        'expected',
        'idempotencyKey',
        'sources',
        'placement',
    ]), 'Media import request');
    if (request.apiVersion !== EDITOR_ENGINE_API_VERSION) {
        throw new EditorCommandError('UNSUPPORTED_API_VERSION', 'Unsupported editor engine API version.');
    }
    if (request.toolName !== EDITOR_MEDIA_IMPORT_TOOL_NAME
        || !isImportString(request.sessionEpoch)
        || !isImportString(request.idempotencyKey)) {
        throw new EditorCommandError('INVALID_REQUEST', 'Media import request envelope is invalid.');
    }

    const expected = requireImportRecord(request.expected, 'Media import expected revisions');
    rejectImportKeys(expected, new Set([
        'sessionRevision',
        'documentRevision',
        'audioGraphRevision',
        'narrativeRevision',
    ]), 'Media import expected revisions');
    if (!isRevision(expected.sessionRevision)
        || !isRevision(expected.documentRevision)
        || (expected.audioGraphRevision !== undefined && !isRevision(expected.audioGraphRevision))
        || (expected.narrativeRevision !== undefined && !isRevision(expected.narrativeRevision))) {
        throw new EditorCommandError('INVALID_REQUEST', 'Media import revision guards are invalid.');
    }

    const sources = requireImportRecord(request.sources, 'Media import sources');
    rejectImportKeys(sources, new Set([
        'videoSourceDescriptors',
        'audioSourceDescriptors',
    ]), 'Media import sources');
    if (!Array.isArray(sources.videoSourceDescriptors)
        || !Array.isArray(sources.audioSourceDescriptors)) {
        throw new EditorCommandError('INVALID_REQUEST', 'Media import descriptor lists are invalid.');
    }

    const placement = requireImportRecord(request.placement, 'Media import placement');
    if (placement.kind === 'register-only') {
        rejectImportKeys(placement, new Set(['kind']), 'Register-only media placement');
    } else if (placement.kind === 'place') {
        rejectImportKeys(placement, new Set([
            'kind',
            'ordering',
            'timelineStartFrame',
            'videoTrackId',
            'audioTrackId',
        ]), 'Natural media placement');
        if (placement.ordering !== 'natural'
            || !isRevision(placement.timelineStartFrame)
            || (placement.videoTrackId !== undefined && !isImportString(placement.videoTrackId))
            || (placement.audioTrackId !== undefined && !isImportString(placement.audioTrackId))) {
            throw new EditorCommandError('INVALID_REQUEST', 'Natural media placement is invalid.');
        }
    } else {
        throw new EditorCommandError('INVALID_REQUEST', 'Media import placement kind is invalid.');
    }
    return structuredClone(request) as unknown as EditorMediaImportRequest;
}

function requireImportRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new EditorCommandError('INVALID_REQUEST', `${label} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function rejectImportKeys(
    value: Record<string, unknown>,
    allowed: ReadonlySet<string>,
    label: string,
): void {
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown) {
        throw new EditorCommandError(
            'INVALID_REQUEST',
            `${label} contains unsupported field "${unknown}".`,
        );
    }
}

function isImportString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isRevision(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

function collectReusedImportSourceIds(
    manifest: EditorManifestV4,
    request: EditorMediaImportRequest,
): { videoSourceIds: string[]; audioSourceIds: string[] } {
    const video = new Set(manifest.videoSourceDescriptors.map((source) => source.id));
    const audio = new Set(manifest.audioSourceDescriptors.map((source) => source.id));
    return {
        videoSourceIds: request.sources.videoSourceDescriptors
            .map((source) => source.id)
            .filter((sourceId) => video.has(sourceId)),
        audioSourceIds: request.sources.audioSourceDescriptors
            .map((source) => source.id)
            .filter((sourceId) => audio.has(sourceId)),
    };
}

function collectRequiredTranscriptIds(
    manifest: EditorManifestV4,
    operations: readonly EditorSemanticOperation[],
): string[] {
    const ids = new Set<string>();
    manifest.narrative?.sourceRecordIds.forEach((id) => ids.add(id));
    operations.forEach((operation) => {
        const payload = operation.payload as Record<string, unknown>;
        if (typeof payload.recordId === 'string') ids.add(payload.recordId);
        if (operation.type === 'narrative.activate') {
            Object.values(operation.payload.recordIdBySourceId).forEach((id) => ids.add(id));
        }
    });
    return Array.from(ids).sort();
}

function collectRequiredAssetIds(
    manifest: EditorManifestV4,
    operations: readonly EditorSemanticOperation[],
): {
    videoSourceIds: string[];
    audioSourceIds: string[];
} {
    const video = new Set<string>();
    const audio = new Set<string>();
    const videoClipById = new Map(manifest.videoClips.map((clip) => [clip.id, clip]));
    const audioClipById = new Map(manifest.audioTracks.flatMap((track) => (
        track.clips.map((clip) => [clip.id, clip] as const)
    )));
    const addAudioClipSource = (clip: EditorManifestV4['audioTracks'][number]['clips'][number]): void => {
        if (clip.source.kind === 'audio-source') audio.add(clip.source.audioSourceId);
        else video.add(clip.source.videoSourceId);
    };

    operations.forEach((operation) => {
        if (operation.type === 'video-clip.insert') {
            video.add(operation.payload.sourceId);
            return;
        }
        if (operation.type === 'video-clip.relink-audio') {
            const clip = videoClipById.get(operation.payload.videoClipId);
            if (clip) video.add(clip.sourceId);
            const detached = audioClipById.get(operation.payload.audioClipId);
            if (detached) addAudioClipSource(detached);
            return;
        }
        switch (operation.type) {
            case 'video-clip.move':
            case 'video-clip.trim':
            case 'video-clip.split':
            case 'video-clip.delete':
            case 'video-clip.duplicate':
            case 'video-clip.set-order':
            case 'video-clip.set-audio':
            case 'video-clip.detach-audio': {
                const clip = videoClipById.get(operation.payload.clipId);
                if (clip) video.add(clip.sourceId);
                return;
            }
        }
        if (operation.type === 'audio-clip.insert') {
            addAudioClipSource(operation.payload.clip);
            return;
        }
        switch (operation.type) {
            case 'audio-clip.move':
            case 'audio-clip.trim':
            case 'audio-clip.split':
            case 'audio-clip.delete':
            case 'audio-clip.duplicate':
            case 'audio-clip.set-order':
            case 'audio-clip.set-gain':
            case 'audio-clip.set-fades': {
                const clip = audioClipById.get(operation.payload.clipId);
                if (clip) addAudioClipSource(clip);
                return;
            }
        }
        if (operation.type === 'track.delete') {
            if (operation.payload.trackKind === 'video') {
                manifest.videoClips
                    .filter((clip) => clip.trackId === operation.payload.trackId)
                    .forEach((clip) => video.add(clip.sourceId));
            } else if (operation.payload.trackKind === 'audio') {
                manifest.audioTracks.find((track) => track.id === operation.payload.trackId)
                    ?.clips.forEach(addAudioClipSource);
            }
            return;
        }
        if (operation.type.startsWith('narrative.')) {
            manifest.narrative?.blockIds.forEach((blockId) => {
                const block = manifest.narrative!.blocks[blockId];
                video.add(block.sourceId);
            });
            if ('sourceId' in operation.payload && typeof operation.payload.sourceId === 'string') {
                video.add(operation.payload.sourceId);
            }
            return;
        }
        if (operation.type.startsWith('link.') && 'target' in operation.payload) {
            const target = operation.payload.target;
            if (target.kind === 'video-clip') {
                const clip = videoClipById.get(target.clipId);
                if (clip) video.add(clip.sourceId);
            } else if (target.kind === 'audio-clip') {
                const clip = audioClipById.get(target.clipId);
                if (clip) addAudioClipSource(clip);
            }
        }
    });
    return {
        videoSourceIds: Array.from(video).sort(),
        audioSourceIds: Array.from(audio).sort(),
    };
}

function collectChangedHistoryAssetIds(
    current: EditorManifestV4,
    candidate: EditorManifestV4,
): { videoSourceIds: string[]; audioSourceIds: string[] } {
    const video = new Set<string>();
    const audio = new Set<string>();
    const currentVideoDescriptors = new Map(
        current.videoSourceDescriptors.map((source) => [source.id, source]),
    );
    const currentAudioDescriptors = new Map(
        current.audioSourceDescriptors.map((source) => [source.id, source]),
    );
    candidate.videoSourceDescriptors.forEach((source) => {
        if (!sameOptionalCanonicalJson(source, currentVideoDescriptors.get(source.id))) {
            video.add(source.id);
        }
    });
    candidate.audioSourceDescriptors.forEach((source) => {
        if (!sameOptionalCanonicalJson(source, currentAudioDescriptors.get(source.id))) {
            audio.add(source.id);
        }
    });

    const currentVideoClips = new Map(current.videoClips.map((clip) => [clip.id, clip]));
    const candidateVideoClips = new Map(candidate.videoClips.map((clip) => [clip.id, clip]));
    new Set([
        ...Array.from(currentVideoClips.keys()),
        ...Array.from(candidateVideoClips.keys()),
    ]).forEach((clipId) => {
        const before = currentVideoClips.get(clipId);
        const after = candidateVideoClips.get(clipId);
        if (sameOptionalCanonicalJson(before, after)) return;
        if (before) video.add(before.sourceId);
        if (after) video.add(after.sourceId);
    });

    const collectAudio = (
        manifest: EditorManifestV4,
    ): Map<string, EditorManifestV4['audioTracks'][number]['clips'][number]> => new Map(
        manifest.audioTracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)),
    );
    const currentAudioClips = collectAudio(current);
    const candidateAudioClips = collectAudio(candidate);
    const addAudioSource = (
        clip: EditorManifestV4['audioTracks'][number]['clips'][number],
    ): void => {
        if (clip.source.kind === 'audio-source') audio.add(clip.source.audioSourceId);
        else video.add(clip.source.videoSourceId);
    };
    new Set([
        ...Array.from(currentAudioClips.keys()),
        ...Array.from(candidateAudioClips.keys()),
    ]).forEach((clipId) => {
        const before = currentAudioClips.get(clipId);
        const after = candidateAudioClips.get(clipId);
        if (sameOptionalCanonicalJson(before, after)) return;
        if (before) addAudioSource(before);
        if (after) addAudioSource(after);
    });

    const currentBlocks = current.narrative?.blocks ?? {};
    const candidateBlocks = candidate.narrative?.blocks ?? {};
    new Set([...Object.keys(currentBlocks), ...Object.keys(candidateBlocks)]).forEach((blockId) => {
        const before = currentBlocks[blockId];
        const after = candidateBlocks[blockId];
        if (sameOptionalCanonicalJson(before, after)) return;
        if (before) video.add(before.sourceId);
        if (after) video.add(after.sourceId);
    });
    const candidateVideoIds = new Set(
        candidate.videoSourceDescriptors.map((source) => source.id),
    );
    const candidateAudioIds = new Set(
        candidate.audioSourceDescriptors.map((source) => source.id),
    );
    return {
        // Removed sources need no hydration to validate the target history projection. Asking the
        // repository for an ID absent from the candidate manifest would make placed imports
        // impossible to Undo; Redo still requests and verifies the restored descriptors.
        videoSourceIds: Array.from(video).filter((id) => candidateVideoIds.has(id)).sort(),
        audioSourceIds: Array.from(audio).filter((id) => candidateAudioIds.has(id)).sort(),
    };
}

function sameOptionalCanonicalJson(left: unknown, right: unknown): boolean {
    if (left === undefined || right === undefined) return left === right;
    return canonicalizeJson(left) === canonicalizeJson(right);
}

function collectOperationIds(operations: readonly EditorSemanticOperation[]): string[] {
    return Array.from(new Set(operations.flatMap((operation) => {
        const ids = [operation.operationId];
        visitStrings(operation.payload, (value) => {
            if (!value.startsWith('$')) ids.push(value);
        });
        return ids;
    }))).slice(0, 500);
}

function visitStrings(value: unknown, visitor: (value: string) => void): void {
    if (typeof value === 'string') visitor(value);
    else if (Array.isArray(value)) value.forEach((item) => visitStrings(item, visitor));
    else if (value && typeof value === 'object') {
        Object.values(value as Record<string, unknown>).forEach((item) => visitStrings(item, visitor));
    }
}

function requiresTranscriptHydration(operation: EditorSemanticOperation): boolean {
    return operation.type.startsWith('narrative.')
        && ![
            'narrative.release-tracks',
            'narrative.set-editing-mode',
            'narrative.merge-blocks',
            'narrative.reorder-blocks',
            'narrative.set-speaker-visibility',
            'narrative.change-block-margin',
            'narrative.change-global-margins',
            'narrative.delete-all-silences',
        ].includes(operation.type);
}

function predictDomains(
    manifest: EditorManifestV4,
    operations: readonly EditorSemanticOperation[],
): { audio: boolean; narrative: boolean } {
    const narrative = operations.some((operation) => operation.type.startsWith('narrative.'));
    const audio = operations.some((operation) => (
        operation.type.startsWith('audio-')
        || operation.type.startsWith('video-clip.')
        || operation.type.startsWith('narrative.')
        || operation.type === 'render.set-profile'
        || operation.type === 'track.delete'
        || operation.type === 'track.set-state'
    ));
    return { audio, narrative: narrative || Boolean(manifest.narrative && narrative) };
}

function detectStableNoop(
    manifest: EditorManifestV4,
    projectMetadata: EditorProjectMetadata,
    operations: readonly EditorSemanticOperation[],
): string | undefined {
    if (operations.length !== 1) return undefined;
    const operation = operations[0];
    if (operation.type === 'project.set-name' && projectMetadata.name === operation.payload.name) {
        return 'unchanged';
    }
    if (operation.type === 'track.rename') {
        const tracks = operation.payload.trackKind === 'video'
            ? manifest.videoTracks
            : operation.payload.trackKind === 'audio'
                ? manifest.audioTracks
                : manifest.subtitleTracks;
        if (tracks.find((track) => track.id === operation.payload.trackId)?.name === operation.payload.name) {
            return 'unchanged';
        }
    }
    if (operation.type === 'narrative.set-editing-mode'
        && manifest.globalEditingMode === operation.payload.mode) return 'unchanged';
    if (operation.type === 'video-clip.set-order') return 'order-not-meaningful';
    return undefined;
}

function preallocateAliases(
    operations: readonly EditorSemanticOperation[],
    options: EditorEngineOptions,
    requestHash: string,
): Record<string, string> {
    const aliases: Record<string, string> = {};
    operations.forEach((operation) => {
        const scope = `${options.projectId}:${requestHash}:${operation.operationId}`;
        if (operation.type === 'track.add') {
            aliases[`$${operation.operationId}.trackId`] = operation.payload.trackId
                ?? options.ports.ids.generate('track', `${scope}:track`);
        } else if (operation.type === 'video-clip.insert') {
            aliases[`$${operation.operationId}.clipId`] = operation.payload.clipId
                ?? options.ports.ids.generate('clip', `${scope}:clip`);
        } else if (operation.type === 'video-clip.split') {
            aliases[`$${operation.operationId}.rightClipId`] = operation.payload.rightClipId
                ?? options.ports.ids.generate('clip', `${scope}:right`);
        } else if (operation.type === 'audio-clip.split') {
            aliases[`$${operation.operationId}.rightClipId`] = operation.payload.rightClipId
                ?? options.ports.ids.generate('clip', `${scope}:right`);
        } else if (operation.type === 'subtitle.split') {
            aliases[`$${operation.operationId}.rightSubtitleId`] = operation.payload.rightSubtitleId
                ?? options.ports.ids.generate('subtitle', `${scope}:right`);
        }
    });
    return aliases;
}

function sameRevisions(left: EditorEngineRevisions, right: EditorEngineRevisions): boolean {
    return left.sessionEpoch === right.sessionEpoch
        && left.sessionRevision === right.sessionRevision
        && left.documentRevision === right.documentRevision
        && left.audioGraphRevision === right.audioGraphRevision
        && left.narrativeRevision === right.narrativeRevision;
}

function applyProjectMetadataOperations(
    current: EditorProjectMetadata,
    operations: readonly EditorSemanticOperation[],
): EditorProjectMetadata {
    const next = structuredClone(current);
    operations.forEach((operation) => {
        if (operation.type !== 'project.set-name') return;
        const name = operation.payload.name.trim();
        if (!name || name.length > 256) {
            throw new EditorCommandError(
                'INVALID_OPERATION',
                'Project names must contain between 1 and 256 non-whitespace characters.',
                { details: { operationId: operation.operationId } },
            );
        }
        next.name = name;
    });
    return next;
}

function sameManifestSemantics(left: EditorManifestV4, right: EditorManifestV4): boolean {
    const normalizedLeft = structuredClone(left);
    const normalizedRight = structuredClone(right);
    normalizedLeft.revision = normalizedRight.revision;
    normalizedLeft.audioGraphRevision = normalizedRight.audioGraphRevision;
    if (normalizedLeft.narrative && normalizedRight.narrative) {
        normalizedLeft.narrative.revision = normalizedRight.narrative.revision;
    }
    return canonicalizeJson(normalizedLeft) === canonicalizeJson(normalizedRight);
}

function canonicalRequestDigest(value: unknown): string {
    return `sha256:${sha256(canonicalizeJson(value))}`;
}

// Small synchronous SHA-256 keeps plan() browser-independent while preserving cryptographic
// receipt conflict detection. It operates only on the already bounded canonical request.
function sha256(value: string): string {
    const bytes = new TextEncoder().encode(value);
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);
    const words = new Uint32Array(64);
    const hash = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const constants = SHA256_CONSTANTS;
    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let index = 0; index < 16; index += 1) {
            words[index] = view.getUint32(offset + index * 4, false);
        }
        for (let index = 16; index < 64; index += 1) {
            const left = words[index - 15];
            const right = words[index - 2];
            const s0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
            const s1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
            words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
        }
        let a = hash[0];
        let b = hash[1];
        let c = hash[2];
        let d = hash[3];
        let e = hash[4];
        let f = hash[5];
        let g = hash[6];
        let h = hash[7];
        for (let index = 0; index < 64; index += 1) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (sum0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        hash[0] = (hash[0] + a) >>> 0;
        hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0;
        hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0;
        hash[5] = (hash[5] + f) >>> 0;
        hash[6] = (hash[6] + g) >>> 0;
        hash[7] = (hash[7] + h) >>> 0;
    }
    return Array.from(hash).map(word => word.toString(16).padStart(8, '0')).join('');
}

function rotateRight(value: number, amount: number): number {
    return (value >>> amount) | (value << (32 - amount));
}

const SHA256_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
