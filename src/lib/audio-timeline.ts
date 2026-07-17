import type {
    AudioClip,
    AudioClipMixSettings,
    AudioSourceDescriptor,
    AudioTrack,
    ImportedAudioClip,
    RationalFrameRate,
    RenderProfile,
    VideoSourceAudioClip,
    VideoSourceDescriptorV3,
} from '@/types/video';
import {
    frameToOutputSample,
    nativeBoundaryToOutputSample,
    outputSampleToCoveringFrame,
    outputSampleToFloorNativeBoundary,
} from './audio-timebase';
import { framesToSeconds, secondsToFrames } from './render-profile';

export const MIN_AUDIO_GAIN_DB = -60;
export const MAX_AUDIO_GAIN_DB = 12;

export interface AudioTimelineSources {
    videoSources: readonly VideoSourceDescriptorV3[];
    audioSources: readonly AudioSourceDescriptor[];
}

export type ResolvedAudioClipSource =
    | { kind: 'video-source-audio'; descriptor: VideoSourceDescriptorV3 }
    | { kind: 'audio-source'; descriptor: AudioSourceDescriptor };

export interface LocatedAudioClip {
    trackIndex: number;
    clipIndex: number;
    track: AudioTrack;
    clip: AudioClip;
    source: ResolvedAudioClipSource;
}

export interface AudioClipOutputInterval {
    startSample: number;
    endSample: number;
}

export function cloneAudioTracks(tracks: readonly AudioTrack[]): AudioTrack[] {
    return tracks.map((track) => ({
        ...track,
        clips: track.clips.map(cloneAudioClip),
    }));
}

export function findAudioClip(
    tracks: readonly AudioTrack[],
    sources: AudioTimelineSources,
    clipId: string,
): LocatedAudioClip | null {
    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
        const track = tracks[trackIndex];
        const clipIndex = track.clips.findIndex((clip) => clip.id === clipId);
        if (clipIndex === -1) continue;
        const clip = track.clips[clipIndex];
        const source = resolveAudioClipSource(clip, sources);
        return source ? { trackIndex, clipIndex, track, clip, source } : null;
    }
    return null;
}

/** Returns the exact rendered output interval, independently from rounded timeline geometry. */
export function getAudioClipOutputInterval(
    clip: AudioClip,
    source: ResolvedAudioClipSource,
    renderProfile: RenderProfile,
): AudioClipOutputInterval {
    const startSample = frameToOutputSample(clip.timelineStartFrame, renderProfile.fps);
    if (isVideoSourceAudioClip(clip)) {
        const frameCount = getCanonicalVideoFrameCount(clip.sourceEnd - clip.sourceStart, renderProfile.fps);
        return {
            startSample,
            endSample: frameToOutputSample(clip.timelineStartFrame + frameCount, renderProfile.fps),
        };
    }
    if (source.kind !== 'audio-source') throw new Error('Imported clip resolved to a video source.');
    if (clip.timelineDurationSamples !== undefined) {
        return {
            startSample,
            endSample: startSample + clip.timelineDurationSamples,
        };
    }
    const durationSamples = nativeBoundaryToOutputSample(
        clip.sourceEndSample,
        source.descriptor.nativeSampleRate,
    ) - nativeBoundaryToOutputSample(clip.sourceStartSample, source.descriptor.nativeSampleRate);
    return { startSample, endSample: startSample + durationSamples };
}

/**
 * Imported fades share the native-sample crop. When a trim makes both fades too long, scaling
 * both by the same ratio preserves the intended envelope balance.
 */
export function clampSampleFades<T extends ImportedAudioClip>(clip: T, sampleCount: number): T {
    const safeSampleCount = Math.max(0, Math.floor(sampleCount));
    let fadeInSamples = clampSafeInteger(clip.fadeInSamples, 0, Number.MAX_SAFE_INTEGER);
    let fadeOutSamples = clampSafeInteger(clip.fadeOutSamples, 0, Number.MAX_SAFE_INTEGER);
    const combined = fadeInSamples + fadeOutSamples;
    if (combined > safeSampleCount && combined > 0) {
        const ratio = safeSampleCount / combined;
        fadeInSamples = Math.floor(fadeInSamples * ratio);
        fadeOutSamples = safeSampleCount - fadeInSamples;
    }
    return { ...clip, fadeInSamples, fadeOutSamples };
}

/** Same proportional fade clamp for detached video audio's integer-frame domain. */
export function clampFrameFades<T extends VideoSourceAudioClip>(clip: T, frameCount: number): T {
    const safeFrameCount = Math.max(0, Math.floor(frameCount));
    let fadeInFrames = clampSafeInteger(clip.fadeInFrames, 0, Number.MAX_SAFE_INTEGER);
    let fadeOutFrames = clampSafeInteger(clip.fadeOutFrames, 0, Number.MAX_SAFE_INTEGER);
    const combined = fadeInFrames + fadeOutFrames;
    if (combined > safeFrameCount && combined > 0) {
        const ratio = safeFrameCount / combined;
        fadeInFrames = Math.floor(fadeInFrames * ratio);
        fadeOutFrames = safeFrameCount - fadeInFrames;
    }
    return { ...clip, fadeInFrames, fadeOutFrames };
}

export function normalizeAudioMixSettings(settings: AudioClipMixSettings): AudioClipMixSettings {
    return {
        muted: Boolean(settings.muted),
        gainDb: clampFinite(settings.gainDb, MIN_AUDIO_GAIN_DB, MAX_AUDIO_GAIN_DB),
    };
}

export function hasAudioTrackCollision(
    track: AudioTrack,
    candidate: AudioClip,
    candidateSource: ResolvedAudioClipSource,
    renderProfile: RenderProfile,
    sources: AudioTimelineSources,
    ignoredClipId?: string,
): boolean {
    const candidateInterval = getAudioClipOutputInterval(candidate, candidateSource, renderProfile);
    return track.clips.some((clip) => {
        if (clip.id === ignoredClipId) return false;
        const existingSource = resolveAudioClipSource(clip, sources);
        if (!existingSource) return true;
        const existingInterval = getAudioClipOutputInterval(clip, existingSource, renderProfile);
        // Half-open output-sample intervals allow clips to touch at one canonical boundary.
        return candidateInterval.startSample < existingInterval.endSample
            && existingInterval.startSample < candidateInterval.endSample;
    });
}

export function moveAudioClipInTracks(
    tracks: readonly AudioTrack[],
    sources: AudioTimelineSources,
    renderProfile: RenderProfile,
    clipId: string,
    targetTrackId: string,
    timelineStartFrame: number,
): AudioTrack[] | null {
    const located = findAudioClip(tracks, sources, clipId);
    const targetTrack = tracks.find((track) => track.id === targetTrackId);
    if (!located || !targetTrack || located.track.locked || targetTrack.locked) return null;

    const snappedStart = Math.max(0, Math.round(timelineStartFrame));
    const candidate = { ...located.clip, timelineStartFrame: snappedStart };
    if (candidate.timelineStartFrame === located.clip.timelineStartFrame && targetTrackId === located.track.id) {
        return null;
    }
    if (hasAudioTrackCollision(targetTrack, candidate, located.source, renderProfile, sources, located.clip.id)) {
        return null;
    }

    return tracks.map((track) => {
        if (track.id === located.track.id && track.id === targetTrackId) {
            return { ...track, clips: track.clips.map((clip) => clip.id === clipId ? candidate : clip).sort(compareAudioClips) };
        }
        if (track.id === located.track.id) return { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) };
        if (track.id === targetTrackId) return { ...track, clips: [...track.clips, candidate].sort(compareAudioClips) };
        return track;
    });
}

export function trimAudioClipInTracks(
    tracks: readonly AudioTrack[],
    sources: AudioTimelineSources,
    renderProfile: RenderProfile,
    clipId: string,
    side: 'left' | 'right',
    timelineFrame: number,
): AudioTrack[] | null {
    const located = findAudioClip(tracks, sources, clipId);
    if (!located || located.track.locked) return null;
    const interval = getAudioClipOutputInterval(located.clip, located.source, renderProfile);
    const durationFrames = getClipFrameCount(located.clip, located.source, renderProfile.fps);
    const startFrame = located.clip.timelineStartFrame;
    const endFrame = startFrame + durationFrames;
    const snappedFrame = Math.round(timelineFrame);

    let candidate: AudioClip;
    if (side === 'left') {
        const nextStartFrame = clampSafeInteger(snappedFrame, startFrame, endFrame - 1);
        if (nextStartFrame === startFrame) return null;
        candidate = trimLeft(located.clip, located.source, renderProfile, interval, nextStartFrame);
    } else {
        const nextEndFrame = clampSafeInteger(snappedFrame, startFrame + 1, endFrame);
        if (nextEndFrame === endFrame) return null;
        candidate = trimRight(located.clip, located.source, renderProfile, interval, nextEndFrame);
    }
    if (isSameCrop(candidate, located.clip)) return null;
    if (hasAudioTrackCollision(located.track, candidate, located.source, renderProfile, sources, located.clip.id)) {
        return null;
    }
    return replaceAudioClip(tracks, located.track.id, clipId, candidate);
}

export function splitAudioClipInTracks(
    tracks: readonly AudioTrack[],
    sources: AudioTimelineSources,
    renderProfile: RenderProfile,
    clipId: string,
    timelineFrame: number,
    rightClipId: string,
): AudioTrack[] | null {
    const located = findAudioClip(tracks, sources, clipId);
    if (!located || located.track.locked || tracks.some((track) => track.clips.some((clip) => clip.id === rightClipId))) {
        return null;
    }
    const durationFrames = getClipFrameCount(located.clip, located.source, renderProfile.fps);
    const splitFrame = Math.round(timelineFrame);
    if (splitFrame <= located.clip.timelineStartFrame || splitFrame >= located.clip.timelineStartFrame + durationFrames) {
        return null;
    }
    const interval = getAudioClipOutputInterval(located.clip, located.source, renderProfile);
    const left = trimRight(located.clip, located.source, renderProfile, interval, splitFrame);
    const rightBase = trimLeft(located.clip, located.source, renderProfile, interval, splitFrame);
    // Opposite stable trim anchors can round one split to adjacent native boundaries. Select the
    // single boundary that minimizes the worst output-duration drift across both children, then
    // apply it symmetrically so the durable source partition has neither a gap nor a duplicate.
    const importedSplit = isImportedAudioClip(left) && isImportedAudioClip(rightBase)
        && located.source.kind === 'audio-source'
        ? alignImportedAudioSplit(left, rightBase, located.source.descriptor.nativeSampleRate)
        : null;
    const alignedLeft = importedSplit?.left ?? left;
    const alignedRightBase = importedSplit?.right ?? rightBase;
    const right = isVideoSourceAudioClip(alignedRightBase)
        ? { ...alignedRightBase, id: rightClipId, fadeInFrames: 0 }
        : { ...alignedRightBase, id: rightClipId, fadeInSamples: 0 };
    const leftWithSplitFade = isVideoSourceAudioClip(alignedLeft)
        ? { ...alignedLeft, fadeOutFrames: 0 }
        : { ...alignedLeft, fadeOutSamples: 0 };

    return tracks.map((track) => track.id === located.track.id
        ? { ...track, clips: track.clips.flatMap((clip) => clip.id === clipId ? [leftWithSplitFade, right] : [clip]).sort(compareAudioClips) }
        : track);
}

export function updateAudioClipMixInTracks(
    tracks: readonly AudioTrack[],
    sources: AudioTimelineSources,
    clipId: string,
    updates: Partial<AudioClipMixSettings>,
): AudioTrack[] | null {
    const located = findAudioClip(tracks, sources, clipId);
    if (!located || located.track.locked) return null;
    const controls = normalizeAudioMixSettings({ ...located.clip, ...updates });
    const candidate = { ...located.clip, ...controls };
    if (areMixSettingsEqual(candidate, located.clip)) return null;
    return replaceAudioClip(tracks, located.track.id, clipId, candidate);
}

function resolveAudioClipSource(clip: AudioClip, sources: AudioTimelineSources): ResolvedAudioClipSource | null {
    if (isVideoSourceAudioClip(clip)) {
        const descriptor = sources.videoSources.find((source) => source.id === clip.source.videoSourceId);
        return descriptor?.hasAudio ? { kind: 'video-source-audio', descriptor } : null;
    }
    const descriptor = sources.audioSources.find((source) => source.id === clip.source.audioSourceId);
    return descriptor ? { kind: 'audio-source', descriptor } : null;
}

function trimLeft(
    clip: AudioClip,
    source: ResolvedAudioClipSource,
    profile: RenderProfile,
    interval: AudioClipOutputInterval,
    nextStartFrame: number,
): AudioClip {
    const removedFrames = nextStartFrame - clip.timelineStartFrame;
    if (isVideoSourceAudioClip(clip)) {
        const nextSourceStart = Math.min(
            clip.sourceEnd,
            clip.sourceStart + framesToSeconds(removedFrames, profile.fps),
        );
        return clampFrameFades({ ...clip, timelineStartFrame: nextStartFrame, sourceStart: nextSourceStart },
            getCanonicalVideoFrameCount(clip.sourceEnd - nextSourceStart, profile.fps));
    }
    if (source.kind !== 'audio-source') throw new Error('Imported clip resolved to a video source.');
    const nextDurationSamples = Math.max(
        1,
        interval.endSample - frameToOutputSample(nextStartFrame, profile.fps),
    );
    // Anchor repeated left trims at the unchanged source end. Re-basing each edit from the already
    // quantized source start would discard its residual phase and accumulate native-boundary drift.
    const targetOutputBoundary = nativeBoundaryToOutputSample(
        clip.sourceEndSample,
        source.descriptor.nativeSampleRate,
    ) - nextDurationSamples;
    const nextSourceStart = Math.min(
        clip.sourceEndSample - 1,
        Math.max(
            clip.sourceStartSample + 1,
            outputSampleToFloorNativeBoundary(targetOutputBoundary, source.descriptor.nativeSampleRate),
        ),
    );
    return clampSampleFades({
        ...clip,
        timelineStartFrame: nextStartFrame,
        timelineDurationSamples: nextDurationSamples,
        sourceStartSample: nextSourceStart,
    },
        clip.sourceEndSample - nextSourceStart);
}

function trimRight(
    clip: AudioClip,
    source: ResolvedAudioClipSource,
    profile: RenderProfile,
    interval: AudioClipOutputInterval,
    nextEndFrame: number,
): AudioClip {
    const keptFrames = nextEndFrame - clip.timelineStartFrame;
    if (isVideoSourceAudioClip(clip)) {
        const nextSourceEnd = Math.max(
            clip.sourceStart,
            Math.min(clip.sourceEnd, clip.sourceStart + framesToSeconds(keptFrames, profile.fps)),
        );
        return clampFrameFades({ ...clip, sourceEnd: nextSourceEnd },
            getCanonicalVideoFrameCount(nextSourceEnd - clip.sourceStart, profile.fps));
    }
    if (source.kind !== 'audio-source') throw new Error('Imported clip resolved to a video source.');
    const targetOutputBoundary = nativeBoundaryToOutputSample(
        clip.sourceStartSample,
        source.descriptor.nativeSampleRate,
    ) + frameToOutputSample(nextEndFrame, profile.fps) - interval.startSample;
    const nextSourceEnd = Math.max(
        clip.sourceStartSample + 1,
        Math.min(
            clip.sourceEndSample,
            outputSampleToFloorNativeBoundary(targetOutputBoundary, source.descriptor.nativeSampleRate),
        ),
    );
    return clampSampleFades({
        ...clip,
        timelineDurationSamples: Math.max(
            1,
            frameToOutputSample(nextEndFrame, profile.fps) - interval.startSample,
        ),
        sourceEndSample: nextSourceEnd,
    }, nextSourceEnd - clip.sourceStartSample);
}

function getClipFrameCount(
    clip: AudioClip,
    source: ResolvedAudioClipSource,
    frameRate: RationalFrameRate,
): number {
    if (isVideoSourceAudioClip(clip)) {
        return getCanonicalVideoFrameCount(clip.sourceEnd - clip.sourceStart, frameRate);
    }
    if (source.kind !== 'audio-source') throw new Error('Imported clip resolved to a video source.');
    const startSample = frameToOutputSample(clip.timelineStartFrame, frameRate);
    const durationSamples = clip.timelineDurationSamples ?? (
        nativeBoundaryToOutputSample(clip.sourceEndSample, source.descriptor.nativeSampleRate)
        - nativeBoundaryToOutputSample(clip.sourceStartSample, source.descriptor.nativeSampleRate)
    );
    const endSample = startSample + durationSamples;
    return outputSampleToCoveringFrame(endSample, frameRate) - clip.timelineStartFrame;
}

function replaceAudioClip(tracks: readonly AudioTrack[], trackId: string, clipId: string, candidate: AudioClip): AudioTrack[] {
    return tracks.map((track) => track.id === trackId
        ? { ...track, clips: track.clips.map((clip) => clip.id === clipId ? candidate : clip).sort(compareAudioClips) }
        : track);
}

function compareAudioClips(left: AudioClip, right: AudioClip): number {
    return left.timelineStartFrame - right.timelineStartFrame || left.id.localeCompare(right.id);
}

function isSameCrop(left: AudioClip, right: AudioClip): boolean {
    if (left.timelineStartFrame !== right.timelineStartFrame || left.source.kind !== right.source.kind) return false;
    return isVideoSourceAudioClip(left) && isVideoSourceAudioClip(right)
        ? left.sourceStart === right.sourceStart && left.sourceEnd === right.sourceEnd
        : isImportedAudioClip(left) && isImportedAudioClip(right)
            && left.sourceStartSample === right.sourceStartSample
            && left.sourceEndSample === right.sourceEndSample
            && left.timelineDurationSamples === right.timelineDurationSamples;
}

function cloneAudioClip(clip: AudioClip): AudioClip {
    return isVideoSourceAudioClip(clip)
        ? { ...clip, source: { ...clip.source } }
        : { ...clip, source: { ...clip.source } };
}

function isVideoSourceAudioClip(clip: AudioClip): clip is VideoSourceAudioClip {
    return clip.source.kind === 'video-source-audio';
}

function isImportedAudioClip(clip: AudioClip): clip is ImportedAudioClip {
    return clip.source.kind === 'audio-source';
}

function alignImportedAudioSplit(
    left: ImportedAudioClip,
    right: ImportedAudioClip,
    nativeSampleRate: number,
): { left: ImportedAudioClip; right: ImportedAudioClip } {
    const candidates = Array.from(new Set([left.sourceEndSample, right.sourceStartSample]))
        .filter((candidate) => candidate > left.sourceStartSample && candidate < right.sourceEndSample);
    const boundary = candidates.reduce((best, candidate) => {
        const score = getImportedSplitBoundaryScore(left, right, candidate, nativeSampleRate);
        const bestScore = getImportedSplitBoundaryScore(left, right, best, nativeSampleRate);
        return score.maximumDrift < bestScore.maximumDrift
            || (score.maximumDrift === bestScore.maximumDrift && score.totalDrift < bestScore.totalDrift)
            ? candidate
            : best;
    }, candidates[0] ?? left.sourceEndSample);
    return {
        left: clampSampleFades(
            { ...left, sourceEndSample: boundary },
            boundary - left.sourceStartSample,
        ),
        right: clampSampleFades(
            { ...right, sourceStartSample: boundary },
            right.sourceEndSample - boundary,
        ),
    };
}

function getImportedSplitBoundaryScore(
    left: ImportedAudioClip,
    right: ImportedAudioClip,
    boundary: number,
    nativeSampleRate: number,
): { maximumDrift: number; totalDrift: number } {
    const leftNaturalDuration = nativeBoundaryToOutputSample(boundary, nativeSampleRate)
        - nativeBoundaryToOutputSample(left.sourceStartSample, nativeSampleRate);
    const rightNaturalDuration = nativeBoundaryToOutputSample(right.sourceEndSample, nativeSampleRate)
        - nativeBoundaryToOutputSample(boundary, nativeSampleRate);
    const leftDrift = Math.abs(leftNaturalDuration - (left.timelineDurationSamples ?? leftNaturalDuration));
    const rightDrift = Math.abs(rightNaturalDuration - (right.timelineDurationSamples ?? rightNaturalDuration));
    return {
        maximumDrift: Math.max(leftDrift, rightDrift),
        totalDrift: leftDrift + rightDrift,
    };
}

function getCanonicalVideoFrameCount(durationSeconds: number, frameRate: RationalFrameRate): number {
    return Math.max(1, secondsToFrames(durationSeconds, frameRate, 'nearest'));
}

function areMixSettingsEqual(left: AudioClipMixSettings, right: AudioClipMixSettings): boolean {
    return left.muted === right.muted && left.gainDb === right.gainDb;
}

function clampFinite(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : 0));
}

function clampSafeInteger(value: number, minimum: number, maximum: number): number {
    const safe = Number.isFinite(value) ? Math.round(value) : minimum;
    return Math.min(maximum, Math.max(minimum, safe));
}
