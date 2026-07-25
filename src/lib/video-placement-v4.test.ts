import { describe, expect, it } from 'vitest';
import { createEditorDocumentV4Fixture } from '@/types/editorial.test-fixtures';
import type { EditorDocumentV4, VideoClipV4 } from '@/types/video';
import {
    buildVideoTrackPlacementsV4,
    getVideoClipPlacementV4,
    getVideoContentEndFrameV4,
    indexVideoTrackPlacementsV4,
    mapProjectFrameToVideoSourceTimeV4,
    resolveVisibleVideoPlacementAtFrame,
} from './video-placement-v4';

function clip(overrides: Partial<VideoClipV4>): VideoClipV4 {
    return {
        id: 'clip_default',
        sourceId: 'video_source_editorial',
        trackId: 'track_lower',
        timelineStartFrame: 0,
        sourceStart: 0,
        sourceEnd: 1,
        audio: {
            linkState: 'linked',
            muted: false,
            gainDb: 0,
            fadeInFrames: 0,
            fadeOutFrames: 0,
        },
        ...overrides,
    };
}

function document(overrides: Partial<EditorDocumentV4> = {}): EditorDocumentV4 {
    return createEditorDocumentV4Fixture({
        editorialTranscriptDescriptors: [],
        narrative: null,
        videoTracks: [
            { id: 'track_top', name: 'Top', visible: true, locked: false },
            { id: 'track_lower', name: 'Lower', visible: true, locked: false },
        ],
        videoClips: [],
        ...overrides,
    });
}

describe('V4 explicit video placement', () => {
    it('builds start-sorted per-track placements and reusable track/clip indexes', () => {
        const graph = document({
            videoClips: [
                clip({ id: 'later', timelineStartFrame: 60, sourceStart: 2, sourceEnd: 3 }),
                clip({ id: 'earlier', timelineStartFrame: 10 }),
                clip({ id: 'top', trackId: 'track_top', timelineStartFrame: 30 }),
            ],
        });

        const tracks = buildVideoTrackPlacementsV4(graph);
        const indexes = indexVideoTrackPlacementsV4(graph);

        expect(tracks.map((track) => ({
            trackId: track.track.id,
            trackIndex: track.trackIndex,
            clipIds: track.placements.map((placement) => placement.clip.id),
        }))).toEqual([
            { trackId: 'track_top', trackIndex: 0, clipIds: ['top'] },
            { trackId: 'track_lower', trackIndex: 1, clipIds: ['earlier', 'later'] },
        ]);
        expect(indexes.byTrackId.get('track_lower')?.trackIndex).toBe(1);
        expect(indexes.byClipId.get('earlier')).toMatchObject({
            clipIndex: 1,
            trackIndex: 1,
            startFrame: 10,
            endFrame: 40,
            durationFrames: 30,
        });
        expect(getVideoClipPlacementV4(graph, 'later')).toMatchObject({ startFrame: 60, endFrame: 90 });
    });

    it('chooses the first visible top-to-bottom layer and keeps locked tracks renderable', () => {
        const graph = document({
            videoClips: [
                clip({ id: 'lower', timelineStartFrame: 0, sourceEnd: 3 }),
                clip({ id: 'top', trackId: 'track_top', timelineStartFrame: 30 }),
            ],
            videoTracks: [
                { id: 'track_top', name: 'Top', visible: true, locked: true },
                { id: 'track_lower', name: 'Lower', visible: true, locked: false },
            ],
        });

        expect(resolveVisibleVideoPlacementAtFrame(buildVideoTrackPlacementsV4(graph), 35)?.clip.id).toBe('top');
        graph.videoTracks[0].visible = false;
        expect(resolveVisibleVideoPlacementAtFrame(buildVideoTrackPlacementsV4(graph), 35)?.clip.id).toBe('lower');
        expect(resolveVisibleVideoPlacementAtFrame(buildVideoTrackPlacementsV4(graph), -1)).toBeNull();
    });

    it('maps project frames to unscaled source time and honors half-open placement ends', () => {
        const graph = document({
            videoClips: [clip({
                id: 'mapped',
                timelineStartFrame: 30,
                sourceStart: 2,
                sourceEnd: 3,
            })],
        });
        const placement = getVideoClipPlacementV4(graph, 'mapped');

        expect(mapProjectFrameToVideoSourceTimeV4(placement, 30)).toBe(2);
        expect(mapProjectFrameToVideoSourceTimeV4(placement, 45)).toBe(2.5);
        expect(mapProjectFrameToVideoSourceTimeV4(placement, 60)).toBeNull();
        expect(mapProjectFrameToVideoSourceTimeV4(placement, 29)).toBeNull();
    });

    it('uses the maximum explicit tail rather than array order or cumulative duration', () => {
        const graph = document({
            videoClips: [
                clip({ id: 'late_short', timelineStartFrame: 150, sourceEnd: 0.5 }),
                clip({ id: 'early_long', trackId: 'track_top', timelineStartFrame: 0, sourceEnd: 2 }),
            ],
        });

        expect(getVideoContentEndFrameV4(graph)).toBe(165);
        expect(resolveVisibleVideoPlacementAtFrame(buildVideoTrackPlacementsV4(graph), 100)).toBeNull();
    });

    it('fails closed for missing ownership, duplicate IDs, unsafe starts, and same-track overlap', () => {
        const missingTrack = document({ videoClips: [clip({ trackId: 'missing_track' })] });
        expect(() => buildVideoTrackPlacementsV4(missingTrack)).toThrow(/unknown track/i);

        const duplicate = document({
            videoClips: [clip({ id: 'duplicate' }), clip({ id: 'duplicate', timelineStartFrame: 30 })],
        });
        expect(() => buildVideoTrackPlacementsV4(duplicate)).toThrow(/duplicate/i);

        const unsafe = document({ videoClips: [clip({ timelineStartFrame: -1 })] });
        expect(() => buildVideoTrackPlacementsV4(unsafe)).toThrow(/non-negative safe frame/i);

        const overlap = document({
            videoClips: [clip({ id: 'left' }), clip({ id: 'right', timelineStartFrame: 29 })],
        });
        expect(() => buildVideoTrackPlacementsV4(overlap)).toThrow(/overlap/i);
    });
});
