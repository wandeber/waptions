import type { Readable } from 'node:stream';
import {
    createReadAccounting,
    freezeReadAccounting,
} from '../../media/accounting';
import { ManagedMediaError, throwIfAborted } from '../../media/errors';
import type {
    AudioAnalysisSample,
    BoundedMediaProcessPort,
    ManagedMediaProcessRequest,
    ManagedMediaProcessResult,
    SceneScoreSample,
} from '../../media/process-port';
import {
    collectBoundedProcessOutput,
    NodeBackendProcessTracker,
    NodeBoundedFfmpegProcessRunner,
    type NodeBackendProcessLimits,
} from '../../render/node-ffmpeg-process';
import type { PathGrantMediaAdapter } from './path-grant-media-adapter';

const INPUT_FD = 3;
const OUTPUT_FD = 4;

interface FfprobeArtifact {
    readonly streams?: readonly {
        readonly codec_type?: string;
        readonly codec_name?: string;
        readonly width?: number;
        readonly height?: number;
    }[];
    readonly format?: {
        readonly format_name?: string;
        readonly duration?: string;
        readonly size?: string;
    };
}

export interface ManagedProcessOutputHandle {
    readonly fileDescriptor: number;
    size(signal?: AbortSignal): Promise<number>;
    assertCurrent(signal?: AbortSignal): Promise<void>;
    sync(signal?: AbortSignal): Promise<void>;
    close(): Promise<void>;
}

export interface ManagedProcessOutputResolverPort {
    acquire(
        processOutputCapabilityId: string,
        signal?: AbortSignal,
    ): Promise<ManagedProcessOutputHandle>;
}

export interface NodeBoundedMediaProcessOptions {
    readonly ffmpegExecutable?: string;
    readonly ffprobeExecutable?: string;
    readonly runner?: NodeBoundedFfmpegProcessRunner;
}

/**
 * Production FFmpeg/FFprobe adapter for the modern media process contract.
 *
 * It inherits only coordinator-owned descriptors, never invokes a shell, bounds stdout/stderr,
 * samples aggregate RSS, and waits for child termination before releasing any authority.
 */
export class NodeBoundedMediaProcessPort implements BoundedMediaProcessPort {
    private readonly ffmpegExecutable: string;
    private readonly ffprobeExecutable: string;
    private readonly runner: NodeBoundedFfmpegProcessRunner;

    constructor(
        private readonly inputs: PathGrantMediaAdapter,
        private readonly outputs: ManagedProcessOutputResolverPort,
        options: NodeBoundedMediaProcessOptions = {},
    ) {
        this.ffmpegExecutable = validateExecutable(options.ffmpegExecutable ?? 'ffmpeg');
        this.ffprobeExecutable = validateExecutable(options.ffprobeExecutable ?? 'ffprobe');
        this.runner = options.runner ?? new NodeBoundedFfmpegProcessRunner();
    }

    async execute(
        request: ManagedMediaProcessRequest,
        signal?: AbortSignal,
    ): Promise<ManagedMediaProcessResult> {
        throwIfAborted(signal);
        const input = this.inputs.resolveProcessHandle(request.source.processInputCapabilityId);
        await input.assertCurrent(signal);
        if (request.source.snapshot.byteLength > request.limits.maxInputBytes) {
            throw new ManagedMediaError(
                'RESOURCE_LIMIT_EXCEEDED',
                'Media source exceeds the authorized process input bound.',
            );
        }
        const tracker = new NodeBackendProcessTracker(
            1,
            request.limits.maxResidentBytes,
        );
        const processLimits = toProcessLimits(request);
        let output: ManagedProcessOutputHandle | undefined;
        try {
            if (request.output) {
                output = await this.outputs.acquire(
                    request.output.processOutputCapabilityId,
                    signal,
                );
                await output.assertCurrent(signal);
                if (await output.size(signal) !== 0) {
                    throw new ManagedMediaError(
                        'INTERNAL_ERROR',
                        'Review output staging was not empty.',
                    );
                }
            }
            let executed = await this.runOperation(
                request,
                input.fileHandle.fd,
                output?.fileDescriptor,
                processLimits,
                tracker,
                signal,
            );
            await input.assertCurrent(signal);
            if (output) {
                await output.assertCurrent(signal);
                await output.sync(signal);
                const inspection = await this.inspectArtifact(
                    request,
                    output.fileDescriptor,
                    processLimits,
                    tracker,
                    signal,
                    request.limits.maxStdoutBytes - executed.stdoutBytes,
                    request.limits.maxStderrBytes - executed.stderrBytes,
                );
                executed = {
                    ...executed,
                    stdoutBytes: executed.stdoutBytes + inspection.stdoutBytes,
                    stderrBytes: executed.stderrBytes + inspection.stderrBytes,
                };
            }
            const diagnostics = tracker.snapshot();
            const outputBytes = output ? await output.size(signal) : 0;
            const accounting = processAccounting(
                request,
                executed.stdoutBytes,
                executed.stderrBytes,
                outputBytes,
                diagnostics.peakBackendResidentBytes,
            );
            switch (request.operation.kind) {
                case 'probe':
                    return {
                        kind: 'probe',
                        stdout: executed.stdout,
                        accounting,
                    };
                case 'frame-grid':
                    return { kind: 'frame-grid', accounting };
                case 'audio-analysis':
                    return {
                        kind: 'audio-analysis',
                        samples: parseAudioAnalysis(
                            executed.stdout,
                            request.operation.ranges,
                            request.operation.bucketDurationUs,
                            request.operation.maxBuckets,
                        ),
                        accounting,
                    };
                case 'scene-analysis':
                    return {
                        kind: 'scene-analysis',
                        samples: parseSceneAnalysis(
                            executed.stdout,
                            request.operation.maxSamples,
                        ),
                        accounting,
                    };
                case 'review-proxy':
                    return { kind: 'review-proxy', accounting };
            }
            throw new ManagedMediaError('INTERNAL_ERROR', 'Unknown media process operation.');
        } finally {
            await output?.close().catch(() => undefined);
        }
    }

    private async inspectArtifact(
        request: ManagedMediaProcessRequest,
        outputFd: number,
        limits: NodeBackendProcessLimits,
        tracker: NodeBackendProcessTracker,
        signal: AbortSignal | undefined,
        maximumStdoutBytes: number,
        maximumStderrBytes: number,
    ): Promise<{ stdoutBytes: number; stderrBytes: number }> {
        if (request.operation.kind !== 'frame-grid'
            && request.operation.kind !== 'review-proxy') {
            return { stdoutBytes: 0, stderrBytes: 0 };
        }
        if (maximumStdoutBytes <= 0 || maximumStderrBytes <= 0) {
            throw new ManagedMediaError(
                'RESOURCE_LIMIT_EXCEEDED',
                'Review artifact verification exceeded its output bound.',
            );
        }
        const session = this.runner.start({
            executable: this.ffprobeExecutable,
            args: [
                '-hide_banner',
                '-v', 'error',
                '-show_format',
                '-show_streams',
                '-of', 'json',
                `/dev/fd/${OUTPUT_FD}`,
            ],
            stdio: ['ignore', 'pipe', 'pipe', 'ignore', outputFd],
            limits: {
                ...limits,
                maximumStderrBytes,
            },
            tracker,
            signal,
            maximumStdoutBytes,
        });
        try {
            const [stdout, result] = await Promise.all([
                collectBoundedProcessOutput(
                    session.stdout as Readable | null,
                    maximumStdoutBytes,
                    signal,
                ),
                session.wait(),
            ]);
            validateArtifactInspection(
                request.operation,
                JSON.parse(Buffer.from(stdout).toString('utf8')) as FfprobeArtifact,
            );
            return {
                stdoutBytes: result.stdoutBytes,
                stderrBytes: result.stderrBytes,
            };
        } catch (error) {
            await session.terminate();
            throw error;
        }
    }

    private async runOperation(
        request: ManagedMediaProcessRequest,
        inputFd: number,
        outputFd: number | undefined,
        limits: NodeBackendProcessLimits,
        tracker: NodeBackendProcessTracker,
        signal?: AbortSignal,
    ): Promise<{ stdout: Uint8Array; stdoutBytes: number; stderrBytes: number }> {
        if (request.operation.kind === 'audio-analysis'
            && request.operation.ranges.length > 1) {
            const outputs: Buffer[] = [];
            let stdoutBytes = 0;
            let stderrBytes = 0;
            for (const range of request.operation.ranges) {
                throwIfAborted(signal);
                const remainingStdout = request.limits.maxStdoutBytes - stdoutBytes;
                const remainingStderr = request.limits.maxStderrBytes - stderrBytes;
                if (remainingStdout <= 0 || remainingStderr <= 0) {
                    throw new ManagedMediaError(
                        'RESOURCE_LIMIT_EXCEEDED',
                        'Audio analysis exceeded its combined process output bound.',
                    );
                }
                const result = await this.runOperation({
                    ...request,
                    operation: {
                        ...request.operation,
                        ranges: [range],
                        maxBuckets: Math.ceil(
                            (range.endUs - range.startUs)
                            / request.operation.bucketDurationUs,
                        ),
                    },
                    limits: {
                        ...request.limits,
                        maxStdoutBytes: remainingStdout,
                        maxStderrBytes: remainingStderr,
                    },
                }, inputFd, outputFd, {
                    ...limits,
                    maximumStderrBytes: remainingStderr,
                }, tracker, signal);
                outputs.push(Buffer.from(result.stdout));
                stdoutBytes += result.stdoutBytes;
                stderrBytes += result.stderrBytes;
            }
            return {
                stdout: Buffer.concat(outputs, stdoutBytes),
                stdoutBytes,
                stderrBytes,
            };
        }
        const command = buildCommand(request, outputFd !== undefined);
        const stdio: Array<'ignore' | 'pipe' | number> = [
            'ignore',
            'pipe',
            'pipe',
            inputFd,
        ];
        if (outputFd !== undefined) stdio.push(outputFd);
        const session = this.runner.start({
            executable: request.operation.kind === 'probe'
                ? this.ffprobeExecutable
                : this.ffmpegExecutable,
            args: command,
            stdio,
            limits,
            tracker,
            signal,
            maximumStdoutBytes: request.limits.maxStdoutBytes,
        });
        try {
            const [stdout, result] = await Promise.all([
                collectBoundedProcessOutput(
                    session.stdout as Readable | null,
                    request.limits.maxStdoutBytes,
                    signal,
                ),
                session.wait(),
            ]);
            return {
                stdout,
                stdoutBytes: result.stdoutBytes,
                stderrBytes: result.stderrBytes,
            };
        } catch (error) {
            await session.terminate();
            throw error;
        }
    }
}

function buildCommand(
    request: ManagedMediaProcessRequest,
    hasOutput: boolean,
): readonly string[] {
    const input = `/dev/fd/${INPUT_FD}`;
    const output = `/dev/fd/${OUTPUT_FD}`;
    switch (request.operation.kind) {
        case 'probe':
            return [
                '-hide_banner',
                '-v', 'error',
                '-probesize', String(Math.min(request.limits.maxInputBytes, 64 * 1024 * 1024)),
                '-analyzeduration', '30000000',
                '-show_format',
                '-show_streams',
                '-of', 'json',
                input,
            ];
        case 'frame-grid': {
            assertOutput(hasOutput);
            const frameCount = request.operation.timestampsUs.length;
            const rows = Math.ceil(frameCount / request.operation.columns);
            const filter = [
                `select='(${selectExpression(request.operation.ranges, 't')})*(${selectTimestampsExpression(request.operation.timestampsUs)})'`,
                'setpts=N/FRAME_RATE/TB',
                `scale=${request.operation.cellWidth}:${request.operation.cellHeight}:force_original_aspect_ratio=decrease`,
                `pad=${request.operation.cellWidth}:${request.operation.cellHeight}:(ow-iw)/2:(oh-ih)/2`,
                `tile=${request.operation.columns}x${rows}:nb_frames=${frameCount}`,
            ].join(',');
            return [
                ...ffmpegPrefix(),
                '-i', input,
                '-an',
                '-vf', filter,
                '-frames:v', '1',
                '-c:v', 'libwebp',
                '-lossless', '0',
                '-compression_level', '4',
                '-fs', String(request.limits.maxOutputBytes),
                '-f', 'webp',
                '-y', output,
            ];
        }
        case 'audio-analysis': {
            const [range] = request.operation.ranges;
            if (!range) {
                throw new ManagedMediaError('INVALID_REQUEST', 'Audio analysis range is empty.');
            }
            const seconds = request.operation.bucketDurationUs / 1_000_000;
            return [
                ...ffmpegPrefix(),
                '-i', input,
                '-vn',
                '-af',
                [
                    `atrim=start=${formatNumber(range.startUs / 1_000_000)}:end=${formatNumber(range.endUs / 1_000_000)}`,
                    'asetpts=PTS-STARTPTS',
                    'aformat=sample_fmts=fltp',
                    `asetnsamples=n=${Math.max(1, Math.round(seconds * 48_000))}:p=1`,
                    'astats=metadata=1:reset=1',
                    'ametadata=print:file=-',
                ].join(','),
                '-f', 'null',
                '-',
            ];
        }
        case 'scene-analysis': {
            const timestamps = sampleTimestamps(
                request.operation.ranges,
                request.operation.sampleIntervalUs,
                request.operation.maxSamples,
            );
            return [
                ...ffmpegPrefix(),
                '-i', input,
                '-an',
                '-vf',
                [
                    `select='(${selectExpression(request.operation.ranges, 't')})*(${selectTimestampsExpression(timestamps)})'`,
                    'select=gt(scene\\,0)',
                    `scale=${request.operation.analysisWidth}:-2`,
                    'metadata=print:file=-',
                ].join(','),
                '-frames:v', String(request.operation.maxSamples),
                '-f', 'null',
                '-',
            ];
        }
        case 'review-proxy': {
            assertOutput(hasOutput);
            const operation = request.operation;
            const videoChains = operation.ranges.map((range, index) => (
                `[0:v]trim=start=${formatNumber(range.startUs / 1_000_000)}:end=${formatNumber(range.endUs / 1_000_000)},`
                + 'setpts=PTS-STARTPTS,'
                + `fps=${formatNumber(operation.maxFrameRate)},`
                + `scale=${operation.width}:${operation.height}:force_original_aspect_ratio=decrease,`
                + `pad=${operation.width}:${operation.height}:(ow-iw)/2:(oh-ih)/2,`
                + `format=yuv420p[v${index}]`
            ));
            const videoConcat = `${operation.ranges.map(
                (_range, index) => `[v${index}]`,
            ).join('')}concat=n=${operation.ranges.length}:v=1:a=0[vout]`;
            const audioChains = operation.includeAudio
                ? operation.ranges.map((range, index) => (
                    `[0:a]atrim=start=${formatNumber(range.startUs / 1_000_000)}:end=${formatNumber(range.endUs / 1_000_000)},`
                    + `asetpts=PTS-STARTPTS[a${index}]`
                ))
                : [];
            const audioConcat = operation.includeAudio
                ? `${operation.ranges.map(
                    (_range, index) => `[a${index}]`,
                ).join('')}concat=n=${operation.ranges.length}:v=0:a=1[aout]`
                : undefined;
            const filters = [...videoChains, videoConcat, ...audioChains];
            if (audioConcat) filters.push(audioConcat);
            const audio = operation.includeAudio
                ? ['-map', '[aout]', '-c:a', 'aac', '-b:a', String(operation.audioBitRate)]
                : ['-an'];
            return [
                ...ffmpegPrefix(),
                '-i', input,
                '-filter_complex', filters.join(';'),
                '-map', '[vout]',
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-b:v', String(operation.videoBitRate),
                ...audio,
                '-movflags', '+faststart',
                '-fs', String(request.limits.maxOutputBytes),
                '-f', 'mp4',
                '-y', output,
            ];
        }
    }
}

function processAccounting(
    request: ManagedMediaProcessRequest,
    stdoutBytes: number,
    stderrBytes: number,
    outputBytes: number,
    peakResidentBytes: number,
): ManagedMediaProcessResult['accounting'] {
    // Descriptor-backed FFmpeg I/O cannot expose portable per-fd kernel read counters. Account
    // conservatively for the complete authorized source rather than fabricating a smaller read.
    const inputBytes = request.source.snapshot.byteLength;
    const input = createReadAccounting();
    if (inputBytes > 0) {
        input.totalBytes = inputBytes;
        input.maxChunkBytes = Math.min(inputBytes, request.limits.maxBufferedBytes);
        input.ranges.push({ start: 0, endExclusive: inputBytes });
    }
    return {
        input: freezeReadAccounting(input),
        outputBytes,
        stdoutBytes,
        stderrBytes,
        maxBufferedBytes: Math.min(
            request.limits.maxBufferedBytes,
            Math.max(stdoutBytes, stderrBytes, outputBytes > 0 ? 64 * 1024 : 0),
        ),
        peakResidentBytes,
        // Portable Node APIs cannot prove compressed GOP preroll from an inherited descriptor.
        // Do not attest exact decoded ranges; requested output ranges remain enforced by filters.
        decodedRanges: [],
    };
}

function validateArtifactInspection(
    operation: ManagedMediaProcessRequest['operation'],
    inspection: FfprobeArtifact,
): void {
    if (operation.kind !== 'frame-grid' && operation.kind !== 'review-proxy') return;
    const byteLength = Number(inspection.format?.size);
    const video = inspection.streams?.find((stream) => stream.codec_type === 'video');
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || !video) {
        throw new ManagedMediaError(
            'PROCESS_FAILED',
            'Review process produced an empty or invalid visual artifact.',
        );
    }
    if (operation.kind === 'frame-grid') {
        const expectedWidth = operation.cellWidth * operation.columns;
        const expectedHeight = operation.cellHeight
            * Math.ceil(operation.timestampsUs.length / operation.columns);
        if (video.codec_name !== 'webp'
            || video.width !== expectedWidth
            || video.height !== expectedHeight) {
            throw new ManagedMediaError(
                'PROCESS_FAILED',
                'Review process produced an invalid WebP frame grid.',
            );
        }
        return;
    }
    const expectedDuration = operation.ranges.reduce(
        (sum, range) => sum + (range.endUs - range.startUs) / 1_000_000,
        0,
    );
    const duration = Number(inspection.format?.duration);
    const audio = inspection.streams?.find((stream) => stream.codec_type === 'audio');
    const tolerance = Math.max(0.1, 1 / operation.maxFrameRate);
    if (!inspection.format?.format_name?.split(',').some((name) => name === 'mp4')
        || video.codec_name !== 'h264'
        || video.width !== operation.width
        || video.height !== operation.height
        || !Number.isFinite(duration)
        || Math.abs(duration - expectedDuration) > tolerance
        || (operation.includeAudio && audio?.codec_name !== 'aac')
        || (!operation.includeAudio && audio !== undefined)) {
        throw new ManagedMediaError(
            'PROCESS_FAILED',
            'Review process produced an invalid or temporally inexact MP4 proxy.',
        );
    }
}

function parseAudioAnalysis(
    bytes: Uint8Array,
    ranges: readonly { startUs: number; endUs: number }[],
    bucketDurationUs: number,
    maximum: number,
): readonly AudioAnalysisSample[] {
    const text = Buffer.from(bytes).toString('utf8');
    const blocks = text.split(/(?=frame:\d+)/g);
    const output: AudioAnalysisSample[] = [];
    let cursor = ranges[0]?.startUs ?? 0;
    let rangeIndex = 0;
    for (const block of blocks) {
        if (output.length >= maximum || rangeIndex >= ranges.length) break;
        const minimum = metadataNumber(block, 'lavfi.astats.Overall.Min_level');
        const maximumLevel = metadataNumber(block, 'lavfi.astats.Overall.Max_level');
        const rmsDb = metadataNumber(block, 'lavfi.astats.Overall.RMS_level');
        const peakDb = metadataNumber(block, 'lavfi.astats.Overall.Peak_level');
        if ([minimum, maximumLevel, rmsDb, peakDb].some((value) => value === null)) continue;
        while (rangeIndex < ranges.length && cursor >= ranges[rangeIndex]!.endUs) {
            rangeIndex += 1;
            cursor = ranges[rangeIndex]?.startUs ?? cursor;
        }
        if (rangeIndex >= ranges.length) break;
        const endUs = Math.min(ranges[rangeIndex]!.endUs, cursor + bucketDurationUs);
        output.push({
            startUs: cursor,
            endUs,
            minimum: minimum!,
            maximum: maximumLevel!,
            rmsDb: rmsDb!,
            peakDb: peakDb!,
        });
        cursor = endUs;
    }
    return Object.freeze(output);
}

function parseSceneAnalysis(
    bytes: Uint8Array,
    maximum: number,
): readonly SceneScoreSample[] {
    const text = Buffer.from(bytes).toString('utf8');
    const output: SceneScoreSample[] = [];
    let timeUs: number | null = null;
    for (const line of text.split(/\r?\n/)) {
        const pts = /\bpts_time:([0-9.]+)/.exec(line);
        if (pts) timeUs = Math.round(Number(pts[1]) * 1_000_000);
        const score = /^lavfi\.scene_score=([0-9.]+)/.exec(line);
        if (score && timeUs !== null && output.length < maximum) {
            output.push({ timeUs, score: Number(score[1]) });
        }
    }
    return Object.freeze(output);
}

function metadataNumber(block: string, key: string): number | null {
    const match = new RegExp(`^${escapeRegExp(key)}=([-+0-9.eE]+)$`, 'm').exec(block);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
}

function selectExpression(
    ranges: readonly { startUs: number; endUs: number }[],
    variable: string,
): string {
    return ranges.map((range) => (
        `gte(${variable}\\,${formatNumber(range.startUs / 1_000_000)})*lt(${variable}\\,${formatNumber(range.endUs / 1_000_000)})`
    )).join('+');
}

function selectTimestampsExpression(timestampsUs: readonly number[]): string {
    if (timestampsUs.length === 0) {
        throw new ManagedMediaError('INVALID_REQUEST', 'Frame-grid timestamps are empty.');
    }
    return timestampsUs.map((timestampUs, index) => {
        const timestamp = formatNumber(timestampUs / 1_000_000);
        return index === 0
            ? `isnan(prev_selected_t)*gte(t\\,${timestamp})`
            : `lt(prev_selected_t\\,${timestamp})*gte(t\\,${timestamp})`;
    }).join('+');
}

function sampleTimestamps(
    ranges: readonly { startUs: number; endUs: number }[],
    intervalUs: number,
    maximum: number,
): readonly number[] {
    const output: number[] = [];
    for (const range of ranges) {
        for (
            let timestampUs = range.startUs;
            timestampUs < range.endUs && output.length < maximum;
            timestampUs += intervalUs
        ) {
            output.push(timestampUs);
        }
        if (output.length >= maximum) break;
    }
    if (output.length === 0) {
        throw new ManagedMediaError('INVALID_REQUEST', 'Scene-analysis ranges are empty.');
    }
    return output;
}

function ffmpegPrefix(): readonly string[] {
    return [
        '-hide_banner',
        '-nostdin',
        '-nostats',
        '-loglevel', 'error',
        '-threads', '1',
        '-filter_threads', '1',
        '-filter_complex_threads', '1',
    ];
}

function toProcessLimits(request: ManagedMediaProcessRequest): NodeBackendProcessLimits {
    return {
        maximumProcesses: 1,
        maximumResidentBytes: request.limits.maxResidentBytes,
        maximumStderrBytes: request.limits.maxStderrBytes,
        maximumProgressBytes: 1,
        timeoutMs: request.limits.timeoutMs,
        killGraceMs: request.limits.killGraceMs,
    };
}

function validateExecutable(value: string): string {
    if (!value || value.length > 4_096 || value.includes('\0')) {
        throw new RangeError('Media process executable is invalid.');
    }
    return value;
}

function assertOutput(value: boolean): void {
    if (!value) {
        throw new ManagedMediaError('INTERNAL_ERROR', 'Media process output capability is missing.');
    }
}

function formatNumber(value: number): string {
    if (!Number.isFinite(value)) throw new RangeError('FFmpeg number must be finite.');
    return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
