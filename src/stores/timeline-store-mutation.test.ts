import { describe, expect, it, vi } from 'vitest';
import { getEditorAudioGraphSignature } from '@/lib/audio-graph-signature';
import type { AnimationStyle } from '@/types/timeline';
import type { TimelineStore } from './timeline-store-types';
import { useTimelineStore } from './timeline-store';
import { buildEditorDocumentFromState } from './timeline-store-snapshot';
import { prepareDurableTimelineMutation } from './timeline-store-mutation';

const stateFixture = (): TimelineStore => {
    const state = {
        ...useTimelineStore.getState(),
        revision: 5,
        audioGraphRevision: 2,
        contentBoundaryRevision: 4,
        history: [],
        redoStack: [],
        tracks: [{
            id: 'captions',
            name: 'Captions',
            style: {} as AnimationStyle,
            subtitles: [],
            isVisible: true,
            isLocked: false,
        }],
        activeTrackId: 'captions',
        videoSources: [{
            id: 'video_source',
            originalName: 'video.mp4',
            mimeType: 'video/mp4',
            size: 100,
            lastModified: 1,
            fingerprint: 'video-fingerprint',
            duration: 2,
            fps: 30,
            width: 1920,
            height: 1080,
            bitrate: null,
            hasAudio: true,
            file: {} as File,
        }],
        videoClips: [{
            id: 'video_clip',
            sourceId: 'video_source',
            sourceStart: 0,
            sourceEnd: 2,
            audio: {
                linkState: 'linked' as const,
                muted: false,
                gainDb: 0,
                fadeInFrames: 0,
                fadeOutFrames: 0,
            },
        }],
        videoTracks: [{ id: 'video_track_1', name: 'Video 1', clipIds: ['video_clip'] }],
    } satisfies TimelineStore;
    const signature = getEditorAudioGraphSignature(buildEditorDocumentFromState(state));
    return {
        ...state,
        transcriptionByTrackId: {
            captions: {
                raw: [],
                groups: {},
                containerIds: [],
                sourceDocumentRevision: state.revision,
                sourceAudioGraphRevision: state.audioGraphRevision,
                sourceAudioGraphSignature: signature,
                stale: false,
            },
        },
    };
};

describe('durable timeline mutation preparation', () => {
    it('drops transient-only and structurally shared no-op patches before history or revisions are consumed', () => {
        const state = stateFixture();

        expect(prepareDurableTimelineMutation(state, {
            transientSelection: { kind: 'video-clip', clipId: 'video_clip' },
            selectedClipId: 'video_clip',
        })).toBeNull();
        expect(prepareDurableTimelineMutation(state, {
            tracks: state.tracks,
        })).toBeNull();
        expect(prepareDurableTimelineMutation(state, {
            tracks: structuredClone(state.tracks),
        }, { history: { label: 'Replace subtitle tracks' } })).toBeNull();
    });

    it('does not stringify or traverse a large unchanged subtitle graph in the durable hot path', () => {
        const state = stateFixture();
        state.tracks = Array.from({ length: 500 }, (_unused, trackIndex) => ({
            ...state.tracks[0],
            id: `track_${trackIndex}`,
            subtitles: Array.from({ length: 100 }, (_entry, subtitleIndex) => ({
                id: `subtitle_${trackIndex}_${subtitleIndex}`,
                startTime: subtitleIndex,
                endTime: subtitleIndex + 1,
                text: 'Unchanged',
            })),
        }));
        const stringify = vi.spyOn(JSON, 'stringify');

        expect(prepareDurableTimelineMutation(state, { tracks: state.tracks })).toBeNull();
        expect(stringify).not.toHaveBeenCalled();
        stringify.mockRestore();
    });

    it('records one history entry and one revision for a durable render-profile command', () => {
        const state = stateFixture();
        const prepared = prepareDurableTimelineMutation(state, {
            renderProfile: { ...state.renderProfile, width: 1280 },
        }, { history: { label: 'Resize canvas' } });

        expect(prepared).toMatchObject({
            revision: 6,
            history: [{ audioGraphMutationImpact: 'preserve-transcription' }],
            redoStack: [],
            renderProfile: { width: 1280 },
        });
        expect(state.revision).toBe(5);
        expect(state.history).toEqual([]);
    });

    it('derives the runtime FPS mirror only from a changed canonical render profile', () => {
        const state = stateFixture();
        const prepared = prepareDurableTimelineMutation(state, {
            renderProfile: {
                ...state.renderProfile,
                fps: { numerator: 24_000, denominator: 1_001 },
            },
        }, { history: { label: 'Change frame rate' } });

        expect(prepared).toMatchObject({
            projectFps: 24_000 / 1_001,
            renderProfile: { fps: { numerator: 24_000, denominator: 1_001 } },
        });
        expect(prepareDurableTimelineMutation(state, { projectFps: 24 })).toBeNull();
    });

    it('applies audio provenance semantics atomically with an audible graph mutation', () => {
        const state = stateFixture();
        const prepared = prepareDurableTimelineMutation(state, {
            videoClips: state.videoClips.map((clip) => ({
                ...clip,
                audio: clip.audio ? { ...clip.audio, muted: true } : null,
            })),
        }, {
            history: { label: 'Mute embedded audio' },
            impact: 'invalidate-transcription',
        });

        expect(prepared).toMatchObject({
            revision: 6,
            audioGraphRevision: 3,
            transcriptionByTrackId: { captions: { stale: true } },
            history: [{ audioGraphMutationImpact: 'invalidate-transcription' }],
        });
    });

    it('can finalize a durable command without adding history for compatibility callers', () => {
        const state = stateFixture();
        const prepared = prepareDurableTimelineMutation(state, {
            activeTrackId: null,
        }, { recordHistory: false });

        expect(prepared).toMatchObject({ revision: 6, activeTrackId: null });
        expect(prepared).not.toHaveProperty('history');
    });
});
