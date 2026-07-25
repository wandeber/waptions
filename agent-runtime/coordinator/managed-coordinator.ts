import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    ArtifactRegistry,
    type ArtifactQuotaPolicy,
    type ArtifactRecord,
} from '../artifacts/artifact-registry';
import type { Readable } from 'node:stream';
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
    artifactQuotas?: ArtifactQuotaPolicy;
    sourceCopyQuotas?: SourceCopyQuotaPolicy;
    renderStagingQuotas?: RenderStagingQuotaPolicy;
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
    Result extends Record<string, unknown> = Record<string, unknown>,
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
        const port = await this.portFactory.create(snapshot, this.persistencePort(projectId));
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
                    sessionRevision: loaded.envelope.sessionRevision + 1,
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
                this.events.publish(event);
                await Promise.resolve(mutation.afterCommit?.()).catch(() => undefined);
                return {
                    ok: true,
                    data: { ...mutation.result, replayed: false },
                    state: this.stateToken(nextEnvelope),
                    warnings: [],
                };
            } catch (error) {
                if (!committed && mutation?.onReject) {
                    await Promise.resolve(mutation.onReject()).catch(() => undefined);
                }
                if (committed && mutation && loaded) {
                    await Promise.resolve(mutation.afterCommit?.()).catch(() => undefined);
                    return {
                        ok: true,
                        data: { ...mutation.result, replayed: false },
                        state: this.stateToken(loaded.envelope),
                        warnings: [
                            'A post-commit callback failed; the durable mutation remains authoritative.',
                        ],
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
            const grant = await this.pathGrants.create(
                envelope.sessionId,
                this.epoch,
                kind,
                path,
                overwriteConfirmed,
            );
            return {
                update: (current) => ({ ...current, grantRevision: current.grantRevision + 1 }),
                writes: [{ relativePath: `grants/${grant.grantId}.json`, value: grant }],
                result: { grant },
                eventKind: 'grant.changed',
                eventData: { action: 'granted', kind },
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
            const grant = this.pathGrants.revoke(existing.grantId, {
                sessionId: existing.sessionId,
                sessionEpoch: existing.sessionEpoch,
            });
            return {
                update: (envelope) => ({ ...envelope, grantRevision: envelope.grantRevision + 1 }),
                writes: [{ relativePath: `grants/${grant.grantId}.json`, value: grant }],
                result: { grant },
                eventKind: 'grant.changed',
                eventData: { action: 'revoked', kind: grant.kind },
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
            sessionRevision: recovered.sessionRevision + 1,
            eventSequence: recovered.eventSequence + 1,
            grantRevision: recovered.grantRevision + (quarantinedGrantWrites.length > 0 ? 1 : 0),
            recoveryCount: recovered.recoveryCount + 1,
            lastCoordinatorEpoch: this.epoch,
            updatedAt: new Date().toISOString(),
        };
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
        validateEditorSnapshot(input.next);
        validateManagedResult(input.result);
        if (
            !input.semanticLabel
            || input.semanticLabel.length > 200
            || input.next.documentRevision <= loaded.envelope.editor.documentRevision
            || input.next.audioGraphRevision < loaded.envelope.editor.audioGraphRevision
            || input.next.historyRevision < loaded.envelope.editor.historyRevision
        ) {
            throw managedError(
                'INVALID_REQUEST',
                'Core produced an invalid editor transition.',
            );
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
        active.committedResult = structuredClone(input.result);
        active.committedSnapshot = structuredClone(input.next);
        active.committed = true;
        this.events.publish(event);
        return { state: this.stateToken(nextEnvelope) };
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
                sessionRevision: loaded.envelope.sessionRevision + 1,
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

    private async resolveReceipt<ReceiptResult extends Record<string, unknown>>(
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
        return {
            ok: true,
            data: { ...receipt.result, replayed: true },
            state: this.stateToken(loaded.envelope),
            warnings: [],
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
        return {
            ok: true,
            data: { ...active.committedResult, replayed: false },
            state: this.stateToken(loaded.envelope),
            warnings,
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
        };
    }

    private createEvent(
        envelope: ManagedProjectEnvelopeV1<State>,
        kind: ManagedEventKind,
        eventData: ManagedEventData,
    ): ManagedEvent {
        const state = this.stateToken(envelope);
        return {
            schemaVersion: 1,
            cursor: state.eventCursor,
            type: kind,
            occurredAt: new Date().toISOString(),
            state,
            sequence: envelope.eventSequence,
            data: eventData,
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
            || !source.readGrantId
            || source.readGrantId.length > 200
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

function boundedIdentity(value: string): string {
    const normalized = value?.trim();
    if (!normalized || normalized.length > 256) {
        throw managedError('INVALID_REQUEST', 'The artifact source identity is invalid.');
    }
    return normalized;
}
