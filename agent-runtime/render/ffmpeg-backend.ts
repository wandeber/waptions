import {
    acquireVerifiedRenderMediaSources,
    type RenderMediaByteSourcePort,
    type ResolvedRenderPlanV1,
    type VerifiedRenderMediaSourceSet,
} from '../../src/lib/render-plan';
import {
    HeadlessRenderError,
    normalizeHeadlessRenderError,
    throwIfAborted,
    type HeadlessRenderBackendCapability,
    type HeadlessRenderBackendDiagnostics,
    type HeadlessRenderBackendPort,
    type HeadlessRenderBackendProgress,
    type HeadlessRenderBackendRequest,
    type HeadlessRenderBackendResult,
    type HeadlessRenderResourceBudgetPort,
    type HeadlessRenderResourceReservation,
    type HeadlessSourceRangeRead,
} from './contracts';
import { validateDiagnostics, validateSourceRanges } from './chromium-backend';
import {
    assertResourceReservation,
    getBackendResourceRequest,
} from './resource-budget';

export interface FfmpegCapabilityProbe {
    ffmpegAvailable: boolean;
    resolvedPlanVersion: 1;
    h264Encoder: boolean;
    aacEncoder: boolean;
    mp4Muxer: boolean;
    reason?: string;
}

export interface FfmpegResolvedPlanResult {
    warnings?: string[];
    sourceRangesRead: HeadlessSourceRangeRead[];
    diagnostics: HeadlessRenderBackendDiagnostics;
}

/**
 * FFmpeg is a codec/container fallback, not a second timeline renderer.
 *
 * Implementations consume raw composed frames and canonical stereo PCM derived from this resolved
 * plan. The port intentionally receives no V4 manifest, stores, or coordinator mutation surface.
 */
export interface FfmpegResolvedPlanExecutorPort {
    probe(signal?: AbortSignal): Promise<FfmpegCapabilityProbe>;
    encode(request: {
        jobId: string;
        plan: ResolvedRenderPlanV1;
        outputCapability: import('./contracts').HeadlessStagedOutputCapability;
        mediaSources: VerifiedRenderMediaSourceSet;
        resourceReservation: HeadlessRenderResourceReservation;
        videoPixelFormat: 'rgba';
        audioSampleFormat: 'f32le-stereo-48000';
        container: 'mp4';
        videoCodec: 'h264';
        audioCodec: 'aac';
        maximumReadChunkBytes: number;
        maximumCanvasFrames: number;
        maximumDecoderSessions: number;
        maximumDecodedPixelBytes: number;
        maximumAudioMixBytes: number;
        signal?: AbortSignal;
        onProgress?: (progress: HeadlessRenderBackendProgress) => void;
    }): Promise<FfmpegResolvedPlanResult>;
}

export class FfmpegResolvedPlanRenderBackend implements HeadlessRenderBackendPort {
    readonly name = 'ffmpeg' as const;

    constructor(
        private readonly executor: FfmpegResolvedPlanExecutorPort,
        private readonly budget: HeadlessRenderResourceBudgetPort,
        private readonly media: RenderMediaByteSourcePort,
    ) {
        if (budget.authority !== 'process-wide-decoded-memory-v1') {
            throw new Error('FFmpeg export requires the process-wide decoded-memory authority.');
        }
    }

    async probe(
        _plan: ResolvedRenderPlanV1,
        signal?: AbortSignal,
    ): Promise<HeadlessRenderBackendCapability> {
        throwIfAborted(signal);
        const capability = await this.executor.probe(signal);
        throwIfAborted(signal);
        const supported = capability.ffmpegAvailable
            && capability.resolvedPlanVersion === 1
            && capability.h264Encoder
            && capability.aacEncoder
            && capability.mp4Muxer;
        return {
            supported,
            backend: this.name,
            resolvedPlanVersion: 1,
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
            reason: supported ? undefined : capability.reason ?? 'FFmpeg H.264/AAC MP4 support is incomplete.',
        };
    }

    async render(request: HeadlessRenderBackendRequest): Promise<HeadlessRenderBackendResult> {
        throwIfAborted(request.signal);
        const resourceRequest = getBackendResourceRequest(
            request.plan,
            this.name,
            request.limits,
        );
        const lease = await this.budget.acquire(
            `${request.jobId}:${this.name}`,
            resourceRequest,
            request.signal,
        );
        let mediaSources: VerifiedRenderMediaSourceSet | null = null;
        try {
            assertResourceReservation(lease.reservation, resourceRequest);
            mediaSources = await acquireVerifiedRenderMediaSources(
                this.media,
                request.plan.sourceSnapshotId,
                request.plan.sources,
                request.limits.maxReadChunkBytes,
                request.signal,
            );
            const result = await this.executor.encode({
                jobId: request.jobId,
                plan: request.plan,
                outputCapability: request.outputCapability,
                mediaSources,
                resourceReservation: lease.reservation,
                videoPixelFormat: 'rgba',
                audioSampleFormat: 'f32le-stereo-48000',
                container: 'mp4',
                videoCodec: 'h264',
                audioCodec: 'aac',
                maximumReadChunkBytes: request.limits.maxReadChunkBytes,
                maximumCanvasFrames: resourceRequest['canvas-frames'] ?? 0,
                maximumDecoderSessions: resourceRequest['video-decoder-sessions'] ?? 0,
                maximumDecodedPixelBytes: resourceRequest['decoded-pixel-bytes'] ?? 0,
                maximumAudioMixBytes: resourceRequest['audio-mix-bytes'] ?? 0,
                signal: request.signal,
                onProgress: (progress) => request.onProgress?.({
                    ...progress,
                    backend: this.name,
                }),
            });
            throwIfAborted(request.signal);
            validateDiagnostics({
                limits: {
                    ...request.limits,
                    maxVideoDecoderSessions: Math.min(
                        1,
                        request.limits.maxVideoDecoderSessions,
                    ),
                },
            }, result.diagnostics);
            validateSourceRanges(request.plan, result.sourceRangesRead);
            return {
                backend: this.name,
                warnings: result.warnings ?? [],
                sourceRangesRead: result.sourceRangesRead,
                diagnostics: result.diagnostics,
            };
        } catch (error) {
            throw normalizeHeadlessRenderError(error);
        } finally {
            try {
                await mediaSources?.close();
            } finally {
                lease.release();
            }
        }
    }
}

export function assertFfmpegResolvedPlanOnly(
    value: unknown,
): asserts value is ResolvedRenderPlanV1 {
    if (!value || typeof value !== 'object'
        || (value as { version?: unknown }).version !== 1
        || 'manifest' in value
        || 'document' in value) {
        throw new HeadlessRenderError(
            'INVALID_SNAPSHOT',
            'FFmpeg accepts only a resolved render plan.',
        );
    }
}
