import type { ManagedProcessPort, ProbedMediaMetadata } from '../media/contracts';
import type { FileHandle } from 'node:fs/promises';

export type ReviewKind =
    | 'contact-sheet'
    | 'thumbnail-strip'
    | 'waveform'
    | 'audio-map'
    | 'silence-speech'
    | 'scene-cuts'
    | 'proxy';

export interface ReviewRange {
    readonly startSeconds: number;
    readonly endSeconds: number;
}

export interface ReviewParameters {
    readonly maximumFrames?: number;
    readonly thumbnailWidth?: number;
    readonly silenceThresholdDb?: number;
    readonly minimumSilenceSeconds?: number;
    readonly sceneThreshold?: number;
    readonly proxyWidth?: number;
}

export interface ReviewArtifactDescriptor {
    readonly artifactId: string;
    readonly contentKey: string;
    readonly kind: ReviewKind;
    readonly mediaType: string;
    readonly byteLength: number;
    readonly sha256: string;
}

export interface StagedReviewArtifact {
    readonly stagingPath: string;
    writeJson(value: unknown, signal?: AbortSignal): Promise<void>;
    commit(signal?: AbortSignal): Promise<ReviewArtifactDescriptor>;
    discard(): Promise<void>;
}

export interface ReviewArtifactPort {
    stage(request: {
        contentKey: string;
        kind: ReviewKind;
        extension: string;
        mediaType: string;
        maximumBytes: number;
        signal?: AbortSignal;
    }): Promise<StagedReviewArtifact>;
}

/** Already-authorized coordinator-internal or write-destination staging capability. */
export interface VerifiedArtifactStagingGrant {
    readonly grantId: string;
    /** Declares the root private to the coordinator; hostile writers are outside this adapter's boundary. */
    readonly ownership: 'coordinator-owned-private-directory';
    readonly canonicalDirectory: string;
    assertCurrent(signal?: AbortSignal): Promise<void>;
}

export interface ReviewBackendRequest {
    readonly kind: ReviewKind;
    readonly handle: FileHandle;
    readonly metadata: ProbedMediaMetadata;
    readonly range: ReviewRange;
    readonly parameters: Required<ReviewParameters>;
    readonly stagingPath: string;
    readonly maximumOutputBytes: number;
    readonly signal?: AbortSignal;
}

export interface ReviewBackendResult {
    /** Present for maps/candidates that the artifact port serializes as canonical JSON. */
    readonly structuredData?: unknown;
}

export interface ReviewBackendPort {
    /** Changes whenever toolchain or command semantics can change artifact bytes. */
    readonly algorithmVersion: string;
    run(request: ReviewBackendRequest): Promise<ReviewBackendResult>;
}

export interface ReviewKindResult {
    readonly kind: ReviewKind;
    readonly range: ReviewRange;
    readonly status: 'succeeded' | 'not-applicable';
    readonly code?: 'NO_AUDIO';
    readonly artifacts: readonly ReviewArtifactDescriptor[];
}

export interface ReviewRequest {
    readonly sourceId: string;
    readonly kinds: readonly ReviewKind[];
    readonly ranges: readonly ReviewRange[];
    readonly parameters?: ReviewParameters;
    readonly signal?: AbortSignal;
}

export interface ReviewDiagnostics {
    readonly jobsStarted: number;
    readonly jobsSucceeded: number;
    readonly jobsCancelled: number;
    readonly noAudioResults: number;
    readonly artifactsPublished: number;
    readonly processConcurrency: {
        readonly active: number;
        readonly peakActive: number;
        readonly queued: number;
        readonly cancellations: number;
    };
}

export interface FfmpegReviewBackendOptions {
    readonly processes: ManagedProcessPort;
    readonly ffmpegExecutable: string;
    readonly toolchainVersion: string;
}
