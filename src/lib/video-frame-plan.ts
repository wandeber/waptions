import type {
    ClipPlacement,
    EditorDocumentV3,
    EditorDocumentV4,
    RationalFrameRate,
    VideoSourceAssetV3,
} from '@/types/video';
import { framesToSeconds, secondsToFrames } from './render-profile';
import {
    getSourceFrameAtOrBefore,
    projectTimeToSourceTime,
    resolveClipAtProjectTime,
    buildClipPlacements,
} from './video-timeline';
import type { PreviewWarmupFrame } from './video-runtime-types';
import {
    buildVideoTrackPlacementsV4,
    mapProjectFrameToVideoSourceTimeV4,
    resolveVisibleVideoPlacementAtFrame,
    type VideoClipPlacementV4,
    type VideoTrackPlacementsV4,
} from './video-placement-v4';

export interface WarmupFramePlanOptions {
    isPlaying: boolean;
    currentProjectFrameIndex: number;
    projectFrameRate: RationalFrameRate;
    placements: readonly ClipPlacement[];
    sources: readonly VideoSourceAssetV3[];
    rangeForward: number;
    rangeBackward: number;
    sparseFps: number;
    playbackLookaheadFrames: number;
    hasFrame: (sourceId: string, sourceFrameIndex: number) => boolean;
}

export type VideoFrameRuntimeDocument =
    | Pick<EditorDocumentV3, 'renderProfile' | 'videoClips' | 'videoTracks'>
    | Pick<EditorDocumentV4, 'renderProfile' | 'videoClips' | 'videoTracks'>;

export type VideoFrameRuntimePlan =
    | {
        version: 3;
        projectFrameRate: RationalFrameRate;
        placements: ClipPlacement[];
    }
    | {
        version: 4;
        projectFrameRate: RationalFrameRate;
        tracks: VideoTrackPlacementsV4[];
    };

export type VideoFrameRuntimePlacement = ClipPlacement | VideoClipPlacementV4;

export interface ResolvedVideoFrameRuntimePlacement {
    placement: VideoFrameRuntimePlacement;
    projectFrameIndex: number;
    sourceTime: number;
}

export interface VideoFramePlanSignaturesV4 {
    /** Stable decoded-frame namespaces. Timeline/crop edits deliberately do not change these. */
    sourceCacheIdentities: Readonly<Record<string, string>>;
    /** Per-occurrence mapping identity used to discard only stale placement/warmup projections. */
    clipMappingIdentities: Readonly<Record<string, string>>;
    /** Compact winning-layer geometry, including explicit black gaps. */
    winningVisualIdentity: string;
    winningClipIds: readonly string[];
}

export interface VideoFramePlanInvalidationV4 {
    /** Source namespaces whose decoded bitmaps/sessions are no longer byte/frame compatible. */
    sourceIdsToInvalidate: string[];
    /** Occurrence mappings whose preview/warmup projection must be rebuilt. */
    clipIdsToReplan: string[];
}

/**
 * Builds the shared preview/export visual plan while retaining exact V3 compatibility.
 *
 * V4 detection is based on the frozen explicit track/clip shape. Once detected, the function
 * delegates to the V4 placement authority and never falls back to flat array accumulation.
 */
export function buildVideoFrameRuntimePlan(
    document: VideoFrameRuntimeDocument,
): VideoFrameRuntimePlan {
    if (getVideoFrameDocumentVersion(document) === 4) {
        return {
            version: 4,
            projectFrameRate: document.renderProfile.fps,
            tracks: buildVideoTrackPlacementsV4(document as Pick<
                EditorDocumentV4,
                'renderProfile' | 'videoClips' | 'videoTracks'
            >),
        };
    }
    return {
        version: 3,
        projectFrameRate: document.renderProfile.fps,
        placements: buildClipPlacements(document.videoClips, document.renderProfile.fps),
    };
}

/** Resolves one canonical project frame, including a null result for every explicit V4 gap. */
export function resolveVideoFrameRuntimePlacementAtFrame(
    plan: VideoFrameRuntimePlan,
    projectFrameIndex: number,
): ResolvedVideoFrameRuntimePlacement | null {
    if (!Number.isSafeInteger(projectFrameIndex) || projectFrameIndex < 0) return null;
    if (plan.version === 4) {
        const placement = resolveVisibleVideoPlacementAtFrame(plan.tracks, projectFrameIndex);
        if (!placement) return null;
        const sourceTime = mapProjectFrameToVideoSourceTimeV4(placement, projectFrameIndex);
        return sourceTime === null ? null : { placement, projectFrameIndex, sourceTime };
    }
    const projectTime = framesToSeconds(projectFrameIndex, plan.projectFrameRate);
    const placement = resolveClipAtProjectTime(plan.placements, projectTime);
    return placement ? {
        placement,
        projectFrameIndex,
        sourceTime: projectTimeToSourceTime(placement, projectTime),
    } : null;
}

/**
 * Resolves the visible occurrence for a transport timestamp.
 *
 * V3 retains its existing exact-second source mapping. V4 first enters the canonical integer
 * project-frame domain because explicit placements are half-open frame intervals.
 */
export function resolveVideoFrameRuntimePlacementAtTime(
    plan: VideoFrameRuntimePlan,
    projectTime: number,
): ResolvedVideoFrameRuntimePlacement | null {
    if (!Number.isFinite(projectTime) || projectTime < 0) return null;
    if (plan.version === 4) {
        return resolveVideoFrameRuntimePlacementAtFrame(
            plan,
            secondsToFrames(projectTime, plan.projectFrameRate, 'floor'),
        );
    }
    const placement = resolveClipAtProjectTime(plan.placements, projectTime);
    if (!placement) return null;
    return {
        placement,
        projectFrameIndex: secondsToFrames(projectTime, plan.projectFrameRate, 'floor'),
        sourceTime: projectTimeToSourceTime(placement, projectTime),
    };
}

/**
 * Plans warmup in the canonical project-frame domain, then maps each frame through its clip to a
 * source frame. This is what allows one runway to cross cuts, reused clips, and different source
 * rates without decoding outside the half-open clip interval.
 */
export function buildPreviewWarmupFramePlan({
    isPlaying,
    currentProjectFrameIndex,
    projectFrameRate,
    placements,
    sources,
    rangeForward,
    rangeBackward,
    sparseFps,
    playbackLookaheadFrames,
    hasFrame,
}: WarmupFramePlanOptions): PreviewWarmupFrame[] {
    return buildWarmupFramePlan({
        isPlaying,
        currentProjectFrameIndex,
        projectFrameRate,
        sources,
        rangeForward,
        rangeBackward,
        sparseFps,
        playbackLookaheadFrames,
        hasFrame,
        resolveProjectFrame: (projectFrameIndex) => {
            const projectTime = framesToSeconds(projectFrameIndex, projectFrameRate);
            const placement = resolveClipAtProjectTime(placements, projectTime);
            return placement ? {
                sourceId: placement.clip.sourceId,
                sourceTime: projectTimeToSourceTime(placement, projectTime),
            } : null;
        },
    });
}

/** V4-capable warmup entry point used by playback hooks after one shared plan build. */
export function buildPreviewWarmupFramePlanForRuntime(
    options: Omit<WarmupFramePlanOptions, 'placements'> & { plan: VideoFrameRuntimePlan },
): PreviewWarmupFrame[] {
    return buildWarmupFramePlan({
        ...options,
        resolveProjectFrame: (projectFrameIndex) => {
            const resolved = resolveVideoFrameRuntimePlacementAtFrame(options.plan, projectFrameIndex);
            return resolved ? {
                sourceId: resolved.placement.clip.sourceId,
                sourceTime: resolved.sourceTime,
            } : null;
        },
    });
}

interface SharedWarmupFramePlanOptions extends Omit<WarmupFramePlanOptions, 'placements'> {
    resolveProjectFrame: (
        projectFrameIndex: number,
    ) => { sourceId: string; sourceTime: number } | null;
}

function buildWarmupFramePlan({
    isPlaying,
    currentProjectFrameIndex,
    projectFrameRate,
    sources,
    rangeForward,
    rangeBackward,
    sparseFps,
    playbackLookaheadFrames,
    hasFrame,
    resolveProjectFrame,
}: SharedWarmupFramePlanOptions): PreviewWarmupFrame[] {
    const sourcesById = new Map(sources.map((source) => [source.id, source]));
    const plan: PreviewWarmupFrame[] = [];
    const seenProjectFrames = new Set<number>();
    const seenSourceFrames = new Set<string>();
    const projectFps = projectFrameRate.numerator / projectFrameRate.denominator;

    const pushProjectFrame = (projectFrameIndex: number) => {
        if (projectFrameIndex < 0 || seenProjectFrames.has(projectFrameIndex)) return;
        seenProjectFrames.add(projectFrameIndex);
        const resolved = resolveProjectFrame(projectFrameIndex);
        if (!resolved) return;
        const source = sourcesById.get(resolved.sourceId);
        if (!source) return;
        const sourceFrame = getSourceFrameAtOrBefore(
            resolved.sourceTime,
            source.fps,
            source.duration,
        );
        const sourceFrameKey = `${source.id}:${sourceFrame.index}`;
        if (seenSourceFrames.has(sourceFrameKey) || hasFrame(source.id, sourceFrame.index)) return;
        seenSourceFrames.add(sourceFrameKey);
        plan.push({
            projectFrameIndex,
            sourceId: source.id,
            sourceFrameIndex: sourceFrame.index,
            sourceTime: sourceFrame.time,
        });
    };

    if (isPlaying) {
        for (let offset = 1; offset <= playbackLookaheadFrames; offset += 1) {
            pushProjectFrame(currentProjectFrameIndex + offset);
        }
        return plan;
    }

    const denseForwardFrames = Math.round(Math.min(2, rangeForward) * projectFps);
    const sparseStep = Math.max(1, Math.round(projectFps / Math.max(1, sparseFps)));
    const farForwardFrames = Math.round(rangeForward * projectFps);
    const backwardFrames = Math.round(rangeBackward * projectFps);

    for (let offset = 1; offset <= denseForwardFrames; offset += 1) {
        pushProjectFrame(currentProjectFrameIndex + offset);
    }
    for (let offset = denseForwardFrames + sparseStep; offset <= farForwardFrames; offset += sparseStep) {
        pushProjectFrame(currentProjectFrameIndex + offset);
    }
    for (let offset = sparseStep; offset <= backwardFrames; offset += sparseStep) {
        pushProjectFrame(Math.max(0, currentProjectFrameIndex - offset));
    }
    // Decode order is deliberately usefulness-first. Cache admission owns retention separately,
    // so a constrained LRU can reject later speculative frames without delaying the runway needed
    // when the user presses Play.
    return plan;
}

/** Stable decoded-frame identity; explicit placement and crop are intentionally absent. */
export function getDecodedVideoFrameCacheIdentityV4(
    source: Pick<VideoSourceAssetV3, 'id' | 'fingerprint' | 'fps'>,
    sourceFrameIndex: number,
): string {
    if (!Number.isSafeInteger(sourceFrameIndex) || sourceFrameIndex < 0) {
        throw new RangeError('Decoded video frame index must be a non-negative safe integer.');
    }
    return JSON.stringify([source.id, source.fingerprint, source.fps, sourceFrameIndex]);
}

/**
 * Captures the two invalidation domains separately.
 *
 * Moving or cropping an occurrence changes only `clipMappingIdentities`; replacing source bytes
 * changes one `sourceCacheIdentities` entry. Winning geometry is derived from explicit placement
 * boundaries, so covered lower layers and black gaps are represented without decoding them.
 */
export function buildVideoFramePlanSignaturesV4(
    document: Pick<EditorDocumentV4, 'renderProfile' | 'videoSources' | 'videoClips' | 'videoTracks'>,
): VideoFramePlanSignaturesV4 {
    const sourcesById = new Map(document.videoSources.map((source) => [source.id, source]));
    const tracks = buildVideoTrackPlacementsV4(document);
    const sourceCacheIdentities = Object.fromEntries(document.videoSources.map((source) => [
        source.id,
        JSON.stringify([source.id, source.fingerprint, source.fps, source.duration]),
    ]));
    const clipMappingIdentities = Object.fromEntries(tracks.flatMap((track) => (
        track.placements.map((placement) => {
            const source = sourcesById.get(placement.clip.sourceId);
            return [placement.clip.id, JSON.stringify([
                placement.clip.id,
                placement.trackId,
                placement.startFrame,
                placement.endFrame,
                placement.clip.sourceId,
                source ? sourceCacheIdentities[source.id] : null,
                placement.clip.sourceStart,
                placement.clip.sourceEnd,
            ])] as const;
        })
    )));
    const boundaries = Array.from(new Set(tracks.flatMap((track) => track.placements.flatMap(
        (placement) => [placement.startFrame, placement.endFrame],
    )))).sort((left, right) => left - right);
    const winningRanges = boundaries.slice(0, -1).map((startFrame, index) => {
        const endFrame = boundaries[index + 1];
        const winner = resolveVisibleVideoPlacementAtFrame(tracks, startFrame);
        return [startFrame, endFrame, winner?.clip.id ?? null] as const;
    }).filter(([startFrame, endFrame]) => endFrame > startFrame).reduce<
        Array<readonly [number, number, string | null]>
    >((ranges, range) => {
        const previous = ranges.at(-1);
        if (previous && previous[1] === range[0] && previous[2] === range[2]) {
            // Hidden or fully covered occurrences may introduce placement boundaries without
            // changing the actual winning layer. Coalescing those intervals prevents their moves
            // from invalidating an otherwise identical visual runway.
            ranges[ranges.length - 1] = [previous[0], range[1], previous[2]];
        } else {
            ranges.push(range);
        }
        return ranges;
    }, []);
    const winningClipIds = Array.from(new Set(winningRanges.flatMap((range) => (
        range[2] === null ? [] : [range[2]]
    )))).sort();
    return {
        sourceCacheIdentities,
        clipMappingIdentities,
        winningVisualIdentity: JSON.stringify(winningRanges),
        winningClipIds,
    };
}

/** Computes the smallest safe decoded-cache and occurrence-plan invalidation sets. */
export function diffVideoFramePlanSignaturesV4(
    previous: VideoFramePlanSignaturesV4,
    next: VideoFramePlanSignaturesV4,
): VideoFramePlanInvalidationV4 {
    const sourceIdsToInvalidate = changedRecordKeys(
        previous.sourceCacheIdentities,
        next.sourceCacheIdentities,
    );
    const clipIdsToReplan = new Set(changedRecordKeys(
        previous.clipMappingIdentities,
        next.clipMappingIdentities,
    ));
    if (previous.winningVisualIdentity !== next.winningVisualIdentity) {
        previous.winningClipIds.forEach((clipId) => clipIdsToReplan.add(clipId));
        next.winningClipIds.forEach((clipId) => clipIdsToReplan.add(clipId));
    }
    return {
        sourceIdsToInvalidate,
        clipIdsToReplan: Array.from(clipIdsToReplan).sort(),
    };
}

function getVideoFrameDocumentVersion(
    document: VideoFrameRuntimeDocument,
): 3 | 4 {
    const trackVersions = new Set(document.videoTracks.map((track) => (
        'visible' in track && 'locked' in track && !('clipIds' in track) ? 4
            : 'clipIds' in track && !('visible' in track) && !('locked' in track) ? 3
                : 0
    )));
    const clipVersions = new Set(document.videoClips.map((clip) => (
        'trackId' in clip && 'timelineStartFrame' in clip ? 4 : 3
    )));
    if (trackVersions.has(0) || trackVersions.size > 1 || clipVersions.size > 1) {
        throw new Error('Mixed or ambiguous V3/V4 video runtime graph.');
    }
    const trackVersion = trackVersions.values().next().value as 3 | 4 | undefined;
    const clipVersion = clipVersions.values().next().value as 3 | 4 | undefined;
    if (trackVersion && clipVersion && trackVersion !== clipVersion) {
        throw new Error('Video clips and tracks must use the same editor graph version.');
    }
    // A completely empty structural adapter can only preserve legacy behavior. Valid V4 graphs
    // always contain at least one explicit video track, even when they have no clips.
    return clipVersion ?? trackVersion ?? 3;
}

function changedRecordKeys(
    previous: Readonly<Record<string, string>>,
    next: Readonly<Record<string, string>>,
): string[] {
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    return Array.from(keys).filter((key) => previous[key] !== next[key]).sort();
}
