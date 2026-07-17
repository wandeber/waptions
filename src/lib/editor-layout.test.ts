import { describe, expect, it } from 'vitest';
import {
    DEFAULT_INSPECTOR_WIDTH,
    DEFAULT_TIMELINE_ROW_HEIGHT,
    EDITOR_LAYOUT_STORAGE_KEY,
    MAXIMUM_TIMELINE_ROW_HEIGHT,
    MAXIMUM_INSPECTOR_WIDTH,
    MINIMUM_INSPECTOR_WIDTH,
    MINIMUM_TIMELINE_ROW_HEIGHT,
    clampInspectorWidth,
    clampTimelineHeight,
    clampTimelineRowHeight,
    getInspectorWidthForKey,
    getMaximumInspectorWidth,
    getMaximumTimelineHeight,
    getClampedSubtitleTrackShift,
    getTimelineHeightForKey,
    getTimelineRowHeightForKey,
    parseEditorLayoutPreferences,
    serializeEditorLayoutPreferences,
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

    it('exposes the effective maximum used by the resizable separator', () => {
        expect(getMaximumTimelineHeight(1_000)).toBe(600);
        expect(getMaximumTimelineHeight(200)).toBe(180);
    });

    it('supports accessible keyboard resizing', () => {
        expect(getTimelineHeightForKey(260, 'ArrowUp', 1_000)).toBe(276);
        expect(getTimelineHeightForKey(260, 'ArrowDown', 1_000)).toBe(244);
        expect(getTimelineHeightForKey(260, 'Home', 1_000)).toBe(180);
        expect(getTimelineHeightForKey(260, 'End', 1_000)).toBe(600);
        expect(getTimelineHeightForKey(260, 'Enter', 1_000)).toBeNull();
    });
});

describe('inspector width contract', () => {
    it('clamps the inspector against its own limits and the workspace ratio', () => {
        expect(clampInspectorWidth(100, 1_200)).toBe(MINIMUM_INSPECTOR_WIDTH);
        expect(clampInspectorWidth(900, 1_200)).toBe(MAXIMUM_INSPECTOR_WIDTH);
        expect(clampInspectorWidth(500, 800)).toBe(360);
        expect(clampInspectorWidth(Number.NaN, 1_200)).toBe(DEFAULT_INSPECTOR_WIDTH);
    });

    it('exposes the responsive maximum used by the resizable separator', () => {
        expect(getMaximumInspectorWidth(1_200)).toBe(MAXIMUM_INSPECTOR_WIDTH);
        expect(getMaximumInspectorWidth(800)).toBe(360);
        expect(getMaximumInspectorWidth(400)).toBe(MINIMUM_INSPECTOR_WIDTH);
    });

    it('supports keyboard resizing from the inspector separator', () => {
        expect(getInspectorWidthForKey(360, 'ArrowLeft', 1_200)).toBe(376);
        expect(getInspectorWidthForKey(360, 'ArrowRight', 1_200)).toBe(344);
        expect(getInspectorWidthForKey(360, 'Home', 1_200)).toBe(MINIMUM_INSPECTOR_WIDTH);
        expect(getInspectorWidthForKey(360, 'End', 1_200)).toBe(MAXIMUM_INSPECTOR_WIDTH);
        expect(getInspectorWidthForKey(360, 'Enter', 1_200)).toBeNull();
    });
});

describe('editor layout preferences', () => {
    it('round-trips valid optional UI preferences', () => {
        const serialized = serializeEditorLayoutPreferences({
            timelineHeight: 312,
            inspectorWidth: 404,
            isInspectorVisible: false,
        });

        expect(parseEditorLayoutPreferences(serialized)).toEqual({
            timelineHeight: 312,
            inspectorWidth: 404,
            isInspectorVisible: false,
        });
        expect(EDITOR_LAYOUT_STORAGE_KEY).toBe('waptions.editor-layout.v1');
    });

    it('rejects malformed or incomplete storage values', () => {
        expect(parseEditorLayoutPreferences(null)).toBeNull();
        expect(parseEditorLayoutPreferences('{broken')).toBeNull();
        expect(parseEditorLayoutPreferences(JSON.stringify({ timelineHeight: 260 }))).toBeNull();
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
