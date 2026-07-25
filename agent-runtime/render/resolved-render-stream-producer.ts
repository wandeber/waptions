import {
    AUDIO_MIX_CHUNK_SIZE,
    renderAudioMixWindow,
    type DecodeAudioContributorRequest,
    type DecodedAudioContributor,
} from '../../src/lib/audio-dsp';
import type { AudioMixContributor } from '../../src/lib/audio-mix-plan';
import {
    resolveRenderPlanVideoFrame,
    type ResolvedRenderPlanV1,
    type ResolvedVideoFrameRequest,
    type VerifiedRenderMediaSourceSet,
} from '../../src/lib/render-plan';
import {
    HeadlessRenderError,
    throwIfAborted,
    type HeadlessRenderResourceReservation,
    type HeadlessSourceRangeRead,
} from './contracts';
import type {
    RawResolvedRenderStreamProducerPort,
    RawResolvedRenderStreamResult,
} from './bounded-ffmpeg-executor';

export interface ResolvedRgbaFrameResult {
    rgba: Uint8Array;
    sourceRangesRead?: HeadlessSourceRangeRead[];
    decodedPixelBytes: number;
    videoDecoderSessions: number;
    canvasFrames: number;
}

/**
 * Platform canvas/decoder seam. Implementations decode the requested immutable source frame and
 * call `renderResolvedPlanFrame`; they allocate only inside `resourceReservation`, include source
 * frames plus canvases in diagnostics, and return one tightly packed RGBA output frame.
 */
export interface ResolvedRgbaFrameRendererPort {
    renderFrame(request: {
        plan: ResolvedRenderPlanV1;
        frameIndex: number;
        videoFrame: ResolvedVideoFrameRequest | null;
        mediaSources: VerifiedRenderMediaSourceSet;
        resourceReservation: HeadlessRenderResourceReservation;
        maximumReadChunkBytes: number;
        maximumDecodedPixelBytes: number;
        signal?: AbortSignal;
    }): Promise<ResolvedRgbaFrameResult>;
}

export interface ResolvedAudioDecodeResult {
    audio: DecodedAudioContributor;
    sourceRangesRead?: HeadlessSourceRangeRead[];
}

/**
 * Codec seam for one bounded contributor window; DSP remains in this concrete producer.
 * Implementations must reserve/allocate no more than `maximumDecodedAudioBytes`.
 */
export interface ResolvedAudioContributorDecoderPort {
    decode(request: {
        contributor: AudioMixContributor;
        window: DecodeAudioContributorRequest;
        mediaSources: VerifiedRenderMediaSourceSet;
        resourceReservation: HeadlessRenderResourceReservation;
        maximumReadChunkBytes: number;
        maximumDecodedAudioBytes: number;
        signal?: AbortSignal;
    }): Promise<ResolvedAudioDecodeResult>;
}

/**
 * Concrete shared raw stream producer for Chromium encoders and the FFmpeg fallback.
 *
 * Video order comes only from the resolved frame requests. Audio is always rendered by the shared
 * `renderAudioMixWindow`, so resampling, gain, fades, downmixing, limiting, mute/solo, and
 * linked/detached decisions cannot diverge between standalone, Chromium, and FFmpeg adapters.
 */
export class CanonicalResolvedRenderStreamProducer
implements RawResolvedRenderStreamProducerPort {
    constructor(
        private readonly frames: ResolvedRgbaFrameRendererPort,
        private readonly audio: ResolvedAudioContributorDecoderPort,
    ) {}

    async produce(request: Parameters<RawResolvedRenderStreamProducerPort['produce']>[0])
    : Promise<RawResolvedRenderStreamResult> {
        const expectedFrameBytes = checkedFrameBytes(request.plan);
        const outputCanvasBytes = expectedFrameBytes * request.maximumCanvasFrames;
        if (!Number.isSafeInteger(outputCanvasBytes)
            || outputCanvasBytes > request.maximumDecodedPixelBytes) {
            throw new HeadlessRenderError(
                'RESOURCE_LIMIT',
                'The decoded-pixel budget cannot hold the bounded frame pool.',
            );
        }
        const ranges = new SourceRangeAccumulator(request.plan);
        let peakDecodedPixelBytes = 0;
        let peakVideoDecoderSessions = 0;
        let peakCanvasFrames = 0;

        for (let frameIndex = 0; frameIndex < request.plan.contentEndFrame; frameIndex += 1) {
            throwIfAborted(request.signal);
            const frame = await this.frames.renderFrame({
                plan: request.plan,
                frameIndex,
                videoFrame: resolveRenderPlanVideoFrame(request.plan, frameIndex),
                mediaSources: request.mediaSources,
                resourceReservation: request.resourceReservation,
                maximumReadChunkBytes: request.maximumReadChunkBytes,
                maximumDecodedPixelBytes: request.maximumDecodedPixelBytes,
                signal: request.signal,
            });
            if (frame.rgba.byteLength !== expectedFrameBytes
                || frame.decodedPixelBytes > request.maximumDecodedPixelBytes
                || frame.videoDecoderSessions > request.maximumDecoderSessions
                || frame.canvasFrames > request.maximumCanvasFrames
                || [
                    frame.decodedPixelBytes,
                    frame.videoDecoderSessions,
                    frame.canvasFrames,
                ].some((value) => !Number.isSafeInteger(value) || value < 0)) {
                throw new HeadlessRenderError(
                    'RESOURCE_LIMIT',
                    'The resolved frame renderer exceeded its hard resource bounds.',
                );
            }
            peakDecodedPixelBytes = Math.max(
                peakDecodedPixelBytes,
                frame.decodedPixelBytes,
            );
            peakVideoDecoderSessions = Math.max(
                peakVideoDecoderSessions,
                frame.videoDecoderSessions,
            );
            peakCanvasFrames = Math.max(peakCanvasFrames, frame.canvasFrames);
            ranges.addAll(frame.sourceRangesRead ?? []);
            await request.onVideoFrame(frameIndex, frame.rgba);
            request.onProgress?.({
                stage: 'video',
                completedUnits: frameIndex + 1,
                totalUnits: request.plan.contentEndFrame,
            });
        }

        const maximumAudioWindowSamples = Math.min(
            AUDIO_MIX_CHUNK_SIZE,
            Math.floor(request.maximumAudioMixBytes / 64),
        );
        if (maximumAudioWindowSamples < 1) {
            throw new HeadlessRenderError(
                'RESOURCE_LIMIT',
                'The audio mix budget cannot hold one bounded stereo sample window.',
            );
        }
        let peakAudioMixBytes = 0;
        for (
            let startSample = 0;
            startSample < request.plan.outputEndSample;
            startSample += maximumAudioWindowSamples
        ) {
            throwIfAborted(request.signal);
            const endSample = Math.min(
                request.plan.outputEndSample,
                startSample + maximumAudioWindowSamples,
            );
            const outputSampleCount = endSample - startSample;
            const dspAndStereoBytes = outputSampleCount * 32;
            const maximumDecodedAudioBytes = request.maximumAudioMixBytes - dspAndStereoBytes;
            const stereo = new Float32Array(outputSampleCount * 2);
            const mixedEnd = Math.min(endSample, request.plan.audioMixPlan.totalSampleCount);
            if (startSample < mixedEnd) {
                let decodedBytes = 0;
                const mix = await renderAudioMixWindow(
                    request.plan.audioMixPlan,
                    async (contributor, window) => {
                        const decoded = await this.audio.decode({
                            contributor,
                            window,
                            mediaSources: request.mediaSources,
                            resourceReservation: request.resourceReservation,
                            maximumReadChunkBytes: request.maximumReadChunkBytes,
                            maximumDecodedAudioBytes,
                            signal: request.signal,
                        });
                        const windowBytes = decoded.audio.channels.reduce(
                            (total, channel) => total + channel.byteLength,
                            0,
                        );
                        decodedBytes = Math.max(decodedBytes, windowBytes);
                        if (windowBytes > maximumDecodedAudioBytes) {
                            throw new HeadlessRenderError(
                                'RESOURCE_LIMIT',
                                'Decoded audio exceeded the bounded mix window.',
                            );
                        }
                        ranges.addAll(decoded.sourceRangesRead ?? []);
                        return decoded.audio;
                    },
                    {
                        startSample,
                        endSample: mixedEnd,
                        chunkSize: maximumAudioWindowSamples,
                        signal: request.signal,
                    },
                );
                for (let index = 0; index < mix.endSample - mix.startSample; index += 1) {
                    stereo[index * 2] = mix.channels[0][index];
                    stereo[index * 2 + 1] = mix.channels[1][index];
                }
                peakAudioMixBytes = Math.max(
                    peakAudioMixBytes,
                    decodedBytes + dspAndStereoBytes,
                    stereo.byteLength + mix.channels[0].byteLength + mix.channels[1].byteLength,
                );
            } else {
                peakAudioMixBytes = Math.max(peakAudioMixBytes, stereo.byteLength);
            }
            await request.onAudioChunk(startSample, stereo);
            request.onProgress?.({
                stage: 'audio',
                completedUnits: endSample,
                totalUnits: request.plan.outputEndSample,
            });
        }
        return {
            sourceRangesRead: ranges.values(),
            diagnostics: {
                peakDecodedPixelBytes,
                peakAudioMixBytes,
                peakVideoDecoderSessions,
                canvasFrames: peakCanvasFrames,
            },
        };
    }
}

class SourceRangeAccumulator {
    private readonly ranges = new Map<string, HeadlessSourceRangeRead>();
    private readonly knownSources: ReadonlySet<string>;

    constructor(plan: ResolvedRenderPlanV1) {
        this.knownSources = new Set(plan.sources.map((source) => (
            `${source.kind}:${source.sourceId}`
        )));
    }

    addAll(ranges: readonly HeadlessSourceRangeRead[]): void {
        ranges.forEach((range) => {
            const sourceKey = `${range.sourceKind}:${range.sourceId}`;
            if (!this.knownSources.has(sourceKey)) {
                throw new HeadlessRenderError(
                    'SOURCE_CHANGED',
                    'A resolved stream adapter reported an unknown media source.',
                );
            }
            const key = `${sourceKey}:${range.kind}`;
            const previous = this.ranges.get(key);
            this.ranges.set(key, previous ? {
                ...previous,
                start: Math.min(previous.start, range.start),
                end: Math.max(previous.end, range.end),
            } : { ...range });
        });
    }

    values(): HeadlessSourceRangeRead[] {
        return Array.from(this.ranges.values()).sort((left, right) => (
            left.sourceKind.localeCompare(right.sourceKind)
            || left.sourceId.localeCompare(right.sourceId)
            || left.kind.localeCompare(right.kind)
        ));
    }
}

function checkedFrameBytes(plan: ResolvedRenderPlanV1): number {
    const bytes = plan.renderProfile.width * plan.renderProfile.height * 4;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
        throw new HeadlessRenderError('RESOURCE_LIMIT', 'The RGBA frame size is invalid.');
    }
    return bytes;
}
