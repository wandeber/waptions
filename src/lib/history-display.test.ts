import { describe, expect, it } from 'vitest';
import type { TimelineHistoryEntry } from '@/stores/timeline-store-types';
import { buildNewestFirstHistoryDisplay } from './history-display';

const entry = (id: string, sequence: number): TimelineHistoryEntry => ({
    id,
    sequence,
    label: id,
    mergeKey: null,
    timestamp: sequence,
    patches: [],
    inversePatches: [],
    audioGraphMutationImpact: 'preserve-transcription',
    recalculatesContentBoundary: false,
    byteSize: 0,
    oversized: false,
});

describe('history display projection', () => {
    it('renders newest first while retaining chronological command semantics', () => {
        const display = buildNewestFirstHistoryDisplay(
            [entry('one', 1), entry('two', 2)],
            [entry('four', 4), entry('three', 3)],
        );
        expect(display.map((item) => item.entry.id)).toEqual(['four', 'three', 'two', 'one']);
        expect(display.map(({ chronologicalIndex, applied, current }) => ({
            chronologicalIndex,
            applied,
            current,
        }))).toEqual([
            { chronologicalIndex: 3, applied: false, current: false },
            { chronologicalIndex: 2, applied: false, current: false },
            { chronologicalIndex: 1, applied: true, current: true },
            { chronologicalIndex: 0, applied: true, current: false },
        ]);
    });
});
