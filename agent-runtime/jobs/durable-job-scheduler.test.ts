import { afterEach, describe, expect, it } from 'vitest';
import { atomicWriteJson } from '../persistence/fs-durable';
import { ManagedFilesystemStore } from '../persistence/managed-filesystem-store';
import { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics';
import {
    DurableJobScheduler,
    type DurableJobRecord,
} from './durable-job-scheduler';
import { temporaryRuntime, testEnvelope } from '../testing/runtime-test-helpers';
import { ManagedCoordinator } from '../coordinator/managed-coordinator';
import { fakeEditorPortFactory, fakeSnapshot } from '../testing/fake-editor-port';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('DurableJobScheduler', () => {
    it('cancels at a checked boundary and runs handler cleanup', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('jobs-project');
        await store.createProject(envelope);
        let cleaned = false;
        const scheduler = new DurableJobScheduler(store, new RuntimeDiagnostics());
        scheduler.register('review', {
            run: async (_input: unknown, context) => {
                await new Promise<void>((_resolve, reject) => {
                    context.signal.addEventListener('abort', () => reject(context.signal.reason), {
                        once: true,
                    });
                });
                return { result: {} };
            },
            cleanup: async () => {
                cleaned = true;
            },
        });
        const job = await scheduler.enqueue({
            projectId: envelope.projectId,
            kind: 'review',
            input: {},
            inputDigest: 'sha256:input',
            capturedState: stateToken(envelope.projectId),
            cancellable: true,
            resumable: true,
        });
        await waitFor(() => scheduler.get(job.jobId)?.state === 'running');
        await scheduler.cancel(job.jobId);
        await waitFor(() => scheduler.get(job.jobId)?.state === 'cancelled');
        expect(cleaned).toBe(true);
        expect(scheduler.hasActiveJobs()).toBe(false);
        await scheduler.close();
    });

    it('reclassifies a running durable job on restart and resumes its checkpoint', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('restart-jobs-project');
        await store.createProject(envelope);
        const now = new Date().toISOString();
        const interrupted: DurableJobRecord<unknown, { offset: number }, { resumed: number }> = {
            schemaVersion: 1,
            jobId: 'restart-job',
            projectId: envelope.projectId,
            kind: 'probe',
            input: {},
            inputDigest: 'sha256:probe',
            capturedState: stateToken(envelope.projectId),
            sequence: 3,
            state: 'running',
            stage: 'reading',
            checkpoint: { offset: 42 },
            resultArtifactIds: [],
            cancellable: true,
            resumable: true,
            createdAt: now,
            startedAt: now,
            updatedAt: now,
        };
        await atomicWriteJson(
            store.projectPath(envelope.projectId, 'jobs', `${interrupted.jobId}.json`),
            interrupted,
        );
        const scheduler = new DurableJobScheduler(store, new RuntimeDiagnostics());
        scheduler.register('probe', {
            run: async (_input: unknown, context) => ({
                result: { resumed: (context.checkpoint as { offset: number }).offset },
            }),
        });
        await scheduler.recover([envelope.projectId]);
        await waitFor(() => scheduler.get(interrupted.jobId)?.state === 'succeeded');
        expect(scheduler.get(interrupted.jobId)?.result).toEqual({ resumed: 42 });
        await scheduler.close();
    });

    it('publishes every job transition into durable session and event revisions', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Job events', fakeSnapshot(), {
            projectId: 'job-events-project',
            sessionId: 'job-events-session',
        });
        coordinator.jobs.register('transcription', {
            run: async (_input: unknown, context) => {
                await context.update({ stage: 'half', fraction: 0.5 });
                return { result: { done: true } };
            },
        });
        const job = await coordinator.jobs.enqueue({
            projectId: 'job-events-project',
            kind: 'transcription',
            input: {},
            inputDigest: 'sha256:job-events',
            capturedState: created.state,
            cancellable: true,
            resumable: true,
        });
        await waitFor(() => coordinator.jobs.get(job.jobId)?.state === 'succeeded');
        await waitFor(() => coordinator.getProject('job-events-project').envelope.jobRevision >= 4);
        const project = coordinator.getProject('job-events-project').envelope;
        expect(project.jobRevision).toBeGreaterThanOrEqual(4);
        expect(project.sessionRevision).toBe(project.jobRevision);
        const eventPage = await coordinator.events.read(
            'job-events-project',
            'job-events-session',
            undefined,
            20,
        );
        expect(eventPage.events.filter((event) => event.kind === 'job.changed')).toHaveLength(
            project.jobRevision,
        );
        await coordinator.close();
    });

    it('releases scheduler capacity when transition persistence fails', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('transition-failure-project');
        await store.createProject(envelope);
        const diagnostics = new RuntimeDiagnostics();
        let failRunningOnce = true;
        const scheduler = new DurableJobScheduler(store, diagnostics, {
            globalConcurrency: 1,
            persistTransition: async (record) => {
                if (record.state === 'running' && failRunningOnce) {
                    failRunningOnce = false;
                    throw new Error('transition persistence failed');
                }
            },
        });
        scheduler.register('review', {
            run: async () => ({ result: { done: true } }),
        });
        const first = await scheduler.enqueue({
            projectId: envelope.projectId,
            kind: 'review',
            input: {},
            inputDigest: 'sha256:first',
            capturedState: stateToken(envelope.projectId),
            cancellable: true,
            resumable: true,
        });
        await waitFor(() => scheduler.get(first.jobId)?.state === 'interrupted');
        expect(diagnostics.snapshot().current.activeJobs).toBe(0);

        const second = await scheduler.enqueue({
            projectId: envelope.projectId,
            kind: 'review',
            input: {},
            inputDigest: 'sha256:second',
            capturedState: stateToken(envelope.projectId),
            cancellable: true,
            resumable: true,
        });
        await waitFor(() => scheduler.get(second.jobId)?.state === 'succeeded');
        expect(diagnostics.snapshot().current.activeJobs).toBe(0);
        await scheduler.close();
    });

    it('rejects sensitive job records and normalizes non-finite progress into failure', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('job-validation-project');
        await store.createProject(envelope);
        const scheduler = new DurableJobScheduler(store, new RuntimeDiagnostics());
        scheduler.register('validated', {
            run: async (_input: unknown, context) => {
                await context.update({ fraction: Number.NaN });
                return { result: {} };
            },
        });
        await expect(scheduler.enqueue({
            projectId: envelope.projectId,
            kind: 'validated',
            input: { apiKey: 'must-not-persist' },
            inputDigest: 'sha256:sensitive',
            capturedState: stateToken(envelope.projectId),
            cancellable: true,
            resumable: true,
        })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        const job = await scheduler.enqueue({
            projectId: envelope.projectId,
            kind: 'validated',
            input: {},
            inputDigest: 'sha256:nan',
            capturedState: stateToken(envelope.projectId),
            cancellable: true,
            resumable: true,
        });
        await waitFor(() => scheduler.get(job.jobId)?.state === 'failed');
        expect(scheduler.get(job.jobId)?.error?.code).toBe('INVALID_REQUEST');
        await scheduler.close();
    });
});

function stateToken(projectId: string) {
    return {
        sessionId: 'session-test',
        projectId,
        sessionEpoch: 'epoch',
        sessionRevision: 0,
        documentRevision: 0,
        audioGraphRevision: 0,
        narrativeRevision: 0,
        eventCursor: 'cursor',
    };
}

async function waitFor(predicate: () => boolean, timeoutMilliseconds = 3_000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMilliseconds) throw new Error('Timed out waiting for job state.');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
