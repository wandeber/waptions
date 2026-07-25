import { platform } from 'node:os';
import type {
    ResolvedRenderPlanV1,
} from '../../src/lib/render-plan';
import type {
    AcquiredNodeStagedOutputHandle,
    NodeStagedOutputHandleResolverPort,
} from '../export/node-staged-output-handle';
import {
    HeadlessRenderError,
    normalizeHeadlessRenderError,
    throwIfAborted,
    type HeadlessRenderBackendProgress,
    type HeadlessSourceRangeRead,
} from './contracts';
import {
    materializeCanonicalAudio,
    type CanonicalPcmScratch,
} from './ffmpeg-audio-materializer';
import {
    buildFfmpegCapabilityArgs,
    buildFfmpegEncoderArgs,
    FFMPEG_PROGRESS_FD,
} from './ffmpeg-command';
import {
    assertFfmpegResolvedPlanOnly,
    type FfmpegCapabilityProbe,
    type FfmpegResolvedPlanExecutorPort,
    type FfmpegResolvedPlanResult,
} from './ffmpeg-backend';
import type { ImmutableSourceHandleResolverPort } from './node-ffmpeg-handles';
import {
    collectBoundedProcessOutput,
    endProcessInput,
    NodeBackendProcessTracker,
    NodeBoundedFfmpegProcessRunner,
    type NodeBackendProcessLimits,
    type NodeBoundedProcessSession,
} from './node-ffmpeg-process';
import { produceResolvedVideoFrames } from './ffmpeg-video-producer';

const FALLBACK_MAX_SCRATCH_BYTES = 4 * 1024 * 1024 * 1024;
const FALLBACK_MAX_RESIDENT_BYTES = 1024 * 1024 * 1024;
const FALLBACK_MAX_STDERR_BYTES = 1024 * 1024;
const FALLBACK_MAX_PROGRESS_BYTES = 4 * 1024 * 1024;
const FALLBACK_PROCESS_TIMEOUT_MS = 2 * 60 * 60_000;
const FALLBACK_KILL_GRACE_MS = 1_000;

export interface NodeFfmpegResolvedPlanExecutorOptions {
    ffmpegExecutable?: string;
    ffprobeExecutable?: string;
    processes?: NodeBoundedFfmpegProcessRunner;
}

/**
 * Concrete Node/FFmpeg renderer for the already-resolved plan.
 *
 * Canonical audio is fully materialized before the encoder starts. During video production the
 * only pipe into the encoder is raw RGBA; audio and MP4 remain seekable inherited descriptors.
 */
export class NodeFfmpegResolvedPlanExecutor implements FfmpegResolvedPlanExecutorPort {
    private active = false;
    private readonly ffmpegExecutable: string;
    private readonly ffprobeExecutable: string;
    private readonly processes: NodeBoundedFfmpegProcessRunner;

    constructor(
        private readonly sourceHandles: ImmutableSourceHandleResolverPort,
        private readonly outputHandles: NodeStagedOutputHandleResolverPort,
        options: NodeFfmpegResolvedPlanExecutorOptions = {},
    ) {
        this.ffmpegExecutable = validateExecutable(
            options.ffmpegExecutable ?? 'ffmpeg',
            'FFmpeg',
        );
        this.ffprobeExecutable = validateExecutable(
            options.ffprobeExecutable ?? 'ffprobe',
            'FFprobe',
        );
        this.processes = options.processes ?? new NodeBoundedFfmpegProcessRunner();
    }

    async probe(signal?: AbortSignal): Promise<FfmpegCapabilityProbe> {
        throwIfAborted(signal);
        if (platform() === 'win32') {
            return unsupportedProbe('Seekable /dev/fd inheritance is unavailable on Windows.');
        }
        const limits: NodeBackendProcessLimits = {
            maximumProcesses: 1,
            maximumResidentBytes: 512 * 1024 * 1024,
            maximumStderrBytes: 256 * 1024,
            maximumProgressBytes: 256 * 1024,
            timeoutMs: 10_000,
            killGraceMs: 1_000,
        };
        try {
            const encoders = await this.collectProbe(
                this.ffmpegExecutable,
                buildFfmpegCapabilityArgs('encoders'),
                limits,
                signal,
            );
            const muxers = await this.collectProbe(
                this.ffmpegExecutable,
                buildFfmpegCapabilityArgs('muxers'),
                limits,
                signal,
            );
            await this.collectProbe(
                this.ffprobeExecutable,
                ['-version'],
                limits,
                signal,
            );
            const h264Encoder = /(?:^|\s)libx264(?:\s|$)/m.test(encoders);
            const aacEncoder = /(?:^|\s)aac(?:\s|$)/m.test(encoders);
            const mp4Muxer = /(?:^|\s)mp4(?:\s|$)/m.test(muxers);
            return {
                ffmpegAvailable: true,
                ffprobeAvailable: true,
                resolvedPlanVersion: 1,
                h264Encoder,
                aacEncoder,
                mp4Muxer,
                reason: h264Encoder && aacEncoder && mp4Muxer
                    ? undefined
                    : 'FFmpeg is missing libx264, AAC, or the MP4 muxer.',
            };
        } catch (error) {
            throwIfAborted(signal);
            return unsupportedProbe(
                error instanceof Error ? error.message : 'FFmpeg probing failed.',
            );
        }
    }

    async encode(
        request: Parameters<FfmpegResolvedPlanExecutorPort['encode']>[0],
    ): Promise<FfmpegResolvedPlanResult> {
        if (this.active) {
            throw new HeadlessRenderError(
                'RESOURCE_LIMIT',
                'The Node FFmpeg executor already has an active render.',
            );
        }
        assertFfmpegResolvedPlanOnly(request.plan);
        validateResolvedPlan(request.plan);
        validateFixedRequest(request);
        throwIfAborted(request.signal);
        this.active = true;

        const processLimits = resolveProcessLimits(request);
        const tracker = new NodeBackendProcessTracker(
            processLimits.maximumProcesses,
            processLimits.maximumResidentBytes,
        );
        let output: AcquiredNodeStagedOutputHandle | null = null;
        let scratch: CanonicalPcmScratch | null = null;
        let encoder: NodeBoundedProcessSession | null = null;
        let primaryError: unknown = null;
        try {
            output = await this.outputHandles.acquire(
                request.outputCapability,
                'read-write',
                request.signal,
            );
            assertOutputHandle(request.outputCapability, output);
            await output.assertCurrent(request.signal);
            if (await output.size(request.signal) !== 0) {
                throw new HeadlessRenderError(
                    'INVALID_OUTPUT',
                    'The create-only staged output was not empty before FFmpeg encoding.',
                );
            }

            const audio = await materializeCanonicalAudio({
                plan: request.plan,
                mediaSources: request.mediaSources,
                sourceHandles: this.sourceHandles,
                processes: this.processes,
                tracker,
                ffmpegExecutable: this.ffmpegExecutable,
                ffprobeExecutable: this.ffprobeExecutable,
                processLimits,
                maximumAudioMixBytes: request.maximumAudioMixBytes,
                maximumScratchBytes: request.maximumScratchBytes
                    ?? FALLBACK_MAX_SCRATCH_BYTES,
                signal: request.signal,
                onProgress: request.onProgress,
            });
            scratch = audio.scratch;
            await output.assertCurrent(request.signal);
            throwIfAborted(request.signal);

            const progress = createEncoderProgressParser(
                request.plan,
                request.onProgress,
            );
            encoder = this.processes.start({
                executable: this.ffmpegExecutable,
                args: buildFfmpegEncoderArgs({
                    width: request.plan.renderProfile.width,
                    height: request.plan.renderProfile.height,
                    fpsNumerator: request.plan.renderProfile.fps.numerator,
                    fpsDenominator: request.plan.renderProfile.fps.denominator,
                    frameCount: request.plan.contentEndFrame,
                    outputSampleCount: request.plan.outputEndSample,
                }),
                stdio: [
                    'pipe',
                    'ignore',
                    'pipe',
                    scratch.fileDescriptor,
                    output.fileDescriptor,
                    'pipe',
                ],
                limits: processLimits,
                tracker,
                signal: request.signal,
                progressPipeIndex: FFMPEG_PROGRESS_FD,
                onProgressChunk: progress.push,
            });

            let video;
            try {
                video = await produceResolvedVideoFrames({
                    plan: request.plan,
                    mediaSources: request.mediaSources,
                    sourceHandles: this.sourceHandles,
                    processes: this.processes,
                    tracker,
                    ffmpegExecutable: this.ffmpegExecutable,
                    processLimits,
                    encoderInput: encoder.stdin,
                    maximumDecodedPixelBytes: request.maximumDecodedPixelBytes,
                    signal: request.signal,
                    onProgress: request.onProgress,
                });
                await endProcessInput(encoder.stdin);
                await encoder.wait();
                progress.finish();
            } catch (error) {
                await encoder.terminate(normalizeHeadlessRenderError(error));
                throw error;
            }
            await output.assertCurrent(request.signal);
            throwIfAborted(request.signal);
            if (await output.size(request.signal) <= 0) {
                throw new HeadlessRenderError(
                    'INVALID_OUTPUT',
                    'FFmpeg produced an empty staged MP4.',
                );
            }
            await output.sync(request.signal);
            const processDiagnostics = tracker.snapshot();
            return {
                sourceRangesRead: mergeSourceRanges([
                    ...audio.sourceRangesRead,
                    ...video.sourceRangesRead,
                ]),
                diagnostics: {
                    peakDecodedPixelBytes: video.peakDecodedPixelBytes,
                    peakAudioMixBytes: audio.peakAudioMixBytes,
                    peakVideoDecoderSessions: video.peakVideoDecoderSessions,
                    canvasFrames: video.canvasFrames,
                    peakBackendResidentBytes: processDiagnostics.peakBackendResidentBytes,
                    peakScratchBytes: audio.peakScratchBytes,
                    peakBackendProcesses: processDiagnostics.peakBackendProcesses,
                },
            };
        } catch (error) {
            primaryError = error;
            throw normalizeHeadlessRenderError(error);
        } finally {
            const cleanupFailures: unknown[] = [];
            if (encoder) {
                await encoder.terminate().catch((error) => cleanupFailures.push(error));
            }
            if (scratch) {
                await scratch.close().catch((error) => cleanupFailures.push(error));
            }
            if (output) {
                await output.close().catch((error) => cleanupFailures.push(error));
            }
            this.active = false;
            if (!primaryError && cleanupFailures.length > 0) {
                throw new HeadlessRenderError(
                    'CLEANUP_FAILED',
                    'The Node FFmpeg backend could not close every owned handle.',
                    false,
                    cleanupFailures[0] instanceof Error
                        ? { cause: cleanupFailures[0] }
                        : undefined,
                );
            }
        }
    }

    private async collectProbe(
        executable: string,
        args: readonly string[],
        limits: NodeBackendProcessLimits,
        signal?: AbortSignal,
    ): Promise<string> {
        const tracker = new NodeBackendProcessTracker(
            limits.maximumProcesses,
            limits.maximumResidentBytes,
        );
        const maximumBytes = 2 * 1024 * 1024;
        const session = this.processes.start({
            executable,
            args,
            stdio: ['ignore', 'pipe', 'pipe'],
            limits,
            tracker,
            signal,
            maximumStdoutBytes: maximumBytes,
        });
        try {
            const [bytes] = await Promise.all([
                collectBoundedProcessOutput(session.stdout, maximumBytes, signal),
                session.wait(),
            ]);
            return bytes.toString('utf8');
        } catch (error) {
            await session.terminate(normalizeHeadlessRenderError(error));
            throw error;
        }
    }
}

function validateResolvedPlan(plan: ResolvedRenderPlanV1): void {
    if (plan.subtitleTracks.length > 0) {
        throw new HeadlessRenderError(
            'CODEC_UNAVAILABLE',
            'This FFmpeg backend cannot render subtitles without verified font bytes and libass support.',
        );
    }
    if (plan.output.container !== 'mp4'
        || plan.output.videoCodec !== 'h264'
        || plan.output.audioCodec !== 'aac'
        || !Number.isSafeInteger(plan.contentEndFrame)
        || plan.contentEndFrame <= 0
        || !Number.isSafeInteger(plan.outputEndSample)
        || plan.outputEndSample <= 0
        || !Number.isSafeInteger(plan.renderProfile.width)
        || !Number.isSafeInteger(plan.renderProfile.height)
        || plan.renderProfile.width <= 0
        || plan.renderProfile.height <= 0
        || !Number.isSafeInteger(plan.renderProfile.fps.numerator)
        || !Number.isSafeInteger(plan.renderProfile.fps.denominator)
        || plan.renderProfile.fps.numerator <= 0
        || plan.renderProfile.fps.denominator <= 0
        || !/^#[0-9a-f]{6}$/.test(plan.backgroundColor)) {
        throw new HeadlessRenderError(
            'INVALID_SNAPSHOT',
            'The resolved render plan is not a bounded H.264/AAC MP4 plan.',
        );
    }
}

function validateFixedRequest(
    request: Parameters<FfmpegResolvedPlanExecutorPort['encode']>[0],
): void {
    const granted = request.resourceReservation.granted;
    const hasVideoDecoder = request.plan.videoSegments.some((segment) => segment.kind === 'video');
    const requiredProcesses = hasVideoDecoder ? 2 : 1;
    if (request.mediaSources.snapshotId !== request.plan.sourceSnapshotId
        || request.resourceReservation.authority !== 'process-wide-decoded-memory-v1'
        || granted['decoded-pixel-bytes'] !== request.maximumDecodedPixelBytes
        || granted['audio-mix-bytes'] !== request.maximumAudioMixBytes
        || granted['canvas-frames'] !== request.maximumCanvasFrames
        || granted['video-decoder-sessions'] !== request.maximumDecoderSessions
        || granted['backend-processes'] !== request.maximumBackendProcesses
        || (request.maximumBackendProcesses ?? 0) < requiredProcesses
        || request.maximumDecoderSessions < (hasVideoDecoder ? 1 : 0)
        || request.videoPixelFormat !== 'rgba'
        || request.audioSampleFormat !== 'f32le-stereo-48000'
        || request.container !== 'mp4'
        || request.videoCodec !== 'h264'
        || request.audioCodec !== 'aac') {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'The Node FFmpeg request does not match its fixed formats and resource reservation.',
        );
    }
}

function resolveProcessLimits(
    request: Parameters<FfmpegResolvedPlanExecutorPort['encode']>[0],
): NodeBackendProcessLimits {
    const limits = {
        maximumProcesses: request.maximumBackendProcesses ?? 0,
        maximumResidentBytes: request.maximumBackendResidentBytes
            ?? FALLBACK_MAX_RESIDENT_BYTES,
        maximumStderrBytes: request.maximumStderrBytes
            ?? FALLBACK_MAX_STDERR_BYTES,
        maximumProgressBytes: request.maximumProgressBytes
            ?? FALLBACK_MAX_PROGRESS_BYTES,
        timeoutMs: request.processTimeoutMs ?? FALLBACK_PROCESS_TIMEOUT_MS,
        killGraceMs: request.processKillGraceMs ?? FALLBACK_KILL_GRACE_MS,
    };
    Object.entries(limits).forEach(([label, value]) => {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new HeadlessRenderError(
                'RESOURCE_LIMIT',
                `${label} must be a positive safe integer.`,
            );
        }
    });
    return limits;
}

function assertOutputHandle(
    expected: Parameters<FfmpegResolvedPlanExecutorPort['encode']>[0]['outputCapability'],
    actual: AcquiredNodeStagedOutputHandle,
): void {
    const capability = actual.outputCapability;
    if (actual.access !== 'read-write'
        || !Number.isSafeInteger(actual.fileDescriptor)
        || actual.fileDescriptor < 0
        || capability.version !== expected.version
        || capability.kind !== expected.kind
        || capability.capabilityId !== expected.capabilityId
        || capability.grantId !== expected.grantId
        || capability.stagingId !== expected.stagingId) {
        throw new HeadlessRenderError(
            'INVALID_OUTPUT',
            'The acquired staged output handle does not match the create-only capability.',
        );
    }
}

function mergeSourceRanges(
    ranges: readonly HeadlessSourceRangeRead[],
): HeadlessSourceRangeRead[] {
    const merged = new Map<string, HeadlessSourceRangeRead>();
    ranges.forEach((range) => {
        const key = `${range.sourceKind}:${range.sourceId}:${range.kind}`;
        const previous = merged.get(key);
        merged.set(key, previous ? {
            ...previous,
            start: Math.min(previous.start, range.start),
            end: Math.max(previous.end, range.end),
        } : { ...range });
    });
    return Array.from(merged.values()).sort((left, right) => (
        left.sourceKind.localeCompare(right.sourceKind)
        || left.sourceId.localeCompare(right.sourceId)
        || left.kind.localeCompare(right.kind)
    ));
}

function createEncoderProgressParser(
    plan: ResolvedRenderPlanV1,
    onProgress?: (progress: HeadlessRenderBackendProgress) => void,
): { push(chunk: Uint8Array): void; finish(): void } {
    let buffer = '';
    let lastFrame = 0;
    const publish = (frame: number) => {
        const bounded = Math.max(lastFrame, Math.min(plan.contentEndFrame, frame));
        lastFrame = bounded;
        onProgress?.({
            stage: 'muxing',
            completedUnits: bounded,
            totalUnits: plan.contentEndFrame,
        });
    };
    const consume = () => {
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        if (buffer.length > 8_192) {
            throw new HeadlessRenderError(
                'RESOURCE_LIMIT',
                'FFmpeg emitted an unbounded progress line.',
            );
        }
        lines.forEach((line) => {
            const match = /^frame=(\d+)$/.exec(line);
            if (match) publish(Number(match[1]));
        });
    };
    return {
        push(chunk) {
            buffer += Buffer.from(chunk).toString('utf8');
            consume();
        },
        finish() {
            buffer += '\n';
            consume();
            publish(plan.contentEndFrame);
        },
    };
}

function validateExecutable(value: string, label: string): string {
    if (!value || value.length > 4_096 || value.includes('\0')) {
        throw new RangeError(`${label} executable is invalid.`);
    }
    return value;
}

function unsupportedProbe(reason: string): FfmpegCapabilityProbe {
    return {
        ffmpegAvailable: false,
        ffprobeAvailable: false,
        resolvedPlanVersion: 1,
        h264Encoder: false,
        aacEncoder: false,
        mp4Muxer: false,
        reason,
    };
}
