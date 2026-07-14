export const MINIMUM_TIMELINE_HEIGHT = 180;
export const MAXIMUM_TIMELINE_HEIGHT_RATIO = 0.6;
export const DEFAULT_TIMELINE_ROW_HEIGHT = 64;
export const MINIMUM_TIMELINE_ROW_HEIGHT = 48;
export const MAXIMUM_TIMELINE_ROW_HEIGHT = 192;
export const TIMELINE_ROW_KEYBOARD_STEP = 4;
export const TIMELINE_ROW_KEYBOARD_LARGE_STEP = 16;

/** Keeps the timeline usable without allowing it to consume the editor workspace. */
export function clampTimelineHeight(requestedHeight: number, workspaceHeight: number): number {
    const safeWorkspaceHeight = Number.isFinite(workspaceHeight) && workspaceHeight > 0
        ? workspaceHeight
        : 0;
    const maximumHeight = Math.max(
        MINIMUM_TIMELINE_HEIGHT,
        Math.floor(safeWorkspaceHeight * MAXIMUM_TIMELINE_HEIGHT_RATIO),
    );
    const safeRequestedHeight = Number.isFinite(requestedHeight)
        ? requestedHeight
        : MINIMUM_TIMELINE_HEIGHT;
    return Math.max(MINIMUM_TIMELINE_HEIGHT, Math.min(maximumHeight, safeRequestedHeight));
}

/** Keeps an independently resized timeline row inside the editor's usable density range. */
export function clampTimelineRowHeight(requestedHeight: number): number {
    const safeHeight = Number.isFinite(requestedHeight)
        ? Math.round(requestedHeight)
        : DEFAULT_TIMELINE_ROW_HEIGHT;
    return Math.max(
        MINIMUM_TIMELINE_ROW_HEIGHT,
        Math.min(MAXIMUM_TIMELINE_ROW_HEIGHT, safeHeight),
    );
}

/** Resolves the accessible keyboard contract shared by every timeline-row separator. */
export function getTimelineRowHeightForKey(
    currentHeight: number,
    key: string,
    useLargeStep = false,
): number | null {
    const height = clampTimelineRowHeight(currentHeight);
    const step = useLargeStep
        ? TIMELINE_ROW_KEYBOARD_LARGE_STEP
        : TIMELINE_ROW_KEYBOARD_STEP;
    if (key === 'ArrowUp') return clampTimelineRowHeight(height - step);
    if (key === 'ArrowDown') return clampTimelineRowHeight(height + step);
    if (key === 'Home') return MINIMUM_TIMELINE_ROW_HEIGHT;
    if (key === 'End') return MAXIMUM_TIMELINE_ROW_HEIGHT;
    return null;
}

/**
 * Converts a real hovered subtitle row into one safe group shift.
 *
 * Variable row heights make pointer pixels meaningless here. The caller performs DOM hit-testing
 * and this helper clamps the resulting index delta against every selected subtitle's original
 * row, matching the store's all-or-nothing group movement rule.
 */
export function getClampedSubtitleTrackShift(
    originalTrackIndexes: readonly number[],
    anchorTrackIndex: number,
    hoveredTrackIndex: number,
    trackCount: number,
): number | null {
    if (
        trackCount < 1
        || anchorTrackIndex < 0
        || anchorTrackIndex >= trackCount
        || hoveredTrackIndex < 0
        || hoveredTrackIndex >= trackCount
        || originalTrackIndexes.length === 0
        || originalTrackIndexes.some((index) => index < 0 || index >= trackCount)
    ) return null;
    const minimumShift = Math.max(...originalTrackIndexes.map((index) => -index));
    const maximumShift = Math.min(...originalTrackIndexes.map((index) => trackCount - 1 - index));
    return Math.max(
        minimumShift,
        Math.min(maximumShift, hoveredTrackIndex - anchorTrackIndex),
    );
}
