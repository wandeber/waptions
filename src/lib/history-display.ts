import type { TimelineHistoryEntry } from '@/stores/timeline-store-types';

export interface HistoryDisplayEntry {
    entry: TimelineHistoryEntry;
    chronologicalIndex: number;
    applied: boolean;
    current: boolean;
}

/** Keeps store history chronological while projecting the inspector's newest-first presentation. */
export function buildNewestFirstHistoryDisplay(
    history: readonly TimelineHistoryEntry[],
    redoStack: readonly TimelineHistoryEntry[],
): HistoryDisplayEntry[] {
    const cursor = history.length;
    return [...history, ...[...redoStack].reverse()]
        .map((entry, chronologicalIndex) => ({
            entry,
            chronologicalIndex,
            applied: chronologicalIndex < cursor,
            current: chronologicalIndex + 1 === cursor,
        }))
        .reverse();
}
