export const WAPTIONS_AGENT_API_VERSION = '2026-07-25' as const;

export type Sha256ContentDigest = `sha256:${string}`;

export const WAPTIONS_STABLE_ERROR_CODES = [
    'INVALID_REQUEST',
    'UNSUPPORTED_API_VERSION',
    'PAYLOAD_TOO_LARGE',
    'SESSION_NOT_FOUND',
    'SESSION_EPOCH_MISMATCH',
    'SESSION_REVISION_CONFLICT',
    'REVISION_CONFLICT',
    'NARRATIVE_REVISION_CONFLICT',
    'AUDIO_REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_CONFLICT',
    'PLAN_NOT_FOUND',
    'PLAN_EXPIRED',
    'PLAN_INPUT_CHANGED',
    'NOT_FOUND',
    'INVALID_DOCUMENT',
    'INVALID_OPERATION',
    'OVERLAP_CONFLICT',
    'LOCKED_TARGET',
    'ORDER_NOT_MEANINGFUL',
    'SOURCE_CHANGED',
    'SOURCE_UNREADABLE',
    'PATH_NOT_GRANTED',
    'WRITE_DESTINATION_NOT_GRANTED',
    'OVERWRITE_NOT_AUTHORIZED',
    'PATH_IDENTITY_CHANGED',
    'UNSUPPORTED_MEDIA',
    'NO_AUDIO',
    'CODEC_UNAVAILABLE',
    'TRANSCRIPTION_POLICY_REJECTED',
    'TRANSCRIPTION_ENDPOINT_UNREACHABLE',
    'SSRF_POLICY_REJECTED',
    'JOB_NOT_CANCELLABLE',
    'EVENT_CURSOR_EXPIRED',
    'ARTIFACT_EXPIRED',
    'CAPABILITY_EXPIRED',
    'COORDINATOR_UNAVAILABLE',
    'INTERNAL_ERROR',
] as const;

export type WaptionsStableErrorCode = (typeof WAPTIONS_STABLE_ERROR_CODES)[number];

export interface BoundedErrorDetails {
    operationId?: string;
    ids?: string[];
    issues?: Array<{
        code: string;
        path: string;
        message: string;
    }>;
    retryAfterMs?: number;
}

export interface ToolWarning {
    code: string;
    message: string;
    affectedIds?: string[];
}

/**
 * Portable immutable identity shared by browser, managed-runtime, and render adapters.
 *
 * Canonical paths deliberately remain in the managed source registry and path-grant subsystem.
 */
export interface ImmutableMediaIdentityV1 {
    schemaVersion: 1;
    contentDigest: Sha256ContentDigest;
    /** Portable V4 descriptor identity, distinct from the streamed content digest. */
    descriptorFingerprint: string;
    byteLength: number;
    immutableVersion: string;
    stableStatIdentity?: {
        device: string;
        fileId: string;
        modifiedNanoseconds: string;
    };
    streamMetadataRefs: Array<{
        kind: 'probe' | 'video-stream' | 'audio-stream' | 'subtitle-stream';
        ref: string;
        digest?: Sha256ContentDigest;
    }>;
}

/** Opaque authority returned only after a registry adapter has verified source identity. */
export interface VerifiedMediaHandleV1 {
    schemaVersion: 1;
    handleId: string;
    capabilityId: string;
    identity: ImmutableMediaIdentityV1;
    verifiedAt: string;
    expiresAt?: string;
}

/**
 * Output adapters receive this already-validated capability instead of reopening a caller path.
 * `outputName` is one safe final component, never an absolute or relative filesystem path.
 */
export interface StagedOutputDestinationCapabilityV1 {
    schemaVersion: 1;
    destinationId: string;
    grantId: string;
    stagingHandleId: string;
    mode: 'create-only' | 'overwrite-file';
    outputName: string;
    verifiedParentIdentity: string;
    overwriteConfirmationId?: string;
    expiresAt: string;
}

export interface StateToken {
    sessionId: string;
    projectId: string;
    sessionEpoch: string;
    sessionRevision: number;
    documentRevision: number;
    audioGraphRevision: number;
    narrativeRevision?: number;
    eventCursor: string;
}

export interface WaptionsToolSuccess<T> {
    ok: true;
    data: T;
    state: StateToken;
    warnings: ToolWarning[];
}

export interface WaptionsToolFailure {
    ok: false;
    error: {
        code: WaptionsStableErrorCode;
        message: string;
        retryable: boolean;
        details?: BoundedErrorDetails;
    };
    state?: StateToken;
}

interface SessionPathGrantBase {
    grantId: string;
    canonicalPath: string;
    createdAt: string;
    revokedAt?: string;
}

export type SessionPathGrant =
    | (SessionPathGrantBase & { kind: 'read-root'; allowCreate: false })
    | (SessionPathGrantBase & { kind: 'write-destination'; allowCreate: boolean })
    | (SessionPathGrantBase & { kind: 'overwrite-file'; allowCreate: false });

export interface ManagedIndexReferenceV1 {
    schemaVersion: 1;
    generation: number;
    relativeRef: string;
    digest: Sha256ContentDigest;
    entryCount: number;
}

export interface ManagedProjectEnvelopeV1 {
    schemaVersion: 1;
    project: {
        projectId: string;
        name: string;
        createdAt: string;
        updatedAt: string;
        status: 'active' | 'archived' | 'tombstoned';
        archivedAt?: string;
        tombstonedAt?: string;
    };
    sessionRevision: number;
    head: {
        manifestRef: 'manifest-v4.json';
        manifestDigest: Sha256ContentDigest;
        documentRevision: number;
        audioGraphRevision: number;
        narrativeRevision?: number;
        renderBackgroundColor: string;
    };
    indexes: {
        history: ManagedIndexReferenceV1;
        wal: ManagedIndexReferenceV1;
        events: ManagedIndexReferenceV1;
        receipts: ManagedIndexReferenceV1;
        transcripts: ManagedIndexReferenceV1;
        jobs: ManagedIndexReferenceV1;
        artifacts: ManagedIndexReferenceV1;
    };
    sourceRegistry: ManagedIndexReferenceV1;
    coordinator: {
        lastSessionEpoch: string;
        recoveryCount: number;
        recoveredAt?: string;
        recoveryOutcome?: 'clean' | 'wal-replayed' | 'wal-rolled-back' | 'degraded';
    };
}

export const WAPTIONS_JOB_STATES = [
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'stale',
    'interrupted',
] as const;

export const WAPTIONS_JOB_KINDS = [
    'media-probe-import',
    'contact-sheet',
    'thumbnail-strip',
    'waveform-audio-map',
    'silence-speech-map',
    'scene-cut-candidates',
    'review-proxy',
    'subtitle-transcription',
    'editorial-transcription',
    'bundle-import',
    'bundle-export',
    'headless-project-validation',
    'final-video-export',
    'cleanup-verification',
] as const;

export interface WaptionsJobRecordV1 {
    schemaVersion: 1;
    jobId: string;
    projectId: string;
    kind: (typeof WAPTIONS_JOB_KINDS)[number];
    inputDigest: Sha256ContentDigest;
    capturedState: StateToken;
    jobSequence: number;
    state: (typeof WAPTIONS_JOB_STATES)[number];
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    finishedAt?: string;
    stage: string;
    fraction?: number;
    message?: string;
    cancellationRequested: boolean;
    cancellationRequestedAt?: string;
    checkpointRef?: string;
    resultArtifactIds: string[];
    error?: {
        code: WaptionsStableErrorCode;
        message: string;
        retryable: boolean;
        details?: BoundedErrorDetails;
    };
}

export const WAPTIONS_EVENT_TYPES = [
    'session.recovered',
    'project.snapshot',
    'project.mutated',
    'history.changed',
    'job.changed',
    'artifact.created',
    'diagnostics.changed',
    'presence.changed',
    'view.changed',
    'source.invalidated',
] as const;

export interface WaptionsEventRecordV1 {
    schemaVersion: 1;
    cursor: string;
    type: (typeof WAPTIONS_EVENT_TYPES)[number];
    occurredAt: string;
    state: StateToken;
    sequence: number;
    data: Readonly<Record<string, unknown>>;
}
