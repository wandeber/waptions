import type {
    ResolvedRenderPlanV1,
    VerifiedRenderMediaSourceSet,
} from '../../src/lib/render-plan';
import {
    HeadlessRenderError,
    throwIfAborted,
    type HeadlessRenderBackendProgress,
    type HeadlessRenderResourceReservation,
    type HeadlessStagedOutputCapability,
} from './contracts';
import type {
    ChromiumWebCodecsCapabilityProbe,
    ChromiumWebCodecsWorkerPort,
    ChromiumWebCodecsWorkerResult,
} from './chromium-backend';
import type { RawResolvedRenderStreamProducerPort } from './bounded-ffmpeg-executor';

export interface BoundedChromiumWorkerLaunch {
    jobId: string;
    outputCapability: HeadlessStagedOutputCapability;
    resourceReservation: HeadlessRenderResourceReservation;
    width: number;
    height: number;
    fpsNumerator: number;
    fpsDenominator: number;
    videoCodec: 'h264';
    audioCodec: 'aac';
    container: 'mp4';
    maximumCanvasFrames: number;
    maximumDecoderSessions: number;
    maximumDecodedPixelBytes: number;
    maximumAudioMixBytes: number;
    maximumReadChunkBytes: number;
    networkPolicy: 'media-byte-source-only';
}

export interface BoundedChromiumWorkerSession {
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
    cancel(reason: string): Promise<void>;
    terminate(): Promise<void>;
    forceTerminate(): Promise<void>;
}

/**
 * Coordinator integration seam that launches the actual isolated Chromium WebCodecs worker.
 *
 * The worker receives fixed codecs and raw composed frames/mixed PCM. It never receives the V4
 * manifest or resolved plan, so it cannot become a second timeline interpretation authority.
 */
export interface BoundedChromiumWorkerHostPort {
    probe(signal?: AbortSignal): Promise<ChromiumWebCodecsCapabilityProbe>;
    launch(
        request: BoundedChromiumWorkerLaunch,
        signal?: AbortSignal,
    ): Promise<BoundedChromiumWorkerSession>;
}

export interface BoundedChromiumWorkerOptions {
    cleanupTimeoutMs?: number;
}

/**
 * Concrete bounded worker executor used by `ChromiumWebCodecsRenderBackend`.
 *
 * It owns canonical stream production, worker launch, cancellation, forced termination, and exact
 * frame/sample coverage. The injected process-wide reservation remains the sole memory authority.
 */
export class BoundedChromiumWebCodecsWorker implements ChromiumWebCodecsWorkerPort {
    private active = false;
    private readonly cleanupTimeoutMs: number;

    constructor(
        private readonly host: BoundedChromiumWorkerHostPort,
        private readonly streams: RawResolvedRenderStreamProducerPort,
        options: BoundedChromiumWorkerOptions = {},
    ) {
        this.cleanupTimeoutMs = validateCleanupTimeout(options.cleanupTimeoutMs ?? 5_000);
    }

    probe(signal?: AbortSignal): Promise<ChromiumWebCodecsCapabilityProbe> {
        return this.host.probe(signal);
    }

    async render(request: {
        jobId: string;
        plan: ResolvedRenderPlanV1;
        outputCapability: HeadlessStagedOutputCapability;
        mediaSources: VerifiedRenderMediaSourceSet;
        resourceReservation: HeadlessRenderResourceReservation;
        maximumReadChunkBytes: number;
        maximumCanvasFrames: number;
        maximumDecoderSessions: number;
        maximumDecodedPixelBytes: number;
        maximumAudioMixBytes: number;
        signal?: AbortSignal;
        onProgress?: (progress: HeadlessRenderBackendProgress) => void;
    }): Promise<ChromiumWebCodecsWorkerResult> {
        if (this.active) {
            throw new HeadlessRenderError(
                'RESOURCE_LIMIT',
                'The Chromium worker executor already has an active render.',
            );
        }
        assertWorkerRequest(request);
        throwIfAborted(request.signal);
        this.active = true;
        let session: BoundedChromiumWorkerSession | null = null;
        let terminal = false;
        let cancelPromise: Promise<void> | null = null;
        const cancelWorker = (reason: string) => {
            if (!session || cancelPromise) return;
            cancelPromise = session.cancel(reason).catch(() => undefined);
        };
        const cancel = () => cancelWorker('abort-signal');
        request.signal?.addEventListener('abort', cancel, { once: true });
        try {
            session = await this.host.launch({
                jobId: request.jobId,
                outputCapability: request.outputCapability,
                resourceReservation: request.resourceReservation,
                width: request.plan.renderProfile.width,
                height: request.plan.renderProfile.height,
                fpsNumerator: request.plan.renderProfile.fps.numerator,
                fpsDenominator: request.plan.renderProfile.fps.denominator,
                videoCodec: 'h264',
                audioCodec: 'aac',
                container: 'mp4',
                maximumCanvasFrames: request.maximumCanvasFrames,
                maximumDecoderSessions: request.maximumDecoderSessions,
                maximumDecodedPixelBytes: request.maximumDecodedPixelBytes,
                maximumAudioMixBytes: request.maximumAudioMixBytes,
                maximumReadChunkBytes: request.maximumReadChunkBytes,
                networkPolicy: 'media-byte-source-only',
            }, request.signal);
            throwIfAborted(request.signal);
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
                            'The Chromium frame stream is incomplete or out of order.',
                        );
                    }
                    await session!.writeVideoFrame(frameIndex, rgba, request.signal);
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
                            'The Chromium audio stream is incomplete, unbounded, or out of order.',
                        );
                    }
                    await session!.writeAudioChunk(
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
                    'The Chromium raw stream did not cover the complete output boundary.',
                );
            }
            const finalization = await session.finalize(request.signal);
            terminal = true;
            return {
                warnings: finalization.warnings,
                sourceRangesRead: streamResult.sourceRangesRead,
                diagnostics: streamResult.diagnostics,
            };
        } finally {
            request.signal?.removeEventListener('abort', cancel);
            try {
                if (session && !terminal) {
                    cancelWorker('render-failed');
                    if (cancelPromise) {
                        await settleWithin(cancelPromise, this.cleanupTimeoutMs);
                    }
                }
                if (session) {
                    const terminated = await settleWithin(
                        session.terminate(),
                        this.cleanupTimeoutMs,
                    );
                    if (!terminated) {
                        const forced = await settleWithin(
                            session.forceTerminate(),
                            this.cleanupTimeoutMs,
                        );
                        if (!forced) {
                            throw new HeadlessRenderError(
                                'CLEANUP_FAILED',
                                'The Chromium worker did not confirm forced termination.',
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

function assertWorkerRequest(request: {
    plan: ResolvedRenderPlanV1;
    mediaSources: VerifiedRenderMediaSourceSet;
    resourceReservation: HeadlessRenderResourceReservation;
    maximumReadChunkBytes: number;
    maximumCanvasFrames: number;
    maximumDecoderSessions: number;
    maximumDecodedPixelBytes: number;
    maximumAudioMixBytes: number;
}): void {
    const decodedCanvasBytes = request.plan.renderProfile.width
        * request.plan.renderProfile.height
        * 4
        * request.maximumCanvasFrames;
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
        || request.maximumCanvasFrames > 2
        || request.maximumDecoderSessions > 2
        || !Number.isSafeInteger(decodedCanvasBytes)
        || decodedCanvasBytes > request.maximumDecodedPixelBytes
        || [
            request.maximumReadChunkBytes,
            request.maximumCanvasFrames,
            request.maximumDecoderSessions,
            request.maximumDecodedPixelBytes,
            request.maximumAudioMixBytes,
        ].some((value) => !Number.isSafeInteger(value) || value <= 0)) {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'The Chromium worker request exceeds the bounded render contract.',
        );
    }
}

function checkedFrameBytes(plan: ResolvedRenderPlanV1): number {
    const bytes = plan.renderProfile.width * plan.renderProfile.height * 4;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
        throw new HeadlessRenderError('RESOURCE_LIMIT', 'The Chromium RGBA frame size is invalid.');
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
