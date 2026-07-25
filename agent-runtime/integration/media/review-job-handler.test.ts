import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactRegistry } from '../../artifacts/artifact-registry';
import { ManagedFilesystemStore } from '../../persistence/managed-filesystem-store';
import { RuntimeDiagnostics } from '../../diagnostics/runtime-diagnostics';
import { PathGrantAuthority } from '../../path-grants/path-grant-authority';
import { testEnvelope } from '../../testing/runtime-test-helpers';
import { ManagedMediaProbeService } from '../../media/probe';
import type {
    BoundedMediaProcessPort,
    ManagedMediaProcessRequest,
} from '../../media/process-port';
import type { DecodedMemoryBudgetPort } from '../../media/ports';
import { ManagedMediaToolService } from './managed-media-tools';
import { PathGrantMediaAdapter } from './path-grant-media-adapter';
import { PrivateReviewArtifactStager } from './review-artifact-staging';
import { ManagedMediaReviewJobHandler } from './review-job-handler';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

class ProbeAndReviewProcess implements BoundedMediaProcessPort {
    async execute(request: ManagedMediaProcessRequest) {
        const input = {
            totalBytes: 1,
            maxChunkBytes: 1,
            ranges: [{ start: 0, endExclusive: 1 }],
        };
        const base = {
            input,
            outputBytes: 0,
            stdoutBytes: 0,
            stderrBytes: 0,
            maxBufferedBytes: 1024,
            peakResidentBytes: 1024,
            decodedRanges: 'ranges' in request.operation ? request.operation.ranges : [],
        };
        if (request.operation.kind === 'probe') {
            const stdout = Buffer.from(JSON.stringify({
                streams: [{
                    index: 0,
                    codec_type: 'audio',
                    codec_name: 'pcm_s16le',
                    sample_rate: '48000',
                    channels: 2,
                    duration: '2',
                }],
                format: {
                    format_name: 'wav',
                    duration: '2',
                    size: String(request.source.snapshot.byteLength),
                },
            }));
            return {
                kind: 'probe' as const,
                stdout,
                accounting: { ...base, stdoutBytes: stdout.byteLength, decodedRanges: [] },
            };
        }
        if (request.operation.kind === 'audio-analysis') {
            return {
                kind: 'audio-analysis' as const,
                samples: [
                    {
                        startUs: 0,
                        endUs: 1_000_000,
                        minimum: -0.5,
                        maximum: 0.5,
                        rmsDb: -20,
                        peakDb: -3,
                    },
                    {
                        startUs: 1_000_000,
                        endUs: 2_000_000,
                        minimum: -0.1,
                        maximum: 0.1,
                        rmsDb: -50,
                        peakDb: -30,
                    },
                ],
                accounting: base,
            };
        }
        throw new Error(`Unexpected operation: ${request.operation.kind}`);
    }
}

const decodedMemory: DecodedMemoryBudgetPort = {
    reserve: async ({ bytes }) => ({
        leaseId: 'lease-1',
        reservedBytes: bytes,
        release: async () => undefined,
    }),
};

describe('managed review terminal publication', () => {
    it('stages real review JSON but keeps registry records invisible until the coordinator transaction', async () => {
        const root = await mkdtemp(join(tmpdir(), 'waptions-review-job-'));
        cleanups.push(() => rm(root, { recursive: true, force: true }));
        const inputs = join(root, 'inputs');
        await mkdir(inputs);
        const sourcePath = join(inputs, 'voice.wav');
        await writeFile(sourcePath, Buffer.from('audio-source'));
        const pathAuthority = new PathGrantAuthority({
            privateCopyRoot: join(root, 'private'),
            authoritySecret: Buffer.alloc(32, 3),
        });
        const scope = { sessionId: 'session-1', sessionEpoch: 'epoch-1' };
        const grant = await pathAuthority.create(
            scope.sessionId,
            scope.sessionEpoch,
            'read-root',
            inputs,
        );
        const media = new PathGrantMediaAdapter(pathAuthority);
        const process = new ProbeAndReviewProcess();
        const probe = new ManagedMediaProbeService(media, media, process, {
            record: () => undefined,
        });
        let sourceId = '';
        const tools = new ManagedMediaToolService(media, probe, {
            importMedia: async ({ request, revalidate, commitAuthority }) => {
                await revalidate();
                sourceId = request.sources.audioSourceDescriptors[0]!.id;
                commitAuthority();
                return {
                    ok: true,
                    sourceIds: [sourceId],
                    placedClipIds: [],
                } as never;
            },
        });
        const probed = await tools.probe({
            operationId: 'review-probe',
            sessionId: scope.sessionId,
            sessionEpoch: scope.sessionEpoch,
            grantId: grant.grantId,
            paths: [sourcePath],
        });
        await tools.import({
            request: {
                apiVersion: '2026-07-25',
                toolName: 'waptions_media_import',
                sessionEpoch: scope.sessionEpoch,
                expected: { sessionRevision: 0, documentRevision: 0, audioGraphRevision: 0 },
                idempotencyKey: 'import-review-source',
            },
            mediaHandles: [probed.handles[0]!.handleId],
            placement: { kind: 'register-only' },
        });

        const store = new ManagedFilesystemStore(join(root, 'store'));
        await store.initialize();
        const envelope = testEnvelope('review-project');
        await store.createProject(envelope);
        const artifacts = new ArtifactRegistry(
            store,
            Buffer.alloc(32, 9),
            new RuntimeDiagnostics(),
        );
        const handler = new ManagedMediaReviewJobHandler(
            media,
            process,
            new PrivateReviewArtifactStager(join(root, 'review-staging')),
            artifacts,
            decodedMemory,
        );
        const output = await handler.run({
            projectId: envelope.projectId,
            jobId: 'review-job',
            sourceIds: [sourceId],
            reviewKind: 'waveform-audio-map',
            intervalsSeconds: [{ startSeconds: 0, endSeconds: 2 }],
            maximumSamples: 2,
        }, {
            signal: new AbortController().signal,
            checkpoint: undefined,
            update: async () => undefined,
        });

        expect(output.artifactIds).toHaveLength(2);
        expect(await artifacts.list(envelope.projectId)).toEqual([]);
        await store.transact({
            baseSessionRevision: 0,
            envelope: {
                ...envelope,
                sessionRevision: 1,
                artifactRevision: 1,
            },
            writes: output.terminalPublication!.artifacts.map((artifact) => (
                artifact.registryWrite
            )),
        });
        output.terminalPublication!.artifacts.forEach((artifact) => artifact.accept());
        expect((await artifacts.list(envelope.projectId)).map((record) => record.kind).sort())
            .toEqual(['audio-map', 'waveform']);
    });
});
