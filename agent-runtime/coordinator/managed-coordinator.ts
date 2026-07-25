import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    ArtifactRegistry,
    type ArtifactQuotaPolicy,
    type ArtifactRecord,
} from '../artifacts/artifact-registry';
import type { Readable } from 'node:stream';
import type {
    EditorIdempotencyReceipt,
    EditorPersistenceCommit,
    EditorPersistencePort,
    EditorTranscriptionPublicationCommitV1,
    EditorialTranscriptionPublicationHydration,
    EditorialTranscriptionPublicationRequest,
    SubtitleTranscriptionPublicationRequest,
} from '../../src/lib/editor-engine';
import {
    collectHistoryPins,
    collectManifestSourceIds,
    collectManifestTranscriptRecordIds,
    collectSourcePins,
    StaleTranscriptionPublicationError,
    validateEditorHistoryState,
} from '../../src/lib/editor-engine';
import { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics';
import {
    getProcessDecodedMemoryBudget,
    type ProcessDecodedMemoryBudget,
} from '../diagnostics/decoded-memory-budget';
import {
    ManagedEventLog,
    type ManagedEvent,
    type ManagedEventData,
    type ManagedEventKind,
} from '../events/event-log';
import {
    DurableJobScheduler,
    type DurableJobEnqueueInput,
    type DurableJobRecord,
    type DurableJobTerminalPublication,
    type DurableJobTerminalTranscriptionPublication,
    type JobSchedulerOptions,
    toJobBoundaryState,
} from '../jobs/durable-job-scheduler';
import {
    PathGrantAuthority,
    type OutputPublicationRecord,
    type PathGrantKind,
    type RenderStagingQuotaPolicy,
    type SessionPathGrantRecord,
    type SourceCopyQuotaPolicy,
    type VerifiedReadHandle,
} from '../path-grants/path-grant-authority';
import { canonicalDigest, canonicalJson } from '../persistence/canonical-json';
import { atomicWriteFile, atomicWriteJson, readJsonFile } from '../persistence/fs-durable';
import type { PersistenceFaultInjector } from '../persistence/fs-durable';
import {
    type DurableReceipt,
    type DurableWrite,
    ManagedFilesystemStore,
} from '../persistence/managed-filesystem-store';
import {
    asManagedRuntimeError,
    managedError,
    type ManagedRuntimeErrorCode,
} from './errors';
import type {
    ManagedEditorPort,
    ManagedEditorPortFactory,
    ManagedEditorPublicationPort,
    ManagedEditorSnapshot,
} from './managed-editor-port';
import { SingleInstanceLock } from './single-instance-lock';
import {
    MANAGED_RUNTIME_API_VERSION,
    MANAGED_RUNTIME_SCHEMA_VERSION,
    type ManagedMutationEnvelope,
    type ManagedMutationResult,
    type ManagedProjectEnvelopeV1,
    type ManagedSessionSummary,
    type ManagedSourceRegistryRecord,
    type StateToken,
} from './types';
import { ViewPresenceStore } from './view-presence-store';
import { evaluateSourceRelease, type SourceReleasePlan } from './source-reachability';

interface CoordinatorEpochRecord {
    schemaVersion: 1;
    epoch: string;
    pid: number;
    startedAt: string;
}

interface LoadedProject<State, Command, Result extends object> {
    envelope: ManagedProjectEnvelopeV1<State>;
    port: ManagedEditorPort<State, Command, Result>;
    poisoned: boolean;
}

interface ActiveEditorRequest<State, Command, Result extends object> {
    request: ManagedMutationEnvelope<Command>;
    coreRequest: ManagedMutationEnvelope<Command>;
    publicReceiptResult?: Readonly<Record<string, unknown>>;
    committed: boolean;
    committedResult?: Result;
    committedSnapshot?: ManagedEditorSnapshot<State>;
}

interface CoreCommitEvidenceV1 {
    schemaVersion: 1;
    projectId: string;
    toolName: string;
    commandId: string;
    walTransactionId: string;
    preparedAt: string;
    receiptRevision: number;
    commitDigest: string;
    previousDigest: string;
    nextDigest: string;
    historyDigest: string;
    receiptDigest: string;
    operationIdsDigest: string;
    operationCount: number;
    fromDocumentRevision: number;
    toDocumentRevision: number;
    sessionState: EditorPersistenceCommit['sessionState'];
    event: null | {
        id: string;
        type: EditorPersistenceCommit['event'] extends infer Event
            ? Event extends { type: infer Type } ? Type : never
            : never;
        sequence: number;
        digest: string;
    };
}

const CORE_SNAPSHOT_CANONICAL_MAX_BYTES = 64 * 1024 * 1024;
const CORE_COMMIT_CANONICAL_MAX_BYTES = 192 * 1024 * 1024;
const MANAGED_EDITOR_RESULT_MAX_BYTES = 64 * 1024 * 1024;
const CORE_COMMIT_EVIDENCE_SLOTS = 1_024;

export interface PreparedManagedTranscriptionPublication {
    /** Project-relative writes promoted atomically by the coordinator WAL. */
    writes: readonly DurableWrite[];
    /**
     * Re-checks the external coverage CAS immediately before the WAL transaction. Returning false
     * is translated to the stable stale-publication error expected by Core.
     */
    verify(): void | boolean | Promise<void | boolean>;
    accept?(): void | Promise<void>;
    reject?(): void | Promise<void>;
}

export interface ManagedTranscriptionPublicationAuthority<State = unknown> {
    prepare(input: {
        projectId: string;
        sessionId: string;
        publication: EditorTranscriptionPublicationCommitV1;
        previous: EditorPersistenceCommit['previous'];
        next: EditorPersistenceCommit['next'];
        current: ManagedEditorSnapshot<State>;
    }): PreparedManagedTranscriptionPublication | Promise<PreparedManagedTranscriptionPublication>;
}

export interface ManagedPreparedCoreTranscriptionCapability {
    readonly capabilityId: string;
    readonly projectId: string;
    readonly kind: 'editorial' | 'subtitle';
    /** Editorial authority is the coordinator-retained Core commit, never caller-provided writes. */
    durableWrites(): readonly DurableWrite[];
    accept(): void;
    reject(): void;
}

interface PreparedCoreTranscriptionEntry {
    capabilityId: string;
    projectId: string;
    sessionId: string;
    sessionEpoch: string;
    kind: 'editorial' | 'subtitle';
    commit: EditorPersistenceCommit;
}

export interface ManagedCoordinatorOptions<
    // Defaults stay permissive so existing unparameterized option objects remain assignable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    State = any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Command = any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Result extends object = any,
> {
    scheduler?: JobSchedulerOptions;
    /**
     * Configures services that need coordinator-owned authorities before projects and jobs recover.
     * This is the production construction seam for media, review, transcription, and export.
     */
    configureRuntime?(
        coordinator: ManagedCoordinator<State, Command, Result>,
    ): void | Promise<void>;
    /**
     * Production runners must exist before durable jobs are recovered. Registering after
     * `start()` can strand an interrupted job indefinitely.
     */
    registerJobHandlers?(scheduler: DurableJobScheduler): void | Promise<void>;
    persistenceFaultInjector?: PersistenceFaultInjector;
    decodedMemoryLimitBytes?: number;
    artifactQuotas?: ArtifactQuotaPolicy;
    sourceCopyQuotas?: SourceCopyQuotaPolicy;
    renderStagingQuotas?: RenderStagingQuotaPolicy;
    transcriptionPublicationAuthority?: ManagedTranscriptionPublicationAuthority<State>;
}

export interface ManagedSessionOpenInput<State> {
    apiVersion: typeof MANAGED_RUNTIME_API_VERSION;
    action: 'create' | 'attach' | 'recover';
    projectId: string;
    idempotencyKey: string;
    canonicalRequestHash: string;
    name?: string;
    initialSnapshot?: ManagedEditorSnapshot<State>;
}

export interface ManagedSessionOpenResult {
    action: 'create' | 'attach' | 'recover';
    created: boolean;
    recovered: boolean;
    participantId: string;
    project: ManagedSessionSummary;
}

export interface RegistryMutation<State, Result extends Record<string, unknown>> {
    update(envelope: ManagedProjectEnvelopeV1<State>): ManagedProjectEnvelopeV1<State>;
    writes?: readonly DurableWrite[];
    result: Result;
    eventKind?: ManagedEventKind;
    eventData?: ManagedEventData;
    afterCommit?(): void | Promise<void>;
    onReject?(): void | Promise<void>;
}

type RegistryMutationFactory<State, Result extends Record<string, unknown>> = (
    envelope: ManagedProjectEnvelopeV1<State>,
) => RegistryMutation<State, Result> | Promise<RegistryMutation<State, Result>>;

export class ManagedCoordinator<
    State = unknown,
    Command = unknown,
    Result extends object = Record<string, unknown>,
> {
    readonly epoch: string;
    readonly store: ManagedFilesystemStore;
    readonly events: ManagedEventLog;
    readonly artifacts: ArtifactRegistry;
    readonly diagnostics: RuntimeDiagnostics;
    readonly decodedMemoryBudget: ProcessDecodedMemoryBudget;
    readonly jobs: DurableJobScheduler;
    readonly pathGrants: PathGrantAuthority;
    readonly presence = new ViewPresenceStore();

    private readonly projects = new Map<string, LoadedProject<State, Command, Result>>();
    private readonly queues = new Map<string, Promise<void>>();
    private readonly activeEditorRequests = new Map<
        string,
        ActiveEditorRequest<State, Command, Result>
    >();
    private readonly pendingCoreEvents = new Map<string, {
        coreEventId: string;
        event: ManagedEvent;
    }>();
    private readonly pendingTranscriptionPublications = new Map<string, {
        toolName: string;
        idempotencyKey: string;
        prepared: PreparedManagedTranscriptionPublication;
    }>();
    private readonly preparedCoreTranscription = new Map<
        string,
        PreparedCoreTranscriptionEntry
    >();
    private readonly participantsByConnection = new Map<string, Set<string>>();
    private readonly connectionsByParticipant = new Map<string, Set<string>>();
    private transcriptionPublicationAuthority?: ManagedTranscriptionPublicationAuthority<State>;
    private closed = false;
    private closing = false;

    private constructor(
        readonly dataRoot: string,
        private readonly lock: SingleInstanceLock,
        private readonly portFactory: ManagedEditorPortFactory<State, Command, Result>,
        store: ManagedFilesystemStore,
        secret: Uint8Array,
        epoch: string,
        options: ManagedCoordinatorOptions<State, Command, Result>,
    ) {
        this.store = store;
        this.epoch = epoch;
        this.diagnostics = new RuntimeDiagnostics();
        this.events = new ManagedEventLog(
            store,
            secret,
            undefined,
            undefined,
            undefined,
            { diagnostics: this.diagnostics },
        );
        this.artifacts = new ArtifactRegistry(
            store,
            secret,
            this.diagnostics,
            options.artifactQuotas,
        );
        this.pathGrants = new PathGrantAuthority({
            privateCopyRoot: join(store.coordinatorRoot, 'source-copies'),
            authoritySecret: secret,
            diagnostics: this.diagnostics,
            sourceCopyQuotas: options.sourceCopyQuotas,
            renderStagingQuotas: options.renderStagingQuotas,
        });
        this.transcriptionPublicationAuthority = options.transcriptionPublicationAuthority;
        this.decodedMemoryBudget = getProcessDecodedMemoryBudget(options.decodedMemoryLimitBytes);
        const externalTransition = options.scheduler?.onTransition;
        this.jobs = new DurableJobScheduler(store, this.diagnostics, {
            ...options.scheduler,
            persistTransition: (record, publication) => (
                this.recordJobTransition(record, publication)
            ),
            onTransition: externalTransition,
        });
    }

    static async start<
        State = unknown,
        Command = unknown,
        Result extends object = Record<string, unknown>,
    >(
        dataRoot: string,
        portFactory: ManagedEditorPortFactory<State, Command, Result>,
        options: ManagedCoordinatorOptions<State, Command, Result> = {},
    ): Promise<ManagedCoordinator<State, Command, Result>> {
        const lock = await SingleInstanceLock.acquire(dataRoot);
        try {
            const store = new ManagedFilesystemStore(dataRoot, options.persistenceFaultInjector);
            await store.initialize();
            const secret = await loadOrCreateSecret(store);
            const epoch = randomUUID();
            await atomicWriteJson(join(store.coordinatorRoot, 'coordinator.json'), {
                schemaVersion: 1,
                epoch,
                pid: process.pid,
                startedAt: new Date().toISOString(),
            } satisfies CoordinatorEpochRecord);
            const coordinator = new ManagedCoordinator(
                dataRoot,
                lock,
                portFactory,
                store,
                secret,
                epoch,
                options,
            );
            await options.configureRuntime?.(coordinator);
            await options.registerJobHandlers?.(coordinator.jobs);
            const projectIds = await store.listProjectIds();
            for (const projectId of projectIds) {
                await coordinator.loadProject(projectId);
                // WAL recovery runs first, so this can safely remove only expired records and
                // blobs that no committed artifact registry entry references.
                await coordinator.artifacts.cleanupExpired(projectId);
            }
            await coordinator.pathGrants.cleanupSourceCopies(
                Array.from(coordinator.projects.values()).map(({ envelope }) => ({
                    sessionId: envelope.sessionId,
                    digests: envelope.sourceRegistry
                        .filter((source) => source.releasedAt === undefined)
                        .map((source) => source.digest),
                })),
            );
            await coordinator.jobs.recover(projectIds);
            return coordinator;
        } catch (error) {
            await lock.release().catch(() => undefined);
            throw error;
        }
    }

    async createSession(
        name: string,
        snapshot: ManagedEditorSnapshot<State>,
        ids: { projectId?: string; sessionId?: string } = {},
    ): Promise<{ project: ManagedSessionSummary; state: StateToken }> {
        this.assertOpen();
        validateEditorSnapshot(snapshot);
        const projectId = ids.projectId ?? randomUUID();
        const sessionId = ids.sessionId ?? randomUUID();
        if (
            this.projects.has(projectId)
            || Array.from(this.projects.values()).some((project) => (
                project.envelope.sessionId === sessionId
            ))
        ) {
            throw managedError(
                'INVALID_REQUEST',
                'The managed project or session identifier is already active.',
            );
        }
        const now = new Date().toISOString();
        const envelope: ManagedProjectEnvelopeV1<State> = {
            schemaVersion: MANAGED_RUNTIME_SCHEMA_VERSION,
            projectId,
            sessionId,
            name: name.trim().slice(0, 200) || 'Untitled project',
            createdAt: now,
            updatedAt: now,
            sessionRevision: 0,
            editor: snapshot,
            eventSequence: 0,
            receiptRevision: 0,
            jobRevision: 0,
            artifactRevision: 0,
            grantRevision: 0,
            sourceRegistryRevision: 0,
            playback: {
                revision: 0,
                presenterViewId: null,
                playing: false,
                outputSample: 0,
                rate: 1,
                masterVolume: 1,
                masterMuted: false,
            },
            sourceRegistry: [],
            lastCoordinatorEpoch: this.epoch,
            recoveryCount: 0,
        };
        validateProjectEnvelope(envelope);
        const port = await this.portFactory.create(
            snapshot,
            this.persistencePort(projectId),
            this.publicationPort(projectId),
        );
        try {
            // Adapter acceptance precedes publication so a rejected snapshot cannot poison the
            // durable project set or make the next coordinator start fail.
            await port.hydrate(snapshot);
            await this.store.createProject(envelope);
            this.projects.set(projectId, { envelope, port, poisoned: false });
            return { project: summary(envelope), state: this.stateToken(envelope) };
        } catch (error) {
            await port.close().catch(() => undefined);
            throw error;
        }
    }

    async openSessionReceiptFirst(
        input: ManagedSessionOpenInput<State>,
    ): Promise<ManagedMutationResult<ManagedSessionOpenResult>> {
        return this.serialized(input.projectId, async () => {
            let port: ManagedEditorPort<State, Command, Result> | undefined;
            try {
                if (
                    input.apiVersion !== MANAGED_RUNTIME_API_VERSION
                    || !input.projectId
                    || !input.idempotencyKey
                    || !/^sha256:[a-f0-9]{64}$/.test(input.canonicalRequestHash)
                ) {
                    throw managedError('INVALID_REQUEST', 'The session open identity is invalid.');
                }
                await this.store.recoverProject(input.projectId);
                const existingReceipt = await this.store.readReceipt<ManagedSessionOpenResult>(
                    input.projectId,
                    'waptions_session_open',
                    input.idempotencyKey,
                );
                if (existingReceipt) {
                    if (existingReceipt.canonicalRequestHash !== input.canonicalRequestHash) {
                        throw managedError(
                            'IDEMPOTENCY_KEY_CONFLICT',
                            'The idempotency key was already used with a different request.',
                        );
                    }
                    if (!this.projects.has(input.projectId)) {
                        await this.loadProject(input.projectId);
                    }
                    const loaded = this.requireProject(input.projectId);
                    return {
                        ok: true,
                        data: existingReceipt.result,
                        state: this.stateToken(loaded.envelope),
                        committedState: this.stateToken(loaded.envelope),
                        warnings: [],
                        replayed: true,
                    };
                }

                if (input.action === 'create') {
                    if (!input.initialSnapshot) {
                        throw managedError(
                            'INVALID_REQUEST',
                            'Creating a session requires an initial editor snapshot.',
                        );
                    }
                    if (await this.store.readProject(input.projectId)) {
                        throw managedError(
                            'IDEMPOTENCY_KEY_CONFLICT',
                            'The project already exists under a different bootstrap request.',
                        );
                    }
                    const sessionId = `session_${canonicalDigest({
                        projectId: input.projectId,
                    }).slice(7, 39)}`;
                    const now = new Date().toISOString();
                    const envelope: ManagedProjectEnvelopeV1<State> = {
                        schemaVersion: MANAGED_RUNTIME_SCHEMA_VERSION,
                        projectId: input.projectId,
                        sessionId,
                        name: input.name?.trim().slice(0, 200) || 'Untitled project',
                        createdAt: now,
                        updatedAt: now,
                        sessionRevision: 0,
                        editor: input.initialSnapshot,
                        eventSequence: 0,
                        receiptRevision: 1,
                        jobRevision: 0,
                        artifactRevision: 0,
                        grantRevision: 0,
                        sourceRegistryRevision: 0,
                        playback: {
                            revision: 0,
                            presenterViewId: null,
                            playing: false,
                            outputSample: 0,
                            rate: 1,
                            masterVolume: 1,
                            masterMuted: false,
                        },
                        sourceRegistry: [],
                        lastCoordinatorEpoch: this.epoch,
                        recoveryCount: 0,
                    };
                    validateProjectEnvelope(envelope);
                    const state = this.stateToken(envelope);
                    const result = sessionOpenResult(input, envelope);
                    const receipt = bootstrapReceipt(input, result, envelope);
                    port = await this.portFactory.create(
                        input.initialSnapshot,
                        this.persistencePort(input.projectId),
                        this.publicationPort(input.projectId),
                    );
                    await port.hydrate(input.initialSnapshot);
                    await this.store.createProjectAtomic(envelope, [
                        this.store.receiptWrite(receipt),
                    ]);
                    this.projects.set(input.projectId, { envelope, port, poisoned: false });
                    port = undefined;
                    return {
                        ok: true,
                        data: result,
                        state,
                        committedState: state,
                        warnings: [],
                        replayed: false,
                    };
                }

                const loaded = this.requireProject(input.projectId);
                const result = sessionOpenResult(input, loaded.envelope);
                const nextEnvelope = {
                    ...loaded.envelope,
                    receiptRevision: loaded.envelope.receiptRevision + 1,
                    updatedAt: new Date().toISOString(),
                };
                await this.commit(loaded, nextEnvelope, [
                    this.store.receiptWrite(bootstrapReceipt(input, result, nextEnvelope)),
                    ...await this.store.receiptRetentionDeletes(input.projectId),
                ]);
                const state = this.stateToken(nextEnvelope);
                return {
                    ok: true,
                    data: result,
                    state,
                    committedState: state,
                    warnings: [],
                    replayed: false,
                };
            } catch (error) {
                return { ok: false, error: asManagedRuntimeError(error).toJSON() };
            } finally {
                await port?.close().catch(() => undefined);
            }
        });
    }

    listSessions(): ManagedSessionSummary[] {
        this.assertOpen();
        return Array.from(this.projects.values()).map((project) => summary(project.envelope));
    }

    bindParticipant(connectionId: string, participantId: string): void {
        validateConnectionIdentity(connectionId, 'connection');
        validateConnectionIdentity(participantId, 'participant');
        const participants = this.participantsByConnection.get(connectionId) ?? new Set<string>();
        participants.add(participantId);
        this.participantsByConnection.set(connectionId, participants);
        const connections = this.connectionsByParticipant.get(participantId) ?? new Set<string>();
        connections.add(connectionId);
        this.connectionsByParticipant.set(participantId, connections);
    }

    participantForConnection(connectionId: string): string | null {
        validateConnectionIdentity(connectionId, 'connection');
        const participants = this.participantsByConnection.get(connectionId);
        if (!participants || participants.size === 0) return null;
        if (participants.size > 1) {
            throw managedError(
                'INVALID_REQUEST',
                'The connection is bound to more than one managed participant.',
            );
        }
        return Array.from(participants)[0];
    }

    detachConnection(connectionId: string): string[] {
        validateConnectionIdentity(connectionId, 'connection');
        const participants = this.participantsByConnection.get(connectionId);
        if (!participants) return [];
        this.participantsByConnection.delete(connectionId);
        const detachedViews: string[] = [];
        for (const participantId of participants) {
            const connections = this.connectionsByParticipant.get(participantId);
            connections?.delete(connectionId);
            if (connections && connections.size > 0) continue;
            this.connectionsByParticipant.delete(participantId);
            detachedViews.push(...this.presence.detachParticipant(participantId));
        }
        return detachedViews;
    }

    resolveProjectId(sessionId: string): string {
        this.assertOpen();
        const matching = Array.from(this.projects.values()).find(
            ({ envelope }) => envelope.sessionId === sessionId,
        );
        if (!matching) {
            throw managedError('SESSION_NOT_FOUND', 'The managed session does not exist.');
        }
        return matching.envelope.projectId;
    }

    getProject(projectId: string): {
        envelope: ManagedProjectEnvelopeV1<State>;
        state: StateToken;
    } {
        const loaded = this.requireProject(projectId);
        return { envelope: structuredClone(loaded.envelope), state: this.stateToken(loaded.envelope) };
    }

    async openRetainedSource(
        projectId: string,
        sourceId: string,
    ): Promise<VerifiedReadHandle> {
        const loaded = this.requireProject(projectId);
        const source = loaded.envelope.sourceRegistry.find((candidate) => (
            candidate.sourceId === sourceId && !candidate.releasedAt
        ));
        if (!source) {
            throw managedError('NOT_FOUND', 'The retained managed source does not exist.');
        }
        return this.pathGrants.openRetainedSource(
            loaded.envelope.sessionId,
            source.sourceId,
            source.digest,
            source.byteLength,
        );
    }

    configureTranscriptionPublicationAuthority(
        authority: ManagedTranscriptionPublicationAuthority<State>,
    ): void {
        if (this.projects.size > 0 || this.transcriptionPublicationAuthority) {
            throw managedError(
                'INVALID_REQUEST',
                'The transcription publication authority must be configured once before recovery.',
            );
        }
        this.transcriptionPublicationAuthority = authority;
    }

    prepareEditorialTranscriptionPublication(
        projectId: string,
        request: EditorialTranscriptionPublicationRequest,
        hydration?: EditorialTranscriptionPublicationHydration,
    ): Promise<ManagedPreparedCoreTranscriptionCapability> {
        return this.prepareCoreTranscriptionPublication(
            projectId,
            'editorial',
            (port) => {
                if (!port.prepareEditorialTranscriptionPublication) {
                    throw managedError(
                        'COORDINATOR_UNAVAILABLE',
                        'The managed editor cannot prepare editorial transcription.',
                        true,
                    );
                }
                return port.prepareEditorialTranscriptionPublication(request, hydration);
            },
        );
    }

    prepareSubtitleTranscriptionPublication(
        projectId: string,
        request: SubtitleTranscriptionPublicationRequest,
    ): Promise<ManagedPreparedCoreTranscriptionCapability> {
        return this.prepareCoreTranscriptionPublication(
            projectId,
            'subtitle',
            (port) => {
                if (!port.prepareSubtitleTranscriptionPublication) {
                    throw managedError(
                        'COORDINATOR_UNAVAILABLE',
                        'The managed editor cannot prepare subtitle transcription.',
                        true,
                    );
                }
                return port.prepareSubtitleTranscriptionPublication(request);
            },
        );
    }

    private async prepareCoreTranscriptionPublication(
        projectId: string,
        kind: 'editorial' | 'subtitle',
        prepare: (
            port: ManagedEditorPort<State, Command, Result>,
        ) => Promise<EditorPersistenceCommit>,
    ): Promise<ManagedPreparedCoreTranscriptionCapability> {
        return this.serialized(projectId, async () => {
            const loaded = this.requireProject(projectId);
            if (loaded.poisoned) {
                throw managedError(
                    'COORDINATOR_UNAVAILABLE',
                    'The managed project requires recovery before transcription preparation.',
                    true,
                );
            }
            const currentSnapshot = loaded.port.snapshot();
            validateEditorSnapshot(currentSnapshot);
            const commit = await prepare(loaded.port);
            if (
                commit.projectId !== projectId
                || commit.transcriptionPublication?.kind !== kind
            ) {
                throw managedError(
                    'INVALID_REQUEST',
                    'Core prepared a transcription publication with the wrong authority.',
                );
            }
            const nextSnapshot = loaded.port.snapshotFromCommit(commit);
            validateEditorSnapshot(nextSnapshot);
            validateEditorPersistenceCommit({
                input: commit,
                projectId,
                epoch: this.epoch,
                request: coreRequestFromCommit(
                    commit,
                    currentSnapshot,
                    loaded.envelope.sessionId,
                ),
                envelope: loaded.envelope,
                currentSnapshot,
                nextSnapshot,
                editorEventSequence: loaded.port.editorEventSequence?.(),
            });
            const capabilityId = `core-transcription:${randomUUID()}`;
            const entry: PreparedCoreTranscriptionEntry = {
                capabilityId,
                projectId,
                sessionId: loaded.envelope.sessionId,
                sessionEpoch: this.epoch,
                kind,
                commit: structuredClone(commit),
            };
            this.preparedCoreTranscription.set(capabilityId, entry);
            const settle = () => {
                if (this.preparedCoreTranscription.get(capabilityId) === entry) {
                    this.preparedCoreTranscription.delete(capabilityId);
                }
            };
            return Object.freeze({
                capabilityId,
                projectId,
                kind,
                durableWrites: () => [],
                accept: settle,
                reject: settle,
            });
        });
    }

    async mutateEditor(
        projectId: string,
        request: ManagedMutationEnvelope<Command>,
    ): Promise<ManagedMutationResult<Result>> {
        return this.mutateEditorAtCoreBoundary(projectId, request);
    }

    /**
     * Receipt-first media import seam. Source handles are revalidated under the project queue
     * immediately before Core dispatch; process-local authority is published only after Core WAL.
     */
    async importMediaThroughCore(
        projectId: string,
        request: ManagedMutationEnvelope<Command>,
        command: Command,
        authority: {
            revalidate(): void | Promise<void>;
            commitAuthority(): void | Promise<void>;
        },
    ): Promise<ManagedMutationResult<Result>> {
        return this.mutateEditorAtCoreBoundary(
            projectId,
            { ...request, command },
            authority,
        );
    }

    private async mutateEditorAtCoreBoundary(
        projectId: string,
        request: ManagedMutationEnvelope<Command>,
        authority?: {
            revalidate(): void | Promise<void>;
            commitAuthority(): void | Promise<void>;
        },
    ): Promise<ManagedMutationResult<Result>> {
        return this.serialized(projectId, async () => {
            let loaded = this.projects.get(projectId);
            let active: ActiveEditorRequest<State, Command, Result> | undefined;
            try {
                const replay = await this.resolveReceipt<Result>(projectId, request);
                if (replay) return replay;
                loaded = this.requireProject(projectId);
                this.validateNewMutation(loaded.envelope, request);
                const before = loaded.port.snapshot();
                validateEditorSnapshot(before);
                active = {
                    request,
                    coreRequest: request,
                    committed: false,
                };
                this.activeEditorRequests.set(projectId, active);
                await authority?.revalidate();
                let result: Result;
                try {
                    result = await loaded.port.dispatch({ command: request.command, request });
                } catch (error) {
                    if (!active.committed) throw error;
                    const restored = await this.restoreCommittedEditorState(loaded, active, [
                        'Core threw after its durable commit; the committed result is authoritative.',
                    ]);
                    await appendAuthorityCommitWarning(restored, authority);
                    return restored;
                }
                if (!active.committed) {
                    validateManagedResult(result);
                    const after = loaded.port.snapshot();
                    validateEditorSnapshot(after);
                    if (
                        canonicalDigest(after, CORE_SNAPSHOT_CANONICAL_MAX_BYTES)
                        !== canonicalDigest(before, CORE_SNAPSHOT_CANONICAL_MAX_BYTES)
                    ) {
                        await loaded.port.hydrate(before);
                    }
                    if (isCoreFailure(result)) {
                        const error = managedCoreFailure(result.error);
                        return {
                            ok: false,
                            error,
                            state: this.stateToken(loaded.envelope),
                        };
                    }
                    throw managedError(
                        'INTERNAL_ERROR',
                        'Core returned without its required atomic persistence commit.',
                    );
                }
                const warnings: string[] = [];
                try {
                    validateManagedResult(result, MANAGED_EDITOR_RESULT_MAX_BYTES);
                    if (
                        canonicalDigest(
                            active.committedResult,
                            MANAGED_EDITOR_RESULT_MAX_BYTES,
                        ) !== canonicalDigest(result, MANAGED_EDITOR_RESULT_MAX_BYTES)
                        || canonicalDigest(
                            active.committedSnapshot,
                            CORE_SNAPSHOT_CANONICAL_MAX_BYTES,
                        )
                            !== canonicalDigest(
                                loaded.port.snapshot(),
                                CORE_SNAPSHOT_CANONICAL_MAX_BYTES,
                            )
                    ) {
                        warnings.push(
                            'Core returned state that differs from its durable commit; '
                                + 'the committed result was restored.',
                        );
                        await loaded.port.hydrate(active.committedSnapshot!);
                    }
                } catch {
                    warnings.push(
                        'Core returned invalid state after its durable commit; '
                            + 'the committed result was restored.',
                    );
                    try {
                        await loaded.port.hydrate(active.committedSnapshot!);
                    } catch {
                        loaded.poisoned = true;
                    }
                }
                const committed = this.committedEditorResult(loaded, active, warnings);
                await appendAuthorityCommitWarning(committed, authority);
                return committed;
            } catch (error) {
                if (active?.committed && loaded) {
                    const restored = await this.restoreCommittedEditorState(loaded, active, [
                        'Core failed after its durable commit; the committed result is authoritative.',
                    ]);
                    await appendAuthorityCommitWarning(restored, authority);
                    return restored;
                }
                return {
                    ok: false,
                    error: asManagedRuntimeError(error).toJSON(),
                    ...(loaded ? { state: this.stateToken(loaded.envelope) } : {}),
                };
            } finally {
                this.activeEditorRequests.delete(projectId);
            }
        });
    }

    /**
     * Runs a translated Core rename while keeping the public idempotency scope on
     * `waptions_session_manage`. Core remains the sole owner of editorial revision/history state.
     */
    async renameProjectThroughCore(
        projectId: string,
        request: ManagedMutationEnvelope<Command>,
        coreRequest: ManagedMutationEnvelope<Command>,
        command: Command,
    ): Promise<ManagedMutationResult<{ action: 'rename'; status: 'renamed' }>> {
        return this.serialized(projectId, async () => {
            let loaded = this.projects.get(projectId);
            const publicResult = { action: 'rename' as const, status: 'renamed' as const };
            let active: ActiveEditorRequest<State, Command, Result> | undefined;
            try {
                const replay = await this.resolveReceipt<typeof publicResult>(projectId, request);
                if (replay) return replay;
                loaded = this.requireProject(projectId);
                this.validateNewMutation(loaded.envelope, request);
                this.validateNewMutation(loaded.envelope, coreRequest);
                const before = loaded.port.snapshot();
                validateEditorSnapshot(before);
                active = {
                    request,
                    coreRequest,
                    publicReceiptResult: publicResult,
                    committed: false,
                };
                this.activeEditorRequests.set(projectId, active);
                let coreResult: Result;
                try {
                    coreResult = await loaded.port.dispatch({ command, request: coreRequest });
                } catch (error) {
                    if (!active.committed) throw error;
                    coreResult = active.committedResult!;
                }
                if (!active.committed) {
                    validateManagedResult(coreResult, MANAGED_EDITOR_RESULT_MAX_BYTES);
                    if (isCoreFailure(coreResult)) {
                        const error = managedCoreFailure(coreResult.error);
                        return {
                            ok: false,
                            error,
                            state: this.stateToken(loaded.envelope),
                        };
                    }
                    throw managedError(
                        'INTERNAL_ERROR',
                        'Core returned from the translated rename without an atomic commit.',
                    );
                }
                if (!active.committedSnapshot) {
                    throw managedError('INTERNAL_ERROR', 'The committed rename head is unavailable.');
                }
                if (
                    canonicalDigest(
                        loaded.port.snapshot(),
                        CORE_SNAPSHOT_CANONICAL_MAX_BYTES,
                    ) !== canonicalDigest(
                        active.committedSnapshot,
                        CORE_SNAPSHOT_CANONICAL_MAX_BYTES,
                    )
                ) {
                    await loaded.port.hydrate(active.committedSnapshot);
                }
                this.publishPendingCoreEvent(projectId);
                return {
                    ok: true,
                    data: publicResult,
                    state: this.stateToken(loaded.envelope),
                    committedState: this.stateToken(loaded.envelope),
                    warnings: [],
                    replayed: false,
                };
            } catch (error) {
                if (active?.committed && loaded?.envelope && active.committedSnapshot) {
                    try {
                        await loaded.port.hydrate(active.committedSnapshot);
                        this.publishPendingCoreEvent(projectId);
                    } catch {
                        loaded.poisoned = true;
                    }
                    return {
                        ok: true,
                        data: publicResult,
                        state: this.stateToken(loaded.envelope),
                        committedState: this.stateToken(loaded.envelope),
                        warnings: [
                            'Core failed after the translated rename committed; '
                                + 'the durable rename is authoritative.',
                        ],
                        replayed: false,
                    };
                }
                return {
                    ok: false,
                    error: asManagedRuntimeError(error).toJSON(),
                    ...(loaded ? { state: this.stateToken(loaded.envelope) } : {}),
                };
            } finally {
                this.activeEditorRequests.delete(projectId);
            }
        });
    }

    async planEditor(projectId: string, command: Command): Promise<Result> {
        const loaded = this.requireProject(projectId);
        if (!loaded.port.plan) {
            throw managedError('INVALID_REQUEST', 'The managed editor does not support planning.');
        }
        return loaded.port.plan(command);
    }

    async mutateRegistry<RegistryResult extends Record<string, unknown>>(
        projectId: string,
        request: ManagedMutationEnvelope,
        factory: RegistryMutationFactory<State, RegistryResult>,
    ): Promise<ManagedMutationResult<RegistryResult>> {
        return this.serialized(projectId, async () => {
            let loaded = this.projects.get(projectId);
            let mutation: RegistryMutation<State, RegistryResult> | undefined;
            let committed = false;
            try {
                const replay = await this.resolveReceipt<RegistryResult>(projectId, request);
                if (replay) return replay;
                loaded = this.requireProject(projectId);
                this.validateNewMutation(loaded.envelope, request);
                mutation = await factory(structuredClone(loaded.envelope));
                validateManagedResult(mutation.result);
                if ((mutation.eventKind === undefined) !== (mutation.eventData === undefined)) {
                    throw managedError(
                        'INVALID_REQUEST',
                        'A registry event kind and payload must be committed together.',
                    );
                }
                if (mutation.eventData) canonicalJson(mutation.eventData, 48 * 1024);
                const updated = omitUndefinedEnvelopeFields(
                    mutation.update(structuredClone(loaded.envelope)),
                );
                const nextEnvelope: ManagedProjectEnvelopeV1<State> = {
                    ...updated,
                    sessionRevision: loaded.envelope.sessionRevision,
                    receiptRevision: loaded.envelope.receiptRevision + 1,
                    eventSequence: loaded.envelope.eventSequence
                        + (mutation.eventKind ? 1 : 0),
                    updatedAt: new Date().toISOString(),
                    lastCoordinatorEpoch: this.epoch,
                };
                if (
                    nextEnvelope.projectId !== loaded.envelope.projectId
                    || nextEnvelope.sessionId !== loaded.envelope.sessionId
                ) {
                    throw managedError(
                        'INVALID_REQUEST',
                        'A registry mutation cannot change project authority.',
                    );
                }
                validateEditorSnapshot(nextEnvelope.editor);
                const event = mutation.eventKind && mutation.eventData
                    ? this.createEvent(nextEnvelope, mutation.eventKind, mutation.eventData)
                    : null;
                const receipt = this.createReceipt(
                    projectId,
                    request,
                    mutation.result,
                    nextEnvelope.sessionRevision,
                    nextEnvelope.editor.reachableSourceIds,
                );
                await this.commit(loaded, nextEnvelope, [
                    ...(mutation.writes ?? []),
                    this.store.receiptWrite(receipt),
                    ...(event ? [this.events.write(event)] : []),
                    ...await this.store.receiptRetentionDeletes(projectId),
                    ...(event ? await this.events.retentionDeletes(projectId) : []),
                ]);
                committed = true;
                if (event) this.events.publish(event);
                await Promise.resolve(mutation.afterCommit?.()).catch(() => undefined);
                return {
                    ok: true,
                    data: mutation.result,
                    state: this.stateToken(nextEnvelope),
                    warnings: [],
                    replayed: false,
                    committedState: this.stateToken(nextEnvelope),
                };
            } catch (error) {
                if (!committed && mutation?.onReject) {
                    await Promise.resolve(mutation.onReject()).catch(() => undefined);
                }
                if (committed && mutation && loaded) {
                    await Promise.resolve(mutation.afterCommit?.()).catch(() => undefined);
                    return {
                        ok: true,
                        data: mutation.result,
                        state: this.stateToken(loaded.envelope),
                        warnings: [
                            'A post-commit callback failed; the durable mutation remains authoritative.',
                        ],
                        replayed: false,
                        committedState: this.stateToken(loaded.envelope),
                    };
                }
                return {
                    ok: false,
                    error: asManagedRuntimeError(error).toJSON(),
                    ...(loaded ? { state: this.stateToken(loaded.envelope) } : {}),
                };
            }
        });
    }

    async grantPath(
        projectId: string,
        request: ManagedMutationEnvelope,
        kind: PathGrantKind,
        path: string,
        overwriteConfirmed = false,
    ): Promise<ManagedMutationResult<{ grant: SessionPathGrantRecord }>> {
        return this.mutateRegistry(projectId, request, async (envelope) => {
            const prepared = await this.pathGrants.prepareCreate(
                envelope.sessionId,
                this.epoch,
                kind,
                path,
                overwriteConfirmed,
            );
            const grant = prepared.record;
            return {
                update: (current) => ({ ...current, grantRevision: current.grantRevision + 1 }),
                writes: [{ relativePath: `grants/${grant.grantId}.json`, value: grant }],
                result: { grant },
                eventKind: 'grant.changed',
                eventData: { action: 'granted', kind },
                afterCommit: () => {
                    prepared.commit();
                },
            };
        });
    }

    async revokePathGrant(
        projectId: string,
        request: ManagedMutationEnvelope,
        grantId: string,
    ): Promise<ManagedMutationResult<{ grant: SessionPathGrantRecord }>> {
        return this.mutateRegistry(projectId, request, async () => {
            const grants = await this.store.readNamespace<SessionPathGrantRecord>(projectId, 'grants');
            const existing = grants.find((grant) => grant.grantId === grantId);
            if (!existing) throw managedError('NOT_FOUND', 'The managed path grant does not exist.');
            const prepared = this.pathGrants.prepareRevoke(existing.grantId, {
                sessionId: existing.sessionId,
                sessionEpoch: existing.sessionEpoch,
            });
            const grant = prepared.record;
            return {
                update: (envelope) => ({ ...envelope, grantRevision: envelope.grantRevision + 1 }),
                writes: [{ relativePath: `grants/${grant.grantId}.json`, value: grant }],
                result: { grant },
                eventKind: 'grant.changed',
                eventData: { action: 'revoked', kind: grant.kind },
                afterCommit: () => {
                    prepared.commit();
                },
            };
        });
    }

    async archiveProject(
        projectId: string,
        request: ManagedMutationEnvelope,
    ): Promise<ManagedMutationResult<{ archivedAt: string }>> {
        return this.mutateRegistry(projectId, request, () => {
            const archivedAt = new Date().toISOString();
            return {
                update: (envelope) => ({ ...envelope, archivedAt }),
                result: { archivedAt },
                eventKind: 'project.changed',
                eventData: { action: 'archived', archivedAt },
            };
        });
    }

    async tombstoneProject(
        projectId: string,
        request: ManagedMutationEnvelope,
    ): Promise<ManagedMutationResult<{ deletedAt: string }>> {
        return this.mutateRegistry(projectId, request, () => {
            const deletedAt = new Date().toISOString();
            return {
                update: (envelope) => ({
                    ...envelope,
                    archivedAt: envelope.archivedAt ?? deletedAt,
                    deletedAt,
                }),
                result: { deletedAt },
                eventKind: 'project.changed',
                eventData: { action: 'tombstoned', deletedAt },
            };
        });
    }

    async createArtifact(
        projectId: string,
        request: ManagedMutationEnvelope,
        input: {
            kind: string;
            mediaType: string;
            source: AsyncIterable<Uint8Array> | Readable;
            expiresAt?: string;
            sourceIds?: readonly string[];
            sourceIdentity: string;
            signal?: AbortSignal;
            deadlineMilliseconds?: number;
        },
    ): Promise<ManagedMutationResult<{ artifact: ArtifactRecord }>> {
        return this.mutateRegistry(projectId, request, async () => {
            boundedIdentity(input.sourceIdentity);
            // Staging happens only after epoch-independent receipt resolution and all guards.
            const staged = await this.artifacts.stage(
                projectId,
                input.kind,
                input.mediaType,
                input.source,
                {
                    expiresAt: input.expiresAt,
                    sourceIds: input.sourceIds,
                    signal: input.signal,
                    deadlineMilliseconds: input.deadlineMilliseconds,
                },
            );
            return {
                update: (envelope) => ({
                    ...envelope,
                    artifactRevision: envelope.artifactRevision + 1,
                }),
                writes: [staged.registryWrite],
                result: { artifact: staged.record },
                eventKind: 'artifact.created',
                eventData: {
                    artifactId: staged.record.artifactId,
                    kind: staged.record.kind,
                    contentDigest: staged.record.digest,
                    byteLength: staged.record.byteLength,
                },
                afterCommit: staged.accept,
                onReject: staged.reject,
            };
        });
    }

    async enqueueJob<Input>(
        projectId: string,
        request: ManagedMutationEnvelope,
        input: Omit<DurableJobEnqueueInput<Input>, 'projectId' | 'capturedState'>,
    ): Promise<ManagedMutationResult<{ job: DurableJobRecord<Input> }>> {
        return this.mutateRegistry(projectId, request, (envelope) => {
            const job = this.jobs.prepareEnqueue({
                ...input,
                projectId,
                capturedState: this.stateToken(envelope),
            });
            const adopt = async () => {
                await this.jobs.acceptEnqueued(job);
            };
            return {
                update: (current) => ({
                    ...current,
                    jobRevision: current.jobRevision + 1,
                }),
                writes: [{
                    relativePath: `jobs/${job.jobId}.json`,
                    value: job,
                }],
                result: { job },
                eventKind: 'job.changed',
                eventData: jobEventData(job),
                afterCommit: adopt,
                onReject: async () => {
                    await this.store.recoverProject(projectId);
                    const durable = (await this.store.readNamespace<DurableJobRecord>(
                        projectId,
                        'jobs',
                    )).find((candidate) => candidate.jobId === job.jobId);
                    if (durable) await this.jobs.acceptEnqueued(durable);
                },
            };
        });
    }

    async cancelJobReceiptFirst(
        projectId: string,
        request: ManagedMutationEnvelope,
        jobId: string,
    ): Promise<ManagedMutationResult<{ job: DurableJobRecord }>> {
        return this.mutateRegistry(projectId, request, () => {
            const job = this.jobs.prepareCancel(jobId);
            if (job.projectId !== projectId) {
                throw managedError('NOT_FOUND', 'The managed job does not belong to this project.');
            }
            return {
                update: (current) => ({
                    ...current,
                    jobRevision: current.jobRevision + 1,
                }),
                writes: [{
                    relativePath: `jobs/${job.jobId}.json`,
                    value: job,
                }],
                result: { job },
                eventKind: 'job.changed',
                eventData: jobEventData(job),
                afterCommit: () => this.jobs.acceptPreparedCancellation(job),
            };
        });
    }

    async updatePlayback(
        projectId: string,
        request: ManagedMutationEnvelope,
        expectedPlaybackRevision: number,
        update: Partial<Omit<ManagedProjectEnvelopeV1<State>['playback'], 'revision'>>,
    ): Promise<ManagedMutationResult<{ playback: ManagedProjectEnvelopeV1<State>['playback'] }>> {
        return this.mutateRegistry(projectId, request, (envelope) => {
            const current = envelope.playback;
            if (
                !Number.isSafeInteger(expectedPlaybackRevision)
                || expectedPlaybackRevision < 0
            ) {
                throw managedError('INVALID_REQUEST', 'The expected playback revision is invalid.');
            }
            if (current.revision !== expectedPlaybackRevision) {
                throw managedError(
                    'REVISION_CONFLICT',
                    'The managed playback revision is stale.',
                    true,
                    {
                        expectedPlaybackRevision,
                        actualPlaybackRevision: current.revision,
                    },
                );
            }
            if (
                (update.rate !== undefined && (!Number.isFinite(update.rate) || update.rate <= 0 || update.rate > 16))
                || (
                    update.masterVolume !== undefined
                    && (!Number.isFinite(update.masterVolume) || update.masterVolume < 0 || update.masterVolume > 4)
                )
                || (
                    update.outputSample !== undefined
                    && (!Number.isSafeInteger(update.outputSample) || update.outputSample < 0)
                )
            ) {
                throw managedError('INVALID_REQUEST', 'The managed playback update is invalid.');
            }
            if (
                update.presenterViewId
                && !this.presence.list(projectId).some((view) => view.viewId === update.presenterViewId)
            ) {
                throw managedError('INVALID_REQUEST', 'Only an attached view may become presenter.');
            }
            const candidate = { ...current, ...update };
            const changed = (Object.keys(update) as Array<keyof typeof update>)
                .some((key) => update[key] !== current[key]);
            if (!changed) {
                return {
                    update: (currentEnvelope) => currentEnvelope,
                    result: { playback: current },
                };
            }
            const playback = { ...candidate, revision: current.revision + 1 };
            return {
                update: (currentEnvelope) => ({ ...currentEnvelope, playback }),
                result: { playback },
                eventKind: update.presenterViewId !== undefined ? 'presenter.changed' : 'playback.changed',
                eventData: { action: 'updated', playback },
            };
        });
    }

    async planSourceRelease(projectId: string): Promise<SourceReleasePlan> {
        const loaded = this.requireProject(projectId);
        const [jobs, receipts, artifacts] = await Promise.all([
            this.store.readNamespace<{ state: string; input?: unknown; checkpoint?: unknown }>(projectId, 'jobs'),
            this.store.readNamespace<DurableReceipt>(projectId, 'receipts'),
            this.store.readNamespace<ArtifactRecord>(projectId, 'artifacts'),
        ]);
        return evaluateSourceRelease(loaded.envelope, jobs, receipts, artifacts);
    }

    async applySourceRelease(
        projectId: string,
        request: ManagedMutationEnvelope,
        plan: SourceReleasePlan,
    ): Promise<ManagedMutationResult<{ releasedSourceIds: readonly string[] }>> {
        return this.mutateRegistry(projectId, request, async (envelope) => {
            if (plan.projectId !== projectId || envelope.sessionRevision !== plan.sessionRevision) {
                throw managedError(
                    'SESSION_REVISION_CONFLICT',
                    'Source reachability changed after the release dry run.',
                    true,
                );
            }
            const [jobs, receipts, artifacts] = await Promise.all([
                this.store.readNamespace<{ state: string; input?: unknown; checkpoint?: unknown }>(
                    projectId,
                    'jobs',
                ),
                this.store.readNamespace<DurableReceipt>(projectId, 'receipts'),
                this.store.readNamespace<ArtifactRecord>(projectId, 'artifacts'),
            ]);
            // The client-provided plan is a confirmation token only. Recompute ownership under the
            // same project serialization immediately before the single atomic commit.
            const effectivePlan = evaluateSourceRelease(envelope, jobs, receipts, artifacts);
            const releasedSourceIds = effectivePlan.releasableSourceIds;
            const released = new Set(releasedSourceIds);
            const retainedDigests = new Set(
                envelope.sourceRegistry
                    .filter((source) => !released.has(source.sourceId) && !source.releasedAt)
                    .map((source) => source.digest),
            );
            const releasedDigests = envelope.sourceRegistry
                .filter((source) => released.has(source.sourceId))
                .map((source) => source.digest)
                .filter((digest) => !retainedDigests.has(digest));
            return {
                update: (current) => ({
                    ...current,
                    sourceRegistryRevision: current.sourceRegistryRevision + 1,
                    sourceRegistry: current.sourceRegistry.map((source) => (
                        released.has(source.sourceId)
                            ? { ...source, releasedAt: new Date().toISOString() }
                            : source
                    )),
                }),
                result: { releasedSourceIds },
                eventKind: 'source.changed',
                eventData: { action: 'released', releasedSourceIds },
                afterCommit: () => this.pathGrants.releaseSourceCopies(
                    envelope.sessionId,
                    releasedDigests,
                ),
            };
        });
    }

    async close(): Promise<void> {
        if (this.closed || this.closing) return;
        this.closing = true;
        await Promise.allSettled(Array.from(this.queues.values()));
        await this.jobs.close();
        await Promise.all(Array.from(this.projects.values()).map((project) => project.port.close()));
        this.preparedCoreTranscription.clear();
        this.participantsByConnection.clear();
        this.connectionsByParticipant.clear();
        this.closed = true;
        this.closing = false;
        await this.lock.release();
    }

    canGracefullyShutdown(): boolean {
        return !this.closed
            && this.queues.size === 0
            && !this.jobs.hasActiveJobs()
            && Array.from(this.projects.values()).every((project) => !project.poisoned);
    }

    private async loadProject(projectId: string): Promise<void> {
        await this.store.recoverProject(projectId);
        const recoveryOutcome = this.store.consumeRecoveryOutcome(projectId);
        const recovered = await this.store.readProject<State>(projectId);
        if (!recovered) return;
        const grantEntries = await this.store.readNamespaceEntries<unknown>(projectId, 'grants');
        const durableOutputs = await this.store.readNamespace<OutputPublicationRecord>(
            projectId,
            'outputs',
        );
        const restorableGrants: SessionPathGrantRecord[] = [];
        const quarantinedGrantWrites: DurableWrite[] = [];
        const seenGrantIds = new Set<string>();
        for (const entry of grantEntries) {
            try {
                this.pathGrants.validateRestorable(entry.value);
                const grant = entry.value;
                if (
                    entry.name !== `${grant.grantId}.json`
                    || grant.sessionId !== recovered.sessionId
                    || seenGrantIds.has(grant.grantId)
                    || this.pathGrants.hasRegisteredGrant(grant.grantId)
                ) {
                    throw managedError(
                        'PATH_NOT_GRANTED',
                        'The durable path grant does not belong to this session.',
                    );
                }
                seenGrantIds.add(grant.grantId);
                restorableGrants.push(grant);
            } catch {
                // V1 grants were not issuer-authenticated or epoch-bound. Quarantine every
                // unsupported/invalid record in the same recovery transaction instead of
                // publishing a recovery revision that the next restart cannot load.
                quarantinedGrantWrites.push({
                    relativePath: `grants/${entry.name}`,
                    delete: true as const,
                });
            }
        }
        if (Array.from(this.projects.values()).some((project) => (
            project.envelope.sessionId === recovered.sessionId
        ))) {
            throw managedError('INVALID_REQUEST', 'The durable session identifier is duplicated.');
        }
        const interruptedJobIds = (await this.store.readNamespace<DurableJobRecord>(
            projectId,
            'jobs',
        ))
            .filter((job) => (
                job.state === 'running'
                || job.state === 'cancelling'
                || job.state === 'interrupted'
            ))
            .map((job) => job.jobId)
            .slice(0, 256);
        validateEditorSnapshot(recovered.editor);
        const port = await this.portFactory.create(
            recovered.editor,
            this.persistencePort(projectId),
            this.publicationPort(projectId),
        );
        try {
            // Adapter acceptance precedes even the recovery event publication. One incompatible
            // project therefore cannot advance durable state and poison every subsequent restart.
            await port.hydrate(recovered.editor);
        } catch (error) {
            await port.close().catch(() => undefined);
            throw error;
        }
        const envelope: ManagedProjectEnvelopeV1<State> = {
            ...recovered,
            sessionRevision: recovered.sessionRevision,
            eventSequence: recovered.eventSequence + 1,
            grantRevision: recovered.grantRevision + (quarantinedGrantWrites.length > 0 ? 1 : 0),
            recoveryCount: recovered.recoveryCount + 1,
            lastCoordinatorEpoch: this.epoch,
            updatedAt: new Date().toISOString(),
        };
        envelope.editor = port.rebaseSession?.(envelope.editor, {
            sessionEpoch: this.epoch,
            sessionRevision: envelope.sessionRevision,
        }) ?? envelope.editor;
        const event = this.createEvent(envelope, 'session.recovered', {
            previousEpoch: recovered.lastCoordinatorEpoch,
            newEpoch: this.epoch,
            outcome: recoveryOutcome,
            interruptedJobIds,
        });
        validateProjectEnvelope(envelope);
        try {
            await this.store.transact({
                baseSessionRevision: recovered.sessionRevision,
                envelope,
                writes: [
                    this.events.write(event),
                    ...await this.events.retentionDeletes(projectId),
                    ...quarantinedGrantWrites,
                ],
            });
            await port.hydrate(envelope.editor);
            for (const grant of restorableGrants) this.pathGrants.register(grant);
            this.projects.set(projectId, { envelope, port, poisoned: false });
            this.events.publish(event);
            await Promise.allSettled(durableOutputs.map(async (output) => {
                const pending = await this.pathGrants.recoverOutputPublication(
                    output.grantId,
                    recovered.sessionId,
                );
                await pending?.accept();
            }));
        } catch (error) {
            await port.close().catch(() => undefined);
            throw error;
        }
    }

    private persistencePort(projectId: string): EditorPersistencePort {
        return {
            ...(this.transcriptionPublicationAuthority
                ? { capabilities: { transcriptionPublication: true as const } }
                : {}),
            getReceipt: async (
                receiptProjectId,
                toolName,
                idempotencyKey,
            ): Promise<EditorIdempotencyReceipt | null> => {
                if (receiptProjectId !== projectId) {
                    throw managedError(
                        'INVALID_REQUEST',
                        'Core requested a receipt outside its managed project.',
                    );
                }
                const receipt = await this.store.readReceipt(
                    projectId,
                    toolName,
                    idempotencyKey,
                );
                return receipt?.coreReceipt
                    ? structuredClone(receipt.coreReceipt)
                    : null;
            },
            commit: (input) => this.commitEditorFromCore(projectId, input),
        };
    }

    private async commitEditorFromCore(
        projectId: string,
        input: EditorPersistenceCommit,
    ): Promise<void> {
        const loaded = this.requireProject(projectId);
        const active = this.activeEditorRequests.get(projectId);
        if (
            !active
            || input.projectId !== projectId
            || input.toolName !== active.coreRequest.toolName
            || input.receipt.toolName !== active.coreRequest.toolName
            || input.receipt.key !== active.coreRequest.idempotencyKey
            || input.receipt.value.idempotencyKey !== active.coreRequest.idempotencyKey
        ) {
            throw managedError(
                'INVALID_REQUEST',
                'Core attempted persistence outside the serialized coordinator dispatch.',
            );
        }
        if (active.committed) {
            throw managedError('INTERNAL_ERROR', 'Core attempted more than one atomic commit.', false);
        }
        const currentSnapshot = loaded.port.snapshot();
        validateEditorSnapshot(currentSnapshot);
        const nextSnapshot = loaded.port.snapshotFromCommit(input);
        validateEditorSnapshot(nextSnapshot);
        const commitEvidence = validateEditorPersistenceCommit({
            input,
            projectId,
            epoch: this.epoch,
            request: active.coreRequest,
            envelope: loaded.envelope,
            currentSnapshot,
            nextSnapshot,
            editorEventSequence: loaded.port.editorEventSequence?.(),
        });
        const additions = sourceRegistryAdditions(input);
        const sourceById = new Map(
            loaded.envelope.sourceRegistry.map((source) => [source.sourceId, source]),
        );
        for (const addition of additions) {
            const existing = sourceById.get(addition.sourceId);
            if (existing && canonicalDigest(existing) !== canonicalDigest(addition)) {
                throw managedError(
                    'SOURCE_CHANGED',
                    'Core attempted to replace an immutable managed source registration.',
                );
            }
            sourceById.set(addition.sourceId, addition);
        }
        const nextEnvelope: ManagedProjectEnvelopeV1<State> = {
            ...loaded.envelope,
            name: input.sessionState.projectName,
            sessionRevision: input.sessionState.sessionRevision,
            receiptRevision: loaded.envelope.receiptRevision + 1,
            sourceRegistryRevision: loaded.envelope.sourceRegistryRevision
                + (additions.length > 0 ? 1 : 0),
            eventSequence: loaded.envelope.eventSequence + (input.event ? 1 : 0),
            editor: nextSnapshot,
            sourceRegistry: Array.from(sourceById.values()),
            updatedAt: new Date().toISOString(),
            lastCoordinatorEpoch: this.epoch,
        };
        const result = {
            ...input.receipt.value.result,
            ok: true,
            replayed: false,
            snapshot: structuredClone(input.next),
        } as unknown as Result;
        validateManagedResult(result, MANAGED_EDITOR_RESULT_MAX_BYTES);
        const event = input.event
            ? this.projectCoreEvent(nextEnvelope, input)
            : null;
        const receipt = this.createReceipt(
            projectId,
            active.request,
            active.publicReceiptResult ?? input.receipt.value.result,
            nextEnvelope.sessionRevision,
            nextSnapshot.reachableSourceIds,
            input.receipt.value,
        );
        const preparedTranscription = input.transcriptionPublication
            ? await this.prepareTranscriptionPublication(
                projectId,
                loaded,
                currentSnapshot,
                input,
            )
            : null;
        // The probe handle is not durable authority. Reopen each retained private source copy and
        // verify its immutable digest immediately before the single Core WAL transaction.
        const retainedHandles: VerifiedReadHandle[] = [];
        try {
            for (const source of additions) {
                const handle = await this.pathGrants.openRetainedSource(
                    loaded.envelope.sessionId,
                    source.sourceId,
                    source.digest,
                    source.byteLength,
                );
                retainedHandles.push(handle);
                await handle.verifyUnchanged();
            }
            if (preparedTranscription) {
                const verified = await preparedTranscription.verify();
                if (verified === false) {
                    throw new StaleTranscriptionPublicationError(
                        'The transcription coverage changed before atomic publication.',
                    );
                }
                this.pendingTranscriptionPublications.set(projectId, {
                    toolName: active.request.toolName,
                    idempotencyKey: active.request.idempotencyKey,
                    prepared: preparedTranscription,
                });
            }
            await this.commit(loaded, nextEnvelope, [
                ...(preparedTranscription?.writes ?? []),
                {
                    relativePath: `core/commit-evidence/${
                        (nextEnvelope.receiptRevision % CORE_COMMIT_EVIDENCE_SLOTS)
                            .toString()
                            .padStart(4, '0')
                    }.json`,
                    value: {
                        ...commitEvidence,
                        receiptRevision: nextEnvelope.receiptRevision,
                    },
                },
                this.store.receiptWrite(receipt),
                ...(event ? [this.events.write(event)] : []),
                ...await this.store.receiptRetentionDeletes(projectId),
                ...(event ? await this.events.retentionDeletes(projectId) : []),
            ]);
        } catch (error) {
            if (preparedTranscription && !loaded.poisoned) {
                this.pendingTranscriptionPublications.delete(projectId);
                await Promise.resolve(preparedTranscription.reject?.()).catch(() => undefined);
            }
            throw error;
        } finally {
            await Promise.allSettled(retainedHandles.map((handle) => handle.close()));
        }
        active.committedResult = structuredClone(result);
        active.committedSnapshot = structuredClone(nextSnapshot);
        active.committed = true;
        if (preparedTranscription) {
            this.pendingTranscriptionPublications.delete(projectId);
            await Promise.resolve(preparedTranscription.accept?.()).catch(() => undefined);
        }
        if (event && input.event) {
            this.pendingCoreEvents.set(projectId, {
                coreEventId: input.event.id,
                event,
            });
        }
    }

    private async prepareTranscriptionPublication(
        projectId: string,
        loaded: LoadedProject<State, Command, Result>,
        currentSnapshot: ManagedEditorSnapshot<State>,
        input: EditorPersistenceCommit,
    ): Promise<PreparedManagedTranscriptionPublication> {
        if (!this.transcriptionPublicationAuthority || !input.transcriptionPublication) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'Atomic managed transcription publication is unavailable.',
                true,
            );
        }
        const prepared = await this.transcriptionPublicationAuthority.prepare({
            projectId,
            sessionId: loaded.envelope.sessionId,
            publication: input.transcriptionPublication,
            previous: input.previous,
            next: input.next,
            current: currentSnapshot,
        });
        const paths = new Set<string>();
        for (const write of prepared.writes) {
            if (
                !write.relativePath.startsWith('transcription/')
                || paths.has(write.relativePath)
            ) {
                await Promise.resolve(prepared.reject?.()).catch(() => undefined);
                throw managedError(
                    'INVALID_REQUEST',
                    'Managed transcription publication produced an invalid durable write set.',
                );
            }
            paths.add(write.relativePath);
        }
        return prepared;
    }

    private publicationPort(projectId: string): ManagedEditorPublicationPort {
        return {
            publish: (coreEvent) => {
                const pending = this.pendingCoreEvents.get(projectId);
                if (!pending || pending.coreEventId !== coreEvent.id) {
                    throw managedError(
                        'INTERNAL_ERROR',
                        'Core published an event without a matching durable commit.',
                    );
                }
                this.pendingCoreEvents.delete(projectId);
                this.events.publish(pending.event);
            },
        };
    }

    private async recordJobTransition(
        record: DurableJobRecord,
        terminalPublication?: DurableJobTerminalPublication,
    ): Promise<void> {
        if (this.closed || !this.projects.has(record.projectId)) return;
        await this.serialized(record.projectId, async () => {
            const loaded = this.projects.get(record.projectId);
            if (!loaded) return;
            if (loaded.poisoned) {
                throw managedError(
                    'COORDINATOR_UNAVAILABLE',
                    'The project requires recovery before publishing a job transition.',
                    true,
                );
            }
            const artifacts = terminalPublication?.artifacts ?? [];
            const outputs = terminalPublication?.outputs ?? [];
            const transcription = terminalPublication?.transcription;
            const transcriptionArtifacts = transcription?.stagedArtifacts ?? [];
            const allArtifacts = [...artifacts, ...transcriptionArtifacts];
            let preparedManagedTranscription: PreparedManagedTranscriptionPublication | null = null;
            const acceptPublications = async (): Promise<void> => {
                await Promise.allSettled([
                    ...allArtifacts.map((artifact) => Promise.resolve().then(
                        () => artifact.accept(),
                    )),
                    ...outputs.map((output) => Promise.resolve().then(() => output.accept())),
                    ...(transcription
                        ? [
                            Promise.resolve().then(
                                () => transcription.preparedCorePublication.accept(),
                            ),
                            ...transcription.preparedCoverageUpdates.map(
                                (coverage) => Promise.resolve().then(() => coverage.accept()),
                            ),
                        ]
                        : []),
                    ...(preparedManagedTranscription
                        ? [Promise.resolve().then(
                            () => preparedManagedTranscription?.accept?.(),
                        )]
                        : []),
                ]);
            };
            const coreEntry = transcription
                ? this.preparedCoreTranscription.get(
                    transcription.preparedCorePublication.capabilityId,
                )
                : undefined;
            if (
                allArtifacts.some((artifact) => artifact.record.projectId !== record.projectId)
                || new Set(allArtifacts.map((artifact) => artifact.record.artifactId)).size
                    !== allArtifacts.length
                || outputs.some((output) => (
                    output.record.sessionId !== loaded.envelope.sessionId
                ))
                || new Set(outputs.map((output) => output.record.publicationId)).size
                    !== outputs.length
                || (
                    transcription
                    && (
                        transcription.projectId !== record.projectId
                        || transcription.inputDigest !== record.inputDigest
                        || transcription.kind !== record.kind
                        || !['editorial-transcription', 'subtitle-transcription'].includes(
                            transcription.kind,
                        )
                        || transcription.preparedCorePublication.projectId !== record.projectId
                        || transcription.preparedCorePublication.kind !== (
                            transcription.kind === 'editorial-transcription'
                                ? 'editorial'
                                : 'subtitle'
                        )
                        || !coreEntry
                        || coreEntry.projectId !== record.projectId
                        || coreEntry.sessionId !== loaded.envelope.sessionId
                        || coreEntry.sessionEpoch !== this.epoch
                        || coreEntry.kind !== transcription.preparedCorePublication.kind
                        || transcription.preparedCoverageUpdates.some(
                            (coverage) => coverage.projectId !== record.projectId,
                        )
                    )
                )
            ) {
                throw managedError(
                    'INVALID_REQUEST',
                    'Terminal publications do not belong to the durable job project.',
                );
            }
            const coverageWrites = transcription
                ? transcription.preparedCoverageUpdates.flatMap(
                    (coverage) => coverage.durableWrites(),
                )
                : [];
            let coreCommit: EditorPersistenceCommit | null = null;
            let nextEditorSnapshot: ManagedEditorSnapshot<State> | null = null;
            let coreEvidence: CoreCommitEvidenceV1 | null = null;
            let coreReceipt: DurableReceipt | null = null;
            let coreEvent: ManagedEvent | null = null;
            if (transcription && coreEntry) {
                coreCommit = structuredClone(coreEntry.commit);
                const currentSnapshot = loaded.port.snapshot();
                validateEditorSnapshot(currentSnapshot);
                nextEditorSnapshot = loaded.port.snapshotFromCommit(coreCommit);
                validateEditorSnapshot(nextEditorSnapshot);
                const coreRequest = coreRequestFromCommit(
                    coreCommit,
                    currentSnapshot,
                    loaded.envelope.sessionId,
                );
                coreEvidence = validateEditorPersistenceCommit({
                    input: coreCommit,
                    projectId: record.projectId,
                    epoch: this.epoch,
                    request: coreRequest,
                    envelope: loaded.envelope,
                    currentSnapshot,
                    nextSnapshot: nextEditorSnapshot,
                    editorEventSequence: loaded.port.editorEventSequence?.(),
                });
                if (
                    coreCommit.transcriptionPublication?.kind
                        !== transcription.preparedCorePublication.kind
                ) {
                    throw managedError(
                        'INVALID_REQUEST',
                        'The prepared Core commit does not match the terminal transcription kind.',
                    );
                }
                coreReceipt = this.createReceipt(
                    record.projectId,
                    coreRequest,
                    coreCommit.receipt.value.result,
                    coreCommit.sessionState.sessionRevision,
                    nextEditorSnapshot.reachableSourceIds,
                    coreCommit.receipt.value,
                );
            }
            const paths = new Set<string>();
            for (const write of coverageWrites) {
                if (
                    !write.relativePath.startsWith('transcription/')
                    || paths.has(write.relativePath)
                ) {
                    throw managedError(
                        'INVALID_REQUEST',
                        'The terminal transcription durable write set is invalid.',
                    );
                }
                paths.add(write.relativePath);
            }
            if (transcription) {
                await this.verifyJobTranscriptionCoverageCas(
                    record.projectId,
                    transcription,
                    coverageWrites,
                );
                const currentSnapshot = loaded.port.snapshot();
                preparedManagedTranscription = await this.prepareTranscriptionPublication(
                    record.projectId,
                    loaded,
                    currentSnapshot,
                    coreCommit!,
                );
                for (const write of preparedManagedTranscription.writes) {
                    if (paths.has(write.relativePath)) {
                        await Promise.resolve(preparedManagedTranscription.reject?.())
                            .catch(() => undefined);
                        preparedManagedTranscription = null;
                        throw managedError(
                            'INVALID_REQUEST',
                            'Core and coverage transcription writes overlap.',
                        );
                    }
                    paths.add(write.relativePath);
                }
                const verified = await preparedManagedTranscription?.verify();
                if (verified === false) {
                    await Promise.resolve(preparedManagedTranscription.reject?.())
                        .catch(() => undefined);
                    preparedManagedTranscription = null;
                    throw new StaleTranscriptionPublicationError(
                        'The transcription publication changed before the terminal transaction.',
                    );
                }
            }
            const transcriptionWrites = [
                ...(preparedManagedTranscription?.writes ?? []),
                ...coverageWrites,
            ];
            const coreEventCount = coreCommit?.event ? 1 : 0;
            const nextEnvelope: ManagedProjectEnvelopeV1<State> = {
                ...loaded.envelope,
                name: coreCommit?.sessionState.projectName ?? loaded.envelope.name,
                sessionRevision: coreCommit?.sessionState.sessionRevision
                    ?? loaded.envelope.sessionRevision,
                receiptRevision: loaded.envelope.receiptRevision + (coreReceipt ? 1 : 0),
                jobRevision: loaded.envelope.jobRevision + 1,
                artifactRevision: loaded.envelope.artifactRevision
                    + (allArtifacts.length > 0 ? 1 : 0),
                eventSequence: loaded.envelope.eventSequence + coreEventCount + 1,
                editor: nextEditorSnapshot ?? loaded.envelope.editor,
                updatedAt: new Date().toISOString(),
            };
            if (coreCommit?.event) {
                coreEvent = this.projectCoreEvent({
                    ...nextEnvelope,
                    jobRevision: loaded.envelope.jobRevision,
                    artifactRevision: loaded.envelope.artifactRevision,
                    eventSequence: loaded.envelope.eventSequence + 1,
                }, coreCommit);
            }
            const event = this.createEvent(nextEnvelope, 'job.changed', jobEventData(record));
            let committed = false;
            try {
                await this.commit(loaded, nextEnvelope, [
                    ...allArtifacts.map((artifact) => artifact.registryWrite),
                    ...outputs.map((output) => output.registryWrite),
                    ...transcriptionWrites,
                    ...(coreEvidence
                        ? [{
                            relativePath: `core/commit-evidence/${
                                (nextEnvelope.receiptRevision % CORE_COMMIT_EVIDENCE_SLOTS)
                                    .toString()
                                    .padStart(4, '0')
                            }.json`,
                            value: {
                                ...coreEvidence,
                                receiptRevision: nextEnvelope.receiptRevision,
                            },
                        }]
                        : []),
                    ...(coreReceipt ? [this.store.receiptWrite(coreReceipt)] : []),
                    {
                        relativePath: `jobs/${record.jobId}.json`,
                        value: record,
                    },
                    ...(coreEvent ? [this.events.write(coreEvent)] : []),
                    this.events.write(event),
                    ...(coreReceipt
                        ? await this.store.receiptRetentionDeletes(record.projectId)
                        : []),
                    ...await this.events.retentionDeletes(record.projectId),
                ]);
                committed = true;
                if (nextEditorSnapshot) {
                    try {
                        await loaded.port.hydrate(nextEditorSnapshot);
                    } catch {
                        loaded.poisoned = true;
                    }
                }
                if (coreEvent) this.events.publish(coreEvent);
                this.events.publish(event);
                await acceptPublications();
            } catch (error) {
                if (committed) {
                    if (coreEvent) this.events.publish(coreEvent);
                    this.events.publish(event);
                    await acceptPublications();
                    return;
                }
                if (loaded.poisoned) {
                    let recoveryError: unknown;
                    try {
                        await this.recoverPoisonedProject(record.projectId, loaded);
                    } catch (candidate) {
                        recoveryError = candidate;
                    }
                    const durableJob = await readJsonFile<DurableJobRecord>(
                        this.store.projectPath(
                            record.projectId,
                            'jobs',
                            `${record.jobId}.json`,
                        ),
                        2 * 1024 * 1024,
                    ).catch(() => null);
                    if (
                        durableJob
                        && durableJob.sequence === record.sequence
                        && durableJob.state === record.state
                        && durableJob.inputDigest === record.inputDigest
                    ) {
                        await acceptPublications();
                        return;
                    }
                    await Promise.resolve(preparedManagedTranscription?.reject?.())
                        .catch(() => undefined);
                    throw recoveryError ?? error;
                }
                await Promise.resolve(preparedManagedTranscription?.reject?.())
                    .catch(() => undefined);
                throw error;
            }
        });
    }

    private async verifyJobTranscriptionCoverageCas(
        projectId: string,
        transcription: DurableJobTerminalTranscriptionPublication,
        writes: readonly DurableWrite[],
    ): Promise<void> {
        for (const coverage of transcription.preparedCoverageUpdates) {
            const headWrites = writes.filter((write) => {
                if (
                    !write.relativePath.startsWith('transcription/coverage-heads/')
                    || write.delete
                    || !write.value
                    || typeof write.value !== 'object'
                    || Array.isArray(write.value)
                ) {
                    return false;
                }
                const value = write.value as Record<string, unknown>;
                return value.sourceFingerprint === coverage.sourceFingerprint
                    && value.acquisitionProfileDigest === coverage.acquisitionProfileDigest;
            });
            if (headWrites.length !== 1) {
                throw managedError(
                    'INVALID_REQUEST',
                    'A terminal transcription coverage capability has no unique durable head.',
                );
            }
            const headWrite = headWrites[0];
            const nextHead = headWrite.value as {
                expectedCoverageRecordIds?: unknown;
                coverageRecordIds?: unknown;
            };
            if (
                !Array.isArray(nextHead.expectedCoverageRecordIds)
                || !Array.isArray(nextHead.coverageRecordIds)
                || canonicalDigest(nextHead.expectedCoverageRecordIds)
                    !== canonicalDigest(coverage.expectedCoverageRecordIds)
                || !nextHead.coverageRecordIds.includes(coverage.coverageRecordId)
            ) {
                throw managedError(
                    'INVALID_REQUEST',
                    'A terminal transcription coverage capability contradicts its durable head.',
                );
            }
            const currentHead = await readJsonFile<{
                coverageRecordIds?: unknown;
            }>(
                this.store.projectPath(
                    projectId,
                    ...headWrite.relativePath.split('/'),
                ),
                2 * 1024 * 1024,
            );
            const currentCoverageIds = currentHead === null
                ? []
                : currentHead.coverageRecordIds;
            if (
                !Array.isArray(currentCoverageIds)
                || canonicalDigest([...currentCoverageIds].sort())
                    !== canonicalDigest([...coverage.expectedCoverageRecordIds].sort())
            ) {
                throw new StaleTranscriptionPublicationError(
                    'The managed transcription coverage head changed before terminal publication.',
                    [coverage.sourceFingerprint],
                );
            }
        }
    }

    private async resolveReceipt<ReceiptResult extends object>(
        projectId: string,
        request: ManagedMutationEnvelope,
    ): Promise<ManagedMutationResult<ReceiptResult> | null> {
        let receipt = await this.store.readReceipt<ReceiptResult>(
            projectId,
            request.toolName,
            request.idempotencyKey,
        );
        const loadedBeforeRecovery = this.projects.get(projectId);
        if (loadedBeforeRecovery?.poisoned) {
            // A persistence exception may be a lost response after the durable marker. Repair WAL
            // before applying any new guards, then republish every recovered event in sequence.
            await this.recoverPoisonedProject(projectId, loadedBeforeRecovery);
            receipt ??= await this.store.readReceipt<ReceiptResult>(
                projectId,
                request.toolName,
                request.idempotencyKey,
            );
        }
        if (!receipt) return null;
        if (receipt.canonicalRequestHash !== request.canonicalRequestHash) {
            throw managedError(
                'IDEMPOTENCY_KEY_CONFLICT',
                'The idempotency key was already used with a different request.',
            );
        }
        if (this.closed || this.closing) {
            throw managedError('COORDINATOR_UNAVAILABLE', 'The coordinator is closing or closed.', true);
        }
        const loaded = this.projects.get(projectId);
        if (!loaded) throw managedError('SESSION_NOT_FOUND', 'The managed project is not open.');
        const replayResult = receipt.coreReceipt
            && receipt.toolName === receipt.coreReceipt.toolName
            && loaded.port.resultFromReceipt
            ? loaded.port.resultFromReceipt(receipt.coreReceipt, true)
            : receipt.result;
        return {
            ok: true,
            data: replayResult as ReceiptResult,
            state: this.stateToken(loaded.envelope),
            warnings: [],
            replayed: true,
            committedState: this.stateToken(loaded.envelope),
        };
    }

    private async recoverPoisonedProject(
        projectId: string,
        loaded: LoadedProject<State, Command, Result>,
    ): Promise<void> {
        const previousEventSequence = loaded.envelope.eventSequence;
        await this.store.recoverProject(projectId);
        const durable = await this.store.readProject<State>(projectId);
        if (!durable) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The durable project disappeared during WAL recovery.',
                true,
            );
        }
        validateProjectEnvelope(durable);
        if (
            durable.projectId !== loaded.envelope.projectId
            || durable.sessionId !== loaded.envelope.sessionId
            || durable.eventSequence < previousEventSequence
        ) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'WAL recovery produced an invalid project authority.',
                true,
            );
        }

        const grantEntries = await this.store.readNamespaceEntries<unknown>(projectId, 'grants');
        const seenGrantIds = new Set<string>();
        for (const entry of grantEntries) {
            this.pathGrants.validateRestorable(entry.value);
            const grant = entry.value;
            if (
                entry.name !== `${grant.grantId}.json`
                || grant.sessionId !== durable.sessionId
                || seenGrantIds.has(grant.grantId)
            ) {
                throw managedError(
                    'COORDINATOR_UNAVAILABLE',
                    'A recovered durable path grant has invalid authority.',
                    true,
                );
            }
            seenGrantIds.add(grant.grantId);
            if (!this.pathGrants.hasRegisteredGrant(grant.grantId)) {
                this.pathGrants.register(grant);
            } else if (grant.revokedAt) {
                // A prepared revoke changes process authority only after the WAL commit. If the
                // response was lost at the marker, reproduce that publication idempotently.
                this.pathGrants.prepareRevoke(grant.grantId, {
                    sessionId: grant.sessionId,
                    sessionEpoch: grant.sessionEpoch,
                }).commit();
            }
        }

        loaded.envelope = durable;
        await this.events.publishDurableRange(
            projectId,
            durable.sessionId,
            previousEventSequence,
            durable.eventSequence,
        );
        try {
            await loaded.port.hydrate(durable.editor);
            const pendingPublication = this.pendingTranscriptionPublications.get(projectId);
            if (pendingPublication) {
                const durableReceipt = await this.store.readReceipt(
                    projectId,
                    pendingPublication.toolName,
                    pendingPublication.idempotencyKey,
                );
                this.pendingTranscriptionPublications.delete(projectId);
                if (durableReceipt) {
                    await pendingPublication.prepared.accept?.();
                } else {
                    await pendingPublication.prepared.reject?.();
                }
            }
            loaded.poisoned = false;
        } catch (error) {
            loaded.poisoned = true;
            throw error;
        }
    }

    private committedEditorResult(
        loaded: LoadedProject<State, Command, Result>,
        active: {
            committed: boolean;
            committedResult?: Result;
            committedSnapshot?: ManagedEditorSnapshot<State>;
        },
        warnings: readonly string[],
    ): ManagedMutationResult<Result> {
        if (!active.committed || !active.committedResult || !active.committedSnapshot) {
            throw managedError('INTERNAL_ERROR', 'Core commit bookkeeping is incomplete.');
        }
        this.publishPendingCoreEvent(loaded.envelope.projectId);
        return {
            ok: true,
            data: active.committedResult,
            state: this.stateToken(loaded.envelope),
            warnings,
            replayed: false,
            committedState: this.stateToken(loaded.envelope),
        };
    }

    private async restoreCommittedEditorState(
        loaded: LoadedProject<State, Command, Result>,
        active: {
            committed: boolean;
            committedResult?: Result;
            committedSnapshot?: ManagedEditorSnapshot<State>;
        },
        warnings: readonly string[],
    ): Promise<ManagedMutationResult<Result>> {
        const nextWarnings = [...warnings];
        try {
            if (!active.committedSnapshot) {
                throw new Error('The committed editor snapshot is unavailable.');
            }
            await loaded.port.hydrate(active.committedSnapshot);
            this.publishPendingCoreEvent(loaded.envelope.projectId);
        } catch {
            loaded.poisoned = true;
            nextWarnings.push(
                'The live editor could not restore its committed head and requires recovery.',
            );
        }
        return this.committedEditorResult(loaded, active, nextWarnings);
    }

    private validateNewMutation(
        envelope: ManagedProjectEnvelopeV1<State>,
        request: ManagedMutationEnvelope,
    ): void {
        if (request.apiVersion !== MANAGED_RUNTIME_API_VERSION) {
            throw managedError('UNSUPPORTED_API_VERSION', 'The managed runtime API version is unsupported.');
        }
        if (
            !request.idempotencyKey
            || request.idempotencyKey.length > 200
            || !request.toolName
            || request.toolName.length > 200
            || !/^sha256:[a-f0-9]{64}$/.test(request.canonicalRequestHash)
        ) {
            throw managedError('INVALID_REQUEST', 'Mutation identity fields are empty or oversized.');
        }
        if (request.sessionId !== envelope.sessionId) {
            throw managedError('SESSION_NOT_FOUND', 'The managed session does not match this project.');
        }
        if (request.sessionEpoch !== this.epoch) {
            throw managedError(
                'SESSION_EPOCH_MISMATCH',
                'The managed coordinator restarted; refresh state before sending a new mutation.',
                true,
            );
        }
        if (request.expected.sessionRevision !== envelope.sessionRevision) {
            throw managedError('SESSION_REVISION_CONFLICT', 'The managed session revision is stale.', true);
        }
        if (request.expected.documentRevision !== envelope.editor.documentRevision) {
            throw managedError('REVISION_CONFLICT', 'The editor document revision is stale.', true);
        }
        if (
            request.expected.audioGraphRevision !== undefined
            && request.expected.audioGraphRevision !== envelope.editor.audioGraphRevision
        ) {
            throw managedError('AUDIO_REVISION_CONFLICT', 'The audio graph revision is stale.', true);
        }
        if (
            request.expected.narrativeRevision !== undefined
            && request.expected.narrativeRevision !== envelope.editor.narrativeRevision
        ) {
            throw managedError('NARRATIVE_REVISION_CONFLICT', 'The narrative revision is stale.', true);
        }
    }

    private createReceipt<ReceiptResult>(
        projectId: string,
        request: ManagedMutationEnvelope,
        result: ReceiptResult,
        committedSessionRevision: number,
        retainedSourceIds: readonly string[],
        coreReceipt?: EditorIdempotencyReceipt,
    ): DurableReceipt<ReceiptResult> {
        return {
            schemaVersion: 2,
            projectId,
            toolName: request.toolName,
            idempotencyKey: request.idempotencyKey,
            canonicalRequestHash: request.canonicalRequestHash,
            result,
            committedSessionRevision,
            createdAt: new Date().toISOString(),
            retainedSourceIds: [...retainedSourceIds],
            ...(coreReceipt ? { coreReceipt: structuredClone(coreReceipt) } : {}),
        };
    }

    private projectCoreEvent(
        envelope: ManagedProjectEnvelopeV1<State>,
        commit: EditorPersistenceCommit,
    ): ManagedEvent {
        if (!commit.event) {
            throw managedError('INVALID_REQUEST', 'Core event projection requires an event.');
        }
        const state = this.stateToken(envelope);
        if (commit.event.type === 'project.mutated') {
            return {
                schemaVersion: 1,
                cursor: state.eventCursor,
                type: 'project.mutated',
                occurredAt: commit.event.occurredAt,
                state,
                sequence: envelope.eventSequence,
                data: {
                    commandId: commit.event.commandId,
                    operationIds: [...commit.event.operationIds],
                    affectedIds: affectedGraphIds(commit.previous, commit.next),
                    historyEntryId: commit.event.historyEntryId,
                },
            };
        }
        return {
            schemaVersion: 1,
            cursor: state.eventCursor,
            type: 'history.changed',
            occurredAt: commit.event.occurredAt,
            state,
            sequence: envelope.eventSequence,
            data: {
                currentIndex: commit.next.history.currentIndex,
                undoCount: commit.next.history.past.length,
                redoCount: commit.next.history.future.length,
                ...(commit.next.history.past.at(-1)?.id
                    ? { headEntryId: commit.next.history.past.at(-1)!.id }
                    : {}),
            },
        };
    }

    private createEvent(
        envelope: ManagedProjectEnvelopeV1<State>,
        kind:
            | ManagedEventKind
            | 'project.changed'
            | 'playback.changed'
            | 'presenter.changed'
            | 'grant.changed'
            | 'source.changed',
        eventData: ManagedEventData,
    ): ManagedEvent {
        const state = this.stateToken(envelope);
        const projected = projectManagedEvent(
            kind,
            eventData,
            envelope.editor.manifestDigest,
        );
        return {
            schemaVersion: 1,
            cursor: state.eventCursor,
            type: projected.type,
            occurredAt: new Date().toISOString(),
            state,
            sequence: envelope.eventSequence,
            data: projected.data,
        };
    }

    private async commit(
        loaded: LoadedProject<State, Command, Result>,
        nextEnvelope: ManagedProjectEnvelopeV1<State>,
        writes: readonly DurableWrite[],
    ): Promise<void> {
        try {
            validateProjectEnvelope(nextEnvelope);
            await this.store.transact({
                envelope: nextEnvelope,
                baseSessionRevision: loaded.envelope.sessionRevision,
                writes,
            });
            loaded.envelope = nextEnvelope;
        } catch (error) {
            // Once any persistence boundary fails, recovery owns deciding old vs new. Keeping this
            // process alive could expose an in-memory head that disagrees with the committed WAL.
            loaded.poisoned = true;
            throw error;
        }
    }

    private publishPendingCoreEvent(projectId: string): void {
        const pending = this.pendingCoreEvents.get(projectId);
        if (!pending) return;
        this.pendingCoreEvents.delete(projectId);
        this.events.publish(pending.event);
    }

    private stateToken(envelope: ManagedProjectEnvelopeV1<State>): StateToken {
        return {
            sessionId: envelope.sessionId,
            projectId: envelope.projectId,
            sessionEpoch: this.epoch,
            sessionRevision: envelope.sessionRevision,
            documentRevision: envelope.editor.documentRevision,
            audioGraphRevision: envelope.editor.audioGraphRevision,
            ...(envelope.editor.narrativeRevision !== undefined
                ? { narrativeRevision: envelope.editor.narrativeRevision }
                : {}),
            eventCursor: this.events.cursor(
                envelope.projectId,
                envelope.sessionId,
                envelope.eventSequence,
            ),
        };
    }

    private requireProject(projectId: string): LoadedProject<State, Command, Result> {
        this.assertOpen();
        const loaded = this.projects.get(projectId);
        if (!loaded) throw managedError('SESSION_NOT_FOUND', 'The managed project is not open.');
        if (loaded.poisoned) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The project requires coordinator recovery after a persistence failure.',
                true,
            );
        }
        return loaded;
    }

    private assertOpen(): void {
        if (this.closed || this.closing) {
            throw managedError('COORDINATOR_UNAVAILABLE', 'The coordinator is closing or closed.', true);
        }
    }

    private async serialized<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(projectId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => current);
        this.queues.set(projectId, tail);
        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.queues.get(projectId) === tail) this.queues.delete(projectId);
        }
    }
}

async function loadOrCreateSecret(store: ManagedFilesystemStore): Promise<Uint8Array> {
    const path = join(store.coordinatorRoot, 'secret');
    try {
        const bytes = await readFile(path);
        if (bytes.byteLength !== 32) throw new Error('Coordinator secret has an invalid length.');
        await chmod(path, 0o600);
        return bytes;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const bytes = randomBytes(32);
        await atomicWriteFile(path, bytes, { mode: 0o600, faultPrefix: 'coordinator-secret' });
        return bytes;
    }
}

function summary<State>(envelope: ManagedProjectEnvelopeV1<State>): ManagedSessionSummary {
    return {
        projectId: envelope.projectId,
        sessionId: envelope.sessionId,
        name: envelope.name,
        sessionRevision: envelope.sessionRevision,
        documentRevision: envelope.editor.documentRevision,
        archived: envelope.archivedAt !== undefined,
        recovered: envelope.recoveryCount > 0,
    };
}

function sessionOpenResult<State>(
    input: ManagedSessionOpenInput<State>,
    envelope: ManagedProjectEnvelopeV1<State>,
): ManagedSessionOpenResult {
    return {
        action: input.action,
        created: input.action === 'create',
        recovered: input.action === 'recover',
        participantId: `participant_${canonicalDigest({
            projectId: envelope.projectId,
            idempotencyKey: input.idempotencyKey,
        }).slice(7, 39)}`,
        project: summary(envelope),
    };
}

function bootstrapReceipt<State>(
    input: ManagedSessionOpenInput<State>,
    result: ManagedSessionOpenResult,
    envelope: ManagedProjectEnvelopeV1<State>,
): DurableReceipt<ManagedSessionOpenResult> {
    return {
        schemaVersion: 2,
        projectId: input.projectId,
        toolName: 'waptions_session_open',
        idempotencyKey: input.idempotencyKey,
        canonicalRequestHash: input.canonicalRequestHash,
        result,
        committedSessionRevision: envelope.sessionRevision,
        createdAt: new Date().toISOString(),
        retainedSourceIds: [...envelope.editor.reachableSourceIds],
    };
}

function validateEditorSnapshot<State>(snapshot: ManagedEditorSnapshot<State>): void {
    canonicalJson(snapshot, 32 * 1024 * 1024);
    for (const [name, value] of Object.entries({
        documentRevision: snapshot.documentRevision,
        audioGraphRevision: snapshot.audioGraphRevision,
        historyRevision: snapshot.historyRevision,
        ...(snapshot.narrativeRevision === undefined
            ? {}
            : { narrativeRevision: snapshot.narrativeRevision }),
    })) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw managedError('INVALID_REQUEST', `The editor ${name} is invalid.`);
        }
    }
    if (!snapshot.manifestDigest || snapshot.manifestDigest.length > 200) {
        throw managedError('INVALID_REQUEST', 'The editor manifest digest is invalid.');
    }
    validateStringSet(snapshot.reachableSourceIds, 'reachable source');
    validateStringSet(snapshot.transcriptRecordIds, 'transcript record');
}

function validateProjectEnvelope<State>(envelope: ManagedProjectEnvelopeV1<State>): void {
    canonicalJson(envelope, 64 * 1024 * 1024);
    validateEditorSnapshot(envelope.editor);
    for (const [name, value] of Object.entries({
        sessionRevision: envelope.sessionRevision,
        eventSequence: envelope.eventSequence,
        receiptRevision: envelope.receiptRevision,
        jobRevision: envelope.jobRevision,
        artifactRevision: envelope.artifactRevision,
        grantRevision: envelope.grantRevision,
        sourceRegistryRevision: envelope.sourceRegistryRevision,
        recoveryCount: envelope.recoveryCount,
        playbackRevision: envelope.playback.revision,
        playbackOutputSample: envelope.playback.outputSample,
    })) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw managedError('INVALID_REQUEST', `The managed project ${name} is invalid.`);
        }
    }
    if (
        !Number.isFinite(envelope.playback.rate)
        || envelope.playback.rate <= 0
        || envelope.playback.rate > 16
        || !Number.isFinite(envelope.playback.masterVolume)
        || envelope.playback.masterVolume < 0
        || envelope.playback.masterVolume > 4
    ) {
        throw managedError('INVALID_REQUEST', 'The managed project playback state is invalid.');
    }
    const sourceIds = new Set<string>();
    for (const source of envelope.sourceRegistry) {
        if (
            !source.sourceId
            || source.sourceId.length > 200
            || sourceIds.has(source.sourceId)
            || !Number.isSafeInteger(source.byteLength)
            || source.byteLength < 0
            || !source.digest
            || source.digest.length > 256
            || !source.immutableVersion
            || source.immutableVersion.length > 256
            || !source.streamSignature
            || source.streamSignature.length > 512
            || !Number.isFinite(Date.parse(source.registeredAt))
            || (
                source.releasedAt !== undefined
                && !Number.isFinite(Date.parse(source.releasedAt))
            )
        ) {
            throw managedError('INVALID_REQUEST', 'A managed source registry record is invalid.');
        }
        sourceIds.add(source.sourceId);
    }
}

function validateManagedResult(value: unknown, maximumBytes = 768 * 1024): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw managedError('INVALID_REQUEST', 'The managed mutation result must be an object.');
    }
    canonicalJson(value, maximumBytes);
}

function omitUndefinedEnvelopeFields<State>(
    envelope: ManagedProjectEnvelopeV1<State>,
): ManagedProjectEnvelopeV1<State> {
    return Object.fromEntries(
        Object.entries(envelope).filter(([, value]) => value !== undefined),
    ) as unknown as ManagedProjectEnvelopeV1<State>;
}

function validateEditorPersistenceCommit<State>(input: {
    input: EditorPersistenceCommit;
    projectId: string;
    epoch: string;
    request: ManagedMutationEnvelope;
    envelope: ManagedProjectEnvelopeV1<State>;
    currentSnapshot: ManagedEditorSnapshot<State>;
    nextSnapshot: ManagedEditorSnapshot<State>;
    editorEventSequence?: number;
}): CoreCommitEvidenceV1 {
    const commit = input.input;
    canonicalJson(commit, CORE_COMMIT_CANONICAL_MAX_BYTES);
    validateCommitIdentity(commit.commandId, 'command');
    validateCommitIdentity(commit.transaction.walTransactionId, 'WAL transaction');
    validateCommitIdentity(commit.receipt.value.requestHash, 'Core request hash');
    validateCommitIdentityList(commit.transaction.operationIds, 'operation');
    validateEditorHistoryState(commit.history);

    if (
        commit.schemaVersion !== 1
        || commit.projectId !== input.projectId
        || commit.previous.projectId !== input.projectId
        || commit.next.projectId !== input.projectId
        || commit.toolName !== input.request.toolName
        || commit.receipt.toolName !== input.request.toolName
        || commit.receipt.value.toolName !== input.request.toolName
        || commit.receipt.key !== input.request.idempotencyKey
        || commit.receipt.value.idempotencyKey !== input.request.idempotencyKey
    ) {
        throw managedError(
            'INVALID_REQUEST',
            'Core persistence identities do not match the serialized mutation.',
        );
    }
    if (
        !/^sha256:[a-f0-9]{64}$/.test(commit.receipt.value.requestHash)
        || !Number.isFinite(Date.parse(commit.transaction.preparedAt))
    ) {
        throw managedError('INVALID_REQUEST', 'Core persistence transaction metadata is invalid.');
    }

    const previousRevisions = managedSnapshotRevisions(
        input.currentSnapshot,
        input.epoch,
        input.envelope.sessionRevision,
    );
    if (!canonicalEqual(commit.previous.revisions, previousRevisions)) {
        throw managedError(
            'REVISION_CONFLICT',
            'Core persistence did not start from the authoritative editor revisions.',
            true,
        );
    }
    const embeddedHead = embeddedCoreHead(input.currentSnapshot);
    if (embeddedHead) {
        if (!canonicalEqual(
            commit.previous,
            embeddedHead,
            CORE_SNAPSHOT_CANONICAL_MAX_BYTES,
        )) {
            throw managedError(
                'REVISION_CONFLICT',
                'Core persistence previous snapshot does not match the authoritative Core head.',
                true,
            );
        }
    } else if (
        !/^sha256:[a-f0-9]{64}$/.test(input.currentSnapshot.manifestDigest)
        || canonicalDigest(
            commit.previous.manifest,
            CORE_SNAPSHOT_CANONICAL_MAX_BYTES,
        ) !== input.currentSnapshot.manifestDigest
    ) {
        throw managedError(
            'REVISION_CONFLICT',
            'The editor adapter cannot canonically prove the previous Core head.',
            true,
        );
    }

    const nextRevisions = sessionStateRevisions(commit.sessionState);
    validateRevisionRecord(nextRevisions);
    if (
        !canonicalEqual(commit.next.revisions, nextRevisions)
        || commit.sessionState.sessionEpoch !== input.epoch
        || commit.sessionState.projectName !== commit.next.project.name
        || commit.sessionState.documentRevision !== input.nextSnapshot.documentRevision
        || commit.sessionState.audioGraphRevision !== input.nextSnapshot.audioGraphRevision
        || commit.sessionState.narrativeRevision !== input.nextSnapshot.narrativeRevision
        || commit.sessionState.sessionRevision !== input.nextSnapshot.historyRevision
        || commit.transaction.fromDocumentRevision
            !== commit.previous.revisions.documentRevision
        || commit.transaction.toDocumentRevision !== commit.next.revisions.documentRevision
        || commit.previous.manifest.revision !== commit.previous.revisions.documentRevision
        || commit.previous.manifest.audioGraphRevision
            !== commit.previous.revisions.audioGraphRevision
        || commit.next.manifest.revision !== commit.next.revisions.documentRevision
        || commit.next.manifest.audioGraphRevision !== commit.next.revisions.audioGraphRevision
        || canonicalDigest(
            commit.next.manifest,
            CORE_SNAPSHOT_CANONICAL_MAX_BYTES,
        ) !== input.nextSnapshot.manifestDigest
    ) {
        throw managedError(
            'REVISION_CONFLICT',
            'Core persistence revisions or projected head are inconsistent.',
            true,
        );
    }

    validateSnapshotAssetReferences(commit.previous);
    validateSnapshotAssetReferences(commit.next);
    validateHistoryProjection(commit.next, commit.history);
    if (
        !canonicalEqual(commit.transcriptPins, {
            durableRecordIds: collectManifestTranscriptRecordIds(commit.next.manifest),
            ...collectHistoryPins(commit.history),
        })
        || !canonicalEqual(commit.sourcePins, {
            current: collectManifestSourceIds(commit.next.manifest),
            ...collectSourcePins(commit.history),
        })
    ) {
        throw managedError(
            'INVALID_REQUEST',
            'Core persistence pins do not match the committed snapshot and history.',
        );
    }

    const receiptResult = commit.receipt.value.result as unknown as Record<string, unknown>;
    const coreEventSequence = input.editorEventSequence
        ?? (commit.event ? commit.event.sequence - 1 : commit.sessionState.eventSequence);
    if (
        receiptResult.ok !== true
        || receiptResult.commandId !== commit.commandId
        || receiptResult.noOp !== (commit.event === null)
        || receiptResult.eventId !== (commit.event?.id ?? null)
        || receiptResult.historyEntryId !== (commit.event?.historyEntryId ?? null)
    ) {
        throw managedError(
            'INVALID_REQUEST',
            'Core persistence receipt identities do not match the commit.',
        );
    }

    if (commit.event === null) {
        if (
            commit.sessionState.sessionRevision !== input.envelope.sessionRevision
            || commit.sessionState.eventSequence !== coreEventSequence
            || !canonicalEqual(
                commit.previous,
                commit.next,
                CORE_SNAPSHOT_CANONICAL_MAX_BYTES,
            )
        ) {
            throw managedError(
                'INVALID_REQUEST',
                'A Core no-op cannot advance or replace the authoritative head.',
            );
        }
    } else {
        validateCommitIdentity(commit.event.id, 'event');
        if (
            commit.event.projectId !== input.projectId
            || commit.event.commandId !== commit.commandId
            || commit.event.sequence !== coreEventSequence + 1
            || commit.sessionState.eventSequence !== commit.event.sequence
            || commit.sessionState.sessionRevision !== input.envelope.sessionRevision + 1
            || commit.event.occurredAt !== commit.transaction.preparedAt
            || !canonicalEqual(commit.event.revisions, commit.next.revisions)
        ) {
            throw managedError(
                'INVALID_REQUEST',
                'A Core event does not match the transaction and contiguous revisions.',
            );
        }
        if (
            (
                commit.event.type === 'project.mutated'
                && !canonicalEqual(
                    commit.event.operationIds,
                    commit.transaction.operationIds,
                )
            )
            || (
                commit.event.type === 'history.changed'
                && !canonicalEqual(
                    commit.transaction.operationIds,
                    [`history.${commit.event.action}`],
                )
            )
        ) {
            throw managedError(
                'INVALID_REQUEST',
                'Core event operation identities do not match the transaction.',
            );
        }
    }

    const evidence: CoreCommitEvidenceV1 = {
        schemaVersion: 1,
        projectId: commit.projectId,
        toolName: commit.toolName,
        commandId: commit.commandId,
        walTransactionId: commit.transaction.walTransactionId,
        preparedAt: commit.transaction.preparedAt,
        receiptRevision: 0,
        commitDigest: canonicalDigest(commit, CORE_COMMIT_CANONICAL_MAX_BYTES),
        previousDigest: canonicalDigest(
            commit.previous,
            CORE_SNAPSHOT_CANONICAL_MAX_BYTES,
        ),
        nextDigest: canonicalDigest(commit.next, CORE_SNAPSHOT_CANONICAL_MAX_BYTES),
        historyDigest: canonicalDigest(commit.history, CORE_SNAPSHOT_CANONICAL_MAX_BYTES),
        receiptDigest: canonicalDigest(commit.receipt, 2 * 1024 * 1024),
        operationIdsDigest: canonicalDigest(commit.transaction.operationIds, 2 * 1024 * 1024),
        operationCount: commit.transaction.operationIds.length,
        fromDocumentRevision: commit.transaction.fromDocumentRevision,
        toDocumentRevision: commit.transaction.toDocumentRevision,
        sessionState: structuredClone(commit.sessionState),
        event: commit.event
            ? {
                id: commit.event.id,
                type: commit.event.type,
                sequence: commit.event.sequence,
                digest: canonicalDigest(commit.event, 2 * 1024 * 1024),
            }
            : null,
    };
    canonicalJson(evidence, 64 * 1024);
    return evidence;
}

function managedSnapshotRevisions<State>(
    snapshot: ManagedEditorSnapshot<State>,
    sessionEpoch: string,
    sessionRevision: number,
): EditorPersistenceCommit['previous']['revisions'] {
    return {
        sessionEpoch,
        sessionRevision,
        documentRevision: snapshot.documentRevision,
        audioGraphRevision: snapshot.audioGraphRevision,
        ...(snapshot.narrativeRevision === undefined
            ? {}
            : { narrativeRevision: snapshot.narrativeRevision }),
    };
}

function coreRequestFromCommit<State>(
    commit: EditorPersistenceCommit,
    currentSnapshot: ManagedEditorSnapshot<State>,
    sessionId: string,
): ManagedMutationEnvelope {
    return {
        apiVersion: MANAGED_RUNTIME_API_VERSION,
        sessionId,
        sessionEpoch: commit.previous.revisions.sessionEpoch,
        toolName: commit.toolName,
        idempotencyKey: commit.receipt.key,
        canonicalRequestHash: commit.receipt.value.requestHash,
        expected: {
            sessionRevision: commit.previous.revisions.sessionRevision,
            documentRevision: currentSnapshot.documentRevision,
            audioGraphRevision: currentSnapshot.audioGraphRevision,
            ...(currentSnapshot.narrativeRevision === undefined
                ? {}
                : { narrativeRevision: currentSnapshot.narrativeRevision }),
        },
        command: {},
    };
}

function sessionStateRevisions(
    session: EditorPersistenceCommit['sessionState'],
): EditorPersistenceCommit['next']['revisions'] {
    return {
        sessionEpoch: session.sessionEpoch,
        sessionRevision: session.sessionRevision,
        documentRevision: session.documentRevision,
        audioGraphRevision: session.audioGraphRevision,
        ...(session.narrativeRevision === undefined
            ? {}
            : { narrativeRevision: session.narrativeRevision }),
    };
}

function embeddedCoreHead<State>(
    snapshot: ManagedEditorSnapshot<State>,
): EditorPersistenceCommit['previous'] | null {
    if (!snapshot.state || typeof snapshot.state !== 'object' || Array.isArray(snapshot.state)) {
        return null;
    }
    const candidate = (snapshot.state as Record<string, unknown>).snapshot;
    if (
        !candidate
        || typeof candidate !== 'object'
        || Array.isArray(candidate)
        || !('projectId' in candidate)
        || !('manifest' in candidate)
        || !('revisions' in candidate)
        || !('history' in candidate)
        || !('assetReferences' in candidate)
    ) {
        return null;
    }
    return candidate as EditorPersistenceCommit['previous'];
}

function validateRevisionRecord(
    revisions: EditorPersistenceCommit['next']['revisions'],
): void {
    if (
        !revisions.sessionEpoch
        || revisions.sessionEpoch.length > 256
        || !Number.isSafeInteger(revisions.sessionRevision)
        || revisions.sessionRevision < 0
        || !Number.isSafeInteger(revisions.documentRevision)
        || revisions.documentRevision < 0
        || !Number.isSafeInteger(revisions.audioGraphRevision)
        || revisions.audioGraphRevision < 0
        || (
            revisions.narrativeRevision !== undefined
            && (
                !Number.isSafeInteger(revisions.narrativeRevision)
                || revisions.narrativeRevision < 0
            )
        )
    ) {
        throw managedError('INVALID_REQUEST', 'Core persistence revisions are invalid.');
    }
}

function validateSnapshotAssetReferences(
    snapshot: EditorPersistenceCommit['next'],
): void {
    const expected = {
        ...collectManifestSourceIds(snapshot.manifest),
        transcriptRecordIds: collectManifestTranscriptRecordIds(snapshot.manifest),
    };
    if (!canonicalEqual(snapshot.assetReferences, expected)) {
        throw managedError(
            'INVALID_REQUEST',
            'Core snapshot asset references do not match its manifest.',
        );
    }
}

function validateHistoryProjection(
    snapshot: EditorPersistenceCommit['next'],
    history: EditorPersistenceCommit['history'],
): void {
    const pastLength = snapshot.history.past.length;
    const futureLength = snapshot.history.future.length;
    const expectedPast = history.past
        .slice(-pastLength || history.past.length)
        .map((entry) => entry.summary);
    const expectedFuture = [...history.future]
        .reverse()
        .slice(0, futureLength)
        .map((entry) => entry.summary);
    if (
        pastLength > history.past.length
        || futureLength > history.future.length
        || snapshot.history.currentIndex !== history.past.length
        || !canonicalEqual(snapshot.history.past, expectedPast)
        || !canonicalEqual(snapshot.history.future, expectedFuture)
    ) {
        throw managedError(
            'INVALID_REQUEST',
            'Core snapshot history does not match the committed history state.',
        );
    }
}

function validateCommitIdentity(value: string, label: string): void {
    if (typeof value !== 'string' || !value || value.length > 256) {
        throw managedError('INVALID_REQUEST', `The Core ${label} identity is invalid.`);
    }
}

function validateCommitIdentityList(values: readonly string[], label: string): void {
    if (
        !Array.isArray(values)
        || values.length > 100_000
        || new Set(values).size !== values.length
    ) {
        throw managedError('INVALID_REQUEST', `The Core ${label} identities are invalid.`);
    }
    for (const value of values) validateCommitIdentity(value, label);
}

function canonicalEqual(left: unknown, right: unknown, maximumBytes = 4 * 1024 * 1024): boolean {
    return canonicalDigest(left, maximumBytes) === canonicalDigest(right, maximumBytes);
}

function sourceRegistryAdditions(
    commit: EditorPersistenceCommit,
): ManagedSourceRegistryRecord[] {
    return [
        ...commit.sourceRegistrations.videoSources.map((source) => ({
            sourceId: source.id,
            immutableVersion: source.handle.identity.immutableVersion,
            byteLength: source.handle.identity.byteLength,
            digest: source.handle.identity.contentDigest,
            streamSignature: source.handle.identity.descriptorFingerprint,
            registeredAt: source.handle.verifiedAt,
        })),
        ...commit.sourceRegistrations.audioSources.map((source) => ({
            sourceId: source.id,
            immutableVersion: source.handle.identity.immutableVersion,
            byteLength: source.handle.identity.byteLength,
            digest: source.handle.identity.contentDigest,
            streamSignature: source.handle.identity.descriptorFingerprint,
            registeredAt: source.handle.verifiedAt,
        })),
    ];
}

function affectedGraphIds(
    previous: EditorPersistenceCommit['previous'],
    next: EditorPersistenceCommit['next'],
): string[] {
    const collect = (snapshot: EditorPersistenceCommit['next']) => new Map<string, unknown>([
        ...snapshot.manifest.videoTracks.map((entity) => [entity.id, entity] as const),
        ...snapshot.manifest.videoClips.map((entity) => [entity.id, entity] as const),
        ...snapshot.manifest.audioTracks.map((entity) => [entity.id, entity] as const),
        ...snapshot.manifest.audioTracks.flatMap(
            (track) => track.clips.map((entity) => [entity.id, entity] as const),
        ),
        ...snapshot.manifest.subtitleTracks.map((entity) => [entity.id, entity] as const),
        ...snapshot.manifest.subtitleTracks.flatMap(
            (track) => track.subtitles.map((entity) => [entity.id, entity] as const),
        ),
        ...snapshot.manifest.videoSourceDescriptors.map(
            (entity) => [entity.id, entity] as const,
        ),
        ...snapshot.manifest.audioSourceDescriptors.map(
            (entity) => [entity.id, entity] as const,
        ),
    ]);
    const before = collect(previous);
    const after = collect(next);
    return Array.from(new Set([...before.keys(), ...after.keys()]))
        .filter((id) => {
            const previousValue = before.get(id);
            const nextValue = after.get(id);
                return previousValue === undefined
                || nextValue === undefined
                || canonicalDigest(
                    previousValue,
                    CORE_SNAPSHOT_CANONICAL_MAX_BYTES,
                ) !== canonicalDigest(nextValue, CORE_SNAPSHOT_CANONICAL_MAX_BYTES);
        })
        .slice(0, 1_024);
}

function isCoreFailure(value: unknown): value is {
    ok: false;
    error: {
        code: ManagedRuntimeErrorCode | 'STALE_TRANSCRIPTION_PUBLICATION';
        message: string;
        retryable: boolean;
    };
} {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as {
        ok?: unknown;
        error?: { code?: unknown; message?: unknown; retryable?: unknown };
    };
    return candidate.ok === false
        && (
            isManagedRuntimeErrorCode(candidate.error?.code)
            || candidate.error?.code === 'STALE_TRANSCRIPTION_PUBLICATION'
        )
        && typeof candidate.error?.message === 'string'
        && typeof candidate.error?.retryable === 'boolean';
}

function managedCoreFailure(error: {
    code: ManagedRuntimeErrorCode | 'STALE_TRANSCRIPTION_PUBLICATION';
    message: string;
    retryable: boolean;
}): {
    code: ManagedRuntimeErrorCode;
    message: string;
    retryable: boolean;
} {
    return {
        code: error.code === 'STALE_TRANSCRIPTION_PUBLICATION'
            ? 'REVISION_CONFLICT'
            : error.code,
        message: error.message.slice(0, 512),
        retryable: error.code === 'STALE_TRANSCRIPTION_PUBLICATION' || error.retryable,
    };
}

async function appendAuthorityCommitWarning<Result>(
    result: ManagedMutationResult<Result>,
    authority?: {
        commitAuthority(): void | Promise<void>;
    },
): Promise<void> {
    if (!authority || !result.ok) return;
    try {
        await authority.commitAuthority();
    } catch {
        result.warnings = [
            ...result.warnings,
            'The Core commit is durable but its process-local media authority needs recovery.',
        ];
    }
}

function isManagedRuntimeErrorCode(value: unknown): value is ManagedRuntimeErrorCode {
    return typeof value === 'string' && MANAGED_RUNTIME_ERROR_CODES.has(value);
}

const MANAGED_RUNTIME_ERROR_CODES: ReadonlySet<string> = new Set([
    'INVALID_REQUEST',
    'UNSUPPORTED_API_VERSION',
    'PAYLOAD_TOO_LARGE',
    'SESSION_NOT_FOUND',
    'SESSION_EPOCH_MISMATCH',
    'SESSION_REVISION_CONFLICT',
    'REVISION_CONFLICT',
    'NARRATIVE_REVISION_CONFLICT',
    'AUDIO_REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_CONFLICT',
    'PLAN_NOT_FOUND',
    'PLAN_EXPIRED',
    'PLAN_INPUT_CHANGED',
    'NOT_FOUND',
    'INVALID_DOCUMENT',
    'INVALID_OPERATION',
    'OVERLAP_CONFLICT',
    'LOCKED_TARGET',
    'ORDER_NOT_MEANINGFUL',
    'SOURCE_CHANGED',
    'SOURCE_UNREADABLE',
    'PATH_NOT_GRANTED',
    'WRITE_DESTINATION_NOT_GRANTED',
    'OVERWRITE_NOT_AUTHORIZED',
    'PATH_IDENTITY_CHANGED',
    'UNSUPPORTED_MEDIA',
    'NO_AUDIO',
    'CODEC_UNAVAILABLE',
    'TRANSCRIPTION_POLICY_REJECTED',
    'TRANSCRIPTION_ENDPOINT_UNREACHABLE',
    'SSRF_POLICY_REJECTED',
    'JOB_NOT_CANCELLABLE',
    'EVENT_CURSOR_EXPIRED',
    'ARTIFACT_EXPIRED',
    'CAPABILITY_EXPIRED',
    'COORDINATOR_UNAVAILABLE',
    'INTERNAL_ERROR',
]);

function validateStringSet(values: readonly string[], label: string): void {
    if (values.length > 100_000 || new Set(values).size !== values.length) {
        throw managedError('INVALID_REQUEST', `The editor ${label} list is invalid.`);
    }
    if (values.some((value) => !value || value.length > 200)) {
        throw managedError('INVALID_REQUEST', `An editor ${label} identifier is invalid.`);
    }
}

function jobEventData(record: DurableJobRecord): Readonly<Record<string, unknown>> {
    return {
        jobId: record.jobId,
        kind: record.kind,
        state: toJobBoundaryState(record.state),
        stage: record.stage,
        jobSequence: record.sequence,
        ...(record.fraction === undefined ? {} : { fraction: record.fraction }),
        ...(record.message === undefined ? {} : { message: record.message }),
    };
}

function projectManagedEvent(
    kind:
        | ManagedEventKind
        | 'project.changed'
        | 'playback.changed'
        | 'presenter.changed'
        | 'grant.changed'
        | 'source.changed',
    data: ManagedEventData,
    manifestDigest: string,
): { type: ManagedEventKind; data: ManagedEventData } {
    if (
        kind === 'project.changed'
        || kind === 'playback.changed'
        || kind === 'presenter.changed'
        || kind === 'grant.changed'
        || kind === 'source.changed'
    ) {
        return {
            type: 'project.snapshot',
            data: {
                manifestDigest,
                reason: 'refreshed',
            },
        };
    }
    return { type: kind, data };
}

function boundedIdentity(value: string): string {
    const normalized = value?.trim();
    if (!normalized || normalized.length > 256) {
        throw managedError('INVALID_REQUEST', 'The artifact source identity is invalid.');
    }
    return normalized;
}

function validateConnectionIdentity(value: string, label: string): void {
    if (typeof value !== 'string' || !value || value.length > 256) {
        throw managedError('INVALID_REQUEST', `The managed ${label} identity is invalid.`);
    }
}
