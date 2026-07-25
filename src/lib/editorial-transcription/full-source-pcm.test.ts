import { describe, expect, it } from 'vitest';
import {
    prepareFullSourceEditorialPcm,
    type EditorialDecodedAudioSample,
    type OpenEditorialAudio,
} from './full-source-pcm';
import {
    ceilRationalSampleCount,
    downmixEditorialChannelsToMono,
    planNativeChunkWindow,
    quantizeEditorialPcm16,
    timestampMicrosecondsToNativeSample,
} from './pcm';
import {
    createEditorialResamplerCoefficientTable,
    serializeEditorialResamplerCoefficients,
    StreamingEditorialResampler,
} from './resampler';
import { sha256Bytes } from './canonical-json';
import coefficientFixture from './fixtures/resampler-coefficient-digests-v1.json';
import {
    createPcm16WavHeader,
    EDITORIAL_WAV_MAX_SAMPLE_COUNT,
} from './wav';

class FakeSample implements EditorialDecodedAudioSample {
    readonly timestamp: number;
    readonly duration: number;
    closeCount = 0;

    constructor(
        readonly microsecondTimestamp: number,
        readonly sampleRate: number,
        readonly channels: readonly number[][],
    ) {
        this.timestamp = microsecondTimestamp / 1_000_000;
        this.numberOfFrames = channels[0]?.length ?? 0;
        this.numberOfChannels = channels.length;
        this.duration = this.numberOfFrames / sampleRate;
    }

    readonly numberOfFrames: number;
    readonly numberOfChannels: number;

    copyTo(destination: Float32Array, options: {
        planeIndex: number;
        format: 'f32-planar';
        frameOffset: number;
        frameCount: number;
    }): void {
        const source = this.channels[options.planeIndex];
        for (let index = 0; index < options.frameCount; index += 1) {
            destination[index] = source[options.frameOffset + index];
        }
    }

    close(): void {
        this.closeCount += 1;
    }
}

function fakeOpen(
    sampleRate: number,
    samples: FakeSample[],
    onDispose: () => void = () => undefined,
): OpenEditorialAudio {
    return async () => ({
        sampleRate,
        numberOfChannels: samples[0]?.numberOfChannels ?? 1,
        samples: (async function* () {
            for (const sample of samples) yield sample;
        })(),
        dispose: onDispose,
    });
}

async function readWavSamples(wav: Blob): Promise<Int16Array> {
    const bytes = await wav.arrayBuffer();
    const view = new DataView(bytes, 44);
    const samples = new Int16Array((bytes.byteLength - 44) / 2);
    for (let index = 0; index < samples.length; index += 1) {
        samples[index] = view.getInt16(index * 2, true);
    }
    return samples;
}

describe('editorial source-zero PCM primitives', () => {
    it('uses rational ceil counts and nearest-sample ties toward the later sample', () => {
        expect(ceilRationalSampleCount({ numerator: 1, denominator: 3 }, 16_000)).toBe(5_334);
        expect(timestampMicrosecondsToNativeSample(500_000, 1)).toBe(1);
        expect(timestampMicrosecondsToNativeSample(-500_000, 1)).toBe(0);
    });

    it('plans leading gaps, overlap trimming and declared-duration clipping', () => {
        expect(planNativeChunkWindow({
            timestampMicroseconds: 250_000,
            sampleRateHz: 8,
            numberOfFrames: 4,
            nextNativeSample: 0,
            declaredNativeSampleCount: 8,
        })).toEqual({
            gapFrames: 2,
            sourceFrameOffset: 0,
            frameCount: 4,
            destinationStartFrame: 2,
            destinationEndFrame: 6,
        });
        expect(planNativeChunkWindow({
            timestampMicroseconds: 375_000,
            sampleRateHz: 8,
            numberOfFrames: 4,
            nextNativeSample: 6,
            declaredNativeSampleCount: 8,
        })).toEqual({
            gapFrames: 0,
            sourceFrameOffset: 3,
            frameCount: 1,
            destinationStartFrame: 6,
            destinationEndFrame: 7,
        });
    });

    it('downmixes in Float64 with non-finite channels replaced by zero', () => {
        expect(Array.from(downmixEditorialChannelsToMono(3, 2, channel => [
            [1, Number.NaN],
            [-1, Number.POSITIVE_INFINITY],
            [0.5, 0.75],
        ][channel]))).toEqual([1 / 6, 0.25]);
    });

    it('quantizes exact edges and half ties away from zero', () => {
        expect(quantizeEditorialPcm16(-1)).toBe(-32_768);
        expect(quantizeEditorialPcm16(1)).toBe(32_767);
        expect(quantizeEditorialPcm16(-0.5 / 32_768)).toBe(-1);
        expect(quantizeEditorialPcm16(0.5 / 32_767)).toBe(1);
        expect(quantizeEditorialPcm16(Number.NaN)).toBe(0);
    });
});

describe('editorial deterministic sinc resampler', () => {
    it('keeps exact phase continuity across arbitrary native chunk boundaries', () => {
        const input = Float64Array.from({ length: 512 }, (_, index) => Math.sin(index / 13));
        const options = { inputRateHz: 48_000, targetSampleCount: 171 };
        const whole = new StreamingEditorialResampler(options);
        const wholeOutput = [
            ...Array.from(whole.append(input)),
            ...Array.from(whole.finish()),
        ];
        const chunked = new StreamingEditorialResampler(options);
        const chunkedOutput = [
            ...Array.from(chunked.append(input.subarray(0, 17))),
            ...Array.from(chunked.append(input.subarray(17, 300))),
            ...Array.from(chunked.append(input.subarray(300))),
            ...Array.from(chunked.finish()),
        ];
        expect(chunkedOutput).toEqual(wholeOutput);
    });

    it('produces stable coefficient digests for two native rates', async () => {
        await expect(sha256Bytes(serializeEditorialResamplerCoefficients(
            createEditorialResamplerCoefficientTable(44_100),
        ))).resolves.toBe(coefficientFixture.digestsByInputRateHz['44100']);
        await expect(sha256Bytes(serializeEditorialResamplerCoefficients(
            createEditorialResamplerCoefficientTable(48_000),
        ))).resolves.toBe(coefficientFixture.digestsByInputRateHz['48000']);
    });

    it('rejects native rates without an immutable V1 coefficient table', () => {
        expect(() => createEditorialResamplerCoefficientTable(32_000))
            .toThrow('does not include an immutable 32000 Hz');
    });

    it('does not expose the cached immutable coefficient bytes to caller mutation', () => {
        const first = createEditorialResamplerCoefficientTable(48_000);
        const expected = first[0];
        first[0] = Number.NaN;
        expect(createEditorialResamplerCoefficientTable(48_000)[0]).toBe(expected);
    });
});

describe('full-source editorial WAV construction', () => {
    it.each([44_100, 48_000])('emits the exact target count from native rate %i', async (sampleRate) => {
        const nativeFrames = Math.ceil(sampleRate / 100);
        const sample = new FakeSample(0, sampleRate, [
            Array.from({ length: nativeFrames }, (_, index) => Math.sin(index / 10)),
        ]);
        const result = await prepareFullSourceEditorialPcm({
            file: new File([], 'source.wav'),
            declaredDuration: { numerator: 1, denominator: 100 },
            openAudio: fakeOpen(sampleRate, [sample]),
        });
        expect(result.sampleCount).toBe(160);
        expect((await readWavSamples(result.wav as Blob)).length).toBe(160);
        expect(sample.closeCount).toBe(1);
    });

    it('writes the exact canonical RIFF header and rejects 32-bit payload overflow', () => {
        const header = new DataView(createPcm16WavHeader(3).buffer);
        expect(header.getUint32(4, true)).toBe(42);
        expect(header.getUint16(20, true)).toBe(1);
        expect(header.getUint16(22, true)).toBe(1);
        expect(header.getUint32(24, true)).toBe(16_000);
        expect(header.getUint32(28, true)).toBe(32_000);
        expect(header.getUint16(34, true)).toBe(16);
        expect(header.getUint32(40, true)).toBe(6);
        expect(() => createPcm16WavHeader(EDITORIAL_WAV_MAX_SAMPLE_COUNT + 1))
            .toThrow('outside the RIFF limit');
    });

    it('zero-fills leading/internal/trailing gaps, trims overlap and emits exact WAV size', async () => {
        const first = new FakeSample(125_000, 48_000, [[1, 1, 1, 1], [1, 1, 1, 1]]);
        const overlapping = new FakeSample(125_042, 48_000, [[-1, -1, -1, -1], [-1, -1, -1, -1]]);
        const afterGap = new FakeSample(125_167, 48_000, [[0.5, 0.5], [0.5, 0.5]]);
        let disposeCount = 0;
        const result = await prepareFullSourceEditorialPcm({
            file: new File([], 'source.webm'),
            declaredDuration: { numerator: 1, denominator: 2 },
            openAudio: fakeOpen(48_000, [first, overlapping, afterGap], () => {
                disposeCount += 1;
            }),
        });
        expect(result.sampleCount).toBe(8_000);
        expect(result.wav?.size).toBe(44 + result.sampleCount * 2);
        expect(first.closeCount).toBe(1);
        expect(overlapping.closeCount).toBe(1);
        expect(afterGap.closeCount).toBe(1);
        expect(disposeCount).toBe(1);
        expect((await readWavSamples(result.wav as Blob)).length).toBe(8_000);
    });

    it('creates a deterministic no-audio result without a WAV or decoder request', async () => {
        let opens = 0;
        const result = await prepareFullSourceEditorialPcm({
            file: new File([], 'silent.webm'),
            declaredDuration: { numerator: 3, denominator: 2 },
            openAudio: async () => {
                opens += 1;
                return null;
            },
        });
        expect(opens).toBe(1);
        expect(result).toEqual({
            sampleRateHz: 16_000,
            sampleCount: 24_000,
            hasAudioStream: false,
            wav: null,
        });
    });

    it('closes the current sample and reader on abort without publishing a partial WAV', async () => {
        const controller = new AbortController();
        const sample = new FakeSample(0, 48_000, [[0, 0, 0, 0]]);
        let disposeCount = 0;
        const openAudio: OpenEditorialAudio = async () => ({
            sampleRate: 48_000,
            numberOfChannels: 1,
            samples: (async function* () {
                yield sample;
                controller.abort();
            })(),
            dispose: () => {
                disposeCount += 1;
            },
        });
        await expect(prepareFullSourceEditorialPcm({
            file: new File([], 'source.webm'),
            declaredDuration: { numerator: 1, denominator: 1 },
            signal: controller.signal,
            openAudio,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(sample.closeCount).toBe(1);
        expect(disposeCount).toBe(1);
    });
});
