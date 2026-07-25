import { describe, expect, it, vi } from 'vitest';
import {
    BoundedChromiumWebCodecsWorker,
    BoundedFfmpegResolvedPlanExecutor,
    CanonicalResolvedRenderStreamProducer,
    HeadlessRenderError,
    type BoundedChromiumWorkerHostPort,
    type BoundedFfmpegProcessHostPort,
    type RawResolvedRenderStreamProducerPort,
} from '../../../agent-runtime/render';
import { resolveContributorSourceSpan } from '../audio-dsp';
import {
    createResolvedRenderPlan,
    type VerifiedRenderMediaSourceSet,
} from '../render-plan';
import {
    createEmptyDiagnostics,
    createHeadlessRenderSnapshotFixture,
} from './headless-render.test-fixtures';

const OUTPUT_CAPABILITY = {
    version: 1 as const,
    kind: 'create-only-staged-output' as const,
    capabilityId: 'capability:bounded-executor',
    grantId: 'grant:bounded-executor',
    stagingId: 'staging:bounded-executor',
};

function createPlan() {
    const snapshot = createHeadlessRenderSnapshotFixture();
    snapshot.manifest.renderProfile.width = 2;
    snapshot.manifest.renderProfile.height = 2;
    return createResolvedRenderPlan(snapshot);
}

function createMediaSources(): VerifiedRenderMediaSourceSet {
    const plan = createPlan();
    return {
        snapshotId: plan.sourceSnapshotId,
        identities: plan.sources,
        get: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
    };
}

function createReservation(options: {
    decodedPixelBytes: number;
    audioMixBytes: number;
    canvasFrames: number;
    decoderSessions: number;
}) {
    return {
        authority: 'process-wide-decoded-memory-v1' as const,
        reservationId: 'reservation:bounded-executor',
        granted: {
            'audio-mix-bytes': options.audioMixBytes,
            'backend-processes': 1,
            'canvas-frames': options.canvasFrames,
            'decoded-pixel-bytes': options.decodedPixelBytes,
            'export-jobs': 1,
            'video-decoder-sessions': options.decoderSessions,
        },
    };
}

describe('bounded concrete Chromium worker executor', () => {
    it('launches a media-capability-only worker and terminates it after success', async () => {
        const terminate = vi.fn().mockResolvedValue(undefined);
        const writeVideoFrame = vi.fn().mockResolvedValue(undefined);
        const writeAudioChunk = vi.fn().mockResolvedValue(undefined);
        const host: BoundedChromiumWorkerHostPort = {
            probe: vi.fn().mockResolvedValue({
                chromiumAvailable: true,
                webCodecs: true,
                h264Encoder: true,
                aacEncoder: true,
                mp4Muxer: true,
            }),
            launch: vi.fn().mockResolvedValue({
                writeVideoFrame,
                writeAudioChunk,
                finalize: vi.fn().mockResolvedValue({ warnings: [] }),
                cancel: vi.fn().mockResolvedValue(undefined),
                terminate,
                forceTerminate: vi.fn().mockResolvedValue(undefined),
            }),
        };
        const plan = createPlan();
        const streams: RawResolvedRenderStreamProducerPort = {
            produce: vi.fn(async (request) => {
                for (let frame = 0; frame < request.plan.contentEndFrame; frame += 1) {
                    await request.onVideoFrame(frame, new Uint8Array(16));
                }
                for (let start = 0; start < request.plan.outputEndSample; start += 16_384) {
                    const count = Math.min(16_384, request.plan.outputEndSample - start);
                    await request.onAudioChunk(start, new Float32Array(count * 2));
                }
                return {
                    sourceRangesRead: [],
                    diagnostics: createEmptyDiagnostics(),
                };
            }),
        };
        const worker = new BoundedChromiumWebCodecsWorker(host, streams);
        const reservation = createReservation({
            decodedPixelBytes: 1024,
            audioMixBytes: 1024 * 1024,
            canvasFrames: 2,
            decoderSessions: 2,
        });

        await expect(worker.render({
            jobId: 'job_chromium',
            plan,
            outputCapability: OUTPUT_CAPABILITY,
            mediaSources: createMediaSources(),
            resourceReservation: reservation,
            maximumReadChunkBytes: 1024,
            maximumCanvasFrames: 2,
            maximumDecoderSessions: 2,
            maximumDecodedPixelBytes: 1024,
            maximumAudioMixBytes: 1024 * 1024,
        })).resolves.toMatchObject({ diagnostics: createEmptyDiagnostics() });

        expect(host.launch).toHaveBeenCalledWith(expect.objectContaining({
            networkPolicy: 'media-byte-source-only',
            videoCodec: 'h264',
            audioCodec: 'aac',
            maximumCanvasFrames: 2,
            maximumDecoderSessions: 2,
        }), undefined);
        expect(vi.mocked(host.launch).mock.calls[0][0]).not.toHaveProperty('plan');
        expect(writeVideoFrame).toHaveBeenCalledTimes(plan.contentEndFrame);
        expect(writeAudioChunk).toHaveBeenCalled();
        expect(terminate).toHaveBeenCalledOnce();
    });

    it('terminates a crashed worker and rejects an unbounded canvas pool before launch', async () => {
        const terminate = vi.fn(() => new Promise<void>(() => undefined));
        const forceTerminate = vi.fn().mockResolvedValue(undefined);
        const host: BoundedChromiumWorkerHostPort = {
            probe: vi.fn(),
            launch: vi.fn().mockResolvedValue({
                writeVideoFrame: vi.fn(),
                writeAudioChunk: vi.fn(),
                finalize: vi.fn(),
                cancel: vi.fn().mockResolvedValue(undefined),
                terminate,
                forceTerminate,
            }),
        };
        const streams: RawResolvedRenderStreamProducerPort = {
            produce: vi.fn().mockRejectedValue(new Error('worker crashed')),
        };
        const worker = new BoundedChromiumWebCodecsWorker(host, streams, {
            cleanupTimeoutMs: 1,
        });
        const plan = createPlan();
        const base = {
            jobId: 'job_chromium',
            plan,
            outputCapability: OUTPUT_CAPABILITY,
            mediaSources: createMediaSources(),
            resourceReservation: createReservation({
                decodedPixelBytes: 1024,
                audioMixBytes: 1024,
                canvasFrames: 2,
                decoderSessions: 2,
            }),
            maximumReadChunkBytes: 1024,
            maximumCanvasFrames: 2,
            maximumDecoderSessions: 2,
            maximumDecodedPixelBytes: 1024,
            maximumAudioMixBytes: 1024,
        };

        await expect(worker.render(base)).rejects.toThrow('worker crashed');
        expect(terminate).toHaveBeenCalledOnce();
        expect(forceTerminate).toHaveBeenCalledOnce();
        await expect(worker.render({ ...base, maximumCanvasFrames: 3 }))
            .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
        expect(host.launch).toHaveBeenCalledOnce();
    });
});

describe('bounded concrete FFmpeg process executor', () => {
    it('sends only fixed raw frames and mixed PCM to FFmpeg, then closes the process', async () => {
        const plan = createPlan();
        const writeVideoFrame = vi.fn().mockResolvedValue(undefined);
        const writeAudioChunk = vi.fn().mockResolvedValue(undefined);
        const finalize = vi.fn().mockResolvedValue({ warnings: [] });
        const close = vi.fn().mockResolvedValue(undefined);
        const abort = vi.fn().mockResolvedValue(undefined);
        const forceKill = vi.fn().mockResolvedValue(undefined);
        const processes: BoundedFfmpegProcessHostPort = {
            probe: vi.fn().mockResolvedValue({
                ffmpegAvailable: true,
                resolvedPlanVersion: 1,
                h264Encoder: true,
                aacEncoder: true,
                mp4Muxer: true,
            }),
            spawn: vi.fn().mockResolvedValue({
                writeVideoFrame,
                writeAudioChunk,
                finalize,
                abort,
                forceKill,
                close,
            }),
        };
        const streams: RawResolvedRenderStreamProducerPort = {
            produce: vi.fn(async (request) => {
                for (let frame = 0; frame < request.plan.contentEndFrame; frame += 1) {
                    await request.onVideoFrame(frame, new Uint8Array(16));
                }
                for (let start = 0; start < request.plan.outputEndSample; start += 16_384) {
                    const count = Math.min(16_384, request.plan.outputEndSample - start);
                    await request.onAudioChunk(start, new Float32Array(count * 2));
                }
                return {
                    sourceRangesRead: [],
                    diagnostics: createEmptyDiagnostics(),
                };
            }),
        };
        const executor = new BoundedFfmpegResolvedPlanExecutor(processes, streams);

        await expect(executor.encode({
            jobId: 'job_ffmpeg',
            plan,
            outputCapability: OUTPUT_CAPABILITY,
            mediaSources: createMediaSources(),
            resourceReservation: createReservation({
                decodedPixelBytes: 1024,
                audioMixBytes: 1024 * 1024,
                canvasFrames: 2,
                decoderSessions: 1,
            }),
            videoPixelFormat: 'rgba',
            audioSampleFormat: 'f32le-stereo-48000',
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
            maximumReadChunkBytes: 1024,
            maximumCanvasFrames: 2,
            maximumDecoderSessions: 1,
            maximumDecodedPixelBytes: 1024,
            maximumAudioMixBytes: 1024 * 1024,
        })).resolves.toMatchObject({ warnings: [] });

        const spawnRequest = vi.mocked(processes.spawn).mock.calls[0][0];
        expect(spawnRequest).not.toHaveProperty('plan');
        expect(spawnRequest).not.toHaveProperty('manifest');
        expect(spawnRequest).toMatchObject({
            videoPixelFormat: 'rgba',
            audioSampleFormat: 'f32le-stereo-48000',
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
        });
        expect(writeVideoFrame).toHaveBeenCalledTimes(plan.contentEndFrame);
        expect(writeAudioChunk).toHaveBeenCalled();
        expect(finalize).toHaveBeenCalledOnce();
        expect(abort).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
    });

    it('aborts and closes when a producer emits an out-of-order frame', async () => {
        const plan = createPlan();
        const abort = vi.fn(() => new Promise<void>(() => undefined));
        const forceKill = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn().mockResolvedValue(undefined);
        const processes: BoundedFfmpegProcessHostPort = {
            probe: vi.fn(),
            spawn: vi.fn().mockResolvedValue({
                writeVideoFrame: vi.fn(),
                writeAudioChunk: vi.fn(),
                finalize: vi.fn(),
                abort,
                forceKill,
                close,
            }),
        };
        const streams: RawResolvedRenderStreamProducerPort = {
            produce: vi.fn(async (request) => {
                await request.onVideoFrame(1, new Uint8Array(16));
                return {
                    sourceRangesRead: [],
                    diagnostics: createEmptyDiagnostics(),
                };
            }),
        };
        const executor = new BoundedFfmpegResolvedPlanExecutor(processes, streams, {
            cleanupTimeoutMs: 1,
        });

        await expect(executor.encode({
            jobId: 'job_ffmpeg',
            plan,
            outputCapability: OUTPUT_CAPABILITY,
            mediaSources: createMediaSources(),
            resourceReservation: createReservation({
                decodedPixelBytes: 1024,
                audioMixBytes: 1024,
                canvasFrames: 2,
                decoderSessions: 1,
            }),
            videoPixelFormat: 'rgba',
            audioSampleFormat: 'f32le-stereo-48000',
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
            maximumReadChunkBytes: 1024,
            maximumCanvasFrames: 2,
            maximumDecoderSessions: 1,
            maximumDecodedPixelBytes: 1024,
            maximumAudioMixBytes: 1024,
        })).rejects.toBeInstanceOf(HeadlessRenderError);
        expect(abort).toHaveBeenCalledOnce();
        expect(forceKill).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    });
});

describe('canonical resolved raw stream producer', () => {
    it('uses the shared DSP for gain/fades and emits explicit silence through the subtitle tail', async () => {
        const plan = createResolvedRenderPlan(createHeadlessRenderSnapshotFixture());
        const chunks: Array<{ start: number; pcm: Float32Array }> = [];
        const producer = new CanonicalResolvedRenderStreamProducer(
            {
                renderFrame: vi.fn(async ({ videoFrame }) => ({
                    rgba: new Uint8Array(plan.renderProfile.width * plan.renderProfile.height * 4),
                    sourceRangesRead: videoFrame ? [{
                        sourceId: videoFrame.sourceId,
                        sourceKind: 'video' as const,
                        kind: 'video-seconds' as const,
                        start: videoFrame.sourceTimeSeconds,
                        end: videoFrame.sourceTimeSeconds + 1 / 30,
                    }] : [],
                    decodedPixelBytes: plan.renderProfile.width * plan.renderProfile.height * 4,
                    videoDecoderSessions: 1,
                    canvasFrames: 1,
                })),
            },
            {
                decode: vi.fn(async ({ contributor, window }) => {
                    const [start, end] = resolveContributorSourceSpan(contributor, 48_000);
                    const startSample = Math.floor(start);
                    const sourceKind = contributor.source.kind === 'audio-source'
                        ? 'audio' as const
                        : 'video' as const;
                    const sourceId = contributor.source.kind === 'audio-source'
                        ? contributor.source.audioSourceId
                        : contributor.source.videoSourceId;
                    return {
                        audio: {
                            sampleRate: 48_000,
                            startSample,
                            channels: [
                                new Float32Array(Math.ceil(end) - startSample + 1).fill(1),
                            ],
                        },
                        sourceRangesRead: [{
                            sourceId,
                            sourceKind,
                            kind: 'audio-output-samples' as const,
                            start: window.outputStartSample,
                            end: window.outputEndSample,
                        }],
                    };
                }),
            },
        );

        const result = await producer.produce({
            plan,
            mediaSources: createMediaSources(),
            resourceReservation: createReservation({
                decodedPixelBytes: 1024 * 1024,
                audioMixBytes: 1024 * 1024,
                canvasFrames: 2,
                decoderSessions: 1,
            }),
            maximumReadChunkBytes: 1024,
            maximumCanvasFrames: 2,
            maximumDecoderSessions: 1,
            maximumDecodedPixelBytes: 1024 * 1024,
            maximumAudioMixBytes: 1024 * 1024,
            onVideoFrame: vi.fn().mockResolvedValue(undefined),
            onAudioChunk: async (start, pcm) => {
                chunks.push({ start, pcm: pcm.slice() });
            },
        });
        const sampleAt = (sample: number) => {
            const chunk = chunks.find((item) => (
                sample >= item.start && sample < item.start + item.pcm.length / 2
            ));
            if (!chunk) throw new Error(`Missing sample ${sample}.`);
            return chunk.pcm[(sample - chunk.start) * 2];
        };

        expect(sampleAt(0)).toBeCloseTo((0.5 / 3_200) * 10 ** (-2 / 20), 8);
        expect(sampleAt(4_000)).toBeCloseTo(10 ** (-2 / 20), 7);
        expect(sampleAt(120_000)).toBe(0);
        expect(sampleAt(128_000)).toBeCloseTo((0.5 / 3_000) * 10 ** (-4 / 20), 8);
        expect(sampleAt(180_000)).toBe(0);
        expect(result.diagnostics).toMatchObject({
            peakVideoDecoderSessions: 1,
            canvasFrames: 1,
        });
        expect(result.diagnostics.peakAudioMixBytes).toBeLessThanOrEqual(1024 * 1024);
        expect(result.sourceRangesRead).toHaveLength(4);
        const redVideoRange = result.sourceRangesRead.find((range) => (
            range.sourceId === 'video-red' && range.kind === 'video-seconds'
        ));
        expect(redVideoRange).toMatchObject({
            sourceId: 'video-red',
            sourceKind: 'video',
            kind: 'video-seconds',
            start: 0,
        });
        expect(redVideoRange?.end).toBeCloseTo(1.5, 12);
    });
});
