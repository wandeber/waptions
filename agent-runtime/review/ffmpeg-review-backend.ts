import { VERIFIED_INPUT_PLACEHOLDER } from '../media/node-process-port';
import type {
    FfmpegReviewBackendOptions,
    ReviewBackendPort,
    ReviewBackendRequest,
    ReviewBackendResult,
} from './contracts';

const PROCESS_OUTPUT_LIMIT = 1024 * 1024;

export class FfmpegReviewBackend implements ReviewBackendPort {
    readonly algorithmVersion: string;

    constructor(private readonly options: FfmpegReviewBackendOptions) {
        if (!options.toolchainVersion.trim()) {
            throw new Error('FFmpeg review requires a non-empty toolchain version.');
        }
        this.algorithmVersion = `ffmpeg:${options.toolchainVersion}`;
    }

    async run(request: ReviewBackendRequest): Promise<ReviewBackendResult> {
        const command = buildReviewCommand(request);
        const result = await this.options.processes.run({
            executable: this.options.ffmpegExecutable,
            args: command,
            inputHandle: request.handle,
            stdoutLimitBytes: PROCESS_OUTPUT_LIMIT,
            stderrLimitBytes: PROCESS_OUTPUT_LIMIT,
            timeoutMs: request.kind === 'proxy' ? 30 * 60_000 : 5 * 60_000,
            signal: request.signal,
        });
        if (request.kind === 'silence-speech') {
            return { structuredData: parseSilenceMap(result.stderr, request.range) };
        }
        if (request.kind === 'scene-cuts') {
            return {
                structuredData: parseSceneCuts(
                    result.stderr,
                    request.parameters.maximumFrames,
                    request.range.startSeconds,
                ),
            };
        }
        if (request.kind === 'audio-map') {
            return {
                structuredData: parseAudioMap(
                    result.stdout,
                    request.parameters.maximumFrames,
                    request.range.startSeconds,
                ),
            };
        }
        return {};
    }
}

export function buildReviewCommand(request: ReviewBackendRequest): readonly string[] {
    if (!Number.isSafeInteger(request.maximumOutputBytes) || request.maximumOutputBytes <= 0) {
        throw new RangeError('Review output limit must be a positive safe integer.');
    }
    const rangeArgs = [
        '-ss', formatSeconds(request.range.startSeconds),
        '-t', formatSeconds(request.range.endSeconds - request.range.startSeconds),
    ];
    const common = [
        '-hide_banner',
        '-nostdin',
        '-threads', '1',
        '-filter_threads', '1',
        '-filter_complex_threads', '1',
        ...rangeArgs,
        '-i', VERIFIED_INPUT_PLACEHOLDER,
    ];
    const frameInterval = Math.max(
        0.001,
        (request.range.endSeconds - request.range.startSeconds)
            / request.parameters.maximumFrames,
    );
    switch (request.kind) {
        case 'contact-sheet': {
            const columns = Math.max(1, Math.ceil(Math.sqrt(request.parameters.maximumFrames)));
            const rows = Math.max(1, Math.ceil(request.parameters.maximumFrames / columns));
            return [
                ...common,
                '-an',
                '-vf',
                `fps=1/${formatSeconds(frameInterval)},scale=${request.parameters.thumbnailWidth}:-2,tile=${columns}x${rows}`,
                '-frames:v', '1',
                '-fs', String(request.maximumOutputBytes),
                '-y', request.stagingPath,
            ];
        }
        case 'thumbnail-strip':
            return [
                ...common,
                '-an',
                '-vf',
                `fps=1/${formatSeconds(frameInterval)},scale=${request.parameters.thumbnailWidth}:-2,tile=${request.parameters.maximumFrames}x1`,
                '-frames:v', '1',
                '-fs', String(request.maximumOutputBytes),
                '-y', request.stagingPath,
            ];
        case 'waveform':
            return [
                ...common,
                '-filter_complex',
                '[0:a:0]aformat=channel_layouts=mono,showwavespic=s=1600x320:colors=0x38bdf8[wave]',
                '-map', '[wave]',
                '-frames:v', '1',
                '-fs', String(request.maximumOutputBytes),
                '-y', request.stagingPath,
            ];
        case 'audio-map':
            {
                const samplesPerPoint = Math.max(1, Math.ceil(
                    (request.range.endSeconds - request.range.startSeconds)
                        * (request.metadata.audio?.sampleRate ?? 48_000)
                        / request.parameters.maximumFrames,
                ));
                return [
                    ...common,
                    '-vn',
                    '-af',
                    `asetnsamples=n=${samplesPerPoint}:p=1,astats=metadata=1:reset=1,ametadata=print:file=-`,
                    '-f', 'null',
                    '-',
                ];
            }
        case 'silence-speech':
            return [
                ...common,
                '-vn',
                '-af',
                `silencedetect=noise=${request.parameters.silenceThresholdDb}dB:d=${formatSeconds(request.parameters.minimumSilenceSeconds)}`,
                '-f', 'null',
                '-',
            ];
        case 'scene-cuts':
            return [
                ...common,
                '-an',
                '-vf', `select='gt(scene,${request.parameters.sceneThreshold})',showinfo`,
                '-frames:v', String(request.parameters.maximumFrames),
                '-f', 'null',
                '-',
            ];
        case 'proxy': {
            const audioArgs = request.metadata.audio
                ? ['-c:a', 'aac', '-b:a', '128k']
                : ['-an'];
            return [
                ...common,
                '-vf', `scale='min(${request.parameters.proxyWidth},iw)':-2`,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '24',
                ...audioArgs,
                '-movflags', '+faststart',
                '-max_muxing_queue_size', '128',
                '-fs', String(request.maximumOutputBytes),
                '-y', request.stagingPath,
            ];
        }
    }
}

function parseSilenceMap(stderr: string, range: { startSeconds: number; endSeconds: number }) {
    const events: Array<{ type: 'silence-start' | 'silence-end'; seconds: number }> = [];
    const pattern = /silence_(start|end):\s*([0-9.]+)/g;
    for (const match of Array.from(stderr.matchAll(pattern))) {
        events.push({
            type: match[1] === 'start' ? 'silence-start' : 'silence-end',
            seconds: range.startSeconds + Number(match[2]),
        });
    }
    return { range, events };
}

function parseSceneCuts(stderr: string, maximum: number, sourceOffsetSeconds: number) {
    const seconds = Array.from(stderr.matchAll(/pts_time:([0-9.]+)/g))
        .slice(0, maximum)
        .map((match) => sourceOffsetSeconds + Number(match[1]));
    return { sceneCutSeconds: seconds };
}

function parseAudioMap(stdout: string, maximum: number, sourceOffsetSeconds: number) {
    const points: Array<{ seconds: number; rmsDb: number }> = [];
    let seconds: number | null = null;
    for (const line of stdout.split(/\r?\n/)) {
        const timestamp = /pts_time:([0-9.]+)/.exec(line);
        if (timestamp) seconds = Number(timestamp[1]);
        const rms = /lavfi\.astats\.Overall\.RMS_level=([-0-9.]+)/.exec(line);
        if (rms && seconds !== null && points.length < maximum) {
            points.push({ seconds: sourceOffsetSeconds + seconds, rmsDb: Number(rms[1]) });
        }
    }
    return { points };
}

function formatSeconds(value: number): string {
    return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}
