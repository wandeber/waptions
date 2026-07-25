import type {
    ManagedProcessPort,
    MediaProbePort,
    ProbedAudioStream,
    ProbedMediaMetadata,
    ProbedVideoStream,
    VerifiedOpenMediaHandle,
} from './contracts';
import { VERIFIED_INPUT_PLACEHOLDER } from './node-process-port';

interface FfprobeJsonStream {
    readonly index?: unknown;
    readonly codec_type?: unknown;
    readonly codec_name?: unknown;
    readonly width?: unknown;
    readonly height?: unknown;
    readonly avg_frame_rate?: unknown;
    readonly r_frame_rate?: unknown;
    readonly sample_rate?: unknown;
    readonly channels?: unknown;
    readonly duration?: unknown;
}

interface FfprobeJson {
    readonly streams?: unknown;
    readonly format?: {
        readonly format_name?: unknown;
        readonly duration?: unknown;
        readonly bit_rate?: unknown;
    };
}

export class FfprobeMediaProbePort implements MediaProbePort {
    constructor(
        private readonly processes: ManagedProcessPort,
        private readonly ffprobeExecutable: string,
    ) {}

    async probe(
        handle: VerifiedOpenMediaHandle,
        signal?: AbortSignal,
    ): Promise<ProbedMediaMetadata> {
        const result = await this.processes.run({
            executable: this.ffprobeExecutable,
            args: [
                '-v', 'error',
                '-show_format',
                '-show_streams',
                '-of', 'json',
                VERIFIED_INPUT_PLACEHOLDER,
            ],
            inputHandle: handle.handle,
            stdoutLimitBytes: 1024 * 1024,
            stderrLimitBytes: 256 * 1024,
            timeoutMs: 60_000,
            signal,
        });
        return parseFfprobeMetadata(result.stdout);
    }
}

export function parseFfprobeMetadata(json: string): ProbedMediaMetadata {
    let parsed: FfprobeJson;
    try {
        parsed = JSON.parse(json) as FfprobeJson;
    } catch (error) {
        throw new Error('ffprobe returned malformed JSON.', { cause: error });
    }
    const streams = Array.isArray(parsed.streams)
        ? parsed.streams.filter((value): value is FfprobeJsonStream => (
            value !== null && typeof value === 'object'
        ))
        : [];
    const videoValue = streams.find((stream) => stream.codec_type === 'video');
    const audioValue = streams.find((stream) => stream.codec_type === 'audio');
    const video = videoValue ? normalizeVideoStream(videoValue) : null;
    const audio = audioValue ? normalizeAudioStream(audioValue) : null;
    const duration = finiteNonNegative(parsed.format?.duration)
        ?? video?.durationSeconds
        ?? audio?.durationSeconds
        ?? 0;
    return Object.freeze({
        container: optionalString(parsed.format?.format_name),
        durationSeconds: duration,
        bitrate: finiteNonNegative(parsed.format?.bit_rate),
        video,
        audio,
    });
}

function normalizeVideoStream(value: FfprobeJsonStream): ProbedVideoStream {
    const width = positiveInteger(value.width);
    const height = positiveInteger(value.height);
    if (width === null || height === null) {
        throw new Error('ffprobe video dimensions are missing or invalid.');
    }
    return Object.freeze({
        streamIndex: nonNegativeInteger(value.index) ?? 0,
        codec: optionalString(value.codec_name),
        width,
        height,
        frameRate: parseFrameRate(value.avg_frame_rate) ?? parseFrameRate(value.r_frame_rate),
        durationSeconds: finiteNonNegative(value.duration),
    });
}

function normalizeAudioStream(value: FfprobeJsonStream): ProbedAudioStream {
    return Object.freeze({
        streamIndex: nonNegativeInteger(value.index) ?? 0,
        codec: optionalString(value.codec_name),
        sampleRate: positiveInteger(value.sample_rate),
        channelCount: positiveInteger(value.channels),
        durationSeconds: finiteNonNegative(value.duration),
    });
}

function parseFrameRate(value: unknown): number | null {
    if (typeof value !== 'string') return finitePositive(value);
    const match = /^(\d+)\/(\d+)$/.exec(value);
    if (match) {
        const denominator = Number(match[2]);
        return denominator > 0 ? finitePositive(Number(match[1]) / denominator) : null;
    }
    return finitePositive(value);
}

function optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function finitePositive(value: unknown): number | null {
    const number = typeof value === 'string' ? Number(value) : value;
    return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegative(value: unknown): number | null {
    const number = typeof value === 'string' ? Number(value) : value;
    return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveInteger(value: unknown): number | null {
    const number = finitePositive(value);
    return number !== null && Number.isSafeInteger(number) ? number : null;
}

function nonNegativeInteger(value: unknown): number | null {
    const number = finiteNonNegative(value);
    return number !== null && Number.isSafeInteger(number) ? number : null;
}
