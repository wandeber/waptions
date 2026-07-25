import { describe, expect, it } from 'vitest';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import { createVideoSourceFingerprint } from '@/lib/video-timeline';
import type { AnimationStyle } from '@/types/timeline';
import type { TimelineStore } from './timeline-store-types';
import { useTimelineStore } from './timeline-store';
import {
    buildEditorDocumentFromState,
    buildEditorManifestFromState,
    buildLegacyEditorDocumentFromState,
} from './timeline-store-snapshot';
import {
    projectTimelineHistory,
    restoreTimelineHistoryProjection,
} from './timeline-history-projection';

const stateFixture = (): TimelineStore => {
    const file = {
        name: 'video.mp4',
        type: 'video/mp4',
        size: 100,
        lastModified: 1,
    } as File;
    return ({
    ...useTimelineStore.getState(),
    revision: 7,
    audioGraphRevision: 3,
    contentBoundaryRevision: 6,
    renderProfile: createDefaultRenderProfile({
        isFrameRateLocked: true,
        isCanvasSizeLocked: true,
    }),
    renderBackgroundColor: '#123abc',
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
        fingerprint: createVideoSourceFingerprint(file),
        duration: 2,
        fps: 30,
        width: 1920,
        height: 1080,
        bitrate: null,
        hasAudio: true,
        file,
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
};

describe('timeline store snapshots', () => {
    it('keeps the descriptor-only V4 runtime/document and durable manifest boundary explicit', () => {
        const state = stateFixture();

        const document = buildEditorDocumentFromState(state);
        const manifest = buildEditorManifestFromState(state);

        expect(document).toMatchObject({
            version: 4,
            revision: 7,
            audioGraphRevision: 3,
            renderBackgroundColor: '#123abc',
            transientSelection: { kind: 'video-clip', clipId: 'video_clip' },
            subtitleTracks: [{ unlinkedVideoEditResponse: 'follow-project-ripple' }],
            videoSources: [{ id: 'video_source', file: state.videoSources[0].file }],
            videoClips: [{ trackId: 'video_track_1', timelineStartFrame: 0 }],
            videoTracks: [{ id: 'video_track_1', visible: true, locked: false }],
        });
        expect(manifest).toMatchObject({
            version: 4,
            revision: 7,
            audioGraphRevision: 3,
            renderBackgroundColor: '#123abc',
            globalEditingMode: 'ripple',
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
            subtitleTracks: [{ unlinkedVideoEditResponse: 'follow-project-ripple' }],
            videoClips: [{ trackId: 'video_track_1', timelineStartFrame: 0 }],
            videoTracks: [{ id: 'video_track_1', visible: true, locked: false }],
        });
        expect('transientSelection' in manifest).toBe(false);
        expect('file' in manifest.videoSourceDescriptors[0]).toBe(false);
    });

    it('deeply owns history projection data in both projection and restore directions', () => {
        const state = stateFixture();
        const projection = projectTimelineHistory(state);

        state.tracks[0].subtitles[0].text = 'Live mutation';
        state.videoTracks[0].clipIds = [];
        expect(projection.tracks[0].subtitles[0].text).toBe('Hello');
        expect(projection.videoTracks[0]).not.toHaveProperty('clipIds');
        expect(projection.videoClips[0]).toMatchObject({
            trackId: 'video_track_1',
            timelineStartFrame: 0,
        });
        expect(projection.renderBackgroundColor).toBe('#123abc');

        const restored = restoreTimelineHistoryProjection(projection);
        projection.tracks[0].subtitles[0].text = 'Projection mutation';
        projection.videoClips[0].trackId = 'mutated_track';
        expect(restored.tracks?.[0].subtitles[0].text).toBe('Hello');
        expect(restored.videoTracks?.[0].clipIds).toEqual(['video_clip']);
        expect(projection.lastSelectedId).toBe('subtitle');
        expect(restored.lastSelectedId).toBe('subtitle');
        expect(projection).not.toHaveProperty('projectFps');
        expect(restored.projectFps).toBe(30);
        expect(restored.renderBackgroundColor).toBe('#123abc');
    });

    it('preserves deleted-range policy in V4 and projects it safely to absolute V3 timing', () => {
        const state = stateFixture();
        state.tracks[0].unlinkedVideoEditResponse = 'remove-with-deleted-video-range';

        expect(buildEditorDocumentFromState(state).subtitleTracks[0]).toMatchObject({
            unlinkedVideoEditResponse: 'remove-with-deleted-video-range',
        });
        expect(buildEditorManifestFromState(state).subtitleTracks[0]).toMatchObject({
            unlinkedVideoEditResponse: 'remove-with-deleted-video-range',
        });
        expect(buildLegacyEditorDocumentFromState(state).subtitleTracks[0]).toMatchObject({
            timingDomain: 'absolute',
        });
    });
});
