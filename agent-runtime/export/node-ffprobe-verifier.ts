import type {
    HeadlessStagedOutputCapability,
} from '../render/contracts';
import { HeadlessRenderError, throwIfAborted } from '../render/contracts';
import { inheritedFdPath } from '../render/ffmpeg-command';
import {
    collectBoundedProcessOutput,
    NodeBackendProcessTracker,
    NodeBoundedFfmpegProcessRunner,
    type NodeBackendProcessLimits,
} from '../render/node-ffmpeg-process';
import type {
    HeadlessMp4Inspection,
    HeadlessMp4VerifierPort,
} from './contracts';
import type {
    AcquiredNodeStagedOutputHandle,
    NodeStagedOutputHandleResolverPort,
} from './node-staged-output-handle';

const FFPROBE_OUTPUT_FD = 3;

export interface NodeFfprobeMp4VerifierOptions {
    ffprobeExecutable?: string;
    processes?: NodeBoundedFfmpegProcessRunner;
    maximumResidentBytes?: number;
    maximumStdoutBytes?: number;
    maximumStderrBytes?: number;
    timeoutMs?: number;
    killGraceMs?: number;
}

export class NodeFfprobeMp4Verifier implements HeadlessMp4VerifierPort {
    private readonly ffprobeExecutable: string;
    private readonly processes: NodeBoundedFfmpegProcessRunner;
    private readonly maximumStdoutBytes: number;
    private readonly processLimits: NodeBackendProcessLimits;

    constructor(
        private readonly handles: NodeStagedOutputHandleResolverPort,
        options: NodeFfprobeMp4VerifierOptions = {},
    ) {
        this.ffprobeExecutable = validateExecutable(
            options.ffprobeExecutable ?? 'ffprobe',
        );
        this.processes = options.processes ?? new NodeBoundedFfmpegProcessRunner();
        this.maximumStdoutBytes = positiveInteger(
            options.maximumStdoutBytes ?? 1024 * 1024,
            'maximumStdoutBytes',
        );
        this.processLimits = {
            maximumProcesses: 1,
            maximumResidentBytes: positiveInteger(
                options.maximumResidentBytes ?? 512 * 1024 * 1024,
                'maximumResidentBytes',
            ),
            maximumStderrBytes: positiveInteger(
                options.maximumStderrBytes ?? 256 * 1024,
                'maximumStderrBytes',
            ),
            maximumProgressBytes: 1,
            timeoutMs: positiveInteger(options.timeoutMs ?? 30_000, 'timeoutMs'),
            killGraceMs: positiveInteger(options.killGraceMs ?? 1_000, 'killGraceMs'),
        };
    }

    async inspect(
        outputCapability: HeadlessStagedOutputCapability,
        signal?: AbortSignal,
    ): Promise<HeadlessMp4Inspection> {
        throwIfAborted(signal);
        const handle = await this.handles.acquire(
            outputCapability,
            'read-only',
            signal,
        );
        try {
            assertOutputHandle(outputCapability, handle);
            await handle.assertCurrent(signal);
            const initialSize = await handle.size(signal);
            if (initialSize <= 0) {
                throw new HeadlessRenderError(
                    'INVALID_OUTPUT',
                    'The staged MP4 is empty before FFprobe verification.',
                );
            }
            const tracker = new NodeBackendProcessTracker(
                this.processLimits.maximumProcesses,
                this.processLimits.maximumResidentBytes,
            );
            const session = this.processes.start({
                executable: this.ffprobeExecutable,
                args: buildOwnedMp4FfprobeArgs(),
                stdio: ['ignore', 'pipe', 'pipe', handle.fileDescriptor],
                limits: this.processLimits,
                tracker,
                signal,
                maximumStdoutBytes: this.maximumStdoutBytes,
            });
            let bytes: Buffer;
            try {
                [bytes] = await Promise.all([
                    collectBoundedProcessOutput(
                        session.stdout,
                        this.maximumStdoutBytes,
                        signal,
                    ),
                    session.wait(),
                ]);
            } catch (error) {
                const verificationError = toRenderError(error);
                await session.terminate(verificationError);
                throw verificationError;
            }
            await handle.assertCurrent(signal);
            throwIfAborted(signal);
            if (await handle.size(signal) !== initialSize) {
                throw new HeadlessRenderError(
                    'SOURCE_CHANGED',
                    'The staged MP4 changed while FFprobe was reading it.',
                );
            }
            return parseOwnedMp4Inspection(bytes);
        } finally {
            await handle.close();
        }
    }
}

export function buildOwnedMp4FfprobeArgs(): readonly string[] {
    return [
        '-hide_banner',
        '-v', 'error',
        '-count_frames',
        '-show_entries',
        'format=format_name,duration:stream=index,codec_type,codec_name,pix_fmt,sample_rate,channels,channel_layout,nb_read_frames,duration',
        '-of', 'json',
        inheritedFdPath(FFPROBE_OUTPUT_FD),
    ];
}

export function parseOwnedMp4Inspection(bytes: Uint8Array): HeadlessMp4Inspection {
    let document: unknown;
    try {
        document = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (error) {
        throw new HeadlessRenderError(
            'INVALID_OUTPUT',
            'FFprobe returned invalid MP4 metadata.',
            false,
            error instanceof Error ? { cause: error } : undefined,
        );
    }
    if (!document || typeof document !== 'object'
        || !Array.isArray((document as { streams?: unknown }).streams)
        || !(document as { format?: unknown }).format
        || typeof (document as { format?: unknown }).format !== 'object') {
        throw new HeadlessRenderError(
            'INVALID_OUTPUT',
            'FFprobe did not return the required MP4 streams and format.',
        );
    }
    const streams = (document as { streams: Array<Record<string, unknown>> }).streams;
    const videos = streams.filter((stream) => stream.codec_type === 'video');
    const audios = streams.filter((stream) => stream.codec_type === 'audio');
    if (videos.length !== 1 || audios.length !== 1 || streams.length !== 2) {
        throw new HeadlessRenderError(
            'INVALID_OUTPUT',
            'The staged MP4 must contain exactly one video and one audio stream.',
        );
    }
    const video = videos[0];
    const audio = audios[0];
    const format = (document as { format: Record<string, unknown> }).format;
    const formatNames = String(format.format_name ?? '').split(',');
    const durationSeconds = finiteNumber(format.duration);
    const videoDurationSeconds = finiteNumber(video.duration);
    const audioDurationSeconds = finiteNumber(audio.duration);
    const frameCount = integerNumber(video.nb_read_frames);
    const sampleRate = integerNumber(audio.sample_rate);
    const channels = integerNumber(audio.channels);
    if (!formatNames.includes('mp4')
        || durationSeconds === null
        || videoDurationSeconds === null
        || audioDurationSeconds === null
        || frameCount === null
        || sampleRate === null
        || channels === null) {
        throw new HeadlessRenderError(
            'INVALID_OUTPUT',
            'FFprobe returned incomplete MP4 duration, frame, or audio metadata.',
        );
    }
    return {
        container: 'mp4',
        videoCodec: String(video.codec_name ?? ''),
        audioCodec: String(audio.codec_name ?? ''),
        pixelFormat: video.pix_fmt == null ? null : String(video.pix_fmt),
        audioSampleRate: sampleRate,
        audioChannels: channels,
        audioChannelLayout: audio.channel_layout == null
            ? null
            : String(audio.channel_layout),
        videoFrameCount: frameCount,
        videoDurationSeconds,
        audioDurationSeconds,
        durationSeconds,
    };
}

function assertOutputHandle(
    expected: HeadlessStagedOutputCapability,
    actual: AcquiredNodeStagedOutputHandle,
): void {
    const capability = actual.outputCapability;
    if (actual.access !== 'read-only'
        || !Number.isSafeInteger(actual.fileDescriptor)
        || actual.fileDescriptor < 0
        || capability.version !== expected.version
        || capability.kind !== expected.kind
        || capability.capabilityId !== expected.capabilityId
        || capability.grantId !== expected.grantId
        || capability.stagingId !== expected.stagingId) {
        throw new HeadlessRenderError(
            'INVALID_OUTPUT',
            'FFprobe did not acquire the exact staged output capability.',
        );
    }
}

function finiteNumber(value: unknown): number | null {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

function integerNumber(value: unknown): number | null {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive safe integer.`);
    }
    return value;
}

function validateExecutable(value: string): string {
    if (!value || value.length > 4_096 || value.includes('\0')) {
        throw new RangeError('FFprobe executable is invalid.');
    }
    return value;
}

function toRenderError(error: unknown): HeadlessRenderError {
    if (error instanceof HeadlessRenderError && error.code !== 'RENDER_FAILED') {
        return error;
    }
    return new HeadlessRenderError(
        'INVALID_OUTPUT',
        error instanceof Error ? error.message : 'FFprobe verification failed.',
        false,
        error instanceof Error ? { cause: error } : undefined,
    );
}
