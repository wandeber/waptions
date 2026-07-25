import type {
    ResolvedRenderPlanV1,
    VerifiedRenderMediaSourceSet,
} from '../../src/lib/render-plan';
import {
    HeadlessRenderError,
    throwIfAborted,
    type HeadlessRenderBackendDiagnostics,
    type HeadlessRenderBackendProgress,
    type HeadlessRenderResourceReservation,
    type HeadlessSourceRangeRead,
    type HeadlessStagedOutputCapability,
} from './contracts';
import {
    assertFfmpegResolvedPlanOnly,
    type FfmpegCapabilityProbe,
    type FfmpegResolvedPlanExecutorPort,
    type FfmpegResolvedPlanResult,
} from './ffmpeg-backend';

export interface RawResolvedRenderStreamResult {
    sourceRangesRead: HeadlessSourceRangeRead[];
    diagnostics: HeadlessRenderBackendDiagnostics;
}

/**
 * Environment-specific decoder/compositor/audio bridge.
 *
 * Implementations must call the shared frame compositor and canonical DSP/audio mix functions.
 * FFmpeg never receives the plan: this producer emits only already-composed RGBA and mixed PCM.
 */
export interface RawResolvedRenderStreamProducerPort {
    produce(request: {
        plan: ResolvedRenderPlanV1;
        mediaSources: VerifiedRenderMediaSourceSet;
        resourceReservation: HeadlessRenderResourceReservation;
        maximumReadChunkBytes: number;
        maximumCanvasFrames: number;
        maximumDecoderSessions: number;
        maximumDecodedPixelBytes: number;
        maximumAudioMixBytes: number;
        signal?: AbortSignal;
        onVideoFrame(
            frameIndex: number,
            rgba: Uint8Array,
        ): Promise<void>;
        onAudioChunk(
            outputStartSample: number,
            stereoPcm: Float32Array,
        ): Promise<void>;
        onProgress?: (progress: HeadlessRenderBackendProgress) => void;
    }): Promise<RawResolvedRenderStreamResult>;
}

export interface BoundedFfmpegProcessSession {
    writeVideoFrame(
        frameIndex: number,
        rgba: Uint8Array,
        signal?: AbortSignal,
    ): Promise<void>;
    writeAudioChunk(
        outputStartSample: number,
        stereoPcm: Float32Array,
        signal?: AbortSignal,
    ): Promise<void>;
    finalize(signal?: AbortSignal): Promise<{ warnings?: string[] }>;
    abort(reason: string): Promise<void>;
    forceKill(): Promise<void>;
    close(): Promise<void>;
}

export interface BoundedFfmpegProcessHostPort {
    probe(signal?: AbortSignal): Promise<FfmpegCapabilityProbe>;
    spawn(request: {
        jobId: string;
        outputCapability: HeadlessStagedOutputCapability;
        resourceReservation: HeadlessRenderResourceReservation;
        width: number;
        height: number;
        fpsNumerator: number;
        fpsDenominator: number;
        videoPixelFormat: 'rgba';
        audioSampleFormat: 'f32le-stereo-48000';
        container: 'mp4';
        videoCodec: 'h264';
        audioCodec: 'aac';
        signal?: AbortSignal;
    }): Promise<BoundedFfmpegProcessSession>;
}

export interface BoundedFfmpegExecutorOptions {
    cleanupTimeoutMs?: number;
}

/**
 * Concrete bounded FFmpeg process executor.
 *
 * The process receives a fixed H.264/AAC MP4 configuration plus raw composed frames and mixed
 * PCM. It never receives the manifest or resolved plan and therefore cannot reinterpret timeline
 * order, gaps, subtitles, links, fades, gain, rate, mute, solo, or content boundaries.
 */
export class BoundedFfmpegResolvedPlanExecutor implements FfmpegResolvedPlanExecutorPort {
    private active = false;
    private readonly cleanupTimeoutMs: number;

    constructor(
        private readonly processes: BoundedFfmpegProcessHostPort,
        private readonly streams: RawResolvedRenderStreamProducerPort,
        options: BoundedFfmpegExecutorOptions = {},
    ) {
        this.cleanupTimeoutMs = validateCleanupTimeout(options.cleanupTimeoutMs ?? 5_000);
    }

    probe(signal?: AbortSignal): Promise<FfmpegCapabilityProbe> {
        return this.processes.probe(signal);
    }

    async encode(request: {
        jobId: string;
        plan: ResolvedRenderPlanV1;
        outputCapability: HeadlessStagedOutputCapability;
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
    }): Promise<FfmpegResolvedPlanResult> {
        if (this.active) {
            throw new HeadlessRenderError(
                'RESOURCE_LIMIT',
                'The FFmpeg executor already has an active process.',
            );
        }
        assertFfmpegResolvedPlanOnly(request.plan);
        assertFixedFfmpegRequest(request);
        throwIfAborted(request.signal);
        this.active = true;
        let process: BoundedFfmpegProcessSession | null = null;
        let terminal = false;
        let abortPromise: Promise<void> | null = null;
        const abortProcess = (reason: string) => {
            if (!process || abortPromise) return;
            abortPromise = process.abort(reason).catch(() => undefined);
        };
        const abort = () => abortProcess('abort-signal');
        request.signal?.addEventListener('abort', abort, { once: true });
        try {
            process = await this.processes.spawn({
                jobId: request.jobId,
                outputCapability: request.outputCapability,
                resourceReservation: request.resourceReservation,
                width: request.plan.renderProfile.width,
                height: request.plan.renderProfile.height,
                fpsNumerator: request.plan.renderProfile.fps.numerator,
                fpsDenominator: request.plan.renderProfile.fps.denominator,
                videoPixelFormat: 'rgba',
                audioSampleFormat: 'f32le-stereo-48000',
                container: 'mp4',
                videoCodec: 'h264',
                audioCodec: 'aac',
                signal: request.signal,
            });
            const expectedFrameBytes = checkedFrameBytes(request.plan);
            let nextFrame = 0;
            let nextSample = 0;
            const streamResult = await this.streams.produce({
                plan: request.plan,
                mediaSources: request.mediaSources,
                resourceReservation: request.resourceReservation,
                maximumReadChunkBytes: request.maximumReadChunkBytes,
                maximumCanvasFrames: request.maximumCanvasFrames,
                maximumDecoderSessions: request.maximumDecoderSessions,
                maximumDecodedPixelBytes: request.maximumDecodedPixelBytes,
                maximumAudioMixBytes: request.maximumAudioMixBytes,
                signal: request.signal,
                onVideoFrame: async (frameIndex, rgba) => {
                    throwIfAborted(request.signal);
                    if (frameIndex !== nextFrame || rgba.byteLength !== expectedFrameBytes) {
                        throw new HeadlessRenderError(
                            'RENDER_FAILED',
                            'The resolved frame stream is incomplete or out of order.',
                        );
                    }
                    await process!.writeVideoFrame(frameIndex, rgba, request.signal);
                    nextFrame += 1;
                },
                onAudioChunk: async (outputStartSample, stereoPcm) => {
                    throwIfAborted(request.signal);
                    const sampleCount = stereoPcm.length / 2;
                    if (outputStartSample !== nextSample
                        || !Number.isSafeInteger(sampleCount)
                        || sampleCount <= 0
                        || stereoPcm.byteLength > request.maximumAudioMixBytes
                        || nextSample + sampleCount > request.plan.outputEndSample) {
                        throw new HeadlessRenderError(
                            'RENDER_FAILED',
                            'The resolved audio stream is incomplete, unbounded, or out of order.',
                        );
                    }
                    await process!.writeAudioChunk(
                        outputStartSample,
                        stereoPcm,
                        request.signal,
                    );
                    nextSample += sampleCount;
                },
                onProgress: request.onProgress,
            });
            if (nextFrame !== request.plan.contentEndFrame
                || nextSample !== request.plan.outputEndSample) {
                throw new HeadlessRenderError(
                    'RENDER_FAILED',
                    'The raw resolved stream did not cover the complete output boundary.',
                );
            }
            const finalization = await process.finalize(request.signal);
            terminal = true;
            return {
                warnings: finalization.warnings,
                sourceRangesRead: streamResult.sourceRangesRead,
                diagnostics: streamResult.diagnostics,
            };
        } finally {
            request.signal?.removeEventListener('abort', abort);
            try {
                if (process && !terminal) {
                    abortProcess('render-failed');
                    if (abortPromise) {
                        const aborted = await settleWithin(
                            abortPromise,
                            this.cleanupTimeoutMs,
                        );
                        if (!aborted) {
                            const killed = await settleWithin(
                                process.forceKill(),
                                this.cleanupTimeoutMs,
                            );
                            if (!killed) {
                                throw new HeadlessRenderError(
                                    'CLEANUP_FAILED',
                                    'FFmpeg did not confirm forced termination.',
                                );
                            }
                        }
                    }
                }
                if (process) {
                    const closed = await settleWithin(
                        process.close(),
                        this.cleanupTimeoutMs,
                    );
                    if (!closed) {
                        const killed = await settleWithin(
                            process.forceKill(),
                            this.cleanupTimeoutMs,
                        );
                        const closedAfterKill = killed && await settleWithin(
                            process.close(),
                            this.cleanupTimeoutMs,
                        );
                        if (!closedAfterKill) {
                            throw new HeadlessRenderError(
                                'CLEANUP_FAILED',
                                'FFmpeg did not confirm process cleanup.',
                            );
                        }
                    }
                }
            } finally {
                this.active = false;
            }
        }
    }
}

function assertFixedFfmpegRequest(request: {
    plan: ResolvedRenderPlanV1;
    mediaSources: VerifiedRenderMediaSourceSet;
    resourceReservation: HeadlessRenderResourceReservation;
    videoPixelFormat: string;
    audioSampleFormat: string;
    container: string;
    videoCodec: string;
    audioCodec: string;
    maximumReadChunkBytes: number;
    maximumCanvasFrames: number;
    maximumDecoderSessions: number;
    maximumDecodedPixelBytes: number;
    maximumAudioMixBytes: number;
}): void {
    if (request.mediaSources.snapshotId !== request.plan.sourceSnapshotId
        || request.resourceReservation.authority !== 'process-wide-decoded-memory-v1'
        || request.resourceReservation.granted['decoded-pixel-bytes']
            !== request.maximumDecodedPixelBytes
        || request.resourceReservation.granted['audio-mix-bytes']
            !== request.maximumAudioMixBytes
        || request.resourceReservation.granted['canvas-frames']
            !== request.maximumCanvasFrames
        || request.resourceReservation.granted['video-decoder-sessions']
            !== request.maximumDecoderSessions
        || request.videoPixelFormat !== 'rgba'
        || request.audioSampleFormat !== 'f32le-stereo-48000'
        || request.container !== 'mp4'
        || request.videoCodec !== 'h264'
        || request.audioCodec !== 'aac'
        || request.maximumCanvasFrames > 2
        || request.maximumDecoderSessions > 1
        || [
            request.maximumReadChunkBytes,
            request.maximumCanvasFrames,
            request.maximumDecoderSessions,
            request.maximumDecodedPixelBytes,
            request.maximumAudioMixBytes,
        ].some((value) => !Number.isSafeInteger(value) || value <= 0)) {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'The FFmpeg process request exceeds the bounded render contract.',
        );
    }
}

function checkedFrameBytes(plan: ResolvedRenderPlanV1): number {
    const bytes = plan.renderProfile.width * plan.renderProfile.height * 4;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
        throw new HeadlessRenderError('RESOURCE_LIMIT', 'The raw RGBA frame size is invalid.');
    }
    return bytes;
}

function validateCleanupTimeout(value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
        throw new RangeError('cleanupTimeoutMs must be between 1 and 60000 milliseconds.');
    }
    return value;
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise.then(() => true, () => false),
            new Promise<false>((resolve) => {
                timeout = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}
