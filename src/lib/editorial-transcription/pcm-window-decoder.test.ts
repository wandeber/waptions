import { describe, expect, it, vi } from 'vitest';
import { quantizeEditorialPcm16 } from './pcm';
import type { EditorialPcmWindowAudioSample } from './pcm-window-decoder';
import { createMediabunnyEditorialPcmWindowDecoder } from './pcm-window-decoder';
import { StreamingEditorialResampler } from './resampler';
import { MediaBudgetManager } from '@/lib/media-byte-source/budget-manager';

class FakeWindowSample implements EditorialPcmWindowAudioSample {
    readonly timestamp: number;
    readonly microsecondTimestamp: number;
    readonly duration: number;
    readonly numberOfFrames: number;
    readonly numberOfChannels: number;
    readonly close = vi.fn();

    constructor(
        timestampMicroseconds: number,
        readonly sampleRate: number,
        private readonly channels: readonly Float32Array[],
    ) {
        this.timestamp = timestampMicroseconds / 1_000_000;
        this.microsecondTimestamp = timestampMicroseconds;
        this.numberOfFrames = channels[0]?.length ?? 0;
        this.numberOfChannels = channels.length;
        this.duration = this.numberOfFrames / sampleRate;
    }

    copyTo(destination: Float32Array, options: {
        planeIndex: number;
        format: 'f32-planar';
        frameOffset: number;
        frameCount: number;
    }): void {
        destination.set(this.channels[options.planeIndex].subarray(
            options.frameOffset,
            options.frameOffset + options.frameCount,
        ));
    }
}

describe('phase-aligned editorial PCM window decoder', () => {
    it.each([44_100, 48_000])('decodes only bounded support at %i Hz on the source-zero phase grid', async (sampleRate) => {
        const frames = new Float32Array(sampleRate * 2);
        for (let index = 0; index < frames.length; index += 1) {
            frames[index] = Math.sin(2 * Math.PI * 440 * index / sampleRate) * 0.5;
        }
        const sample = new FakeWindowSample(0, sampleRate, [frames]);
        const requestedRanges: Array<[number, number]> = [];
        const dispose = vi.fn();
        const pcmBudget = new MediaBudgetManager('editorial-window-test', 1024 * 1024);
        const decoder = createMediabunnyEditorialPcmWindowDecoder({
            resolveSource: () => ({
                file: {} as File,
                declaredDuration: { numerator: 2, denominator: 1 },
            }),
            openAudio: async () => ({
                sampleRate,
                numberOfChannels: 1,
                samples: async function* (startSeconds, endSeconds) {
                    requestedRanges.push([startSeconds, endSeconds]);
                    yield sample;
                },
                dispose,
            }),
            pcmBudget,
        });

        const result = await decoder.decodeWindow({
            sourceFingerprint: 'source-fingerprint',
            pcmAlgorithmVersion: 1,
            startSample: 12_345,
            endSample: 13_145,
            filterPaddingSamples: 64,
        });

        const fullSource = new StreamingEditorialResampler({
            inputRateHz: sampleRate,
            targetSampleCount: 32_000,
        });
        const fullSourcePcm16 = Int16Array.from(
            Array.from(fullSource.append(frames)).concat(Array.from(fullSource.finish())),
            quantizeEditorialPcm16,
        );

        expect(result).toHaveLength(800);
        expect(result).toEqual(fullSourcePcm16.slice(12_345, 13_145));
        expect(requestedRanges).toHaveLength(1);
        expect(requestedRanges[0][0]).toBeGreaterThan(0.7);
        expect(requestedRanges[0][1] - requestedRanges[0][0]).toBeLessThan(0.07);
        expect(sample.close).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
        expect(pcmBudget.snapshot().peakBytes).toBeLessThanOrEqual(pcmBudget.maxBytes);
        pcmBudget.assertDrained();
    });

    it('zero-fills a source without audio and rejects unsupported native rates', async () => {
        const source = {
            file: {} as File,
            declaredDuration: { numerator: 1, denominator: 1 },
        };
        const noAudio = createMediabunnyEditorialPcmWindowDecoder({
            resolveSource: () => source,
            openAudio: async () => null,
        });
        await expect(noAudio.decodeWindow({
            sourceFingerprint: 'source-fingerprint',
            pcmAlgorithmVersion: 1,
            startSample: 100,
            endSample: 200,
            filterPaddingSamples: 64,
        })).resolves.toEqual(new Int16Array(100));

        const dispose = vi.fn();
        const unsupported = createMediabunnyEditorialPcmWindowDecoder({
            resolveSource: () => source,
            openAudio: async () => ({
                sampleRate: 32_000,
                numberOfChannels: 1,
                samples: async function* () { return; },
                dispose,
            }),
        });
        await expect(unsupported.decodeWindow({
            sourceFingerprint: 'source-fingerprint',
            pcmAlgorithmVersion: 1,
            startSample: 100,
            endSample: 200,
            filterPaddingSamples: 64,
        })).rejects.toThrow('supports native 44100 Hz and 48000 Hz');
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('disposes the reader and closes the current sample when cancellation becomes visible', async () => {
        const controller = new AbortController();
        const sample = new FakeWindowSample(0, 48_000, [new Float32Array(48_000)]);
        const dispose = vi.fn();
        const decoder = createMediabunnyEditorialPcmWindowDecoder({
            resolveSource: () => ({
                file: {} as File,
                declaredDuration: { numerator: 1, denominator: 1 },
            }),
            openAudio: async () => ({
                sampleRate: 48_000,
                numberOfChannels: 1,
                samples: async function* () {
                    controller.abort();
                    yield sample;
                },
                dispose,
            }),
        });

        await expect(decoder.decodeWindow({
            sourceFingerprint: 'source-fingerprint',
            pcmAlgorithmVersion: 1,
            startSample: 100,
            endSample: 200,
            filterPaddingSamples: 64,
            signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(sample.close).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
    });
});
