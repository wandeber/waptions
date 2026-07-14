import type {
    AudioClip,
    EditorDocumentV3,
    ImportedAudioClip,
    RationalFrameRate,
    VideoSourceAudioClip,
} from '@/types/video';
import {
    frameSpanToOutputSamples,
    frameToOutputSample,
    nativeBoundaryToOutputSample,
} from './audio-timebase';
import { secondsToFrames } from './render-profile';

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
export function buildAudioMixPlan(document: EditorDocumentV3): AudioMixPlan {
    const { fps } = document.renderProfile;
    const videoSourcesById = new Map(document.videoSources.map((source) => [source.id, source]));
    const candidates: CandidateContributor[] = [];
    let videoFrameCursor = 0;
    let independentTimelineEndSample = 0;

    document.videoClips.forEach((clip) => {
        const source = videoSourcesById.get(clip.sourceId);
        const durationFrames = getCanonicalVideoFrameCount(clip.sourceEnd - clip.sourceStart, fps);
        const startFrame = videoFrameCursor;
        const endFrame = startFrame + durationFrames;
        videoFrameCursor = endFrame;

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
            const fades = getIndependentOutputFades(clip, document);
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
    const videoSampleCount = frameToOutputSample(videoFrameCursor, fps);
    const totalSampleCount = Math.max(videoSampleCount, independentTimelineEndSample);

    return {
        sampleRate: document.renderProfile.audioSampleRate,
        totalSampleCount,
        videoSampleCount,
        contributors,
    };
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
