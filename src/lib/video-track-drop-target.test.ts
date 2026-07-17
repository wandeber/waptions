import { describe, expect, it } from 'vitest';
import { parseVideoTrackDropTarget } from './video-track-drop-target';

describe('video track drop target parsing', () => {
    it('prefers a temporary insertion boundary over its surrounding track', () => {
        const insertion = { dataset: { videoTrackInsertionIndex: '1' } } as unknown as HTMLElement;
        const child = {
            closest: (selector: string) => selector === '[data-video-track-insertion-index]'
                ? insertion
                : { dataset: { videoTrackId: 'v1' } },
        } as Element;
        expect(parseVideoTrackDropTarget(child)).toEqual({ kind: 'insertion', insertionIndex: 1 });
    });

    it('returns existing tracks and rejects malformed or unrelated targets', () => {
        const track = {
            closest: (selector: string) => selector === '[data-video-track-id]'
                ? { dataset: { videoTrackId: 'video_track_2' } }
                : null,
        } as Element;
        expect(parseVideoTrackDropTarget(track)).toEqual({ kind: 'track', trackId: 'video_track_2' });
        const invalid = {
            closest: (selector: string) => selector === '[data-video-track-insertion-index]'
                ? { dataset: { videoTrackInsertionIndex: '-1' } }
                : null,
        } as Element;
        expect(parseVideoTrackDropTarget(invalid)).toBeNull();
        expect(parseVideoTrackDropTarget({ closest: () => null } as unknown as Element)).toBeNull();
    });
});
