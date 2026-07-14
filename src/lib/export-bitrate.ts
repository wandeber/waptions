import type { VideoClip, VideoSourceDescriptor } from '@/types/video';

export const DEFAULT_SOURCE_BITRATE = 5_000_000;

/**
 * Estimates the active timeline bitrate from inspected source bitrates.
 *
 * Each clip placement contributes independently, so trimmed and repeated uses are weighted by
 * their actual placement duration. Append-only sources without placements intentionally have no
 * influence. The fallback is applied per active placement only when its source bitrate is absent
 * or invalid, which keeps one uninspected source from discarding useful metadata from the others.
 */
export function calculateActiveTimelineBitrate(
    videoSources: readonly VideoSourceDescriptor[],
    videoClips: readonly VideoClip[],
): number {
    const sourcesById = new Map(videoSources.map((source) => [source.id, source]));
    let weightedBitrate = 0;
    let activeDuration = 0;

    videoClips.forEach((clip) => {
        const duration = clip.sourceEnd - clip.sourceStart;
        if (!Number.isFinite(duration) || duration <= 0) return;

        const inspectedBitrate = sourcesById.get(clip.sourceId)?.bitrate;
        const bitrate = typeof inspectedBitrate === 'number'
            && Number.isFinite(inspectedBitrate)
            && inspectedBitrate > 0
            ? inspectedBitrate
            : DEFAULT_SOURCE_BITRATE;
        weightedBitrate += bitrate * duration;
        activeDuration += duration;
    });

    return activeDuration > 0 ? weightedBitrate / activeDuration : DEFAULT_SOURCE_BITRATE;
}
