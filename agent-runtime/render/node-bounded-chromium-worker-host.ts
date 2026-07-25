import { platform } from 'node:os';
import type { Writable } from 'node:stream';

import type {
    AcquiredNodeStagedOutputHandle,
    NodeStagedOutputHandleResolverPort,
} from '../export/node-staged-output-handle';
import type {
    BoundedChromiumWorkerHostPort,
    BoundedChromiumWorkerLaunch,
    BoundedChromiumWorkerSession,
} from './bounded-chromium-worker';
import {
    HeadlessRenderError,
    throwIfAborted,
    type HeadlessStagedOutputCapability,
} from './contracts';
import {
    collectBoundedProcessOutput,
    endProcessInput,
    NodeBackendProcessTracker,
    NodeBoundedFfmpegProcessRunner,
    type NodeBackendProcessLimits,
    type NodeBoundedProcessSession,
    writeProcessInput,
} from './node-ffmpeg-process';
import type { ChromiumWebCodecsCapabilityProbe } from './chromium-backend';

const RAW_AUDIO_FD = 3;
const MAXIMUM_PROBE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_PROCESS_LIMITS: NodeBackendProcessLimits = {
    maximumProcesses: 1,
    maximumResidentBytes: 1024 * 1024 * 1024,
    maximumStderrBytes: 1024 * 1024,
    maximumProgressBytes: 1,
    timeoutMs: 2 * 60 * 60_000,
    killGraceMs: 1_000,
};

export interface NodeBoundedChromiumWorkerHostOptions {
    /** Logical packaged executable name only; caller-controlled paths are deliberately rejected. */
    ffmpegExecutable?: string;
    processes?: NodeBoundedFfmpegProcessRunner;
    maximumOutputBytes?: number;
    maximumResidentBytes?: number;
    maximumStderrBytes?: number;
    processTimeoutMs?: number;
    processKillGraceMs?: number;
}

/**
 * Production host for `BoundedChromiumWorkerHostPort` on Node runtimes.
 *
 * Chromium/WebCodecs cannot safely transfer a seekable Node descriptor into its JavaScript
 * encoder process with the currently packaged dependencies. This host keeps the Chromium-side
 * compositor authoritative and passes its already-rasterized RGBA subtitle frames plus canonical
 * PCM to one fixed FFmpeg encoder over pipes. FFmpeg receives no manifest, plan, subtitle text,
 * source/output paths, or network protocol.
 */
export class NodeBoundedChromiumWorkerHostPort implements BoundedChromiumWorkerHostPort {
    private active = false;
    private readonly ffmpegExecutable: string;
    private readonly processes: NodeBoundedFfmpegProcessRunner;
    private readonly maximumOutputBytes: number;
    private readonly processLimits: NodeBackendProcessLimits;

    constructor(
        private readonly outputs: NodeStagedOutputHandleResolverPort,
        options: NodeBoundedChromiumWorkerHostOptions = {},
    ) {
        this.ffmpegExecutable = validateLogicalExecutable(options.ffmpegExecutable ?? 'ffmpeg');
        this.processes = options.processes ?? new NodeBoundedFfmpegProcessRunner();
        this.maximumOutputBytes = validatePositiveSafeInteger(
            options.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES,
            'maximumOutputBytes',
        );
        this.processLimits = Object.freeze({
            maximumProcesses: 1,
            maximumResidentBytes: validatePositiveSafeInteger(
                options.maximumResidentBytes ?? DEFAULT_PROCESS_LIMITS.maximumResidentBytes,
                'maximumResidentBytes',
            ),
            maximumStderrBytes: validatePositiveSafeInteger(
                options.maximumStderrBytes ?? DEFAULT_PROCESS_LIMITS.maximumStderrBytes,
                'maximumStderrBytes',
            ),
            maximumProgressBytes: 1,
            timeoutMs: validatePositiveSafeInteger(
                options.processTimeoutMs ?? DEFAULT_PROCESS_LIMITS.timeoutMs,
                'processTimeoutMs',
            ),
            killGraceMs: validatePositiveSafeInteger(
                options.processKillGraceMs ?? DEFAULT_PROCESS_LIMITS.killGraceMs,
                'processKillGraceMs',
            ),
        });
    }

    async probe(signal?: AbortSignal): Promise<ChromiumWebCodecsCapabilityProbe> {
        throwIfAborted(signal);
        if (platform() === 'win32') {
            return unsupportedProbe('Descriptor-bound raw MP4 encoding is unavailable on Windows.');
        }
        try {
            // Keep even capability discovery within the same one-child-process bound as rendering.
            const encoders = await this.collectCapability('encoders', signal);
            const muxers = await this.collectCapability('muxers', signal);
            throwIfAborted(signal);
            const h264Encoder = /(?:^|\s)libx264(?:\s|$)/m.test(encoders);
            const aacEncoder = /(?:^|\s)aac(?:\s|$)/m.test(encoders);
            const mp4Muxer = /(?:^|\s)mp4(?:\s|$)/m.test(muxers);
            const supported = h264Encoder && aacEncoder && mp4Muxer;
            return {
                // This is not a Chromium process. The backend accepts the explicit exact fallback
                // below only after canonical Chromium composition has produced the RGBA frames.
                chromiumAvailable: false,
                webCodecs: false,
                h264Encoder,
                aacEncoder,
                mp4Muxer,
                implementation: 'deterministic-ffmpeg-raw-descriptor',
                reason: supported
                    ? 'Using deterministic FFmpeg raw-descriptor encoding after Chromium composition.'
                    : 'FFmpeg is missing libx264, AAC, or the MP4 muxer.',
            };
        } catch (error) {
            throwIfAborted(signal);
            return unsupportedProbe(error instanceof Error
                ? error.message
                : 'FFmpeg capability probing failed.');
        }
    }

    async launch(
        request: BoundedChromiumWorkerLaunch,
        signal?: AbortSignal,
    ): Promise<BoundedChromiumWorkerSession> {
        if (this.active) {
            throw new HeadlessRenderError(
                'RESOURCE_LIMIT',
                'The deterministic Chromium worker host already has an active session.',
            );
        }
        throwIfAborted(signal);
        assertLaunchRequest(request);
        if (platform() === 'win32') {
            throw new HeadlessRenderError(
                'BACKEND_UNAVAILABLE',
                'Descriptor-bound raw MP4 encoding is unavailable on Windows.',
            );
        }

        this.active = true;
        let output: AcquiredNodeStagedOutputHandle | null = null;
        try {
            output = await this.outputs.acquire(request.outputCapability, 'read-write', signal);
            assertOutputHandle(request.outputCapability, output);
            await output.assertCurrent(signal);
            if (await output.size(signal) !== 0) {
                throw new HeadlessRenderError(
                    'INVALID_OUTPUT',
                    'The create-only staged output must be empty before encoding.',
                );
            }
            throwIfAborted(signal);

            const tracker = new NodeBackendProcessTracker(
                this.processLimits.maximumProcesses,
                this.processLimits.maximumResidentBytes,
            );
            const process = this.processes.start({
                executable: this.ffmpegExecutable,
                args: buildRawDescriptorEncoderArgs(request, this.maximumOutputBytes),
                stdio: ['pipe', 'ignore', 'pipe', 'pipe', output.fileDescriptor],
                limits: this.processLimits,
                tracker,
                signal,
            });
            const audioInput = process.inputAt(RAW_AUDIO_FD);
            if (!audioInput) {
                await process.terminate(new HeadlessRenderError(
                    'RENDER_FAILED',
                    'FFmpeg did not expose the raw PCM input pipe.',
                ));
                throw new HeadlessRenderError(
                    'RENDER_FAILED',
                    'FFmpeg did not expose the raw PCM input pipe.',
                );
            }
            return this.createSession(request, output, process, audioInput);
        } catch (error) {
            this.active = false;
            await output?.close().catch(() => undefined);
            throw error;
        }
    }

    private async collectCapability(
        kind: 'encoders' | 'muxers',
        signal?: AbortSignal,
    ): Promise<string> {
        const tracker = new NodeBackendProcessTracker(
            this.processLimits.maximumProcesses,
            this.processLimits.maximumResidentBytes,
        );
        const process = this.processes.start({
            executable: this.ffmpegExecutable,
            args: ['-hide_banner', `-${kind}`],
            stdio: ['ignore', 'pipe', 'pipe'],
            limits: {
                ...this.processLimits,
                timeoutMs: Math.min(this.processLimits.timeoutMs, 10_000),
            },
            tracker,
            signal,
            maximumStdoutBytes: MAXIMUM_PROBE_BYTES,
        });
        try {
            const [bytes] = await Promise.all([
                collectBoundedProcessOutput(process.stdout, MAXIMUM_PROBE_BYTES, signal),
                process.wait(),
            ]);
            return bytes.toString('utf8');
        } catch (error) {
            await process.terminate();
            throw error;
        }
    }

    private createSession(
        request: BoundedChromiumWorkerLaunch,
        output: AcquiredNodeStagedOutputHandle,
        process: NodeBoundedProcessSession,
        audioInput: Writable,
    ): BoundedChromiumWorkerSession {
        const expectedFrameBytes = checkedFrameBytes(request.width, request.height);
        let nextFrame = 0;
        let nextSample = 0;
        let writing = false;
        let finalized = false;
        let closed = false;

        const assertOpen = () => {
            if (closed || finalized) {
                throw new HeadlessRenderError(
                    'RENDER_FAILED',
                    'The deterministic Chromium worker session is already terminal.',
                );
            }
        };
        const closeOwned = async () => {
            if (closed) return;
            closed = true;
            await output.close();
            this.active = false;
        };
        const terminate = async (error?: HeadlessRenderError) => {
            if (closed) return;
            if (!finalized) {
                await process.terminate(error);
            } else {
                await process.wait().catch(() => undefined);
            }
            await closeOwned();
        };
        const withWrite = async (operation: () => Promise<void>) => {
            assertOpen();
            if (writing) {
                throw new HeadlessRenderError(
                    'RESOURCE_LIMIT',
                    'The deterministic Chromium worker allows one raw input write at a time.',
                );
            }
            writing = true;
            try {
                await operation();
            } finally {
                writing = false;
            }
        };

        return {
            writeVideoFrame: (frameIndex, rgba, signal) => withWrite(async () => {
                throwIfAborted(signal);
                if (!Number.isSafeInteger(frameIndex) || frameIndex !== nextFrame
                    || rgba.byteLength !== expectedFrameBytes) {
                    throw new HeadlessRenderError(
                        'RENDER_FAILED',
                        'The deterministic Chromium worker received an invalid RGBA frame.',
                    );
                }
                await writeProcessInput(process.stdin, rgba, signal);
                nextFrame += 1;
            }),
            writeAudioChunk: (outputStartSample, stereoPcm, signal) => withWrite(async () => {
                throwIfAborted(signal);
                const sampleCount = stereoPcm.length / 2;
                if (!Number.isSafeInteger(outputStartSample)
                    || outputStartSample !== nextSample
                    || !Number.isSafeInteger(sampleCount)
                    || sampleCount <= 0
                    || stereoPcm.byteLength > request.maximumAudioMixBytes) {
                    throw new HeadlessRenderError(
                        'RENDER_FAILED',
                        'The deterministic Chromium worker received an invalid PCM chunk.',
                    );
                }
                await writeProcessInput(
                    audioInput,
                    new Uint8Array(
                        stereoPcm.buffer,
                        stereoPcm.byteOffset,
                        stereoPcm.byteLength,
                    ),
                    signal,
                );
                nextSample += sampleCount;
            }),
            finalize: async (signal) => {
                assertOpen();
                if (writing) {
                    throw new HeadlessRenderError(
                        'RENDER_FAILED',
                        'The deterministic Chromium worker cannot finalize while a raw write is active.',
                    );
                }
                throwIfAborted(signal);
                await Promise.all([
                    endProcessInput(process.stdin),
                    endProcessInput(audioInput),
                ]);
                await process.wait();
                await output.assertCurrent(signal);
                const outputBytes = await output.size(signal);
                if (outputBytes <= 0 || outputBytes > this.maximumOutputBytes) {
                    throw new HeadlessRenderError(
                        'INVALID_OUTPUT',
                        'The deterministic Chromium worker produced an invalid staged MP4 size.',
                    );
                }
                await output.sync(signal);
                finalized = true;
                return {
                    warnings: [
                        'Chromium composition used deterministic FFmpeg raw-descriptor encoding.',
                    ],
                };
            },
            cancel: (reason) => terminate(new HeadlessRenderError(
                'CANCELLED',
                `The deterministic Chromium worker was cancelled: ${safeCancelReason(reason)}.`,
            )),
            terminate: () => terminate(),
            forceTerminate: async () => {
                if (closed) return;
                process.forceKill();
                await process.wait().catch(() => undefined);
                await closeOwned();
            },
        };
    }
}

function buildRawDescriptorEncoderArgs(
    request: BoundedChromiumWorkerLaunch,
    maximumOutputBytes: number,
): readonly string[] {
    return [
        '-hide_banner',
        '-nostdin',
        '-nostats',
        '-loglevel', 'error',
        '-protocol_whitelist', 'pipe',
        '-threads', '1',
        '-filter_threads', '1',
        '-filter_complex_threads', '1',
        '-fflags', '+bitexact',
        '-f', 'rawvideo',
        '-pix_fmt', 'rgba',
        '-video_size', `${request.width}x${request.height}`,
        '-framerate', `${request.fpsNumerator}/${request.fpsDenominator}`,
        '-i', 'pipe:0',
        '-f', 'f32le',
        '-ar', '48000',
        '-ac', '2',
        '-i', `pipe:${RAW_AUDIO_FD}`,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-sn',
        '-dn',
        '-map_metadata', '-1',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-threads:v', '1',
        '-flags:v', '+bitexact',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '48000',
        '-ac', '2',
        '-threads:a', '1',
        '-flags:a', '+bitexact',
        '-metadata', 'creation_time=1970-01-01T00:00:00Z',
        '-max_muxing_queue_size', '128',
        '-fs', String(maximumOutputBytes),
        '-movflags', '+empty_moov+default_base_moof+frag_keyframe',
        '-f', 'mp4',
        'pipe:4',
    ];
}

function assertLaunchRequest(value: unknown): asserts value is BoundedChromiumWorkerLaunch {
    if (!value || typeof value !== 'object') {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'The Chromium worker host request exceeds its fixed raw encoding contract.',
        );
    }
    const request = value as BoundedChromiumWorkerLaunch;
    const expectedKeys = [
        'audioCodec',
        'container',
        'fpsDenominator',
        'fpsNumerator',
        'height',
        'jobId',
        'maximumAudioMixBytes',
        'maximumCanvasFrames',
        'maximumDecodedPixelBytes',
        'maximumDecoderSessions',
        'maximumReadChunkBytes',
        'networkPolicy',
        'outputCapability',
        'resourceReservation',
        'videoCodec',
        'width',
    ];
    if (Object.keys(request).sort().join(',') !== expectedKeys.join(',')
        || !/^[A-Za-z0-9_-]{1,128}$/.test(request.jobId)
        || request.videoCodec !== 'h264'
        || request.audioCodec !== 'aac'
        || request.container !== 'mp4'
        || request.networkPolicy !== 'media-byte-source-only'
        || !isValidOutputCapability(request.outputCapability)
        || !isValidReservation(request)
        || [
            request.width,
            request.height,
            request.fpsNumerator,
            request.fpsDenominator,
            request.maximumCanvasFrames,
            request.maximumDecoderSessions,
            request.maximumDecodedPixelBytes,
            request.maximumAudioMixBytes,
            request.maximumReadChunkBytes,
        ].some((value) => !Number.isSafeInteger(value) || value <= 0)
        || request.width % 2 !== 0
        || request.height % 2 !== 0
        || request.maximumCanvasFrames > 2
        || request.maximumDecoderSessions > 2
        || exceedsCanvasBudget(request)) {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'The Chromium worker host request exceeds its fixed raw encoding contract.',
        );
    }
}

function isValidReservation(request: BoundedChromiumWorkerLaunch): boolean {
    const reservation = request.resourceReservation;
    if (!reservation || typeof reservation !== 'object'
        || !reservation.granted || typeof reservation.granted !== 'object') return false;
    const granted = reservation.granted;
    const expectedKeys = [
        'audio-mix-bytes',
        'backend-processes',
        'canvas-frames',
        'decoded-pixel-bytes',
        'export-jobs',
        'video-decoder-sessions',
    ];
    return reservation.authority === 'process-wide-decoded-memory-v1'
        && /^[A-Za-z0-9:_-]{1,256}$/.test(reservation.reservationId)
        && Object.keys(granted).sort().join(',') === expectedKeys.join(',')
        && granted['audio-mix-bytes'] === request.maximumAudioMixBytes
        && granted['backend-processes'] === 1
        && granted['canvas-frames'] === request.maximumCanvasFrames
        && granted['decoded-pixel-bytes'] === request.maximumDecodedPixelBytes
        && granted['export-jobs'] === 1
        && granted['video-decoder-sessions'] === request.maximumDecoderSessions;
}

function isValidOutputCapability(value: unknown): value is HeadlessStagedOutputCapability {
    if (!value || typeof value !== 'object') return false;
    const capability = value as HeadlessStagedOutputCapability;
    return capability.version === 1
        && capability.kind === 'create-only-staged-output'
        && Object.keys(capability).sort().join(',')
            === 'capabilityId,grantId,kind,stagingId,version'
        && [capability.capabilityId, capability.grantId, capability.stagingId]
            .every((item) => /^[A-Za-z0-9:_-]{1,256}$/.test(item));
}

function assertOutputHandle(
    expected: HeadlessStagedOutputCapability,
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
            'The staged output resolver returned a mismatched descriptor.',
        );
    }
}

function unsupportedProbe(reason: string): ChromiumWebCodecsCapabilityProbe {
    return {
        chromiumAvailable: false,
        webCodecs: false,
        h264Encoder: false,
        aacEncoder: false,
        mp4Muxer: false,
        implementation: 'deterministic-ffmpeg-raw-descriptor',
        reason,
    };
}

function checkedFrameBytes(width: number, height: number): number {
    const bytes = width * height * 4;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
        throw new HeadlessRenderError('RESOURCE_LIMIT', 'The raw RGBA frame size is invalid.');
    }
    return bytes;
}

function exceedsCanvasBudget(request: BoundedChromiumWorkerLaunch): boolean {
    const canvasBytes = checkedFrameBytes(request.width, request.height)
        * request.maximumCanvasFrames;
    return !Number.isSafeInteger(canvasBytes)
        || canvasBytes > request.maximumDecodedPixelBytes;
}

function validatePositiveSafeInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive safe integer.`);
    }
    return value;
}

function validateLogicalExecutable(value: string): string {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
        throw new RangeError('ffmpegExecutable must be a logical packaged executable name.');
    }
    return value;
}

function safeCancelReason(value: string): string {
    return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value)
        ? value
        : 'cancelled';
}
