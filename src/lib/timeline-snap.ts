import type {
    AudioClip,
    AudioSourceDescriptor,
    AudioTrack,
    RationalFrameRate,
    VideoClip,
    VideoSourceDescriptorV3,
} from '@/types/video';
import {
    frameToOutputSample,
    nativeBoundaryToOutputSample,
    outputSampleToCoveringFrame,
} from './audio-timebase';
import { secondsToFrames } from './render-profile';
import { buildClipPlacements } from './video-timeline';

export const TIMELINE_SNAP_THRESHOLD_PIXELS = 15;

export interface TimelineSnapPoint {
    frame: number;
    ownerKey: string;
}

export interface TimelineSnapResult {
    frame: number;
    snappedFrame: number | null;
}

/**
 * Resolves the visible output-frame span for either independent-audio source domain. Keeping this
 * conversion beside snapping prevents rulers, subtitles, and clips from disagreeing about where an
 * imported audio clip ends after native samples have been projected onto the project frame grid.
 */
export function getAudioClipDurationFrames(
    clip: AudioClip,
    frameRate: RationalFrameRate,
    videoSources: readonly VideoSourceDescriptorV3[],
    audioSources: readonly AudioSourceDescriptor[],
): number | null {
    if ('sourceStart' in clip) {
        const source = videoSources.find((candidate) => candidate.id === clip.source.videoSourceId);
        if (!source?.hasAudio) return null;
        return Math.max(1, secondsToFrames(clip.sourceEnd - clip.sourceStart, frameRate, 'nearest'));
    }

    const source = audioSources.find((candidate) => candidate.id === clip.source.audioSourceId);
    if (!source) return null;
    const outputStart = frameToOutputSample(clip.timelineStartFrame, frameRate);
    if (clip.timelineDurationSamples !== undefined
        && (!Number.isSafeInteger(clip.timelineDurationSamples) || clip.timelineDurationSamples <= 0)) {
        return null;
    }
    const outputDuration = clip.timelineDurationSamples ?? (
        nativeBoundaryToOutputSample(clip.sourceEndSample, source.nativeSampleRate)
        - nativeBoundaryToOutputSample(clip.sourceStartSample, source.nativeSampleRate)
    );
    return Math.max(
        1,
        outputSampleToCoveringFrame(outputStart + outputDuration, frameRate) - clip.timelineStartFrame,
    );
}

/** Returns both edges of every valid independent audio clip as shared timeline snap targets. */
export function buildAudioClipSnapPoints(
    tracks: readonly AudioTrack[],
    frameRate: RationalFrameRate,
    videoSources: readonly VideoSourceDescriptorV3[],
    audioSources: readonly AudioSourceDescriptor[],
): TimelineSnapPoint[] {
    return tracks.flatMap((track) => track.clips.flatMap((clip) => {
        const durationFrames = getAudioClipDurationFrames(clip, frameRate, videoSources, audioSources);
        if (durationFrames === null) return [];
        const ownerKey = `audio:${clip.id}`;
        return [
            { frame: clip.timelineStartFrame, ownerKey },
            { frame: clip.timelineStartFrame + durationFrames, ownerKey },
        ];
    }));
}

/** Projects sequential video crops onto the same canonical frame grid used by preview/export. */
export function buildVideoClipSnapPoints(
    clips: readonly VideoClip[],
    frameRate: RationalFrameRate,
): TimelineSnapPoint[] {
    return buildClipPlacements(clips, frameRate).flatMap((placement) => {
        const ownerKey = `video:${placement.clip.id}`;
        return [
            {
                frame: secondsToFrames(placement.projectStart, frameRate, 'nearest'),
                ownerKey,
            },
            {
                frame: secondsToFrames(placement.projectEnd, frameRate, 'nearest'),
                ownerKey,
            },
        ];
    });
}

/** Converts the shared pixel tolerance to the integer frame domain used by media clips. */
export function getTimelineSnapThresholdFrames(
    pixelsPerSecond: number,
    frameRate: RationalFrameRate,
): number {
    const fps = frameRate.numerator / frameRate.denominator;
    if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0 || !Number.isFinite(fps) || fps <= 0) {
        return 0;
    }
    // Flooring keeps the frame-domain tolerance at or below the advertised pixel threshold.
    // At extreme zoom levels zero is intentional: exact frame alignment still snaps, while the
    // neighboring frame remains independently selectable instead of feeling magnetically locked.
    return Math.max(0, Math.floor(TIMELINE_SNAP_THRESHOLD_PIXELS / pixelsPerSecond * fps));
}

export function snapTimelineFrame(
    candidateFrame: number,
    points: readonly TimelineSnapPoint[],
    thresholdFrames: number,
    excludedOwnerKey?: string,
): TimelineSnapResult {
    let snappedFrame: number | null = null;
    let closestDistance = Math.max(0, thresholdFrames) + 1;

    points.forEach((point) => {
        if (point.ownerKey === excludedOwnerKey || !Number.isSafeInteger(point.frame)) return;
        const distance = Math.abs(candidateFrame - point.frame);
        if (distance > thresholdFrames || distance >= closestDistance) return;
        closestDistance = distance;
        snappedFrame = point.frame;
    });

    return {
        frame: snappedFrame ?? candidateFrame,
        snappedFrame,
    };
}

/** Snaps either edge of a moving clip while preserving its duration and non-negative position. */
export function snapTimelineSpan(
    startFrame: number,
    durationFrames: number,
    points: readonly TimelineSnapPoint[],
    thresholdFrames: number,
    excludedOwnerKey?: string,
): TimelineSnapResult {
    const startResult = snapTimelineFrame(startFrame, points, thresholdFrames, excludedOwnerKey);
    const endFrame = startFrame + durationFrames;
    const endResult = snapTimelineFrame(endFrame, points, thresholdFrames, excludedOwnerKey);
    const startDistance = startResult.snappedFrame === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(startFrame - startResult.snappedFrame);
    const endDistance = endResult.snappedFrame === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(endFrame - endResult.snappedFrame);
    const endAlignedStart = endResult.snappedFrame === null
        ? startFrame
        : endResult.snappedFrame - durationFrames;

    if (endDistance < startDistance && endAlignedStart >= 0) {
        return { frame: endAlignedStart, snappedFrame: endResult.snappedFrame };
    }
    if (startResult.snappedFrame !== null) return startResult;
    if (endResult.snappedFrame !== null && endAlignedStart >= 0) {
        return { frame: endAlignedStart, snappedFrame: endResult.snappedFrame };
    }
    return { frame: startFrame, snappedFrame: null };
}

/**
 * Snaps a moving span whose output-frame duration can change with its start frame. Imported audio
 * lives in a native-sample crop domain, so projecting the same samples at a different 29.97-fps
 * boundary can add or remove one covering frame. Searching the small frame tolerance guarantees
 * that preview geometry, collision validation, and the eventual store commit share the same end.
 */
export function snapTimelineVariableSpan(
    startFrame: number,
    resolveDurationFrames: (candidateStartFrame: number) => number,
    points: readonly TimelineSnapPoint[],
    thresholdFrames: number,
    excludedOwnerKey?: string,
): TimelineSnapResult {
    const safeThreshold = Math.max(0, Math.floor(thresholdFrames));
    const candidates: number[] = [startFrame];
    for (let distance = 1; distance <= safeThreshold; distance += 1) {
        if (startFrame - distance >= 0) candidates.push(startFrame - distance);
        candidates.push(startFrame + distance);
    }

    for (const candidateStart of candidates) {
        const durationFrames = Math.max(1, Math.round(resolveDurationFrames(candidateStart)));
        const candidateEnd = candidateStart + durationFrames;
        const point = points.find((candidatePoint) => (
            candidatePoint.ownerKey !== excludedOwnerKey
            && Number.isSafeInteger(candidatePoint.frame)
            && (candidatePoint.frame === candidateStart || candidatePoint.frame === candidateEnd)
        ));
        if (point) return { frame: candidateStart, snappedFrame: point.frame };
    }

    return { frame: startFrame, snappedFrame: null };
}
