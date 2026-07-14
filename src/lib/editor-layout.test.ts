import { describe, expect, it } from 'vitest';
import {
    DEFAULT_TIMELINE_ROW_HEIGHT,
    MAXIMUM_TIMELINE_ROW_HEIGHT,
    MINIMUM_TIMELINE_ROW_HEIGHT,
    clampTimelineHeight,
    clampTimelineRowHeight,
    getClampedSubtitleTrackShift,
    getTimelineRowHeightForKey,
} from './editor-layout';

describe('timeline height clamp', () => {
    it('keeps the timeline at least 180 pixels tall', () => {
        expect(clampTimelineHeight(100, 1_000)).toBe(180);
    });

    it('caps the timeline at 60 percent of the workspace', () => {
        expect(clampTimelineHeight(500, 600)).toBe(360);
    });

    it('uses the minimum when the workspace is shorter than the minimum cap', () => {
        expect(clampTimelineHeight(260, 200)).toBe(180);
    });
});

describe('timeline row height contract', () => {
    it('rounds finite heights and clamps invalid or out-of-range values', () => {
        expect(clampTimelineRowHeight(80.6)).toBe(81);
        expect(clampTimelineRowHeight(-100)).toBe(MINIMUM_TIMELINE_ROW_HEIGHT);
        expect(clampTimelineRowHeight(1_000)).toBe(MAXIMUM_TIMELINE_ROW_HEIGHT);
        expect(clampTimelineRowHeight(Number.NaN)).toBe(DEFAULT_TIMELINE_ROW_HEIGHT);
    });

    it('supports normal and accelerated arrow-key resizing', () => {
        expect(getTimelineRowHeightForKey(64, 'ArrowUp')).toBe(60);
        expect(getTimelineRowHeightForKey(64, 'ArrowDown')).toBe(68);
        expect(getTimelineRowHeightForKey(64, 'ArrowUp', true)).toBe(48);
        expect(getTimelineRowHeightForKey(64, 'ArrowDown', true)).toBe(80);
    });

    it('supports exact limits and ignores unrelated keys', () => {
        expect(getTimelineRowHeightForKey(100, 'Home')).toBe(MINIMUM_TIMELINE_ROW_HEIGHT);
        expect(getTimelineRowHeightForKey(100, 'End')).toBe(MAXIMUM_TIMELINE_ROW_HEIGHT);
        expect(getTimelineRowHeightForKey(100, 'Enter')).toBeNull();
    });
});

describe('variable-height subtitle row targeting', () => {
    it('derives the shift from hovered row indexes rather than pixel distance', () => {
        expect(getClampedSubtitleTrackShift([1], 1, 3, 4)).toBe(2);
        expect(getClampedSubtitleTrackShift([2], 2, 0, 4)).toBe(-2);
    });

    it('clamps a multi-track selection as one all-or-nothing group', () => {
        expect(getClampedSubtitleTrackShift([0, 1], 0, 3, 4)).toBe(2);
        expect(getClampedSubtitleTrackShift([2, 3], 3, 0, 4)).toBe(-2);
    });

    it('rejects incomplete hit-test geometry', () => {
        expect(getClampedSubtitleTrackShift([], 0, 1, 2)).toBeNull();
        expect(getClampedSubtitleTrackShift([0], -1, 1, 2)).toBeNull();
        expect(getClampedSubtitleTrackShift([0], 0, 2, 2)).toBeNull();
    });
});
