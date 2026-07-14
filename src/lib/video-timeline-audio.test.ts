import { describe, expect, it } from 'vitest';
import type { VideoClip, VideoClipV3 } from '@/types/video';
import {
    assembleAudioSegmentCrops,
    buildAudioOutputSegments,
    buildV3VideoAudioOutputSegments,
    calculateAudioSegmentCrop,
    findAudioTimelineSilenceRanges,
    getCumulativeSampleBoundaries,
} from './video-timeline-audio';

const clip = (id: string, sourceStart: number, sourceEnd: number): VideoClip => ({
    id,
    sourceId: 'source',
    sourceStart,
    sourceEnd,
});

describe('audio output sample math', () => {
    it('rounds cumulative fractional boundaries so per-clip error does not drift', () => {
        expect(getCumulativeSampleBoundaries([1 / 3, 1 / 3, 1 / 3], 10)).toEqual([0, 3, 7, 10]);

        const segments = buildAudioOutputSegments([
            clip('a', 0, 1 / 3),
            clip('b', 1, 4 / 3),
            clip('c', 2, 7 / 3),
        ], 10);
        expect(segments.map((segment) => segment.sampleCount)).toEqual([3, 4, 3]);
        expect(segments.at(-1)?.endSample).toBe(10);
    });

    it('uses exact neighboring boundaries for fractional 48kHz clips', () => {
        const segments = buildAudioOutputSegments([
            clip('a', 0, 1 / 29),
            clip('b', 0, 1 / 29),
        ]);
        expect(segments[0].endSample).toBe(segments[1].startSample);
        expect(segments[0].sampleCount + segments[1].sampleCount).toBe(Math.round(2 / 29 * 48_000));
    });

    it('places v3 video audio on canonical integer frames at broadcast rates', () => {
        const duration = 1.4 * 1_001 / 30_000;
        const clips: VideoClipV3[] = [{
            id: 'a',
            sourceId: 'source',
            sourceStart: 0,
            sourceEnd: duration,
            audio: { linkState: 'linked', muted: false, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0 },
        }, {
            id: 'b',
            sourceId: 'source',
            sourceStart: 1,
            sourceEnd: 1 + duration,
            audio: { linkState: 'detached', muted: false, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0 },
        }];
        const segments = buildV3VideoAudioOutputSegments(clips, { numerator: 30_000, denominator: 1_001 });

        expect(segments.map((segment) => [segment.startSample, segment.endSample])).toEqual([
            [0, 1_602],
            [1_602, 3_203],
        ]);
    });
});

describe('source buffer crop and silence math', () => {
    it('reports leading and trailing silence around a partial decoded intersection', () => {
        const segment = buildAudioOutputSegments([clip('a', 1, 3)])[0];
        const crop = calculateAudioSegmentCrop(segment, {
            startTime: 1.5,
            sampleRate: 48_000,
            frameCount: 48_000,
        });

        expect(crop.sourceFrameStart).toBe(0);
        expect(crop.sourceFrameEnd).toBe(48_000);
        expect(crop.outputRange).toEqual({
            startSample: 24_000,
            endSample: 72_000,
            sampleCount: 48_000,
        });
        expect(crop.silenceRanges).toEqual([
            { startSample: 0, endSample: 24_000, sampleCount: 24_000, reason: 'missing-source-audio' },
            { startSample: 72_000, endSample: 96_000, sampleCount: 24_000, reason: 'missing-source-audio' },
        ]);
    });

    it('calculates crop frames relative to a larger source buffer', () => {
        const segment = buildAudioOutputSegments([clip('a', 1, 3)])[0];
        const crop = calculateAudioSegmentCrop(segment, {
            startTime: 0,
            sampleRate: 48_000,
            frameCount: 4 * 48_000,
        });

        expect(crop.sourceFrameStart).toBe(48_000);
        expect(crop.sourceFrameEnd).toBe(144_000);
        expect(crop.sourceFrameCount).toBe(96_000);
        expect(crop.silenceRanges).toEqual([]);
    });

    it('returns explicit full silence when source audio does not intersect', () => {
        const segment = buildAudioOutputSegments([clip('a', 2, 3)])[0];
        const crop = calculateAudioSegmentCrop(segment, {
            startTime: 0,
            sampleRate: 48_000,
            frameCount: 48_000,
        });
        expect(crop.outputRange).toBeNull();
        expect(crop.silenceRanges).toEqual([
            { startSample: 0, endSample: 48_000, sampleCount: 48_000, reason: 'missing-source-audio' },
        ]);
    });

    it('derives explicit timeline gaps before, between, and after populated ranges', () => {
        expect(findAudioTimelineSilenceRanges([
            { startSample: 10, endSample: 20, sampleCount: 10 },
            { startSample: 30, endSample: 40, sampleCount: 10 },
        ], 50)).toEqual([
            { startSample: 0, endSample: 10, sampleCount: 10, reason: 'timeline-gap' },
            { startSample: 20, endSample: 30, sampleCount: 10, reason: 'timeline-gap' },
            { startSample: 40, endSample: 50, sampleCount: 10, reason: 'timeline-gap' },
        ]);
    });
});

describe('streamed audio window assembly', () => {
    it('joins adjacent buffers without reporting false segment-wide silence', () => {
        const segment = buildAudioOutputSegments([clip('a', 0, 2)])[0];
        const assembly = assembleAudioSegmentCrops(segment, [
            { startTime: 0, sampleRate: 48_000, frameCount: 48_000 },
            { startTime: 1, sampleRate: 48_000, frameCount: 48_000 },
        ]);

        expect(assembly.crops.map((crop) => crop.outputRange)).toEqual([
            { startSample: 0, endSample: 48_000, sampleCount: 48_000 },
            { startSample: 48_000, endSample: 96_000, sampleCount: 48_000 },
        ]);
        expect(assembly.silenceRanges).toEqual([]);
    });

    it('reports only an actual internal timestamp gap', () => {
        const segment = buildAudioOutputSegments([clip('a', 0, 2)])[0];
        const assembly = assembleAudioSegmentCrops(segment, [
            { startTime: 0, sampleRate: 48_000, frameCount: 24_000 },
            { startTime: 1, sampleRate: 48_000, frameCount: 48_000 },
        ]);

        expect(assembly.silenceRanges).toEqual([
            {
                startSample: 24_000,
                endSample: 48_000,
                sampleCount: 24_000,
                reason: 'missing-source-audio',
            },
        ]);
    });

    it('reports uncovered leading and trailing boundaries once', () => {
        const segment = buildAudioOutputSegments([clip('a', 1, 3)])[0];
        const assembly = assembleAudioSegmentCrops(segment, [
            { startTime: 1.25, sampleRate: 48_000, frameCount: 72_000 },
        ]);

        expect(assembly.crops[0].outputRange).toEqual({
            startSample: 12_000,
            endSample: 84_000,
            sampleCount: 72_000,
        });
        expect(assembly.silenceRanges).toEqual([
            { startSample: 0, endSample: 12_000, sampleCount: 12_000, reason: 'missing-source-audio' },
            { startSample: 84_000, endSample: 96_000, sampleCount: 12_000, reason: 'missing-source-audio' },
        ]);
    });

    it('trims overlapping windows to non-overlapping source and output ranges', () => {
        const segment = buildAudioOutputSegments([clip('a', 0, 2)])[0];
        const assembly = assembleAudioSegmentCrops(segment, [
            { startTime: 1, sampleRate: 48_000, frameCount: 48_000 },
            { startTime: 0, sampleRate: 48_000, frameCount: 72_000 },
        ]);

        expect(assembly.crops.map((crop) => ({
            bufferIndex: crop.bufferIndex,
            sourceFrameStart: crop.sourceFrameStart,
            outputRange: crop.outputRange,
        }))).toEqual([
            {
                bufferIndex: 1,
                sourceFrameStart: 0,
                outputRange: { startSample: 0, endSample: 72_000, sampleCount: 72_000 },
            },
            {
                bufferIndex: 0,
                sourceFrameStart: 24_000,
                outputRange: { startSample: 72_000, endSample: 96_000, sampleCount: 24_000 },
            },
        ]);
        expect(assembly.silenceRanges).toEqual([]);
    });
});
