import { describe, expect, it } from 'vitest';
import type { VideoClipV3, VideoTrack } from '@/types/video';
import {
    addVideoTrackMembership,
    canonicalizeVideoTrackClipOrder,
    createDefaultVideoTracks,
    deleteVideoClipMembership,
    insertSplitVideoClipMembership,
    moveVideoClipToNewTrackMembership,
    moveVideoClipToTrackMembership,
    removeEmptyVideoTrackMembership,
    validateVideoTracks,
} from './video-tracks';

const clip = (id: string): VideoClipV3 => ({
    id,
    sourceId: 'source',
    sourceStart: 0,
    sourceEnd: 1,
    audio: null,
});
const clips = [clip('a'), clip('b'), clip('c')];
const tracks = (): VideoTrack[] => [
    { id: 'v1', name: 'Video 1', clipIds: ['a', 'c'] },
    { id: 'v2', name: 'Video 2', clipIds: ['b'] },
];

describe('video track membership', () => {
    it('creates and validates the deterministic default track', () => {
        const result = createDefaultVideoTracks(clips);
        expect(result).toEqual([{ id: 'video_track_1', name: 'Video 1', clipIds: ['a', 'b', 'c'] }]);
        expect(validateVideoTracks(result, clips)).toEqual([]);
    });

    it('rejects missing, duplicate, unknown, and non-canonical memberships', () => {
        expect(validateVideoTracks([], clips)[0].path).toBe('videoTracks');
        expect(validateVideoTracks([
            { id: 'v1', name: 'One', clipIds: ['b', 'a'] },
            { id: 'v1', name: 'Two', clipIds: ['b', 'missing'] },
        ], clips).map((issue) => issue.message)).toEqual(expect.arrayContaining([
            expect.stringContaining('canonical'),
            expect.stringContaining('Duplicate video track'),
            expect.stringContaining('already assigned'),
            expect.stringContaining('Unknown'),
            expect.stringContaining('not assigned'),
        ]));
    });

    it('preserves explicit empty tracks and removes only an explicitly removed empty non-last track', () => {
        const added = addVideoTrackMembership(tracks(), { id: 'v3', name: 'Video 3', clipIds: [] }, 1);
        expect(added.videoTracks.map((track) => track.id)).toEqual(['v1', 'v3', 'v2']);
        expect(removeEmptyVideoTrackMembership(added.videoTracks, 'v3').videoTracks.map((track) => track.id))
            .toEqual(['v1', 'v2']);
        expect(removeEmptyVideoTrackMembership([{ id: 'v1', name: 'Video 1', clipIds: [] }], 'v1').changed)
            .toBe(false);
    });

    it('treats a same-target move as a strict no-op', () => {
        expect(moveVideoClipToTrackMembership(tracks(), clips, 'a', 'v1').changed).toBe(false);
    });

    it('moves to an existing track, canonicalizes order, and prunes the emptied source', () => {
        const result = moveVideoClipToTrackMembership(tracks(), clips, 'b', 'v1');
        expect(result.videoTracks).toEqual([{ id: 'v1', name: 'Video 1', clipIds: ['a', 'b', 'c'] }]);
        expect(validateVideoTracks(result.videoTracks, clips)).toEqual([]);
    });

    it('adjusts insertion after pruning a source before the requested boundary', () => {
        const result = moveVideoClipToNewTrackMembership(
            tracks(),
            clips,
            'b',
            { id: 'new_lane', name: 'New lane' },
            2,
        );
        expect(result.videoTracks.map((track) => track.id)).toEqual(['v1', 'new_lane']);
        expect(result.videoTracks[1].clipIds).toEqual(['b']);
    });

    it('replaces an emptied sole source lane with the atomically created target lane', () => {
        const result = moveVideoClipToNewTrackMembership(
            [{ id: 'only', name: 'Only', clipIds: ['a'] }],
            [clip('a')],
            'a',
            { id: 'new_lane', name: 'New lane' },
            1,
        );
        expect(result.videoTracks).toEqual([
            { id: 'new_lane', name: 'New lane', clipIds: ['a'] },
        ]);
    });

    it('couples split, delete, and global reorder without changing membership', () => {
        const splitClips = [clip('a'), clip('right'), clip('b'), clip('c')];
        const afterSplit = insertSplitVideoClipMembership(tracks(), splitClips, 'a', 'right');
        expect(afterSplit[0].clipIds).toEqual(['a', 'right', 'c']);

        const afterDelete = deleteVideoClipMembership(afterSplit, 'b');
        expect(afterDelete.map((track) => track.id)).toEqual(['v1']);

        const reordered = canonicalizeVideoTrackClipOrder(afterSplit, [clip('c'), clip('b'), clip('a'), clip('right')]);
        expect(reordered).toEqual([
            { id: 'v1', name: 'Video 1', clipIds: ['c', 'a', 'right'] },
            { id: 'v2', name: 'Video 2', clipIds: ['b'] },
        ]);
    });
});
