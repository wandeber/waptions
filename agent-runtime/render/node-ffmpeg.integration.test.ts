import { constants, readSync } from 'node:fs';
import {
    mkdtemp,
    open,
    rm,
    stat,
    writeFile,
    type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HeadlessMediaIdentity } from '../../src/lib/render-plan';
import {
    NodeFfprobeMp4Verifier,
    type AcquiredNodeStagedOutputHandle,
    type NodeStagedOutputHandleResolverPort,
} from '../export';
import {
    materializeCanonicalAudio,
} from './ffmpeg-audio-materializer';
import {
    HeadlessRenderError,
    type HeadlessStagedOutputCapability,
} from './contracts';
import type {
    AcquiredImmutableSourceHandle,
    ImmutableSourceHandleResolverPort,
} from './node-ffmpeg-handles';
import { createNodeFfmpegPlanFixture } from './node-ffmpeg.test-fixtures';
import {
    NodeBackendProcessTracker,
    NodeBoundedFfmpegProcessRunner,
} from './node-ffmpeg-process';
import { NodeFfmpegResolvedPlanExecutor } from './node-ffmpeg-resolved-plan-executor';

const FFMPEG_AVAILABLE = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const HEVC_ENCODER_AVAILABLE = FFMPEG_AVAILABLE
    && /(?:^|\s)libx265(?:\s|$)/m.test(runTool('ffmpeg', ['-hide_banner', '-encoders']));
const OUTPUT_CAPABILITY: HeadlessStagedOutputCapability = {
    version: 1,
    kind: 'create-only-staged-output',
    capabilityId: 'capability:integration-output',
    grantId: 'grant:integration-output',
    stagingId: 'staging:integration-output',
};

describe.skipIf(!FFMPEG_AVAILABLE)('system FFmpeg resolved-plan integration', () => {
    let directory: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'waptions-ffmpeg-integration-'));
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    it('renders video-gap-video with silent AAC and verifies the exact staged FD', async () => {
        const sourcePath = join(directory, 'generated-h264.mp4');
        const outputPath = join(directory, 'staged-output.mp4');
        runTool('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-i', 'color=c=red:s=64x36:r=30000/1001:d=1',
            '-an',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-threads', '1',
            '-y',
            sourcePath,
        ]);
        await createEmptyOutput(outputPath);
        const sourceIdentity = await identityFor(
            sourcePath,
            'video',
            'video:source',
            'source-capability:video',
        );
        const plan = createNodeFfmpegPlanFixture({
            sources: [{
                ...sourceIdentity,
                originalName: 'malicious;$(touch should-not-exist).mp4',
                mimeType: 'video/mp4',
                duration: 1,
            }],
        });
        const sourceResolver = new TestSourceHandleResolver(
            new Map([[sourceIdentity.sourceId, sourcePath]]),
        );
        const outputResolver = new TestOutputHandleResolver(outputPath);
        const executor = new NodeFfmpegResolvedPlanExecutor(
            sourceResolver,
            outputResolver,
        );

        await expect(executor.probe()).resolves.toMatchObject({
            ffmpegAvailable: true,
            ffprobeAvailable: true,
            h264Encoder: true,
            aacEncoder: true,
            mp4Muxer: true,
        });
        const result = await executor.encode(createEncodeRequest(plan));
        expect(result.diagnostics).toMatchObject({
            peakBackendProcesses: 2,
            peakScratchBytes: plan.outputEndSample * 2 * 4,
            peakVideoDecoderSessions: 1,
        });
        expect(sourceResolver.peakActiveHandles).toBe(1);
        expect(sourceResolver.activeHandles).toBe(0);
        expect(outputResolver.activeHandles).toBe(0);

        const verifier = new NodeFfprobeMp4Verifier(outputResolver);
        const inspection = await verifier.inspect(OUTPUT_CAPABILITY);
        expect(inspection).toMatchObject({
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
            pixelFormat: 'yuv420p',
            audioSampleRate: 48_000,
            audioChannels: 2,
            audioChannelLayout: 'stereo',
            videoFrameCount: plan.contentEndFrame,
        });
        const rawFrames = runToolBuffer('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'error',
            '-i', outputPath,
            '-map', '0:v:0',
            '-pix_fmt', 'rgba',
            '-f', 'rawvideo',
            'pipe:1',
        ]);
        const frameBytes = plan.renderProfile.width * plan.renderProfile.height * 4;
        expect(rawFrames.byteLength).toBe(frameBytes * plan.contentEndFrame);
        const gapPixel = Array.from(rawFrames.subarray(
            frameBytes * 2,
            frameBytes * 2 + 3,
        ));
        expect(gapPixel[0]).toBeGreaterThanOrEqual(12);
        expect(gapPixel[0]).toBeLessThanOrEqual(24);
        expect(gapPixel[1]).toBeGreaterThanOrEqual(24);
        expect(gapPixel[1]).toBeLessThanOrEqual(42);
        expect(gapPixel[2]).toBeGreaterThanOrEqual(40);
        expect(gapPixel[2]).toBeLessThanOrEqual(60);

        const audio = runToolBuffer('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'error',
            '-i', outputPath,
            '-map', '0:a:0',
            '-f', 'f32le',
            '-ac', '2',
            '-ar', '48000',
            'pipe:1',
        ]);
        const audioView = new Float32Array(
            audio.buffer,
            audio.byteOffset,
            Math.floor(audio.byteLength / 4),
        );
        expect(Array.from(audioView).every((sample) => Math.abs(sample) < 0.000_001))
            .toBe(true);
    }, 60_000);

    it.skipIf(!HEVC_ENCODER_AVAILABLE)(
        'decodes HEVC MOV through a seekable inherited descriptor',
        async () => {
            const sourcePath = join(directory, 'generated-hevc.mov');
            const outputPath = join(directory, 'staged-hevc-output.mp4');
            runTool('ffmpeg', [
                '-hide_banner',
                '-loglevel', 'error',
                '-f', 'lavfi',
                '-i', 'testsrc2=s=64x36:r=30000/1001:d=1',
                '-an',
                '-c:v', 'libx265',
                '-x265-params', 'pools=1:frame-threads=1',
                '-tag:v', 'hvc1',
                '-threads', '1',
                '-y',
                sourcePath,
            ]);
            await createEmptyOutput(outputPath);
            const sourceIdentity = await identityFor(
                sourcePath,
                'video',
                'video:source',
                'source-capability:video',
            );
            const plan = createNodeFfmpegPlanFixture({
                sources: [{
                    ...sourceIdentity,
                    originalName: 'seek-required.mov',
                    mimeType: 'video/quicktime',
                    duration: 1,
                }],
            });
            const sourceResolver = new TestSourceHandleResolver(
                new Map([[sourceIdentity.sourceId, sourcePath]]),
            );
            const outputResolver = new TestOutputHandleResolver(outputPath);
            const executor = new NodeFfmpegResolvedPlanExecutor(
                sourceResolver,
                outputResolver,
            );

            await expect(executor.encode(createEncodeRequest(plan))).resolves.toMatchObject({
                diagnostics: {
                    peakBackendProcesses: 2,
                },
            });
            await expect(new NodeFfprobeMp4Verifier(outputResolver).inspect(
                OUTPUT_CAPABILITY,
            )).resolves.toMatchObject({
                videoCodec: 'h264',
                audioCodec: 'aac',
                videoFrameCount: 5,
            });
        },
        60_000,
    );

    it('revalidates a source after its decoder and cleans every owned handle on change', async () => {
        const sourcePath = join(directory, 'changed-source.mp4');
        const outputPath = join(directory, 'changed-output.mp4');
        runTool('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-i', 'color=c=blue:s=64x36:r=30000/1001:d=1',
            '-an',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-threads', '1',
            '-y',
            sourcePath,
        ]);
        await createEmptyOutput(outputPath);
        const sourceIdentity = await identityFor(
            sourcePath,
            'video',
            'video:source',
            'source-capability:video',
        );
        const plan = createNodeFfmpegPlanFixture({
            sources: [{
                ...sourceIdentity,
                originalName: 'changed.mp4',
                mimeType: 'video/mp4',
                duration: 1,
            }],
        });
        const sourceResolver = new TestSourceHandleResolver(
            new Map([[sourceIdentity.sourceId, sourcePath]]),
            (sourceId, assertion) => {
                if (sourceId === sourceIdentity.sourceId && assertion === 2) {
                    throw new HeadlessRenderError(
                        'SOURCE_CHANGED',
                        'Fixture source changed after decoding.',
                    );
                }
            },
        );
        const outputResolver = new TestOutputHandleResolver(outputPath);
        const executor = new NodeFfmpegResolvedPlanExecutor(
            sourceResolver,
            outputResolver,
        );

        await expect(executor.encode(createEncodeRequest(plan))).rejects.toMatchObject({
            code: 'SOURCE_CHANGED',
        });
        expect(sourceResolver.activeHandles).toBe(0);
        expect(outputResolver.activeHandles).toBe(0);
    }, 60_000);

    it('fails closed before source acquisition when staged output already has bytes', async () => {
        const outputPath = join(directory, 'nonempty-output.mp4');
        await writeFile(outputPath, Buffer.from('not empty'), { mode: 0o600 });
        const plan = createNodeFfmpegPlanFixture();
        const sourceResolver = new TestSourceHandleResolver(new Map());
        const outputResolver = new TestOutputHandleResolver(outputPath);
        const executor = new NodeFfmpegResolvedPlanExecutor(
            sourceResolver,
            outputResolver,
        );

        await expect(executor.encode(createEncodeRequest(plan))).rejects.toMatchObject({
            code: 'INVALID_OUTPUT',
        });
        expect(sourceResolver.activeHandles).toBe(0);
        expect(outputResolver.activeHandles).toBe(0);
        expect((await stat(outputPath)).size).toBe('not empty'.length);
    });

    it('preserves native/seconds contributor placement, fades, gain, and limiter in PCM scratch', async () => {
        const sourcePath = join(directory, 'constant-audio.wav');
        runTool('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-i', 'aevalsrc=0.5:s=48000:d=1',
            '-ac', '1',
            '-c:a', 'pcm_f32le',
            '-y',
            sourcePath,
        ]);
        const audioIdentity = await identityFor(
            sourcePath,
            'audio',
            'audio:source',
            'source-capability:audio',
        );
        const base = createNodeFfmpegPlanFixture();
        const plan = createNodeFfmpegPlanFixture({
            sources: [
                ...base.sources,
                {
                    ...audioIdentity,
                    originalName: 'constant.wav',
                    mimeType: 'audio/wav',
                    duration: 1,
                },
            ],
            audioMixPlan: {
                sampleRate: 48_000,
                totalSampleCount: base.outputEndSample,
                videoSampleCount: base.outputEndSample,
                contributors: [
                    {
                        id: 'seconds',
                        kind: 'independent-audio',
                        trackId: 'audio',
                        source: {
                            kind: 'audio-source',
                            audioSourceId: audioIdentity.sourceId,
                        },
                        outputStartSample: 0,
                        outputEndSample: 4_800,
                        sourceRange: {
                            domain: 'seconds',
                            startSeconds: 0,
                            endSeconds: 0.1,
                        },
                        fadeInSamples: 100,
                        fadeOutSamples: 100,
                        gainLinear: 2,
                    },
                    {
                        id: 'native',
                        kind: 'independent-audio',
                        trackId: 'audio',
                        source: {
                            kind: 'audio-source',
                            audioSourceId: audioIdentity.sourceId,
                        },
                        outputStartSample: 2_400,
                        outputEndSample: 7_200,
                        sourceRange: {
                            domain: 'native-samples',
                            startSample: 0,
                            endSample: 4_800,
                            sampleRate: 48_000,
                        },
                        fadeInSamples: 0,
                        fadeOutSamples: 0,
                        gainLinear: 2,
                    },
                ],
            },
        });
        const sourceResolver = new TestSourceHandleResolver(
            new Map([
                ['video:source', join(directory, 'unused-video')],
                [audioIdentity.sourceId, sourcePath],
            ]),
        );
        const result = await materializeCanonicalAudio({
            plan,
            mediaSources: createMediaSources(plan),
            sourceHandles: sourceResolver,
            processes: new NodeBoundedFfmpegProcessRunner(),
            tracker: new NodeBackendProcessTracker(1, 512 * 1024 * 1024),
            ffmpegExecutable: 'ffmpeg',
            ffprobeExecutable: 'ffprobe',
            processLimits: {
                maximumProcesses: 1,
                maximumResidentBytes: 512 * 1024 * 1024,
                maximumStderrBytes: 1024 * 1024,
                maximumProgressBytes: 1024,
                timeoutMs: 30_000,
                killGraceMs: 1_000,
            },
            maximumAudioMixBytes: 1024 * 1024,
            maximumScratchBytes: 1024 * 1024,
        });
        try {
            const bytes = Buffer.alloc(result.scratch.byteLength);
            expect(readSync(
                result.scratch.fileDescriptor,
                bytes,
                0,
                bytes.length,
                0,
            )).toBe(bytes.length);
            const samples = new Float32Array(
                bytes.buffer,
                bytes.byteOffset,
                bytes.byteLength / 4,
            );
            const leftAt = (sample: number) => samples[sample * 2];
            expect(leftAt(0)).toBeCloseTo(0.005, 5);
            expect(leftAt(1_000)).toBeCloseTo(0.999, 5);
            expect(leftAt(2_400)).toBeCloseTo(0.999, 5);
            expect(leftAt(5_000)).toBeCloseTo(0.999, 5);
            expect(leftAt(7_500)).toBe(0);
            expect(result.sourceRangesRead).toEqual([{
                sourceId: audioIdentity.sourceId,
                sourceKind: 'audio',
                kind: 'audio-output-samples',
                start: 0,
                end: 7_200,
            }]);
            expect(sourceResolver.activeHandles).toBe(0);
        } finally {
            await result.scratch.close();
        }
    }, 60_000);
});

function createEncodeRequest(plan: ReturnType<typeof createNodeFfmpegPlanFixture>) {
    return {
        jobId: 'job:integration',
        plan,
        outputCapability: OUTPUT_CAPABILITY,
        mediaSources: createMediaSources(plan),
        resourceReservation: {
            authority: 'process-wide-decoded-memory-v1' as const,
            reservationId: 'reservation:integration',
            granted: {
                'audio-mix-bytes': 1024 * 1024,
                'backend-processes': 2,
                'canvas-frames': 1,
                'decoded-pixel-bytes': 1024 * 1024,
                'export-jobs': 1,
                'video-decoder-sessions': 1,
            },
        },
        videoPixelFormat: 'rgba' as const,
        audioSampleFormat: 'f32le-stereo-48000' as const,
        container: 'mp4' as const,
        videoCodec: 'h264' as const,
        audioCodec: 'aac' as const,
        maximumReadChunkBytes: 1024 * 1024,
        maximumCanvasFrames: 1,
        maximumDecoderSessions: 1,
        maximumDecodedPixelBytes: 1024 * 1024,
        maximumAudioMixBytes: 1024 * 1024,
        maximumBackendProcesses: 2,
        maximumScratchBytes: 1024 * 1024,
        maximumBackendResidentBytes: 1024 * 1024 * 1024,
        maximumStderrBytes: 1024 * 1024,
        maximumProgressBytes: 1024 * 1024,
        processTimeoutMs: 30_000,
        processKillGraceMs: 1_000,
    };
}

function createMediaSources(plan: ReturnType<typeof createNodeFfmpegPlanFixture>) {
    return {
        snapshotId: plan.sourceSnapshotId,
        identities: plan.sources,
        get(kind: HeadlessMediaIdentity['kind'], sourceId: string) {
            const identity = plan.sources.find((candidate) => (
                candidate.kind === kind && candidate.sourceId === sourceId
            ));
            if (!identity) throw new Error('Unknown integration source.');
            return {
                identity,
                capabilityId: identity.byteSourceCapabilityId,
                size: async () => identity.size,
                read: async () => new Uint8Array(),
                stream: () => new ReadableStream<Uint8Array>(),
                verify: async () => identity,
                close: async () => undefined,
            };
        },
        close: async () => undefined,
    };
}

class TestSourceHandleResolver implements ImmutableSourceHandleResolverPort {
    activeHandles = 0;
    peakActiveHandles = 0;
    private readonly assertions = new Map<string, number>();

    constructor(
        private readonly paths: ReadonlyMap<string, string>,
        private readonly onAssert?: (sourceId: string, assertion: number) => void,
    ) {}

    async acquire(
        _mediaSources: Parameters<ImmutableSourceHandleResolverPort['acquire']>[0],
        expectedIdentity: HeadlessMediaIdentity,
    ): Promise<AcquiredImmutableSourceHandle> {
        const path = this.paths.get(expectedIdentity.sourceId);
        if (!path) throw new Error('The integration source path is unavailable.');
        const handle = await open(path, constants.O_RDONLY);
        const initial = await handle.stat();
        this.activeHandles += 1;
        this.peakActiveHandles = Math.max(this.peakActiveHandles, this.activeHandles);
        let closed = false;
        return {
            identity: expectedIdentity,
            fileDescriptor: handle.fd,
            assertCurrent: async () => {
                await assertFileCurrent(handle, initial);
                const assertion = (this.assertions.get(expectedIdentity.sourceId) ?? 0) + 1;
                this.assertions.set(expectedIdentity.sourceId, assertion);
                this.onAssert?.(expectedIdentity.sourceId, assertion);
            },
            close: async () => {
                if (closed) return;
                closed = true;
                this.activeHandles -= 1;
                await handle.close();
            },
        };
    }
}

class TestOutputHandleResolver implements NodeStagedOutputHandleResolverPort {
    activeHandles = 0;

    constructor(private readonly outputPath: string) {}

    async acquire(
        outputCapability: HeadlessStagedOutputCapability,
        access: 'read-only' | 'read-write',
    ): Promise<AcquiredNodeStagedOutputHandle> {
        const handle = await open(
            this.outputPath,
            access === 'read-write' ? constants.O_RDWR : constants.O_RDONLY,
        );
        const initial = await handle.stat();
        this.activeHandles += 1;
        let closed = false;
        return {
            outputCapability,
            fileDescriptor: handle.fd,
            access,
            size: async () => (await handle.stat()).size,
            assertCurrent: async () => assertSameInode(handle, initial),
            sync: async () => handle.sync(),
            close: async () => {
                if (closed) return;
                closed = true;
                this.activeHandles -= 1;
                await handle.close();
            },
        };
    }
}

async function assertFileCurrent(handle: FileHandle, initial: Awaited<ReturnType<FileHandle['stat']>>) {
    const current = await handle.stat();
    if (current.dev !== initial.dev
        || current.ino !== initial.ino
        || current.size !== initial.size
        || current.mtimeMs !== initial.mtimeMs) {
        throw new Error('Integration source changed.');
    }
}

async function assertSameInode(handle: FileHandle, initial: Awaited<ReturnType<FileHandle['stat']>>) {
    const current = await handle.stat();
    if (current.dev !== initial.dev || current.ino !== initial.ino) {
        throw new Error('Integration output inode changed.');
    }
}

async function identityFor(
    path: string,
    kind: 'video' | 'audio',
    sourceId: string,
    byteSourceCapabilityId: string,
): Promise<HeadlessMediaIdentity> {
    const snapshot = await stat(path);
    return {
        sourceId,
        kind,
        byteSourceCapabilityId,
        fingerprint: `fixture:${kind}:${snapshot.size}`,
        size: snapshot.size,
        lastModified: snapshot.mtimeMs,
    };
}

async function createEmptyOutput(path: string): Promise<void> {
    const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
    );
    await handle.close();
}

function toolAvailable(executable: string): boolean {
    return spawnSync(executable, ['-version'], {
        shell: false,
        stdio: 'ignore',
    }).status === 0;
}

function runTool(executable: string, args: readonly string[]): string {
    const result = spawnSync(executable, [...args], {
        shell: false,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new Error(`${executable} failed: ${result.stderr}`);
    }
    return result.stdout;
}

function runToolBuffer(executable: string, args: readonly string[]): Buffer {
    const result = spawnSync(executable, [...args], {
        shell: false,
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new Error(`${executable} failed: ${result.stderr.toString('utf8')}`);
    }
    return result.stdout;
}
