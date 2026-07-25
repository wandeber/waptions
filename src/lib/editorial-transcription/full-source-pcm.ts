import {
    ALL_FORMATS,
    AudioSampleSink,
    BlobSource,
    Input,
    type AudioSample,
} from 'mediabunny';
import {
    ceilRationalSampleCount,
    downmixEditorialChannelsToMono,
    EDITORIAL_PCM_MIX_CHUNK_FRAMES,
    EDITORIAL_PCM_OUTPUT_SAMPLE_RATE_HZ,
    normalizeRationalDuration,
    planNativeChunkWindow,
    quantizeEditorialPcm16,
    type RationalDuration,
} from './pcm';
import { StreamingEditorialResampler } from './resampler';
import {
    EDITORIAL_WAV_MAX_SAMPLE_COUNT,
    Pcm16WavPartAccumulator,
} from './wav';

export interface EditorialDecodedAudioSample {
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

export interface OpenEditorialAudioResult {
    readonly sampleRate: number;
    readonly numberOfChannels: number;
    readonly samples: AsyncIterable<EditorialDecodedAudioSample>;
    dispose(): void;
}

export type OpenEditorialAudio = (file: File) => Promise<OpenEditorialAudioResult | null>;

export interface PrepareFullSourceEditorialPcmInput {
    file: File;
    /** Exact caller-owned container duration; never a selected clip crop. */
    declaredDuration: RationalDuration;
    signal?: AbortSignal;
    openAudio?: OpenEditorialAudio;
}

export interface PreparedFullSourceEditorialPcm {
    sampleRateHz: 16_000;
    sampleCount: number;
    hasAudioStream: boolean;
    wav: Blob | null;
}

async function openEditorialAudioWithMediabunny(file: File): Promise<OpenEditorialAudioResult | null> {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        input.dispose();
    };
    try {
        // Mediabunny's primary-track resolver honors the declared/default disposition and falls
        // back to stable container order. The borrowed track remains valid only while Input lives.
        const track = await input.getPrimaryAudioTrack();
        if (!track) {
            dispose();
            return null;
        }
        const sink = new AudioSampleSink(track);
        return {
            sampleRate: track.sampleRate,
            numberOfChannels: track.numberOfChannels,
            samples: sink.samples() as AsyncIterable<AudioSample>,
            dispose,
        };
    } catch (error) {
        dispose();
        throw error;
    }
}

/**
 * Decodes one complete primary source stream to canonical source-zero mono PCM16 16 kHz WAV.
 *
 * Input and every yielded AudioSample are owned here and closed exactly once. Timestamp gaps are
 * fed as zeros through the same streaming resampler, overlapping decoded prefixes are discarded,
 * and declared trailing duration is padded before a fixed target count is emitted. No clip crop,
 * timeline region, detached audio or project mix enters this function's contract.
 */
export async function prepareFullSourceEditorialPcm(
    input: PrepareFullSourceEditorialPcmInput,
): Promise<PreparedFullSourceEditorialPcm> {
    const duration = normalizeRationalDuration(input.declaredDuration);
    const targetSampleCount = ceilRationalSampleCount(
        duration,
        EDITORIAL_PCM_OUTPUT_SAMPLE_RATE_HZ,
    );
    if (targetSampleCount > EDITORIAL_WAV_MAX_SAMPLE_COUNT) {
        throw new Error('Editorial source exceeds the RIFF/WAVE 32-bit payload limit.');
    }
    throwIfAborted(input.signal);
    const reader = await (input.openAudio ?? openEditorialAudioWithMediabunny)(input.file);
    throwIfAborted(input.signal);
    if (!reader) {
        return {
            sampleRateHz: 16_000,
            sampleCount: targetSampleCount,
            hasAudioStream: false,
            wav: null,
        };
    }

    if (!Number.isSafeInteger(reader.sampleRate) || reader.sampleRate <= 0
        || !Number.isSafeInteger(reader.numberOfChannels) || reader.numberOfChannels <= 0) {
        reader.dispose();
        throw new Error('Editorial primary audio format is unsupported.');
    }
    const declaredNativeSampleCount = ceilRationalSampleCount(duration, reader.sampleRate);
    const resampler = new StreamingEditorialResampler({
        inputRateHz: reader.sampleRate,
        outputRateHz: EDITORIAL_PCM_OUTPUT_SAMPLE_RATE_HZ,
        targetSampleCount,
    });
    const wav = new Pcm16WavPartAccumulator();
    let nextNativeSample = 0;
    let previousTimestampMicroseconds: number | null = null;
    let readerDisposed = false;
    let succeeded = false;
    const disposeReader = () => {
        if (readerDisposed) return;
        readerDisposed = true;
        reader.dispose();
    };
    const appendResampled = (samples: Float64Array) => {
        if (samples.length === 0) return;
        const quantized = new Int16Array(samples.length);
        for (let index = 0; index < samples.length; index += 1) {
            quantized[index] = quantizeEditorialPcm16(samples[index]);
        }
        wav.append(quantized);
    };

    try {
        for await (const sample of reader.samples) {
            let sampleProcessingFailed = false;
            try {
                throwIfAborted(input.signal);
                assertDecodedSampleFormat(sample, reader.sampleRate, reader.numberOfChannels);
                if (previousTimestampMicroseconds !== null
                    && sample.microsecondTimestamp < previousTimestampMicroseconds) {
                    throw new Error('Editorial decoded timestamps must be monotonic.');
                }
                previousTimestampMicroseconds = sample.microsecondTimestamp;
                const window = planNativeChunkWindow({
                    timestampMicroseconds: sample.microsecondTimestamp,
                    sampleRateHz: reader.sampleRate,
                    numberOfFrames: sample.numberOfFrames,
                    nextNativeSample,
                    declaredNativeSampleCount,
                });
                if (!window) continue;
                resampler.appendZeros(window.gapFrames, appendResampled);
                nextNativeSample = window.destinationStartFrame;
                for (let processed = 0; processed < window.frameCount;) {
                    throwIfAborted(input.signal);
                    const frameCount = Math.min(
                        EDITORIAL_PCM_MIX_CHUNK_FRAMES,
                        window.frameCount - processed,
                    );
                    const mono = downmixEditorialChannelsToMono(
                        sample.numberOfChannels,
                        frameCount,
                        (channel) => {
                            const plane = new Float32Array(frameCount);
                            sample.copyTo(plane, {
                                planeIndex: channel,
                                format: 'f32-planar',
                                frameOffset: window.sourceFrameOffset + processed,
                                frameCount,
                            });
                            return plane;
                        },
                    );
                    appendResampled(resampler.append(mono));
                    processed += frameCount;
                    nextNativeSample += frameCount;
                }
            } catch (error) {
                sampleProcessingFailed = true;
                throw error;
            } finally {
                // Ownership transfers from AudioSampleSink at yield. The close belongs inside the
                // loop so copy errors, aborts and wholly overlapped chunks all release immediately.
                try {
                    sample.close();
                } catch (error) {
                    // A cleanup failure remains terminal on a successful processing path, but it
                    // must not replace the decode/copy/abort error that initiated unwinding.
                    if (!sampleProcessingFailed) throw error;
                }
            }
        }
        throwIfAborted(input.signal);
        if (nextNativeSample < declaredNativeSampleCount) {
            resampler.appendZeros(
                declaredNativeSampleCount - nextNativeSample,
                appendResampled,
            );
        }
        appendResampled(resampler.finish());
        throwIfAborted(input.signal);
        const wavBlob = wav.finish(targetSampleCount);
        succeeded = true;
        return {
            sampleRateHz: 16_000,
            sampleCount: targetSampleCount,
            hasAudioStream: true,
            wav: wavBlob,
        };
    } finally {
        resampler.dispose();
        if (!succeeded) wav.release();
        try {
            disposeReader();
        } catch (error) {
            // Preserve the decode/request failure already propagating through this finally block.
            // A cleanup failure on an otherwise successful path is still terminal and observable.
            if (succeeded) throw error;
        }
    }
}

function assertDecodedSampleFormat(
    sample: EditorialDecodedAudioSample,
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
        // Mid-stream native-format changes and incomplete timing metadata fail closed. Allowing a
        // decoder/platform fallback here would make canonical bytes provider-dependent.
        throw new Error('Editorial decoded audio format or timestamp changed unexpectedly.');
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new DOMException('Editorial audio preparation was cancelled.', 'AbortError');
    }
}
