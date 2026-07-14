import { describe, expect, it } from 'vitest';
import type {
    AudioSample,
    AudioSampleSource,
    BufferTarget,
    InputAudioTrack,
} from 'mediabunny';
import {
    addNonNegativeAudioSample,
    extractAudio,
    inspectMediaTracks,
    type AudioExtractionDependencies,
    type MediaInspectionInput,
} from './mediabunny-utils';

class FakeAudioSample {
    closeCount = 0;
    clonedSample: FakeAudioSample | null = null;

    constructor(
        public timestamp: number,
        public duration: number,
    ) { }

    clone() {
        this.clonedSample = new FakeAudioSample(this.timestamp, this.duration);
        return this.clonedSample;
    }

    setTimestamp(timestamp: number) {
        this.timestamp = timestamp;
    }

    close() {
        this.closeCount++;
    }
}

class FakeAudioSampleSource {
    addedSamples: FakeAudioSample[] = [];
    shouldFail = false;
    closeCount = 0;

    async add(sample: FakeAudioSample) {
        if (this.shouldFail) {
            throw new Error('encoder rejected sample');
        }

        this.addedSamples.push(sample);
    }

    close() {
        this.closeCount += 1;
    }
}

interface AudioExtractionHarnessOptions {
    audioTrack?: InputAudioTrack | null;
    failStart?: boolean;
    failFinalizeBeforeFinalizing?: boolean;
    failFinalizeDuringFinalizing?: boolean;
    failSampleAdd?: boolean;
}

function createAudioExtractionHarness(options: AudioExtractionHarnessOptions = {}) {
    const source = new FakeAudioSampleSource();
    source.shouldFail = options.failSampleAdd ?? false;
    const sample = new FakeAudioSample(0, 0.02);
    const encodedBuffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const target = { buffer: null as ArrayBuffer | null };
    const audioTrack = options.audioTrack === undefined
        ? ({} as InputAudioTrack)
        : options.audioTrack;

    let disposeCount = 0;
    let cancelCount = 0;
    let finalizeCount = 0;
    let startCount = 0;
    let addedSource: AudioSampleSource | null = null;
    const output = {
        state: 'pending' as 'pending' | 'started' | 'canceled' | 'finalizing' | 'finalized',
        addAudioTrack(added: AudioSampleSource) {
            addedSource = added;
        },
        async start() {
            startCount += 1;
            this.state = 'started';
            if (options.failStart) throw new Error('output start failed');
        },
        async finalize() {
            finalizeCount += 1;
            if (options.failFinalizeBeforeFinalizing) {
                throw new Error('output finalize failed before finalizing');
            }
            this.state = 'finalizing';
            if (options.failFinalizeDuringFinalizing) {
                throw new Error('output finalize failed while finalizing');
            }
            target.buffer = encodedBuffer;
            this.state = 'finalized';
        },
        async cancel() {
            cancelCount += 1;
            this.state = 'canceled';
        },
    };
    const dependencies = {
        createInput: () => ({
            getPrimaryAudioTrack: async () => audioTrack,
            dispose: () => {
                disposeCount += 1;
            },
        }),
        createTarget: () => target as BufferTarget,
        createOutput: () => output,
        selectCodec: async () => 'aac' as const,
        createSource: () => source as unknown as AudioSampleSource,
        createSink: () => ({
            async *samples() {
                yield sample as unknown as AudioSample;
            },
        }),
    } as AudioExtractionDependencies;

    return {
        dependencies,
        encodedBuffer,
        output,
        sample,
        source,
        get addedSource() {
            return addedSource;
        },
        get cancelCount() {
            return cancelCount;
        },
        get disposeCount() {
            return disposeCount;
        },
        get finalizeCount() {
            return finalizeCount;
        },
        get startCount() {
            return startCount;
        },
    };
}

describe('addNonNegativeAudioSample', () => {
    it('clamps overlapping negative samples and closes the original and clone', async () => {
        const source = new FakeAudioSampleSource();
        const sample = new FakeAudioSample(-0.001451, 0.02);

        const added = await addNonNegativeAudioSample(
            source as unknown as AudioSampleSource,
            sample as unknown as AudioSample,
        );

        expect(added).toBe(true);
        expect(source.addedSamples).toHaveLength(1);
        expect(source.addedSamples[0].timestamp).toBe(0);
        expect(sample.closeCount).toBe(1);
        expect(sample.clonedSample?.closeCount).toBe(1);
    });

    it('skips fully negative samples and still closes them', async () => {
        const source = new FakeAudioSampleSource();
        const sample = new FakeAudioSample(-0.03, 0.01);

        const added = await addNonNegativeAudioSample(
            source as unknown as AudioSampleSource,
            sample as unknown as AudioSample,
        );

        expect(added).toBe(false);
        expect(source.addedSamples).toHaveLength(0);
        expect(sample.closeCount).toBe(1);
        expect(sample.clonedSample).toBeNull();
    });

    it('closes samples even when the encoder rejects them', async () => {
        const source = new FakeAudioSampleSource();
        source.shouldFail = true;
        const sample = new FakeAudioSample(0, 0.02);

        await expect(addNonNegativeAudioSample(
            source as unknown as AudioSampleSource,
            sample as unknown as AudioSample,
        )).rejects.toThrow('encoder rejected sample');

        expect(sample.closeCount).toBe(1);
    });
});

describe('extractAudio', () => {
    it('finalizes the buffer and releases each owned resource exactly once', async () => {
        const harness = createAudioExtractionHarness();

        const blob = await extractAudio({} as File, harness.dependencies);

        expect(blob.type).toBe('audio/mp4');
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
            new Uint8Array(harness.encodedBuffer),
        );
        expect(harness.addedSource).toBe(harness.source);
        expect(harness.startCount).toBe(1);
        expect(harness.finalizeCount).toBe(1);
        expect(harness.cancelCount).toBe(0);
        expect(harness.source.closeCount).toBe(1);
        expect(harness.sample.closeCount).toBe(1);
        expect(harness.disposeCount).toBe(1);
        expect(harness.output.state).toBe('finalized');
    });

    it('cancels a started output and disposes the input when sample encoding fails', async () => {
        const harness = createAudioExtractionHarness({ failSampleAdd: true });

        await expect(extractAudio({} as File, harness.dependencies))
            .rejects.toThrow('encoder rejected sample');

        expect(harness.finalizeCount).toBe(0);
        expect(harness.cancelCount).toBe(1);
        expect(harness.source.closeCount).toBe(1);
        expect(harness.sample.closeCount).toBe(1);
        expect(harness.disposeCount).toBe(1);
        expect(harness.output.state).toBe('canceled');
    });

    it('closes the source, cancels the output, and disposes the input when start fails', async () => {
        const harness = createAudioExtractionHarness({ failStart: true });

        await expect(extractAudio({} as File, harness.dependencies))
            .rejects.toThrow('output start failed');

        expect(harness.finalizeCount).toBe(0);
        expect(harness.cancelCount).toBe(1);
        expect(harness.source.closeCount).toBe(1);
        expect(harness.sample.closeCount).toBe(0);
        expect(harness.disposeCount).toBe(1);
    });

    it('cancels when finalize fails before Mediabunny enters its non-cancelable finalizing state', async () => {
        const harness = createAudioExtractionHarness({ failFinalizeBeforeFinalizing: true });

        await expect(extractAudio({} as File, harness.dependencies))
            .rejects.toThrow('output finalize failed before finalizing');

        expect(harness.cancelCount).toBe(1);
        expect(harness.source.closeCount).toBe(1);
        expect(harness.disposeCount).toBe(1);
    });

    it('does not re-cancel an output after Mediabunny has entered finalization', async () => {
        const harness = createAudioExtractionHarness({ failFinalizeDuringFinalizing: true });

        await expect(extractAudio({} as File, harness.dependencies))
            .rejects.toThrow('output finalize failed while finalizing');

        expect(harness.cancelCount).toBe(0);
        expect(harness.source.closeCount).toBe(1);
        expect(harness.disposeCount).toBe(1);
        expect(harness.output.state).toBe('finalizing');
    });

    it('disposes the input when no audio track exists without constructing output resources', async () => {
        const harness = createAudioExtractionHarness({ audioTrack: null });

        await expect(extractAudio({} as File, harness.dependencies))
            .rejects.toThrow('No audio track found in the file');

        expect(harness.startCount).toBe(0);
        expect(harness.finalizeCount).toBe(0);
        expect(harness.cancelCount).toBe(0);
        expect(harness.source.closeCount).toBe(0);
        expect(harness.disposeCount).toBe(1);
    });
});

describe('inspectMediaTracks', () => {
    it('returns primary video and audio metadata and disposes the owning input', async () => {
        let disposeCount = 0;
        const input = {
            computeDuration: async () => 2.5,
            getPrimaryVideoTrack: async () => ({
                displayWidth: 1920,
                displayHeight: 1080,
                codec: 'avc',
                computePacketStats: async () => ({
                    packetCount: 75,
                    averagePacketRate: 29.971,
                    averageBitrate: 4_000_000,
                }),
            }),
            getPrimaryAudioTrack: async () => ({
                sampleRate: 48_000,
                numberOfChannels: 2,
                codec: 'aac',
                computePacketStats: async () => ({
                    packetCount: 120,
                    averagePacketRate: 48,
                    averageBitrate: 127_999.7,
                }),
            }),
            dispose: () => {
                disposeCount += 1;
            },
        } as unknown as MediaInspectionInput;

        const result = await inspectMediaTracks({} as File, () => input);

        expect(result).toEqual({
            duration: 2.5,
            video: { width: 1920, height: 1080, fps: 29.97, codec: 'avc' },
            audio: {
                sampleRate: 48_000,
                numberOfChannels: 2,
                codec: 'aac',
                bitrate: 128_000,
            },
        });
        expect(disposeCount).toBe(1);
    });

    it('keeps valid audio when optional bitrate statistics fail', async () => {
        const input = {
            computeDuration: async () => 1,
            getPrimaryVideoTrack: async () => null,
            getPrimaryAudioTrack: async () => ({
                sampleRate: 44_100,
                numberOfChannels: 1,
                codec: 'mp3',
                computePacketStats: async () => {
                    throw new Error('stats unavailable');
                },
            }),
            dispose() { },
        } as unknown as MediaInspectionInput;

        await expect(inspectMediaTracks({} as File, () => input)).resolves.toEqual({
            duration: 1,
            video: null,
            audio: {
                sampleRate: 44_100,
                numberOfChannels: 1,
                codec: 'mp3',
                bitrate: null,
            },
        });
    });

    it('disposes the input when primary track probing throws', async () => {
        let disposeCount = 0;
        const input = {
            computeDuration: async () => 1,
            getPrimaryVideoTrack: async () => {
                throw new Error('malformed container');
            },
            getPrimaryAudioTrack: async () => null,
            dispose: () => {
                disposeCount += 1;
            },
        } as unknown as MediaInspectionInput;

        await expect(inspectMediaTracks({} as File, () => input))
            .rejects.toThrow('malformed container');
        expect(disposeCount).toBe(1);
    });
});
