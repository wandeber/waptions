import type { RationalFrameRate } from '@/types/video';

export type VideoFrameRequestScope = 'preview' | 'warmup';
export type VideoFrameSessionRequestScope = VideoFrameRequestScope | 'export';

export interface VideoFrameTargetResolution {
    width: number;
    height: number;
}

/** Retention identity for one usefulness-ordered plan, independent from cancellation lifetime. */
export interface PreviewWarmupPlanIdentity {
    generation: number;
    order: number;
}

/**
 * Typed preview identity keeps scheduling policy separate from private cache keys. Preview and
 * warmup share one source session only when both the logical ID and immutable V3 fingerprint match.
 * Export owns VideoFrameSession directly and deliberately never enters this request contract.
 */
export interface VideoFrameRequest {
    scope: VideoFrameRequestScope;
    sourceId: string;
    /** Immutable V3 descriptor identity; source IDs alone may be reused after file replacement. */
    sourceFingerprint: string;
    file: File;
    sourceTime: number;
    sourceFps: number;
    targetResolution?: VideoFrameTargetResolution;
    signal?: AbortSignal;
    warmupPlan?: PreviewWarmupPlanIdentity;
}

export interface VideoFrameResult {
    canvas: CanvasImageSource;
    timestamp: number;
    duration: number;
    frameIndex: number;
    release(): void;
}

export interface PreviewWarmupFrame {
    projectFrameIndex: number;
    sourceId: string;
    sourceFrameIndex: number;
    sourceTime: number;
}

export interface PreviewWarmupProjectContext {
    projectFrameRate: RationalFrameRate;
}
