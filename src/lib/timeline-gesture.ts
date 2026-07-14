/**
 * Local transaction state used by timeline pointer gestures.
 *
 * Timeline drags can emit hundreds of pointer events. Keeping those intermediate values in this
 * small reducer prevents previews from consuming undo history, invalidating transcription, or
 * scheduling persistence writes. Only `finishTimelineGesture` exposes a terminal value that a
 * component may commit to the durable store.
 */
export type TimelineGestureState<T> =
    | { status: 'idle' }
    | { status: 'active'; initial: T; draft: T };

export interface TimelineGestureFinish<T> {
    state: TimelineGestureState<T>;
    commit: T | null;
}

export function beginTimelineGesture<T>(initial: T): TimelineGestureState<T> {
    return { status: 'active', initial, draft: initial };
}

export function updateTimelineGesture<T>(
    state: TimelineGestureState<T>,
    draft: T,
): TimelineGestureState<T> {
    return state.status === 'active' ? { ...state, draft } : state;
}

/** Cancelling deliberately returns no terminal value, so pointercancel and Escape are no-ops. */
export function cancelTimelineGesture<T>(): TimelineGestureFinish<T> {
    return { state: { status: 'idle' }, commit: null };
}

/**
 * Finishes a gesture and yields at most one commit value. The equality hook lets compound drafts
 * avoid durable no-op actions without forcing every gesture value to be serializable.
 */
export function finishTimelineGesture<T>(
    state: TimelineGestureState<T>,
    equals: (left: T, right: T) => boolean = Object.is,
): TimelineGestureFinish<T> {
    if (state.status !== 'active') return { state: { status: 'idle' }, commit: null };
    return {
        state: { status: 'idle' },
        commit: equals(state.initial, state.draft) ? null : state.draft,
    };
}

/** Keyboard edits are already terminal, so one key command maps to at most one store action. */
export function commitTimelineKeyboardEdit<T>(
    initial: T,
    next: T,
    equals: (left: T, right: T) => boolean = Object.is,
): T | null {
    return equals(initial, next) ? null : next;
}
