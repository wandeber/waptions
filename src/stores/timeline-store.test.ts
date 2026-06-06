import { beforeEach, describe, expect, it } from 'vitest';
import { useTimelineStore } from './timeline-store';
import { useVideoStore } from './video-store';
import type { AnimationStyle, Subtitle, SubtitleTrack } from '@/types/timeline';

const defaultStyle: AnimationStyle = {
    fadeInDuration: 0.2,
    fadeOutDuration: 0.2,
    initialScale: 1.5,
    bounceStrength: 1.7,
    useElasticEffect: true,
    fontSize: 48,
    textColor: '#FFF50B',
    strokeWidth: 6,
    strokeColor: '#000000',
    fontWeight: 800,
    textCase: 'uppercase',
    textAlign: 'center',
    hidePunctuation: false,
    punctuationChars: '¿?:-,.;¡!',
    removeAccents: false,
    fontFamily: 'Arial',
    numberOfLines: 1,
    position: { x: 50, y: 80 },
    backgroundColor: '#000000',
    backgroundOpacity: 0.5,
    backgroundBorderColor: '#FFF50B',
    backgroundBorderWidth: 2,
    backgroundMarginVertical: 8,
    backgroundMarginHorizontal: 16,
    backgroundBorderRadius: 8,
    backgroundOffsetX: 0,
    backgroundOffsetY: 0,
};

const subtitle = (id: string, text: string): Subtitle => ({
    id,
    text,
    startTime: 0,
    endTime: 1,
});

const track = (id: string, subtitles: Subtitle[] = []): SubtitleTrack => ({
    id,
    name: id,
    style: defaultStyle,
    subtitles,
    isVisible: true,
    isLocked: false,
});

const resetStores = () => {
    useVideoStore.setState({
        videoFile: null,
        videoUrl: null,
        width: 0,
        height: 0,
        fps: 30,
        duration: 0,
        bitrate: null,
        isLoading: false,
    });

    useTimelineStore.setState({
        tracks: [],
        activeTrackId: null,
        selectedSubtitleIds: [],
        lastSelectedId: null,
        history: [],
        redoStack: [],
        rawTranscription: null,
        transcriptionGroups: null,
        transcriptionContainerIds: null,
        isVideoSelected: false,
    });
};

describe('timeline history', () => {
    beforeEach(resetStores);

    it('undoes and redoes setTracks edits by default', async () => {
        const initialTrack = track('track-1', [subtitle('sub-1', 'hello')]);
        const hiddenTrack = { ...initialTrack, isVisible: false };
        const store = useTimelineStore.getState();

        store.setTracks([initialTrack], { resetHistory: true, skipSave: true });
        store.setTracks([hiddenTrack], { skipSave: true });

        expect(useTimelineStore.getState().history).toHaveLength(1);

        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState().tracks[0].isVisible).toBe(true);
        expect(useTimelineStore.getState().redoStack).toHaveLength(1);

        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState().tracks[0].isVisible).toBe(false);
    });

    it('restores transcription state together with timeline tracks', async () => {
        const initialTrack = track('track-1', [subtitle('sub-1', 'manual')]);
        const generatedTrack = track('track-1', [subtitle('sub-2', 'generated')]);
        const rawWord = subtitle('word-1', 'generated');
        const store = useTimelineStore.getState();

        store.setTracks([initialTrack], { resetHistory: true, skipSave: true });
        store.pushHistory();
        store.setTranscriptionState({ group: [rawWord] }, ['group'], [rawWord]);
        store.setTracks([generatedTrack], { skipHistory: true, skipSave: true });

        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState().tracks[0].subtitles[0].text).toBe('manual');
        expect(useTimelineStore.getState().rawTranscription).toBeNull();
        expect(useTimelineStore.getState().transcriptionGroups).toBeNull();
        expect(useTimelineStore.getState().transcriptionContainerIds).toBeNull();

        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState().tracks[0].subtitles[0].text).toBe('generated');
        expect(useTimelineStore.getState().rawTranscription?.[0].text).toBe('generated');
        expect(useTimelineStore.getState().transcriptionGroups?.group[0].text).toBe('generated');
        expect(useTimelineStore.getState().transcriptionContainerIds).toEqual(['group']);
    });

    it('resets history when loading or closing a project replaces tracks', () => {
        const initialTrack = track('track-1');
        const editedTrack = { ...initialTrack, isVisible: false };
        const store = useTimelineStore.getState();

        store.setTracks([initialTrack], { resetHistory: true, skipSave: true });
        store.setTracks([editedTrack], { skipSave: true });
        expect(useTimelineStore.getState().history).toHaveLength(1);

        useTimelineStore.getState().setTracks([], { resetHistory: true, skipSave: true });

        expect(useTimelineStore.getState().tracks).toEqual([]);
        expect(useTimelineStore.getState().history).toEqual([]);
        expect(useTimelineStore.getState().redoStack).toEqual([]);
    });

    it('undoes subtitle text updates made through the core update action', async () => {
        const initialTrack = track('track-1', [subtitle('sub-1', 'before')]);
        const store = useTimelineStore.getState();

        store.setTracks([initialTrack], { resetHistory: true, skipSave: true });
        useTimelineStore.getState().updateSubtitleInTrack('track-1', 'sub-1', { text: 'after' });

        expect(useTimelineStore.getState().tracks[0].subtitles[0].text).toBe('after');

        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState().tracks[0].subtitles[0].text).toBe('before');

        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState().tracks[0].subtitles[0].text).toBe('after');
    });

    it('undoes paste as a single grouped action', async () => {
        const initialTrack = track('track-1', [subtitle('sub-1', 'copied')]);

        useTimelineStore.getState().setTracks([initialTrack], { resetHistory: true, skipSave: true });
        useTimelineStore.setState({
            activeTrackId: 'track-1',
            selectedSubtitleIds: ['sub-1'],
            lastSelectedId: 'sub-1',
        });

        useTimelineStore.getState().copySelection();
        useTimelineStore.getState().pasteSelection(2);

        expect(useTimelineStore.getState().tracks[0].subtitles).toHaveLength(2);
        expect(useTimelineStore.getState().history).toHaveLength(1);

        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState().tracks[0].subtitles).toHaveLength(1);

        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState().tracks[0].subtitles).toHaveLength(2);
    });

    it('undoes moving selected subtitles between tracks', async () => {
        const sourceTrack = track('source', [subtitle('sub-1', 'move me')]);
        const targetTrack = track('target');

        useTimelineStore.getState().setTracks([sourceTrack, targetTrack], { resetHistory: true, skipSave: true });
        useTimelineStore.getState().moveSubtitlesToTrack(['sub-1'], 1);

        expect(useTimelineStore.getState().tracks[0].subtitles).toHaveLength(0);
        expect(useTimelineStore.getState().tracks[1].subtitles).toHaveLength(1);

        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState().tracks[0].subtitles).toHaveLength(1);
        expect(useTimelineStore.getState().tracks[1].subtitles).toHaveLength(0);

        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState().tracks[0].subtitles).toHaveLength(0);
        expect(useTimelineStore.getState().tracks[1].subtitles).toHaveLength(1);
    });

    it('does not create history entries for invalid subtitle mutations', () => {
        const sourceTrack = track('source', [subtitle('sub-1', 'move me')]);
        const targetTrack = track('target');

        useTimelineStore.getState().setTracks([sourceTrack, targetTrack], { resetHistory: true, skipSave: true });

        useTimelineStore.getState().updateSubtitleInTrack('source', 'missing', { text: 'nope' });
        useTimelineStore.getState().removeSubtitleFromTrack('source', 'missing');
        useTimelineStore.getState().moveSubtitleToTrack('missing', 'source', 'target');
        useTimelineStore.getState().moveSubtitlesToTrack(['sub-1'], -1);

        expect(useTimelineStore.getState().history).toEqual([]);
        expect(useTimelineStore.getState().tracks[0].subtitles).toHaveLength(1);
        expect(useTimelineStore.getState().tracks[1].subtitles).toHaveLength(0);
    });
});
