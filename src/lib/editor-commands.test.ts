import { describe, expect, it, vi } from 'vitest';
import { createDefaultRenderProfile } from './render-profile';
import {
    applyVideoEditToSubtitleDomains,
    deleteAudioClipCommand,
    moveAudioClipCommand,
    splitAudioClipCommand,
    splitVideoClipCommand,
    updateSubtitleCommand,
} from './editor-commands';
import { trimVideoClip } from './video-timeline';
import type { AnimationStyle } from '@/types/timeline';
import type { AudioSourceAsset, AudioTrack, SubtitleTrackV3, VideoClipV3 } from '@/types/video';

const renderProfile = createDefaultRenderProfile({
    isFrameRateLocked: true,
    isCanvasSizeLocked: true,
});

const subtitleTrack = (id: string, timingDomain: 'video-ripple' | 'absolute'): SubtitleTrackV3 => ({
    id,
    name: id,
    style: {} as AnimationStyle,
    subtitles: [{ id: `${id}_subtitle`, startTime: 1, endTime: 2, text: id }],
    isVisible: true,
    isLocked: false,
    timingDomain,
});

const audioSource: AudioSourceAsset = {
    id: 'audio_source',
    originalName: 'music.wav',
    mimeType: 'audio/wav',
    size: 100,
    lastModified: 1,
    fingerprint: 'audio-fingerprint',
    duration: 2,
    nativeSampleRate: 48_000,
    nativeSampleCount: 96_000,
    nativeChannelCount: 2,
    bitrate: null,
    codec: 'pcm',
    file: {} as File,
};

const audioTracks = (): AudioTrack[] => [{
    id: 'source_track',
    name: 'Source',
    muted: false,
    solo: false,
    locked: false,
    gainDb: 0,
    clips: [{
        id: 'audio_clip',
        source: { kind: 'audio-source', audioSourceId: audioSource.id },
        timelineStartFrame: 0,
        sourceStartSample: 0,
        sourceEndSample: 96_000,
        muted: false,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
    }],
}, {
    id: 'target_track',
    name: 'Target',
    muted: false,
    solo: false,
    locked: false,
    gainDb: 0,
    clips: [],
}];

describe('pure editor commands', () => {
    it('returns null for a semantic subtitle no-op and an immutable patch for a real edit', () => {
        const tracks = [subtitleTrack('captions', 'video-ripple')];
        const stringify = vi.spyOn(JSON, 'stringify');

        expect(updateSubtitleCommand(tracks, 'captions', 'captions_subtitle', { text: 'captions' }))
            .toBeNull();
        const updated = updateSubtitleCommand(tracks, 'captions', 'captions_subtitle', { text: 'Updated' });

        expect(updated?.[0].subtitles[0].text).toBe('Updated');
        expect(tracks[0].subtitles[0].text).toBe('captions');
        expect(stringify).not.toHaveBeenCalled();
        stringify.mockRestore();
    });

    it.each(['linked', 'detached'] as const)(
        'splits %s embedded audio without duplicating fades at the artificial seam',
        (linkState) => {
            const clips: VideoClipV3[] = [{
                id: 'video_clip',
                sourceId: 'video_source',
                sourceStart: 0,
                sourceEnd: 4,
                audio: {
                    linkState,
                    muted: false,
                    gainDb: 0,
                    fadeInFrames: 50,
                    fadeOutFrames: 70,
                },
            }];

            const result = splitVideoClipCommand(
                clips,
                'video_clip',
                1,
                'right_clip',
                renderProfile,
            );

            expect(result?.map((clip) => clip.audio)).toMatchObject([
                { linkState, fadeInFrames: 30, fadeOutFrames: 0 },
                { linkState, fadeInFrames: 0, fadeOutFrames: 70 },
            ]);
            expect(clips).toHaveLength(1);
        },
    );

    it('moves, splits, and deletes an imported-audio clip without mutating command input', () => {
        const state = {
            audioTracks: audioTracks(),
            videoSources: [],
            audioSources: [audioSource],
            renderProfile,
        };

        const moved = moveAudioClipCommand(state, 'audio_clip', 'target_track', 30);
        expect(moved?.[1].clips[0].timelineStartFrame).toBe(30);
        expect(state.audioTracks[0].clips).toHaveLength(1);

        const split = splitAudioClipCommand({ ...state, audioTracks: moved! }, 'audio_clip', 60, 'right_clip');
        expect(split).toMatchObject({ trackId: 'target_track' });
        expect(split?.audioTracks[1].clips.map((clip) => clip.id)).toEqual(['audio_clip', 'right_clip']);

        const deleted = deleteAudioClipCommand({ ...state, audioTracks: split!.audioTracks }, 'right_clip');
        expect(deleted?.[1].clips.map((clip) => clip.id)).toEqual(['audio_clip']);
    });

    it('ripples only video-ripple subtitle domains for a media edit', () => {
        const tracks = [subtitleTrack('ripple', 'video-ripple'), subtitleTrack('absolute', 'absolute')];
        const edit = trimVideoClip(
            [{ id: 'video_clip', sourceId: 'video_source', sourceStart: 0, sourceEnd: 4 }],
            'video_clip',
            1,
            4,
            [{
                id: 'video_source',
                originalName: 'video.mp4',
                mimeType: 'video/mp4',
                size: 100,
                lastModified: 1,
                fingerprint: 'video-fingerprint',
                duration: 4,
                fps: 30,
                width: 1920,
                height: 1080,
                bitrate: null,
                hasAudio: false,
            }],
            30,
            4,
        );

        const result = applyVideoEditToSubtitleDomains(tracks, [], edit);

        expect(result.tracks[0].subtitles[0]).toMatchObject({ startTime: 0, endTime: 1 });
        expect(result.tracks[1].subtitles[0]).toMatchObject({ startTime: 1, endTime: 2 });
    });
});
