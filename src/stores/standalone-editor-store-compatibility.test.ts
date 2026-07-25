import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createEditorDocumentV4Fixture,
    createSubtitleTrackV4Fixture,
} from '@/types/editorial.test-fixtures';
import {
    setStandaloneEditorEngineBridge,
    type StandaloneEditorEngineBridge,
} from './standalone-editor-engine-registry';
import { useTimelineStore } from './timeline-store';

afterEach(() => {
    setStandaloneEditorEngineBridge(null);
    useTimelineStore.getState().resetEditorDocument();
});

describe('standalone editor Zustand compatibility', () => {
    it('enqueues a semantic command without optimistically publishing durable graph state', () => {
        const document = createEditorDocumentV4Fixture({ narrative: null });
        useTimelineStore.getState().hydrateEditorDocument(document);
        const enqueueOperations = vi.fn((_, options) => options.compatibilityResult);
        setStandaloneEditorEngineBridge(bridge({ enqueueOperations }));

        const result = useTimelineStore.getState().executeOrdinaryV4Command({
            target: { kind: 'video-clip', clipId: 'video_clip_editorial' },
            action: {
                kind: 'move',
                targetTrackId: 'video_track_editorial',
                targetStart: 60,
            },
        });

        expect(result.kind).toBe('success');
        expect(enqueueOperations).toHaveBeenCalledOnce();
        expect(enqueueOperations.mock.calls[0][0][0]).toMatchObject({
            type: 'video-clip.move',
            payload: {
                clipId: 'video_clip_editorial',
                timelineStartFrame: 60,
            },
        });
        expect(useTimelineStore.getState().videoClips[0].timelineStartFrame).toBe(0);
        expect(useTimelineStore.getState().revision).toBe(document.revision);
    });

    it('surfaces a typed unsupported boundary without publishing a cross-track move', () => {
        const document = createEditorDocumentV4Fixture({
            narrative: null,
            subtitleTracks: [createSubtitleTrackV4Fixture({
                id: 'subtitle_track_a',
                subtitles: [{ id: 'subtitle_a', startTime: 0, endTime: 1, text: 'A' }],
            }), createSubtitleTrackV4Fixture({
                id: 'subtitle_track_b',
                subtitles: [],
            })],
            activeSubtitleTrackId: 'subtitle_track_a',
        });
        useTimelineStore.getState().hydrateEditorDocument(document);
        const reportUnsupported = vi.fn();
        setStandaloneEditorEngineBridge(bridge({ reportUnsupported }));

        const result = useTimelineStore.getState().executeOrdinaryV4Command({
            target: {
                kind: 'subtitle',
                trackId: 'subtitle_track_a',
                subtitleId: 'subtitle_a',
            },
            action: {
                kind: 'move',
                targetTrackId: 'subtitle_track_b',
                targetStart: 48_000,
            },
        });

        expect(result).toMatchObject({
            kind: 'error',
            error: { code: 'unsupported-cross-track-subtitle-move' },
        });
        expect(reportUnsupported).toHaveBeenCalledOnce();
        expect(useTimelineStore.getState().tracks[0].subtitles[0]).toMatchObject({
            id: 'subtitle_a',
            startTime: 0,
        });
        expect(useTimelineStore.getState().tracks[1].subtitles).toEqual([]);
    });

    it('batches detached embedded audio without publishing an intermediate track', () => {
        const document = createEditorDocumentV4Fixture({ narrative: null });
        useTimelineStore.getState().hydrateEditorDocument(document);
        const enqueueOperations = vi.fn((_, options) => options.compatibilityResult);
        setStandaloneEditorEngineBridge(bridge({ enqueueOperations }));

        useTimelineStore.getState().detachVideoClipAudio('video_clip_editorial', {
            trackId: 'detached_audio_track',
            clipId: 'detached_audio_clip',
        });

        expect(enqueueOperations).toHaveBeenCalledOnce();
        expect(enqueueOperations.mock.calls[0][0]).toMatchObject([
            {
                type: 'track.add',
                payload: {
                    trackKind: 'audio',
                    trackId: 'detached_audio_track',
                },
            },
            {
                type: 'video-clip.detach-audio',
                payload: {
                    clipId: 'video_clip_editorial',
                    audioTrackId: 'detached_audio_track',
                    detachedClipId: 'detached_audio_clip',
                },
            },
        ]);
        expect(enqueueOperations.mock.calls[0][1]).toMatchObject({
            selectionAfter: {
                kind: 'audio-clip',
                trackId: 'detached_audio_track',
                clipId: 'detached_audio_clip',
            },
        });
        expect(useTimelineStore.getState().audioTracks).toEqual([]);
        expect(useTimelineStore.getState().videoClips[0].audio?.linkState).toBe('linked');
    });

    it('routes subtitle visibility through track state without changing the projection first', () => {
        const track = createSubtitleTrackV4Fixture({ id: 'subtitle_track' });
        const document = createEditorDocumentV4Fixture({
            narrative: null,
            subtitleTracks: [track],
            activeSubtitleTrackId: track.id,
        });
        useTimelineStore.getState().hydrateEditorDocument(document);
        const enqueueOperations = vi.fn((_, options) => options.compatibilityResult);
        setStandaloneEditorEngineBridge(bridge({ enqueueOperations }));

        useTimelineStore.getState().setTracks([{ ...track, isVisible: false }]);

        expect(enqueueOperations).toHaveBeenCalledOnce();
        expect(enqueueOperations.mock.calls[0][0]).toMatchObject([{
            type: 'track.set-state',
            payload: {
                trackKind: 'subtitle',
                trackId: track.id,
                visible: false,
            },
        }]);
        expect(useTimelineStore.getState().tracks[0].isVisible).toBe(true);
    });

    it('preserves an order-only subtitle replacement past the canonical legacy planner', () => {
        const first = { id: 'subtitle_a', startTime: 0, endTime: 1, text: 'A' };
        const second = { id: 'subtitle_b', startTime: 1, endTime: 2, text: 'B' };
        const track = createSubtitleTrackV4Fixture({
            id: 'subtitle_track',
            subtitles: [first, second],
        });
        const document = createEditorDocumentV4Fixture({
            narrative: null,
            subtitleTracks: [track],
            activeSubtitleTrackId: track.id,
        });
        useTimelineStore.getState().hydrateEditorDocument(document);
        const enqueueOperations = vi.fn((_, options) => options.compatibilityResult);
        setStandaloneEditorEngineBridge(bridge({ enqueueOperations }));

        useTimelineStore.getState().setTracks([{
            ...track,
            subtitles: [second, first],
        }]);

        expect(enqueueOperations).toHaveBeenCalledOnce();
        expect(enqueueOperations.mock.calls[0][0]).toMatchObject([{
            type: 'subtitle.set-order',
            payload: {
                trackId: track.id,
                subtitleId: 'subtitle_a',
                afterId: 'subtitle_b',
            },
        }]);
        expect(useTimelineStore.getState().tracks[0].subtitles.map((subtitle) => subtitle.id))
            .toEqual(['subtitle_a', 'subtitle_b']);
    });
});

function bridge(
    overrides: Partial<StandaloneEditorEngineBridge>,
): StandaloneEditorEngineBridge {
    return {
        getSnapshot: vi.fn(),
        enqueueOperations: vi.fn((_, options) => options.compatibilityResult),
        dispatchOperations: vi.fn(async (_, options) => options.compatibilityResult),
        reportUnsupported: vi.fn(),
        flush: vi.fn(async () => undefined),
        retryLastFailure: vi.fn(async () => false),
        undo: vi.fn(async () => undefined),
        redo: vi.fn(async () => undefined),
        jumpToHistory: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        ...overrides,
    } as StandaloneEditorEngineBridge;
}
