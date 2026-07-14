import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnimationStyle } from '@/types/timeline';
import {
    createTimelineAudioRuntimeInputsSelector,
    selectTimelineAudioRuntimeInputs,
} from '@/hooks/timeline-audio-runtime-sync';
import { useTimelineStore } from './timeline-store';

type RuntimeState = Parameters<typeof selectTimelineAudioRuntimeInputs>[0];

describe('timeline content boundary invalidation', () => {
    beforeEach(() => {
        useTimelineStore.getState().resetEditorDocument();
        useTimelineStore.setState({
            tracks: [{
                id: 'captions',
                name: 'Captions',
                style: {} as AnimationStyle,
                subtitles: [{ id: 'first', startTime: 0, endTime: 1, text: 'Before' }],
                isVisible: true,
                isLocked: false,
            }],
            activeTrackId: 'captions',
            contentBoundaryRevision: 100,
            history: [],
            redoStack: [],
        });
    });

    afterEach(() => {
        useTimelineStore.getState().resetEditorDocument();
    });

    it('keeps metadata edits O(1) and recalculates exact timing add, remove, and resize boundaries', () => {
        const calculateBoundary = vi.fn((state: RuntimeState) => (
            selectTimelineAudioRuntimeInputs(state).contentEndFrame
        ));
        const selectRuntimeInputs = createTimelineAudioRuntimeInputsSelector(calculateBoundary);
        const initialInputs = selectRuntimeInputs(useTimelineStore.getState());
        expect(initialInputs.contentEndFrame).toBe(30);

        for (let edit = 0; edit < 25; edit += 1) {
            useTimelineStore.getState().updateSubtitleInTrack(
                'captions',
                'first',
                { text: `Metadata edit ${edit}` },
            );
            selectRuntimeInputs(useTimelineStore.getState());
            useTimelineStore.getState().updateTrackStyle('captions', { fontSize: 20 + edit });
            selectRuntimeInputs(useTimelineStore.getState());
        }

        expect(useTimelineStore.getState().contentBoundaryRevision).toBe(100);
        expect(calculateBoundary).toHaveBeenCalledOnce();

        useTimelineStore.getState().updateSubtitleInTrack('captions', 'first', { endTime: 2 });
        expect(selectRuntimeInputs(useTimelineStore.getState()).contentEndFrame).toBe(60);
        expect(useTimelineStore.getState().contentBoundaryRevision).toBe(101);

        const addedId = useTimelineStore.getState().addSubtitleToTrack('captions', {
            startTime: 2,
            endTime: 3,
            text: 'Added',
        });
        expect(selectRuntimeInputs(useTimelineStore.getState()).contentEndFrame).toBe(90);
        expect(useTimelineStore.getState().contentBoundaryRevision).toBe(102);

        useTimelineStore.getState().removeSubtitleFromTrack('captions', addedId);
        expect(selectRuntimeInputs(useTimelineStore.getState()).contentEndFrame).toBe(60);
        expect(useTimelineStore.getState().contentBoundaryRevision).toBe(103);
        expect(calculateBoundary).toHaveBeenCalledTimes(4);
    });

    it('invalidates the exact boundary through drag preview, terminal commit, history, and hydration', async () => {
        const calculateBoundary = vi.fn((state: RuntimeState) => (
            selectTimelineAudioRuntimeInputs(state).contentEndFrame
        ));
        const selectRuntimeInputs = createTimelineAudioRuntimeInputsSelector(calculateBoundary);
        expect(selectRuntimeInputs(useTimelineStore.getState()).contentEndFrame).toBe(30);

        useTimelineStore.getState().setIsDragging(true, { label: 'Move subtitles' });
        expect(selectRuntimeInputs(useTimelineStore.getState()).contentEndFrame).toBe(30);
        expect(calculateBoundary).toHaveBeenCalledOnce();

        useTimelineStore.getState().updateSubtitleInTrack(
            'captions',
            'first',
            { endTime: 2 },
            { skipHistory: true },
        );
        expect(selectRuntimeInputs(useTimelineStore.getState()).contentEndFrame).toBe(60);
        expect(useTimelineStore.getState().contentBoundaryRevision).toBe(101);

        useTimelineStore.getState().updateSubtitleInTrack(
            'captions',
            'first',
            { endTime: 3 },
            { skipHistory: true },
        );
        expect(selectRuntimeInputs(useTimelineStore.getState()).contentEndFrame).toBe(90);
        expect(useTimelineStore.getState().contentBoundaryRevision).toBe(102);

        useTimelineStore.getState().setIsDragging(false);
        expect(selectRuntimeInputs(useTimelineStore.getState()).contentEndFrame).toBe(90);
        expect(useTimelineStore.getState().contentBoundaryRevision).toBe(103);
        expect(calculateBoundary).toHaveBeenCalledTimes(4);

        await useTimelineStore.getState().undo();
        expect(selectRuntimeInputs(useTimelineStore.getState()).contentEndFrame).toBe(30);
        expect(useTimelineStore.getState().contentBoundaryRevision).toBe(104);

        await useTimelineStore.getState().redo();
        expect(selectRuntimeInputs(useTimelineStore.getState()).contentEndFrame).toBe(90);
        expect(useTimelineStore.getState().contentBoundaryRevision).toBe(105);

        const currentDocument = useTimelineStore.getState().buildEditorDocument();
        useTimelineStore.getState().hydrateEditorDocument({
            ...currentDocument,
            revision: currentDocument.revision + 1,
            subtitleTracks: currentDocument.subtitleTracks.map((track) => ({
                ...track,
                subtitles: track.subtitles.map((subtitle) => (
                    subtitle.id === 'first' ? { ...subtitle, endTime: 4 } : subtitle
                )),
            })),
        });
        expect(selectRuntimeInputs(useTimelineStore.getState()).contentEndFrame).toBe(120);
        expect(useTimelineStore.getState().contentBoundaryRevision).toBe(106);
        expect(calculateBoundary).toHaveBeenCalledTimes(7);

        useTimelineStore.getState().updateSubtitleInTrack('captions', 'first', { text: 'After hydrate' });
        selectRuntimeInputs(useTimelineStore.getState());
        useTimelineStore.getState().updateTrackStyle('captions', { fontSize: 64 });
        expect(selectRuntimeInputs(useTimelineStore.getState()).contentEndFrame).toBe(120);
        expect(useTimelineStore.getState().contentBoundaryRevision).toBe(106);
        expect(calculateBoundary).toHaveBeenCalledTimes(7);
    });
});
