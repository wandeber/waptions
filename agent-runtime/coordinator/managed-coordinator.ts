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
import { atomicWriteFile, atomicWriteJson } from '../persistence/fs-durable';
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

export interface ManagedCoordinatorOptions {
    scheduler?: JobSchedulerOptions;
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
    eventKind: ManagedEventKind;
    eventData: ManagedEventData;
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
    private readonly activeEditorRequests = new Map<string, {
        request: ManagedMutationEnvelope<Command>;
        committed: boolean;
        committedResult?: Result;
        committedSnapshot?: ManagedEditorSnapshot<State>;
    }>();
    private readonly pendingCoreEvents = new Map<string, {
        coreEventId: string;
        event: ManagedEvent;
    }>();
    private closed = false;
    private closing = false;

    private constructor(
        readonly dataRoot: string,
        private readonly lock: SingleInstanceLock,
        private readonly portFactory: ManagedEditorPortFactory<State, Command, Result>,
        store: ManagedFilesystemStore,
        secret: Uint8Array,
        epoch: string,
        options: ManagedCoordinatorOptions,
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
        options: ManagedCoordinatorOptions = {},
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

    async mutateEditor(
        projectId: string,
        request: ManagedMutationEnvelope<Command>,
    ): Promise<ManagedMutationResult<Result>> {
        return this.serialized(projectId, async () => {
            let loaded = this.projects.get(projectId);
            let active: {
                request: ManagedMutationEnvelope<Command>;
                committed: boolean;
                committedResult?: Result;
                committedSnapshot?: ManagedEditorSnapshot<State>;
            } | undefined;
            try {
                const replay = await this.resolveReceipt<Result>(projectId, request);
                if (replay) return replay;
                loaded = this.requireProject(projectId);
                this.validateNewMutation(loaded.envelope, request);
                const before = loaded.port.snapshot();
                validateEditorSnapshot(before);
                active = {
                    request,
                    committed: false,
                };
                this.activeEditorRequests.set(projectId, active);
                let result: Result;
                try {
                    result = await loaded.port.dispatch({ command: request.command, request });
                } catch (error) {
                    if (!active.committed) throw error;
                    return this.restoreCommittedEditorState(loaded, active, [
                        'Core threw after its durable commit; the committed result is authoritative.',
                    ]);
                }
                if (!active.committed) {
                    validateManagedResult(result);
                    const after = loaded.port.snapshot();
                    validateEditorSnapshot(after);
                    if (canonicalDigest(after) !== canonicalDigest(before)) {
                        await loaded.port.hydrate(before);
                    }
                    if (isCoreFailure(result)) {
                        return {
                            ok: false,
                            error: {
                                code: result.error.code,
                                message: result.error.message.slice(0, 512),
                                retryable: result.error.retryable,
                            },
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
                    validateManagedResult(result);
                    if (
                        canonicalDigest(active.committedResult) !== canonicalDigest(result)
                        || canonicalDigest(active.committedSnapshot)
                            !== canonicalDigest(loaded.port.snapshot())
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
                return this.committedEditorResult(loaded, active, warnings);
            } catch (error) {
                if (active?.committed && loaded) {
                    return this.restoreCommittedEditorState(loaded, active, [
                        'Core failed after its durable commit; the committed result is authoritative.',
                    ]);
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
                canonicalJson(mutation.eventData, 48 * 1024);
                const updated = mutation.update(structuredClone(loaded.envelope));
                const nextEnvelope: ManagedProjectEnvelopeV1<State> = {
                    ...updated,
                    sessionRevision: loaded.envelope.sessionRevision,
                    receiptRevision: loaded.envelope.receiptRevision + 1,
                    eventSequence: loaded.envelope.eventSequence + 1,
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
                const event = this.createEvent(nextEnvelope, mutation.eventKind, mutation.eventData);
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
                    this.events.write(event),
                    ...await this.store.receiptRetentionDeletes(projectId),
                    ...await this.events.retentionDeletes(projectId),
                ]);
                committed = true;
                await loaded.port.hydrate(nextEnvelope.editor);
                this.events.publish(event);
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
        update: Partial<Omit<ManagedProjectEnvelopeV1<State>['playback'], 'revision'>>,
    ): Promise<ManagedMutationResult<{ playback: ManagedProjectEnvelopeV1<State>['playback'] }>> {
        return this.mutateRegistry(projectId, request, (envelope) => {
            const current = envelope.playback;
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
            const playback = { ...current, ...update, revision: current.revision + 1 };
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
            || input.toolName !== active.request.toolName
            || input.receipt.toolName !== active.request.toolName
            || input.receipt.key !== active.request.idempotencyKey
            || input.receipt.value.idempotencyKey !== active.request.idempotencyKey
        ) {
            throw managedError(
                'INVALID_REQUEST',
                'Core attempted persistence outside the serialized coordinator dispatch.',
            );
        }
        if (active.committed) {
            throw managedError('INTERNAL_ERROR', 'Core attempted more than one atomic commit.', false);
        }
        const nextSnapshot = loaded.port.snapshotFromCommit(input);
        validateEditorSnapshot(nextSnapshot);
        if (
            input.transaction.fromDocumentRevision
                !== loaded.envelope.editor.documentRevision
            || input.previous.revisions.documentRevision
                !== loaded.envelope.editor.documentRevision
            || input.sessionState.documentRevision !== nextSnapshot.documentRevision
            || input.sessionState.audioGraphRevision !== nextSnapshot.audioGraphRevision
            || input.next.revisions.sessionRevision !== input.sessionState.sessionRevision
            || input.next.revisions.sessionEpoch !== this.epoch
        ) {
            throw managedError(
                'REVISION_CONFLICT',
                'Core persistence did not start from the authoritative editor head.',
                true,
            );
        }
        if (
            input.sessionState.sessionRevision !== loaded.envelope.sessionRevision
            && input.sessionState.sessionRevision !== loaded.envelope.sessionRevision + 1
        ) {
            throw managedError(
                'INVALID_REQUEST',
                'Core produced a non-contiguous session revision.',
            );
        }
        if (
            input.event === null
            && (
                input.sessionState.sessionRevision !== loaded.envelope.sessionRevision
                || input.sessionState.eventSequence
                    !== (loaded.port.editorEventSequence?.() ?? input.sessionState.eventSequence)
            )
        ) {
            throw managedError(
                'INVALID_REQUEST',
                'A Core no-op cannot advance session or event revisions.',
            );
        }
        if (
            input.event
            && (
                input.event.sequence
                    !== (loaded.port.editorEventSequence?.() ?? input.event.sequence - 1) + 1
                || input.sessionState.eventSequence !== input.event.sequence
                || input.sessionState.sessionRevision !== loaded.envelope.sessionRevision + 1
            )
        ) {
            throw managedError(
                'INVALID_REQUEST',
                'A Core event must advance contiguous session and event revisions.',
            );
        }
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
        validateManagedResult(result);
        const event = input.event
            ? this.projectCoreEvent(nextEnvelope, input)
            : null;
        const receipt = this.createReceipt(
            projectId,
            active.request,
            input.receipt.value.result,
            nextEnvelope.sessionRevision,
            nextSnapshot.reachableSourceIds,
            input.receipt.value,
        );
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
            await this.commit(loaded, nextEnvelope, [
                {
                    relativePath: `core/commits/${canonicalDigest(
                        input.transaction.walTransactionId,
                    ).slice(7)}.json`,
                    value: input,
                },
                this.store.receiptWrite(receipt),
                ...(event ? [this.events.write(event)] : []),
                ...await this.store.receiptRetentionDeletes(projectId),
                ...(event ? await this.events.retentionDeletes(projectId) : []),
            ]);
        } finally {
            await Promise.allSettled(retainedHandles.map((handle) => handle.close()));
        }
        active.committedResult = structuredClone(result);
        active.committedSnapshot = structuredClone(nextSnapshot);
        active.committed = true;
        if (event && input.event) {
            this.pendingCoreEvents.set(projectId, {
                coreEventId: input.event.id,
                event,
            });
        }
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
            if (
                artifacts.some((artifact) => artifact.record.projectId !== record.projectId)
                || new Set(artifacts.map((artifact) => artifact.record.artifactId)).size
                    !== artifacts.length
                || outputs.some((output) => (
                    output.record.sessionId !== loaded.envelope.sessionId
                ))
                || new Set(outputs.map((output) => output.record.publicationId)).size
                    !== outputs.length
            ) {
                await Promise.allSettled([
                    ...artifacts.map((artifact) => artifact.reject()),
                    ...outputs.map((output) => output.reject()),
                ]);
                throw managedError(
                    'INVALID_REQUEST',
                    'Terminal publications do not belong to the durable job project.',
                );
            }
            const nextEnvelope: ManagedProjectEnvelopeV1<State> = {
                ...loaded.envelope,
                sessionRevision: loaded.envelope.sessionRevision,
                jobRevision: loaded.envelope.jobRevision + 1,
                artifactRevision: loaded.envelope.artifactRevision + (artifacts.length > 0 ? 1 : 0),
                eventSequence: loaded.envelope.eventSequence + 1,
                updatedAt: new Date().toISOString(),
            };
            const event = this.createEvent(nextEnvelope, 'job.changed', jobEventData(record));
            let committed = false;
            try {
                await this.commit(loaded, nextEnvelope, [
                    ...artifacts.map((artifact) => artifact.registryWrite),
                    ...outputs.map((output) => output.registryWrite),
                    {
                        relativePath: `jobs/${record.jobId}.json`,
                        value: record,
                    },
                    this.events.write(event),
                    ...await this.events.retentionDeletes(record.projectId),
                ]);
                committed = true;
                await loaded.port.hydrate(nextEnvelope.editor);
                this.events.publish(event);
                for (const artifact of artifacts) artifact.accept();
                await Promise.all(outputs.map((output) => output.accept()));
            } catch (error) {
                if (committed) {
                    for (const artifact of artifacts) artifact.accept();
                    await Promise.allSettled(outputs.map((output) => output.accept()));
                    return;
                }
                await Promise.allSettled([
                    ...artifacts.map((artifact) => artifact.reject()),
                    ...outputs.map((output) => output.reject()),
                ]);
                throw error;
            }
        });
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
            // before applying any new guards, then retry the exact receipt lookup.
            await this.store.recoverProject(projectId);
            const durable = await this.store.readProject<State>(projectId);
            if (durable) {
                validateProjectEnvelope(durable);
                loadedBeforeRecovery.envelope = durable;
                try {
                    await loadedBeforeRecovery.port.hydrate(durable.editor);
                    loadedBeforeRecovery.poisoned = false;
                } catch {
                    loadedBeforeRecovery.poisoned = true;
                }
            }
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
        const replayResult = receipt.coreReceipt && loaded.port.resultFromReceipt
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

function validateManagedResult(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw managedError('INVALID_REQUEST', 'The managed mutation result must be an object.');
    }
    canonicalJson(value, 768 * 1024);
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
                || canonicalDigest(previousValue) !== canonicalDigest(nextValue);
        })
        .slice(0, 1_024);
}

function isCoreFailure(value: unknown): value is {
    ok: false;
    error: {
        code: ManagedRuntimeErrorCode;
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
        && isManagedRuntimeErrorCode(candidate.error?.code)
        && typeof candidate.error?.message === 'string'
        && typeof candidate.error?.retryable === 'boolean';
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
