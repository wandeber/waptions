import {
    buildTimelineAudioRuntimeSnapshot,
    type TimelineAudioRuntimeDocumentInput,
} from '@/lib/audio-runtime-projection';
import { frameToOutputSample } from '@/lib/audio-timebase';
import { secondsToFrames } from '@/lib/render-profile';
import { getTimelineContentEndFrame } from '@/lib/video-timeline';
import type { TimelineStore } from '@/stores/timeline-store-types';
import type {
    TimelineAudioEnginePort,
    TimelineAudioEngineSnapshot,
} from '@/types/timeline-audio-engine';
import type { RationalFrameRate } from '@/types/video';

export interface TimelineAudioRuntimeInputs extends TimelineAudioRuntimeDocumentInput {
    /** Subtitle lanes affect preview only through their exact terminal frame. */
    contentEndFrame: number;
}

type TimelineAudioRuntimeState = Pick<
    TimelineStore,
    | 'renderProfile'
    | 'videoSources'
    | 'videoClips'
    | 'audioSources'
    | 'audioTracks'
    | 'tracks'
    | 'contentBoundaryRevision'
>;

export type TimelineAudioSnapshotProjector = (
    document: TimelineAudioRuntimeDocumentInput,
    contentEndSample: number,
) => TimelineAudioEngineSnapshot;

export interface TimelineAudioRuntimeSyncResult {
    frameRate: RationalFrameRate;
}

type TimelineContentEndFrameCalculator = (
    state: TimelineAudioRuntimeState,
) => number;

const calculateTimelineContentEndFrame: TimelineContentEndFrameCalculator = (state) => (
    getTimelineContentEndFrame(
        state.videoClips,
        state.tracks,
        {
            audioTracks: state.audioTracks,
            videoSources: state.videoSources,
            audioSources: state.audioSources,
            renderProfile: state.renderProfile,
        },
    )
);

/**
 * Selects only references that can change decoded audio plus the scalar content boundary.
 *
 * Zustand's shallow selector can therefore discard subtitle text, style, name, selection, and
 * provenance updates before React renders the audio hook. Computing the boundary remains exact
 * because it delegates to the same frame-domain function used by duration and export.
 */
export function selectTimelineAudioRuntimeInputs(
    state: TimelineAudioRuntimeState,
): TimelineAudioRuntimeInputs {
    return {
        renderProfile: state.renderProfile,
        videoSources: state.videoSources,
        videoClips: state.videoClips,
        audioSources: state.audioSources,
        audioTracks: state.audioTracks,
        contentEndFrame: calculateTimelineContentEndFrame(state),
    };
}

/**
 * Creates the stable semantic selector consumed by one editor hook instance.
 *
 * Zustand invokes selectors for every store update, including every text keystroke. The store's
 * boundary revision changes only for temporal/structural commands, so metadata and mix updates can
 * reuse the cached scalar without walking subtitle cues or media clips.
 */
export function createTimelineAudioRuntimeInputsSelector(
    calculateContentEndFrame: TimelineContentEndFrameCalculator = calculateTimelineContentEndFrame,
): (
    state: TimelineAudioRuntimeState,
) => TimelineAudioRuntimeInputs {
    let previousState: TimelineAudioRuntimeState | null = null;
    let previousInputs: TimelineAudioRuntimeInputs | null = null;
    return (state) => {
        const canReuseContentBoundary = previousState?.contentBoundaryRevision
            === state.contentBoundaryRevision;
        if (previousState
            && canReuseContentBoundary
            && previousState.renderProfile === state.renderProfile
            && previousState.videoSources === state.videoSources
            && previousState.videoClips === state.videoClips
            && previousState.audioSources === state.audioSources
            && previousState.audioTracks === state.audioTracks) {
            return previousInputs!;
        }
        const inputs: TimelineAudioRuntimeInputs = {
            renderProfile: state.renderProfile,
            videoSources: state.videoSources,
            videoClips: state.videoClips,
            audioSources: state.audioSources,
            audioTracks: state.audioTracks,
            contentEndFrame: canReuseContentBoundary
                ? previousInputs!.contentEndFrame
                : calculateContentEndFrame(state),
        };
        previousState = state;
        if (previousInputs && haveEqualTimelineAudioRuntimeInputs(previousInputs, inputs)) {
            return previousInputs;
        }
        previousInputs = inputs;
        return inputs;
    };
}

export function haveEqualTimelineAudioRuntimeInputs(
    left: TimelineAudioRuntimeInputs,
    right: TimelineAudioRuntimeInputs,
): boolean {
    return left.renderProfile === right.renderProfile
        && left.videoSources === right.videoSources
        && left.videoClips === right.videoClips
        && left.audioSources === right.audioSources
        && left.audioTracks === right.audioTracks
        && left.contentEndFrame === right.contentEndFrame;
}

/**
 * Applies one shallow media snapshot and skips projection before any document-shaped object exists.
 *
 * The optional projector is a narrow deterministic seam used to prove that mounting twice or
 * changing non-audio metadata performs zero mix/source projection work.
 */
export function synchronizeTimelineAudioRuntime(
    engine: TimelineAudioEnginePort,
    previous: TimelineAudioRuntimeInputs | null,
    current: TimelineAudioRuntimeInputs,
    playheadSeconds: number,
    projector: TimelineAudioSnapshotProjector = buildTimelineAudioRuntimeSnapshot,
): TimelineAudioRuntimeSyncResult | null {
    if (previous && haveEqualTimelineAudioRuntimeInputs(previous, current)) return null;

    const document: TimelineAudioRuntimeDocumentInput = {
        renderProfile: current.renderProfile,
        videoSources: current.videoSources,
        videoClips: current.videoClips,
        audioSources: current.audioSources,
        audioTracks: current.audioTracks,
    };
    const snapshot = projector(
        document,
        frameToOutputSample(current.contentEndFrame, current.renderProfile.fps),
    );
    engine.applySnapshot(snapshot, frameToOutputSample(
        secondsToFrames(Math.max(0, playheadSeconds), current.renderProfile.fps, 'nearest'),
        current.renderProfile.fps,
    ));
    return { frameRate: current.renderProfile.fps };
}
