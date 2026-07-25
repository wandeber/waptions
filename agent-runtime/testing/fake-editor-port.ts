import type {
    ManagedEditorPort,
    ManagedEditorPortFactory,
    ManagedEditorSnapshot,
} from '../coordinator/managed-editor-port';
import type {
    EditorCommandSuccess,
    EditorEngineSnapshot,
    EditorPersistenceCommit,
    EditorPersistencePort,
} from '../../src/lib/editor-engine';
import type { ManagedMutationEnvelope } from '../coordinator/types';

export interface FakeEditorState {
    values: readonly string[];
    projectId: string;
    eventSequence: number;
}

export interface FakeEditorCommand {
    append: string;
}

export interface FakeEditorResult extends EditorCommandSuccess, Record<string, unknown> {
    appended: string;
}

export function fakeSnapshot(
    values: readonly string[] = [],
    projectId = 'fake-project',
    eventSequence = 0,
): ManagedEditorSnapshot<FakeEditorState> {
    return {
        state: { values: [...values], projectId, eventSequence },
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
        private readonly persistence: EditorPersistencePort,
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
        const next = fakeSnapshot(
            values,
            this.current.state.projectId,
            this.current.state.eventSequence + 1,
        );
        const commit = fakeEditorCommit(
            this.current.state.projectId,
            input.request,
            this.current,
            next,
        );
        await this.persistence.commit(commit);
        this.current = fakeSnapshotFromCommit(commit);
        return fakeEditorResultFromCommit(commit, input.command.append);
    }

    snapshotFromCommit(commit: EditorPersistenceCommit): ManagedEditorSnapshot<FakeEditorState> {
        return fakeSnapshotFromCommit(commit);
    }

    rebaseSession(
        snapshot: ManagedEditorSnapshot<FakeEditorState>,
        session: {
            sessionEpoch: string;
            sessionRevision: number;
            eventSequence?: number;
        },
    ): ManagedEditorSnapshot<FakeEditorState> {
        return {
            ...structuredClone(snapshot),
            state: {
                ...structuredClone(snapshot.state),
                eventSequence: session.eventSequence ?? snapshot.state.eventSequence,
            },
        };
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

export function fakeEditorCommit(
    projectId: string,
    request: ManagedMutationEnvelope<FakeEditorCommand>,
    previousManaged: ManagedEditorSnapshot<FakeEditorState>,
    nextManaged: ManagedEditorSnapshot<FakeEditorState>,
    options: { noOp?: boolean } = {},
): EditorPersistenceCommit {
    if (request.toolName !== 'waptions_edit_apply') {
        throw new Error('The fake Core editor requires the real edit mutation tool name.');
    }
    const noOp = options.noOp === true;
    const nextSessionRevision = request.expected.sessionRevision + (noOp ? 0 : 1);
    const nextEventSequence = previousManaged.state.eventSequence + (noOp ? 0 : 1);
    const previous = fakeEngineSnapshot(
        projectId,
        request,
        previousManaged,
        request.expected.sessionRevision,
    );
    const next = fakeEngineSnapshot(
        projectId,
        request,
        nextManaged,
        nextSessionRevision,
    );
    const occurredAt = new Date().toISOString();
    const commandId = `command-${request.idempotencyKey}`;
    const eventId = noOp ? null : `event-${request.idempotencyKey}`;
    const historyEntryId = noOp ? null : `history-${request.idempotencyKey}`;
    const semanticResult: Omit<FakeEditorResult, 'snapshot' | 'replayed'> = {
        ok: true,
        commandId,
        noOp,
        ...(noOp ? { noOpReason: 'unchanged' } : {}),
        historyEntryId,
        eventId,
        aliases: {},
        warnings: [],
        appended: request.command.append,
    };
    return {
        schemaVersion: 1,
        projectId,
        toolName: 'waptions_edit_apply',
        commandId,
        transaction: {
            walTransactionId: `wal-${request.idempotencyKey}`,
            preparedAt: occurredAt,
            operationIds: noOp ? [] : ['fake-operation'],
            fromDocumentRevision: previousManaged.documentRevision,
            toDocumentRevision: nextManaged.documentRevision,
        },
        sessionState: {
            sessionEpoch: request.sessionEpoch,
            sessionRevision: nextSessionRevision,
            eventSequence: nextEventSequence,
            projectName: 'Fake project',
            documentRevision: nextManaged.documentRevision,
            audioGraphRevision: nextManaged.audioGraphRevision,
            ...(nextManaged.narrativeRevision === undefined
                ? {}
                : { narrativeRevision: nextManaged.narrativeRevision }),
        },
        previous,
        next,
        history: { past: [], future: [] },
        transcriptPins: {
            durableRecordIds: [],
            historyRecordIds: [],
            redoRecordIds: [],
        },
        sourcePins: {
            current: { videoSourceIds: [], audioSourceIds: [] },
            history: { videoSourceIds: [], audioSourceIds: [] },
            redo: { videoSourceIds: [], audioSourceIds: [] },
        },
        sourceRegistrations: { videoSources: [], audioSources: [] },
        event: noOp
            ? null
            : {
                id: eventId!,
                sequence: nextEventSequence,
                type: 'project.mutated',
                projectId,
                occurredAt,
                commandId,
                operationIds: ['fake-operation'],
                historyEntryId: historyEntryId!,
                revisions: next.revisions,
            },
        receipt: {
            toolName: 'waptions_edit_apply',
            key: request.idempotencyKey,
            value: {
                toolName: 'waptions_edit_apply',
                idempotencyKey: request.idempotencyKey,
                requestHash: `sha256:${'a'.repeat(64)}`,
                result: semanticResult,
            },
        },
    };
}

function fakeEngineSnapshot(
    projectId: string,
    request: ManagedMutationEnvelope<FakeEditorCommand>,
    managed: ManagedEditorSnapshot<FakeEditorState>,
    sessionRevision: number,
): EditorEngineSnapshot {
    return {
        projectId,
        project: { name: 'Fake project' },
        manifest: {
            version: 4,
            revision: managed.documentRevision,
            audioGraphRevision: 0,
            renderProfile: {
                fps: { numerator: 30, denominator: 1 },
                width: 1_920,
                height: 1_080,
                audioSampleRate: 48_000,
                isFrameRateLocked: true,
                isCanvasSizeLocked: true,
            },
            renderBackgroundColor: '#000000',
            subtitleTracks: [],
            videoSourceDescriptors: [],
            videoClips: [],
            videoTracks: managed.state.values.map((value, index) => ({
                id: `fake-video-track-${index}`,
                name: value,
                visible: true,
                locked: false,
            })),
            audioSourceDescriptors: [],
            audioTracks: [],
            activeSubtitleTrackId: null,
            transcriptionByTrackId: {},
            globalEditingMode: 'ripple',
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
        },
        revisions: {
            sessionEpoch: request.sessionEpoch,
            sessionRevision,
            documentRevision: managed.documentRevision,
            audioGraphRevision: 0,
            narrativeRevision: 0,
        },
        history: { past: [], future: [], currentIndex: -1 },
        assetReferences: {
            videoSourceIds: [],
            audioSourceIds: [],
            transcriptRecordIds: [],
        },
    };
}

export function fakeSnapshotFromCommit(
    commit: EditorPersistenceCommit,
): ManagedEditorSnapshot<FakeEditorState> {
    const values = commit.next.manifest.videoTracks.map((track) => track.name);
    return {
        ...fakeSnapshot(values, commit.projectId, commit.sessionState.eventSequence),
        documentRevision: commit.sessionState.documentRevision,
        audioGraphRevision: commit.sessionState.audioGraphRevision,
        ...(commit.sessionState.narrativeRevision === undefined
            ? { narrativeRevision: undefined }
            : { narrativeRevision: commit.sessionState.narrativeRevision }),
        historyRevision: commit.sessionState.sessionRevision,
    };
}

export function fakeEditorResultFromCommit(
    commit: EditorPersistenceCommit,
    appended: string,
): FakeEditorResult {
    return {
        ...commit.receipt.value.result,
        appended,
        replayed: false,
        snapshot: structuredClone(commit.next),
    };
}
