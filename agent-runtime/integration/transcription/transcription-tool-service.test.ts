import { describe, expect, it, vi } from 'vitest';
import type { DurableJobEnqueueInput, DurableJobRecord, DurableJobScheduler } from '../../jobs/durable-job-scheduler';
import { DurableJobScheduler as DurableScheduler } from '../../jobs/durable-job-scheduler';
import type { ManagedMutationEnvelope, ManagedMutationResult, StateToken } from '../../coordinator/types';
import { RuntimeDiagnostics } from '../../diagnostics/runtime-diagnostics';
import type { CanonicalToolCall } from '../../mcp/contracts';
import { ManagedFilesystemStore } from '../../persistence/managed-filesystem-store';
import { atomicWriteJson } from '../../persistence/fs-durable';
import { temporaryRuntime, testEnvelope } from '../../testing/runtime-test-helpers';
import {
    ManagedCredentialCapabilityAuthority,
    ManagedEndpointCapabilityAuthority,
} from './capabilities';
import type {
    ManagedTranscriptionFactoryDependencies,
    ManagedTranscriptionJobInputV1,
} from './contracts';
import {
    createManagedTranscriptionIntegration,
    ManagedTranscriptionStartService,
    type ManagedTranscriptionStartCoordinatorPort,
} from './transcription-tool-service';

const state: StateToken = {
    sessionId: 'session-1',
    projectId: 'project-1',
    sessionEpoch: 'epoch-1',
    sessionRevision: 4,
    documentRevision: 3,
    audioGraphRevision: 2,
    narrativeRevision: 1,
    eventCursor: 'event-4',
};

describe('managed transcription start integration', () => {
    it('maps the default local provider without persisting its URL and keeps an optional secret out of the job and WAL', async () => {
        const runtime = fixture({ localSecret: 'provider-secret-sentinel' });
        const result = await runtime.service.handle(call({
            transcriptionKind: 'editorial',
            targetTrackIds: ['editorial-target'],
            ranges: [
                { sourceId: 'source-a', startSample16k: 0, endSample16k: 160 },
                { sourceId: 'source-a', startSample16k: 160, endSample16k: 320 },
            ],
            language: 'es',
            speakerMode: 'diarized',
            providerPolicy: {
                kind: 'managed-local-endpoint',
                credentialCapabilityId: 'credential-reference-1',
            },
        }), context());

        expect(result).toMatchObject({
            ok: true,
            data: { jobId: 'job-1', job: { kind: 'editorial-transcription' } },
        });
        expect(runtime.core.planStart).toHaveBeenCalledWith(expect.objectContaining({
            transcriptionKind: 'editorial',
            targetTrackIds: ['editorial-target'],
            capturedState: state,
        }));
        expect(runtime.jobs).toHaveLength(1);
        expect(runtime.jobs[0]!.input).toMatchObject({
            kind: 'editorial-transcription',
            language: 'es',
            speakerMode: 'diarized',
            contextSamples: 32_000,
            sources: [{
                sourceId: 'source-a',
                sourceSampleCount: 640,
                ranges: [{ startSample: 0, endSample: 320 }],
            }],
            providerPolicy: { kind: 'managed-local-endpoint' },
        });
        const policy = runtime.jobs[0]!.input.providerPolicy;
        expect(policy).not.toHaveProperty('endpointCapabilityId');
        expect(policy).toHaveProperty('credentialCapabilityId');

        const durableProjection = JSON.stringify({
            job: runtime.jobs[0],
            wal: runtime.wal,
            receipts: Array.from(runtime.receipts.entries()),
        });
        expect(durableProjection).not.toContain('http://localhost:43556/v1/audio/transcriptions');
        expect(durableProjection).not.toContain('provider-secret-sentinel');
        expect(durableProjection).not.toContain('credential-reference-1');
    });

    it('selects subtitle jobs and defaults an omitted range list to each Core-authorized source', async () => {
        const runtime = fixture();
        runtime.core.planStart.mockResolvedValueOnce({
            targetIds: ['subtitle-target'],
            sources: [source('source-b', 'b', 120), source('source-a', 'a', 640)],
        });

        const result = await runtime.service.handle(call({
            transcriptionKind: 'subtitle',
            targetTrackIds: ['subtitle-target'],
            language: null,
            speakerMode: 'none',
            providerPolicy: { kind: 'managed-local-endpoint' },
        }), context());

        expect(result).toMatchObject({ ok: true, data: { job: { kind: 'subtitle-transcription' } } });
        expect(runtime.jobs[0]!.input.sources).toEqual([
            expect.objectContaining({
                sourceId: 'source-a',
                ranges: [{ startSample: 0, endSample: 640 }],
            }),
            expect.objectContaining({
                sourceId: 'source-b',
                ranges: [{ startSample: 0, endSample: 120 }],
            }),
        ]);
    });

    it('uses the coordinator receipt boundary to return the original job on replay and reject an idempotency conflict', async () => {
        const runtime = fixture();
        const firstCall = call({
            transcriptionKind: 'subtitle',
            targetTrackIds: ['subtitle-target'],
            language: 'en',
            speakerMode: 'none',
            providerPolicy: { kind: 'managed-local-endpoint' },
        }, 'a', 'same-idempotency-key');

        const first = await runtime.service.handle(firstCall, context());
        const replay = await runtime.service.handle(firstCall, context());
        const conflict = await runtime.service.handle(call({
            transcriptionKind: 'editorial',
            targetTrackIds: ['editorial-target'],
            language: 'en',
            speakerMode: 'none',
            providerPolicy: { kind: 'managed-local-endpoint' },
        }, 'b', 'same-idempotency-key'), context());

        expect(first).toMatchObject({ ok: true, replayed: false, data: { jobId: 'job-1' } });
        expect(replay).toMatchObject({ ok: true, replayed: true, data: { jobId: 'job-1' } });
        expect(conflict).toMatchObject({
            ok: false,
            error: { code: 'IDEMPOTENCY_KEY_CONFLICT' },
        });
        expect(runtime.jobs).toHaveLength(1);
    });

    it('mints a server capability only from a process-local configuration response', async () => {
        const runtime = fixture({
            openAiConfiguration: {
                endpoint: 'https://transcriber.example.test/v1/audio/transcriptions',
                credential: 'server-secret-sentinel',
            },
        });
        const result = await runtime.service.handle(call({
            transcriptionKind: 'editorial',
            targetTrackIds: ['editorial-target'],
            language: 'fr',
            speakerMode: 'diarized',
            providerPolicy: {
                kind: 'openai-compatible',
                endpointCapabilityId: 'endpoint-reference-1',
                credentialCapabilityId: 'credential-reference-1',
            },
        }), context());

        expect(result).toMatchObject({ ok: true });
        expect(runtime.jobs[0]!.input.providerPolicy).toMatchObject({
            kind: 'managed-server-endpoint',
            endpointCapabilityId: expect.stringMatching(/^transcription-endpoint:/),
            credentialCapabilityId: expect.stringMatching(/^transcription-credential:/),
        });
        const durableProjection = JSON.stringify({ job: runtime.jobs[0], wal: runtime.wal });
        expect(durableProjection).not.toContain('transcriber.example.test');
        expect(durableProjection).not.toContain('server-secret-sentinel');
        expect(durableProjection).not.toContain('endpoint-reference-1');
        expect(durableProjection).not.toContain('credential-reference-1');
    });

    it.each([
        {
            label: 'a browser-local policy',
            providerPolicy: { kind: 'browser-local' },
            expected: 'Browser-local transcription',
        },
        {
            label: 'an unknown range source',
            providerPolicy: { kind: 'managed-local-endpoint' },
            ranges: [{ sourceId: 'missing-source', startSample16k: 0, endSample16k: 10 }],
            expected: 'not authorized',
        },
        {
            label: 'a model override',
            providerPolicy: { kind: 'managed-local-endpoint', model: 'other-model' },
            expected: 'fixed editorial model',
        },
    ])('rejects $label before enqueue', async ({ providerPolicy, ranges, expected }) => {
        const runtime = fixture();
        await expect(runtime.service.handle(call({
            transcriptionKind: 'subtitle',
            targetTrackIds: ['subtitle-target'],
            ...(ranges ? { ranges } : {}),
            language: 'en',
            speakerMode: 'none',
            providerPolicy,
        }), context())).rejects.toThrow(expected);
        expect(runtime.jobs).toEqual([]);
    });

    it('installs both durable workers before recovery without expanding runtime composition', () => {
        const runtime = fixture();
        const register = vi.fn();
        const bundle = createManagedTranscriptionIntegration({
            coordinator: runtime.coordinator,
            core: runtime.core,
            endpoints: runtime.endpoints,
            credentials: runtime.credentials,
            jobDependencies: fakeJobDependencies(),
        });

        bundle.install({ register } as unknown as DurableJobScheduler);

        expect(register).toHaveBeenNthCalledWith(1, 'editorial-transcription', expect.anything());
        expect(register).toHaveBeenNthCalledWith(2, 'subtitle-transcription', expect.anything());
    });

    it('keeps a default-local job resumable because recovery does not need a persisted endpoint capability', async () => {
        const runtime = fixture();
        await runtime.service.handle(call({
            transcriptionKind: 'editorial',
            targetTrackIds: ['editorial-target'],
            language: 'es',
            speakerMode: 'none',
            providerPolicy: { kind: 'managed-local-endpoint' },
        }), context());
        const localJob = runtime.jobs[0]!;
        expect(localJob.input.providerPolicy).toEqual({ kind: 'managed-local-endpoint' });

        const disk = await temporaryRuntime();
        try {
            const store = new ManagedFilesystemStore(disk.path);
            await store.initialize();
            const envelope = testEnvelope(state.projectId, state.sessionId);
            await store.createProject(envelope);
            const interrupted: DurableJobRecord<ManagedTranscriptionJobInputV1> = {
                ...structuredClone(localJob),
                state: 'interrupted',
                stage: 'interrupted',
                sequence: 2,
            };
            await atomicWriteJson(
                store.projectPath(envelope.projectId, 'jobs', `${interrupted.jobId}.json`),
                interrupted,
            );
            const scheduler = new DurableScheduler(store, new RuntimeDiagnostics());
            scheduler.register('editorial-transcription', {
                validateInput: input => {
                    expect((input as ManagedTranscriptionJobInputV1).providerPolicy)
                        .toEqual({ kind: 'managed-local-endpoint' });
                },
                run: async () => ({ result: { recovered: true } }),
            });
            await scheduler.recover([envelope.projectId]);
            await waitFor(() => scheduler.get(interrupted.jobId)?.state === 'succeeded');
            expect(scheduler.get(interrupted.jobId)?.result).toEqual({ recovered: true });
            await scheduler.close();
        } finally {
            await disk.cleanup();
        }
    });
});

function fixture(options: {
    localSecret?: string;
    openAiConfiguration?: { readonly endpoint: string; readonly credential?: string };
} = {}) {
    const endpoints = new ManagedEndpointCapabilityAuthority({
        resolveLocalhost: async () => [{ address: '127.0.0.1', family: 4 }],
        validateServerEndpoint: async () => undefined,
    });
    const credentials = new ManagedCredentialCapabilityAuthority();
    const coordinator = new MemoryCoordinator();
    const core = {
        planStart: vi.fn(async ({ targetTrackIds }: { readonly targetTrackIds: readonly string[] }) => ({
            targetIds: targetTrackIds,
            sources: [source('source-a', 'a', 640)],
        })),
    };
    const service = new ManagedTranscriptionStartService({
        coordinator,
        core,
        endpoints,
        credentials,
        providerConfiguration: {
            resolveLocalCredential: async () => options.localSecret ?? 'unused-secret',
            resolveOpenAiCompatible: async () => {
                if (!options.openAiConfiguration) throw new Error('OpenAI configuration was not expected.');
                return options.openAiConfiguration;
            },
        },
    });
    return {
        service,
        coordinator,
        core,
        endpoints,
        credentials,
        jobs: coordinator.jobs,
        wal: coordinator.wal,
        receipts: coordinator.receipts,
    };
}

class MemoryCoordinator implements ManagedTranscriptionStartCoordinatorPort {
    readonly jobs: DurableJobRecord<ManagedTranscriptionJobInputV1>[] = [];
    readonly wal: unknown[] = [];
    readonly receipts = new Map<string, {
        readonly requestHash: string;
        readonly job: DurableJobRecord<ManagedTranscriptionJobInputV1>;
    }>();

    resolveProjectId(sessionId: string): string {
        if (sessionId !== state.sessionId) throw new Error('Unexpected session.');
        return state.projectId;
    }

    getProject(projectId: string) {
        if (projectId !== state.projectId) throw new Error('Unexpected project.');
        return { state: structuredClone(state) };
    }

    async enqueueJob(
        projectId: string,
        request: ManagedMutationEnvelope,
        input: Omit<
            DurableJobEnqueueInput<ManagedTranscriptionJobInputV1>,
            'projectId' | 'capturedState'
        >,
    ): Promise<ManagedMutationResult<{ readonly job: DurableJobRecord<ManagedTranscriptionJobInputV1> }>> {
        const existing = this.receipts.get(request.idempotencyKey);
        if (existing) {
            if (existing.requestHash !== request.canonicalRequestHash) {
                return {
                    ok: false,
                    error: {
                        code: 'IDEMPOTENCY_KEY_CONFLICT',
                        message: 'The idempotency key was already used with a different request.',
                        retryable: false,
                    },
                    state: structuredClone(state),
                };
            }
            return {
                ok: true,
                data: { job: structuredClone(existing.job) },
                state: structuredClone(state),
                warnings: [],
                replayed: true,
            };
        }
        const job: DurableJobRecord<ManagedTranscriptionJobInputV1> = {
            schemaVersion: 1,
            jobId: `job-${this.jobs.length + 1}`,
            projectId,
            kind: input.kind,
            input: structuredClone(input.input),
            inputDigest: input.inputDigest,
            capturedState: structuredClone(state),
            sequence: 1,
            state: 'queued',
            stage: 'queued',
            resultArtifactIds: [],
            cancellable: input.cancellable,
            resumable: input.resumable,
            createdAt: '2026-07-25T16:00:00.000Z',
            updatedAt: '2026-07-25T16:00:00.000Z',
        };
        this.jobs.push(job);
        this.receipts.set(request.idempotencyKey, {
            requestHash: request.canonicalRequestHash,
            job,
        });
        this.wal.push({
            command: request.command,
            canonicalRequestHash: request.canonicalRequestHash,
            job,
        });
        return {
            ok: true,
            data: { job: structuredClone(job) },
            state: structuredClone(state),
            warnings: [],
            replayed: false,
        };
    }
}

function source(sourceId: string, digestCharacter: string, sourceSampleCount: number) {
    return {
        sourceId,
        sourceFingerprint: `sha256:${digestCharacter.repeat(64)}` as const,
        sourceSampleCount,
    };
}

function call(
    input: Record<string, unknown>,
    hashCharacter = 'a',
    idempotencyKey = 'transcription-idempotency-key',
): CanonicalToolCall {
    return {
        toolName: 'waptions_transcription_start',
        request: {
            apiVersion: '2026-07-25',
            sessionId: state.sessionId,
            sessionEpoch: state.sessionEpoch,
            expected: {
                sessionRevision: state.sessionRevision,
                documentRevision: state.documentRevision,
                audioGraphRevision: state.audioGraphRevision,
                ...(state.narrativeRevision === undefined
                    ? {}
                    : { narrativeRevision: state.narrativeRevision }),
            },
            idempotencyKey,
            ...input,
        },
        canonicalRequest: '{}',
        requestHash: `sha256:${hashCharacter.repeat(64)}` as `sha256:${string}`,
    };
}

function context() {
    return { signal: new AbortController().signal };
}

function fakeJobDependencies(): ManagedTranscriptionFactoryDependencies {
    return {
        endpoints: {} as ManagedTranscriptionFactoryDependencies['endpoints'],
        credentials: {} as ManagedTranscriptionFactoryDependencies['credentials'],
        sources: {} as ManagedTranscriptionFactoryDependencies['sources'],
        freshness: {} as ManagedTranscriptionFactoryDependencies['freshness'],
        cas: {} as ManagedTranscriptionFactoryDependencies['cas'],
        publisher: {} as ManagedTranscriptionFactoryDependencies['publisher'],
        provider: {} as ManagedTranscriptionFactoryDependencies['provider'],
        decoder: {} as ManagedTranscriptionFactoryDependencies['decoder'],
    };
}

async function waitFor(predicate: () => boolean, timeoutMilliseconds = 1_000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started >= timeoutMilliseconds) {
            throw new Error('Timed out waiting for durable job recovery.');
        }
        await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
}
