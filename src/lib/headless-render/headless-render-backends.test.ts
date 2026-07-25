import { describe, expect, it, vi } from 'vitest';
import {
    BoundedHeadlessRenderBackendSelector,
    ChromiumWebCodecsRenderBackend,
    FfmpegResolvedPlanRenderBackend,
    HeadlessRenderError,
    assertFfmpegResolvedPlanOnly,
    type ChromiumWebCodecsWorkerPort,
    type FfmpegResolvedPlanExecutorPort,
    type HeadlessRenderBackendRequest,
    type HeadlessRenderResourceBudgetPort,
    type HeadlessRenderResourceBudgetSnapshot,
    type HeadlessRenderResourceKind,
    type HeadlessRenderResourceRequest,
} from '../../../agent-runtime/render';
import {
    DEFAULT_HEADLESS_RENDER_LIMITS,
} from '../../../agent-runtime/render/contracts';
import {
    createResolvedRenderPlan,
    type RenderMediaByteSourcePort,
} from '../render-plan';
import {
    createEmptyDiagnostics,
    createHeadlessRenderSnapshotFixture,
} from './headless-render.test-fixtures';

function createBudget(overrides: Partial<Record<HeadlessRenderResourceKind, number>> = {}) {
    return new FakeProcessWideBudget(overrides);
}

function createMediaPort(): RenderMediaByteSourcePort & {
    close: ReturnType<typeof vi.fn>;
} {
    const close = vi.fn().mockResolvedValue(undefined);
    return {
        acquire: vi.fn(async (_snapshotId, identity) => ({
            identity,
            capabilityId: identity.byteSourceCapabilityId,
            size: vi.fn().mockResolvedValue(identity.size),
            read: vi.fn(async (range) => new Uint8Array(range.endExclusive - range.start)),
            stream: vi.fn((range) => new ReadableStream<Uint8Array>({
                start(controller) {
                    const length = (range?.endExclusive ?? identity.size) - (range?.start ?? 0);
                    controller.enqueue(new Uint8Array(length));
                    controller.close();
                },
            })),
            verify: vi.fn().mockResolvedValue(identity),
            close,
        })),
        close,
    };
}

function createRequest(): HeadlessRenderBackendRequest {
    return {
        jobId: 'job_backend',
        plan: createResolvedRenderPlan(createHeadlessRenderSnapshotFixture()),
        outputCapability: {
            version: 1,
            kind: 'create-only-staged-output',
            capabilityId: 'capability:test-output',
            grantId: 'grant:test-output',
            stagingId: 'staging:test-output',
        },
        limits: DEFAULT_HEADLESS_RENDER_LIMITS,
    };
}

describe('headless render resource budget', () => {
    it('acquires atomically, records peaks, and releases idempotently', async () => {
        const budget = createBudget();
        const lease = await budget.acquire('first', {
            'export-jobs': 1,
            'canvas-frames': 2,
        });

        await expect(budget.acquire('second', { 'export-jobs': 1 }))
            .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
        expect(budget.snapshot().current).toMatchObject({
            'export-jobs': 1,
            'canvas-frames': 2,
        });
        lease.release();
        lease.release();
        expect(budget.snapshot().current).toMatchObject({
            'export-jobs': 0,
            'canvas-frames': 0,
        });
        expect(budget.snapshot().peak).toMatchObject({
            'export-jobs': 1,
            'canvas-frames': 2,
        });
    });
});

class FakeProcessWideBudget implements HeadlessRenderResourceBudgetPort {
    readonly authority = 'process-wide-decoded-memory-v1' as const;
    private readonly limits: Record<HeadlessRenderResourceKind, number> = {
        'audio-mix-bytes': DEFAULT_HEADLESS_RENDER_LIMITS.maxAudioMixBytes,
        'backend-processes': DEFAULT_HEADLESS_RENDER_LIMITS.maxBackendProcesses,
        'canvas-frames': DEFAULT_HEADLESS_RENDER_LIMITS.maxCanvasFrames,
        'decoded-pixel-bytes': DEFAULT_HEADLESS_RENDER_LIMITS.maxDecodedPixelBytes,
        'export-jobs': DEFAULT_HEADLESS_RENDER_LIMITS.maxConcurrentExports,
        'video-decoder-sessions': DEFAULT_HEADLESS_RENDER_LIMITS.maxVideoDecoderSessions,
    };
    private readonly current = zeroResources();
    private readonly peak = zeroResources();

    constructor(overrides: Partial<Record<HeadlessRenderResourceKind, number>> = {}) {
        Object.assign(this.limits, overrides);
    }

    async acquire(
        ownerId: string,
        request: HeadlessRenderResourceRequest,
        signal?: AbortSignal,
    ) {
        if (signal?.aborted) throw new HeadlessRenderError('CANCELLED', 'Cancelled.');
        const normalized = zeroResources();
        (Object.keys(normalized) as HeadlessRenderResourceKind[]).forEach((kind) => {
            normalized[kind] = request[kind] ?? 0;
            if (this.current[kind] + normalized[kind] > this.limits[kind]) {
                throw new HeadlessRenderError('RESOURCE_LIMIT', `Exceeded ${kind}.`);
            }
        });
        (Object.keys(normalized) as HeadlessRenderResourceKind[]).forEach((kind) => {
            this.current[kind] += normalized[kind];
            this.peak[kind] = Math.max(this.peak[kind], this.current[kind]);
        });
        let released = false;
        return {
            reservation: {
                authority: this.authority,
                reservationId: `reservation:${ownerId}`,
                granted: { ...normalized },
            },
            release: () => {
                if (released) return;
                released = true;
                (Object.keys(normalized) as HeadlessRenderResourceKind[]).forEach((kind) => {
                    this.current[kind] -= normalized[kind];
                });
            },
        };
    }

    snapshot(): HeadlessRenderResourceBudgetSnapshot {
        return {
            limits: { ...this.limits },
            current: { ...this.current },
            peak: { ...this.peak },
        };
    }
}

function zeroResources(): Record<HeadlessRenderResourceKind, number> {
    return {
        'audio-mix-bytes': 0,
        'backend-processes': 0,
        'canvas-frames': 0,
        'decoded-pixel-bytes': 0,
        'export-jobs': 0,
        'video-decoder-sessions': 0,
    };
}

describe('bounded Chromium and FFmpeg backends', () => {
    it('passes only the immutable resolved plan and hard limits to Chromium', async () => {
        const budget = createBudget();
        const worker: ChromiumWebCodecsWorkerPort = {
            probe: vi.fn().mockResolvedValue({
                chromiumAvailable: true,
                webCodecs: true,
                h264Encoder: true,
                aacEncoder: true,
                mp4Muxer: true,
            }),
            render: vi.fn().mockImplementation(async (request) => {
                expect(request.plan.version).toBe(1);
                expect('manifest' in request.plan).toBe(false);
                expect(request.maximumCanvasFrames).toBe(2);
                expect(request.maximumDecoderSessions).toBe(2);
                request.onProgress?.({
                    stage: 'video',
                    completedUnits: request.plan.contentEndFrame,
                    totalUnits: request.plan.contentEndFrame,
                });
                return {
                    sourceRangesRead: [{
                        sourceId: 'video-red',
                        sourceKind: 'video' as const,
                        kind: 'video-seconds' as const,
                        start: 0,
                        end: 1.5,
                    }],
                    diagnostics: {
                        peakDecodedPixelBytes: 320 * 180 * 4 * 2,
                        peakAudioMixBytes: 16_384 * 2 * 4,
                        peakVideoDecoderSessions: 2,
                        canvasFrames: 2,
                    },
                };
            }),
        };
        const progress = vi.fn();
        const backend = new ChromiumWebCodecsRenderBackend(worker, budget, createMediaPort());
        const request = { ...createRequest(), onProgress: progress };

        expect(await backend.probe(request.plan)).toMatchObject({ supported: true });
        await expect(backend.render(request)).resolves.toMatchObject({
            backend: 'chromium-webcodecs',
        });
        expect(progress).toHaveBeenCalledWith(expect.objectContaining({
            backend: 'chromium-webcodecs',
            stage: 'video',
        }));
        expect(budget.snapshot().current).toEqual(expect.objectContaining({
            'export-jobs': 0,
            'decoded-pixel-bytes': 0,
        }));
    });

    it('uses FFmpeg only as a raw resolved-plan H.264/AAC encoder', async () => {
        const budget = createBudget();
        const executor: FfmpegResolvedPlanExecutorPort = {
            probe: vi.fn().mockResolvedValue({
                ffmpegAvailable: true,
                resolvedPlanVersion: 1,
                h264Encoder: true,
                aacEncoder: true,
                mp4Muxer: true,
            }),
            encode: vi.fn().mockImplementation(async (request) => {
                assertFfmpegResolvedPlanOnly(request.plan);
                expect(request).toMatchObject({
                    videoPixelFormat: 'rgba',
                    audioSampleFormat: 'f32le-stereo-48000',
                    container: 'mp4',
                    videoCodec: 'h264',
                    audioCodec: 'aac',
                });
                return {
                    sourceRangesRead: [],
                    diagnostics: createEmptyDiagnostics(),
                };
            }),
        };
        const backend = new FfmpegResolvedPlanRenderBackend(executor, budget, createMediaPort());

        await expect(backend.render(createRequest())).resolves.toMatchObject({
            backend: 'ffmpeg',
        });
        expect(executor.encode).toHaveBeenCalledTimes(1);
    });

    it('falls back once after a retryable Chromium codec failure and resets partial output', async () => {
        const budget = createBudget();
        const primaryWorker: ChromiumWebCodecsWorkerPort = {
            probe: vi.fn().mockResolvedValue({
                chromiumAvailable: true,
                webCodecs: true,
                h264Encoder: true,
                aacEncoder: true,
                mp4Muxer: true,
            }),
            render: vi.fn().mockRejectedValue(new HeadlessRenderError(
                'CODEC_UNAVAILABLE',
                'H.264 initialization failed.',
            )),
        };
        const fallbackExecutor: FfmpegResolvedPlanExecutorPort = {
            probe: vi.fn().mockResolvedValue({
                ffmpegAvailable: true,
                resolvedPlanVersion: 1,
                h264Encoder: true,
                aacEncoder: true,
                mp4Muxer: true,
            }),
            encode: vi.fn().mockResolvedValue({
                warnings: [],
                sourceRangesRead: [],
                diagnostics: createEmptyDiagnostics(),
            }),
        };
        const selector = new BoundedHeadlessRenderBackendSelector(
            new ChromiumWebCodecsRenderBackend(primaryWorker, budget, createMediaPort()),
            new FfmpegResolvedPlanRenderBackend(fallbackExecutor, budget, createMediaPort()),
        );
        const reset = vi.fn().mockResolvedValue(undefined);

        await expect(selector.render({
            ...createRequest(),
            resetOutputForFallback: reset,
        })).resolves.toMatchObject({
            backend: 'ffmpeg',
            warnings: [expect.stringMatching(/Chromium fallback/)],
        });
        expect(reset).toHaveBeenCalledOnce();
        expect(fallbackExecutor.encode).toHaveBeenCalledOnce();
    });

    it('never falls back for cancellation, source changes, or resource-limit failures', async () => {
        for (const code of ['CANCELLED', 'SOURCE_CHANGED', 'RESOURCE_LIMIT'] as const) {
            const budget = createBudget();
            const worker: ChromiumWebCodecsWorkerPort = {
                probe: vi.fn().mockResolvedValue({
                    chromiumAvailable: true,
                    webCodecs: true,
                    h264Encoder: true,
                    aacEncoder: true,
                    mp4Muxer: true,
                }),
                render: vi.fn().mockRejectedValue(new HeadlessRenderError(code, code)),
            };
            const executor: FfmpegResolvedPlanExecutorPort = {
                probe: vi.fn(),
                encode: vi.fn(),
            };
            const selector = new BoundedHeadlessRenderBackendSelector(
                new ChromiumWebCodecsRenderBackend(worker, budget, createMediaPort()),
                new FfmpegResolvedPlanRenderBackend(executor, budget, createMediaPort()),
            );

            await expect(selector.render({
                ...createRequest(),
                resetOutputForFallback: vi.fn(),
            })).rejects.toMatchObject({ code });
            expect(executor.probe).not.toHaveBeenCalled();
            expect(executor.encode).not.toHaveBeenCalled();
        }
    });

    it('releases every resource lease when an executor crashes or aborts', async () => {
        const budget = createBudget();
        const media = createMediaPort();
        const worker: ChromiumWebCodecsWorkerPort = {
            probe: vi.fn(),
            render: vi.fn().mockRejectedValue(new Error('worker crashed')),
        };
        const backend = new ChromiumWebCodecsRenderBackend(worker, budget, media);

        await expect(backend.render(createRequest())).rejects.toMatchObject({
            code: 'RENDER_FAILED',
        });
        expect(Object.values(budget.snapshot().current).every((value) => value === 0)).toBe(true);
        expect(media.close).toHaveBeenCalledTimes(3);
    });

    it('rejects the render against the injected global decoded-memory cap before execution', async () => {
        const budget = createBudget({ 'decoded-pixel-bytes': 320 * 180 * 4 * 2 - 1 });
        const worker: ChromiumWebCodecsWorkerPort = {
            probe: vi.fn(),
            render: vi.fn(),
        };
        const media = createMediaPort();
        const backend = new ChromiumWebCodecsRenderBackend(worker, budget, media);

        await expect(backend.render(createRequest())).rejects.toMatchObject({
            code: 'RESOURCE_LIMIT',
        });
        expect(worker.render).not.toHaveBeenCalled();
        expect(media.acquire).not.toHaveBeenCalled();
        expect(Object.values(budget.snapshot().current).every((value) => value === 0)).toBe(true);
    });

    it('reserves source-resolution decoder frames before rendering a downscaled output', async () => {
        const snapshot = createHeadlessRenderSnapshotFixture();
        snapshot.manifest.videoSourceDescriptors[0].width = 7_680;
        snapshot.manifest.videoSourceDescriptors[0].height = 4_320;
        const worker: ChromiumWebCodecsWorkerPort = {
            probe: vi.fn(),
            render: vi.fn(),
        };
        const media = createMediaPort();
        const backend = new ChromiumWebCodecsRenderBackend(
            worker,
            createBudget(),
            media,
        );

        await expect(backend.render({
            ...createRequest(),
            plan: createResolvedRenderPlan(snapshot),
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
        expect(worker.render).not.toHaveBeenCalled();
        expect(media.acquire).not.toHaveBeenCalled();
    });

    it('caps configurable maxima to the fixed backend pool sizes it actually reserves', async () => {
        const budget = createBudget();
        const worker: ChromiumWebCodecsWorkerPort = {
            probe: vi.fn(),
            render: vi.fn().mockImplementation(async (request) => {
                expect(request.maximumCanvasFrames).toBe(2);
                expect(request.maximumDecoderSessions).toBe(2);
                return {
                    sourceRangesRead: [],
                    diagnostics: createEmptyDiagnostics(),
                };
            }),
        };
        const chromium = new ChromiumWebCodecsRenderBackend(
            worker,
            budget,
            createMediaPort(),
        );
        const executor: FfmpegResolvedPlanExecutorPort = {
            probe: vi.fn(),
            encode: vi.fn().mockImplementation(async (request) => {
                expect(request.maximumCanvasFrames).toBe(2);
                expect(request.maximumDecoderSessions).toBe(1);
                return {
                    sourceRangesRead: [],
                    diagnostics: createEmptyDiagnostics(),
                };
            }),
        };
        const ffmpeg = new FfmpegResolvedPlanRenderBackend(
            executor,
            budget,
            createMediaPort(),
        );
        const request = createRequest();
        request.limits = {
            ...request.limits,
            maxCanvasFrames: 10,
            maxVideoDecoderSessions: 10,
        };

        await expect(chromium.render(request)).resolves.toMatchObject({
            backend: 'chromium-webcodecs',
        });
        await expect(ffmpeg.render(request)).resolves.toMatchObject({
            backend: 'ffmpeg',
        });
    });
});
