import type {
    AudioClip,
    ImportedAudioClip,
    VideoSourceAudioClip,
} from '@/types/video';
import {
    type AudioMixContributor,
    type AudioMixContributorSourceRange,
    type AudioMixPlan,
} from '../audio-mix-plan';
import {
    frameSpanToOutputSamples,
    frameToOutputSample,
    nativeBoundaryToOutputSample,
} from '../audio-timebase';
import {
    getVideoClipDurationFramesV4,
    indexVideoTrackPlacementsV4,
} from '../video-placement-v4';
import type { DescriptorRenderGraphV4 } from './descriptor-render-graph';

interface CandidateContributor extends AudioMixContributor {
    trackSolo: boolean;
}

/**
 * Descriptor-first V4 audio planner.
 *
 * This is intentionally independent from EditorDocumentV4 and File. It preserves the standalone
 * planner's output-sample, mute/solo, linked/detached, gain, and fade semantics while consuming
 * only the validated manifest catalog.
 */
export function buildDescriptorAudioMixPlanV4(
    graph: DescriptorRenderGraphV4,
): AudioMixPlan {
    const { fps } = graph.renderProfile;
    const videoSourcesById = new Map(graph.videoSources.map((source) => [source.id, source]));
    const placementIndex = indexVideoTrackPlacementsV4({
        renderProfile: graph.renderProfile,
        videoClips: [...graph.videoClips],
        videoTracks: [...graph.videoTracks],
    });
    const candidates: CandidateContributor[] = [];
    let independentTimelineEndSample = 0;

    graph.videoClips.forEach((clip) => {
        const placement = placementIndex.byClipId.get(clip.id);
        if (!placement) throw new Error(`Missing explicit video placement for clip "${clip.id}".`);
        const source = videoSourcesById.get(clip.sourceId);
        if (!source?.hasAudio || !clip.audio || clip.audio.linkState !== 'linked' || clip.audio.muted) {
            return;
        }
        candidates.push({
            id: `embedded-video:${clip.id}`,
            kind: 'embedded-video',
            trackId: null,
            source: { kind: 'video-source-audio', videoSourceId: clip.sourceId },
            outputStartSample: frameToOutputSample(placement.startFrame, fps),
            outputEndSample: frameToOutputSample(placement.endFrame, fps),
            sourceRange: {
                domain: 'seconds',
                startSeconds: clip.sourceStart,
                endSeconds: clip.sourceEnd,
            },
            fadeInSamples: frameSpanToOutputSamples(
                placement.startFrame,
                placement.startFrame + clip.audio.fadeInFrames,
                fps,
            ),
            fadeOutSamples: frameSpanToOutputSamples(
                placement.endFrame - clip.audio.fadeOutFrames,
                placement.endFrame,
                fps,
            ),
            gainLinear: decibelsToLinear(clip.audio.gainDb),
            trackSolo: false,
        });
    });

    graph.audioTracks.forEach((track) => track.clips.forEach((clip) => {
        const interval = getDescriptorAudioOutputInterval(clip, graph);
        if (!interval) return;
        independentTimelineEndSample = Math.max(independentTimelineEndSample, interval.endSample);
        if (track.muted || clip.muted) return;
        const sourceRange = getDescriptorSourceRange(clip, graph);
        if (!sourceRange) return;
        const fades = clampOutputFades(
            getDescriptorOutputFades(clip, graph),
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
    }));

    const hasEffectiveSolo = candidates.some((candidate) => candidate.trackSolo);
    const contributors = candidates
        .filter((candidate) => !hasEffectiveSolo || candidate.trackSolo)
        .map(stripCandidateState);
    const videoEndFrame = placementIndex.tracks.reduce(
        (maximum, track) => track.placements.reduce(
            (trackMaximum, placement) => Math.max(trackMaximum, placement.endFrame),
            maximum,
        ),
        0,
    );
    const videoSampleCount = frameToOutputSample(videoEndFrame, fps);
    return {
        sampleRate: 48_000,
        totalSampleCount: Math.max(videoSampleCount, independentTimelineEndSample),
        videoSampleCount,
        contributors,
    };
}

function getDescriptorAudioOutputInterval(
    clip: AudioClip,
    graph: DescriptorRenderGraphV4,
): { startSample: number; endSample: number } | null {
    const startSample = frameToOutputSample(clip.timelineStartFrame, graph.renderProfile.fps);
    if (isVideoSourceAudioClip(clip)) {
        const source = graph.videoSources.find((item) => (
            item.id === clip.source.videoSourceId && item.hasAudio
        ));
        if (!source) return null;
        const durationFrames = getVideoClipDurationFramesV4(clip, graph.renderProfile);
        return {
            startSample,
            endSample: frameToOutputSample(
                clip.timelineStartFrame + durationFrames,
                graph.renderProfile.fps,
            ),
        };
    }
    const source = graph.audioSources.find((item) => item.id === clip.source.audioSourceId);
    if (!source) return null;
    const durationSamples = clip.timelineDurationSamples ?? (
        nativeBoundaryToOutputSample(clip.sourceEndSample, source.nativeSampleRate)
        - nativeBoundaryToOutputSample(clip.sourceStartSample, source.nativeSampleRate)
    );
    return { startSample, endSample: startSample + durationSamples };
}

function getDescriptorSourceRange(
    clip: AudioClip,
    graph: DescriptorRenderGraphV4,
): AudioMixContributorSourceRange | null {
    if (isVideoSourceAudioClip(clip)) {
        return graph.videoSources.some((source) => (
            source.id === clip.source.videoSourceId && source.hasAudio
        )) ? {
                domain: 'seconds',
                startSeconds: clip.sourceStart,
                endSeconds: clip.sourceEnd,
            } : null;
    }
    const source = graph.audioSources.find((item) => item.id === clip.source.audioSourceId);
    return source ? {
        domain: 'native-samples',
        startSample: clip.sourceStartSample,
        endSample: clip.sourceEndSample,
        sampleRate: source.nativeSampleRate,
    } : null;
}

function getDescriptorOutputFades(
    clip: AudioClip,
    graph: DescriptorRenderGraphV4,
): { fadeInSamples: number; fadeOutSamples: number } {
    if (isVideoSourceAudioClip(clip)) {
        const durationFrames = getVideoClipDurationFramesV4(clip, graph.renderProfile);
        const endFrame = clip.timelineStartFrame + durationFrames;
        return {
            fadeInSamples: frameSpanToOutputSamples(
                clip.timelineStartFrame,
                clip.timelineStartFrame + clip.fadeInFrames,
                graph.renderProfile.fps,
            ),
            fadeOutSamples: frameSpanToOutputSamples(
                endFrame - clip.fadeOutFrames,
                endFrame,
                graph.renderProfile.fps,
            ),
        };
    }
    const source = graph.audioSources.find((item) => item.id === clip.source.audioSourceId);
    if (!source) return { fadeInSamples: 0, fadeOutSamples: 0 };
    return {
        fadeInSamples: nativeBoundaryToOutputSample(
            clip.sourceStartSample + clip.fadeInSamples,
            source.nativeSampleRate,
        ) - nativeBoundaryToOutputSample(clip.sourceStartSample, source.nativeSampleRate),
        fadeOutSamples: nativeBoundaryToOutputSample(
            clip.sourceEndSample,
            source.nativeSampleRate,
        ) - nativeBoundaryToOutputSample(
            clip.sourceEndSample - clip.fadeOutSamples,
            source.nativeSampleRate,
        ),
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

function decibelsToLinear(decibels: number): number {
    return 10 ** (decibels / 20);
}

function isVideoSourceAudioClip(clip: AudioClip): clip is VideoSourceAudioClip {
    return clip.source.kind === 'video-source-audio';
}

export function isDescriptorImportedAudioClip(clip: AudioClip): clip is ImportedAudioClip {
    return clip.source.kind === 'audio-source';
}
