import type { ManagedRuntimeErrorShape } from './errors';
import type { ManagedEditorSnapshot } from './managed-editor-port';

export const MANAGED_RUNTIME_API_VERSION = '2026-07-25' as const;
export const MANAGED_RUNTIME_SCHEMA_VERSION = 1 as const;

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

export interface MutationExpectedRevisions {
    sessionRevision: number;
    documentRevision: number;
    audioGraphRevision?: number;
    narrativeRevision?: number;
}

export interface ManagedMutationEnvelope<Command = unknown> {
    apiVersion: typeof MANAGED_RUNTIME_API_VERSION;
    sessionId: string;
    sessionEpoch: string;
    expected: MutationExpectedRevisions;
    idempotencyKey: string;
    toolName: string;
    command: Command;
}

export interface ManagedMutationSuccess<Result = unknown> {
    ok: true;
    data: Result & { replayed: boolean };
    state: StateToken;
    warnings: readonly string[];
}

export interface ManagedMutationFailure {
    ok: false;
    error: ManagedRuntimeErrorShape;
    state?: StateToken;
}

export type ManagedMutationResult<Result = unknown> =
    | ManagedMutationSuccess<Result>
    | ManagedMutationFailure;

export interface ManagedPlaybackState {
    revision: number;
    presenterViewId: string | null;
    playing: boolean;
    outputSample: number;
    rate: number;
    masterVolume: number;
    masterMuted: boolean;
}

export interface ManagedSourceRegistryRecord {
    sourceId: string;
    immutableVersion: string;
    readGrantId: string;
    byteLength: number;
    digest: string;
    streamSignature: string;
    registeredAt: string;
    releasedAt?: string;
}

export interface ManagedProjectEnvelopeV1<State = unknown> {
    schemaVersion: typeof MANAGED_RUNTIME_SCHEMA_VERSION;
    projectId: string;
    sessionId: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    sessionRevision: number;
    editor: ManagedEditorSnapshot<State>;
    eventSequence: number;
    receiptRevision: number;
    jobRevision: number;
    artifactRevision: number;
    grantRevision: number;
    sourceRegistryRevision: number;
    playback: ManagedPlaybackState;
    sourceRegistry: readonly ManagedSourceRegistryRecord[];
    archivedAt?: string;
    deletedAt?: string;
    lastCoordinatorEpoch: string;
    recoveryCount: number;
}

export interface ManagedSessionSummary {
    projectId: string;
    sessionId: string;
    name: string;
    sessionRevision: number;
    documentRevision: number;
    archived: boolean;
    recovered: boolean;
}
