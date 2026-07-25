import {
    framesPerSecond,
    type ResolvedRenderPlanV1,
} from '../../../src/lib/render-plan';
import type {
    HeadlessRenderBackendDiagnostics,
    HeadlessRenderBackendName,
    HeadlessSourceRangeRead,
    HeadlessStagedOutputCapability,
} from '../../render/contracts';
import {
    collectBoundedProcessOutput,
    NodeBackendProcessTracker,
    NodeBoundedFfmpegProcessRunner,
} from '../../render/node-ffmpeg-process';
import type {
    NodeStagedOutputHandleResolverPort,
} from '../../export/node-staged-output-handle';

const INPUT_FD = 3;
const OUTPUT_FD = 4;
const MAXIMUM_WEBM_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024;

export interface RenderedMp4ScratchLease {
    readonly fileDescriptor: number;
    readonly planId: string;
    readonly backend: HeadlessRenderBackendName;
    readonly warnings: readonly string[];
    readonly sourceRangesRead: readonly HeadlessSourceRangeRead[];
    readonly diagnostics: HeadlessRenderBackendDiagnostics;
    assertCurrent(signal?: AbortSignal): Promise<void>;
    close(): Promise<void>;
}

/** Renders the resolved plan to a private seekable MP4 scratch file, never a user destination. */
export interface Mp4ScratchRenderPort {
    render(
        request: {
            readonly jobId: string;
            readonly plan: ResolvedRenderPlanV1;
            readonly signal?: AbortSignal;
        },
    ): Promise<RenderedMp4ScratchLease>;
}

export interface ManagedWebmRenderResult {
    readonly planId: string;
    readonly backend: HeadlessRenderBackendName;
    readonly warnings: readonly string[];
    readonly sourceRangesRead: readonly HeadlessSourceRangeRead[];
    readonly diagnostics: HeadlessRenderBackendDiagnostics;
    readonly durationSeconds: number;
    readonly videoCodec: 'vp9';
    readonly audioCodec: 'opus';
}

export interface ManagedWebmRenderPort {
    render(request: {
        readonly jobId: string;
        readonly plan: ResolvedRenderPlanV1;
        readonly outputCapability: HeadlessStagedOutputCapability;
        readonly signal?: AbortSignal;
    }): Promise<ManagedWebmRenderResult>;
}

/** Bounded VP9/Opus transcode of the exact resolved-plan MP4 scratch render. */
export class NodeFfmpegWebmRenderPort implements ManagedWebmRenderPort {
    private readonly runner: NodeBoundedFfmpegProcessRunner;
    private readonly ffmpegExecutable: string;
    private readonly ffprobeExecutable: string;

    constructor(
        private readonly scratch: Mp4ScratchRenderPort,
        private readonly outputs: NodeStagedOutputHandleResolverPort,
        options: {
            readonly runner?: NodeBoundedFfmpegProcessRunner;
            readonly ffmpegExecutable?: string;
            readonly ffprobeExecutable?: string;
        } = {},
    ) {
        this.runner = options.runner ?? new NodeBoundedFfmpegProcessRunner();
        this.ffmpegExecutable = validateExecutable(options.ffmpegExecutable ?? 'ffmpeg');
        this.ffprobeExecutable = validateExecutable(options.ffprobeExecutable ?? 'ffprobe');
    }

    async render(
        request: Parameters<ManagedWebmRenderPort['render']>[0],
    ): Promise<ManagedWebmRenderResult> {
        const scratch = await this.scratch.render({
            jobId: request.jobId,
            plan: request.plan,
            signal: request.signal,
        });
        let output: Awaited<ReturnType<NodeStagedOutputHandleResolverPort['acquire']>> | undefined;
        const limits = {
            maximumProcesses: 1,
            maximumResidentBytes: 1024 * 1024 * 1024,
            maximumStderrBytes: 1024 * 1024,
            maximumProgressBytes: 1,
            timeoutMs: 2 * 60 * 60_000,
            killGraceMs: 1_000,
        };
        let transcodePeakResidentBytes = 0;
        let transcodePeakProcesses = 0;
        try {
            output = await this.outputs.acquire(
                request.outputCapability,
                'read-write',
                request.signal,
            );
            await scratch.assertCurrent(request.signal);
            await output.assertCurrent(request.signal);
            if (await output.size(request.signal) !== 0) {
                throw new Error('WebM destination staging is not empty.');
            }
            const tracker = new NodeBackendProcessTracker(
                limits.maximumProcesses,
                limits.maximumResidentBytes,
            );
            const session = this.runner.start({
                executable: this.ffmpegExecutable,
                args: [
                    '-hide_banner',
                    '-nostdin',
                    '-nostats',
                    '-loglevel', 'error',
                    '-threads', '1',
                    '-i', `/dev/fd/${INPUT_FD}`,
                    '-map', '0:v:0',
                    '-map', '0:a:0',
                    '-c:v', 'libvpx-vp9',
                    '-crf', '30',
                    '-b:v', '0',
                    '-pix_fmt', 'yuv420p',
                    '-row-mt', '1',
                    '-threads:v', '1',
                    '-c:a', 'libopus',
                    '-b:a', '160k',
                    '-ar', '48000',
                    '-ac', '2',
                    '-fs', String(MAXIMUM_WEBM_OUTPUT_BYTES),
                    '-f', 'webm',
                    '-y', `/dev/fd/${OUTPUT_FD}`,
                ],
                stdio: [
                    'ignore',
                    'ignore',
                    'pipe',
                    scratch.fileDescriptor,
                    output.fileDescriptor,
                ],
                limits,
                tracker,
                signal: request.signal,
            });
            await session.wait();
            const processDiagnostics = tracker.snapshot();
            transcodePeakResidentBytes = processDiagnostics.peakBackendResidentBytes;
            transcodePeakProcesses = processDiagnostics.peakBackendProcesses;
            await output.sync(request.signal);
            await output.assertCurrent(request.signal);
            await scratch.assertCurrent(request.signal);
        } finally {
            await Promise.allSettled([
                output?.close() ?? Promise.resolve(),
                scratch.close(),
            ]);
        }
        const inspection = await this.inspect(request.outputCapability, request.signal);
        const expectedDuration = request.plan.contentEndFrame
            / framesPerSecond(request.plan.renderProfile.fps);
        const durationTolerance = 1 / framesPerSecond(request.plan.renderProfile.fps);
        if (inspection.videoFrameCount !== request.plan.contentEndFrame
            || Math.abs(inspection.durationSeconds - expectedDuration)
                > durationTolerance + Number.EPSILON) {
            throw new Error(
                `Staged WebM differs from the resolved render boundary (${inspection.videoFrameCount}/${request.plan.contentEndFrame} frames, ${inspection.durationSeconds}/${expectedDuration} seconds).`,
            );
        }
        const peakBackendResidentBytes = Math.max(
            scratch.diagnostics.peakBackendResidentBytes ?? 0,
            transcodePeakResidentBytes,
            inspection.peakResidentBytes,
        );
        const peakBackendProcesses = Math.max(
            scratch.diagnostics.peakBackendProcesses ?? 0,
            transcodePeakProcesses,
            inspection.peakProcesses,
        );
        return {
            planId: request.plan.planId,
            backend: scratch.backend,
            warnings: [...scratch.warnings],
            sourceRangesRead: [...scratch.sourceRangesRead],
            diagnostics: {
                ...scratch.diagnostics,
                peakBackendResidentBytes,
                peakBackendProcesses,
            },
            durationSeconds: inspection.durationSeconds,
            videoCodec: 'vp9',
            audioCodec: 'opus',
        };
    }

    private async inspect(
        capability: HeadlessStagedOutputCapability,
        signal?: AbortSignal,
    ): Promise<{
        durationSeconds: number;
        videoFrameCount: number;
        peakResidentBytes: number;
        peakProcesses: number;
    }> {
        const output = await this.outputs.acquire(capability, 'read-only', signal);
        const limits = {
            maximumProcesses: 1,
            maximumResidentBytes: 256 * 1024 * 1024,
            maximumStderrBytes: 256 * 1024,
            maximumProgressBytes: 1,
            timeoutMs: 30_000,
            killGraceMs: 1_000,
        };
        try {
            const tracker = new NodeBackendProcessTracker(1, limits.maximumResidentBytes);
            const session = this.runner.start({
                executable: this.ffprobeExecutable,
                args: [
                    '-hide_banner',
                    '-v', 'error',
                    '-count_frames',
                    '-show_entries',
                    'format=format_name,duration:stream=codec_type,codec_name,pix_fmt,sample_rate,channels,nb_read_frames',
                    '-of', 'json',
                    `/dev/fd/${INPUT_FD}`,
                ],
                stdio: ['ignore', 'pipe', 'pipe', output.fileDescriptor],
                limits,
                tracker,
                signal,
                maximumStdoutBytes: 1024 * 1024,
            });
            let stdout: Buffer;
            try {
                [stdout] = await Promise.all([
                    collectBoundedProcessOutput(session.stdout, 1024 * 1024, signal),
                    session.wait(),
                ]);
            } catch (error) {
                await session.terminate();
                throw error;
            }
            const parsed = JSON.parse(Buffer.from(stdout).toString('utf8')) as {
                format?: { format_name?: unknown; duration?: unknown };
                streams?: Array<{
                    codec_type?: unknown;
                    codec_name?: unknown;
                    pix_fmt?: unknown;
                    sample_rate?: unknown;
                    channels?: unknown;
                    nb_read_frames?: unknown;
                }>;
            };
            const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
            const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
            const durationSeconds = Number(parsed.format?.duration);
            const videoFrameCount = Number(video?.nb_read_frames);
            if (!String(parsed.format?.format_name ?? '').split(',').includes('webm')
                || video?.codec_name !== 'vp9'
                || audio?.codec_name !== 'opus'
                || video.pix_fmt !== 'yuv420p'
                || Number(audio.sample_rate) !== 48_000
                || Number(audio.channels) !== 2
                || !Number.isSafeInteger(videoFrameCount)
                || videoFrameCount <= 0
                || !Number.isFinite(durationSeconds)
                || durationSeconds <= 0) {
                throw new Error('FFprobe rejected the staged VP9/Opus WebM.');
            }
            const diagnostics = tracker.snapshot();
            return {
                durationSeconds,
                videoFrameCount,
                peakResidentBytes: diagnostics.peakBackendResidentBytes,
                peakProcesses: diagnostics.peakBackendProcesses,
            };
        } finally {
            await output.close();
        }
    }
}

function validateExecutable(value: string): string {
    if (!value || value.length > 4_096 || value.includes('\0')) {
        throw new RangeError('FFmpeg executable is invalid.');
    }
    return value;
}
