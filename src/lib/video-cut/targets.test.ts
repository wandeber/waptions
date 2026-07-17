import { describe, expect, it } from 'vitest';
import type { VideoClipV3, VideoTrack } from '@/types/video';
import {
    getDefaultVideoCutDetectionScope,
    resolveVideoCutDetectionClipIds,
    type VideoCutDetectionRequest,
} from './targets';

const clips = ['a', 'b', 'c'].map((id): VideoClipV3 => ({
    id,
    sourceId: `source-${id}`,
    sourceStart: 0,
    sourceEnd: 1,
    audio: null,
}));
const tracks: VideoTrack[] = [
    { id: 'track-a', name: 'Video 1', clipIds: ['a', 'b'] },
    { id: 'track-b', name: 'Video 2', clipIds: ['c'] },
];

describe('video cut detection targets', () => {
    it('defaults to the preserved multi-selection for a selected context-clicked clip', () => {
        const request: VideoCutDetectionRequest = {
            trackId: 'track-a',
            clickedClipId: 'b',
            selectedClipIds: ['a', 'b'],
        };

        expect(getDefaultVideoCutDetectionScope(request)).toBe('selection');
        expect(resolveVideoCutDetectionClipIds(request, 'selection', tracks, clips)).toEqual(['a', 'b']);
    });

    it('defaults to one clip outside a multi-selection and to a whole track from lane context', () => {
        expect(getDefaultVideoCutDetectionScope({
            trackId: 'track-b',
            clickedClipId: 'c',
            selectedClipIds: ['a', 'b'],
        })).toBe('clip');
        const trackRequest: VideoCutDetectionRequest = {
            trackId: 'track-a',
            clickedClipId: null,
            selectedClipIds: ['c'],
        };
        expect(getDefaultVideoCutDetectionScope(trackRequest)).toBe('track');
        expect(resolveVideoCutDetectionClipIds(trackRequest, 'track', tracks, clips)).toEqual(['a', 'b']);
    });

    it('deduplicates targets and drops stale clip ids', () => {
        const request: VideoCutDetectionRequest = {
            trackId: 'missing-track',
            clickedClipId: 'missing',
            selectedClipIds: ['a', 'a', 'missing', 'c'],
        };

        expect(resolveVideoCutDetectionClipIds(request, 'selection', tracks, clips)).toEqual(['a', 'c']);
        expect(resolveVideoCutDetectionClipIds(request, 'clip', tracks, clips)).toEqual([]);
        expect(resolveVideoCutDetectionClipIds(request, 'track', tracks, clips)).toEqual([]);
        expect(resolveVideoCutDetectionClipIds(request, 'all-tracks', tracks, clips)).toEqual(['a', 'b', 'c']);
    });
});
