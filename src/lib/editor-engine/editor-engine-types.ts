import type { SerializablePatch } from '@/lib/serializable-patch';
import type {
    AudioSourceDescriptor,
    EditorManifestV4,
    VideoSourceDescriptorV3,
} from '@/types/video';
import type {
    EditorCommandBatchRequest,
    EditorExpectedRevisions,
    EDITOR_ENGINE_API_VERSION,
    EDITOR_MEDIA_IMPORT_TOOL_NAME,
    EditorMutationToolName,
    EditorSemanticOperation,
} from './editor-command';
import type { EditorCommandFailure } from './editor-command-errors';
import type { EditorEngineListener } from './editor-events';
import type { EditorAssetHydration } from './editor-ports';
import type {
    EditorialTranscriptionPublicationHydration,
    EditorialTranscriptionPublicationRequest,
    SubtitleTranscriptionPublicationRequest,
} from './editor-transcription-publication';

export interface EditorEngineRevisions {
    sessionEpoch: string;
    sessionRevision: number;
    documentRevision: number;
    audioGraphRevision: number;
    narrativeRevision?: number;
}

export interface EditorHistorySummary {
    id: string;
    label: string;
    category: string;
    occurredAt: string;
    operationIds: string[];
    from: Omit<EditorEngineRevisions, 'sessionEpoch'>;
    to: Omit<EditorEngineRevisions, 'sessionEpoch'>;
}

export interface EditorHistoryEntry {
    summary: EditorHistorySummary;
    patches: SerializablePatch[];
    inversePatches: SerializablePatch[];
    byteSize: number;
    transcriptRecordIds: string[];
    sourceReferences: {
        videoSourceIds: string[];
        audioSourceIds: string[];
    };
    projectMetadata: {
        before: EditorProjectMetadata;
        after: EditorProjectMetadata;
    } | null;
}

export interface EditorHistoryState {
    past: EditorHistoryEntry[];
    future: EditorHistoryEntry[];
}

export interface EditorEngineSnapshot {
    projectId: string;
    project: EditorProjectMetadata;
    manifest: EditorManifestV4;
    revisions: EditorEngineRevisions;
    history: {
        past: EditorHistorySummary[];
        future: EditorHistorySummary[];
        currentIndex: number;
    };
    assetReferences: {
        videoSourceIds: string[];
        audioSourceIds: string[];
        transcriptRecordIds: string[];
    };
}

export interface EditorProjectMetadata {
    name: string;
}

export interface EditorCommandPlanSuccess {
    ok: true;
    planId: string;
    requestHash: string;
    expiresAt: string;
    base: EditorEngineRevisions;
    normalizedOperations: EditorSemanticOperation[];
    aliases: Record<string, string>;
    predicted: {
        sessionRevision: number;
        documentRevision: number;
        audioGraphRevision: number;
        narrativeRevision?: number;
    };
    affectedIds: string[];
    history: {
        label: string;
        category: string;
    };
    noOpReason?: string;
    requiresHydration: boolean;
    warnings: string[];
}

export type EditorCommandPlan = EditorCommandPlanSuccess | EditorCommandFailure;

export interface EditorCommandSuccess {
    ok: true;
    replayed: boolean;
    commandId: string;
    planId?: string;
    noOp: boolean;
    noOpReason?: string;
    historyEntryId: string | null;
    eventId: string | null;
    aliases: Record<string, string>;
    warnings: string[];
    snapshot: EditorEngineSnapshot;
}

export type EditorCommandResult = EditorCommandSuccess | EditorCommandFailure;

export type EditorMediaImportPlacement =
    | {
        kind: 'register-only';
    }
    | {
        kind: 'place';
        ordering: 'natural';
        timelineStartFrame: number;
        videoTrackId?: string;
        audioTrackId?: string;
    };

export interface EditorMediaImportRequest {
    apiVersion: typeof EDITOR_ENGINE_API_VERSION;
    toolName: typeof EDITOR_MEDIA_IMPORT_TOOL_NAME;
    sessionEpoch: string;
    expected: EditorExpectedRevisions;
    idempotencyKey: string;
    sources: {
        videoSourceDescriptors: VideoSourceDescriptorV3[];
        audioSourceDescriptors: AudioSourceDescriptor[];
    };
    placement: EditorMediaImportPlacement;
}

export interface EditorMediaImportSuccess extends EditorCommandSuccess {
    sourceIds: string[];
    placedClipIds: string[];
}

export type EditorMediaImportResult = EditorMediaImportSuccess | EditorCommandFailure;

export interface EditorialTranscriptionPublicationSuccess extends EditorCommandSuccess {
    publicationKind: 'editorial';
    recordIds: string[];
    coverageRecordIds: string[];
}

export type EditorialTranscriptionPublicationResult =
    | EditorialTranscriptionPublicationSuccess
    | EditorCommandFailure;

export interface SubtitleTranscriptionPublicationSuccess extends EditorCommandSuccess {
    publicationKind: 'subtitle';
    trackIds: string[];
}

export type SubtitleTranscriptionPublicationResult =
    | SubtitleTranscriptionPublicationSuccess
    | EditorCommandFailure;

export interface HistoryMutationRequest {
    apiVersion: '2026-07-25';
    toolName: Extract<EditorMutationToolName, 'waptions_history_apply'>;
    sessionEpoch: string;
    expected: EditorExpectedRevisions;
    idempotencyKey: string;
    steps?: number;
}

export interface HistoryJumpRequest extends HistoryMutationRequest {
    entryId: string;
    position: 'before' | 'after';
}

export interface EditorEngine {
    getSnapshot(): EditorEngineSnapshot;
    plan(request: EditorCommandBatchRequest): EditorCommandPlan;
    dispatch(request: EditorCommandBatchRequest): Promise<EditorCommandResult>;
    /**
     * Internal import boundary used after an adapter resolves public media handles. Hydration is
     * deliberately separate so capability identities never enter the durable request digest.
     */
    importMedia(
        request: EditorMediaImportRequest,
        hydration?: EditorAssetHydration,
    ): Promise<EditorMediaImportResult>;
    /**
     * Internal terminal boundary for immutable editorial transcript and coverage records.
     * Detached bodies are verified separately and never enter the durable request digest.
     */
    publishEditorialTranscription(
        request: EditorialTranscriptionPublicationRequest,
        hydration?: EditorialTranscriptionPublicationHydration,
    ): Promise<EditorialTranscriptionPublicationResult>;
    /** Internal terminal boundary for atomic single-track or diarized subtitle publication. */
    publishSubtitleTranscription(
        request: SubtitleTranscriptionPublicationRequest,
    ): Promise<SubtitleTranscriptionPublicationResult>;
    undo(request: HistoryMutationRequest): Promise<EditorCommandResult>;
    redo(request: HistoryMutationRequest): Promise<EditorCommandResult>;
    jumpToHistory(request: HistoryJumpRequest): Promise<EditorCommandResult>;
    subscribe(listener: EditorEngineListener): () => void;
    close(): Promise<void>;
}

export interface EditorEngineOptions {
    projectId: string;
    sessionEpoch: string;
    initialManifest: EditorManifestV4;
    initialProjectMetadata?: EditorProjectMetadata;
    initialSessionRevision?: number;
    ports: import('./editor-ports').EditorEnginePorts;
    initialHistory?: EditorHistoryState;
    historySummaryLimit?: number;
    planTtlMs?: number;
    initialEventSequence?: number;
    closePorts?: boolean;
}
