import type { ResolvedVideoSegmentV1 } from '../../src/lib/render-plan';
import { HeadlessRenderError } from './contracts';

export const FFMPEG_SOURCE_FD = 3;
export const FFMPEG_AUDIO_FD = 3;
export const FFMPEG_OUTPUT_FD = 4;
export const FFMPEG_PROGRESS_FD = 5;

export interface FfmpegEncoderCommand {
    args: readonly string[];
    stdio: ReadonlyArray<'ignore' | 'pipe' | number>;
}
export function buildFfmpegVideoDecoderArgs(input: {
    segment: ResolvedVideoSegmentV1;
    outputWidth: number;
    outputHeight: number;
    fpsNumerator: number;
    fpsDenominator: number;
    backgroundColor: string;
}): readonly string[] {
    const {
        segment,
        outputWidth,
        outputHeight,
        fpsNumerator,
        fpsDenominator,
    } = input;
    validatePositiveInteger(outputWidth, 'outputWidth');
    validatePositiveInteger(outputHeight, 'outputHeight');
    validatePositiveInteger(fpsNumerator, 'fpsNumerator');
    validatePositiveInteger(fpsDenominator, 'fpsDenominator');
    validateCanonicalColor(input.backgroundColor);
    validateFiniteNonNegative(segment.sourceStartSeconds, 'sourceStartSeconds');
    validateFinitePositive(segment.sourceSecondsPerOutputFrame, 'sourceSecondsPerOutputFrame');
    const frameCount = segment.outputEndFrame - segment.outputStartFrame;
    validatePositiveInteger(frameCount, 'video segment frame count');
    const contain = roundContainRectangle(
        segment.contain,
        outputWidth,
        outputHeight,
    );
    const speed = segment.sourceSecondsPerOutputFrame * fpsNumerator / fpsDenominator;
    validateFinitePositive(speed, 'video source speed');
    const filter = [
        `setpts=(PTS-STARTPTS)/${formatFfmpegNumber(speed)}`,
        `fps=fps=${fpsNumerator}/${fpsDenominator}:start_time=0:round=near`,
        `scale=${contain.width}:${contain.height}:flags=bicubic`,
        'setsar=1',
        `pad=${outputWidth}:${outputHeight}:${contain.x}:${contain.y}:color=0x${input.backgroundColor.slice(1)}`,
        'format=pix_fmts=rgba',
    ].join(',');
    return [
        '-hide_banner',
        '-nostdin',
        '-nostats',
        '-loglevel', 'error',
        '-threads', '1',
        '-filter_threads', '1',
        '-filter_complex_threads', '1',
        '-ss', formatFfmpegNumber(segment.sourceStartSeconds),
        '-i', inheritedFdPath(FFMPEG_SOURCE_FD),
        '-map', '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-vf', filter,
        '-frames:v', String(frameCount),
        '-pix_fmt', 'rgba',
        '-f', 'rawvideo',
        'pipe:1',
    ];
}

export function buildFfmpegAudioMetadataArgs(): readonly string[] {
    return [
        '-hide_banner',
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=sample_rate,channels',
        '-of', 'json',
        inheritedFdPath(FFMPEG_SOURCE_FD),
    ];
}

export function buildFfmpegAudioDecoderArgs(input: {
    startSample: number;
    endSample: number;
}): readonly string[] {
    validateNonNegativeInteger(input.startSample, 'startSample');
    validatePositiveInteger(input.endSample, 'endSample');
    if (input.endSample <= input.startSample) {
        throw new HeadlessRenderError(
            'INVALID_SNAPSHOT',
            'The FFmpeg audio decode interval must be non-empty.',
        );
    }
    const filter = `atrim=start_sample=${input.startSample}:end_sample=${input.endSample},asetpts=PTS-STARTPTS`;
    return [
        '-hide_banner',
        '-nostdin',
        '-nostats',
        '-loglevel', 'error',
        '-threads', '1',
        '-filter_threads', '1',
        '-filter_complex_threads', '1',
        '-i', inheritedFdPath(FFMPEG_SOURCE_FD),
        '-map', '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-af', filter,
        '-c:a', 'pcm_f32le',
        '-f', 'f32le',
        'pipe:1',
    ];
}

export function buildFfmpegEncoderArgs(input: {
    width: number;
    height: number;
    fpsNumerator: number;
    fpsDenominator: number;
    frameCount: number;
    outputSampleCount: number;
    maximumOutputBytes: number;
}): readonly string[] {
    validatePositiveInteger(input.width, 'width');
    validatePositiveInteger(input.height, 'height');
    validatePositiveInteger(input.fpsNumerator, 'fpsNumerator');
    validatePositiveInteger(input.fpsDenominator, 'fpsDenominator');
    validatePositiveInteger(input.frameCount, 'frameCount');
    validatePositiveInteger(input.outputSampleCount, 'outputSampleCount');
    validatePositiveInteger(input.maximumOutputBytes, 'maximumOutputBytes');
    if (input.width % 2 !== 0 || input.height % 2 !== 0) {
        throw new HeadlessRenderError(
            'INVALID_SNAPSHOT',
            'H.264/yuv420p output dimensions must be even.',
        );
    }
    return [
        '-hide_banner',
        '-nostdin',
        '-nostats',
        '-loglevel', 'error',
        '-threads', '1',
        '-filter_threads', '1',
        '-filter_complex_threads', '1',
        '-f', 'rawvideo',
        '-pix_fmt', 'rgba',
        '-video_size', `${input.width}x${input.height}`,
        '-framerate', `${input.fpsNumerator}/${input.fpsDenominator}`,
        '-i', 'pipe:0',
        '-f', 'f32le',
        '-ar', '48000',
        '-ac', '2',
        '-i', inheritedFdPath(FFMPEG_AUDIO_FD),
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-frames:v', String(input.frameCount),
        '-af', `atrim=end_sample=${input.outputSampleCount},asetpts=N/SR/TB`,
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-threads:v', '1',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '48000',
        '-ac', '2',
        '-threads:a', '1',
        '-max_muxing_queue_size', '128',
        '-progress', `pipe:${FFMPEG_PROGRESS_FD}`,
        '-fs', String(input.maximumOutputBytes),
        '-f', 'mp4',
        '-y',
        inheritedFdPath(FFMPEG_OUTPUT_FD),
    ];
}

export function buildFfmpegCapabilityArgs(kind: 'encoders' | 'muxers'): readonly string[] {
    return ['-hide_banner', `-${kind}`];
}

export function inheritedFdPath(childFileDescriptor: number): string {
    if (!Number.isSafeInteger(childFileDescriptor) || childFileDescriptor < 3) {
        throw new RangeError('Inherited child file descriptors must be safe integers of at least 3.');
    }
    return `/dev/fd/${childFileDescriptor}`;
}

export function formatFfmpegNumber(value: number): string {
    if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
        throw new RangeError('FFmpeg numeric arguments must be finite and bounded.');
    }
    const formatted = value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
    return formatted === '-0' ? '0' : formatted;
}

function roundContainRectangle(
    contain: ResolvedVideoSegmentV1['contain'],
    outputWidth: number,
    outputHeight: number,
): { x: number; y: number; width: number; height: number } {
    const values = [contain.x, contain.y, contain.width, contain.height];
    if (values.some((value) => !Number.isFinite(value))) {
        throw new HeadlessRenderError(
            'INVALID_SNAPSHOT',
            'The resolved contain rectangle is invalid.',
        );
    }
    // Rounding both edges avoids cumulative drift when Core produced fractional contain geometry.
    const left = Math.max(0, Math.round(contain.x));
    const top = Math.max(0, Math.round(contain.y));
    const right = Math.min(outputWidth, Math.round(contain.x + contain.width));
    const bottom = Math.min(outputHeight, Math.round(contain.y + contain.height));
    if (right <= left || bottom <= top) {
        throw new HeadlessRenderError(
            'INVALID_SNAPSHOT',
            'The resolved contain rectangle has no output pixels.',
        );
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function validateCanonicalColor(value: string): void {
    if (!/^#[0-9a-f]{6}$/.test(value)) {
        throw new HeadlessRenderError(
            'INVALID_SNAPSHOT',
            'The resolved background color must be canonical lowercase hexadecimal.',
        );
    }
}

function validatePositiveInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new HeadlessRenderError('INVALID_SNAPSHOT', `${label} must be a positive safe integer.`);
    }
}

function validateNonNegativeInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new HeadlessRenderError(
            'INVALID_SNAPSHOT',
            `${label} must be a non-negative safe integer.`,
        );
    }
}

function validateFinitePositive(value: number, label: string): void {
    if (!Number.isFinite(value) || value <= 0) {
        throw new HeadlessRenderError('INVALID_SNAPSHOT', `${label} must be finite and positive.`);
    }
}

function validateFiniteNonNegative(value: number, label: string): void {
    if (!Number.isFinite(value) || value < 0) {
        throw new HeadlessRenderError(
            'INVALID_SNAPSHOT',
            `${label} must be finite and non-negative.`,
        );
    }
}
