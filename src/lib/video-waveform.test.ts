import { describe, expect, it } from 'vitest';
import type { WaveformPeaks } from './video-waveform';
import type { AudioSourceAsset, VideoSourceAsset } from '@/types/video';
import type { AudioMediaAsset, AudioMediaReference } from './media-asset-ref';
import {
    appendWaveformSamples,
    createWaveformLru,
    createWaveformPeakAggregator,
    estimateWaveformPeaksBytes,
    extractAudioMediaWaveformPeaks,
    finalizeWaveformPeaks,
    getWaveformBucketCount,
    getWaveformFromLru,
    getWaveformSampleWindow,
    getVisibleWaveformSourceIds,
    getVisibleVideoAudioReferences,
    mixWaveformChannelsToMono,
    putWaveformInLru,
    selectRequestedAudioMedia,
    selectRequestedAudibleSources,
    snapshotWaveformsFromLru,
} from './video-waveform';

const peaks = (value: number): WaveformPeaks => ({
    duration: 1,
    sampleRate: 48_000,
    bucketCount: 2,
    min: new Float32Array([value, value]),
    max: new Float32Array([value, value]),
});

const source = (id: string, hasAudio = true): VideoSourceAsset => ({
    id,
    originalName: `${id}.mp4`,
    mimeType: 'video/mp4',
    size: 1,
    lastModified: 1,
    fingerprint: `${id}:fingerprint`,
    duration: 10,
    fps: 30,
    width: 1920,
    height: 1080,
    bitrate: null,
    hasAudio,
    file: {} as File,
});

const audioSource = (id: string): AudioSourceAsset => ({
    id,
    originalName: `${id}.wav`,
    mimeType: 'audio/wav',
    size: 1,
    lastModified: 1,
    fingerprint: `${id}:fingerprint`,
    duration: 1,
    nativeSampleRate: 4,
    nativeSampleCount: 4,
    nativeChannelCount: 1,
    bitrate: null,
    codec: 'pcm-s16',
    file: {} as File,
});

const videoAudioRef = (videoSourceId: string): AudioMediaReference => ({
    kind: 'video-source-audio',
    videoSourceId,
});

const importedAudioRef = (audioSourceId: string): AudioMediaReference => ({
    kind: 'audio-source',
    audioSourceId,
});

describe('waveform peak aggregation', () => {
    it('enforces the bucket floor and cap for zero, short, and long sources', () => {
        expect(getWaveformBucketCount(0)).toBe(1_000);
        expect(getWaveformBucketCount(0.01)).toBe(1_000);
        expect(getWaveformBucketCount(11)).toBe(1_100);
        expect(getWaveformBucketCount(2_000)).toBe(100_000);
    });

    it('aggregates extrema identically across arbitrary streamed chunk boundaries', () => {
        const streamed = createWaveformPeakAggregator(1, 4_000);
        appendWaveformSamples(streamed, new Float32Array([0.5, -0.5, 0.1]));
        appendWaveformSamples(streamed, new Float32Array([-0.8, 0.9, -0.2, 0.4, -0.6]));

        const singleChunk = createWaveformPeakAggregator(1, 4_000);
        appendWaveformSamples(singleChunk, new Float32Array([0.5, -0.5, 0.1, -0.8, 0.9, -0.2, 0.4, -0.6]));

        const streamedPeaks = finalizeWaveformPeaks(streamed);
        const singleChunkPeaks = finalizeWaveformPeaks(singleChunk);
        expect(streamedPeaks.min[0]).toBeCloseTo(-0.8);
        expect(streamedPeaks.min[1]).toBeCloseTo(-0.6);
        expect(streamedPeaks.max[0]).toBeCloseTo(0.5);
        expect(streamedPeaks.max[1]).toBeCloseTo(0.9);
        expect(streamedPeaks.min).toEqual(singleChunkPeaks.min);
        expect(streamedPeaks.max).toEqual(singleChunkPeaks.max);
    });

    it('returns neutral zero buckets for a zero-duration waveform', () => {
        const aggregator = createWaveformPeakAggregator(0);
        appendWaveformSamples(aggregator, new Float32Array([1, -1]));
        const result = finalizeWaveformPeaks(aggregator);
        expect(result.min.every((value) => value === 0)).toBe(true);
        expect(result.max.every((value) => value === 0)).toBe(true);
    });

    it('aligns priming, timestamp gaps, and overlapping decoded samples', () => {
        expect(getWaveformSampleWindow(-0.25, 4, 4, 0)).toEqual({
            sourceFrameOffset: 1,
            frameCount: 3,
            timelineSampleIndex: 0,
        });
        expect(getWaveformSampleWindow(2, 4, 4, 3)).toEqual({
            sourceFrameOffset: 0,
            frameCount: 4,
            timelineSampleIndex: 8,
        });
        expect(getWaveformSampleWindow(1, 4, 4, 6)).toEqual({
            sourceFrameOffset: 2,
            frameCount: 2,
            timelineSampleIndex: 6,
        });
    });

    it('stops channel mixing promptly when waveform extraction is superseded', () => {
        let cancellationChecks = 0;
        let channelReads = 0;
        const result = mixWaveformChannelsToMono(
            2,
            8_192,
            () => {
                channelReads += 1;
                return new Float32Array(8_192).fill(1);
            },
            () => {
                cancellationChecks += 1;
                return cancellationChecks >= 2;
            },
        );

        expect(result).toBeNull();
        expect(channelReads).toBe(1);
    });
});

describe('waveform byte estimates and LRU eviction', () => {
    it('estimates the retained typed-array bytes', () => {
        expect(estimateWaveformPeaksBytes(peaks(0))).toBe(16);
    });

    it('evicts the least recently used typed media stream under the caller cap', () => {
        const cache = createWaveformLru(32);
        expect(putWaveformInLru(cache, videoAudioRef('a'), peaks(1))).toEqual([]);
        expect(putWaveformInLru(cache, importedAudioRef('b'), peaks(2))).toEqual([]);
        expect(getWaveformFromLru(cache, videoAudioRef('a'))).toBeTruthy();

        expect(putWaveformInLru(cache, videoAudioRef('c'), peaks(3)))
            .toEqual(['audio-source:b']);
        expect(getWaveformFromLru(cache, importedAudioRef('b'))).toBeNull();
        expect(getWaveformFromLru(cache, videoAudioRef('a'))).toBeTruthy();
        expect(getWaveformFromLru(cache, videoAudioRef('c'))).toBeTruthy();
        expect(cache.totalBytes).toBe(32);
    });

    it('isolates same-ID streams and snapshots only project-owned typed references', () => {
        const cache = createWaveformLru(32);
        const first = peaks(1);
        putWaveformInLru(cache, videoAudioRef('shared'), first);
        putWaveformInLru(cache, importedAudioRef('shared'), peaks(2));

        expect(getWaveformFromLru(cache, videoAudioRef('shared'))).toBe(first);
        expect(getWaveformFromLru(cache, importedAudioRef('shared'))).not.toBe(first);
        const snapshot = snapshotWaveformsFromLru(cache, [
            videoAudioRef('shared'),
            importedAudioRef('other-project'),
        ]);
        expect(snapshot.get('video-source-audio:shared')).toBe(first);
        expect(Array.from(snapshot.keys())).toEqual(['video-source-audio:shared']);
    });
});

describe('typed waveform media and decoder ownership', () => {
    it('resolves both embedded video audio and imported audio in request order', () => {
        const video = source('shared');
        const audio = audioSource('shared');
        expect(selectRequestedAudioMedia(
            [video],
            [audio],
            [importedAudioRef('shared'), videoAudioRef('shared'), importedAudioRef('shared')],
        )).toEqual([
            { kind: 'audio-source', asset: audio },
            { kind: 'video-source-audio', asset: video },
        ]);
    });

    it('closes every owned sample and the decoder after successful extraction', async () => {
        const closeCounts = [0, 0];
        let disposeCount = 0;
        const media: AudioMediaAsset = { kind: 'audio-source', asset: audioSource('audio') };
        const result = await extractAudioMediaWaveformPeaks(media, () => false, async () => ({
            samples: (async function* () {
                for (let index = 0; index < closeCounts.length; index += 1) {
                    yield {
                        timestamp: index * 0.5,
                        duration: 0.5,
                        sampleRate: 4,
                        numberOfFrames: 2,
                        numberOfChannels: 1,
                        copyTo(destination: Float32Array) {
                            destination.set(index === 0 ? [0.5, -0.5] : [1, -1]);
                        },
                        close() {
                            closeCounts[index] += 1;
                        },
                    };
                }
            })(),
            dispose: () => {
                disposeCount += 1;
            },
        }));

        expect(result).not.toBeNull();
        expect(closeCounts).toEqual([1, 1]);
        expect(disposeCount).toBe(1);
    });

    it('releases the current sample and decoder when copying throws', async () => {
        let sampleCloseCount = 0;
        let disposeCount = 0;
        const media: AudioMediaAsset = { kind: 'video-source-audio', asset: source('video') };

        await expect(extractAudioMediaWaveformPeaks(media, () => false, async () => ({
            samples: (async function* () {
                yield {
                    timestamp: 0,
                    duration: 1,
                    sampleRate: 4,
                    numberOfFrames: 4,
                    numberOfChannels: 1,
                    copyTo() {
                        throw new Error('decode copy failed');
                    },
                    close() {
                        sampleCloseCount += 1;
                    },
                };
            })(),
            dispose: () => {
                disposeCount += 1;
            },
        }))).rejects.toThrow('decode copy failed');

        expect(sampleCloseCount).toBe(1);
        expect(disposeCount).toBe(1);
    });

    it('closes the yielded sample and decoder when cancellation aborts decoding', async () => {
        let cancellationChecks = 0;
        let sampleCloseCount = 0;
        let disposeCount = 0;
        const media: AudioMediaAsset = { kind: 'audio-source', asset: audioSource('audio') };
        const result = await extractAudioMediaWaveformPeaks(
            media,
            () => {
                cancellationChecks += 1;
                return cancellationChecks >= 3;
            },
            async () => ({
                samples: (async function* () {
                    yield {
                        timestamp: 0,
                        duration: 1,
                        sampleRate: 4,
                        numberOfFrames: 4,
                        numberOfChannels: 1,
                        copyTo(destination: Float32Array) {
                            destination.fill(1);
                        },
                        close() {
                            sampleCloseCount += 1;
                        },
                    };
                })(),
                dispose: () => {
                    disposeCount += 1;
                },
            }),
        );

        expect(result).toBeNull();
        expect(sampleCloseCount).toBe(1);
        expect(disposeCount).toBe(1);
    });
});

describe('visible waveform source selection', () => {
    it('requests only clip sources intersecting the viewport and de-duplicates reuse', () => {
        expect(getVisibleWaveformSourceIds(
            [
                { id: 'a-1', sourceId: 'a', sourceStart: 0, sourceEnd: 2 },
                { id: 'b', sourceId: 'b', sourceStart: 0, sourceEnd: 2 },
                { id: 'a-2', sourceId: 'a', sourceStart: 2, sourceEnd: 4 },
            ],
            1,
            5,
        )).toEqual(['a', 'b']);
    });

    it('does not select orphan, unrequested, or silent source assets', () => {
        const visible = source('visible');
        expect(selectRequestedAudibleSources(
            [source('orphan'), visible, source('silent', false)],
            ['visible', 'silent', 'missing'],
        )).toEqual([visible]);
    });

    it('requests only linked embedded audio from the intersecting video clip', () => {
        expect(getVisibleVideoAudioReferences(
            [
                {
                    id: 'detached',
                    sourceId: 'shared',
                    sourceStart: 0,
                    sourceEnd: 2,
                    audio: {
                        linkState: 'detached',
                        muted: false,
                        gainDb: 0,
                        fadeInFrames: 0,
                        fadeOutFrames: 0,
                    },
                },
                {
                    id: 'linked',
                    sourceId: 'shared',
                    sourceStart: 0,
                    sourceEnd: 2,
                    audio: {
                        linkState: 'linked',
                        muted: false,
                        gainDb: 0,
                        fadeInFrames: 0,
                        fadeOutFrames: 0,
                    },
                },
            ],
            { numerator: 30, denominator: 1 },
            0,
            1,
        )).toEqual([]);
        expect(getVisibleVideoAudioReferences(
            [
                {
                    id: 'detached',
                    sourceId: 'shared',
                    sourceStart: 0,
                    sourceEnd: 2,
                    audio: {
                        linkState: 'detached',
                        muted: false,
                        gainDb: 0,
                        fadeInFrames: 0,
                        fadeOutFrames: 0,
                    },
                },
                {
                    id: 'linked',
                    sourceId: 'shared',
                    sourceStart: 0,
                    sourceEnd: 2,
                    audio: {
                        linkState: 'linked',
                        muted: false,
                        gainDb: 0,
                        fadeInFrames: 0,
                        fadeOutFrames: 0,
                    },
                },
            ],
            { numerator: 30, denominator: 1 },
            2,
            3,
        )).toEqual([{ kind: 'video-source-audio', videoSourceId: 'shared' }]);
    });

    it('uses canonical broadcast-frame placement instead of accumulating raw seconds', () => {
        const linkedAudio = {
            linkState: 'linked' as const,
            muted: false,
            gainDb: 0,
            fadeInFrames: 0,
            fadeOutFrames: 0,
        };

        expect(getVisibleVideoAudioReferences(
            [
                { id: 'first', sourceId: 'first', sourceStart: 0, sourceEnd: 0.05, audio: linkedAudio },
                { id: 'second', sourceId: 'second', sourceStart: 0, sourceEnd: 0.05, audio: linkedAudio },
                { id: 'third', sourceId: 'third', sourceStart: 0, sourceEnd: 0.05, audio: linkedAudio },
            ],
            { numerator: 30_000, denominator: 1_001 },
            0.07,
            0.08,
        )).toEqual([{ kind: 'video-source-audio', videoSourceId: 'third' }]);
    });
});
