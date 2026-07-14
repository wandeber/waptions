import { describe, expect, it } from 'vitest';
import type {
    AudioSourceAsset,
    AudioTrack,
    ImportedAudioClip,
    VideoSourceAssetV3,
    VideoSourceAudioClip,
} from '@/types/video';
import { createDefaultRenderProfile } from './render-profile';
import {
    clampSampleFades,
    findAudioClip,
    hasAudioTrackCollision,
    moveAudioClipInTracks,
    splitAudioClipInTracks,
    trimAudioClipInTracks,
} from './audio-timeline';

const audioSource = (id = 'audio_source'): AudioSourceAsset => ({
    id,
    originalName: `${id}.wav`,
    mimeType: 'audio/wav',
    size: 1_000,
    lastModified: 1,
    fingerprint: `${id}_fingerprint`,
    duration: 10,
    nativeSampleRate: 48_000,
    nativeSampleCount: 480_000,
    nativeChannelCount: 2,
    bitrate: 1_536_000,
    codec: 'pcm_s16le',
    file: { name: `${id}.wav`, type: 'audio/wav', size: 1_000, lastModified: 1 } as File,
});

const videoSource: VideoSourceAssetV3 = {
    id: 'video_source',
    originalName: 'video.mp4',
    mimeType: 'video/mp4',
    size: 1,
    lastModified: 1,
    fingerprint: 'video_fingerprint',
    duration: 10,
    fps: 30,
    width: 1920,
    height: 1080,
    bitrate: null,
    hasAudio: true,
    file: {} as File,
};

const importedClip = (
    id: string,
    startFrame: number,
    startSample = 0,
    endSample = 48_000,
): ImportedAudioClip => ({
    id,
    source: { kind: 'audio-source', audioSourceId: 'audio_source' },
    timelineStartFrame: startFrame,
    sourceStartSample: startSample,
    sourceEndSample: endSample,
    muted: false,
    gainDb: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
});

const detachedClip = (id: string, startFrame: number): VideoSourceAudioClip => ({
    id,
    source: { kind: 'video-source-audio', videoSourceId: 'video_source' },
    timelineStartFrame: startFrame,
    sourceStart: 0,
    sourceEnd: 1,
    muted: false,
    gainDb: 0,
    fadeInFrames: 0,
    fadeOutFrames: 0,
});

const track = (id: string, clips: AudioTrack['clips'] = []): AudioTrack => ({
    id,
    name: id,
    muted: false,
    solo: false,
    locked: false,
    gainDb: 0,
    clips,
});

const importedSource = audioSource();
const sources = { videoSources: [videoSource], audioSources: [importedSource] };
const profile = createDefaultRenderProfile();

describe('audio timeline editing', () => {
    it('allows touching exact sample intervals and detects a one-frame overlap across variants', () => {
        const lane = track('lane', [importedClip('left', 0)]);
        const detached = detachedClip('touching', 30);
        expect(hasAudioTrackCollision(
            lane,
            detached,
            { kind: 'video-source-audio', descriptor: videoSource },
            profile,
            sources,
        )).toBe(false);
        expect(hasAudioTrackCollision(
            lane,
            { ...detached, id: 'overlap', timelineStartFrame: 29 },
            { kind: 'video-source-audio', descriptor: videoSource },
            profile,
            sources,
        )).toBe(true);
    });

    it('uses nearest canonical duration for detached video-audio collision bounds', () => {
        const short = { ...detachedClip('short', 0), sourceEnd: 1.4 / 30 };
        const lane = track('lane', [short]);
        const touching = { ...detachedClip('touching', 1), sourceStart: 1, sourceEnd: 1 + 1.4 / 30 };
        expect(hasAudioTrackCollision(
            lane,
            touching,
            { kind: 'video-source-audio', descriptor: videoSource },
            profile,
            sources,
        )).toBe(false);
    });

    it('moves both clip variants across time and tracks without changing source domains', () => {
        const tracks = [track('one', [detachedClip('moving', 0)]), track('two', [importedClip('occupied', 60)])];
        const moved = moveAudioClipInTracks(tracks, sources, profile, 'moving', 'two', 30);
        expect(moved?.[0].clips).toEqual([]);
        expect(moved?.[1].clips[0]).toMatchObject({
            id: 'moving',
            timelineStartFrame: 30,
            source: { kind: 'video-source-audio' },
            sourceStart: 0,
            sourceEnd: 1,
        });
        expect(moveAudioClipInTracks(tracks, sources, profile, 'moving', 'two', 45)).toBeNull();
    });

    it('trims imported clips on frame boundaries while retaining native samples', () => {
        const faded = { ...importedClip('clip', 0), fadeInSamples: 30_000, fadeOutSamples: 30_000 };
        const trimmed = trimAudioClipInTracks([track('lane', [faded])], sources, profile, 'clip', 'right', 15);
        const result = trimmed?.[0].clips[0];

        expect(result).toMatchObject({ sourceStartSample: 0, sourceEndSample: 24_000 });
        if (result && 'fadeInSamples' in result) {
            expect(result.fadeInSamples + result.fadeOutSamples).toBe(24_000);
        }
    });

    it('trims detached video audio in seconds and keeps frame fades in their own domain', () => {
        const faded = { ...detachedClip('clip', 0), fadeInFrames: 20, fadeOutFrames: 20 };
        const trimmed = trimAudioClipInTracks([track('lane', [faded])], sources, profile, 'clip', 'right', 15);
        expect(trimmed?.[0].clips[0]).toMatchObject({
            source: { kind: 'video-source-audio' },
            sourceStart: 0,
            sourceEnd: 0.5,
        });
        const result = trimmed?.[0].clips[0];
        if (result && 'fadeInFrames' in result) {
            expect(result.fadeInFrames + result.fadeOutFrames).toBe(15);
        }
    });

    it('splits each variant without converting its crop or fade units', () => {
        const imported = splitAudioClipInTracks(
            [track('lane', [{ ...importedClip('left', 0), fadeOutSamples: 8_000 }])],
            sources,
            profile,
            'left',
            15,
            'right',
        );
        expect(imported?.[0].clips).toEqual([
            expect.objectContaining({ id: 'left', sourceEndSample: 24_000, fadeOutSamples: 0 }),
            expect.objectContaining({ id: 'right', sourceStartSample: 24_000, fadeInSamples: 0 }),
        ]);

        const detached = splitAudioClipInTracks(
            [track('lane', [{ ...detachedClip('video_left', 0), fadeOutFrames: 4 }])],
            sources,
            profile,
            'video_left',
            15,
            'video_right',
        );
        expect(detached?.[0].clips).toEqual([
            expect.objectContaining({ id: 'video_left', sourceEnd: 0.5, fadeOutFrames: 0 }),
            expect.objectContaining({ id: 'video_right', sourceStart: 0.5, fadeInFrames: 0 }),
        ]);
    });

    it('keeps source lookup typed and clamps imported fade balance', () => {
        expect(findAudioClip([track('lane', [detachedClip('clip', 0)])], sources, 'clip')?.source.kind)
            .toBe('video-source-audio');
        const faded = { ...importedClip('clip', 0, 0, 8), fadeInSamples: 9, fadeOutSamples: 3 };
        expect(clampSampleFades(faded, 8)).toMatchObject({ fadeInSamples: 6, fadeOutSamples: 2 });
    });
});
