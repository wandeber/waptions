import { describe, expect, it } from 'vitest';
import {
    buildAudioClipSnapPoints,
    buildVideoClipSnapPoints,
    getAudioClipDurationFrames,
    getTimelineSnapThresholdFrames,
    snapTimelineFrame,
    snapTimelineSpan,
    snapTimelineVariableSpan,
    type TimelineSnapPoint,
} from './timeline-snap';
import type {
    AudioSourceDescriptor,
    AudioTrack,
    VideoClip,
    VideoSourceDescriptorV3,
} from '@/types/video';

const points: TimelineSnapPoint[] = [
    { frame: 0, ownerKey: 'timeline:start' },
    { frame: 30, ownerKey: 'video:first' },
    { frame: 75, ownerKey: 'audio:other' },
];

describe('timeline media snapping', () => {
    it('publishes independent audio boundaries as shared snap targets', () => {
        const audioSources: AudioSourceDescriptor[] = [{
            id: 'audio-source',
            originalName: 'voice.wav',
            mimeType: 'audio/wav',
            size: 100,
            lastModified: 1,
            fingerprint: 'audio-fingerprint',
            duration: 2,
            nativeSampleRate: 48_000,
            nativeSampleCount: 96_000,
            nativeChannelCount: 1,
            bitrate: null,
            codec: null,
        }];
        const audioTracks: AudioTrack[] = [{
            id: 'audio-track',
            name: 'Voiceover',
            muted: false,
            solo: false,
            locked: false,
            gainDb: 0,
            clips: [{
                id: 'audio-clip',
                timelineStartFrame: 30,
                muted: false,
                gainDb: 0,
                source: { kind: 'audio-source', audioSourceId: 'audio-source' },
                sourceStartSample: 0,
                sourceEndSample: 48_000,
                fadeInSamples: 0,
                fadeOutSamples: 0,
            }],
        }];

        expect(buildAudioClipSnapPoints(
            audioTracks,
            { numerator: 30, denominator: 1 },
            [] as VideoSourceDescriptorV3[],
            audioSources,
        )).toEqual([
            { frame: 30, ownerKey: 'audio:audio-clip' },
            { frame: 60, ownerKey: 'audio:audio-clip' },
        ]);
    });

    it('projects short sequential video crops on the canonical project grid', () => {
        const clips: VideoClip[] = [{
            id: 'first',
            sourceId: 'source',
            sourceStart: 0,
            sourceEnd: 0.05,
        }, {
            id: 'second',
            sourceId: 'source',
            sourceStart: 1,
            sourceEnd: 1.05,
        }];

        expect(buildVideoClipSnapPoints(
            clips,
            { numerator: 30_000, denominator: 1_001 },
        )).toEqual([
            { frame: 0, ownerKey: 'video:first' },
            { frame: 1, ownerKey: 'video:first' },
            { frame: 1, ownerKey: 'video:second' },
            { frame: 2, ownerKey: 'video:second' },
        ]);
    });

    it('uses the same pixel tolerance at different timeline zoom levels', () => {
        expect(getTimelineSnapThresholdFrames(100, { numerator: 30, denominator: 1 })).toBe(4);
        expect(getTimelineSnapThresholdFrames(300, { numerator: 30, denominator: 1 })).toBe(1);
        expect(getTimelineSnapThresholdFrames(3_000, { numerator: 30, denominator: 1 })).toBe(0);
    });

    it('snaps a single audio trim edge and ignores its own boundaries', () => {
        expect(snapTimelineFrame(28, points, 3, 'audio:selected')).toEqual({
            frame: 30,
            snappedFrame: 30,
        });
        expect(snapTimelineFrame(73, points, 3, 'audio:other')).toEqual({
            frame: 73,
            snappedFrame: null,
        });
    });

    it('snaps the closest moving edge without changing clip duration', () => {
        expect(snapTimelineSpan(52, 20, points, 4, 'audio:selected')).toEqual({
            frame: 55,
            snappedFrame: 75,
        });
        expect(snapTimelineSpan(1, 80, points, 6, 'audio:selected')).toEqual({
            frame: 0,
            snappedFrame: 0,
        });
    });

    it('reprojects sample-based duration before snapping a moved clip end', () => {
        const audioSource: AudioSourceDescriptor = {
            id: 'short-source',
            originalName: 'short.wav',
            mimeType: 'audio/wav',
            size: 100,
            lastModified: 1,
            fingerprint: 'short-fingerprint',
            duration: 1_602 / 48_000,
            nativeSampleRate: 48_000,
            nativeSampleCount: 1_602,
            nativeChannelCount: 1,
            bitrate: null,
            codec: null,
        };
        const clip: AudioTrack['clips'][number] = {
            id: 'short-clip',
            timelineStartFrame: 0,
            muted: false,
            gainDb: 0,
            source: { kind: 'audio-source', audioSourceId: audioSource.id },
            sourceStartSample: 0,
            sourceEndSample: 1_602,
            timelineDurationSamples: 1_602,
            fadeInSamples: 0,
            fadeOutSamples: 0,
        };
        const frameRate = { numerator: 30_000, denominator: 1_001 };
        const resolveDuration = (candidateStartFrame: number) => getAudioClipDurationFrames(
            { ...clip, timelineStartFrame: candidateStartFrame },
            frameRate,
            [],
            [audioSource],
        ) ?? 1;

        expect(resolveDuration(0)).toBe(1);
        expect(resolveDuration(1)).toBe(2);
        expect(resolveDuration(2)).toBe(1);
        expect(snapTimelineVariableSpan(
            0,
            resolveDuration,
            [{ frame: 3, ownerKey: 'video:edge' }],
            2,
            'audio:short-clip',
        )).toEqual({ frame: 1, snappedFrame: 3 });
    });
});
