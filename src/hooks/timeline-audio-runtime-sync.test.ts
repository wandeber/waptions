import { describe, expect, it, vi } from 'vitest';
import { buildTimelineAudioRuntimeSnapshot } from '@/lib/audio-runtime-projection';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import type { AnimationStyle } from '@/types/timeline';
import type { TimelineAudioEnginePort } from '@/types/timeline-audio-engine';
import {
    createTimelineAudioRuntimeInputsSelector,
    haveEqualTimelineAudioRuntimeInputs,
    selectTimelineAudioRuntimeInputs,
    synchronizeTimelineAudioRuntime,
} from './timeline-audio-runtime-sync';

type RuntimeState = Parameters<typeof selectTimelineAudioRuntimeInputs>[0];

function makeRuntimeState() {
    const file = new File(['video'], 'video.webm', { type: 'video/webm' });
    return {
        renderProfile: createDefaultRenderProfile({
            fps: { numerator: 30, denominator: 1 },
            isFrameRateLocked: true,
            isCanvasSizeLocked: true,
        }),
        contentBoundaryRevision: 1,
        tracks: [{
            id: 'captions',
            name: 'Captions',
            style: {} as AnimationStyle,
            subtitles: [{ id: 'subtitle', startTime: 0, endTime: 1, text: 'Before' }],
            isVisible: true,
            isLocked: false,
        }],
        videoSources: [{
            id: 'video', originalName: 'video.webm', mimeType: 'video/webm', size: file.size,
            lastModified: 1, fingerprint: 'video-v1', duration: 2, fps: 30, width: 320,
            height: 180, bitrate: null, hasAudio: true, file,
        }],
        videoClips: [{
            id: 'clip', sourceId: 'video', sourceStart: 0, sourceEnd: 2,
            audio: {
                linkState: 'linked' as const,
                muted: false,
                gainDb: 0,
                fadeInFrames: 0,
                fadeOutFrames: 0,
            },
        }],
        videoTracks: [{ id: 'video_track_1', name: 'Video 1', clipIds: ['clip'] }],
        audioSources: [],
        audioTracks: [],
    };
}

function makeEngine(): TimelineAudioEnginePort {
    return {
        applySnapshot: vi.fn(),
        play: vi.fn(async () => undefined),
        pause: vi.fn(),
        seek: vi.fn(),
        setPlaybackRate: vi.fn(),
        setMasterGain: vi.fn(),
        setTransientOverride: vi.fn(),
        hasAudibleContributors: vi.fn(() => true),
        destroy: vi.fn(async () => undefined),
    };
}

describe('timeline audio runtime synchronization', () => {
    it('projects an empty transitional Timeline graph before building the V4 audio snapshot', () => {
        const state = {
            ...makeRuntimeState(),
            tracks: [],
            videoSources: [],
            videoClips: [],
            videoTracks: [{
                id: 'video_track_1',
                name: 'Video 1',
                visible: true,
                locked: false,
                clipIds: [],
            }],
        };
        const inputs = selectTimelineAudioRuntimeInputs(state);
        const engine = makeEngine();

        synchronizeTimelineAudioRuntime(engine, null, inputs, 0);

        const snapshot = vi.mocked(engine.applySnapshot).mock.calls[0][0];
        expect(snapshot.document.videoTracks).toEqual([{
            id: 'video_track_1',
            name: 'Video 1',
            visible: true,
            locked: false,
        }]);
        expect(snapshot.mixPlan).toMatchObject({
            totalSampleCount: 0,
            videoSampleCount: 0,
            contributors: [],
        });
    });

    it('does zero snapshot projection for the duplicate mount effect or subtitle metadata', () => {
        const state = makeRuntimeState();
        const boundaryCalculator = vi.fn((runtimeState: RuntimeState) => (
            selectTimelineAudioRuntimeInputs(runtimeState).contentEndFrame
        ));
        const selector = createTimelineAudioRuntimeInputsSelector(boundaryCalculator);
        const initialInputs = selector(state);
        const engine = makeEngine();
        const projector = vi.fn(buildTimelineAudioRuntimeSnapshot);

        synchronizeTimelineAudioRuntime(engine, null, initialInputs, 0, projector);
        synchronizeTimelineAudioRuntime(engine, initialInputs, initialInputs, 0, projector);

        let metadataInputs = initialInputs;
        for (let edit = 0; edit < 50; edit += 1) {
            metadataInputs = selector({
                ...state,
                tracks: [{
                    ...state.tracks[0],
                    name: `Renamed captions ${edit}`,
                    style: { ...state.tracks[0].style, textColor: `#${edit}` },
                    subtitles: [{ ...state.tracks[0].subtitles[0], text: `After ${edit}` }],
                }],
            });
        }
        expect(metadataInputs).toBe(initialInputs);
        expect(haveEqualTimelineAudioRuntimeInputs(initialInputs, metadataInputs)).toBe(true);
        synchronizeTimelineAudioRuntime(engine, initialInputs, metadataInputs, 0, projector);

        expect(boundaryCalculator).toHaveBeenCalledOnce();
        expect(projector).toHaveBeenCalledOnce();
        expect(engine.applySnapshot).toHaveBeenCalledOnce();
    });

    it('recalculates exact boundaries only for timing add, remove, and resize mutations', () => {
        const state = makeRuntimeState();
        const boundaryCalculator = vi.fn((runtimeState: RuntimeState) => (
            selectTimelineAudioRuntimeInputs(runtimeState).contentEndFrame
        ));
        const selector = createTimelineAudioRuntimeInputsSelector(boundaryCalculator);
        const initialInputs = selector(state);
        const engine = makeEngine();
        synchronizeTimelineAudioRuntime(engine, null, initialInputs, 0);
        const initialSnapshot = vi.mocked(engine.applySnapshot).mock.calls[0][0];

        const resizedState = {
            ...state,
            contentBoundaryRevision: 2,
            tracks: [{
                ...state.tracks[0],
                subtitles: [{ ...state.tracks[0].subtitles[0], endTime: 3 }],
            }],
        };
        const resizedInputs = selector(resizedState);
        expect(resizedInputs.contentEndFrame).toBe(90);

        const addedState = {
            ...resizedState,
            contentBoundaryRevision: 3,
            tracks: [{
                ...resizedState.tracks[0],
                subtitles: [
                    ...resizedState.tracks[0].subtitles,
                    { id: 'added', startTime: 3, endTime: 4, text: 'Added' },
                ],
            }],
        };
        expect(selector(addedState).contentEndFrame).toBe(120);

        const removedState = {
            ...addedState,
            contentBoundaryRevision: 4,
            tracks: [{ ...addedState.tracks[0], subtitles: [] }],
        };
        const removedInputs = selector(removedState);
        expect(removedInputs.contentEndFrame).toBe(60);
        expect(boundaryCalculator).toHaveBeenCalledTimes(4);

        synchronizeTimelineAudioRuntime(engine, initialInputs, resizedInputs, 0);
        const extendedSnapshot = vi.mocked(engine.applySnapshot).mock.calls[1][0];
        expect(extendedSnapshot.contentEndSample).toBe(144_000);
        expect(extendedSnapshot.audibleMixKey).toBe(initialSnapshot.audibleMixKey);

        const gainInputs = selector({
            ...removedState,
            videoClips: [{
                ...state.videoClips[0],
                audio: { ...state.videoClips[0].audio!, gainDb: -6 },
            }],
        });
        expect(boundaryCalculator).toHaveBeenCalledTimes(4);
        synchronizeTimelineAudioRuntime(engine, resizedInputs, gainInputs, 0);
        const gainSnapshot = vi.mocked(engine.applySnapshot).mock.calls[2][0];
        expect(gainSnapshot.contentEndSample).toBe(96_000);
        expect(gainSnapshot.audibleMixKey).not.toBe(initialSnapshot.audibleMixKey);
    });
});
