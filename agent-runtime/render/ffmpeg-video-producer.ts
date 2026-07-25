import type { Writable } from 'node:stream';
import type {
    HeadlessMediaIdentity,
    ResolvedRenderPlanV1,
    ResolvedVideoSegmentV1,
    VerifiedRenderMediaSourceSet,
} from '../../src/lib/render-plan';
import {
    HeadlessRenderError,
    throwIfAborted,
    type HeadlessRenderBackendProgress,
    type HeadlessSourceRangeRead,
} from './contracts';
import { buildFfmpegVideoDecoderArgs } from './ffmpeg-command';
import type { ImmutableSourceHandleResolverPort } from './node-ffmpeg-handles';
import {
    NodeBackendProcessTracker,
    NodeBoundedFfmpegProcessRunner,
    writeProcessInput,
    type NodeBackendProcessLimits,
} from './node-ffmpeg-process';

export interface FfmpegVideoProductionRequest {
    plan: ResolvedRenderPlanV1;
    mediaSources: VerifiedRenderMediaSourceSet;
    sourceHandles: ImmutableSourceHandleResolverPort;
    processes: NodeBoundedFfmpegProcessRunner;
    tracker: NodeBackendProcessTracker;
    ffmpegExecutable: string;
    processLimits: NodeBackendProcessLimits;
    encoderInput: Writable | null;
    maximumDecodedPixelBytes: number;
    signal?: AbortSignal;
    onProgress?: (progress: HeadlessRenderBackendProgress) => void;
}
export interface FfmpegVideoProductionResult {
    sourceRangesRead: HeadlessSourceRangeRead[];
    peakDecodedPixelBytes: number;
    peakVideoDecoderSessions: number;
    canvasFrames: number;
}

export async function produceResolvedVideoFrames(
    request: FfmpegVideoProductionRequest,
): Promise<FfmpegVideoProductionResult> {
    const frameBytes = checkedMultiply(
        request.plan.renderProfile.width,
        request.plan.renderProfile.height,
        4,
    );
    if (frameBytes > request.maximumDecodedPixelBytes) {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'The decoded-pixel budget cannot hold one RGBA output frame.',
        );
    }
    validateSegmentCoverage(request.plan);
    const backgroundFrame = createBackgroundFrame(
        frameBytes,
        request.plan.backgroundColor,
    );
    const ranges: HeadlessSourceRangeRead[] = [];
    let completedFrames = 0;
    let peakVideoDecoderSessions = 0;

    for (const segment of request.plan.videoSegments) {
        throwIfAborted(request.signal);
        const frameCount = segment.outputEndFrame - segment.outputStartFrame;
        if (segment.kind === 'background') {
            for (let index = 0; index < frameCount; index += 1) {
                await writeProcessInput(
                    request.encoderInput,
                    backgroundFrame,
                    request.signal,
                );
                completedFrames += 1;
                reportProgress(request, completedFrames);
            }
            continue;
        }
        peakVideoDecoderSessions = 1;
        await decodeVideoSegment(
            request,
            segment,
            frameBytes,
            (frame) => writeProcessInput(
                request.encoderInput,
                frame,
                request.signal,
            ).then(() => {
                completedFrames += 1;
                reportProgress(request, completedFrames);
            }),
        );
        ranges.push({
            sourceId: segment.sourceId,
            sourceKind: 'video',
            kind: 'video-seconds',
            start: segment.sourceStartSeconds,
            end: Math.min(
                segment.sourceEndSeconds,
                segment.sourceStartSeconds
                    + frameCount * segment.sourceSecondsPerOutputFrame,
            ),
        });
    }
    if (completedFrames !== request.plan.contentEndFrame) {
        throw new HeadlessRenderError(
            'RENDER_FAILED',
            'Resolved video production did not cover the exact output frame interval.',
        );
    }
    return {
        sourceRangesRead: coalesceVideoRanges(ranges),
        peakDecodedPixelBytes: frameBytes,
        peakVideoDecoderSessions,
        canvasFrames: 1,
    };
}

async function decodeVideoSegment(
    request: FfmpegVideoProductionRequest,
    segment: ResolvedVideoSegmentV1,
    frameBytes: number,
    onFrame: (frame: Uint8Array) => Promise<void>,
): Promise<void> {
    const source = request.plan.sources.find((candidate) => (
        candidate.kind === 'video' && candidate.sourceId === segment.sourceId
    ));
    if (!source) {
        throw new HeadlessRenderError(
            'SOURCE_CHANGED',
            'A resolved video segment references an unknown immutable source.',
        );
    }
    const handle = await request.sourceHandles.acquire(
        request.mediaSources,
        source,
        request.signal,
    );
    try {
        assertAcquiredSource(source, handle.identity, handle.fileDescriptor);
        await handle.assertCurrent(request.signal);
        throwIfAborted(request.signal);
        const expectedFrames = segment.outputEndFrame - segment.outputStartFrame;
        const expectedBytes = checkedMultiply(expectedFrames, frameBytes);
        const session = request.processes.start({
            executable: request.ffmpegExecutable,
            args: buildFfmpegVideoDecoderArgs({
                segment,
                outputWidth: request.plan.renderProfile.width,
                outputHeight: request.plan.renderProfile.height,
                fpsNumerator: request.plan.renderProfile.fps.numerator,
                fpsDenominator: request.plan.renderProfile.fps.denominator,
                backgroundColor: request.plan.backgroundColor,
            }),
            stdio: ['ignore', 'pipe', 'pipe', handle.fileDescriptor],
            limits: request.processLimits,
            tracker: request.tracker,
            signal: request.signal,
            maximumStdoutBytes: expectedBytes,
        });
        let emittedFrames = 0;
        let frameOffset = 0;
        const frame = Buffer.allocUnsafe(frameBytes);
        try {
            if (!session.stdout) {
                throw new HeadlessRenderError(
                    'RENDER_FAILED',
                    'The FFmpeg source decoder did not expose RGBA output.',
                );
            }
            for await (const value of session.stdout) {
                throwIfAborted(request.signal);
                const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
                let chunkOffset = 0;
                while (chunkOffset < chunk.byteLength) {
                    const copied = Math.min(
                        frameBytes - frameOffset,
                        chunk.byteLength - chunkOffset,
                    );
                    chunk.copy(frame, frameOffset, chunkOffset, chunkOffset + copied);
                    frameOffset += copied;
                    chunkOffset += copied;
                    if (frameOffset === frameBytes) {
                        await onFrame(frame);
                        emittedFrames += 1;
                        frameOffset = 0;
                    }
                }
            }
            await session.wait();
        } catch (error) {
            await session.terminate(toRenderError(error));
            throw error;
        }
        await handle.assertCurrent(request.signal);
        if (frameOffset !== 0 || emittedFrames !== expectedFrames) {
            throw new HeadlessRenderError(
                'RENDER_FAILED',
                'FFmpeg did not decode the exact resolved video frame interval.',
            );
        }
    } finally {
        await handle.close();
    }
}

function validateSegmentCoverage(plan: ResolvedRenderPlanV1): void {
    let nextFrame = 0;
    for (const segment of plan.videoSegments) {
        if (!Number.isSafeInteger(segment.outputStartFrame)
            || !Number.isSafeInteger(segment.outputEndFrame)
            || segment.outputStartFrame !== nextFrame
            || segment.outputEndFrame <= segment.outputStartFrame
            || segment.outputEndFrame > plan.contentEndFrame) {
            throw new HeadlessRenderError(
                'INVALID_SNAPSHOT',
                'Resolved video segments must exactly cover contiguous half-open frame intervals.',
            );
        }
        nextFrame = segment.outputEndFrame;
    }
    if (nextFrame !== plan.contentEndFrame || plan.contentEndFrame <= 0) {
        throw new HeadlessRenderError(
            'INVALID_SNAPSHOT',
            'Resolved video segments do not cover the complete output boundary.',
        );
    }
}

function createBackgroundFrame(frameBytes: number, color: string): Uint8Array {
    if (!/^#[0-9a-f]{6}$/.test(color)) {
        throw new HeadlessRenderError(
            'INVALID_SNAPSHOT',
            'The resolved background color is not canonical hexadecimal.',
        );
    }
    const red = Number.parseInt(color.slice(1, 3), 16);
    const green = Number.parseInt(color.slice(3, 5), 16);
    const blue = Number.parseInt(color.slice(5, 7), 16);
    const frame = new Uint8Array(frameBytes);
    for (let offset = 0; offset < frame.length; offset += 4) {
        frame[offset] = red;
        frame[offset + 1] = green;
        frame[offset + 2] = blue;
        frame[offset + 3] = 255;
    }
    return frame;
}

function assertAcquiredSource(
    expected: HeadlessMediaIdentity,
    actual: HeadlessMediaIdentity,
    fileDescriptor: number,
): void {
    const keys: Array<keyof HeadlessMediaIdentity> = [
        'sourceId',
        'kind',
        'byteSourceCapabilityId',
        'fingerprint',
        'size',
        'lastModified',
    ];
    if (!Number.isSafeInteger(fileDescriptor) || fileDescriptor < 0
        || keys.some((key) => actual[key] !== expected[key])) {
        throw new HeadlessRenderError(
            'SOURCE_CHANGED',
            'The acquired video handle does not match the resolved immutable identity.',
        );
    }
}

function coalesceVideoRanges(
    ranges: readonly HeadlessSourceRangeRead[],
): HeadlessSourceRangeRead[] {
    const bySource = new Map<string, HeadlessSourceRangeRead>();
    ranges.forEach((range) => {
        const previous = bySource.get(range.sourceId);
        bySource.set(range.sourceId, previous ? {
            ...previous,
            start: Math.min(previous.start, range.start),
            end: Math.max(previous.end, range.end),
        } : { ...range });
    });
    return Array.from(bySource.values()).sort((left, right) => (
        left.sourceId.localeCompare(right.sourceId)
    ));
}

function reportProgress(
    request: FfmpegVideoProductionRequest,
    completedFrames: number,
): void {
    request.onProgress?.({
        stage: 'video',
        completedUnits: completedFrames,
        totalUnits: request.plan.contentEndFrame,
    });
}

function checkedMultiply(...values: number[]): number {
    const result = values.reduce((product, value) => product * value, 1);
    if (!Number.isSafeInteger(result) || result <= 0) {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'Resolved video byte accounting overflowed.',
        );
    }
    return result;
}

function toRenderError(error: unknown): HeadlessRenderError {
    return error instanceof HeadlessRenderError
        ? error
        : new HeadlessRenderError(
            'RENDER_FAILED',
            error instanceof Error ? error.message : 'FFmpeg video decoding failed.',
            false,
            error instanceof Error ? { cause: error } : undefined,
        );
}
