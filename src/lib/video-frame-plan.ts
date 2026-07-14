import type { ClipPlacement, RationalFrameRate, VideoSourceAssetV3 } from '@/types/video';
import { framesToSeconds } from './render-profile';
import {
    getSourceFrameAtOrBefore,
    projectTimeToSourceTime,
    resolveClipAtProjectTime,
} from './video-timeline';
import type { PreviewWarmupFrame } from './video-runtime-types';

interface WarmupFramePlanOptions {
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
    const sourcesById = new Map(sources.map((source) => [source.id, source]));
    const plan: PreviewWarmupFrame[] = [];
    const seenProjectFrames = new Set<number>();
    const seenSourceFrames = new Set<string>();
    const projectFps = projectFrameRate.numerator / projectFrameRate.denominator;

    const pushProjectFrame = (projectFrameIndex: number) => {
        if (projectFrameIndex < 0 || seenProjectFrames.has(projectFrameIndex)) return;
        seenProjectFrames.add(projectFrameIndex);
        const projectTime = framesToSeconds(projectFrameIndex, projectFrameRate);
        const placement = resolveClipAtProjectTime(placements, projectTime);
        if (!placement) return;
        const source = sourcesById.get(placement.clip.sourceId);
        if (!source) return;
        const sourceFrame = getSourceFrameAtOrBefore(
            projectTimeToSourceTime(placement, projectTime),
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
