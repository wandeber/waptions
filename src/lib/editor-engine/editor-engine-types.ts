import type { SerializablePatch } from '@/lib/serializable-patch';
import type { EditorManifestV4 } from '@/types/video';
import type {
    EditorCommandBatchRequest,
    EditorExpectedRevisions,
    EditorMutationToolName,
    EditorSemanticOperation,
} from './editor-command';
import type { EditorCommandFailure } from './editor-command-errors';
import type { EditorEngineListener } from './editor-events';

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
