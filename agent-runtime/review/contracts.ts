import type { ManagedProcessPort, ProbedMediaMetadata } from '../media/contracts';
import type { FileHandle } from 'node:fs/promises';
import type { MediaReadAccounting } from '../media/accounting';
import type { PublishedArtifactDescriptor } from '../media/ports';

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
export interface MediaTimeRange {
  readonly startUs: number;
  readonly endUs: number;
}

export interface ContactSheetReview {
  readonly kind: 'contact-sheet';
  readonly frameCount?: number;
  readonly cellWidth?: number;
  readonly cellHeight?: number;
  readonly columns?: number;
}

export interface ThumbnailStripReview {
  readonly kind: 'thumbnail-strip';
  readonly frameCount?: number;
  readonly cellWidth?: number;
  readonly cellHeight?: number;
  readonly columns?: number;
}

export interface WaveformReview {
  readonly kind: 'waveform';
  readonly bucketDurationUs?: number;
}

export interface AudioMapReview {
  readonly kind: 'audio-map';
  readonly bucketDurationUs?: number;
}

export interface SilenceMapReview {
  readonly kind: 'silence-map';
  readonly bucketDurationUs?: number;
  readonly thresholdDb?: number;
  readonly minimumDurationUs?: number;
}

export interface SpeechMapReview {
  readonly kind: 'speech-map';
  readonly bucketDurationUs?: number;
  readonly thresholdDb?: number;
  readonly minimumDurationUs?: number;
}

export interface SceneCandidatesReview {
  readonly kind: 'scene-candidates';
  readonly sampleIntervalUs?: number;
  readonly threshold?: number;
  readonly minimumGapUs?: number;
  readonly maxCandidates?: number;
  readonly analysisWidth?: number;
}

export interface ReviewProxyReview {
  readonly kind: 'review-proxy';
  readonly width?: number;
  readonly height?: number;
  readonly maxFrameRate?: number;
  readonly videoBitRate?: number;
  readonly audioBitRate?: number;
  readonly includeAudio?: boolean;
}

export type MediaReviewSpecification =
  | ContactSheetReview
  | ThumbnailStripReview
  | WaveformReview
  | AudioMapReview
  | SilenceMapReview
  | SpeechMapReview
  | SceneCandidatesReview
  | ReviewProxyReview;

export interface UsedRangeReviewScope {
  readonly kind: 'used-ranges';
  readonly ranges: readonly MediaTimeRange[];
}

export interface ConfirmedFullSourceReviewScope {
  readonly kind: 'full-source';
  readonly confirmed: true;
}

export type MediaReviewScope = UsedRangeReviewScope | ConfirmedFullSourceReviewScope;

export interface ManagedMediaReviewRequest {
  readonly jobId: string;
  readonly sourceId: string;
  readonly scope: MediaReviewScope;
  readonly reviews: readonly MediaReviewSpecification[];
}

export interface ReviewInterval {
  readonly startUs: number;
  readonly endUs: number;
}

export interface SceneCandidate {
  readonly timeUs: number;
  readonly score: number;
}

export interface ManagedMediaReviewResult {
  readonly jobId: string;
  readonly sourceId: string;
  readonly artifacts: readonly PublishedArtifactDescriptor[];
  readonly readAccounting: MediaReadAccounting;
}

export const REVIEW_ALGORITHM_VERSION = 'managed-media-review-v1';
