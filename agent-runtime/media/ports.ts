import type { MediaReadAccounting } from './accounting';
import type { ManagedMediaErrorCode } from './errors';

export type ManagedMediaJobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface ManagedMediaJobUpdate {
  readonly jobId: string;
  readonly state: ManagedMediaJobState;
  readonly stage: string;
  readonly sequence: number;
  readonly fraction?: number;
  readonly message?: string;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: {
    readonly code: ManagedMediaErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface DurableMediaJobPort {
  publish(update: ManagedMediaJobUpdate, signal?: AbortSignal): Promise<void>;
}

export interface MediaDiagnosticsEvent {
  readonly name: string;
  readonly operationId: string;
  readonly value?: number;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
  readonly readAccounting?: MediaReadAccounting;
}

export interface MediaDiagnosticsPort {
  record(event: MediaDiagnosticsEvent): void;
}

export interface DecodedMemoryLease {
  readonly leaseId: string;
  readonly reservedBytes: number;
  release(): Promise<void>;
}

/**
 * This is process-wide, not job-local. The implementation owner must bind the
 * same budget used by preview, render, export, caches, and every decoder.
 */
export interface DecodedMemoryBudgetPort {
  reserve(
    request: {
      readonly operationId: string;
      readonly category: 'review-decode';
      readonly bytes: number;
    },
    signal?: AbortSignal,
  ): Promise<DecodedMemoryLease>;
}

export interface StagedArtifactCapability {
  readonly stageId: string;
  readonly processOutputCapabilityId: string;
  readonly contentAddress: `sha256:${string}`;
  readonly contentType: string;
  readonly maxBytes: number;
}

export interface PublishedArtifactDescriptor {
  readonly artifactId: string;
  readonly contentAddress: `sha256:${string}`;
  readonly contentType: string;
  readonly byteLength: number;
  readonly sha256: `sha256:${string}`;
}

export interface ArtifactStageRequest {
  readonly jobId: string;
  readonly contentAddress: `sha256:${string}`;
  readonly kind: string;
  readonly contentType: string;
  readonly extension: string;
  readonly maxBytes: number;
}

export interface ArtifactCommitRequest {
  readonly stage: StagedArtifactCapability;
  readonly kind: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Stages are create-only capabilities. The port owns final paths, atomic
 * publication, fsync/rename behavior, hashing, and deletion of partial files.
 */
export interface DurableArtifactPublicationPort {
  findByContentAddress(
    contentAddress: `sha256:${string}`,
    signal?: AbortSignal,
  ): Promise<PublishedArtifactDescriptor | undefined>;

  stageCreateOnly(
    request: ArtifactStageRequest,
    signal?: AbortSignal,
  ): Promise<StagedArtifactCapability>;

  writeStream(
    stage: StagedArtifactCapability,
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<{ readonly byteLength: number; readonly maxBufferedBytes: number }>;

  commitBatch(
    requests: readonly ArtifactCommitRequest[],
    signal?: AbortSignal,
  ): Promise<readonly PublishedArtifactDescriptor[]>;

  discard(stage: StagedArtifactCapability): Promise<void>;
}

export interface MediaClockPort {
  now(): Date;
}
