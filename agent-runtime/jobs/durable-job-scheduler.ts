import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { managedError, type ManagedRuntimeErrorShape, asManagedRuntimeError } from '../coordinator/errors';
import type { StateToken } from '../coordinator/types';
import type { ManagedFilesystemStore } from '../persistence/managed-filesystem-store';
import { atomicWriteJson } from '../persistence/fs-durable';
import { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics';
import { canonicalJson } from '../persistence/canonical-json';
import { MANAGED_JOB_JSON_MAX_BYTES } from '../persistence/managed-filesystem-store';

export type DurableJobState =
    | 'queued'
    | 'running'
    | 'cancelling'
    | 'cancelled'
    | 'succeeded'
    | 'failed'
    | 'interrupted';

export type JobBoundaryState =
    | 'queued'
    | 'running'
    | 'cancel_requested'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'interrupted';

export interface DurableJobRecord<Input = unknown, Checkpoint = unknown, Result = unknown> {
    schemaVersion: 1;
    jobId: string;
    projectId: string;
    kind: string;
    input: Input;
    inputDigest: string;
    capturedState: StateToken;
    sequence: number;
    state: DurableJobState;
    stage: string;
    fraction?: number;
    message?: string;
    checkpoint?: Checkpoint;
    result?: Result;
    resultArtifactIds: readonly string[];
    cancellable: boolean;
    resumable: boolean;
    cancellationRequestedAt?: string;
    createdAt: string;
    startedAt?: string;
    updatedAt: string;
    finishedAt?: string;
    error?: ManagedRuntimeErrorShape;
}

export interface JobExecutionContext<Checkpoint> {
    signal: AbortSignal;
    checkpoint: Checkpoint | undefined;
    update(update: {
        stage?: string;
        fraction?: number;
        message?: string;
        checkpoint?: Checkpoint;
    }): Promise<void>;
}

export interface DurableJobHandler<Input = unknown, Checkpoint = unknown, Result = unknown> {
    run(input: Input, context: JobExecutionContext<Checkpoint>): Promise<{
        result: Result;
        artifactIds?: readonly string[];
    }>;
    cleanup?(record: DurableJobRecord<Input, Checkpoint, Result>): Promise<void>;
}

export interface JobSchedulerOptions {
    globalConcurrency?: number;
    concurrencyByKind?: Readonly<Record<string, number>>;
    persistTransition?(record: DurableJobRecord): Promise<void>;
    onTransition?(record: DurableJobRecord): Promise<void> | void;
}

const TERMINAL = new Set<DurableJobState>(['cancelled', 'succeeded', 'failed']);

export class DurableJobScheduler {
    private readonly handlers = new Map<string, DurableJobHandler>();
    private readonly jobs = new Map<string, DurableJobRecord>();
    private readonly controllers = new Map<string, AbortController>();
    private readonly executions = new Map<string, Promise<void>>();
    private readonly activeByKind = new Map<string, number>();
    private draining = false;
    private closed = false;

    constructor(
        private readonly store: ManagedFilesystemStore,
        private readonly diagnostics: RuntimeDiagnostics,
        private readonly options: JobSchedulerOptions = {},
    ) {}

    register<Input, Checkpoint, Result>(
        kind: string,
        handler: DurableJobHandler<Input, Checkpoint, Result>,
    ): void {
        if (this.handlers.has(kind)) throw new Error(`Job handler already registered: ${kind}`);
        this.handlers.set(kind, handler as DurableJobHandler);
    }

    async recover(projectIds: readonly string[]): Promise<void> {
        for (const projectId of projectIds) {
            for (const record of await this.store.readNamespace<DurableJobRecord>(projectId, 'jobs')) {
                let recovered = record;
                if (record.state === 'running' || record.state === 'cancelling') {
                    recovered = record.resumable
                        ? {
                            ...record,
                            state: 'queued',
                            stage: 'recovered',
                            message: 'Resuming from the last durable checkpoint.',
                            updatedAt: new Date().toISOString(),
                        }
                        : {
                            ...record,
                            state: 'failed',
                            stage: 'interrupted',
                            finishedAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                            error: managedError(
                                'INTERNAL_ERROR',
                                'The non-resumable job was interrupted by coordinator restart.',
                                true,
                            ).toJSON(),
                        };
                    await this.persist(recovered);
                } else if (record.state === 'interrupted') {
                    recovered = record.resumable
                        ? { ...record, state: 'queued', updatedAt: new Date().toISOString() }
                        : { ...record, state: 'failed', finishedAt: new Date().toISOString() };
                    await this.persist(recovered);
                }
                this.jobs.set(recovered.jobId, recovered);
            }
        }
        this.refreshDiagnostics();
        void this.drain();
    }

    async enqueue<Input>(
        record: Omit<
            DurableJobRecord<Input>,
            'schemaVersion' | 'jobId' | 'sequence' | 'state' | 'stage' | 'resultArtifactIds'
            | 'createdAt' | 'updatedAt'
        >,
    ): Promise<DurableJobRecord<Input>> {
        if (this.closed) throw new Error('The job scheduler is closed.');
        if (!this.handlers.has(record.kind)) {
            throw managedError('INVALID_REQUEST', `No managed job handler is registered for ${record.kind}.`);
        }
        validateJobValue(record.input, 'job input', 512 * 1024);
        const now = new Date().toISOString();
        const job: DurableJobRecord<Input> = {
            ...record,
            schemaVersion: 1,
            jobId: randomUUID(),
            sequence: 1,
            state: 'queued',
            stage: 'queued',
            resultArtifactIds: [],
            createdAt: now,
            updatedAt: now,
        };
        await this.persist(job);
        this.jobs.set(job.jobId, job);
        await this.notify(job);
        this.refreshDiagnostics();
        void this.drain();
        return job;
    }

    get(jobId: string): DurableJobRecord | null {
        return this.jobs.get(jobId) ?? null;
    }

    list(projectId?: string): DurableJobRecord[] {
        return Array.from(this.jobs.values())
            .filter((job) => !projectId || job.projectId === projectId)
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }

    async cancel(jobId: string): Promise<DurableJobRecord> {
        const record = this.jobs.get(jobId);
        if (!record) throw managedError('NOT_FOUND', 'The managed job does not exist.');
        if (TERMINAL.has(record.state)) return record;
        if (!record.cancellable) {
            throw managedError('JOB_NOT_CANCELLABLE', 'The managed job cannot be cancelled.');
        }
        const now = new Date().toISOString();
        if (record.state === 'queued') {
            const cancelled: DurableJobRecord = {
                ...record,
                sequence: record.sequence + 1,
                state: 'cancelled',
                stage: 'cancelled',
                cancellationRequestedAt: now,
                updatedAt: now,
                finishedAt: now,
            };
            await this.persist(cancelled);
            this.jobs.set(jobId, cancelled);
            await this.cleanup(cancelled);
            await this.notify(cancelled);
            this.refreshDiagnostics();
            return cancelled;
        }
        const cancelling: DurableJobRecord = {
            ...record,
            sequence: record.sequence + 1,
            state: 'cancelling',
            stage: 'cancelling',
            cancellationRequestedAt: record.cancellationRequestedAt ?? now,
            updatedAt: now,
        };
        await this.persist(cancelling);
        this.jobs.set(jobId, cancelling);
        this.controllers.get(jobId)?.abort(new DOMException('Cancelled', 'AbortError'));
        await this.notify(cancelling);
        return cancelling;
    }

    async close(): Promise<void> {
        this.closed = true;
        for (const controller of Array.from(this.controllers.values())) {
            controller.abort(new DOMException('Coordinator shutdown', 'AbortError'));
        }
        await Promise.allSettled(Array.from(this.executions.values()));
        await Promise.all(
            Array.from(this.jobs.values()).map(async (job) => {
                const jobId = job.jobId;
                const current = this.jobs.get(jobId);
                if (!current || TERMINAL.has(current.state)) return;
                const interrupted: DurableJobRecord = {
                    ...current,
                    state: 'interrupted',
                    stage: 'interrupted',
                    sequence: current.sequence + 1,
                    updatedAt: new Date().toISOString(),
                };
                await this.persist(interrupted);
                this.jobs.set(jobId, interrupted);
            }),
        );
    }

    private async drain(): Promise<void> {
        if (this.draining || this.closed) return;
        this.draining = true;
        try {
            while (!this.closed) {
                const next = Array.from(this.jobs.values()).find((job) => (
                    job.state === 'queued' && this.canStart(job.kind)
                ));
                if (!next) break;
                const execution = this.execute(next).finally(() => {
                    this.executions.delete(next.jobId);
                });
                this.executions.set(next.jobId, execution);
            }
        } finally {
            this.draining = false;
        }
    }

    private canStart(kind: string): boolean {
        const globalLimit = this.options.globalConcurrency ?? 4;
        if (this.controllers.size >= globalLimit) return false;
        const kindLimit = this.options.concurrencyByKind?.[kind] ?? defaultKindConcurrency(kind);
        return (this.activeByKind.get(kind) ?? 0) < kindLimit;
    }

    private async execute(initial: DurableJobRecord): Promise<void> {
        const handler = this.handlers.get(initial.kind);
        if (!handler) return;
        const controller = new AbortController();
        this.controllers.set(initial.jobId, controller);
        this.activeByKind.set(initial.kind, (this.activeByKind.get(initial.kind) ?? 0) + 1);
        const now = new Date().toISOString();
        let running: DurableJobRecord = {
            ...initial,
            sequence: initial.sequence + 1,
            state: 'running',
            stage: initial.checkpoint === undefined ? 'starting' : 'resuming',
            startedAt: initial.startedAt ?? now,
            updatedAt: now,
        };
        try {
            await this.persist(running);
            this.jobs.set(running.jobId, running);
            await this.notify(running);
            this.refreshDiagnostics();
            try {
                const output = await handler.run(running.input, {
                    signal: controller.signal,
                    checkpoint: running.checkpoint,
                    update: async (update) => {
                        if ('checkpoint' in update) {
                            validateJobValue(update.checkpoint, 'job checkpoint', 512 * 1024);
                        }
                        const current = this.jobs.get(running.jobId) ?? running;
                        const fraction = normalizeFraction(update.fraction ?? current.fraction);
                        const message = boundedMessage(update.message ?? current.message);
                        running = {
                            ...current,
                            ...update,
                            sequence: current.sequence + 1,
                            state: current.state === 'cancelling' ? 'cancelling' : 'running',
                            ...(fraction === undefined ? {} : { fraction }),
                            ...(message === undefined ? {} : { message }),
                            updatedAt: new Date().toISOString(),
                        };
                        await this.persist(running);
                        this.jobs.set(running.jobId, running);
                        await this.notify(running);
                    },
                });
                if (controller.signal.aborted || this.jobs.get(running.jobId)?.state === 'cancelling') {
                    throw controller.signal.reason ?? new DOMException('Cancelled', 'AbortError');
                }
                validateJobValue(output.result, 'job result', 1024 * 1024);
                validateArtifactIds(output.artifactIds ?? []);
                const succeeded: DurableJobRecord = {
                    ...running,
                    sequence: running.sequence + 1,
                    state: 'succeeded',
                    stage: 'complete',
                    fraction: 1,
                    result: output.result,
                    resultArtifactIds: [...(output.artifactIds ?? [])],
                    updatedAt: new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                };
                await this.persist(succeeded);
                this.jobs.set(succeeded.jobId, succeeded);
                await this.notify(succeeded);
            } catch (error) {
                const cancelled = controller.signal.aborted
                    || (error instanceof DOMException && error.name === 'AbortError');
                const current = this.jobs.get(running.jobId) ?? running;
                const terminal: DurableJobRecord = {
                    ...current,
                    sequence: current.sequence + 1,
                    state: cancelled ? 'cancelled' : 'failed',
                    stage: cancelled ? 'cancelled' : 'failed',
                    updatedAt: new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                    ...(!cancelled ? { error: asManagedRuntimeError(error).toJSON() } : {}),
                };
                await this.persist(terminal);
                this.jobs.set(terminal.jobId, terminal);
                await this.cleanup(terminal);
                await this.notify(terminal);
            }
        } catch (error) {
            const current = this.jobs.get(initial.jobId) ?? initial;
            if (!TERMINAL.has(current.state)) {
                this.jobs.set(initial.jobId, {
                    ...current,
                    state: 'interrupted',
                    stage: 'transition-failed',
                    sequence: current.sequence + 1,
                    updatedAt: new Date().toISOString(),
                    error: asManagedRuntimeError(error).toJSON(),
                });
            }
        } finally {
            this.controllers.delete(initial.jobId);
            this.activeByKind.set(initial.kind, Math.max(0, (this.activeByKind.get(initial.kind) ?? 1) - 1));
            this.refreshDiagnostics();
            void this.drain();
        }
    }

    private async persist(record: DurableJobRecord): Promise<void> {
        validateJobValue(record, 'job record', MANAGED_JOB_JSON_MAX_BYTES);
        if (this.options.persistTransition) {
            await this.options.persistTransition(record);
            return;
        }
        const path = this.store.projectPath(record.projectId, 'jobs', `${record.jobId}.json`);
        await atomicWriteJson(path, record, { faultPrefix: 'job' });
    }

    private async cleanup(record: DurableJobRecord): Promise<void> {
        await this.handlers.get(record.kind)?.cleanup?.(record);
        await rm(this.store.projectPath(record.projectId, 'jobs', `${record.jobId}.partial`), {
            force: true,
        });
    }

    private async notify(record: DurableJobRecord): Promise<void> {
        await this.options.onTransition?.(record);
    }

    private refreshDiagnostics(): void {
        this.diagnostics.set('queuedJobs', Array.from(this.jobs.values()).filter((job) => job.state === 'queued').length);
        this.diagnostics.set('activeJobs', this.controllers.size);
    }

    hasActiveJobs(): boolean {
        return this.controllers.size > 0
            || Array.from(this.jobs.values()).some((job) => (
                job.state === 'queued' || job.state === 'running' || job.state === 'cancelling'
            ));
    }
}

function defaultKindConcurrency(kind: string): number {
    if (kind.includes('transcription') || kind.includes('export')) return 1;
    if (kind.includes('probe') || kind.includes('review')) return 2;
    return 2;
}

function normalizeFraction(value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isFinite(value)) {
        throw managedError('INVALID_REQUEST', 'Job progress fractions must be finite.');
    }
    return Math.max(0, Math.min(1, value));
}

function boundedMessage(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (/(Bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]{12,}|api[_-]?key\s*[:=])/i.test(value)) {
        throw managedError('INVALID_REQUEST', 'Sensitive values cannot be persisted in job messages.');
    }
    return value.slice(0, 512);
}

export function toJobBoundaryState(state: DurableJobState): JobBoundaryState {
    switch (state) {
        case 'cancelling':
            return 'cancel_requested';
        case 'succeeded':
            return 'completed';
        default:
            return state;
    }
}

function validateJobValue(value: unknown, label: string, maximumBytes: number): void {
    rejectSensitiveJobKeys(value);
    canonicalJson(value, maximumBytes);
}

function rejectSensitiveJobKeys(value: unknown, seen = new Set<object>()): void {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) throw managedError('INVALID_REQUEST', 'Job records cannot contain cycles.');
    seen.add(value);
    if (Array.isArray(value)) {
        for (const entry of value) rejectSensitiveJobKeys(entry, seen);
    } else {
        for (const [key, nested] of Object.entries(value)) {
            if (/(api.?key|authorization|password|secret|access.?token|refresh.?token|signed.?url)/i.test(key)) {
                throw managedError('INVALID_REQUEST', 'Sensitive values cannot be persisted in job records.');
            }
            rejectSensitiveJobKeys(nested, seen);
        }
    }
    seen.delete(value);
}

function validateArtifactIds(ids: readonly string[]): void {
    if (
        ids.length > 1_000
        || ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)
    ) {
        throw managedError('INVALID_REQUEST', 'Job artifact identifiers are invalid or oversized.');
    }
}
