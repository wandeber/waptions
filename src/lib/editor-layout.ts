export const MINIMUM_TIMELINE_HEIGHT = 180;
export const MAXIMUM_TIMELINE_HEIGHT_RATIO = 0.6;
export const DEFAULT_TIMELINE_HEIGHT = 260;
export const DEFAULT_TIMELINE_ROW_HEIGHT = 64;
export const MINIMUM_TIMELINE_ROW_HEIGHT = 48;
export const MAXIMUM_TIMELINE_ROW_HEIGHT = 192;
export const TIMELINE_ROW_KEYBOARD_STEP = 4;
export const TIMELINE_ROW_KEYBOARD_LARGE_STEP = 16;
export const DEFAULT_INSPECTOR_WIDTH = 360;
export const MINIMUM_INSPECTOR_WIDTH = 280;
export const MAXIMUM_INSPECTOR_WIDTH = 520;
export const INSPECTOR_KEYBOARD_STEP = 16;
export const EDITOR_LAYOUT_STORAGE_KEY = 'waptions.editor-layout.v1';

export interface EditorLayoutPreferences {
    timelineHeight: number;
    inspectorWidth: number;
    isInspectorVisible: boolean;
}

/** Keeps the timeline usable without allowing it to consume the editor workspace. */
export function getMaximumTimelineHeight(workspaceHeight: number): number {
    const safeWorkspaceHeight = Number.isFinite(workspaceHeight) && workspaceHeight > 0
        ? workspaceHeight
        : 0;
    return Math.max(
        MINIMUM_TIMELINE_HEIGHT,
        Math.floor(safeWorkspaceHeight * MAXIMUM_TIMELINE_HEIGHT_RATIO),
    );
}

/** Keeps the timeline usable without allowing it to consume the editor workspace. */
export function clampTimelineHeight(requestedHeight: number, workspaceHeight: number): number {
    const maximumHeight = getMaximumTimelineHeight(workspaceHeight);
    const safeRequestedHeight = Number.isFinite(requestedHeight)
        ? requestedHeight
        : MINIMUM_TIMELINE_HEIGHT;
    return Math.max(MINIMUM_TIMELINE_HEIGHT, Math.min(maximumHeight, safeRequestedHeight));
}

/** Keeps the inspector useful while reserving enough horizontal room for the monitor and timeline. */
export function getMaximumInspectorWidth(workspaceWidth: number): number {
    const safeWorkspaceWidth = Number.isFinite(workspaceWidth) && workspaceWidth > 0
        ? workspaceWidth
        : MINIMUM_INSPECTOR_WIDTH;
    return Math.max(
        MINIMUM_INSPECTOR_WIDTH,
        Math.min(MAXIMUM_INSPECTOR_WIDTH, Math.floor(safeWorkspaceWidth * 0.45)),
    );
}

/** Keeps the inspector useful while reserving enough horizontal room for the monitor and timeline. */
export function clampInspectorWidth(requestedWidth: number, workspaceWidth: number): number {
    const maximumWidth = getMaximumInspectorWidth(workspaceWidth);
    const safeRequestedWidth = Number.isFinite(requestedWidth)
        ? requestedWidth
        : DEFAULT_INSPECTOR_WIDTH;
    return Math.max(MINIMUM_INSPECTOR_WIDTH, Math.min(maximumWidth, Math.round(safeRequestedWidth)));
}

/** Resolves keyboard resizing for the inspector's vertical separator. */
export function getInspectorWidthForKey(
    currentWidth: number,
    key: string,
    workspaceWidth: number,
): number | null {
    if (key === 'ArrowLeft') {
        return clampInspectorWidth(currentWidth + INSPECTOR_KEYBOARD_STEP, workspaceWidth);
    }
    if (key === 'ArrowRight') {
        return clampInspectorWidth(currentWidth - INSPECTOR_KEYBOARD_STEP, workspaceWidth);
    }
    if (key === 'Home') return clampInspectorWidth(MINIMUM_INSPECTOR_WIDTH, workspaceWidth);
    if (key === 'End') return clampInspectorWidth(MAXIMUM_INSPECTOR_WIDTH, workspaceWidth);
    return null;
}

/** Resolves keyboard resizing for the monitor/timeline horizontal separator. */
export function getTimelineHeightForKey(
    currentHeight: number,
    key: string,
    workspaceHeight: number,
): number | null {
    if (key === 'ArrowUp') return clampTimelineHeight(currentHeight + INSPECTOR_KEYBOARD_STEP, workspaceHeight);
    if (key === 'ArrowDown') return clampTimelineHeight(currentHeight - INSPECTOR_KEYBOARD_STEP, workspaceHeight);
    if (key === 'Home') return clampTimelineHeight(MINIMUM_TIMELINE_HEIGHT, workspaceHeight);
    if (key === 'End') return clampTimelineHeight(workspaceHeight, workspaceHeight);
    return null;
}

/** Reads optional local UI preferences without letting malformed storage break the editor shell. */
export function parseEditorLayoutPreferences(serialized: string | null): EditorLayoutPreferences | null {
    if (!serialized) return null;
    try {
        const value = JSON.parse(serialized) as Partial<EditorLayoutPreferences>;
        if (
            !Number.isFinite(value.timelineHeight)
            || !Number.isFinite(value.inspectorWidth)
            || typeof value.isInspectorVisible !== 'boolean'
        ) return null;
        return {
            timelineHeight: Math.max(MINIMUM_TIMELINE_HEIGHT, Math.round(value.timelineHeight as number)),
            inspectorWidth: Math.max(MINIMUM_INSPECTOR_WIDTH, Math.round(value.inspectorWidth as number)),
            isInspectorVisible: value.isInspectorVisible,
        };
    } catch {
        return null;
    }
}

export function serializeEditorLayoutPreferences(preferences: EditorLayoutPreferences): string {
    return JSON.stringify(preferences);
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
