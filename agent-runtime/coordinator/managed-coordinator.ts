import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArtifactRegistry, type ArtifactRecord } from '../artifacts/artifact-registry';
import type { Readable } from 'node:stream';
import { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics';
import {
    getProcessDecodedMemoryBudget,
    type ProcessDecodedMemoryBudget,
} from '../diagnostics/decoded-memory-budget';
import { ManagedEventLog, type ManagedEvent, type ManagedEventKind } from '../events/event-log';
import {
    DurableJobScheduler,
    type DurableJobRecord,
    type JobSchedulerOptions,
    toJobBoundaryState,
} from '../jobs/durable-job-scheduler';
import {
    PathGrantAuthority,
    type PathGrantKind,
    type SessionPathGrantRecord,
} from '../path-grants/path-grant-authority';
import { canonicalDigest } from '../persistence/canonical-json';
import { atomicWriteFile, atomicWriteJson } from '../persistence/fs-durable';
import type { PersistenceFaultInjector } from '../persistence/fs-durable';
import {
    type DurableReceipt,
    type DurableWrite,
    ManagedFilesystemStore,
} from '../persistence/managed-filesystem-store';
import { asManagedRuntimeError, managedError } from './errors';
import type {
    ManagedEditorPort,
    ManagedEditorPortFactory,
    ManagedEditorPersistenceCommit,
    ManagedEditorPersistencePort,
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

interface LoadedProject<State, Command, Result extends Record<string, unknown>> {
    envelope: ManagedProjectEnvelopeV1<State>;
    port: ManagedEditorPort<State, Command, Result>;
    poisoned: boolean;
}

export interface ManagedCoordinatorOptions {
    scheduler?: JobSchedulerOptions;
    persistenceFaultInjector?: PersistenceFaultInjector;
    decodedMemoryLimitBytes?: number;
}

export interface RegistryMutation<State, Result extends Record<string, unknown>> {
    update(envelope: ManagedProjectEnvelopeV1<State>): ManagedProjectEnvelopeV1<State>;
    writes?: readonly DurableWrite[];
    result: Result;
    eventKind: ManagedEventKind;
    eventSummary: Readonly<Record<string, string | number | boolean | null>>;
}

type RegistryMutationFactory<State, Result extends Record<string, unknown>> = (
    envelope: ManagedProjectEnvelopeV1<State>,
) => RegistryMutation<State, Result> | Promise<RegistryMutation<State, Result>>;

export class ManagedCoordinator<
    State = unknown,
    Command = unknown,
    Result extends Record<string, unknown> = Record<string, unknown>,
> {
    readonly epoch: string;
    readonly store: ManagedFilesystemStore;
    readonly events: ManagedEventLog;
    readonly artifacts: ArtifactRegistry;
    readonly diagnostics: RuntimeDiagnostics;
    readonly decodedMemoryBudget: ProcessDecodedMemoryBudget;
    readonly jobs: DurableJobScheduler;
    readonly pathGrants = new PathGrantAuthority();
    readonly presence = new ViewPresenceStore();

    private readonly projects = new Map<string, LoadedProject<State, Command, Result>>();
    private readonly queues = new Map<string, Promise<void>>();
    private readonly activeEditorRequests = new Map<string, {
        request: ManagedMutationEnvelope<Command>;
        committed: boolean;
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
        this.events = new ManagedEventLog(store, secret);
        this.artifacts = new ArtifactRegistry(store, secret);
        this.diagnostics = new RuntimeDiagnostics();
        this.decodedMemoryBudget = getProcessDecodedMemoryBudget(options.decodedMemoryLimitBytes);
        const externalTransition = options.scheduler?.onTransition;
        this.jobs = new DurableJobScheduler(store, this.diagnostics, {
            ...options.scheduler,
            persistTransition: (record) => this.recordJobTransition(record),
            onTransition: externalTransition,
        });
    }

    static async start<
        State = unknown,
        Command = unknown,
        Result extends Record<string, unknown> = Record<string, unknown>,
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
            const projectIds = await store.listProjectIds();
            for (const projectId of projectIds) {
                await coordinator.loadProject(projectId);
                // WAL recovery runs first, so this can safely remove only expired records and
                // blobs that no committed artifact registry entry references.
                await coordinator.artifacts.cleanupExpired(projectId);
            }
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
        const projectId = ids.projectId ?? randomUUID();
        const sessionId = ids.sessionId ?? randomUUID();
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
        await this.store.createProject(envelope);
        const port = await this.portFactory.create(snapshot, this.persistencePort(projectId));
        this.projects.set(projectId, { envelope, port, poisoned: false });
        return { project: summary(envelope), state: this.stateToken(envelope) };
    }

    listSessions(): ManagedSessionSummary[] {
        this.assertOpen();
        return Array.from(this.projects.values()).map((project) => summary(project.envelope));
    }

    getProject(projectId: string): {
        envelope: ManagedProjectEnvelopeV1<State>;
        state: StateToken;
    } {
        const loaded = this.requireProject(projectId);
        return { envelope: structuredClone(loaded.envelope), state: this.stateToken(loaded.envelope) };
    }

    async mutateEditor(
        projectId: string,
        request: ManagedMutationEnvelope<Command>,
    ): Promise<ManagedMutationResult<Result>> {
        return this.serialized(projectId, async () => {
            const loaded = this.requireProject(projectId);
            try {
                const replay = await this.resolveReceipt<Result>(projectId, request);
                if (replay) return replay;
                this.validateNewMutation(loaded.envelope, request);
                const active = { request, committed: false };
                this.activeEditorRequests.set(projectId, active);
                const result = await loaded.port.dispatch({ command: request.command, request });
                return {
                    ok: true,
                    data: { ...result, replayed: false },
                    state: this.stateToken(loaded.envelope),
                    warnings: [],
                };
            } catch (error) {
                return {
                    ok: false,
                    error: asManagedRuntimeError(error).toJSON(),
                    state: this.stateToken(loaded.envelope),
                };
            } finally {
                this.activeEditorRequests.delete(projectId);
            }
        });
    }

    async mutateRegistry<RegistryResult extends Record<string, unknown>>(
        projectId: string,
        request: ManagedMutationEnvelope,
        factory: RegistryMutationFactory<State, RegistryResult>,
    ): Promise<ManagedMutationResult<RegistryResult>> {
        return this.serialized(projectId, async () => {
            const loaded = this.requireProject(projectId);
            try {
                const replay = await this.resolveReceipt<RegistryResult>(projectId, request);
                if (replay) return replay;
                this.validateNewMutation(loaded.envelope, request);
                const mutation = await factory(structuredClone(loaded.envelope));
                const updated = mutation.update(structuredClone(loaded.envelope));
                const nextEnvelope: ManagedProjectEnvelopeV1<State> = {
                    ...updated,
                    sessionRevision: loaded.envelope.sessionRevision + 1,
                    receiptRevision: loaded.envelope.receiptRevision + 1,
                    eventSequence: loaded.envelope.eventSequence + 1,
                    updatedAt: new Date().toISOString(),
                    lastCoordinatorEpoch: this.epoch,
                };
                const event = this.createEvent(nextEnvelope, mutation.eventKind, mutation.eventSummary);
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
                this.events.publish(event);
                return {
                    ok: true,
                    data: { ...mutation.result, replayed: false },
                    state: this.stateToken(nextEnvelope),
                    warnings: [],
                };
            } catch (error) {
                return {
                    ok: false,
                    error: asManagedRuntimeError(error).toJSON(),
                    state: this.stateToken(loaded.envelope),
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
            const grant = await this.pathGrants.create(
                envelope.sessionId,
                kind,
                path,
                overwriteConfirmed,
            );
            return {
                update: (current) => ({ ...current, grantRevision: current.grantRevision + 1 }),
                writes: [{ relativePath: `grants/${grant.grantId}.json`, value: grant }],
                result: { grant },
                eventKind: 'grant.changed',
                eventSummary: { action: 'granted', kind },
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
            const grant = this.pathGrants.revoke(existing);
            return {
                update: (envelope) => ({ ...envelope, grantRevision: envelope.grantRevision + 1 }),
                writes: [{ relativePath: `grants/${grant.grantId}.json`, value: grant }],
                result: { grant },
                eventKind: 'grant.changed',
                eventSummary: { action: 'revoked', kind: grant.kind },
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
                eventSummary: { action: 'archived' },
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
                eventSummary: { action: 'tombstoned' },
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
        },
    ): Promise<ManagedMutationResult<{ artifact: ArtifactRecord }>> {
        return this.mutateRegistry(projectId, request, async () => {
            // Staging happens only after epoch-independent receipt resolution and all guards.
            const staged = await this.artifacts.stage(
                projectId,
                input.kind,
                input.mediaType,
                input.source,
                { expiresAt: input.expiresAt, sourceIds: input.sourceIds },
            );
            return {
                update: (envelope) => ({
                    ...envelope,
                    artifactRevision: envelope.artifactRevision + 1,
                }),
                writes: [staged.registryWrite],
                result: { artifact: staged.record },
                eventKind: 'artifact.created',
                eventSummary: {
                    artifactId: staged.record.artifactId,
                    kind: staged.record.kind,
                    byteLength: staged.record.byteLength,
                },
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
                eventSummary: {
                    action: update.presenterViewId !== undefined ? 'presenter-updated' : 'playback-updated',
                    playing: playback.playing,
                    outputSample: playback.outputSample,
                },
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
        return this.mutateRegistry(projectId, request, () => ({
            update: (envelope) => {
                if (envelope.sessionRevision !== plan.sessionRevision) {
                    throw managedError(
                        'SESSION_REVISION_CONFLICT',
                        'Source reachability changed after the release dry run.',
                        true,
                    );
                }
                const released = new Set(plan.releasableSourceIds);
                return {
                    ...envelope,
                    sourceRegistryRevision: envelope.sourceRegistryRevision + 1,
                    sourceRegistry: envelope.sourceRegistry.map((source) => (
                        released.has(source.sourceId)
                            ? { ...source, releasedAt: new Date().toISOString() }
                            : source
                    )),
                };
            },
            result: { releasedSourceIds: plan.releasableSourceIds },
            eventKind: 'source.changed',
            eventSummary: { action: 'released', count: plan.releasableSourceIds.length },
        }));
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
        const recovered = await this.store.readProject<State>(projectId);
        if (!recovered) return;
        const envelope: ManagedProjectEnvelopeV1<State> = {
            ...recovered,
            sessionRevision: recovered.sessionRevision + 1,
            eventSequence: recovered.eventSequence + 1,
            recoveryCount: recovered.recoveryCount + 1,
            lastCoordinatorEpoch: this.epoch,
            updatedAt: new Date().toISOString(),
        };
        const event = this.createEvent(envelope, 'session.recovered', {
            action: 'recovered',
            recoveryCount: envelope.recoveryCount,
        });
        await this.store.transact({
            baseSessionRevision: recovered.sessionRevision,
            envelope,
            writes: [
                this.events.write(event),
                ...await this.events.retentionDeletes(projectId),
            ],
        });
        const port = await this.portFactory.create(envelope.editor, this.persistencePort(projectId));
        await port.hydrate(envelope.editor);
        this.projects.set(projectId, { envelope, port, poisoned: false });
        this.events.publish(event);
    }

    private persistencePort(projectId: string): ManagedEditorPersistencePort<State, Result> {
        return {
            commit: (input) => this.commitEditorFromCore(projectId, input),
        };
    }

    private async commitEditorFromCore(
        projectId: string,
        input: ManagedEditorPersistenceCommit<State, Result>,
    ): Promise<{ state: StateToken }> {
        const loaded = this.requireProject(projectId);
        const active = this.activeEditorRequests.get(projectId);
        if (!active || canonicalDigest(active.request) !== canonicalDigest(input.request)) {
            throw managedError(
                'INVALID_REQUEST',
                'Core attempted persistence outside the serialized coordinator dispatch.',
            );
        }
        if (active.committed) {
            throw managedError('INTERNAL_ERROR', 'Core attempted more than one atomic commit.', false);
        }
        if (input.baseDocumentRevision !== loaded.envelope.editor.documentRevision) {
            throw managedError(
                'REVISION_CONFLICT',
                'The editor changed before Core reached its persistence boundary.',
                true,
            );
        }
        const nextEnvelope: ManagedProjectEnvelopeV1<State> = {
            ...loaded.envelope,
            sessionRevision: loaded.envelope.sessionRevision + 1,
            receiptRevision: loaded.envelope.receiptRevision + 1,
            eventSequence: loaded.envelope.eventSequence + 1,
            editor: input.next,
            updatedAt: new Date().toISOString(),
            lastCoordinatorEpoch: this.epoch,
        };
        const event = this.createEvent(
            nextEnvelope,
            'project.changed',
            { action: input.semanticLabel, toolName: input.request.toolName },
        );
        const receipt = this.createReceipt(
            projectId,
            input.request,
            input.result,
            nextEnvelope.sessionRevision,
            input.next.reachableSourceIds,
        );
        await this.commit(loaded, nextEnvelope, [
            this.store.receiptWrite(receipt),
            this.events.write(event),
            ...await this.store.receiptRetentionDeletes(projectId),
            ...await this.events.retentionDeletes(projectId),
        ]);
        active.committed = true;
        this.events.publish(event);
        return { state: this.stateToken(nextEnvelope) };
    }

    private async recordJobTransition(record: DurableJobRecord): Promise<void> {
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
            const nextEnvelope: ManagedProjectEnvelopeV1<State> = {
                ...loaded.envelope,
                sessionRevision: loaded.envelope.sessionRevision + 1,
                jobRevision: loaded.envelope.jobRevision + 1,
                eventSequence: loaded.envelope.eventSequence + 1,
                updatedAt: new Date().toISOString(),
            };
            const event = this.createEvent(nextEnvelope, 'job.changed', {
                jobId: record.jobId,
                kind: record.kind,
                state: toJobBoundaryState(record.state),
                stage: record.stage,
                sequence: record.sequence,
            });
            await this.commit(loaded, nextEnvelope, [
                {
                    relativePath: `jobs/${record.jobId}.json`,
                    value: record,
                },
                this.events.write(event),
                ...await this.events.retentionDeletes(record.projectId),
            ]);
            this.events.publish(event);
        });
    }

    private async resolveReceipt<ReceiptResult extends Record<string, unknown>>(
        projectId: string,
        request: ManagedMutationEnvelope,
    ): Promise<ManagedMutationResult<ReceiptResult> | null> {
        const receipt = await this.store.readReceipt<ReceiptResult>(
            projectId,
            request.toolName,
            request.idempotencyKey,
        );
        if (!receipt) return null;
        const requestHash = canonicalDigest(request);
        if (receipt.requestHash !== requestHash) {
            throw managedError(
                'IDEMPOTENCY_KEY_CONFLICT',
                'The idempotency key was already used with a different request.',
            );
        }
        const loaded = this.requireProject(projectId);
        return {
            ok: true,
            data: { ...receipt.result, replayed: true },
            state: this.stateToken(loaded.envelope),
            warnings: [],
        };
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
    ): DurableReceipt<ReceiptResult> {
        return {
            schemaVersion: 1,
            projectId,
            toolName: request.toolName,
            idempotencyKey: request.idempotencyKey,
            requestHash: canonicalDigest(request),
            result,
            committedSessionRevision,
            createdAt: new Date().toISOString(),
            retainedSourceIds: [...retainedSourceIds],
        };
    }

    private createEvent(
        envelope: ManagedProjectEnvelopeV1<State>,
        kind: ManagedEventKind,
        eventSummary: Readonly<Record<string, string | number | boolean | null>>,
    ): ManagedEvent {
        return {
            schemaVersion: 1,
            projectId: envelope.projectId,
            sessionId: envelope.sessionId,
            sequence: envelope.eventSequence,
            kind,
            createdAt: new Date().toISOString(),
            sessionRevision: envelope.sessionRevision,
            summary: eventSummary,
        };
    }

    private async commit(
        loaded: LoadedProject<State, Command, Result>,
        nextEnvelope: ManagedProjectEnvelopeV1<State>,
        writes: readonly DurableWrite[],
    ): Promise<void> {
        try {
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
