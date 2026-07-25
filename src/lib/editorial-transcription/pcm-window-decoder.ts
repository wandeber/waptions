import {
    ALL_FORMATS,
    AudioSampleSink,
    Input,
    type AudioSample,
} from 'mediabunny';
import type {
    EditorialPcmWindowDecoder,
    EditorialPcmWindowIdentity,
} from '@/lib/storage/editorial-pcm-window-cache';
import {
    ceilRationalSampleCount,
    downmixEditorialChannelsToMono,
    EDITORIAL_PCM_MIX_CHUNK_FRAMES,
    EDITORIAL_PCM_OUTPUT_SAMPLE_RATE_HZ,
    quantizeEditorialPcm16,
    timestampMicrosecondsToNativeSample,
    type RationalDuration,
} from './pcm';
import {
    createEditorialResamplerCoefficientTable,
    EDITORIAL_RESAMPLER_PHASES,
    EDITORIAL_RESAMPLER_TAPS,
    isSupportedEditorialPcmNativeSampleRate,
} from './resampler';
import type { MediaBudgetManager } from '@/lib/media-byte-source/budget-manager';
import { mediaRuntimeBudgets } from '@/lib/media-byte-source/budgets';
import { createAdmittedMediabunnyInput } from '@/lib/media-byte-source/mediabunny-adapter';
import type { MediaByteSource, MediaByteSourceInput } from '@/lib/media-byte-source/types';

export interface EditorialPcmWindowSource {
    file: File;
    byteSource?: MediaByteSource;
    declaredDuration: RationalDuration;
}

export type ResolveEditorialPcmWindowSource = (
    sourceFingerprint: string,
) => EditorialPcmWindowSource | null | Promise<EditorialPcmWindowSource | null>;

export interface EditorialPcmWindowAudioSample {
    readonly timestamp: number;
    readonly microsecondTimestamp: number;
    readonly duration: number;
    readonly sampleRate: number;
    readonly numberOfFrames: number;
    readonly numberOfChannels: number;
    copyTo(destination: Float32Array, options: {
        planeIndex: number;
        format: 'f32-planar';
        frameOffset: number;
        frameCount: number;
    }): void;
    close(): void;
}

export interface OpenEditorialPcmWindowAudioResult {
    readonly sampleRate: number;
    readonly numberOfChannels: number;
    samples(startSeconds: number, endSeconds: number): AsyncIterable<EditorialPcmWindowAudioSample>;
    dispose(): void;
}

export type OpenEditorialPcmWindowAudio = (
    source: MediaByteSourceInput,
) => Promise<OpenEditorialPcmWindowAudioResult | null>;

export interface MediabunnyEditorialPcmWindowDecoderOptions {
    resolveSource: ResolveEditorialPcmWindowSource;
    openAudio?: OpenEditorialPcmWindowAudio;
    pcmBudget?: MediaBudgetManager;
}

async function openEditorialPcmWindowAudioWithMediabunny(
    source: MediaByteSourceInput,
): Promise<OpenEditorialPcmWindowAudioResult | null> {
    const input = await createAdmittedMediabunnyInput(source, (admittedSource) => new Input({
        source: admittedSource,
        formats: ALL_FORMATS,
    }));
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        input.dispose();
    };
    try {
        const track = await input.getPrimaryAudioTrack();
        if (!track) {
            dispose();
            return null;
        }
        const sink = new AudioSampleSink(track);
        return {
            sampleRate: track.sampleRate,
            numberOfChannels: track.numberOfChannels,
            samples: (startSeconds, endSeconds) => (
                sink.samples(startSeconds, endSeconds) as AsyncIterable<AudioSample>
            ),
            dispose,
        };
    } catch (error) {
        dispose();
        throw error;
    }
}

/**
 * Creates the bounded refinement decoder installed by the editor runtime.
 *
 * The requested 16 kHz indices remain on the same source-zero phase grid as full-source PCM.
 * Only the requested window, caller padding, and the fixed 64-tap native support are decoded.
 * Timestamp gaps stay zero and overlapping decoded prefixes are discarded exactly as they are by
 * full-source acquisition. No PCM survives outside the returned array or the best-effort cache.
 */
export function createMediabunnyEditorialPcmWindowDecoder(
    options: MediabunnyEditorialPcmWindowDecoderOptions,
): EditorialPcmWindowDecoder {
    const openAudio = options.openAudio ?? openEditorialPcmWindowAudioWithMediabunny;
    return {
        decodeWindow: async (request) => decodeEditorialPcmWindow({
            request,
            resolveSource: options.resolveSource,
            openAudio,
            pcmBudget: options.pcmBudget ?? mediaRuntimeBudgets.pcmBytes,
        }),
    };
}

async function decodeEditorialPcmWindow(input: {
    request: EditorialPcmWindowIdentity & {
        filterPaddingSamples: number;
        signal?: AbortSignal;
    };
    resolveSource: ResolveEditorialPcmWindowSource;
    openAudio: OpenEditorialPcmWindowAudio;
    pcmBudget: MediaBudgetManager;
}): Promise<Int16Array> {
    const { request } = input;
    throwIfAborted(request.signal);
    const source = await input.resolveSource(request.sourceFingerprint);
    if (!source) throw new Error('The editorial PCM source is unavailable.');
    const targetSampleCount = ceilRationalSampleCount(
        source.declaredDuration,
        EDITORIAL_PCM_OUTPUT_SAMPLE_RATE_HZ,
    );
    if (request.endSample > targetSampleCount) {
        throw new Error('The editorial PCM window exceeds the declared source duration.');
    }

    const output = new Int16Array(request.endSample - request.startSample);
    const reader = await input.openAudio(source.byteSource ?? source.file);
    throwIfAborted(request.signal);
    if (!reader) return output;

    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        reader.dispose();
    };
    const abortReader = () => dispose();
    request.signal?.addEventListener('abort', abortReader, { once: true });
    try {
        if (!Number.isSafeInteger(reader.sampleRate) || reader.sampleRate <= 0
            || !Number.isSafeInteger(reader.numberOfChannels) || reader.numberOfChannels <= 0) {
            throw new Error('Editorial primary audio format is unsupported.');
        }
        if (!isSupportedEditorialPcmNativeSampleRate(reader.sampleRate)) {
            throw new Error(
                `Editorial PCM v1 supports native 44100 Hz and 48000 Hz audio; received ${reader.sampleRate} Hz.`,
            );
        }

        const declaredNativeSampleCount = ceilRationalSampleCount(
            source.declaredDuration,
            reader.sampleRate,
        );
        const paddedOutputStart = Math.max(0, request.startSample - request.filterPaddingSamples);
        const paddedOutputEnd = Math.min(
            targetSampleCount,
            request.endSample + request.filterPaddingSamples,
        );
        const nativeSupport = getNativeSupportRange({
            outputStartSample: paddedOutputStart,
            outputEndSample: paddedOutputEnd,
            nativeSampleRate: reader.sampleRate,
            declaredNativeSampleCount,
        });
        const nativeFrameCount = nativeSupport.end - nativeSupport.start;
        const maximumMixFrames = Math.min(EDITORIAL_PCM_MIX_CHUNK_FRAMES, nativeFrameCount);
        const nativeReservation = await input.pcmBudget.reserve(
            nativeFrameCount * Float64Array.BYTES_PER_ELEMENT
                + maximumMixFrames * (reader.numberOfChannels + 2) * Float32Array.BYTES_PER_ELEMENT,
            { label: 'editorial-pcm-native-window', signal: request.signal },
        );
        const native = new Float64Array(nativeFrameCount);
        let nextNativeSample = nativeSupport.start;
        let previousTimestampMicroseconds: number | null = null;

        try {
            for await (const sample of reader.samples(
                nativeSupport.start / reader.sampleRate,
                nativeSupport.end / reader.sampleRate,
            )) {
                let processingFailed = false;
                try {
                    throwIfAborted(request.signal);
                    assertWindowSampleFormat(sample, reader.sampleRate, reader.numberOfChannels);
                    if (previousTimestampMicroseconds !== null
                        && sample.microsecondTimestamp < previousTimestampMicroseconds) {
                        throw new Error('Editorial decoded timestamps must be monotonic.');
                    }
                    previousTimestampMicroseconds = sample.microsecondTimestamp;
                    const decodedStart = timestampMicrosecondsToNativeSample(
                        sample.microsecondTimestamp,
                        reader.sampleRate,
                    );
                    const decodedEnd = decodedStart + sample.numberOfFrames;
                    const retainedStart = Math.max(
                        nativeSupport.start,
                        nextNativeSample,
                        decodedStart,
                        0,
                    );
                    const retainedEnd = Math.min(
                        nativeSupport.end,
                        declaredNativeSampleCount,
                        decodedEnd,
                    );
                    if (retainedStart >= retainedEnd) continue;
                    const sourceFrameOffset = retainedStart - decodedStart;
                    const retainedFrameCount = retainedEnd - retainedStart;
                    for (let processed = 0; processed < retainedFrameCount;) {
                        throwIfAborted(request.signal);
                        const frameCount = Math.min(
                            EDITORIAL_PCM_MIX_CHUNK_FRAMES,
                            retainedFrameCount - processed,
                        );
                        const mono = downmixEditorialChannelsToMono(
                            reader.numberOfChannels,
                            frameCount,
                            (channel) => {
                                const plane = new Float32Array(frameCount);
                                sample.copyTo(plane, {
                                    planeIndex: channel,
                                    format: 'f32-planar',
                                    frameOffset: sourceFrameOffset + processed,
                                    frameCount,
                                });
                                return plane;
                            },
                        );
                        native.set(mono, retainedStart - nativeSupport.start + processed);
                        processed += frameCount;
                    }
                    nextNativeSample = retainedEnd;
                } catch (error) {
                    processingFailed = true;
                    throw error;
                } finally {
                    try {
                        sample.close();
                    } catch (error) {
                        if (!processingFailed) throw error;
                    }
                }
            }
            throwIfAborted(request.signal);

            const coefficients = createEditorialResamplerCoefficientTable(reader.sampleRate);
            for (let index = 0; index < output.length; index += 1) {
                const outputSample = request.startSample + index;
                const phase = getSourcePhase(outputSample, reader.sampleRate);
                const baseSample = phase.sourceSample - (EDITORIAL_RESAMPLER_TAPS / 2 - 1);
                const coefficientOffset = phase.phase * EDITORIAL_RESAMPLER_TAPS;
                let value = 0;
                for (let tap = 0; tap < EDITORIAL_RESAMPLER_TAPS; tap += 1) {
                    const sourceSample = baseSample + tap;
                    const nativeIndex = sourceSample - nativeSupport.start;
                    const sampleValue = nativeIndex >= 0 && nativeIndex < native.length
                        ? native[nativeIndex]
                        : 0;
                    value += sampleValue * coefficients[coefficientOffset + tap];
                }
                output[index] = quantizeEditorialPcm16(value);
            }
        } finally {
            nativeReservation.release();
        }
        return output;
    } finally {
        request.signal?.removeEventListener('abort', abortReader);
        dispose();
    }
}

function getNativeSupportRange(input: {
    outputStartSample: number;
    outputEndSample: number;
    nativeSampleRate: number;
    declaredNativeSampleCount: number;
}): { start: number; end: number } {
    const first = getSourcePhase(input.outputStartSample, input.nativeSampleRate).sourceSample;
    const finalOutputSample = Math.max(input.outputStartSample, input.outputEndSample - 1);
    const last = getSourcePhase(finalOutputSample, input.nativeSampleRate).sourceSample;
    return {
        start: Math.max(0, first - (EDITORIAL_RESAMPLER_TAPS / 2 - 1)),
        end: Math.min(
            input.declaredNativeSampleCount,
            last + EDITORIAL_RESAMPLER_TAPS / 2 + 1,
        ),
    };
}

function getSourcePhase(
    outputSample: number,
    nativeSampleRate: number,
): { sourceSample: number; phase: number } {
    const numerator = BigInt(outputSample) * BigInt(nativeSampleRate);
    const outputRate = BigInt(EDITORIAL_PCM_OUTPUT_SAMPLE_RATE_HZ);
    const sourceSample = numerator / outputRate;
    const remainder = numerator % outputRate;
    const phase = remainder * BigInt(EDITORIAL_RESAMPLER_PHASES) / outputRate;
    return { sourceSample: Number(sourceSample), phase: Number(phase) };
}

function assertWindowSampleFormat(
    sample: EditorialPcmWindowAudioSample,
    sampleRate: number,
    numberOfChannels: number,
): void {
    if (!Number.isFinite(sample.timestamp) || !Number.isFinite(sample.duration)
        || !Number.isSafeInteger(sample.microsecondTimestamp)
        || sample.sampleRate !== sampleRate
        || sample.numberOfChannels !== numberOfChannels
        || !Number.isSafeInteger(sample.numberOfFrames)
        || sample.numberOfFrames < 0
        || Math.abs(sample.timestamp * 1_000_000 - sample.microsecondTimestamp) > 1
        || Math.abs(sample.duration * sampleRate - sample.numberOfFrames) > 1) {
        throw new Error('Editorial decoded audio format or timestamp changed unexpectedly.');
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new DOMException('Editorial PCM window decoding was cancelled.', 'AbortError');
    }
}
