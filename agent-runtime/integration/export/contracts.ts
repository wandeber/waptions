import type { EditorManifestV4 } from '../../../src/types/video';
import type {
    StagedOutputDestinationCapabilityV1,
    StateToken,
} from '../../../src/types/waptions-agent-protocol';
import type {
    HeadlessRenderSnapshotV1,
} from '../../../src/lib/render-plan';
import type { StagedArtifact } from '../../artifacts/artifact-registry';
import type {
    StagedOutputPublication,
} from '../../path-grants/path-grant-authority';
import type {
    HeadlessRenderBackendDiagnostics,
    HeadlessRenderBackendName,
    HeadlessSourceRangeRead,
} from '../../render/contracts';
import type { MediaProbeMetadata } from '../../source-registry/contracts';

export type ManagedExportKind =
    | 'mp4-h264-aac'
    | 'webm'
    | 'portable-bundle'
    | 'reference-snapshot'
    | 'proof-record';

/** Canonical DurableJobScheduler kind for each admitted export contract. */
export type ManagedExportJobKind = `export:${ManagedExportKind}`;

export interface ManagedStreamingEntry {
    readonly name: string;
    readonly byteLength: number;
    readonly expectedDigest?: `sha256:${string}`;
    stream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
    revalidate(signal?: AbortSignal): Promise<void>;
}

export interface ManagedReferenceSourceV1 {
    readonly sourceId: string;
    readonly displayName: string;
    readonly mediaClass: 'video' | 'audio';
    readonly contentDigest: `sha256:${string}`;
    readonly byteLength: number;
    readonly descriptorFingerprint: string;
    readonly probe: MediaProbeMetadata;
}

export interface ManagedReferenceSnapshotV1 {
    readonly schemaVersion: 1;
    readonly apiVersion: string;
    readonly runtimeVersion: string;
    readonly schemaBundleDigest: `sha256:${string}`;
    readonly state: StateToken;
    readonly manifestDigest: `sha256:${string}`;
    readonly manifest: EditorManifestV4;
    readonly sources: readonly ManagedReferenceSourceV1[];
    readonly transcriptRecordIds: readonly `sha256:${string}`[];
    readonly historyEntryIds: readonly string[];
}

export interface ManagedProofEvidenceV1 {
    readonly schemaVersion: 1;
    readonly runtimeVersion: string;
    readonly pluginVersion: string;
    readonly schemaBundleDigest: `sha256:${string}`;
    readonly state: StateToken;
    readonly sources: readonly ManagedReferenceSourceV1[];
    readonly operations: readonly {
        readonly toolName: string;
        readonly idempotencyKey: string;
        readonly requestDigest: `sha256:${string}`;
        readonly resultingSessionRevision: number;
        readonly jobIds: readonly string[];
        readonly artifactIds: readonly string[];
    }[];
    readonly editSummary: Readonly<Record<string, string | number | boolean>>;
    readonly undoRedoEvidence: Readonly<Record<string, string | number | boolean>>;
    readonly reconnectEvidence: Readonly<Record<string, string | number | boolean>>;
    readonly memoryCaps: Readonly<Record<string, number>>;
}

export interface ManagedPortableBundleMaterial {
    readonly entries: readonly ManagedStreamingEntry[];
}

export interface ManagedExportMaterial {
    readonly renderSnapshot?: HeadlessRenderSnapshotV1;
    readonly portableBundle?: ManagedPortableBundleMaterial;
    readonly referenceSnapshot?: ManagedReferenceSnapshotV1;
    readonly proof?: ManagedProofEvidenceV1;
}

export interface ManagedExportRequest {
    readonly projectId: string;
    readonly jobId: string;
    readonly exportKind: ManagedExportKind;
    readonly destination: StagedOutputDestinationCapabilityV1;
    readonly material: ManagedExportMaterial;
    readonly signal?: AbortSignal;
    readonly onProgress?: (update: {
        readonly stage: string;
        readonly fraction?: number;
    }) => void;
}

export interface ManagedOutputCandidate {
    readonly outputId: string;
    readonly contentDigest: `sha256:${string}`;
    readonly byteLength: number;
    /**
     * Coordinator-only boundary. The export handler must never invoke this method.
     * The resulting registry write joins terminal job/artifact/event persistence.
     */
    preparePublication(signal?: AbortSignal): Promise<StagedOutputPublication>;
    abort(): Promise<void>;
}

export interface ManagedExportTerminalProposal {
    readonly jobKind: ManagedExportJobKind;
    readonly outputs: readonly ManagedOutputCandidate[];
    readonly artifacts: readonly StagedArtifact[];
    readonly jobResult: ManagedExportSuccess;
    /** Coordinator persists these in order in the same terminal transaction. */
    readonly events: readonly {
        readonly type: 'artifact.created' | 'job.changed';
        readonly data: Readonly<Record<string, unknown>>;
    }[];
}

export interface ManagedExportSuccess {
    readonly jobId: string;
    readonly jobKind: ManagedExportJobKind;
    readonly exportKind: ManagedExportKind;
    readonly outputId: string;
    readonly contentDigest: `sha256:${string}`;
    readonly byteLength: number;
    readonly mediaType: string;
    readonly planId?: string;
    readonly backend?: HeadlessRenderBackendName;
    readonly codecs?: {
        readonly video: string;
        readonly audio: string;
    };
    readonly durationSeconds?: number;
    readonly sourceRangesRead?: readonly HeadlessSourceRangeRead[];
    readonly diagnostics?: HeadlessRenderBackendDiagnostics;
    readonly warnings: readonly string[];
}

export interface ManagedExportJobService {
    prepare(request: ManagedExportRequest): Promise<ManagedExportTerminalProposal>;
}
