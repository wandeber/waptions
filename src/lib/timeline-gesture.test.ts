import { describe, expect, it } from 'vitest';
import {
    beginTimelineGesture,
    cancelTimelineGesture,
    commitTimelineKeyboardEdit,
    finishTimelineGesture,
    updateTimelineGesture,
} from './timeline-gesture';

describe('timeline gesture transaction', () => {
    it('keeps pointer updates local and exposes only the final draft', () => {
        let state = beginTimelineGesture({ frame: 10, trackId: 'a' });
        state = updateTimelineGesture(state, { frame: 14, trackId: 'a' });
        state = updateTimelineGesture(state, { frame: 18, trackId: 'b' });

        const finished = finishTimelineGesture(
            state,
            (left, right) => left.frame === right.frame && left.trackId === right.trackId,
        );

        expect(finished.commit).toEqual({ frame: 18, trackId: 'b' });
        expect(finished.state).toEqual({ status: 'idle' });
        expect(finishTimelineGesture(finished.state).commit).toBeNull();
    });

    it('does not expose a commit for pointercancel, Escape, or a no-op draft', () => {
        const active = beginTimelineGesture(20);
        expect(cancelTimelineGesture<number>().commit).toBeNull();
        expect(finishTimelineGesture(active).commit).toBeNull();
        expect(updateTimelineGesture<number>({ status: 'idle' }, 30)).toEqual({ status: 'idle' });
    });

    it('maps one keyboard command to one terminal value', () => {
        expect(commitTimelineKeyboardEdit(5, 6)).toBe(6);
        expect(commitTimelineKeyboardEdit(5, 5)).toBeNull();
    });
});
