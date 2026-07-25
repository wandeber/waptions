import {
    ALL_FORMATS,
    AudioSampleSink,
    Input,
    type AudioSample,
} from 'mediabunny';
import {
    MediaBudgetExceededError,
    MediaBudgetManager,
    type MediaBudgetLease,
} from '../../../src/lib/media-byte-source/budget-manager';
import { createAdmittedMediabunnyInput } from '../../../src/lib/media-byte-source/mediabunny-adapter';
import type { MediaByteSource } from '../../../src/lib/media-byte-source/types';
import {
    EDITORIAL_PCM_MIX_CHUNK_FRAMES,
    EDITORIAL_PCM_OUTPUT_SAMPLE_RATE_HZ,
    quantizeEditorialPcm16,
    timestampMicrosecondsToNativeSample,
} from '../../../src/lib/editorial-transcription/pcm';
import {
    createEditorialResamplerCoefficientTable,
    EDITORIAL_RESAMPLER_PHASES,
    EDITORIAL_RESAMPLER_TAPS,
    isSupportedEditorialPcmNativeSampleRate,
} from '../../../src/lib/editorial-transcription/resampler';
import { createPcm16WavHeader } from '../../../src/lib/editorial-transcription/wav';
import type {
    ManagedDecodedWindow,
    ManagedTranscriptionDecoderPort,
} from './contracts';
import {
    ManagedTranscriptionError,
    throwIfManagedTranscriptionAborted,
} from './errors';

export const MANAGED_TRANSCRIPTION_MEMORY_MAX_BYTES = 8 * 1024 * 1024;
export const MANAGED_TRANSCRIPTION_MEDIABUNNY_CACHE_BYTES = 512 * 1024;
const WINDOW_RING_FRAMES = EDITORIAL_PCM_MIX_CHUNK_FRAMES * 2 + EDITORIAL_RESAMPLER_TAPS * 2;
const WAV_HEADER_BYTES = 44;

export interface ManagedDecodedAudioSample {
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

export interface ManagedOpenAudioResult {
    readonly sampleRate: number;
    readonly numberOfChannels: number;
    samples(startSeconds: number, endSeconds: number): AsyncIterable<ManagedDecodedAudioSample>;
    dispose(): void;
}

export type OpenManagedAudio = (
    source: MediaByteSource,
    input: {
        readonly cacheBytes: number;
        readonly memoryBudget: MediaBudgetManager;
        readonly signal: AbortSignal;
    },
) => Promise<ManagedOpenAudioResult | null>;

export interface ManagedStreamingPcmWindowDecoderOptions {
    readonly memoryBudget?: MediaBudgetManager;
    readonly openAudio?: OpenManagedAudio;
}

/**
 * Source-zero, phase-stable 16 kHz decoder with one bounded native ring.
 *
 * Only a <=30-second output WAV, one 16k-frame mix scratch, the fixed coefficient table and a
 * 32k-frame ring can be live. The native 44.1/48 kHz window is never materialized.
 */
export class ManagedStreamingPcmWindowDecoder implements ManagedTranscriptionDecoderPort {
    readonly memoryBudget: MediaBudgetManager;
    private readonly openAudio: OpenManagedAudio;

    constructor(options: ManagedStreamingPcmWindowDecoderOptions = {}) {
        this.memoryBudget = options.memoryBudget ?? new MediaBudgetManager(
            'managed-transcription-total-bytes',
            MANAGED_TRANSCRIPTION_MEMORY_MAX_BYTES,
        );
        this.openAudio = options.openAudio ?? openAudioWithMediabunny;
    }

    async decode(input: {
        readonly source: MediaByteSource;
        readonly sourceSampleCount: number;
        readonly window: import('../../../src/types/editorial').TranscriptionAcquisitionWindowV2;
        readonly signal: AbortSignal;
    }): Promise<ManagedDecodedWindow> {
        validateDecodeInput(input);
        throwIfManagedTranscriptionAborted(input.signal);
        const sampleCount = input.window.decoded.endSample - input.window.decoded.startSample;
        const wavBytes = WAV_HEADER_BYTES + sampleCount * 2;
        // Node Blob copies byte-backed parts. Reserving two complete WAVs is intentionally
        // conservative while the constructor snapshot and the live Blob may overlap.
        const outputReservation = await this.memoryBudget.reserve(wavBytes * 2, {
            label: 'managed-transcription-wav',
            signal: input.signal,
        });
        let outputLease: MediaBudgetLease | null = null;
        let reader: ManagedOpenAudioResult | null = null;
        let readerDisposed = false;
        let succeeded = false;
        const disposeReader = () => {
            if (readerDisposed) return;
            readerDisposed = true;
            reader?.dispose();
        };
        try {
            reader = await this.openAudio(input.source, {
                cacheBytes: MANAGED_TRANSCRIPTION_MEDIABUNNY_CACHE_BYTES,
                memoryBudget: this.memoryBudget,
                signal: input.signal,
            });
            throwIfManagedTranscriptionAborted(input.signal);
            if (!reader) {
                outputReservation.release();
                return {
                    sampleCount,
                    hasAudioStream: false,
                    wav: null,
                    release: () => undefined,
                };
            }
            validateAudioShape(reader);
            const declaredNativeSampleCount = ceilRational(
                input.sourceSampleCount * reader.sampleRate,
                EDITORIAL_PCM_OUTPUT_SAMPLE_RATE_HZ,
            );
            const coefficientsBytes = EDITORIAL_RESAMPLER_TAPS
                * EDITORIAL_RESAMPLER_PHASES
                * Float64Array.BYTES_PER_ELEMENT;
            const ringBytes = WINDOW_RING_FRAMES * Float64Array.BYTES_PER_ELEMENT;
            const scratchBytes = EDITORIAL_PCM_MIX_CHUNK_FRAMES
                * (Float32Array.BYTES_PER_ELEMENT + Float64Array.BYTES_PER_ELEMENT);
            const decodeReservation = await this.memoryBudget.reserve(
                // The canonical helper retains one immutable process cache and returns a caller
                // slice. Accounting both prevents the first decode from hiding that extra table.
                coefficientsBytes * 2 + ringBytes + scratchBytes,
                { label: 'managed-transcription-resampler', signal: input.signal },
            );
            const decodeLease = decodeReservation.commit();
            try {
                const outputBytes = new Uint8Array(wavBytes);
                outputBytes.set(createPcm16WavHeader(sampleCount), 0);
                const outputView = new DataView(outputBytes.buffer);
                const resampler = new WindowRingResampler({
                    inputRateHz: reader.sampleRate,
                    outputStartSample: input.window.decoded.startSample,
                    outputEndSample: input.window.decoded.endSample,
                    declaredNativeSampleCount,
                    coefficients: createEditorialResamplerCoefficientTable(reader.sampleRate),
                    writeSample: (index, value) => {
                        outputView.setInt16(
                            WAV_HEADER_BYTES + index * 2,
                            quantizeEditorialPcm16(value),
                            true,
                        );
                    },
                });
                let nextNativeSample = resampler.supportStart;
                let previousTimestampMicroseconds: number | null = null;
                const abortReader = () => disposeReader();
                input.signal.addEventListener('abort', abortReader, { once: true });
                try {
                    for await (const sample of reader.samples(
                        resampler.supportStart / reader.sampleRate,
                        resampler.supportEnd / reader.sampleRate,
                    )) {
                        let sampleFailed = false;
                        let sampleLease: MediaBudgetLease | null = null;
                        try {
                            throwIfManagedTranscriptionAborted(input.signal);
                            assertSampleShape(sample, reader.sampleRate, reader.numberOfChannels);
                            const sampleReservation = await this.memoryBudget.reserve(
                                sample.numberOfFrames
                                    * sample.numberOfChannels
                                    * Float32Array.BYTES_PER_ELEMENT,
                                {
                                    label: 'managed-transcription-decoded-sample',
                                    signal: input.signal,
                                },
                            );
                            sampleLease = sampleReservation.commit();
                            if (previousTimestampMicroseconds !== null
                                && sample.microsecondTimestamp < previousTimestampMicroseconds) {
                                throw new ManagedTranscriptionError(
                                    'SOURCE_CHANGED',
                                    true,
                                    'Decoded audio timestamps are not monotonic.',
                                );
                            }
                            previousTimestampMicroseconds = sample.microsecondTimestamp;
                            const decodedStart = timestampMicrosecondsToNativeSample(
                                sample.microsecondTimestamp,
                                reader.sampleRate,
                            );
                            const decodedEnd = decodedStart + sample.numberOfFrames;
                            const retainedStart = Math.max(
                                resampler.supportStart,
                                nextNativeSample,
                                decodedStart,
                                0,
                            );
                            const retainedEnd = Math.min(
                                resampler.supportEnd,
                                declaredNativeSampleCount,
                                decodedEnd,
                            );
                            if (retainedStart >= retainedEnd) continue;
                            resampler.appendZeros(retainedStart - nextNativeSample);
                            const sourceFrameOffset = retainedStart - decodedStart;
                            const retainedFrames = retainedEnd - retainedStart;
                            const mono = new Float64Array(
                                Math.min(EDITORIAL_PCM_MIX_CHUNK_FRAMES, retainedFrames),
                            );
                            const plane = new Float32Array(mono.length);
                            for (let processed = 0; processed < retainedFrames;) {
                                throwIfManagedTranscriptionAborted(input.signal);
                                const frameCount = Math.min(mono.length, retainedFrames - processed);
                                mono.fill(0, 0, frameCount);
                                for (let channel = 0; channel < reader.numberOfChannels; channel += 1) {
                                    plane.fill(0, 0, frameCount);
                                    sample.copyTo(plane.subarray(0, frameCount), {
                                        planeIndex: channel,
                                        format: 'f32-planar',
                                        frameOffset: sourceFrameOffset + processed,
                                        frameCount,
                                    });
                                    for (let frame = 0; frame < frameCount; frame += 1) {
                                        const value = plane[frame];
                                        mono[frame] += Number.isFinite(value) ? value : 0;
                                    }
                                }
                                for (let frame = 0; frame < frameCount; frame += 1) {
                                    mono[frame] /= reader.numberOfChannels;
                                }
                                resampler.append(mono.subarray(0, frameCount));
                                processed += frameCount;
                            }
                            nextNativeSample = retainedEnd;
                        } catch (error) {
                            sampleFailed = true;
                            throw error;
                        } finally {
                            sampleLease?.release();
                            try {
                                sample.close();
                            } catch (error) {
                                if (!sampleFailed) throw error;
                            }
                        }
                    }
                    throwIfManagedTranscriptionAborted(input.signal);
                    resampler.appendZeros(resampler.supportEnd - nextNativeSample);
                    resampler.finish();
                    if (resampler.outputCount !== sampleCount) {
                        throw new ManagedTranscriptionError(
                            'SOURCE_CHANGED',
                            true,
                            'The managed resampler produced an incomplete window.',
                        );
                    }
                    outputLease = outputReservation.commit();
                    const wav = new Blob([outputBytes], { type: 'audio/wav' });
                    succeeded = true;
                    let released = false;
                    return {
                        sampleCount,
                        hasAudioStream: true,
                        wav,
                        release: () => {
                            if (released) return;
                            released = true;
                            outputLease?.release();
                            outputLease = null;
                        },
                    };
                } finally {
                    input.signal.removeEventListener('abort', abortReader);
                }
            } finally {
                decodeLease.release();
            }
        } catch (error) {
            if (error instanceof RangeError || error instanceof MediaBudgetExceededError) {
                throw new ManagedTranscriptionError(
                    'MEMORY_LIMIT_EXCEEDED',
                    false,
                    'The managed transcription memory budget was exceeded.',
                    { cause: error },
                );
            }
            throw error;
        } finally {
            try {
                disposeReader();
            } finally {
                if (!succeeded) {
                    outputLease?.release();
                    outputReservation.release();
                }
            }
        }
    }
}

interface WindowRingResamplerInput {
    readonly inputRateHz: number;
    readonly outputStartSample: number;
    readonly outputEndSample: number;
    readonly declaredNativeSampleCount: number;
    readonly coefficients: Float64Array;
    readonly writeSample: (index: number, value: number) => void;
}

class WindowRingResampler {
    readonly supportStart: number;
    readonly supportEnd: number;
    private readonly ring = new Float64Array(WINDOW_RING_FRAMES);
    private nextNativeSample: number;
    private nextOutputSample: number;
    private finished = false;
    outputCount = 0;

    constructor(private readonly input: WindowRingResamplerInput) {
        const firstPhase = sourcePhase(input.outputStartSample, input.inputRateHz);
        const finalPhase = sourcePhase(
            Math.max(input.outputStartSample, input.outputEndSample - 1),
            input.inputRateHz,
        );
        this.supportStart = Math.max(
            0,
            firstPhase.sourceSample - (EDITORIAL_RESAMPLER_TAPS / 2 - 1),
        );
        this.supportEnd = Math.min(
            input.declaredNativeSampleCount,
            finalPhase.sourceSample + EDITORIAL_RESAMPLER_TAPS / 2 + 1,
        );
        this.nextNativeSample = this.supportStart;
        this.nextOutputSample = input.outputStartSample;
        if (input.coefficients.length
            !== EDITORIAL_RESAMPLER_TAPS * EDITORIAL_RESAMPLER_PHASES) {
            throw new Error('Managed resampler coefficient table is invalid.');
        }
    }

    append(samples: ArrayLike<number>): void {
        if (this.finished) throw new Error('Managed resampler is already finished.');
        this.ensureRingCapacity(samples.length);
        for (let index = 0; index < samples.length; index += 1) {
            const value = samples[index];
            this.ring[this.nextNativeSample % this.ring.length] = Number.isFinite(value) ? value : 0;
            this.nextNativeSample += 1;
        }
        this.drain(false);
    }

    appendZeros(sampleCount: number): void {
        if (!Number.isSafeInteger(sampleCount) || sampleCount < 0) {
            throw new Error('Managed resampler zero-fill count is invalid.');
        }
        for (let remaining = sampleCount; remaining > 0;) {
            const count = Math.min(remaining, EDITORIAL_PCM_MIX_CHUNK_FRAMES);
            this.ensureRingCapacity(count);
            for (let index = 0; index < count; index += 1) {
                this.ring[this.nextNativeSample % this.ring.length] = 0;
                this.nextNativeSample += 1;
            }
            this.drain(false);
            remaining -= count;
        }
    }

    finish(): void {
        if (this.finished) return;
        this.finished = true;
        this.drain(true);
    }

    private drain(allowFutureZero: boolean): void {
        while (this.nextOutputSample < this.input.outputEndSample) {
            const phase = sourcePhase(this.nextOutputSample, this.input.inputRateHz);
            const baseSample = phase.sourceSample - (EDITORIAL_RESAMPLER_TAPS / 2 - 1);
            const maxSample = baseSample + EDITORIAL_RESAMPLER_TAPS - 1;
            if (!allowFutureZero && maxSample >= this.nextNativeSample) return;
            let value = 0;
            const coefficientOffset = phase.phase * EDITORIAL_RESAMPLER_TAPS;
            for (let tap = 0; tap < EDITORIAL_RESAMPLER_TAPS; tap += 1) {
                const sampleIndex = baseSample + tap;
                const sampleValue = sampleIndex < this.supportStart
                    || sampleIndex >= this.supportEnd
                    || sampleIndex >= this.nextNativeSample
                    ? 0
                    : this.ring[sampleIndex % this.ring.length];
                value += sampleValue * this.input.coefficients[coefficientOffset + tap];
            }
            this.input.writeSample(this.outputCount, value);
            this.outputCount += 1;
            this.nextOutputSample += 1;
        }
    }

    private ensureRingCapacity(additionalSamples: number): void {
        if (this.nextOutputSample >= this.input.outputEndSample) return;
        const minimumNeeded = sourcePhase(
            this.nextOutputSample,
            this.input.inputRateHz,
        ).sourceSample - (EDITORIAL_RESAMPLER_TAPS / 2 - 1);
        if (this.nextNativeSample + additionalSamples - minimumNeeded > this.ring.length) {
            throw new ManagedTranscriptionError(
                'MEMORY_LIMIT_EXCEEDED',
                false,
                'The managed audio decoder exceeded its fixed ring capacity.',
            );
        }
    }
}

async function openAudioWithMediabunny(
    source: MediaByteSource,
    input: {
        readonly cacheBytes: number;
        readonly memoryBudget: MediaBudgetManager;
        readonly signal: AbortSignal;
    },
): Promise<ManagedOpenAudioResult | null> {
    // StreamSource may run two reads and retain up to twice maxCacheSize. Its standard cache and
    // admission reservations cover one cache plus one staging buffer; reserve the second pair
    // explicitly so the shared 8 MiB budget reflects the real worst-case overlap.
    const workerOverlapReservation = await input.memoryBudget.reserve(
        input.cacheBytes * 2,
        {
            label: 'managed-transcription-mediabunny-worker-overlap',
            signal: input.signal,
        },
    );
    const workerOverlapLease = workerOverlapReservation.commit();
    let mediaInput: Input;
    try {
        mediaInput = await createAdmittedMediabunnyInput(
            source,
            admittedSource => new Input({ source: admittedSource, formats: ALL_FORMATS }),
            {
                cacheBytes: input.cacheBytes,
                cacheBudget: input.memoryBudget,
                cacheAdmissionBudget: input.memoryBudget,
                signal: input.signal,
            },
        );
    } catch (error) {
        workerOverlapLease.release();
        throw error;
    }
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        input.signal.removeEventListener('abort', dispose);
        try {
            mediaInput.dispose();
        } finally {
            workerOverlapLease.release();
        }
    };
    input.signal.addEventListener('abort', dispose, { once: true });
    try {
        throwIfManagedTranscriptionAborted(input.signal);
        const track = await mediaInput.getPrimaryAudioTrack();
        throwIfManagedTranscriptionAborted(input.signal);
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

function sourcePhase(
    outputSample: number,
    nativeSampleRate: number,
): { sourceSample: number; phase: number } {
    const numerator = BigInt(outputSample) * BigInt(nativeSampleRate);
    const outputRate = BigInt(EDITORIAL_PCM_OUTPUT_SAMPLE_RATE_HZ);
    return {
        sourceSample: Number(numerator / outputRate),
        phase: Number(
            numerator % outputRate * BigInt(EDITORIAL_RESAMPLER_PHASES) / outputRate,
        ),
    };
}

function validateDecodeInput(input: {
    readonly sourceSampleCount: number;
    readonly window: import('../../../src/types/editorial').TranscriptionAcquisitionWindowV2;
}): void {
    const { decoded } = input.window;
    if (
        !Number.isSafeInteger(input.sourceSampleCount)
        || input.sourceSampleCount < 0
        || !Number.isSafeInteger(decoded.startSample)
        || !Number.isSafeInteger(decoded.endSample)
        || decoded.startSample < 0
        || decoded.endSample <= decoded.startSample
        || decoded.endSample > input.sourceSampleCount
        || decoded.endSample - decoded.startSample > 30 * EDITORIAL_PCM_OUTPUT_SAMPLE_RATE_HZ
    ) {
        throw new ManagedTranscriptionError(
            'INVALID_INPUT',
            false,
            'The managed transcription window is invalid.',
        );
    }
}

function validateAudioShape(reader: ManagedOpenAudioResult): void {
    if (
        !Number.isSafeInteger(reader.sampleRate)
        || !isSupportedEditorialPcmNativeSampleRate(reader.sampleRate)
        || !Number.isSafeInteger(reader.numberOfChannels)
        || reader.numberOfChannels <= 0
        || reader.numberOfChannels > 32
    ) {
        throw new ManagedTranscriptionError(
            'SOURCE_CHANGED',
            false,
            'The managed source audio shape is unsupported.',
        );
    }
}

function assertSampleShape(
    sample: ManagedDecodedAudioSample,
    sampleRate: number,
    channelCount: number,
): void {
    if (
        !Number.isFinite(sample.timestamp)
        || !Number.isFinite(sample.duration)
        || !Number.isSafeInteger(sample.microsecondTimestamp)
        || sample.sampleRate !== sampleRate
        || sample.numberOfChannels !== channelCount
        || !Number.isSafeInteger(sample.numberOfFrames)
        || sample.numberOfFrames < 0
        || Math.abs(sample.timestamp * 1_000_000 - sample.microsecondTimestamp) > 1
        || Math.abs(sample.duration * sampleRate - sample.numberOfFrames) > 1
    ) {
        throw new ManagedTranscriptionError(
            'SOURCE_CHANGED',
            true,
            'The managed source audio shape changed during decoding.',
        );
    }
}

function ceilRational(numerator: number, denominator: number): number {
    if (!Number.isSafeInteger(numerator) || numerator < 0) {
        throw new ManagedTranscriptionError(
            'INVALID_INPUT',
            false,
            'The managed source duration exceeds the safe sample range.',
        );
    }
    return Math.floor((numerator + denominator - 1) / denominator);
}
