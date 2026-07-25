import type { FileHandle } from 'node:fs/promises';
import type {
    EditorAssetHydration,
} from '../../../src/lib/editor-engine/editor-ports';
import type {
    EditorMediaImportPlacement,
    EditorMediaImportRequest,
    EditorMediaImportResult,
} from '../../../src/lib/editor-engine/editor-engine-types';
import type {
    AudioSourceDescriptor,
    VideoSourceDescriptorV3,
} from '../../../src/types/video';
import type {
    ImmutableMediaIdentityV1,
    VerifiedMediaHandleV1,
} from '../../../src/types/waptions-agent-protocol';
import type { StagedArtifact } from '../../artifacts/artifact-registry';
import type {
    MediaProbeMetadata,
    RegisteredImmutableMediaIdentity,
} from '../../source-registry/contracts';

export type CanonicalMediaReviewKind =
    | 'contact-sheet'
    | 'thumbnail-strip'
    | 'waveform-audio-map'
    | 'silence-speech-map'
    | 'scene-cut-candidates'
    | 'transcription-assisted'
    | 'review-proxy';

export interface ManagedMediaProbeRequest {
    readonly operationId: string;
    readonly sessionId: string;
    readonly sessionEpoch: string;
    readonly grantId: string;
    readonly paths?: readonly string[];
    readonly selection?: {
        readonly kind: 'granted-directory';
        readonly maximumResults: number;
        readonly maximumCandidates?: number;
        readonly requireVideo?: boolean;
    };
    readonly hashPolicy?: 'always' | 'if-needed';
    readonly signal?: AbortSignal;
}

export interface ManagedMediaProbeResponse {
    readonly handles: readonly VerifiedMediaHandleV1[];
    /** Path-free technical inventory used to choose import/review operations. */
    readonly media: readonly {
        readonly handle: VerifiedMediaHandleV1;
        readonly displayName: string;
        readonly mediaClass: 'video' | 'audio';
        readonly mimeType: string;
        readonly metadata: MediaProbeMetadata;
    }[];
    /** Probe is synchronous and never fabricates durable jobs. */
    readonly jobIds: readonly [];
}

export interface ManagedMediaCatalogRecord {
    readonly handle: VerifiedMediaHandleV1;
    readonly sourceId: string;
    readonly displayName: string;
    readonly mimeType: string;
    readonly lastModified: number;
    readonly registeredIdentity: RegisteredImmutableMediaIdentity;
    readonly metadata: MediaProbeMetadata;
    readonly class: 'video' | 'audio';
    readonly videoDescriptor?: VideoSourceDescriptorV3;
    readonly audioDescriptor?: AudioSourceDescriptor;
}

/**
 * Private authority used by media workers. Implementations may retain paths internally, but every
 * value crossing this interface is descriptor-bound and path-free.
 */
export interface ManagedMediaHandleCatalogPort {
    get(handleId: string): ManagedMediaCatalogRecord | undefined;
    getBySourceId(sourceId: string): ManagedMediaCatalogRecord | undefined;
    open(
        handleId: string,
        signal?: AbortSignal,
    ): Promise<ManagedMediaOpenLease>;
    restoreCommitted(input: {
        readonly grantId: string;
        readonly scope: { readonly sessionId: string; readonly sessionEpoch: string };
        readonly record: ManagedMediaCatalogRecord;
    }): void;
    pinUncommitted(handleIds: readonly string[]): () => Promise<void>;
    releaseUncommitted(handleIds: readonly string[]): Promise<void>;
    markCommitted(sourceIds: readonly string[]): void;
    revoke(handleId: string): void;
}

export interface ManagedMediaOpenLease {
    readonly handleId: string;
    readonly sourceCapabilityId: string;
    readonly displayName: string;
    readonly identity: RegisteredImmutableMediaIdentity;
    readonly fileHandle: FileHandle;
    assertCurrent(signal?: AbortSignal): Promise<void>;
    close(): Promise<void>;
}

export interface ManagedMediaImportRequest {
    readonly request: Omit<EditorMediaImportRequest, 'sources' | 'placement'>;
    readonly mediaHandles: readonly string[];
    readonly placement: EditorMediaImportPlacement;
    readonly signal?: AbortSignal;
}

/**
 * The coordinator implementation must bind capability revalidation to the same persistence
 * boundary used by EditorEngine.importMedia. This prevents a revoke race between preparation and
 * Core's WAL/snapshot/history/source-registration commit.
 */
export interface CoreMediaImportPort {
    /**
     * Optional receipt-first seam. Production resolves a prior import before it inspects or pins
     * a transient media handle, so a lost response remains replayable after restart or revocation.
     */
    replayImport?(request: ManagedMediaImportRequest): Promise<
        import('../../../src/lib/editor-engine').EditorMediaImportResult | null
    >;
    importMedia(input: {
        request: EditorMediaImportRequest;
        hydration: EditorAssetHydration;
        revalidate(signal?: AbortSignal): Promise<void>;
        /**
         * Invoke after the durable Core import commit succeeds and before returning its result.
         * This converts the pinned transient handles into retained source authority.
         */
        commitAuthority(): void;
        signal?: AbortSignal;
    }): Promise<EditorMediaImportResult>;
}

export interface ManagedMediaImportResponse {
    readonly sourceIds: readonly string[];
    readonly placedClipIds: readonly string[];
    readonly result: EditorMediaImportResult;
}

export interface ManagedMediaReviewRequest {
    readonly projectId: string;
    readonly jobId: string;
    readonly sourceIds: readonly string[];
    readonly reviewKind: CanonicalMediaReviewKind;
    readonly intervalsSeconds?: readonly {
        readonly startSeconds: number;
        readonly endSeconds: number;
    }[];
    readonly maximumSamples?: number;
}

export interface ManagedMediaReviewJobResult {
    readonly sourceIds: readonly string[];
    readonly reviewKind: Exclude<CanonicalMediaReviewKind, 'transcription-assisted'>;
    readonly artifactIds: readonly string[];
    readonly terminalPublication: {
        readonly artifacts: readonly StagedArtifact[];
    };
}

export interface ManagedMediaDescriptorProjection {
    readonly identity: ImmutableMediaIdentityV1;
    readonly hydration: EditorAssetHydration['videoSources'][number]
        | EditorAssetHydration['audioSources'][number];
}
