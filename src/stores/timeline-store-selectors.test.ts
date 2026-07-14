import { describe, expect, it } from 'vitest';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import type { AnimationStyle } from '@/types/timeline';
import type { TimelineStore } from './timeline-store-types';
import { useTimelineStore } from './timeline-store';
import {
    getTrackTimingDomain,
    selectPersistentEditorAssets,
    selectTimelineContentDuration,
    selectTransientSubtitleSelection,
} from './timeline-store-selectors';

const stateFixture = (): TimelineStore => ({
    ...useTimelineStore.getState(),
    renderProfile: createDefaultRenderProfile({
        isFrameRateLocked: true,
        isCanvasSizeLocked: true,
    }),
    tracks: [{
        id: 'captions',
        name: 'Captions',
        style: {} as AnimationStyle,
        subtitles: [{ id: 'subtitle', startTime: 0, endTime: 1, text: 'Hello' }],
        isVisible: true,
        isLocked: false,
    }],
    videoSources: [{
        id: 'video_source',
        originalName: 'video.mp4',
        mimeType: 'video/mp4',
        size: 100,
        lastModified: 1,
        fingerprint: 'video-fingerprint',
        duration: 2,
        fps: 30,
        width: 1920,
        height: 1080,
        bitrate: null,
        hasAudio: false,
        file: {} as File,
    }],
    videoClips: [{
        id: 'video_clip',
        sourceId: 'video_source',
        sourceStart: 0,
        sourceEnd: 2,
        audio: null,
    }],
    audioSources: [{
        id: 'audio_source',
        originalName: 'audio.wav',
        mimeType: 'audio/wav',
        size: 100,
        lastModified: 2,
        fingerprint: 'audio-fingerprint',
        duration: 3,
        nativeSampleRate: 48_000,
        nativeSampleCount: 144_000,
        nativeChannelCount: 2,
        bitrate: null,
        codec: 'pcm',
        file: {} as File,
    }],
    audioTracks: [{
        id: 'audio_track',
        name: 'Audio',
        muted: false,
        solo: false,
        locked: false,
        gainDb: 0,
        clips: [{
            id: 'audio_clip',
            source: { kind: 'audio-source', audioSourceId: 'audio_source' },
            timelineStartFrame: 60,
            sourceStartSample: 0,
            sourceEndSample: 144_000,
            muted: false,
            gainDb: 0,
            fadeInSamples: 0,
            fadeOutSamples: 0,
        }],
    }],
});

describe('timeline semantic selectors', () => {
    it('derives full mixed-media duration and typed persistent assets', () => {
        const state = stateFixture();

        expect(selectTimelineContentDuration(state)).toBe(5);
        expect(selectPersistentEditorAssets(state).map((asset) => [asset.kind, asset.asset.id]))
            .toEqual([
                ['video-source', 'video_source'],
                ['audio-source', 'audio_source'],
            ]);
    });

    it('normalizes legacy timing domains and subtitle selection into semantic values', () => {
        const state = stateFixture();

        expect(getTrackTimingDomain(state.tracks[0])).toBe('video-ripple');
        expect(selectTransientSubtitleSelection(state.tracks, ['subtitle'], 'captions')).toEqual({
            kind: 'subtitles',
            trackId: 'captions',
            subtitleIds: ['subtitle'],
        });
        expect(selectTransientSubtitleSelection(state.tracks, ['missing'], 'captions')).toEqual({ kind: 'none' });
    });
});
