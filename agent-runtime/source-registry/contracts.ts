import type { MediaReadAccounting } from '../media/accounting';

export type Sha256Digest = `sha256:${string}`;

/**
 * Durable media identity intentionally contains no filesystem path. The grant
 * owner keeps path resolution and descriptor reopening outside media jobs.
 */
export interface ImmutableMediaIdentity {
  readonly version: 1;
  /**
   * New imports acquire the digest through the streamed probe. Registered
   * identities always use RegisteredImmutableMediaIdentity below.
   */
  readonly sha256?: Sha256Digest;
  readonly byteLength: number;
  readonly statIdentity: string;
}

export interface RegisteredImmutableMediaIdentity extends ImmutableMediaIdentity {
  readonly sha256: Sha256Digest;
}

export type OpenMediaSnapshot = ImmutableMediaIdentity;

export interface MediaRational {
  readonly numerator: number;
  readonly denominator: number;
}

export interface MediaVideoStreamMetadata {
  readonly index: number;
  readonly codec: string;
  readonly profile?: string;
  readonly pixelFormat?: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: MediaRational;
  readonly durationUs?: number;
  readonly bitRate?: number;
}

export interface MediaAudioStreamMetadata {
  readonly index: number;
  readonly codec: string;
  readonly profile?: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly channelLayout?: string;
  readonly durationUs?: number;
  readonly bitRate?: number;
}

export interface MediaProbeMetadata {
  readonly containerFormats: readonly string[];
  readonly containerLongName?: string;
  readonly durationUs: number;
  readonly startTimeUs?: number;
  readonly bitRate?: number;
  readonly videoStreams: readonly MediaVideoStreamMetadata[];
  readonly audioStreams: readonly MediaAudioStreamMetadata[];
  readonly primaryVideoStreamIndex: number;
  readonly primaryAudioStreamIndex?: number;
}

export interface ImmutableMediaSourceRecord {
  readonly version: 1;
  readonly sourceId: string;
  readonly sourceCapabilityId: string;
  readonly displayName: string;
  readonly identity: RegisteredImmutableMediaIdentity;
  readonly metadata: MediaProbeMetadata;
  readonly registeredAt: string;
}

export interface PendingMediaSourceRegistration {
  readonly registrationAlias: string;
  readonly sourceCapabilityId: string;
  readonly displayName: string;
  readonly identity: RegisteredImmutableMediaIdentity;
  readonly metadata: MediaProbeMetadata;
  readonly readAccounting: MediaReadAccounting;
}

export interface AtomicSourceRegistrationRequest<TPlacementRequest = never> {
  readonly jobId: string;
  readonly sources: readonly PendingMediaSourceRegistration[];
  /**
   * Passed through unchanged so the eventual engine/coordinator owner can
   * define the placement schema without coupling media jobs to it.
   */
  readonly placementRequest?: TPlacementRequest;
}

export interface AtomicSourceRegistrationResult<TPlacementResult = never> {
  readonly registryRevision: number;
  readonly sources: readonly ImmutableMediaSourceRecord[];
  readonly placementResult?: TPlacementResult;
}

export interface ImmutableSourceRegistryPort<
  TPlacementRequest = never,
  TPlacementResult = never,
> {
  /**
   * The implementation enters its registry/placement transaction, revalidates
   * every source capability against the supplied immutable identity, and only
   * then publishes the complete batch. A mismatch publishes no registry or
   * placement state and fails with SOURCE_CHANGED.
   */
  registerVerifiedAtomically(
    request: AtomicSourceRegistrationRequest<TPlacementRequest>,
    signal?: AbortSignal,
  ): Promise<AtomicSourceRegistrationResult<TPlacementResult>>;

  get(sourceId: string, signal?: AbortSignal): Promise<ImmutableMediaSourceRecord | undefined>;
}
