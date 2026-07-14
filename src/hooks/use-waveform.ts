'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AudioSourceAsset, VideoSourceAsset, VideoSourceAssetV3 } from '@/types/video';
import {
    getAudioMediaCacheKey,
    getAudioMediaDuration,
    type AudioMediaCacheKey,
    type AudioMediaReference,
} from '@/lib/media-asset-ref';
import {
    createWaveformLru,
    getWaveformFromLru,
    putWaveformInLru,
    selectRequestedAudioMedia,
    snapshotWaveformsFromLru,
    type WaveformPeaks,
} from '@/lib/video-waveform';
import { extractWaveformPeaksInWorker } from '@/lib/video-waveform-client';

// Peaks are compact (at most 100k min/max buckets per stream), but the cap prevents projects
// with hundreds of orphaned imports from retaining every decoded waveform indefinitely.
const waveformCache = createWaveformLru(32 * 1024 * 1024);
// The compatibility adapter must preserve this reference across renders because useAudioWaveforms
// treats source catalog identity as an effect boundary. A fresh empty array would restart and abort
// its worker batch after every state publication from the effect itself.
const EMPTY_AUDIO_SOURCES: readonly AudioSourceAsset[] = [];
// Two workers prevent one long visible source from blocking every later lane while keeping decoder
// pressure bounded. Unbounded Promise.all extraction can starve the separate playback decoder on
// projects with many tracks even though aggregation itself is no longer on React's main thread.
const MAXIMUM_CONCURRENT_WAVEFORM_EXTRACTIONS = 2;

/**
 * Loads typed audio media references requested by the visible timeline viewport. Consumers use
 * cache keys rather than bare IDs so embedded video audio and imported audio cannot collide.
 */
export function useAudioWaveforms(
    videoSources: readonly VideoSourceAssetV3[],
    audioSources: readonly AudioSourceAsset[],
    requestedReferences: readonly AudioMediaReference[],
) {
    const [peaksByMediaKey, setPeaksByMediaKey] = useState<ReadonlyMap<AudioMediaCacheKey, WaveformPeaks>>(
        new Map(),
    );
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
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
        const requestedMedia = selectRequestedAudioMedia(
            videoSources,
            audioSources,
            requestedReferences,
        );
        const publishCacheSnapshot = () => {
            if (!cancelled) {
                // React retains only references still owned by the bounded LRU. Replacing the map
                // after insertion drops arrays whose stream was evicted by that insertion.
                setPeaksByMediaKey(snapshotWaveformsFromLru(waveformCache, projectReferences));
            }
        };

        publishCacheSnapshot();
        setError(null);
        if (requestedMedia.length === 0) {
            setIsLoading(false);
            return () => {
                cancelled = true;
            };
        }

        const load = async () => {
            setIsLoading(true);
            try {
                let nextMediaIndex = 0;
                const loadNextMedia = async (): Promise<void> => {
                    while (!cancelled && !abortController.signal.aborted) {
                        const media = requestedMedia[nextMediaIndex];
                        nextMediaIndex += 1;
                        if (!media) return;
                        const reference: AudioMediaReference = media.kind === 'video-source-audio'
                            ? { kind: 'video-source-audio', videoSourceId: media.asset.id }
                            : { kind: 'audio-source', audioSourceId: media.asset.id };
                        try {
                            let peaks = getWaveformFromLru(waveformCache, reference);
                            if (!peaks) {
                                peaks = await extractWaveformPeaksInWorker(
                                    media.asset.file,
                                    getAudioMediaDuration(media),
                                    abortController.signal,
                                );
                                // A scroll, zoom, resize, or project switch can supersede this
                                // request while decoding. Stale work must never populate the cache.
                                if (!peaks || cancelled) return;
                                putWaveformInLru(waveformCache, reference, peaks);
                            }
                            publishCacheSnapshot();
                        } catch (caught) {
                            if (cancelled || abortController.signal.aborted) return;
                            // Decoder support is source-specific. Keep the other bounded worker and
                            // this chain alive so one corrupt file cannot suppress unrelated lanes.
                            const message = caught instanceof Error
                                ? caught.message
                                : 'Unknown waveform error';
                            console.error(
                                `Failed to build waveform peaks for ${getAudioMediaCacheKey(reference)}:`,
                                caught,
                            );
                            setError(message);
                        }
                    }
                };
                const workerCount = Math.min(
                    MAXIMUM_CONCURRENT_WAVEFORM_EXTRACTIONS,
                    requestedMedia.length,
                );
                await Promise.all(Array.from({ length: workerCount }, () => loadNextMedia()));
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        };
        void load();
        return () => {
            cancelled = true;
            abortController.abort();
        };
    }, [audioSources, requestedReferences, videoSources]);

    return { peaksByMediaKey, isLoading, error };
}

/**
 * Compatibility adapter for the existing video-only timeline. New v3 timeline consumers should
 * use useAudioWaveforms and typed cache keys directly.
 */
export function useWaveforms(
    videoSources: readonly VideoSourceAsset[],
    requestedSourceIds: readonly string[],
) {
    const requestedReferences = useMemo<AudioMediaReference[]>(
        () => requestedSourceIds.map((videoSourceId) => ({
            kind: 'video-source-audio',
            videoSourceId,
        })),
        [requestedSourceIds],
    );
    const result = useAudioWaveforms(videoSources, EMPTY_AUDIO_SOURCES, requestedReferences);
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
