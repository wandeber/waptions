import { describe, expect, it } from 'vitest';
import type { MediaByteSource } from '../../../src/lib/media-byte-source/types';
import { quantizeEditorialPcm16 } from '../../../src/lib/editorial-transcription/pcm';
import {
    StreamingEditorialResampler,
} from '../../../src/lib/editorial-transcription/resampler';
import {
    MANAGED_TRANSCRIPTION_MEMORY_MAX_BYTES,
    ManagedStreamingPcmWindowDecoder,
    type ManagedDecodedAudioSample,
} from './streaming-pcm-window-decoder';

const fingerprint = `sha256:${'4'.repeat(64)}`;

describe('managed streaming PCM window decoder', () => {
    it.each([44_100, 48_000])(
        'keeps a real 30-second %i Hz window below the aggregate 8 MiB budget',
        async (nativeSampleRate) => {
            let sampleCloseCount = 0;
            let readerDisposeCount = 0;
            const sampleCount = 30 * 16_000;
            const decoder = new ManagedStreamingPcmWindowDecoder({
                openAudio: async () => ({
                    sampleRate: nativeSampleRate,
                    numberOfChannels: 2,
                    async *samples() {
                        const totalFrames = nativeSampleRate * 30;
                        for (let startFrame = 0; startFrame < totalFrames; startFrame += 16_384) {
                            yield fakeSample({
                                sampleRate: nativeSampleRate,
                                startFrame,
                                frameCount: Math.min(16_384, totalFrames - startFrame),
                                channels: 2,
                                onClose: () => { sampleCloseCount += 1; },
                            });
                        }
                    },
                    dispose: () => { readerDisposeCount += 1; },
                }),
            });

            const decoded = await decoder.decode({
                source: dummySource(),
                sourceSampleCount: sampleCount,
                window: {
                    windowId: `sha256:${'5'.repeat(64)}`,
                    core: { startSample: 0, endSample: sampleCount },
                    decoded: { startSample: 0, endSample: sampleCount },
                    chunkRecordIds: [],
                },
                signal: new AbortController().signal,
            });

            expect(decoded.wav?.size).toBe(44 + sampleCount * 2);
            expect(sampleCloseCount).toBe(Math.ceil(nativeSampleRate * 30 / 16_384));
            expect(readerDisposeCount).toBe(1);
            const live = decoder.memoryBudget.snapshot();
            expect(live.peakBytes).toBeLessThanOrEqual(MANAGED_TRANSCRIPTION_MEMORY_MAX_BYTES);
            // The old whole-native-window Float64 allocation alone exceeded 10 MiB.
            expect(nativeSampleRate * 30 * Float64Array.BYTES_PER_ELEMENT)
                .toBeGreaterThan(MANAGED_TRANSCRIPTION_MEMORY_MAX_BYTES);
            decoded.release();
            decoder.memoryBudget.assertDrained();
        },
        30_000,
    );

    it('closes samples/readers and releases every reservation on cancellation', async () => {
        const controller = new AbortController();
        let sampleCloseCount = 0;
        let readerDisposeCount = 0;
        const decoder = new ManagedStreamingPcmWindowDecoder({
            openAudio: async () => ({
                sampleRate: 48_000,
                numberOfChannels: 1,
                async *samples() {
                    yield fakeSample({
                        sampleRate: 48_000,
                        startFrame: 0,
                        frameCount: 48_000,
                        channels: 1,
                        onCopy: () => controller.abort(),
                        onClose: () => { sampleCloseCount += 1; },
                    });
                },
                dispose: () => { readerDisposeCount += 1; },
            }),
        });

        await expect(decoder.decode({
            source: dummySource(),
            sourceSampleCount: 16_000,
            window: {
                windowId: `sha256:${'6'.repeat(64)}`,
                core: { startSample: 0, endSample: 16_000 },
                decoded: { startSample: 0, endSample: 16_000 },
                chunkRecordIds: [],
            },
            signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(sampleCloseCount).toBe(1);
        expect(readerDisposeCount).toBe(1);
        decoder.memoryBudget.assertDrained();
    });

    it('rejects a window above thirty seconds before opening media', async () => {
        let opened = false;
        const decoder = new ManagedStreamingPcmWindowDecoder({
            openAudio: async () => {
                opened = true;
                return null;
            },
        });
        const endSample = 30 * 16_000 + 1;
        await expect(decoder.decode({
            source: dummySource(),
            sourceSampleCount: endSample,
            window: {
                windowId: `sha256:${'7'.repeat(64)}`,
                core: { startSample: 0, endSample },
                decoded: { startSample: 0, endSample },
                chunkRecordIds: [],
            },
            signal: new AbortController().signal,
        })).rejects.toMatchObject({
            transcriptionCode: 'INVALID_INPUT',
        });
        expect(opened).toBe(false);
    });

    it.each([44_100, 48_000])(
        'matches the canonical source-zero phase for a nonzero %i Hz window',
        async (nativeSampleRate) => {
            const native = Float32Array.from(
                { length: nativeSampleRate },
                (_value, index) => (
                    Math.sin(index * 0.017) * 0.6
                    + Math.cos(index * 0.0031) * 0.2
                ),
            );
            const canonical = new StreamingEditorialResampler({
                inputRateHz: nativeSampleRate,
                targetSampleCount: 16_000,
            });
            const expected = concatenate([
                canonical.append(native),
                canonical.finish(),
            ]);
            const startSample = 4_321;
            const endSample = 9_876;
            const decoder = new ManagedStreamingPcmWindowDecoder({
                openAudio: async () => ({
                    sampleRate: nativeSampleRate,
                    numberOfChannels: 1,
                    async *samples() {
                        for (
                            let startFrame = 0;
                            startFrame < native.length;
                            startFrame += 16_384
                        ) {
                            yield fakeSample({
                                sampleRate: nativeSampleRate,
                                startFrame,
                                frameCount: Math.min(
                                    16_384,
                                    native.length - startFrame,
                                ),
                                channels: 1,
                                valueAt: index => native[index],
                                onClose: () => undefined,
                            });
                        }
                    },
                    dispose: () => undefined,
                }),
            });

            const decoded = await decoder.decode({
                source: dummySource(),
                sourceSampleCount: 16_000,
                window: {
                    windowId: `sha256:${'8'.repeat(64)}`,
                    core: { startSample, endSample },
                    decoded: { startSample, endSample },
                    chunkRecordIds: [],
                },
                signal: new AbortController().signal,
            });
            if (!decoded.wav) throw new Error('Expected a decoded WAV.');
            const wav = new DataView(await decoded.wav.arrayBuffer());
            const actual = Array.from(
                { length: endSample - startSample },
                (_value, index) => wav.getInt16(44 + index * 2, true),
            );
            expect(actual).toEqual(
                Array.from(
                    expected.subarray(startSample, endSample),
                    quantizeEditorialPcm16,
                ),
            );
            decoded.release();
            decoder.memoryBudget.assertDrained();
        },
        30_000,
    );
});

function fakeSample(input: {
    sampleRate: number;
    startFrame: number;
    frameCount: number;
    channels: number;
    valueAt?: (nativeFrame: number) => number;
    onCopy?: () => void;
    onClose: () => void;
}): ManagedDecodedAudioSample {
    let closed = false;
    const microsecondTimestamp = Math.round(
        input.startFrame * 1_000_000 / input.sampleRate,
    );
    return {
        timestamp: microsecondTimestamp / 1_000_000,
        microsecondTimestamp,
        duration: input.frameCount / input.sampleRate,
        sampleRate: input.sampleRate,
        numberOfFrames: input.frameCount,
        numberOfChannels: input.channels,
        copyTo(destination, options) {
            input.onCopy?.();
            for (let index = 0; index < destination.length; index += 1) {
                destination[index] = input.valueAt?.(
                    input.startFrame + options.frameOffset + index,
                ) ?? 0.25;
            }
        },
        close() {
            if (closed) throw new Error('sample closed twice');
            closed = true;
            input.onClose();
        },
    };
}

function concatenate(values: readonly Float64Array[]): Float64Array {
    const output = new Float64Array(
        values.reduce((total, value) => total + value.length, 0),
    );
    let offset = 0;
    for (const value of values) {
        output.set(value, offset);
        offset += value.length;
    }
    return output;
}

function dummySource(): MediaByteSource {
    return {
        sourceId: 'source-1',
        identity: { fingerprint, sizeBytes: 0 },
        size: async () => 0,
        read: async () => new Uint8Array(),
        stream: () => new ReadableStream({
            start(controller) {
                controller.close();
            },
        }),
        verify: async () => ({ fingerprint, sizeBytes: 0 }),
        close: async () => undefined,
    };
}
