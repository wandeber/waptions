import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactRegistry } from '../../artifacts/artifact-registry';
import { RuntimeDiagnostics } from '../../diagnostics/runtime-diagnostics';
import { ManagedMediaProbeService } from '../../media/probe';
import { executeBoundedMediaProcess } from '../../media/process-execution';
import type { MediaDiagnosticsPort } from '../../media/ports';
import { PathGrantAuthority } from '../../path-grants/path-grant-authority';
import { ManagedFilesystemStore } from '../../persistence/managed-filesystem-store';
import { testEnvelope } from '../../testing/runtime-test-helpers';
import { ManagedMediaToolService } from './managed-media-tools';
import { NodeBoundedMediaProcessPort } from './node-bounded-media-process';
import { PathGrantMediaAdapter } from './path-grant-media-adapter';
import { PrivateReviewArtifactStager } from './review-artifact-staging';
import { ManagedMediaReviewJobHandler } from './review-job-handler';

const FFMPEG_AVAILABLE = toolAvailable('ffmpeg')
    && toolAvailable('ffprobe')
    && /(?:^|\s)libx264(?:\s|$)/m.test(runTool('ffmpeg', ['-hide_banner', '-encoders']));
const WEBP_ENCODER_AVAILABLE = FFMPEG_AVAILABLE
    && /(?:^|\s)libwebp(?:\s|$)/m.test(runTool('ffmpeg', ['-hide_banner', '-encoders']));
const cleanups: Array<() => Promise<void>> = [];
const diagnostics: MediaDiagnosticsPort = { record: () => undefined };

afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe.skipIf(!FFMPEG_AVAILABLE)('managed media system FFmpeg integration', () => {
    it('probes mixed H.264 video-without-audio and audio-only media through retained descriptors', async () => {
        const root = await mkdtemp(join(tmpdir(), 'waptions-media-process-'));
        cleanups.push(() => rm(root, { recursive: true, force: true }));
        const inputs = join(root, 'inputs');
        await mkdir(inputs);
        const videoPath = join(inputs, 'clip-10.mp4');
        const audioPath = join(inputs, 'clip-2.wav');
        runTool('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-i', 'testsrc2=s=64x36:r=30:d=0.25',
            '-an',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-threads', '1',
            '-y',
            videoPath,
        ]);
        runTool('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-i', 'sine=frequency=440:sample_rate=48000:duration=0.25',
            '-ac', '2',
            '-c:a', 'pcm_s16le',
            '-y',
            audioPath,
        ]);

        const authority = new PathGrantAuthority({
            privateCopyRoot: join(root, 'private'),
            authoritySecret: Buffer.alloc(32, 11),
        });
        const scope = { sessionId: 'session-real', sessionEpoch: 'epoch-real' };
        const grant = await authority.create(
            scope.sessionId,
            scope.sessionEpoch,
            'read-root',
            inputs,
        );
        const adapter = new PathGrantMediaAdapter(authority);
        const process = new NodeBoundedMediaProcessPort(adapter, {
            acquire: async () => {
                throw new Error('Probe must not request output staging.');
            },
        });
        const probes = new ManagedMediaProbeService(adapter, adapter, process, diagnostics);
        const service = new ManagedMediaToolService(adapter, probes, {
            importMedia: async () => {
                throw new Error('Import is outside this probe test.');
            },
        });

        const result = await service.probe({
            operationId: 'real-probe',
            sessionId: scope.sessionId,
            sessionEpoch: scope.sessionEpoch,
            grantId: grant.grantId,
            paths: [videoPath, audioPath],
        });

        expect(result.jobIds).toEqual([]);
        expect(result.handles).toHaveLength(2);
        const records = result.handles.map((handle) => adapter.get(handle.handleId)!);
        expect(records.find((record) => record.displayName === 'clip-10.mp4')).toMatchObject({
            class: 'video',
            metadata: {
                videoStreams: [{ codec: 'h264', width: 64, height: 36 }],
                audioStreams: [],
            },
        });
        expect(records.find((record) => record.displayName === 'clip-2.wav')).toMatchObject({
            class: 'audio',
            metadata: {
                videoStreams: [],
                audioStreams: [{ codec: 'pcm_s16le', sampleRate: 48_000, channels: 2 }],
            },
        });
        expect(JSON.stringify(result)).not.toContain(root);

        const video = records.find((record) => record.class === 'video')!;
        const videoHandle = await adapter.openSource(video.handle.capabilityId);
        try {
            const scene = await executeBoundedMediaProcess(process, {
                operationId: 'real-scene-analysis',
                source: videoHandle,
                operation: {
                    kind: 'scene-analysis',
                    ranges: [{ startUs: 0, endUs: 250_000 }],
                    sampleIntervalUs: 50_000,
                    maxSamples: 5,
                    analysisWidth: 64,
                },
                limits: analysisLimits(video.registeredIdentity.byteLength),
            });
            expect(scene.kind).toBe('scene-analysis');
            if (scene.kind === 'scene-analysis') {
                expect(scene.samples.length).toBeGreaterThan(0);
                expect(scene.samples.every((sample) => (
                    sample.timeUs >= 0
                    && sample.timeUs < 250_000
                    && sample.score >= 0
                ))).toBe(true);
            }
        } finally {
            await videoHandle.close();
        }

        const audio = records.find((record) => record.class === 'audio')!;
        const audioHandle = await adapter.openSource(audio.handle.capabilityId);
        try {
            const waveform = await executeBoundedMediaProcess(process, {
                operationId: 'real-audio-analysis',
                source: audioHandle,
                operation: {
                    kind: 'audio-analysis',
                    ranges: [
                        { startUs: 0, endUs: 100_000 },
                        { startUs: 150_000, endUs: 250_000 },
                    ],
                    bucketDurationUs: 50_000,
                    maxBuckets: 4,
                },
                limits: analysisLimits(audio.registeredIdentity.byteLength),
            });
            expect(waveform.kind).toBe('audio-analysis');
            if (waveform.kind === 'audio-analysis') {
                expect(waveform.samples).toHaveLength(4);
                expect(waveform.samples.every((sample) => (
                    Number.isFinite(sample.rmsDb)
                    && Math.abs(sample.minimum) <= 1
                    && Math.abs(sample.maximum) <= 1
                    && (
                        sample.endUs <= 100_000
                        || sample.startUs >= 150_000
                    )
                ))).toBe(true);
            }
        } finally {
            await audioHandle.close();
        }
    }, 30_000);

    it.skipIf(!WEBP_ENCODER_AVAILABLE)(
        'creates a real bounded contact sheet and keeps it staged until the terminal transaction',
        async () => {
        const root = await mkdtemp(join(tmpdir(), 'waptions-media-review-process-'));
        cleanups.push(() => rm(root, { recursive: true, force: true }));
        const inputs = join(root, 'inputs');
        await mkdir(inputs);
        const videoPath = join(inputs, 'review.mp4');
        runTool('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-i', 'testsrc2=s=64x36:r=30:d=0.5',
            '-an',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-threads', '1',
            '-y',
            videoPath,
        ]);
        const pathAuthority = new PathGrantAuthority({
            privateCopyRoot: join(root, 'private'),
            authoritySecret: Buffer.alloc(32, 12),
        });
        const scope = { sessionId: 'session-review', sessionEpoch: 'epoch-review' };
        const grant = await pathAuthority.create(
            scope.sessionId,
            scope.sessionEpoch,
            'read-root',
            inputs,
        );
        const media = new PathGrantMediaAdapter(pathAuthority);
        const stager = new PrivateReviewArtifactStager(join(root, 'review-staging'));
        const process = new NodeBoundedMediaProcessPort(media, stager);
        const probes = new ManagedMediaProbeService(media, media, process, diagnostics);
        let sourceId = '';
        const tools = new ManagedMediaToolService(media, probes, {
            importMedia: async ({ request, revalidate, commitAuthority }) => {
                await revalidate();
                sourceId = request.sources.videoSourceDescriptors[0]!.id;
                commitAuthority();
                return {
                    ok: true,
                    sourceIds: [sourceId],
                    placedClipIds: [],
                } as never;
            },
        });
        const probed = await tools.probe({
            operationId: 'real-review-probe',
            sessionId: scope.sessionId,
            sessionEpoch: scope.sessionEpoch,
            grantId: grant.grantId,
            paths: [videoPath],
        });
        await tools.import({
            request: {
                apiVersion: '2026-07-25',
                toolName: 'waptions_media_import',
                sessionEpoch: scope.sessionEpoch,
                expected: { sessionRevision: 0, documentRevision: 0, audioGraphRevision: 0 },
                idempotencyKey: 'real-review-import',
            },
            mediaHandles: [probed.handles[0]!.handleId],
            placement: { kind: 'register-only' },
        });

        const store = new ManagedFilesystemStore(join(root, 'store'));
        await store.initialize();
        const envelope = testEnvelope('real-review-project');
        await store.createProject(envelope);
        const artifacts = new ArtifactRegistry(
            store,
            Buffer.alloc(32, 13),
            new RuntimeDiagnostics(),
        );
        const handler = new ManagedMediaReviewJobHandler(
            media,
            process,
            stager,
            artifacts,
            {
                reserve: async ({ bytes }) => ({
                    leaseId: 'real-review-memory',
                    reservedBytes: bytes,
                    release: async () => undefined,
                }),
            },
        );
        const output = await handler.run({
            projectId: envelope.projectId,
            jobId: 'real-review-job',
            sourceIds: [sourceId],
            reviewKind: 'contact-sheet',
            maximumSamples: 4,
        }, {
            signal: new AbortController().signal,
            checkpoint: undefined,
            update: async () => undefined,
        });

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
        const [record] = await artifacts.list(envelope.projectId);
        expect(record).toMatchObject({ kind: 'contact-sheet', mediaType: 'image/webp' });
        const header = await artifacts.readRange(
            envelope.projectId,
            record!.artifactId,
            0,
            Math.min(record!.byteLength, 12),
        );
        expect(Buffer.from(header.bytes).subarray(0, 4).toString('ascii')).toBe('RIFF');
        expect(Buffer.from(header.bytes).subarray(8, 12).toString('ascii')).toBe('WEBP');
        },
        30_000,
    );
});

function toolAvailable(executable: string): boolean {
    return spawnSync(executable, ['-version'], {
        stdio: 'ignore',
        timeout: 5_000,
    }).status === 0;
}

function runTool(executable: string, args: readonly string[]): string {
    const result = spawnSync(executable, [...args], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30_000,
    });
    if (result.status !== 0) {
        throw new Error(`${executable} failed (${result.status}): ${result.stderr}`);
    }
    return result.stdout;
}

function analysisLimits(maxInputBytes: number) {
    return {
        timeoutMs: 30_000,
        killGraceMs: 1_000,
        maxInputBytes,
        maxOutputBytes: 0,
        maxStdoutBytes: 4 * 1024 * 1024,
        maxStderrBytes: 64 * 1024,
        maxBufferedBytes: 4 * 1024 * 1024,
        maxResidentBytes: 256 * 1024 * 1024,
    };
}
