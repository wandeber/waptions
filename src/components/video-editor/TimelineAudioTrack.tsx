'use client';

import { useMemo } from 'react';
import type {
    AudioClip,
    AudioSourceAsset,
    AudioTrack,
    RationalFrameRate,
    VideoSourceAssetV3,
} from '@/types/video';
import type { AudioMediaCacheKey } from '@/lib/media-asset-ref';
import type { WaveformPeaks } from '@/lib/video-waveform';
import { getAudioMediaCacheKey } from '@/lib/media-asset-ref';
import { useTimelineStore } from '@/stores/timeline-store';
import { TimelineAudioClip } from './TimelineAudioClip';
import { useShallow } from 'zustand/react/shallow';
import { getAudioClipDurationFrames, type TimelineSnapPoint } from '@/lib/timeline-snap';

interface TimelineAudioTrackProps {
    track: AudioTrack;
    allTracks: readonly AudioTrack[];
    videoSources: readonly VideoSourceAssetV3[];
    audioSources: readonly AudioSourceAsset[];
    frameRate: RationalFrameRate;
    pixelsPerSecond: number;
    peaksByMediaKey: ReadonlyMap<AudioMediaCacheKey, WaveformPeaks>;
    snapPoints: readonly TimelineSnapPoint[];
}

interface AudioClipVisualData {
    durationFrames: number;
    sourceName: string;
    waveformSourceStart: number;
    waveformSourceEnd: number;
    cacheKey: AudioMediaCacheKey;
}

/** Converts both audio crop domains to the output-frame span used by timeline geometry. */
export function getAudioClipVisualData(
    clip: AudioClip,
    frameRate: RationalFrameRate,
    videoSources: readonly VideoSourceAssetV3[],
    audioSources: readonly AudioSourceAsset[],
): AudioClipVisualData | null {
    const durationFrames = getAudioClipDurationFrames(clip, frameRate, videoSources, audioSources);
    if (durationFrames === null) return null;
    if ('sourceStart' in clip) {
        const source = videoSources.find((candidate) => candidate.id === clip.source.videoSourceId);
        if (!source?.hasAudio) return null;
        return {
            durationFrames,
            sourceName: source.originalName,
            waveformSourceStart: clip.sourceStart,
            waveformSourceEnd: clip.sourceEnd,
            cacheKey: getAudioMediaCacheKey(clip.source),
        };
    }

    const source = audioSources.find((candidate) => candidate.id === clip.source.audioSourceId);
    if (!source) return null;
    return {
        durationFrames,
        sourceName: source.originalName,
        waveformSourceStart: clip.sourceStartSample / source.nativeSampleRate,
        waveformSourceEnd: clip.sourceEndSample / source.nativeSampleRate,
        cacheKey: getAudioMediaCacheKey(clip.source),
    };
}

export function TimelineAudioTrack({
    track,
    allTracks,
    videoSources,
    audioSources,
    frameRate,
    pixelsPerSecond,
    peaksByMediaKey,
    snapPoints,
}: TimelineAudioTrackProps) {
    const { transientSelection, selectClip } = useTimelineStore(useShallow((state) => ({
        transientSelection: state.transientSelection,
        selectClip: state.selectClip,
    })));
    const visualDataByClipId = useMemo(() => {
        const data = new Map<string, AudioClipVisualData>();
        allTracks.forEach((candidateTrack) => candidateTrack.clips.forEach((clip) => {
            const visual = getAudioClipVisualData(clip, frameRate, videoSources, audioSources);
            if (visual) data.set(clip.id, visual);
        }));
        return data;
    }, [allTracks, audioSources, frameRate, videoSources]);
    const validatePlacement = (
        clipId: string,
        targetTrackId: string,
        startFrame: number,
        durationFrames: number,
    ) => {
        const sourceTrack = allTracks.find((candidate) => candidate.clips.some((clip) => clip.id === clipId));
        const targetTrack = allTracks.find((candidate) => candidate.id === targetTrackId);
        if (!sourceTrack || !targetTrack || sourceTrack.locked || targetTrack.locked || startFrame < 0 || durationFrames < 1) {
            return false;
        }
        const endFrame = startFrame + durationFrames;
        return !targetTrack.clips.some((candidate) => {
            if (candidate.id === clipId) return false;
            const visual = visualDataByClipId.get(candidate.id);
            if (!visual) return true;
            const candidateStart = candidate.timelineStartFrame;
            const candidateEnd = candidateStart + visual.durationFrames;
            return startFrame < candidateEnd && candidateStart < endFrame;
        });
    };

    return (
        <div
            className={`relative h-full border-b border-slate-800/70 ${track.locked ? 'bg-slate-950/80' : 'bg-slate-900/45'}`}
            data-testid="timeline-audio-track"
            data-audio-track-id={track.id}
            onClick={() => selectClip(null)}
        >
            {track.clips.map((clip) => {
                const visual = visualDataByClipId.get(clip.id);
                if (!visual) return null;
                return (
                    <TimelineAudioClip
                        key={clip.id}
                        clip={clip}
                        trackId={track.id}
                        trackLocked={track.locked}
                        durationFrames={visual.durationFrames}
                        pixelsPerSecond={pixelsPerSecond}
                        frameRate={frameRate}
                        sourceName={visual.sourceName}
                        waveformSourceStart={visual.waveformSourceStart}
                        waveformSourceEnd={visual.waveformSourceEnd}
                        peaks={peaksByMediaKey.get(visual.cacheKey)}
                        selected={transientSelection.kind === 'audio-clip' && transientSelection.clipId === clip.id}
                        snapPoints={snapPoints}
                        resolveDurationFrames={(candidateStartFrame) => getAudioClipDurationFrames(
                            { ...clip, timelineStartFrame: candidateStartFrame },
                            frameRate,
                            videoSources,
                            audioSources,
                        ) ?? visual.durationFrames}
                        validatePlacement={validatePlacement}
                    />
                );
            })}
        </div>
    );
}
