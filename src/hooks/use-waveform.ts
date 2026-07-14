'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AudioSourceAsset, VideoSourceAsset, VideoSourceAssetV3 } from '@/types/video';
import {
    getAudioMediaCacheKey,
    type AudioMediaAsset,
    type AudioMediaCacheKey,
    type AudioMediaReference,
} from '@/lib/media-asset-ref';
import {
    selectRequestedAudioMedia,
    type WaveformPeaks,
} from '@/lib/video-waveform';
import {
    sharedWaveformRepository,
    type WaveformRepository,
} from '@/lib/waveform-repository';

// The compatibility adapter must preserve this reference across renders because useAudioWaveforms
// treats source catalog identity as an effect boundary. A fresh empty array would restart and abort
// its worker batch after every state publication from the effect itself.
const EMPTY_AUDIO_SOURCES: readonly AudioSourceAsset[] = [];
// Two workers prevent one long visible source from blocking every later lane while keeping decoder
// pressure bounded. Unbounded Promise.all extraction can starve the separate playback decoder on
// projects with many tracks even though aggregation itself is no longer on React's main thread.
const MAXIMUM_CONCURRENT_WAVEFORM_EXTRACTIONS = 2;

export type WaveformRepositoryReader = Pick<WaveformRepository, 'peek' | 'request'>;

export interface LoadRequestedWaveformsOptions {
    repository: WaveformRepositoryReader;
    projectMedia: readonly AudioMediaAsset[];
    requestedMedia: readonly AudioMediaAsset[];
    signal: AbortSignal;
    onSnapshot: (snapshot: ReadonlyMap<AudioMediaCacheKey, WaveformPeaks>) => void;
    onError: (media: AudioMediaAsset, error: unknown) => void;
    maximumConcurrency?: number;
}

/**
 * Coordinates one hook generation while the repository owns caches and shared workers.
 *
 * The signal belongs to the current project/viewport render. Every progress and completion path
 * checks it immediately before publication, so a late worker message cannot put peaks from a
 * previous project into the newly mounted timeline.
 */
export async function loadRequestedWaveforms(
    options: LoadRequestedWaveformsOptions,
): Promise<void> {
    const progressive = new Map<AudioMediaCacheKey, WaveformPeaks>();
    const projectKeys = new Set(options.projectMedia.map(getAudioMediaCacheKey));
    const publish = () => {
        if (options.signal.aborted) return;
        const snapshot = new Map<AudioMediaCacheKey, WaveformPeaks>();
        options.projectMedia.forEach((media) => {
            // Snapshotting the complete project catalog should not mark every cached source as
            // recently visible; only actual repository requests participate in LRU recency.
            const peaks = options.repository.peek(media, false);
            if (peaks) snapshot.set(getAudioMediaCacheKey(media), peaks);
        });
        progressive.forEach((peaks, key) => {
            if (projectKeys.has(key)) snapshot.set(key, peaks);
        });
        options.onSnapshot(snapshot);
    };

    publish();
    let nextMediaIndex = 0;
    const loadNext = async (): Promise<void> => {
        while (!options.signal.aborted) {
            const media = options.requestedMedia[nextMediaIndex];
            nextMediaIndex += 1;
            if (!media) return;
            const mediaKey = getAudioMediaCacheKey(media);
            try {
                const peaks = await options.repository.request(media, {
                    signal: options.signal,
                    onProgress: (partialPeaks) => {
                        if (options.signal.aborted) return;
                        progressive.set(mediaKey, partialPeaks);
                        publish();
                    },
                });
                if (options.signal.aborted) return;
                progressive.delete(mediaKey);
                if (peaks) publish();
            } catch (error) {
                if (options.signal.aborted) return;
                progressive.delete(mediaKey);
                options.onError(media, error);
                publish();
            }
        }
    };
    const requestedConcurrency = Number.isSafeInteger(options.maximumConcurrency)
        ? options.maximumConcurrency as number
        : MAXIMUM_CONCURRENT_WAVEFORM_EXTRACTIONS;
    const workerCount = Math.min(
        Math.max(1, requestedConcurrency),
        options.requestedMedia.length,
    );
    await Promise.all(Array.from({ length: workerCount }, () => loadNext()));
}

/**
 * Loads typed audio media references requested by the visible timeline viewport. Consumers use
 * cache keys rather than bare IDs so embedded video audio and imported audio cannot collide.
 */
export function useAudioWaveforms(
    videoSources: readonly VideoSourceAssetV3[],
    audioSources: readonly AudioSourceAsset[],
    requestedReferences: readonly AudioMediaReference[],
    repository: WaveformRepositoryReader = sharedWaveformRepository,
) {
    const [peaksByMediaKey, setPeaksByMediaKey] = useState<ReadonlyMap<AudioMediaCacheKey, WaveformPeaks>>(
        new Map(),
    );
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const abortController = new AbortController();
        const projectReferences: AudioMediaReference[] = [
            ...videoSources
                .filter((source) => source.hasAudio)
                .map((source) => ({
                    kind: 'video-source-audio' as const,
                    videoSourceId: source.id,
                })),
            ...audioSources.map((source) => ({
                kind: 'audio-source' as const,
                audioSourceId: source.id,
            })),
        ];
        const projectMedia = selectRequestedAudioMedia(videoSources, audioSources, projectReferences);
        const requestedMedia = selectRequestedAudioMedia(
            videoSources,
            audioSources,
            requestedReferences,
        );
        setError(null);
        if (requestedMedia.length === 0) {
            const snapshot = new Map<AudioMediaCacheKey, WaveformPeaks>();
            projectMedia.forEach((media) => {
                const peaks = repository.peek(media, false);
                if (peaks) snapshot.set(getAudioMediaCacheKey(media), peaks);
            });
            setPeaksByMediaKey(snapshot);
            setIsLoading(false);
            return () => abortController.abort();
        }

        const load = async () => {
            setIsLoading(true);
            try {
                await loadRequestedWaveforms({
                    repository,
                    projectMedia,
                    requestedMedia,
                    signal: abortController.signal,
                    onSnapshot: setPeaksByMediaKey,
                    onError: (media, caught) => {
                        const message = caught instanceof Error
                            ? caught.message
                            : 'Unknown waveform error';
                        console.error(
                            `Failed to build waveform peaks for ${getAudioMediaCacheKey(media)}:`,
                            caught,
                        );
                        setError(message);
                    },
                });
            } finally {
                if (!abortController.signal.aborted) setIsLoading(false);
            }
        };
        void load();
        return () => abortController.abort();
    }, [audioSources, repository, requestedReferences, videoSources]);

    return { peaksByMediaKey, isLoading, error };
}

/**
 * Compatibility adapter for the existing video-only timeline. New v3 timeline consumers should
 * use useAudioWaveforms and typed cache keys directly.
 */
export function useWaveforms(
    videoSources: readonly VideoSourceAsset[],
    requestedSourceIds: readonly string[],
    repository: WaveformRepositoryReader = sharedWaveformRepository,
) {
    const requestedReferences = useMemo<AudioMediaReference[]>(
        () => requestedSourceIds.map((videoSourceId) => ({
            kind: 'video-source-audio',
            videoSourceId,
        })),
        [requestedSourceIds],
    );
    const result = useAudioWaveforms(
        videoSources,
        EMPTY_AUDIO_SOURCES,
        requestedReferences,
        repository,
    );
    const peaksBySourceId = useMemo(() => {
        const compatibilityMap = new Map<string, WaveformPeaks>();
        requestedReferences.forEach((reference) => {
            if (reference.kind !== 'video-source-audio') return;
            const peaks = result.peaksByMediaKey.get(getAudioMediaCacheKey(reference));
            if (peaks) compatibilityMap.set(reference.videoSourceId, peaks);
        });
        return compatibilityMap as ReadonlyMap<string, WaveformPeaks>;
    }, [requestedReferences, result.peaksByMediaKey]);

    return { ...result, peaksBySourceId };
}
