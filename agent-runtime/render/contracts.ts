import type { ResolvedRenderPlanV1 } from '../../src/lib/render-plan';

export const HEADLESS_RENDER_LIMITS_VERSION = 1 as const;

export type HeadlessRenderBackendName = 'chromium-webcodecs' | 'ffmpeg';

export type HeadlessRenderErrorCode =
    | 'BACKEND_UNAVAILABLE'
    | 'CANCELLED'
    | 'CLEANUP_FAILED'
    | 'CODEC_UNAVAILABLE'
    | 'INVALID_OUTPUT'
    | 'INVALID_SNAPSHOT'
    | 'OUTPUT_EXISTS'
    | 'RENDER_FAILED'
    | 'RESOURCE_LIMIT'
    | 'SOURCE_CHANGED';

export class HeadlessRenderError extends Error {
    constructor(
        readonly code: HeadlessRenderErrorCode,
        message: string,
        readonly retryableWithFallback = false,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'HeadlessRenderError';
    }
}

export interface HeadlessRenderLimitsV1 {
    version: typeof HEADLESS_RENDER_LIMITS_VERSION;
    maxReadChunkBytes: number;
    maxDecodedPixelBytes: number;
    maxVideoDecoderSessions: number;
    maxCanvasFrames: number;
    maxAudioMixBytes: number;
    maxConcurrentExports: number;
    maxBackendProcesses: number;
    /** Maximum logical bytes retained by backend-owned private scratch files. */
    maxScratchBytes?: number;
    /** Maximum combined resident bytes of active backend child processes. */
    maxBackendResidentBytes?: number;
    /** Maximum stderr bytes accepted from one backend child process. */
    maxBackendStderrBytes?: number;
    /** Maximum FFmpeg progress-protocol bytes accepted from one process. */
    maxBackendProgressBytes?: number;
    /** Maximum lifetime of one backend child process. */
    backendProcessTimeoutMs?: number;
    /** Grace period between SIGTERM and SIGKILL. */
    backendKillGraceMs?: number;
}

export const DEFAULT_HEADLESS_RENDER_LIMITS: HeadlessRenderLimitsV1 = Object.freeze({
    version: HEADLESS_RENDER_LIMITS_VERSION,
    maxReadChunkBytes: 8 * 1024 * 1024,
    maxDecodedPixelBytes: 192 * 1024 * 1024,
    maxVideoDecoderSessions: 2,
    maxCanvasFrames: 2,
    maxAudioMixBytes: 32 * 1024 * 1024,
    maxConcurrentExports: 1,
    // One encoder and at most one sequential source decoder may overlap.
    maxBackendProcesses: 2,
    maxScratchBytes: 4 * 1024 * 1024 * 1024,
    maxBackendResidentBytes: 1024 * 1024 * 1024,
    maxBackendStderrBytes: 1024 * 1024,
    maxBackendProgressBytes: 4 * 1024 * 1024,
    backendProcessTimeoutMs: 2 * 60 * 60_000,
    backendKillGraceMs: 1_000,
});

export type HeadlessRenderResourceKind =
    | 'audio-mix-bytes'
    | 'backend-processes'
    | 'canvas-frames'
    | 'decoded-pixel-bytes'
    | 'export-jobs'
    | 'video-decoder-sessions';

export type HeadlessRenderResourceRequest = Partial<
    Record<HeadlessRenderResourceKind, number>
>;

export interface HeadlessRenderResourceReservation {
    readonly authority: 'process-wide-decoded-memory-v1';
    readonly reservationId: string;
    readonly granted: Readonly<Record<HeadlessRenderResourceKind, number>>;
}

export interface HeadlessRenderResourceLease {
    readonly reservation: HeadlessRenderResourceReservation;
    release(): void;
}

/**
 * The coordinator should inject one process-wide implementation. The render package never creates
 * a singleton, so tests and standalone callers can provide a scoped manager without split authority.
 */
export interface HeadlessRenderResourceBudgetPort {
    readonly authority: 'process-wide-decoded-memory-v1';
    acquire(
        ownerId: string,
        request: HeadlessRenderResourceRequest,
        signal?: AbortSignal,
    ): Promise<HeadlessRenderResourceLease>;
    snapshot(): HeadlessRenderResourceBudgetSnapshot;
}

export interface HeadlessRenderResourceBudgetSnapshot {
    limits: Readonly<Record<HeadlessRenderResourceKind, number>>;
    current: Readonly<Record<HeadlessRenderResourceKind, number>>;
    peak: Readonly<Record<HeadlessRenderResourceKind, number>>;
}

export interface HeadlessRenderBackendCapability {
    supported: boolean;
    backend: HeadlessRenderBackendName;
    resolvedPlanVersion: 1;
    container: 'mp4';
    videoCodec: 'h264';
    audioCodec: 'aac';
    reason?: string;
}

export type HeadlessRenderProgressStage = 'video' | 'audio' | 'muxing';

export interface HeadlessRenderBackendProgress {
    backend?: HeadlessRenderBackendName;
    stage: HeadlessRenderProgressStage;
    completedUnits: number;
    totalUnits: number;
}

export interface HeadlessSourceRangeRead {
    sourceId: string;
    sourceKind: 'video' | 'audio';
    kind: 'video-seconds' | 'audio-output-samples';
    start: number;
    end: number;
}

export interface HeadlessRenderBackendDiagnostics {
    peakDecodedPixelBytes: number;
    peakAudioMixBytes: number;
    peakVideoDecoderSessions: number;
    canvasFrames: number;
    peakBackendResidentBytes?: number;
    peakScratchBytes?: number;
    peakBackendProcesses?: number;
}

export interface HeadlessRenderBackendResult {
    backend: HeadlessRenderBackendName;
    warnings: string[];
    sourceRangesRead: HeadlessSourceRangeRead[];
    diagnostics: HeadlessRenderBackendDiagnostics;
}

/** Opaque, path-free handle issued only after coordinator grant/capability validation and staging. */
export interface HeadlessStagedOutputCapability {
    version: 1;
    kind: 'create-only-staged-output';
    capabilityId: string;
    grantId: string;
    stagingId: string;
}

export interface HeadlessRenderBackendRequest {
    jobId: string;
    plan: ResolvedRenderPlanV1;
    outputCapability: HeadlessStagedOutputCapability;
    limits: HeadlessRenderLimitsV1;
    signal?: AbortSignal;
    onProgress?: (progress: HeadlessRenderBackendProgress) => void;
}

export interface HeadlessRenderBackendPort {
    readonly name: HeadlessRenderBackendName;
    probe(
        plan: ResolvedRenderPlanV1,
        signal?: AbortSignal,
    ): Promise<HeadlessRenderBackendCapability>;
    render(request: HeadlessRenderBackendRequest): Promise<HeadlessRenderBackendResult>;
}

export interface HeadlessBackendSelectionRequest extends HeadlessRenderBackendRequest {
    /** Removes all bytes produced by a failed primary attempt before FFmpeg starts. */
    resetOutputForFallback(): Promise<void>;
}

export function createAbortError(message = 'Headless render was cancelled.'): HeadlessRenderError {
    const error = new HeadlessRenderError('CANCELLED', message);
    error.name = 'AbortError';
    return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw createAbortError();
}

export function normalizeHeadlessRenderError(error: unknown): HeadlessRenderError {
    if (error instanceof HeadlessRenderError) return error;
    if (error instanceof Error && error.name === 'AbortError') return createAbortError(error.message);
    return new HeadlessRenderError(
        'RENDER_FAILED',
        error instanceof Error ? error.message : 'Unknown headless render failure.',
        false,
        error instanceof Error ? { cause: error } : undefined,
    );
}
