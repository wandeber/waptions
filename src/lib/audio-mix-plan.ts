import type {
    AudioClip,
    EditorDocumentV3,
    EditorDocumentV4,
    ImportedAudioClip,
    RationalFrameRate,
    VideoClipV3,
    VideoClipV4,
    VideoSourceAudioClip,
} from '@/types/video';
import {
    frameSpanToOutputSamples,
    frameToOutputSample,
    nativeBoundaryToOutputSample,
} from './audio-timebase';
import { secondsToFrames } from './render-profile';
import { indexVideoTrackPlacementsV4 } from './video-placement-v4';

export type AudioMixContributorSource = AudioClip['source'];

export type AudioMixContributorSourceRange =
    | { domain: 'seconds'; startSeconds: number; endSeconds: number }
    | { domain: 'native-samples'; startSample: number; endSample: number; sampleRate: number };

export interface AudioMixContributor {
    id: string;
    kind: 'embedded-video' | 'independent-audio';
    trackId: string | null;
    source: AudioMixContributorSource;
    outputStartSample: number;
    outputEndSample: number;
    sourceRange: AudioMixContributorSourceRange;
    fadeInSamples: number;
    fadeOutSamples: number;
    gainLinear: number;
}

export interface AudioMixPlan {
    sampleRate: 48_000;
    totalSampleCount: number;
    videoSampleCount: number;
    contributors: AudioMixContributor[];
}

export type AudioMixDocument =
    | Pick<
        EditorDocumentV3,
        'renderProfile' | 'videoSources' | 'videoClips' | 'videoTracks' | 'audioSources' | 'audioTracks'
    >
    | Pick<
        EditorDocumentV4,
        'renderProfile' | 'videoSources' | 'videoClips' | 'videoTracks' | 'audioSources' | 'audioTracks'
    >;

interface CandidateContributor extends AudioMixContributor {
    trackSolo: boolean;
}

/** Converts a logarithmic editor control to a deterministic linear multiplier. */
export function decibelsToLinear(decibels: number): number {
    return 10 ** (decibels / 20);
}

/**
 * Builds the immutable graph shared by preview and export.
 *
 * Linked video audio is an embedded contributor only while its parent clip says `linked`.
 * Detached and imported clips are independent contributors on ordinary audio tracks. A solo on
 * any track that has an audible contributor suppresses both non-solo tracks and embedded video
 * audio, matching the behavior of conventional editor track mixers.
 */
export function buildAudioMixPlan(document: AudioMixDocument): AudioMixPlan {
    const { fps } = document.renderProfile;
    const videoSourcesById = new Map(document.videoSources.map((source) => [source.id, source]));
    const candidates: CandidateContributor[] = [];
    let independentTimelineEndSample = 0;
    const videoPlacements = buildEmbeddedVideoPlacements(document);

    videoPlacements.forEach(({ clip, startFrame, endFrame }) => {
        const source = videoSourcesById.get(clip.sourceId);

        if (!source?.hasAudio || !clip.audio || clip.audio.linkState !== 'linked' || clip.audio.muted) return;
        candidates.push({
            id: `embedded-video:${clip.id}`,
            kind: 'embedded-video',
            trackId: null,
            source: { kind: 'video-source-audio', videoSourceId: clip.sourceId },
            outputStartSample: frameToOutputSample(startFrame, fps),
            outputEndSample: frameToOutputSample(endFrame, fps),
            sourceRange: {
                domain: 'seconds',
                startSeconds: clip.sourceStart,
                endSeconds: clip.sourceEnd,
            },
            fadeInSamples: frameSpanToOutputSamples(startFrame, startFrame + clip.audio.fadeInFrames, fps),
            fadeOutSamples: frameSpanToOutputSamples(endFrame - clip.audio.fadeOutFrames, endFrame, fps),
            gainLinear: decibelsToLinear(clip.audio.gainDb),
            trackSolo: false,
        });
    });

    document.audioTracks.forEach((track) => {
        track.clips.forEach((clip) => {
            const interval = getIndependentAudioOutputInterval(clip, document);
            if (!interval) return;
            independentTimelineEndSample = Math.max(independentTimelineEndSample, interval.endSample);
            if (track.muted || clip.muted) return;

            const sourceRange = getIndependentSourceRange(clip, document);
            if (!sourceRange) return;
            const fades = clampOutputFades(
                getIndependentOutputFades(clip, document),
                interval.endSample - interval.startSample,
            );
            candidates.push({
                id: `independent-audio:${track.id}:${clip.id}`,
                kind: 'independent-audio',
                trackId: track.id,
                source: clip.source,
                outputStartSample: interval.startSample,
                outputEndSample: interval.endSample,
                sourceRange,
                fadeInSamples: fades.fadeInSamples,
                fadeOutSamples: fades.fadeOutSamples,
                gainLinear: decibelsToLinear(track.gainDb + clip.gainDb),
                trackSolo: track.solo,
            });
        });
    });

    const hasEffectiveSolo = candidates.some((candidate) => candidate.trackSolo);
    const contributors = candidates
        .filter((candidate) => !hasEffectiveSolo || candidate.trackSolo)
        .map(stripCandidateState);
    const videoEndFrame = videoPlacements.reduce(
        (maximum, placement) => Math.max(maximum, placement.endFrame),
        0,
    );
    const videoSampleCount = frameToOutputSample(videoEndFrame, fps);
    const totalSampleCount = Math.max(videoSampleCount, independentTimelineEndSample);

    return {
        sampleRate: document.renderProfile.audioSampleRate,
        totalSampleCount,
        videoSampleCount,
        contributors,
    };
}

interface EmbeddedVideoPlacement {
    clip: VideoClipV3 | VideoClipV4;
    startFrame: number;
    endFrame: number;
}

/**
 * Projects linked-video audio from the same placement authority as visual playback.
 *
 * V3 retains its cumulative frame cursor. A coherent V4 clip/track shape selects the explicit
 * path; mixed-version arrays fail closed instead of accidentally restoring cumulative timing.
 * Track visibility is deliberately absent because hiding video must not mute linked audio.
 */
function buildEmbeddedVideoPlacements(document: AudioMixDocument): EmbeddedVideoPlacement[] {
    const trackVersions = new Set(document.videoTracks.map((track) => (
        'visible' in track && 'locked' in track && !('clipIds' in track) ? 4
            : 'clipIds' in track && !('visible' in track) && !('locked' in track) ? 3
                : 0
    )));
    const clipVersions = new Set(document.videoClips.map((clip) => (
        'timelineStartFrame' in clip && 'trackId' in clip ? 4 : 3
    )));
    if (trackVersions.has(0) || trackVersions.size > 1 || clipVersions.size > 1) {
        throw new Error('Mixed or ambiguous V3/V4 audio runtime graph.');
    }
    const trackVersion = trackVersions.values().next().value as 3 | 4 | undefined;
    const clipVersion = clipVersions.values().next().value as 3 | 4 | undefined;
    if (trackVersion && clipVersion && trackVersion !== clipVersion) {
        throw new Error('Video clips and tracks must use the same editor graph version.');
    }

    if ((clipVersion ?? trackVersion) === 4) {
        const explicitDocument = document as Pick<
            EditorDocumentV4,
            'renderProfile' | 'videoTracks' | 'videoClips'
        >;
        const index = indexVideoTrackPlacementsV4(explicitDocument);
        return explicitDocument.videoClips.map((clip) => {
            const placement = index.byClipId.get(clip.id);
            if (!placement) throw new Error(`Missing explicit video placement for clip "${clip.id}".`);
            return { clip, startFrame: placement.startFrame, endFrame: placement.endFrame };
        });
    }

    let frameCursor = 0;
    return (document.videoClips as VideoClipV3[]).map((clip) => {
        const durationFrames = getCanonicalVideoFrameCount(
            clip.sourceEnd - clip.sourceStart,
            document.renderProfile.fps,
        );
        const placement = {
            clip,
            startFrame: frameCursor,
            endFrame: frameCursor + durationFrames,
        };
        frameCursor = placement.endFrame;
        return placement;
    });
}

export function getAudioMixPlanDurationSeconds(plan: AudioMixPlan): number {
    return plan.totalSampleCount / plan.sampleRate;
}

/** Returns the exact half-open output-sample interval used for editing and rendering. */
export function getIndependentAudioOutputInterval(
    clip: AudioClip,
    document: Pick<EditorDocumentV3, 'renderProfile' | 'videoSources' | 'audioSources'>,
): { startSample: number; endSample: number } | null {
    const startSample = frameToOutputSample(clip.timelineStartFrame, document.renderProfile.fps);
    if (isVideoSourceAudioClip(clip)) {
        if (!document.videoSources.some((source) => source.id === clip.source.videoSourceId && source.hasAudio)) {
            return null;
        }
        const durationFrames = getCanonicalVideoFrameCount(
            clip.sourceEnd - clip.sourceStart,
            document.renderProfile.fps,
        );
        return {
            startSample,
            endSample: frameToOutputSample(clip.timelineStartFrame + durationFrames, document.renderProfile.fps),
        };
    }

    const source = document.audioSources.find((item) => item.id === clip.source.audioSourceId);
    if (!source) return null;
    if (clip.timelineDurationSamples !== undefined) {
        return {
            startSample,
            endSample: startSample + clip.timelineDurationSamples,
        };
    }
    // The duration is the difference between the two absolute native boundary mappings. Mapping
    // only the crop's sample count would produce a different one-sample result after a left trim.
    const durationSamples = nativeBoundaryToOutputSample(clip.sourceEndSample, source.nativeSampleRate)
        - nativeBoundaryToOutputSample(clip.sourceStartSample, source.nativeSampleRate);
    return { startSample, endSample: startSample + durationSamples };
}

function getIndependentSourceRange(
    clip: AudioClip,
    document: Pick<EditorDocumentV3, 'videoSources' | 'audioSources'>,
): AudioMixContributorSourceRange | null {
    if (isVideoSourceAudioClip(clip)) {
        return document.videoSources.some((source) => source.id === clip.source.videoSourceId && source.hasAudio)
            ? { domain: 'seconds', startSeconds: clip.sourceStart, endSeconds: clip.sourceEnd }
            : null;
    }
    const source = document.audioSources.find((item) => item.id === clip.source.audioSourceId);
    return source ? {
        domain: 'native-samples',
        startSample: clip.sourceStartSample,
        endSample: clip.sourceEndSample,
        sampleRate: source.nativeSampleRate,
    } : null;
}

function getIndependentOutputFades(
    clip: AudioClip,
    document: Pick<EditorDocumentV3, 'renderProfile' | 'audioSources'>,
): { fadeInSamples: number; fadeOutSamples: number } {
    if (isVideoSourceAudioClip(clip)) {
        const durationFrames = getCanonicalVideoFrameCount(
            clip.sourceEnd - clip.sourceStart,
            document.renderProfile.fps,
        );
        const endFrame = clip.timelineStartFrame + durationFrames;
        return {
            fadeInSamples: frameSpanToOutputSamples(
                clip.timelineStartFrame,
                clip.timelineStartFrame + clip.fadeInFrames,
                document.renderProfile.fps,
            ),
            fadeOutSamples: frameSpanToOutputSamples(
                endFrame - clip.fadeOutFrames,
                endFrame,
                document.renderProfile.fps,
            ),
        };
    }
    const source = document.audioSources.find((item) => item.id === clip.source.audioSourceId);
    if (!source) return { fadeInSamples: 0, fadeOutSamples: 0 };
    return {
        fadeInSamples: nativeBoundaryToOutputSample(
            clip.sourceStartSample + clip.fadeInSamples,
            source.nativeSampleRate,
        ) - nativeBoundaryToOutputSample(clip.sourceStartSample, source.nativeSampleRate),
        fadeOutSamples: nativeBoundaryToOutputSample(clip.sourceEndSample, source.nativeSampleRate)
            - nativeBoundaryToOutputSample(clip.sourceEndSample - clip.fadeOutSamples, source.nativeSampleRate),
    };
}

function clampOutputFades(
    fades: { fadeInSamples: number; fadeOutSamples: number },
    outputSampleCount: number,
): { fadeInSamples: number; fadeOutSamples: number } {
    const combined = fades.fadeInSamples + fades.fadeOutSamples;
    if (combined <= outputSampleCount || combined === 0) return fades;
    const fadeInSamples = Math.floor(fades.fadeInSamples * outputSampleCount / combined);
    return { fadeInSamples, fadeOutSamples: outputSampleCount - fadeInSamples };
}

function stripCandidateState(candidate: CandidateContributor): AudioMixContributor {
    return {
        id: candidate.id,
        kind: candidate.kind,
        trackId: candidate.trackId,
        source: candidate.source,
        outputStartSample: candidate.outputStartSample,
        outputEndSample: candidate.outputEndSample,
        sourceRange: candidate.sourceRange,
        fadeInSamples: candidate.fadeInSamples,
        fadeOutSamples: candidate.fadeOutSamples,
        gainLinear: candidate.gainLinear,
    };
}

export function isImportedAudioClip(clip: AudioClip): clip is ImportedAudioClip {
    return clip.source.kind === 'audio-source';
}

export function isVideoSourceAudioClip(clip: AudioClip): clip is VideoSourceAudioClip {
    return clip.source.kind === 'video-source-audio';
}

function getCanonicalVideoFrameCount(durationSeconds: number, frameRate: RationalFrameRate): number {
    return Math.max(1, secondsToFrames(durationSeconds, frameRate, 'nearest'));
}
