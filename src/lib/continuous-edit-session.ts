export type ContinuousEditTerminal = 'commit' | 'cancel';

export interface ContinuousEditSession<T> {
    baseline: T;
    latest: T;
    terminal: ContinuousEditTerminal | null;
}

export interface ContinuousEditResult<T> {
    session: ContinuousEditSession<T>;
    value: T;
    shouldCommit: boolean;
}

/** Maps draft-only terminal keys while preserving IME candidate confirmation and cancellation. */
export function getContinuousEditKeyboardTerminal(
    key: string,
    isComposing: boolean,
): ContinuousEditTerminal | null {
    if (isComposing) return null;
    if (key === 'Enter') return 'commit';
    if (key === 'Escape') return 'cancel';
    return null;
}

/** Starts one UI gesture or focus lifetime from its durable baseline. */
export function beginContinuousEdit<T>(baseline: T): ContinuousEditSession<T> {
    return { baseline, latest: baseline, terminal: null };
}

/** Updates only the local preview. Terminal sessions intentionally ignore late browser events. */
export function previewContinuousEdit<T>(
    session: ContinuousEditSession<T>,
    latest: T,
): ContinuousEditSession<T> {
    return session.terminal === null ? { ...session, latest } : session;
}

/**
 * Resolves a session exactly once.
 *
 * Pointer capture can emit pointerup and then lostpointercapture, while Enter commonly causes a
 * subsequent blur. Returning shouldCommit=false after the first terminal prevents both browser
 * sequences from creating duplicate durable commands.
 */
export function terminateContinuousEdit<T>(
    session: ContinuousEditSession<T>,
    terminal: ContinuousEditTerminal,
    equals: (left: T, right: T) => boolean = Object.is,
): ContinuousEditResult<T> {
    if (session.terminal !== null) {
        return {
            session,
            value: session.terminal === 'cancel' ? session.baseline : session.latest,
            shouldCommit: false,
        };
    }
    const terminated = { ...session, terminal };
    return {
        session: terminated,
        value: terminal === 'cancel' ? session.baseline : session.latest,
        shouldCommit: terminal === 'commit' && !equals(session.baseline, session.latest),
    };
}
