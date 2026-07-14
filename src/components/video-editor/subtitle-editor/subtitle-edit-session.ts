export interface SubtitleHistoryKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}

export type SubtitleHistoryShortcut = 'undo' | 'redo';

/** Returns the app history action owned by a focused controlled subtitle textarea. */
export function getSubtitleHistoryShortcut(
  event: SubtitleHistoryKeyEvent,
): SubtitleHistoryShortcut | null {
  // Native IME history and candidate selection must remain untouched for the whole composition
  // session, even if the platform reports a modifier combination that normally means undo.
  if (event.isComposing || (!event.metaKey && !event.ctrlKey)) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key === 'y' && !event.shiftKey) return 'redo';
  if (key !== 'z') return null;
  return event.shiftKey ? 'redo' : 'undo';
}
