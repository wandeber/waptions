import type { HeadlessRenderSnapshotV1, ResolvedRenderPlanV1 } from '../../src/lib/render-plan';
import type {
    HeadlessRenderBackendDiagnostics,
    HeadlessRenderBackendName,
    HeadlessRenderBackendProgress,
    HeadlessRenderLimitsV1,
    HeadlessSourceRangeRead,
    HeadlessStagedOutputCapability,
} from '../render/contracts';
import type { HeadlessExportProgressUpdate } from '../render/progress';

/** Caller-visible reference to a coordinator-validated, create-only staged destination. */
export interface HeadlessExportTargetReference {
    version: 1;
    capabilityId: string;
    grantId: string;
}

export interface HeadlessExportPartial {
    jobId: string;
    partialId: string;
    modifiedAtMs: number;
}

export interface HeadlessExportTargetLease {
    readonly outputCapability: HeadlessStagedOutputCapability;
    readonly displayPath: string;
    reset(signal?: AbortSignal): Promise<void>;
    sync(signal?: AbortSignal): Promise<void>;
    inspect(
        verifier: HeadlessMp4VerifierPort,
        signal?: AbortSignal,
    ): Promise<HeadlessMp4Inspection>;
    commit(signal?: AbortSignal): Promise<void>;
    abort(): Promise<void>;
    hashSha256(signal?: AbortSignal): Promise<string>;
    size(signal?: AbortSignal): Promise<number>;
}

/**
 * Resolves only capabilities already staged by the coordinator's path-grant authority.
 *
 * Export never accepts a filesystem path, creates a sibling by itself, or upgrades this
 * create-only lease to overwrite authority.
 */
export interface HeadlessExportArtifactPort {
    acquireCreateOnly(
        jobId: string,
        target: HeadlessExportTargetReference,
        signal?: AbortSignal,
    ): Promise<HeadlessExportTargetLease>;
    listPartials(
        recoveryScopeId: string,
        signal?: AbortSignal,
    ): Promise<HeadlessExportPartial[]>;
    removePartial(partialId: string): Promise<void>;
}

export interface HeadlessMp4Inspection {
    container: 'mp4' | string;
    videoCodec: 'h264' | string;
    audioCodec: 'aac' | string | null;
    durationSeconds: number;
}

/** FFprobe-compatible integration seam. The verifier must read, never repair, the staged output. */
export interface HeadlessMp4VerifierPort {
    inspect(
        outputCapability: HeadlessStagedOutputCapability,
        signal?: AbortSignal,
    ): Promise<HeadlessMp4Inspection>;
}

export interface HeadlessExportRequest {
    jobId: string;
    snapshot: HeadlessRenderSnapshotV1;
    target: HeadlessExportTargetReference;
    limits?: HeadlessRenderLimitsV1;
    signal?: AbortSignal;
    onProgress?: (progress: HeadlessExportProgressUpdate) => void;
}

export interface HeadlessExportSuccess {
    status: 'succeeded';
    jobId: string;
    planId: string;
    path: string;
    capabilityId: string;
    grantId: string;
    sha256: string;
    bytes: number;
    backend: HeadlessRenderBackendName;
    videoCodec: 'h264';
    audioCodec: 'aac';
    durationSeconds: number;
    warnings: string[];
    sourceRangesRead: HeadlessSourceRangeRead[];
    diagnostics: HeadlessRenderBackendDiagnostics;
}

export interface HeadlessExportFailure {
    status: 'failed' | 'cancelled';
    jobId: string;
    code: string;
    message: string;
}

export type HeadlessExportResult = HeadlessExportSuccess | HeadlessExportFailure;

export interface HeadlessRenderExecutionPort {
    render(request: {
        jobId: string;
        plan: ResolvedRenderPlanV1;
        outputCapability: HeadlessStagedOutputCapability;
        limits: HeadlessRenderLimitsV1;
        signal?: AbortSignal;
        onProgress?: (progress: HeadlessRenderBackendProgress) => void;
        resetOutputForFallback(): Promise<void>;
    }): Promise<{
        backend: HeadlessRenderBackendName;
        warnings: string[];
        sourceRangesRead: HeadlessSourceRangeRead[];
        diagnostics: HeadlessRenderBackendDiagnostics;
    }>;
}
