'use client';

import { useEffect, useRef } from 'react';
import { buildAudioMixPlan } from '@/lib/audio-mix-plan';
import { frameToOutputSample } from '@/lib/audio-timebase';
import { createTimelineAudioEngine } from '@/lib/timeline-audio-engine';
import { secondsToFrames } from '@/lib/render-profile';
import { getTimelineContentEndFrame } from '@/lib/video-timeline';
import { usePlaybackStore, type PlaybackClockDriver } from '@/stores/playback-store';
import { useProjectStore } from '@/stores/project-store';
import { useTimelineStore } from '@/stores/timeline-store';
import type {
    TimelineAudioEngineCallbacks,
    TimelineAudioEnginePort,
} from '@/types/timeline-audio-engine';
import type { RationalFrameRate } from '@/types/video';

/**
 * Creates the project-scoped callbacks that bridge the sample clock back into editor state.
 *
 * Keeping this boundary explicit makes failure ownership testable: startup failures are returned
 * through `driver.play()`, while asynchronous decode/refill failures arrive through `onError` and
 * must also stop the Zustand transport so the UI cannot remain frozen in a playing state.
 */
export function createTimelineAudioEngineCallbacks(
    isActive: () => boolean,
): TimelineAudioEngineCallbacks {
    return {
        onClock: (event) => {
            if (!isActive() || !event.playing) return;
            // The engine already rejects stale worklet generations. The project-local active
            // flag additionally prevents a closing editor from publishing one final callback.
            usePlaybackStore.getState().publishExternalClock(event.timeSeconds);
        },
        onUnderrun: (event) => {
            if (!isActive()) return;
            console.warn(
                `Timeline audio underrun at sample ${event.outputSample} (${event.missingSampleCount} samples missing).`,
            );
        },
        onError: (error) => {
            if (!isActive()) return;
            console.error('Timeline audio engine error:', error);
            // The engine has already stopped its worklet transport before reporting an async
            // scheduler failure. Mirror that terminal state in the editor store and release
            // external-clock ownership; otherwise the play button remains active on a frozen UI.
            usePlaybackStore.getState().pause();
        },
    };
}

/**
 * Installs the one browser audio engine owned by an editor instance.
 *
 * AudioContext creation remains deferred inside `engine.play()`. Registering the transport driver
 * here is therefore safe during React effects, while the actual context construction still starts
 * synchronously from the user's play action and satisfies browser autoplay rules.
 */
export function useTimelineAudioEngine(): void {
    const projectId = useProjectStore((state) => state.activeProject?.id ?? null);
    const revision = useTimelineStore((state) => state.revision);
    const audioGraphRevision = useTimelineStore((state) => state.audioGraphRevision);
    const engineRef = useRef<TimelineAudioEnginePort | null>(null);
    const frameRateRef = useRef<RationalFrameRate>({ numerator: 30, denominator: 1 });
    const appliedSnapshotKeyRef = useRef<string | null>(null);

    useEffect(() => {
        if (!projectId) return;
        let active = true;
        const engine = createTimelineAudioEngine(
            createTimelineAudioEngineCallbacks(() => active),
        );
        engineRef.current = engine;

        const driver: PlaybackClockDriver = {
            hasAudibleContributors: () => engine.hasAudibleContributors(),
            play: () => engine.play(),
            pause: () => engine.pause(),
            seek: (timeSeconds) => engine.seek(frameToOutputSample(
                secondsToFrames(Math.max(0, timeSeconds), frameRateRef.current, 'nearest'),
                frameRateRef.current,
            )),
            setPlaybackRate: (speed) => engine.setPlaybackRate(speed),
            setMasterGain: (gainLinear) => engine.setMasterGain(gainLinear),
        };

        const timeline = useTimelineStore.getState();
        const document = timeline.buildEditorDocument();
        const contentEndFrame = getTimelineContentEndFrame(
            document.videoClips,
            document.subtitleTracks,
            {
                audioTracks: document.audioTracks,
                videoSources: document.videoSources,
                audioSources: document.audioSources,
                renderProfile: document.renderProfile,
            },
        );
        frameRateRef.current = document.renderProfile.fps;
        engine.setSnapshot({
            documentRevision: document.revision,
            audioGraphRevision: document.audioGraphRevision,
            document,
            mixPlan: buildAudioMixPlan(document),
            contentEndSample: frameToOutputSample(contentEndFrame, document.renderProfile.fps),
        });
        appliedSnapshotKeyRef.current = `${projectId}:${document.revision}:${document.audioGraphRevision}`;
        usePlaybackStore.getState().setClockDriver(driver);

        return () => {
            active = false;
            if (engineRef.current === engine) engineRef.current = null;
            appliedSnapshotKeyRef.current = null;
            usePlaybackStore.getState().setClockDriver(null);
            void engine.destroy().catch((error) => {
                console.error('Failed to release the timeline audio engine:', error);
            });
        };
    }, [projectId]);

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine || !projectId) return;
        const timeline = useTimelineStore.getState();
        const document = timeline.buildEditorDocument();
        const snapshotKey = `${projectId}:${document.revision}:${document.audioGraphRevision}`;
        if (snapshotKey === appliedSnapshotKeyRef.current) return;

        const contentEndFrame = getTimelineContentEndFrame(
            document.videoClips,
            document.subtitleTracks,
            {
                audioTracks: document.audioTracks,
                videoSources: document.videoSources,
                audioSources: document.audioSources,
                renderProfile: document.renderProfile,
            },
        );
        frameRateRef.current = document.renderProfile.fps;
        engine.setSnapshot({
            documentRevision: document.revision,
            audioGraphRevision: document.audioGraphRevision,
            document,
            mixPlan: buildAudioMixPlan(document),
            contentEndSample: frameToOutputSample(contentEndFrame, document.renderProfile.fps),
        });
        const playback = usePlaybackStore.getState();
        engine.seek(frameToOutputSample(
            secondsToFrames(playback.currentTime, document.renderProfile.fps, 'nearest'),
            document.renderProfile.fps,
        ));
        appliedSnapshotKeyRef.current = snapshotKey;
        playback.refreshClockDriver();
    }, [audioGraphRevision, projectId, revision]);
}
