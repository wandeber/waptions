import { describe, expect, it } from 'vitest';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import type { TimelineHistoryProjection } from './timeline-store-types';
import type { AnimationStyle } from '@/types/timeline';
import type { TimelineHistoryState } from './timeline-history';
import {
    TIMELINE_HISTORY_BYTE_LIMIT,
    TIMELINE_HISTORY_ENTRY_LIMIT,
    boundTimelineHistory,
    recordTimelineHistory,
} from './timeline-history';

const projection = (name = 'Captions'): TimelineHistoryProjection => ({
    tracks: [{
        id: 'track',
        name,
        style: {} as AnimationStyle,
        subtitles: [],
        isVisible: true,
        isLocked: false,
    }],
    videoClips: [],
    videoTracks: [{ id: 'video_track_1', name: 'Video 1', clipIds: [] }],
    renderProfile: createDefaultRenderProfile(),
    audioTracks: [],
    transientSelection: { kind: 'none' },
    activeTrackId: 'track',
    selectedSubtitleIds: [],
    lastSelectedId: null,
    selectedClipId: null,
    isVideoSelected: false,
    transcriptionByTrackId: {},
    rawTranscription: null,
    transcriptionGroups: null,
    transcriptionContainerIds: null,
});

const emptyHistory = (): TimelineHistoryState => ({
    history: [],
    redoStack: [],
    historySequence: 0,
    historyBytes: 0,
});

describe('timeline patch history policy', () => {
    it('ignores commands that only replace selection context with equivalent or new context', () => {
        const state = emptyHistory();
        const before = projection();
        const after = {
            ...structuredClone(before),
            transientSelection: { kind: 'video-clip' as const, clipId: 'video_clip' },
            selectedClipId: 'video_clip',
            isVideoSelected: true,
        };

        expect(recordTimelineHistory(state, before, structuredClone(before), {
            metadata: { label: 'Equivalent clone' },
            impact: 'preserve-transcription',
            recalculatesContentBoundary: false,
        })).toBe(state);
        expect(recordTimelineHistory(emptyHistory(), before, after, {
            metadata: { label: 'Select video clip' },
            impact: 'preserve-transcription',
            recalculatesContentBoundary: false,
        })).toEqual(emptyHistory());
    });

    it('records semantic forward/inverse patches and trusted byte totals', () => {
        const result = recordTimelineHistory(
            emptyHistory(),
            projection(),
            projection('Dialogue'),
            {
                metadata: { label: 'Rename subtitle track' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 1,
            },
        );

        expect(result.history).toHaveLength(1);
        expect(result.history[0]).toMatchObject({
            id: 'history-1',
            sequence: 1,
            label: 'Rename subtitle track',
            mergeKey: null,
        });
        expect(result.history[0].patches).toContainEqual(expect.objectContaining({
            op: 'set',
            path: ['tracks', { id: 'track' }, 'name'],
            value: 'Dialogue',
        }));
        expect(result.history[0].inversePatches).toContainEqual(expect.objectContaining({
            op: 'set',
            path: ['tracks', { id: 'track' }, 'name'],
            value: 'Captions',
        }));
        expect(result.historyBytes).toBe(result.history[0].byteSize);
    });

    it('merges compatible commands from the original baseline inside the 750ms window', () => {
        const first = recordTimelineHistory(
            emptyHistory(),
            projection(),
            projection('D'),
            {
                metadata: { label: 'Rename subtitle track', mergeKey: 'track-name:track' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 100,
            },
        );
        const merged = recordTimelineHistory(
            first,
            projection('D'),
            projection('Dialogue'),
            {
                metadata: { label: 'Rename subtitle track', mergeKey: 'track-name:track' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 700,
            },
        );

        expect(merged.history).toHaveLength(1);
        expect(merged.historySequence).toBe(1);
        expect(merged.history[0].timestamp).toBe(700);
    });

    it('removes a merged command that returns to its material baseline with different selection', () => {
        const first = recordTimelineHistory(
            emptyHistory(),
            projection('A'),
            projection('B'),
            {
                metadata: { label: 'Rename subtitle track', mergeKey: 'track-name:track' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 100,
            },
        );
        const selectedBaseline = {
            ...projection('A'),
            transientSelection: { kind: 'video-clip' as const, clipId: 'video_clip' },
            selectedClipId: 'video_clip',
            isVideoSelected: true,
        };
        const netZero = recordTimelineHistory(
            first,
            projection('B'),
            selectedBaseline,
            {
                metadata: { label: 'Rename subtitle track', mergeKey: 'track-name:track' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 200,
            },
        );

        expect(netZero.history).toEqual([]);
        expect(netZero.historyBytes).toBe(0);
        // Sequence IDs stay monotonic even when the retained command is compacted away.
        expect(netZero.historySequence).toBe(1);
    });

    it('starts a new command after Undo even when the retained command has the same merge key', () => {
        const first = recordTimelineHistory(
            emptyHistory(),
            projection(),
            projection('Draft'),
            {
                metadata: { label: 'Rename subtitle track', mergeKey: 'track-name:track' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 100,
            },
        );
        const second = recordTimelineHistory(
            first,
            projection('Draft'),
            projection('Discarded future'),
            {
                metadata: { label: 'Independent edit' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 1_000,
            },
        );
        const afterUndo = {
            ...second,
            history: [first.history[0]],
            redoStack: [second.history[1]],
        };

        const branched = recordTimelineHistory(
            afterUndo,
            projection('Draft'),
            projection('Final'),
            {
                metadata: { label: 'Rename subtitle track', mergeKey: 'track-name:track' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 200,
            },
        );

        expect(branched.history.map((entry) => entry.id)).toEqual(['history-1', 'history-3']);
        expect(branched.redoStack).toEqual([]);
        expect(branched.history[0].patches).toEqual(first.history[0].patches);
    });

    it('shares the 500-entry budget across undo and redo branches', () => {
        let state = emptyHistory();
        let before = projection();
        for (let index = 1; index <= TIMELINE_HISTORY_ENTRY_LIMIT + 10; index += 1) {
            const after = projection(`Captions ${index}`);
            state = recordTimelineHistory(state, before, after, {
                metadata: { label: `Rename ${index}` },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: index * 1_000,
            });
            before = after;
        }
        expect(state.history).toHaveLength(TIMELINE_HISTORY_ENTRY_LIMIT);
        const bounded = boundTimelineHistory({
            ...state,
            history: state.history.slice(0, 300),
            redoStack: state.history.slice(300),
        });
        expect(bounded.history.length + bounded.redoStack.length).toBe(TIMELINE_HISTORY_ENTRY_LIMIT);
    });

    it('evicts the oldest command when the combined byte budget is exceeded', () => {
        const first = recordTimelineHistory(emptyHistory(), projection(), projection('First'), {
            metadata: { label: 'First' },
            impact: 'preserve-transcription',
            recalculatesContentBoundary: false,
            now: 1,
        });
        const second = recordTimelineHistory(first, projection('First'), projection('Second'), {
            metadata: { label: 'Second' },
            impact: 'preserve-transcription',
            recalculatesContentBoundary: false,
            now: 2,
        });
        const oversizedPair = second.history.map((entry) => ({
            ...entry,
            byteSize: Math.floor(TIMELINE_HISTORY_BYTE_LIMIT * 0.6),
        }));

        const bounded = boundTimelineHistory({ ...second, history: oversizedPair });

        expect(bounded.history.map((entry) => entry.id)).toEqual(['history-2']);
        expect(bounded.historyBytes).toBe(oversizedPair[1].byteSize);
    });

    it('retains and marks the latest command when it alone exceeds the byte budget', () => {
        const recorded = recordTimelineHistory(emptyHistory(), projection(), projection('Latest'), {
            metadata: { label: 'Latest' },
            impact: 'preserve-transcription',
            recalculatesContentBoundary: false,
            now: 1,
        });
        const oversized = {
            ...recorded.history[0],
            byteSize: TIMELINE_HISTORY_BYTE_LIMIT + 1,
            oversized: false,
        };

        const bounded = boundTimelineHistory({ ...recorded, history: [oversized] });

        expect(bounded.history).toHaveLength(1);
        expect(bounded.history[0]).toMatchObject({ id: 'history-1', oversized: true });
        expect(bounded.historyBytes).toBe(TIMELINE_HISTORY_BYTE_LIMIT + 1);
    });
});
