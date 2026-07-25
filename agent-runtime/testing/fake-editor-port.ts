import type {
    ManagedEditorPort,
    ManagedEditorPortFactory,
    ManagedEditorPersistencePort,
    ManagedEditorSnapshot,
} from '../coordinator/managed-editor-port';

export interface FakeEditorState {
    values: readonly string[];
}

export interface FakeEditorCommand {
    append: string;
}

export interface FakeEditorResult extends Record<string, unknown> {
    appended: string;
}

export function fakeSnapshot(values: readonly string[] = []): ManagedEditorSnapshot<FakeEditorState> {
    return {
        state: { values: [...values] },
        documentRevision: values.length,
        audioGraphRevision: 0,
        narrativeRevision: 0,
        manifestDigest: `fake:${values.join(',')}`,
        historyRevision: values.length,
        reachableSourceIds: [],
        transcriptRecordIds: [],
    };
}

class FakeEditorPort implements ManagedEditorPort<FakeEditorState, FakeEditorCommand, FakeEditorResult> {
    private current: ManagedEditorSnapshot<FakeEditorState>;

    constructor(
        snapshot: ManagedEditorSnapshot<FakeEditorState>,
        private readonly persistence: ManagedEditorPersistencePort<FakeEditorState, FakeEditorResult>,
    ) {
        this.current = structuredClone(snapshot);
    }

    snapshot(): ManagedEditorSnapshot<FakeEditorState> {
        return structuredClone(this.current);
    }

    async dispatch(input: {
        command: FakeEditorCommand;
        request: import('../coordinator/types').ManagedMutationEnvelope<FakeEditorCommand>;
    }): Promise<FakeEditorResult> {
        const values = [...this.current.state.values, input.command.append];
        const next = fakeSnapshot(values);
        const result = { appended: input.command.append };
        await this.persistence.commit({
            request: input.request,
            baseDocumentRevision: this.current.documentRevision,
            next,
            result,
            semanticLabel: 'append test value',
        });
        this.current = structuredClone(next);
        return result;
    }

    async hydrate(snapshot: ManagedEditorSnapshot<FakeEditorState>): Promise<void> {
        this.current = structuredClone(snapshot);
    }

    async close(): Promise<void> {}
}

export const fakeEditorPortFactory: ManagedEditorPortFactory<
    FakeEditorState,
    FakeEditorCommand,
    FakeEditorResult
> = {
    create: async (snapshot, persistence) => new FakeEditorPort(snapshot, persistence),
};
