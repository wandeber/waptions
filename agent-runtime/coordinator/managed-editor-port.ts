import type {
    EditorEngineEvent,
    EditorIdempotencyReceipt,
    EditorPersistenceCommit,
    EditorPersistencePort,
} from '../../src/lib/editor-engine';
import type { ManagedMutationEnvelope } from './types';

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
    plan?(command: Command): Result | Promise<Result>;
    dispatch(input: ManagedEditorDispatchInput<Command>): Promise<Result>;
    /**
     * Purely projects Core's exact committed payload into the coordinator envelope. It does not
     * persist, publish, allocate IDs, or create a second receipt/event.
     */
    snapshotFromCommit(commit: EditorPersistenceCommit): ManagedEditorSnapshot<State>;
    /**
     * Rehydrates the exact Core semantic receipt against the current managed head. This keeps the
     * public request hash separate from Core's internal request hash without persisting snapshots
     * in public receipts.
     */
    resultFromReceipt?(
        receipt: EditorIdempotencyReceipt,
        replayed: boolean,
    ): Result;
    editorEventSequence?(): number;
    rebaseSession?(
        snapshot: ManagedEditorSnapshot<State>,
        session: {
            sessionEpoch: string;
            sessionRevision: number;
            eventSequence?: number;
        },
    ): ManagedEditorSnapshot<State>;
    hydrate(snapshot: ManagedEditorSnapshot<State>): Promise<void>;
    close(): Promise<void>;
}

export interface ManagedEditorPublicationPort {
    publish(event: EditorEngineEvent): void | Promise<void>;
}

export interface ManagedEditorPortFactory<State = unknown, Command = unknown, Result = unknown> {
    create(
        snapshot: ManagedEditorSnapshot<State>,
        persistence: EditorPersistencePort,
        publication: ManagedEditorPublicationPort,
    ): Promise<ManagedEditorPort<State, Command, Result>>;
}
