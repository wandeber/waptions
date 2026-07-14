import type { AudioGraphMutationImpact } from '@/lib/audio-graph-signature';
import {
    applySerializablePatches,
    createSerializablePatches,
    estimateSerializableBytes,
} from '@/lib/serializable-patch';
import { TIMELINE_HISTORY_ROOTS } from './timeline-history-projection';
import type {
    TimelineHistoryEntry,
    TimelineHistoryMetadata,
    TimelineHistoryProjection,
} from './timeline-store-types';

export const TIMELINE_HISTORY_ENTRY_LIMIT = 500;
export const TIMELINE_HISTORY_BYTE_LIMIT = 32 * 1024 * 1024;
export const TIMELINE_HISTORY_MERGE_WINDOW_MS = 750;

export interface TimelineHistoryState {
    history: TimelineHistoryEntry[];
    redoStack: TimelineHistoryEntry[];
    historySequence: number;
    historyBytes: number;
}

export interface RecordTimelineHistoryOptions {
    metadata: TimelineHistoryMetadata;
    impact: AudioGraphMutationImpact;
    recalculatesContentBoundary: boolean;
    now?: number;
}

/** Creates one semantic history command, optionally merging it into a recent compatible edit. */
export function recordTimelineHistory(
    state: TimelineHistoryState,
    before: TimelineHistoryProjection,
    after: TimelineHistoryProjection,
    options: RecordTimelineHistoryOptions,
): TimelineHistoryState {
    const now = options.now ?? Date.now();
    const last = state.history.at(-1);
    const canMerge = Boolean(
        options.metadata.mergeKey
        && state.redoStack.length === 0
        && last?.mergeKey === options.metadata.mergeKey
        && now - last.timestamp <= TIMELINE_HISTORY_MERGE_WINDOW_MS,
    );

    if (canMerge && last) {
        // Reconstruct the original command baseline from the current pre-edit projection. This
        // avoids retaining a hidden full snapshot while still producing one clean merged diff.
        const baseline = applySerializablePatches(
            before,
            last.inversePatches,
            TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
        );
        const mergedPair = createSerializablePatches(
            baseline,
            after,
            TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
        );
        if (!hasMaterialPatches(mergedPair)) {
            // A continuous edit can return to its exact baseline inside the merge window. Remove
            // the earlier command instead of retaining a revision-consuming no-op Undo step.
            return boundTimelineHistory({
                history: state.history.slice(0, -1),
                redoStack: [],
                historySequence: state.historySequence,
                historyBytes: 0,
            });
        }
        const pair = withSelectionContext(mergedPair, baseline, after);
        const merged = sizeEntry({
            ...last,
            label: options.metadata.label,
            timestamp: now,
            patches: pair.patches,
            inversePatches: pair.inversePatches,
            audioGraphMutationImpact: mergeImpact(last.audioGraphMutationImpact, options.impact),
            recalculatesContentBoundary: last.recalculatesContentBoundary
                || options.recalculatesContentBoundary,
        });
        return boundTimelineHistory({
            history: [...state.history.slice(0, -1), merged],
            redoStack: [],
            historySequence: state.historySequence,
            historyBytes: 0,
        });
    }

    const materialPair = createSerializablePatches(
        before,
        after,
        TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
    );
    if (!hasMaterialPatches(materialPair)) return state;
    const pair = withSelectionContext(materialPair, before, after);
    const sequence = state.historySequence + 1;
    const entry = sizeEntry({
        id: `history-${sequence}`,
        sequence,
        label: options.metadata.label,
        mergeKey: options.metadata.mergeKey ?? null,
        timestamp: now,
        patches: pair.patches,
        inversePatches: pair.inversePatches,
        audioGraphMutationImpact: options.impact,
        recalculatesContentBoundary: options.recalculatesContentBoundary,
        byteSize: 0,
        oversized: false,
    });
    return boundTimelineHistory({
        history: [...state.history, entry],
        redoStack: [],
        historySequence: sequence,
        historyBytes: 0,
    });
}

/**
 * Enforces a combined undo/redo budget. The newest command is retained even when it alone exceeds
 * 32 MiB so the user's most recent edit always remains undoable; the panel marks it as oversized.
 */
export function boundTimelineHistory(state: TimelineHistoryState): TimelineHistoryState {
    const history = [...state.history];
    const redoStack = [...state.redoStack];
    let byteSize = sumBytes(history, redoStack);
    const exceedsBudget = () => history.length + redoStack.length > TIMELINE_HISTORY_ENTRY_LIMIT
        || byteSize > TIMELINE_HISTORY_BYTE_LIMIT;

    while (exceedsBudget() && history.length + redoStack.length > 1) {
        // history[0] is the oldest applied command. If no undo command remains, redo[0] is the
        // farthest future command and therefore the least useful retained branch entry.
        const evicted = history.length > 0 ? history.shift() : redoStack.shift();
        byteSize -= evicted?.byteSize ?? 0;
    }

    const latest = history.at(-1) ?? redoStack.at(-1);
    if (latest) {
        const oversized = latest.byteSize > TIMELINE_HISTORY_BYTE_LIMIT;
        if (latest.oversized !== oversized) {
            const replacement = { ...latest, oversized };
            if (history.at(-1) === latest) history[history.length - 1] = replacement;
            else redoStack[redoStack.length - 1] = replacement;
        }
    }
    return {
        history,
        redoStack,
        historySequence: state.historySequence,
        historyBytes: sumBytes(history, redoStack),
    };
}

/** Recomputes trusted byte totals and the next sequence from validated persisted entries. */
export function normalizeTimelineHistory(
    history: readonly TimelineHistoryEntry[],
    redoStack: readonly TimelineHistoryEntry[],
): TimelineHistoryState {
    const normalizedHistory = history.map(sizeEntry);
    const normalizedRedo = redoStack.map(sizeEntry);
    const sequence = [...normalizedHistory, ...normalizedRedo]
        .reduce((maximum, entry) => Math.max(maximum, entry.sequence), 0);
    return boundTimelineHistory({
        history: normalizedHistory,
        redoStack: normalizedRedo,
        historySequence: sequence,
        historyBytes: 0,
    });
}

function sizeEntry(entry: TimelineHistoryEntry): TimelineHistoryEntry {
    const base = { ...entry, byteSize: 0, oversized: false };
    const byteSize = estimateSerializableBytes(base);
    return {
        ...base,
        byteSize,
        oversized: byteSize > TIMELINE_HISTORY_BYTE_LIMIT,
    };
}

function sumBytes(
    history: readonly TimelineHistoryEntry[],
    redoStack: readonly TimelineHistoryEntry[],
): number {
    return [...history, ...redoStack].reduce((sum, entry) => sum + entry.byteSize, 0);
}

function mergeImpact(
    left: AudioGraphMutationImpact,
    right: AudioGraphMutationImpact,
): AudioGraphMutationImpact {
    return left === 'invalidate-transcription' || right === 'invalidate-transcription'
        ? 'invalidate-transcription'
        : 'preserve-transcription';
}

const HISTORY_CONTEXT_ROOTS = [
    'transientSelection',
    'activeTrackId',
    'selectedSubtitleIds',
    'lastSelectedId',
    'selectedClipId',
    'isVideoSelected',
] as const satisfies readonly (keyof TimelineHistoryProjection)[];

/** Context roots make history navigation predictable, but never constitute an edit by themselves. */
function hasMaterialPatches(pair: ReturnType<typeof createSerializablePatches>): boolean {
    const contextRoots = new Set<string>(HISTORY_CONTEXT_ROOTS);
    return pair.patches.some((patch) => !contextRoots.has(String(patch.path[0])));
}

/**
 * Selection is command context, not merely edited data. Store one root assignment in both
 * directions even when the command itself did not change selection, so navigating history lands
 * on the exact object/lane selection that surrounded that command. Net-zero merge detection runs
 * before this enrichment because these contextual assignments are intentionally always present.
 */
function withSelectionContext(
    pair: ReturnType<typeof createSerializablePatches>,
    before: TimelineHistoryProjection,
    after: TimelineHistoryProjection,
): ReturnType<typeof createSerializablePatches> {
    const roots = new Set<string>(HISTORY_CONTEXT_ROOTS);
    const patches = pair.patches.filter((patch) => !roots.has(String(patch.path[0])));
    const inversePatches = pair.inversePatches.filter((patch) => !roots.has(String(patch.path[0])));
    HISTORY_CONTEXT_ROOTS.forEach((root) => {
        patches.push({ op: 'set', path: [root], value: structuredClone(after[root]) });
        inversePatches.unshift({ op: 'set', path: [root], value: structuredClone(before[root]) });
    });
    return { patches, inversePatches };
}
