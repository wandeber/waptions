import { describe, expect, it } from 'vitest';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import type { AnimationStyle } from '@/types/timeline';
import type { TimelineStore } from './timeline-store-types';
import { useTimelineStore } from './timeline-store';
import {
    buildEditorDocumentFromState,
    buildEditorManifestFromState,
} from './timeline-store-snapshot';
import {
    projectTimelineHistory,
    restoreTimelineHistoryProjection,
} from './timeline-history-projection';

const stateFixture = (): TimelineStore => ({
    ...useTimelineStore.getState(),
    revision: 7,
    audioGraphRevision: 3,
    contentBoundaryRevision: 6,
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
    activeTrackId: 'captions',
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
        hasAudio: true,
        file: { name: 'video.mp4' } as File,
    }],
    videoClips: [{
        id: 'video_clip',
        sourceId: 'video_source',
        sourceStart: 0,
        sourceEnd: 2,
        audio: {
            linkState: 'linked',
            muted: false,
            gainDb: 0,
            fadeInFrames: 0,
            fadeOutFrames: 0,
        },
    }],
    videoTracks: [{ id: 'video_track_1', name: 'Video 1', clipIds: ['video_clip'] }],
    transientSelection: { kind: 'video-clip', clipId: 'video_clip' },
    selectedSubtitleIds: ['subtitle'],
    lastSelectedId: 'subtitle',
});

describe('timeline store snapshots', () => {
    it('keeps the V3 runtime/document and durable manifest compatibility boundary explicit', () => {
        const state = stateFixture();

        const document = buildEditorDocumentFromState(state);
        const manifest = buildEditorManifestFromState(state);

        expect(document).toMatchObject({
            version: 3,
            revision: 7,
            audioGraphRevision: 3,
            transientSelection: { kind: 'video-clip', clipId: 'video_clip' },
            subtitleTracks: [{ timingDomain: 'video-ripple' }],
            videoSources: [{ id: 'video_source', file: state.videoSources[0].file }],
        });
        expect(manifest).toMatchInlineSnapshot(`
          {
            "activeSubtitleTrackId": "captions",
            "audioGraphRevision": 3,
            "audioSourceDescriptors": [],
            "audioTracks": [],
            "renderProfile": {
              "audioSampleRate": 48000,
              "fps": {
                "denominator": 1,
                "numerator": 30,
              },
              "height": 1080,
              "isCanvasSizeLocked": true,
              "isFrameRateLocked": true,
              "width": 1920,
            },
            "revision": 7,
            "subtitleTracks": [
              {
                "id": "captions",
                "isLocked": false,
                "isVisible": true,
                "name": "Captions",
                "style": {},
                "subtitles": [
                  {
                    "endTime": 1,
                    "id": "subtitle",
                    "startTime": 0,
                    "text": "Hello",
                  },
                ],
                "timingDomain": "video-ripple",
              },
            ],
            "transcriptionByTrackId": {},
            "version": 3,
            "videoClips": [
              {
                "audio": {
                  "fadeInFrames": 0,
                  "fadeOutFrames": 0,
                  "gainDb": 0,
                  "linkState": "linked",
                  "muted": false,
                },
                "id": "video_clip",
                "sourceEnd": 2,
                "sourceId": "video_source",
                "sourceStart": 0,
              },
            ],
            "videoSourceDescriptors": [
              {
                "bitrate": null,
                "duration": 2,
                "fingerprint": "video-fingerprint",
                "fps": 30,
                "hasAudio": true,
                "height": 1080,
                "id": "video_source",
                "lastModified": 1,
                "mimeType": "video/mp4",
                "originalName": "video.mp4",
                "size": 100,
                "width": 1920,
              },
            ],
            "videoTracks": [
              {
                "clipIds": [
                  "video_clip",
                ],
                "id": "video_track_1",
                "name": "Video 1",
              },
            ],
          }
        `);
        expect('transientSelection' in manifest).toBe(false);
        expect('file' in manifest.videoSourceDescriptors[0]).toBe(false);
    });

    it('deeply owns history projection data in both projection and restore directions', () => {
        const state = stateFixture();
        const projection = projectTimelineHistory(state);

        state.tracks[0].subtitles[0].text = 'Live mutation';
        state.videoTracks[0].clipIds = [];
        expect(projection.tracks[0].subtitles[0].text).toBe('Hello');
        expect(projection.videoTracks[0].clipIds).toEqual(['video_clip']);

        const restored = restoreTimelineHistoryProjection(projection);
        projection.tracks[0].subtitles[0].text = 'Projection mutation';
        projection.videoTracks[0].clipIds = [];
        expect(restored.tracks?.[0].subtitles[0].text).toBe('Hello');
        expect(restored.videoTracks?.[0].clipIds).toEqual(['video_clip']);
        expect(projection.lastSelectedId).toBe('subtitle');
        expect(restored.lastSelectedId).toBe('subtitle');
        expect(projection).not.toHaveProperty('projectFps');
        expect(restored.projectFps).toBe(30);
    });
});
