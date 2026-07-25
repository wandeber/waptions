import type { StagedArtifact } from '../../artifacts/artifact-registry';
import type { StateToken } from '../../coordinator/types';
import type { DurableWrite } from '../../persistence/managed-filesystem-store';
import type { VerifiedReadHandle } from '../../path-grants/path-grant-authority';
import type {
    EditorialSpeakerMode,
    HalfOpenSampleRange,
    Sha256Digest,
    TranscriptionAcquisitionWindowV2,
    TranscriptionCoverageRecordV2,
} from '../../../src/types/editorial';

export const MANAGED_TRANSCRIPTION_JOB_KINDS = [
    'editorial-transcription',
    'subtitle-transcription',
] as const;
export type ManagedTranscriptionJobKind = (typeof MANAGED_TRANSCRIPTION_JOB_KINDS)[number];

export type ManagedTranscriptionProviderPolicy =
    | {
        readonly kind: 'managed-local-endpoint';
        /**
         * Omission uses the product's process-local default capability. Only the opaque minted
         * capability is retained while the job runs; the URL never enters durable job state.
         */
        readonly endpointCapabilityId?: string;
        readonly credentialCapabilityId?: string;
    }
    | {
        readonly kind: 'managed-server-endpoint';
        readonly endpointCapabilityId: string;
        readonly credentialCapabilityId?: string;
    }
    | {
        readonly kind: 'browser-local';
    };

export interface ManagedTranscriptionSourceRequest {
    readonly sourceId: string;
    readonly sourceFingerprint: Sha256Digest;
    /** Full source length on the canonical source-zero 16 kHz grid. */
    readonly sourceSampleCount: number;
    readonly ranges: readonly HalfOpenSampleRange[];
}

export interface ManagedTranscriptionJobInputV1 {
    readonly schemaVersion: 1;
    readonly kind: ManagedTranscriptionJobKind;
    readonly projectId: string;
    readonly capturedState: StateToken;
    readonly providerPolicy: ManagedTranscriptionProviderPolicy;
    readonly language: string | null;
    readonly speakerMode: EditorialSpeakerMode;
    readonly contextSamples: number;
    readonly sources: readonly ManagedTranscriptionSourceRequest[];
    /** Opaque target IDs interpreted only by the injected authoritative Core publisher. */
    readonly targetIds: readonly string[];
}

export interface ManagedTranscriptionCheckpointSourceV1 {
    readonly sourceId: string;
    readonly sourceFingerprint: Sha256Digest;
    readonly acquisitionProfileDigest: Sha256Digest;
    readonly requestKey: Sha256Digest;
    readonly expectedCoverageRecordIds: readonly Sha256Digest[];
    readonly completedWindowIds: readonly Sha256Digest[];
    readonly chunkRecordIds: readonly Sha256Digest[];
    /** Persisted independently so replaying another source cannot reset this retry budget. */
    readonly casAttempt: number;
    readonly mergedRecordId?: Sha256Digest;
    readonly coverageRecordId?: Sha256Digest;
}

/**
 * Durable checkpoint schema. It intentionally contains only opaque identities and counters.
 * Provider bytes, transcript text, endpoint material and credentials belong to process-local
 * authorities or the private content-addressed repository.
 */
export interface ManagedTranscriptionCheckpointV1 {
    readonly schemaVersion: 1;
    readonly kind: ManagedTranscriptionJobKind;
    readonly inputDigest: Sha256Digest;
    readonly sourceIndex: number;
    readonly sources: readonly ManagedTranscriptionCheckpointSourceV1[];
    readonly casAttempt: number;
}

export interface ManagedTranscriptionSourceResult {
    readonly sourceId: string;
    readonly sourceFingerprint: Sha256Digest;
    readonly requestKey: Sha256Digest;
    readonly acquisitionProfileDigest: Sha256Digest;
    readonly mergedRecordId: Sha256Digest;
    readonly coverageRecordId: Sha256Digest;
    readonly acquiredWindowCount: number;
    readonly reusedWindowCount: number;
}

export interface ManagedTranscriptionJobResultV1 {
    readonly schemaVersion: 1;
    readonly kind: ManagedTranscriptionJobKind;
    readonly sourceCount: number;
    readonly acquiredWindowCount: number;
    readonly reusedWindowCount: number;
    readonly publicationId: string;
    readonly sources: readonly ManagedTranscriptionSourceResult[];
}

export interface ManagedEndpointCapabilityScope {
    readonly projectId: string;
    readonly sessionEpoch: string;
}

export interface ManagedEndpointCapabilityIssueRequest {
    readonly endpoint: string;
    readonly kind: 'local' | 'server';
    readonly scope: ManagedEndpointCapabilityScope;
    readonly lifetimeMilliseconds: number;
}

export interface ResolvedManagedEndpointCapability {
    readonly capabilityId: string;
    readonly kind: 'local' | 'server';
    readonly endpoint: string;
    readonly endpointIdentityDigest: Sha256Digest;
    readonly scope: ManagedEndpointCapabilityScope;
    readonly expiresAtMilliseconds: number;
    /** Present only for a local capability and used by the Undici lookup callback. */
    readonly pinnedLoopbackAddress?: string;
    readonly pinnedLoopbackFamily?: 4 | 6;
}

export interface ManagedCredentialCapabilityIssueRequest {
    readonly secret: string;
    readonly scope: ManagedEndpointCapabilityScope;
    readonly endpointCapabilityId?: string;
    readonly lifetimeMilliseconds: number;
}

export interface ResolvedManagedCredentialCapability {
    readonly capabilityId: string;
    readonly secret: string;
    readonly scope: ManagedEndpointCapabilityScope;
    readonly endpointCapabilityId?: string;
    readonly expiresAtMilliseconds: number;
}

export interface ManagedEndpointCapabilityAuthorityPort {
    issue(request: ManagedEndpointCapabilityIssueRequest): Promise<string>;
    resolve(
        capabilityId: string,
        scope: ManagedEndpointCapabilityScope,
    ): Promise<ResolvedManagedEndpointCapability>;
    revoke(capabilityId: string): void;
}

export interface ManagedCredentialCapabilityAuthorityPort {
    issue(request: ManagedCredentialCapabilityIssueRequest): string;
    resolve(
        capabilityId: string,
        scope: ManagedEndpointCapabilityScope,
        endpointCapabilityId: string,
    ): ResolvedManagedCredentialCapability;
    revoke(capabilityId: string): void;
}

export interface ManagedRetainedTranscriptionSourcePort {
    openRetainedSource(
        projectId: string,
        sourceId: string,
        signal: AbortSignal,
    ): Promise<VerifiedReadHandle>;
}

export interface ManagedTranscriptionFreshnessPort {
    assertCurrent(input: {
        readonly projectId: string;
        readonly capturedState: StateToken;
        readonly sources: readonly Pick<
            ManagedTranscriptionSourceRequest,
            'sourceId' | 'sourceFingerprint'
        >[];
        readonly targetIds: readonly string[];
        readonly signal: AbortSignal;
    }): Promise<void>;
}

export interface ManagedChunkRecordV1 {
    readonly schemaVersion: 1;
    readonly recordId: Sha256Digest;
    readonly sourceFingerprint: Sha256Digest;
    readonly acquisitionProfileDigest: Sha256Digest;
    readonly windowId: Sha256Digest;
    readonly decoded: HalfOpenSampleRange;
    readonly canonicalModel: string;
    readonly words: readonly ManagedChunkWordV1[];
}

export interface ManagedChunkWordV1 {
    readonly text: string;
    readonly startSample: number;
    readonly endSample: number;
    readonly probability: number | null;
    readonly speaker: {
        readonly providerSpeakerId: string;
        readonly evidenceKey: string;
    } | null;
}

export interface ManagedMergedWordV1 extends ManagedChunkWordV1 {
    readonly windowId: Sha256Digest;
    readonly tokenIndex: number;
}

export interface ManagedTranscriptManifestV1 {
    readonly schemaVersion: 1;
    readonly recordId: Sha256Digest;
    readonly sourceFingerprint: Sha256Digest;
    readonly sourceSampleCount: number;
    readonly language: string | null;
    readonly speakerMode: EditorialSpeakerMode;
    readonly canonicalModel: string;
    readonly coreCoverage: readonly HalfOpenSampleRange[];
    readonly chunkRecordIds: readonly Sha256Digest[];
    readonly mergedWordsRecordId: Sha256Digest;
}

export interface ManagedCoverageFamilySnapshot {
    readonly records: readonly TranscriptionCoverageRecordV2[];
}

export interface ManagedCoverageHeadReaderPort {
    readCoverageFamily(input: {
        readonly projectId: string;
        readonly sourceFingerprint: Sha256Digest;
        readonly acquisitionProfileDigest: Sha256Digest;
    }): Promise<readonly TranscriptionCoverageRecordV2[]>;
}

export interface ManagedTranscriptionCasPort {
    listCompatibleCoverage(input: {
        readonly projectId: string;
        readonly sourceFingerprint: Sha256Digest;
        readonly acquisitionProfileDigest: Sha256Digest;
    }): Promise<ManagedCoverageFamilySnapshot>;
    getChunk(recordId: Sha256Digest): Promise<ManagedChunkRecordV1 | null>;
    stageChunk(record: ManagedChunkRecordV1, signal: AbortSignal): Promise<void>;
    stageMergedTranscript(input: {
        readonly sourceFingerprint: Sha256Digest;
        readonly acquisitionProfileDigest: Sha256Digest;
        readonly sourceSampleCount: number;
        readonly language: string | null;
        readonly speakerMode: EditorialSpeakerMode;
        readonly canonicalModel: string;
        readonly coreCoverage: readonly HalfOpenSampleRange[];
        readonly chunks: readonly {
            readonly recordId: Sha256Digest;
            readonly windowId: Sha256Digest;
            readonly decoded: HalfOpenSampleRange;
        }[];
        readonly signal: AbortSignal;
    }): Promise<ManagedTranscriptManifestV1>;
    getManifest(recordId: Sha256Digest): Promise<ManagedTranscriptManifestV1 | null>;
    iterateMergedWords(
        mergedWordsRecordId: Sha256Digest,
        signal?: AbortSignal,
    ): AsyncIterable<ManagedMergedWordV1>;
    verifyRecord(recordId: Sha256Digest, signal?: AbortSignal): Promise<boolean>;
    prepareCoverageUpdate(input: {
        readonly projectId: string;
        readonly sourceFingerprint: Sha256Digest;
        readonly acquisitionProfileDigest: Sha256Digest;
        readonly expectedCoverageRecordIds: readonly Sha256Digest[];
        readonly record: TranscriptionCoverageRecordV2;
        readonly pinRecordIds: readonly Sha256Digest[];
        readonly signal: AbortSignal;
    }): Promise<PreparedManagedCoverageUpdate | null>;
}

/**
 * Opaque process-local commit capability. The proposal carries only this handle; its writes are
 * revealed to the owning coordinator at the single terminal transaction boundary.
 */
export interface PreparedManagedCommitCapability {
    readonly capabilityId: string;
    readonly projectId: string;
    readonly kind: 'editorial' | 'subtitle' | 'coverage';
    durableWrites(): readonly DurableWrite[];
    accept(): Promise<void> | void;
    reject(): Promise<void> | void;
}

export interface PreparedManagedCoverageUpdate extends PreparedManagedCommitCapability {
    readonly kind: 'coverage';
    readonly sourceFingerprint: Sha256Digest;
    readonly acquisitionProfileDigest: Sha256Digest;
    readonly expectedCoverageRecordIds: readonly Sha256Digest[];
    readonly coverageRecordId: Sha256Digest;
    readonly pinRecordIds: readonly Sha256Digest[];
}

export interface CoreTranscriptionPublisher {
    /**
     * The central adapter wraps Core's typed `transcriptionPublication` commit intent in this
     * process-local capability. It must preserve Core's coverage CAS and stale error semantics;
     * the managed handler never calls a second publication boundary.
     */
    prepareEditorialPublication(input: {
        readonly projectId: string;
        readonly capturedState: StateToken;
        readonly targetIds: readonly string[];
        readonly sources: readonly ManagedTranscriptionSourceResult[];
        readonly signal: AbortSignal;
    }): Promise<PreparedManagedCommitCapability>;
    prepareSubtitlePublication(input: {
        readonly projectId: string;
        readonly capturedState: StateToken;
        readonly targetIds: readonly string[];
        readonly sources: readonly ManagedTranscriptionSourceResult[];
        readonly signal: AbortSignal;
    }): Promise<PreparedManagedCommitCapability>;
}

export interface ManagedTranscriptionTerminalProposalV1 {
    readonly schemaVersion: 1;
    readonly proposalId: string;
    readonly projectId: string;
    readonly kind: ManagedTranscriptionJobKind;
    readonly inputDigest: Sha256Digest;
    readonly preparedCorePublication: PreparedManagedCommitCapability;
    readonly preparedCoverageUpdates: readonly PreparedManagedCoverageUpdate[];
    readonly stagedArtifacts: readonly StagedArtifact[];
    readonly transcriptRecordIds: readonly Sha256Digest[];
    readonly coverageRecordIds: readonly Sha256Digest[];
    readonly chunkRecordIds: readonly Sha256Digest[];
    readonly sourceIds: readonly string[];
}

export interface ManagedTranscriptionTerminalPublication {
    readonly artifacts: readonly StagedArtifact[];
    readonly transcription: ManagedTranscriptionTerminalProposalV1;
}

export interface ManagedProviderTranscript {
    readonly canonicalModel: string;
    readonly words: readonly ManagedChunkWordV1[];
    /** Releases the aggregate response/projection memory lease after the chunk is staged. */
    release(): void;
}

export interface ManagedProviderRequest {
    readonly endpoint: ResolvedManagedEndpointCapability;
    readonly credential?: ResolvedManagedCredentialCapability;
    readonly wav: Blob;
    readonly sourceFingerprint: Sha256Digest;
    readonly window: TranscriptionAcquisitionWindowV2;
    readonly language: string | null;
    readonly speakerMode: EditorialSpeakerMode;
    readonly signal: AbortSignal;
}

export interface ManagedTranscriptionProviderPort {
    transcribe(request: ManagedProviderRequest): Promise<ManagedProviderTranscript>;
}

export interface ManagedDecodedWindow {
    readonly sampleCount: number;
    readonly hasAudioStream: boolean;
    readonly wav: Blob | null;
    release(): void;
}

export interface ManagedTranscriptionDecoderPort {
    decode(input: {
        readonly source: import('../../../src/lib/media-byte-source/types').MediaByteSource;
        readonly sourceSampleCount: number;
        readonly window: TranscriptionAcquisitionWindowV2;
        readonly signal: AbortSignal;
    }): Promise<ManagedDecodedWindow>;
}

export interface ManagedTranscriptionFactoryDependencies {
    readonly endpoints: ManagedEndpointCapabilityAuthorityPort;
    readonly credentials: ManagedCredentialCapabilityAuthorityPort;
    readonly sources: ManagedRetainedTranscriptionSourcePort;
    readonly freshness: ManagedTranscriptionFreshnessPort;
    readonly cas: ManagedTranscriptionCasPort;
    readonly publisher: CoreTranscriptionPublisher;
    readonly provider?: ManagedTranscriptionProviderPort;
    readonly decoder?: ManagedTranscriptionDecoderPort;
}
