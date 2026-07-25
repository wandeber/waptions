import { ALL_FORMATS, AudioSampleSink, Input } from 'mediabunny';
import type {
    AudioSourceAsset,
    RationalFrameRate,
    VideoClip,
    VideoClipV3,
    VideoSourceAsset,
    VideoSourceAssetV3,
} from '@/types/video';
import { buildClipPlacements } from './video-timeline';
import {
    getAudioMediaCacheKey,
    getAudioMediaDuration,
    resolveAudioMediaAsset,
    type AudioMediaAsset,
    type AudioMediaCacheKey,
    type AudioMediaReference,
} from './media-asset-ref';
import type { MediaBudgetManager } from './media-byte-source/budget-manager';
import { mediaRuntimeBudgets } from './media-byte-source/budgets';
import { createAdmittedMediabunnyInput } from './media-byte-source/mediabunny-adapter';
import type { MediaByteSourceInput } from './media-byte-source/types';

const DEFAULT_SAMPLE_RATE = 48_000;
const MINIMUM_BUCKET_COUNT = 1_000;
const MAXIMUM_BUCKET_COUNT = 100_000;
// Version 3 invalidates the metadata-only persistent keys used before import fingerprints became
// nonce-bearing immutable identities. Old cache entries remain harmless orphaned derived data.
export const WAVEFORM_PEAK_ALGORITHM_VERSION = 3;
export const WAVEFORM_PROGRESS_INTERVAL_MS = 200;
const WAVEFORM_MIX_CHUNK_FRAMES = 16_384;

export interface WaveformPeaks {
    duration: number;
    sampleRate: number;
    bucketCount: number;
    min: Float32Array;
    max: Float32Array;
}

export interface WaveformPeakAggregator {
    readonly duration: number;
    readonly sampleRate: number;
    readonly bucketCount: number;
    readonly totalSampleCount: number;
    readonly min: Float32Array;
    readonly max: Float32Array;
    readonly populated: Uint8Array;
    nextSampleIndex: number;
}

export interface WaveformSampleWindow {
    sourceFrameOffset: number;
    frameCount: number;
    timelineSampleIndex: number;
}

export interface WaveformDecodedAudioSample {
    timestamp: number;
    duration: number;
    sampleRate: number;
    numberOfFrames: number;
    numberOfChannels: number;
    copyTo(destination: Float32Array, options: {
        planeIndex: number;
        format: 'f32-planar';
        frameOffset: number;
        frameCount: number;
    }): void;
    close(): void;
}

export interface OpenWaveformAudioResult {
    samples: AsyncIterable<WaveformDecodedAudioSample>;
    dispose(): void;
}

export type OpenWaveformAudio = (source: MediaByteSourceInput) => Promise<OpenWaveformAudioResult | null>;

export interface WaveformExtractionProgressOptions {
    onProgress?: (peaks: WaveformPeaks) => void;
    intervalMs?: number;
    now?: () => number;
    pcmBudget?: MediaBudgetManager;
}

async function openWaveformAudioWithMediabunny(
    source: MediaByteSourceInput,
): Promise<OpenWaveformAudioResult | null> {
    const input = await createAdmittedMediabunnyInput(source, (admittedSource) => new Input({
        source: admittedSource,
        formats: ALL_FORMATS,
    }));
    try {
        const track = await input.getPrimaryAudioTrack();
        if (!track) {
            input.dispose();
            return null;
        }
        const sink = new AudioSampleSink(track);
        return {
            samples: sink.samples(),
            // The Input owns the demuxer and decoder transitively used by the sink. The caller
            // must dispose it only after iteration has completed or been abandoned.
            dispose: () => input.dispose(),
        };
    } catch (error) {
        input.dispose();
        throw error;
    }
}

/**
 * Decodes one typed audio media stream into bounded peak data.
 *
 * Every yielded sample transfers ownership to this function. The per-sample finally block is
 * intentionally inside the async loop so copying errors, cancellation, and iterator failures
 * cannot leak WebCodecs AudioData. The enclosing reader is then disposed after iteration ends.
 */
export async function extractAudioMediaWaveformPeaks(
    media: AudioMediaAsset,
    shouldCancel: () => boolean = () => false,
    openAudio: OpenWaveformAudio = openWaveformAudioWithMediabunny,
    progress: WaveformExtractionProgressOptions = {},
): Promise<WaveformPeaks | null> {
    return extractAudioFileWaveformPeaks(
        media.asset.file,
        getAudioMediaDuration(media),
        shouldCancel,
        openAudio,
        progress,
    );
}

/**
 * File-level extraction entry point used by the dedicated waveform worker.
 *
 * Keeping the decoder and peak aggregation independent from project descriptors means the worker
 * receives only structured-clone-safe media data. The typed media wrapper above remains the
 * authoritative main-thread adapter for video-embedded and standalone audio assets.
 */
export async function extractAudioFileWaveformPeaks(
    file: File,
    duration: number,
    shouldCancel: () => boolean = () => false,
    openAudio: OpenWaveformAudio = openWaveformAudioWithMediabunny,
    progress: WaveformExtractionProgressOptions = {},
): Promise<WaveformPeaks | null> {
    if (shouldCancel()) return null;
    const reader = await openAudio(file);
    if (!reader) return finalizeWaveformPeaks(createWaveformPeakAggregator(duration));

    let aggregator: WaveformPeakAggregator | null = null;
    let lastProgressAt = Number.NEGATIVE_INFINITY;
    const now = progress.now ?? (() => (
        typeof performance !== 'undefined' ? performance.now() : Date.now()
    ));
    const requestedProgressInterval = Number.isFinite(progress.intervalMs)
        ? progress.intervalMs as number
        : WAVEFORM_PROGRESS_INTERVAL_MS;
    const progressIntervalMs = Math.min(
        250,
        Math.max(1, requestedProgressInterval),
    );
    try {
        if (shouldCancel()) return null;
        for await (const sample of reader.samples) {
            try {
                if (shouldCancel()) return null;
                if (!aggregator) {
                    aggregator = createWaveformPeakAggregator(duration, sample.sampleRate);
                }
                const window = getWaveformSampleWindow(
                    sample.timestamp,
                    sample.sampleRate,
                    sample.numberOfFrames,
                    aggregator.nextSampleIndex,
                );
                if (!window) continue;

                // Advancing the absolute cursor preserves actual timestamp gaps as neutral
                // buckets instead of manufacturing a potentially large silence buffer.
                aggregator.nextSampleIndex = window.timelineSampleIndex;
                // A PCM container may expose one very large AudioData sample. Bounded chunks keep
                // peak publication and cancellation responsive even in that case, while also
                // avoiding a full-sample mono allocation in the worker.
                for (
                    let processedFrames = 0;
                    processedFrames < window.frameCount;
                    processedFrames += WAVEFORM_MIX_CHUNK_FRAMES
                ) {
                    const frameCount = Math.min(
                        WAVEFORM_MIX_CHUNK_FRAMES,
                        window.frameCount - processedFrames,
                    );
                    const pcmReservation = await (
                        progress.pcmBudget ?? mediaRuntimeBudgets.pcmBytes
                    ).reserve(frameCount * 2 * 4, { label: 'waveform-mix-chunk' });
                    try {
                        if (shouldCancel()) return null;
                        const mono = mixWaveformChannelsToMono(
                            sample.numberOfChannels,
                            frameCount,
                            (channel) => {
                                const plane = new Float32Array(frameCount);
                                sample.copyTo(plane, {
                                    planeIndex: channel,
                                    format: 'f32-planar',
                                    frameOffset: window.sourceFrameOffset + processedFrames,
                                    frameCount,
                                });
                                return plane;
                            },
                            shouldCancel,
                        );
                        if (!mono) return null;
                        appendWaveformSamples(aggregator, mono);
                    } finally {
                        pcmReservation.release();
                    }

                    const currentTime = now();
                    if (
                        progress.onProgress
                        && currentTime - lastProgressAt >= progressIntervalMs
                    ) {
                        lastProgressAt = currentTime;
                        // finalizeWaveformPeaks slices both live arrays. The worker may therefore
                        // transfer this snapshot without detaching the accumulator still owned by
                        // the decoder, which continues receiving later samples.
                        progress.onProgress(finalizeWaveformPeaks(aggregator));
                    }
                }
            } finally {
                // AudioSampleSink yields owned samples. Close exactly once before requesting the
                // next sample, even if copyTo or cancellation exits this function early.
                sample.close();
            }
        }
    } finally {
        reader.dispose();
    }

    if (shouldCancel()) return null;
    return finalizeWaveformPeaks(aggregator ?? createWaveformPeakAggregator(duration));
}

/**
 * Mixes decoded planar channels while allowing long samples to stop promptly when superseded.
 * Returning null lets the owning decoder unwind through its sample-closing finally block.
 */
export function mixWaveformChannelsToMono(
    numberOfChannels: number,
    frameCount: number,
    readChannel: (channelIndex: number) => Float32Array,
    shouldCancel: () => boolean = () => false,
): Float32Array | null {
    const mono = new Float32Array(frameCount);
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
        if (shouldCancel()) return null;
        const plane = readChannel(channel);
        for (let frame = 0; frame < frameCount; frame += 1) {
            // Large decoded samples can spend meaningful time in this inner loop. Polling every
            // 2,048 frames bounds superseded CPU work without adding a branch to every frame.
            if ((frame & 2_047) === 0 && shouldCancel()) return null;
            mono[frame] += plane[frame] / numberOfChannels;
        }
    }
    return shouldCancel() ? null : mono;
}

/**
 * Aligns a decoded sample to the waveform's zero-based source clock. Priming samples before zero
 * are cropped, overlaps are skipped, and timestamp gaps advance the destination cursor without
 * allocating large silence arrays (unpopulated peak buckets already represent silence).
 */
export function getWaveformSampleWindow(
    timestamp: number,
    sampleRate: number,
    numberOfFrames: number,
    nextSampleIndex: number,
): WaveformSampleWindow | null {
    if (!Number.isFinite(timestamp) || !Number.isFinite(sampleRate) || sampleRate <= 0) {
        throw new Error('Waveform sample timing must be finite with a positive sample rate.');
    }
    const preZeroFrames = Math.min(numberOfFrames, Math.max(0, Math.ceil(-timestamp * sampleRate)));
    const nonNegativeStart = Math.max(0, Math.round(timestamp * sampleRate) + preZeroFrames);
    const overlapFrames = Math.max(0, nextSampleIndex - nonNegativeStart);
    const sourceFrameOffset = Math.min(numberOfFrames, preZeroFrames + overlapFrames);
    const frameCount = numberOfFrames - sourceFrameOffset;
    if (frameCount <= 0) return null;
    return {
        sourceFrameOffset,
        frameCount,
        timelineSampleIndex: Math.max(nextSampleIndex, nonNegativeStart),
    };
}

export function getWaveformBucketCount(duration: number): number {
    const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    return Math.min(
        MAXIMUM_BUCKET_COUNT,
        Math.max(MINIMUM_BUCKET_COUNT, Math.ceil(safeDuration * 100)),
    );
}

export function createWaveformPeakAggregator(
    duration: number,
    sampleRate = DEFAULT_SAMPLE_RATE,
): WaveformPeakAggregator {
    if (!Number.isFinite(duration) || duration < 0) {
        throw new Error('Waveform duration must be non-negative and finite.');
    }
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
        throw new Error('Waveform sample rate must be positive and finite.');
    }
    const bucketCount = getWaveformBucketCount(duration);
    return {
        duration,
        sampleRate,
        bucketCount,
        totalSampleCount: Math.max(0, Math.round(duration * sampleRate)),
        min: new Float32Array(bucketCount),
        max: new Float32Array(bucketCount),
        // A separate occupancy bitmap is necessary because an untouched bucket and a valid
        // all-zero bucket have the same numerical extrema.
        populated: new Uint8Array(bucketCount),
        nextSampleIndex: 0,
    };
}

/**
 * Adds a mono stream chunk without requiring callers to retain earlier chunks. Bucket lookup
 * uses the absolute sample cursor, so splitting the same samples at arbitrary chunk boundaries
 * always yields identical peaks.
 */
export function appendWaveformSamples(
    aggregator: WaveformPeakAggregator,
    samples: ArrayLike<number>,
): void {
    if (aggregator.totalSampleCount === 0) {
        aggregator.nextSampleIndex += samples.length;
        return;
    }

    for (let chunkIndex = 0; chunkIndex < samples.length; chunkIndex += 1) {
        const sampleIndex = aggregator.nextSampleIndex + chunkIndex;
        if (sampleIndex >= aggregator.totalSampleCount) {
            break;
        }
        const sample = samples[chunkIndex];
        if (!Number.isFinite(sample)) {
            continue;
        }
        const bucketIndex = Math.min(
            aggregator.bucketCount - 1,
            Math.floor(sampleIndex * aggregator.bucketCount / aggregator.totalSampleCount),
        );
        if (aggregator.populated[bucketIndex] === 0) {
            aggregator.min[bucketIndex] = sample;
            aggregator.max[bucketIndex] = sample;
            aggregator.populated[bucketIndex] = 1;
        } else {
            aggregator.min[bucketIndex] = Math.min(aggregator.min[bucketIndex], sample);
            aggregator.max[bucketIndex] = Math.max(aggregator.max[bucketIndex], sample);
        }
    }
    aggregator.nextSampleIndex += samples.length;
}

export function finalizeWaveformPeaks(aggregator: WaveformPeakAggregator): WaveformPeaks {
    // Float32Array initializes missing buckets to zero, which is the correct neutral visual
    // value for short sources whose mandatory 1,000 buckets outnumber their audio samples.
    return {
        duration: aggregator.duration,
        sampleRate: aggregator.sampleRate,
        bucketCount: aggregator.bucketCount,
        min: aggregator.min.slice(),
        max: aggregator.max.slice(),
    };
}

export function estimateWaveformPeaksBytes(peaks: WaveformPeaks): number {
    return peaks.min.byteLength + peaks.max.byteLength;
}

/** Selects only explicitly requested audible sources, preserving visible clip order. */
export function selectRequestedAudibleSources(
    videoSources: readonly VideoSourceAsset[],
    requestedSourceIds: readonly string[],
): VideoSourceAsset[] {
    const sourcesById = new Map(videoSources.map((source) => [source.id, source]));
    const seen = new Set<string>();
    return requestedSourceIds.flatMap((sourceId) => {
        if (seen.has(sourceId)) return [];
        seen.add(sourceId);
        const source = sourcesById.get(sourceId);
        return source?.hasAudio ? [source] : [];
    });
}

/** Resolves requested audio streams in request order while removing duplicate typed keys. */
export function selectRequestedAudioMedia(
    videoSources: readonly VideoSourceAssetV3[],
    audioSources: readonly AudioSourceAsset[],
    requestedReferences: readonly AudioMediaReference[],
): AudioMediaAsset[] {
    const seen = new Set<AudioMediaCacheKey>();
    return requestedReferences.flatMap((reference) => {
        const cacheKey = getAudioMediaCacheKey(reference);
        if (seen.has(cacheKey)) return [];
        seen.add(cacheKey);
        const media = resolveAudioMediaAsset(reference, videoSources, audioSources);
        return media ? [media] : [];
    });
}

/** Finds source IDs whose gapless clip placements intersect the horizontal viewport. */
export function getVisibleWaveformSourceIds(
    videoClips: readonly VideoClip[],
    visibleStart: number,
    visibleEnd: number,
): string[] {
    const start = Number.isFinite(visibleStart) ? Math.max(0, visibleStart) : 0;
    const end = Number.isFinite(visibleEnd) ? Math.max(start, visibleEnd) : start;
    if (end <= start) return [];

    const seen = new Set<string>();
    return buildClipPlacements(videoClips).flatMap((placement) => {
        const intersects = placement.projectEnd > start && placement.projectStart < end;
        if (!intersects || seen.has(placement.clip.sourceId)) return [];
        seen.add(placement.clip.sourceId);
        return [placement.clip.sourceId];
    });
}

/**
 * Typed equivalent used by the v3 timeline. Detached embedded audio is rendered on its audio
 * clip, so only video clips whose embedded audio remains linked request an in-clip waveform.
 */
export function getVisibleVideoAudioReferences(
    videoClips: readonly (VideoClip | VideoClipV3)[],
    frameRate: RationalFrameRate,
    visibleStart: number,
    visibleEnd: number,
): AudioMediaReference[] {
    const start = Number.isFinite(visibleStart) ? Math.max(0, visibleStart) : 0;
    const end = Number.isFinite(visibleEnd) ? Math.max(start, visibleEnd) : start;
    if (end <= start) return [];

    const seen = new Set<string>();
    return buildClipPlacements(videoClips, frameRate).flatMap((placement) => {
        const clip = placement.clip as VideoClip | VideoClipV3;
        const intersects = placement.projectEnd > start && placement.projectStart < end;
        if (!intersects || seen.has(clip.sourceId)) return [];
        if ('audio' in clip && clip.audio?.linkState !== 'linked') return [];
        seen.add(clip.sourceId);
        return [{ kind: 'video-source-audio' as const, videoSourceId: clip.sourceId }];
    });
}
