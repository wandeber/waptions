import type {
    CanonicalToolCall,
    CoordinatorResult,
    JsonObject,
    ScopedMutationToolCall,
} from '../../mcp/contracts';
import type { EditorManifestV4 } from '../../../src/types/video';
import type { CanonicalEditorialTranscriptRecordV1 } from '../../../src/lib/editorial-transcription/transcript-body';

export interface ManagedProjectImportLimits {
    readonly maximumArchiveBytes: number;
    readonly maximumEntries: number;
    readonly maximumCentralDirectoryBytes: number;
    readonly maximumMetadataBytes: number;
    readonly maximumDetachedBodyBytes: number;
    readonly maximumAggregateDetachedBodyBytes: number;
    readonly maximumEntryBytes: number;
    readonly maximumAggregateBytes: number;
    readonly maximumReadChunkBytes: number;
}

/** Limits are deliberately lower than the browser compatibility reader because the managed
 * runtime has to keep one coordinator process responsive for every project. */
export const DEFAULT_MANAGED_PROJECT_IMPORT_LIMITS: ManagedProjectImportLimits = Object.freeze({
    maximumArchiveBytes: 256 * 1024 * 1024 * 1024,
    maximumEntries: 8_192,
    maximumCentralDirectoryBytes: 16 * 1024 * 1024,
    maximumMetadataBytes: 4 * 1024 * 1024,
    maximumDetachedBodyBytes: 64 * 1024 * 1024,
    maximumAggregateDetachedBodyBytes: 256 * 1024 * 1024,
    maximumEntryBytes: 64 * 1024 * 1024 * 1024,
    maximumAggregateBytes: 256 * 1024 * 1024 * 1024,
    maximumReadChunkBytes: 1024 * 1024,
});

/**
 * A path-free, already-authorized random-access source. Implementations normally wrap a
 * PathGrantAuthority VerifiedReadHandle or a coordinator-owned artifact lease. Neither an
 * operating-system path nor a file descriptor may escape this boundary.
 */
export interface ManagedProjectImportReadLease {
    readonly capabilityId: string;
    readonly byteLength: number;
    read(position: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
    assertCurrent(signal?: AbortSignal): Promise<void>;
    close(): Promise<void>;
}

export interface ManagedProjectImportPathAuthority {
    openPath(input: {
        readonly grantId: string;
        readonly path: string;
        readonly sessionId: string;
        readonly sessionEpoch: string;
        readonly signal?: AbortSignal;
    }): Promise<ManagedProjectImportReadLease>;
}

export interface ManagedProjectImportMedia {
    readonly sourceId: string;
    readonly mediaKind: 'video' | 'audio' | 'legacy-video';
    readonly byteLength: number;
    readonly contentDigest: `sha256:${string}`;
    /** The original descriptor is intentionally path-free. */
    readonly descriptor: JsonObject;
    /**
     * Private streaming access for the Core import port. This is valid only during the prepare
     * callback; a publisher must stage or consume it before that callback resolves.
     */
    stream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface ManagedProjectImportDetachedTranscript {
    readonly record: CanonicalEditorialTranscriptRecordV1;
    readonly descriptorIds: readonly string[];
}

export interface PreparedManagedProjectImport {
    readonly formatVersion: 1 | 2 | 3 | 4;
    readonly project: JsonObject;
    readonly manifest: EditorManifestV4;
    readonly media: readonly ManagedProjectImportMedia[];
    readonly transcripts: readonly ManagedProjectImportDetachedTranscript[];
    /** Canonical raw range/provenance records. Core owns their durable repositories. */
    readonly rangeRecords: readonly JsonObject[];
}

export interface ManagedLegacyProjectImportConverter {
    /**
     * Converts old V1/V2 metadata only after every referenced body has been bounded and verified.
     * The converter receives opaque streaming sources and may not retain them after it resolves.
     */
    convert(input: {
        readonly formatVersion: 1 | 2;
        readonly metadata: JsonObject;
        readonly media: readonly ManagedProjectImportMedia[];
        readonly signal?: AbortSignal;
    }): Promise<EditorManifestV4>;
}

export interface ManagedProjectImportReceiptAuthority {
    /**
     * Must look up the epoch-independent receipt before the importer consumes a capability. A
     * matching prior success is returned verbatim, preventing a replay from touching a stale path.
     */
    replay(call: ScopedMutationToolCall, signal?: AbortSignal): Promise<CoordinatorResult | null>;
    /**
     * This is the only publication boundary. Its implementation must re-check live guards and
     * persist the prepared Core state, source records, event and receipt in one transaction before
     * publishing a new project head. The import module never calls a coordinator mutator itself.
     */
    publishReceiptFirst(input: {
        readonly call: ScopedMutationToolCall;
        readonly prepared: PreparedManagedProjectImport;
        readonly signal?: AbortSignal;
    }): Promise<CoordinatorResult>;
}

export interface ManagedProjectImportServiceDependencies {
    readonly paths: ManagedProjectImportPathAuthority;
    readonly receipts: ManagedProjectImportReceiptAuthority;
    readonly legacy?: ManagedLegacyProjectImportConverter;
    readonly limits?: Partial<ManagedProjectImportLimits>;
}

/** The delegate has the same shape as the `waptions_project_import` handler injection slot. */
export type ManagedProjectImportDelegatedHandler = (
    call: CanonicalToolCall,
    context: { readonly signal: AbortSignal },
) => Promise<CoordinatorResult>;
