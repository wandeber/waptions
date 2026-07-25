import type { ManagedMutationEnvelope, StateToken } from './types';

export interface ManagedEditorSnapshot<State = unknown> {
    state: State;
    documentRevision: number;
    audioGraphRevision: number;
    narrativeRevision?: number;
    manifestDigest: string;
    historyRevision: number;
    reachableSourceIds: readonly string[];
    transcriptRecordIds: readonly string[];
}

export interface ManagedEditorPersistenceCommit<State = unknown, Result = unknown> {
    request: ManagedMutationEnvelope;
    baseDocumentRevision: number;
    next: ManagedEditorSnapshot<State>;
    result: Result;
    semanticLabel: string;
}

export interface ManagedEditorPersistenceCommitResult {
    state: StateToken;
}

/**
 * Coordinator-owned implementation of Core's EditorPersistencePort atomic boundary.
 *
 * Core calls this exactly once after its pure planning, dependent transforms, hydration, and V4
 * validation. Core remains responsible for publishing its prepared head after this promise
 * resolves. The coordinator must never run a second prepare/publish pipeline.
 */
export interface ManagedEditorPersistencePort<State = unknown, Result = unknown> {
    commit(
        input: ManagedEditorPersistenceCommit<State, Result>,
    ): Promise<ManagedEditorPersistenceCommitResult>;
}

export interface ManagedEditorDispatchInput<Command = unknown> {
    command: Command;
    request: ManagedMutationEnvelope<Command>;
}

/**
 * Minimal adapter around the instance-scoped Core EditorEngine.
 *
 * `dispatch` is Core's only mutation pipeline and uses the injected persistence port. It returns
 * only after Core has committed through that port and published the new snapshot once.
 */
export interface ManagedEditorPort<State = unknown, Command = unknown, Result = unknown> {
    snapshot(): ManagedEditorSnapshot<State>;
    dispatch(input: ManagedEditorDispatchInput<Command>): Promise<Result>;
    hydrate(snapshot: ManagedEditorSnapshot<State>): Promise<void>;
    close(): Promise<void>;
}

export interface ManagedEditorPortFactory<State = unknown, Command = unknown, Result = unknown> {
    create(
        snapshot: ManagedEditorSnapshot<State>,
        persistence: ManagedEditorPersistencePort<State, Result>,
    ): Promise<ManagedEditorPort<State, Command, Result>>;
}
