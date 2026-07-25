import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { StagedArtifact } from '../../artifacts/artifact-registry';
import type { StateToken } from '../../coordinator/types';
import { RuntimeDiagnostics } from '../../diagnostics/runtime-diagnostics';
import {
    DurableJobScheduler,
    type DurableJobRecord,
} from '../../jobs/durable-job-scheduler';
import { atomicWriteJson } from '../../persistence/fs-durable';
import { ManagedFilesystemStore } from '../../persistence/managed-filesystem-store';
import type { StagedOutputPublication } from '../../path-grants/path-grant-authority';
import { temporaryRuntime, testEnvelope } from '../../testing/runtime-test-helpers';
import type {
    ManagedExportJobService,
    ManagedExportRequest,
    ManagedExportTerminalProposal,
    ManagedOutputCandidate,
} from './contracts';
import {
    MANAGED_EXPORT_DURABLE_JOB_KINDS,
    ManagedExportDurableJobHandler,
    createManagedExportDurableJobInput,
    registerManagedExportDurableJobHandlers,
    type ManagedExportDurableJobInputV1,
    type ManagedExportMaterialFactory,
} from './durable-export-job-handler';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('ManagedExportDurableJobHandler', () => {
    it.each(MANAGED_EXPORT_DURABLE_JOB_KINDS)(
        'adapts %s through the durable terminal boundary',
        async (kind) => {
            const hooks = exportHooks();
            const prepared = serviceFixture(hooks);
            const materials = materialFactory();
            const handler = new ManagedExportDurableJobHandler(kind, {
                service: prepared.service,
                materials: materials.factory,
            });
            const input = durableInput(kind);

            const output = await handler.run(input, executionContext());

            expect(prepared.prepare).toHaveBeenCalledWith(expect.objectContaining({
                projectId: input.projectId,
                jobId: input.jobId,
                exportKind: kind.slice('export:'.length),
                destination: input.destination,
                material: {},
            }));
            expect(materials.resolve).toHaveBeenCalledWith(input, expect.objectContaining({
                signal: expect.any(AbortSignal),
            }));
            expect(hooks.preparePublication).toHaveBeenCalledTimes(1);
            expect(output.terminalPublication.artifacts.map((artifact) => artifact.record.artifactId))
                .toEqual([hooks.artifactId]);
            expect(output.terminalPublication.outputs?.map((publication) => publication.record.publicationId))
                .toEqual([hooks.publicationId]);
            expect(output.artifactIds).toEqual([hooks.artifactId]);
            expect(output.result.job.jobId).toBe(input.jobId);
            expect(output.result.events.map((event) => event.type))
                .toEqual(['artifact.created', 'job.changed']);
        },
    );

    it('hands artifacts, output publication, and terminal job state to one persistence call', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('durable-export-atomic', 'durable-export-session');
        await store.createProject(envelope);

        const hooks = exportHooks();
        const prepared = serviceFixture(hooks);
        let committed = false;
        const scheduler = new DurableJobScheduler(store, new RuntimeDiagnostics(), {
            persistTransition: async (record, terminalPublication) => {
                const current = (await store.readProject(envelope.projectId))!;
                await store.transact({
                    baseSessionRevision: current.sessionRevision,
                    envelope: { ...current, updatedAt: new Date().toISOString() },
                    writes: [
                        { relativePath: `jobs/${record.jobId}.json`, value: record },
                        ...(terminalPublication?.artifacts.map((artifact) => artifact.registryWrite) ?? []),
                        ...(terminalPublication?.outputs?.map((output) => output.registryWrite) ?? []),
                    ],
                });
                if (terminalPublication) {
                    committed = true;
                    terminalPublication.artifacts.forEach((artifact) => artifact.accept());
                    await Promise.all(terminalPublication.outputs?.map((output) => output.accept()) ?? []);
                }
            },
        });
        hooks.assertAcceptedAfterCommit = () => expect(committed).toBe(true);
        registerManagedExportDurableJobHandlers(scheduler, {
            service: prepared.service,
            materials: materialFactory().factory,
        });
        const input = durableInput('export:mp4-h264-aac', {
            projectId: envelope.projectId,
            capturedState: stateToken(envelope.projectId, envelope.sessionId),
        });

        const job = await scheduler.enqueue({
            projectId: input.projectId,
            kind: input.kind,
            input,
            inputDigest: 'sha256:durable-export-atomic',
            capturedState: input.capturedState,
            cancellable: true,
            resumable: true,
        });
        await waitFor(() => scheduler.get(job.jobId)?.state === 'succeeded');

        expect(hooks.acceptArtifact).toHaveBeenCalledTimes(1);
        expect(hooks.acceptPublication).toHaveBeenCalledTimes(1);
        expect((await store.readNamespace<{ artifactId: string }>(envelope.projectId, 'artifacts'))
            .map((record) => record.artifactId))
            .toEqual([hooks.artifactId]);
        expect((await store.readNamespace<{ publicationId: string }>(envelope.projectId, 'outputs'))
            .map((record) => record.publicationId))
            .toEqual([hooks.publicationId]);
        expect(scheduler.get(job.jobId)?.resultArtifactIds).toEqual([hooks.artifactId]);
        await scheduler.close();
    });

    it('rejects every staged resource when publication preparation fails', async () => {
        const hooks = exportHooks({ prepareError: new Error('publication failed') });
        const prepared = serviceFixture(hooks);
        const cleanup = vi.fn<() => Promise<void>>(async () => undefined);
        const handler = new ManagedExportDurableJobHandler('export:webm', {
            service: prepared.service,
            materials: materialFactory(cleanup).factory,
        });

        await expect(handler.run(durableInput('export:webm'), executionContext())).rejects
            .toThrow('publication failed');

        expect(hooks.rejectArtifact).toHaveBeenCalledTimes(1);
        expect(hooks.abortCandidate).toHaveBeenCalledTimes(1);
        expect(hooks.rejectPublication).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('aborts staged exports before publication when cancellation wins', async () => {
        const hooks = exportHooks();
        const prepared = serviceFixture(hooks);
        const controller = new AbortController();
        prepared.prepare.mockImplementationOnce(async (request) => {
            controller.abort(new DOMException('Cancelled', 'AbortError'));
            return proposalFor(request, hooks);
        });
        const handler = new ManagedExportDurableJobHandler('export:proof-record', {
            service: prepared.service,
            materials: materialFactory().factory,
        });

        await expect(handler.run(
            durableInput('export:proof-record'),
            executionContext(controller.signal),
        )).rejects.toMatchObject({ name: 'AbortError' });

        expect(hooks.preparePublication).not.toHaveBeenCalled();
        expect(hooks.rejectArtifact).toHaveBeenCalledTimes(1);
        expect(hooks.abortCandidate).toHaveBeenCalledTimes(1);
    });

    it('rejects closed inputs with paths or secrets before the first durable write', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('durable-export-input');
        await store.createProject(envelope);
        const materials = materialFactory();
        const scheduler = new DurableJobScheduler(store, new RuntimeDiagnostics(), {
            globalConcurrency: 0,
        });
        registerManagedExportDurableJobHandlers(scheduler, {
            service: serviceFixture(exportHooks()).service,
            materials: materials.factory,
        });
        const valid = durableInput('export:reference-snapshot', {
            projectId: envelope.projectId,
            capturedState: stateToken(envelope.projectId),
        });

        for (const input of [
            { ...valid, materialReference: 'file:///private/export.json' },
            { ...valid, secret: 'must-not-persist' },
        ]) {
            await expect(scheduler.enqueue({
                projectId: envelope.projectId,
                kind: valid.kind,
                input: input as ManagedExportDurableJobInputV1,
                inputDigest: 'sha256:invalid-input',
                capturedState: valid.capturedState,
                cancellable: true,
                resumable: true,
            })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        }
        await expect(scheduler.enqueue({
            projectId: envelope.projectId,
            kind: valid.kind,
            input: valid,
            inputDigest: 'sha256:valid-input',
            capturedState: valid.capturedState,
            cancellable: true,
            resumable: true,
        })).resolves.toBeDefined();

        const [stored] = await store.readNamespace<DurableJobRecord<ManagedExportDurableJobInputV1>>(
            envelope.projectId,
            'jobs',
        );
        expect(JSON.stringify(stored?.input)).not.toMatch(/(?:\/|\\\\|secret|api.?key|password)/i);
        expect(materials.resolve).not.toHaveBeenCalled();
        await scheduler.close();
    });

    it('recovers an interrupted export once without reading a path from durable input', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('durable-export-recovery');
        await store.createProject(envelope);
        const input = durableInput('export:portable-bundle', {
            projectId: envelope.projectId,
            jobId: 'recovered-export-job',
            capturedState: stateToken(envelope.projectId),
        });
        const now = new Date().toISOString();
        const interrupted: DurableJobRecord<ManagedExportDurableJobInputV1> = {
            schemaVersion: 1,
            jobId: input.jobId,
            projectId: input.projectId,
            kind: input.kind,
            input,
            inputDigest: 'sha256:recovered-export-input',
            capturedState: input.capturedState,
            sequence: 3,
            state: 'running',
            stage: 'writing',
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
        const hooks = exportHooks();
        const prepared = serviceFixture(hooks);
        const materials = materialFactory();
        const scheduler = new DurableJobScheduler(store, new RuntimeDiagnostics(), {
            persistTransition: async (record, terminalPublication) => {
                await atomicWriteJson(
                    store.projectPath(record.projectId, 'jobs', `${record.jobId}.json`),
                    record,
                );
                if (terminalPublication) {
                    terminalPublication.artifacts.forEach((artifact) => artifact.accept());
                    await Promise.all(terminalPublication.outputs?.map((output) => output.accept()) ?? []);
                }
            },
        });
        registerManagedExportDurableJobHandlers(scheduler, {
            service: prepared.service,
            materials: materials.factory,
        });

        await scheduler.recover([envelope.projectId]);
        await waitFor(() => scheduler.get(input.jobId)?.state === 'succeeded');
        await scheduler.recover([envelope.projectId]);

        expect(prepared.prepare).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(scheduler.get(input.jobId)?.input)).not.toMatch(/(?:\/|\\\\)/);
        expect(materials.resolve).toHaveBeenCalledWith(input, expect.objectContaining({
            signal: expect.any(AbortSignal),
        }));
        await scheduler.close();
    });
});

function durableInput(
    kind: typeof MANAGED_EXPORT_DURABLE_JOB_KINDS[number],
    overrides: Partial<ManagedExportDurableJobInputV1> = {},
): ManagedExportDurableJobInputV1 {
    const projectId = overrides.projectId ?? 'durable-export-project';
    const capturedState = overrides.capturedState ?? stateToken(projectId);
    return createManagedExportDurableJobInput({
        schemaVersion: 1,
        kind,
        projectId,
        jobId: overrides.jobId ?? `job-${kind.slice('export:'.length)}`,
        capturedState,
        destination: overrides.destination ?? {
            schemaVersion: 1,
            destinationId: `destination-${kind.slice('export:'.length)}`,
            grantId: 'grant-export',
            stagingHandleId: `stage-${kind.slice('export:'.length)}`,
            mode: 'create-only',
            outputName: 'managed-export.bin',
            verifiedParentIdentity: 'parent-export',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        materialReference: overrides.materialReference ?? `material-${kind.slice('export:'.length)}`,
    });
}

function stateToken(projectId: string, sessionId = 'durable-export-session'): StateToken {
    return {
        sessionId,
        projectId,
        sessionEpoch: 'durable-export-epoch',
        sessionRevision: 0,
        documentRevision: 0,
        audioGraphRevision: 0,
        narrativeRevision: 0,
        eventCursor: 'durable-export-cursor',
    };
}

function executionContext(signal = new AbortController().signal) {
    return {
        signal,
        checkpoint: undefined,
        update: async () => undefined,
    };
}

function materialFactory(
    cleanup: () => Promise<void> | void = vi.fn<() => Promise<void>>(async () => undefined),
): {
    readonly factory: ManagedExportMaterialFactory;
    readonly resolve: Mock<() => Promise<Record<string, never>>>;
} {
    const resolve = vi.fn<() => Promise<Record<string, never>>>(async () => ({}));
    return {
        factory: { resolveMaterial: resolve, cleanup },
        resolve,
    };
}

interface ExportHooks {
    readonly artifactId: string;
    readonly publicationId: string;
    readonly preparePublication: Mock<() => void>;
    readonly abortCandidate: Mock<() => Promise<void>>;
    readonly acceptArtifact: Mock<() => void>;
    readonly rejectArtifact: Mock<() => Promise<void>>;
    readonly acceptPublication: Mock<() => Promise<void>>;
    readonly rejectPublication: Mock<() => Promise<void>>;
    readonly prepareError?: Error;
    assertAcceptedAfterCommit?: () => void;
}

function exportHooks(options: { prepareError?: Error } = {}): ExportHooks {
    return {
        artifactId: 'export-artifact-1',
        publicationId: 'export-publication-1',
        preparePublication: vi.fn<() => void>(),
        abortCandidate: vi.fn<() => Promise<void>>(async () => undefined),
        acceptArtifact: vi.fn<() => void>(),
        rejectArtifact: vi.fn<() => Promise<void>>(async () => undefined),
        acceptPublication: vi.fn<() => Promise<void>>(async () => undefined),
        rejectPublication: vi.fn<() => Promise<void>>(async () => undefined),
        ...options,
    };
}

function serviceFixture(hooks: ExportHooks): {
    readonly service: ManagedExportJobService;
    readonly prepare: Mock<(request: ManagedExportRequest) => Promise<ManagedExportTerminalProposal>>;
} {
    const prepare = vi.fn<(request: ManagedExportRequest) => Promise<ManagedExportTerminalProposal>>(
        async (request) => proposalFor(request, hooks),
    );
    return { service: { prepare }, prepare };
}

function proposalFor(request: ManagedExportRequest, hooks: ExportHooks): ManagedExportTerminalProposal {
    const digest = `sha256:${'a'.repeat(64)}` as const;
    const artifact: StagedArtifact = {
        record: {
            schemaVersion: 1,
            artifactId: hooks.artifactId,
            projectId: request.projectId,
            kind: `export:${request.exportKind}`,
            mediaType: 'application/octet-stream',
            byteLength: 4,
            digest,
            relativeBlobPath: 'blobs/export-artifact-1.blob',
            createdAt: new Date().toISOString(),
            sourceIds: [],
        },
        registryWrite: {
            relativePath: `artifacts/${hooks.artifactId}.json`,
            value: { artifactId: hooks.artifactId },
        },
        accept: () => {
            hooks.assertAcceptedAfterCommit?.();
            hooks.acceptArtifact();
        },
        reject: hooks.rejectArtifact,
    };
    const publication: StagedOutputPublication = {
        record: {
            schemaVersion: 1,
            publicationId: hooks.publicationId,
            grantId: request.destination.grantId,
            sessionId: 'durable-export-session',
            byteLength: 4,
            digest,
            createdAt: new Date().toISOString(),
        },
        registryWrite: {
            relativePath: `outputs/${hooks.publicationId}.json`,
            value: { publicationId: hooks.publicationId },
        },
        accept: async () => {
            hooks.assertAcceptedAfterCommit?.();
            await hooks.acceptPublication();
        },
        reject: hooks.rejectPublication,
    };
    const output: ManagedOutputCandidate = {
        outputId: request.destination.destinationId,
        contentDigest: digest,
        byteLength: 4,
        preparePublication: async () => {
            hooks.preparePublication();
            if (hooks.prepareError) throw hooks.prepareError;
            return publication;
        },
        abort: hooks.abortCandidate,
    };
    const jobResult = {
        jobId: request.jobId,
        jobKind: `export:${request.exportKind}` as const,
        exportKind: request.exportKind,
        outputId: output.outputId,
        contentDigest: digest,
        byteLength: 4,
        mediaType: 'application/octet-stream',
        warnings: [],
    };
    return {
        jobKind: jobResult.jobKind,
        outputs: [output],
        artifacts: [artifact],
        jobResult,
        events: [
            {
                type: 'artifact.created',
                data: {
                    artifactId: hooks.artifactId,
                    outputId: output.outputId,
                },
            },
            {
                type: 'job.changed',
                data: {
                    jobId: request.jobId,
                    artifactId: hooks.artifactId,
                    outputId: output.outputId,
                },
            },
        ],
    };
}

async function waitFor(predicate: () => boolean, timeoutMilliseconds = 3_000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMilliseconds) throw new Error('Timed out waiting for job state.');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
