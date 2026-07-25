import { createHash } from 'node:crypto';
import {
    appendEditorHistory,
    createEditorEngine,
    createEditorHistoryEntry,
    EditorCommandError,
    type EditorCommandErrorCode,
    type EditorAssetHydration,
    type EditorCommandBatchRequest,
    type EditorCommandPlan,
    type EditorCommandResult,
    type EditorEngine,
    type EditorEngineSnapshot,
    type EditorHistoryState,
    type EditorIdempotencyReceipt,
    type EditorMediaImportRequest,
    type EditorMediaImportResult,
    type EditorPersistenceCommit,
    type EditorPersistencePort,
    type EditorialTranscriptionPublicationHydration,
    type EditorialTranscriptionPublicationRequest,
    type HistoryJumpRequest,
    type HistoryMutationRequest,
    type SubtitleTranscriptionPublicationRequest,
} from '../../src/lib/editor-engine';
import { validateEditorManifestV4 } from '../../src/lib/editor-document-v4';
import type { ResolvedEditorialTranscriptMapV1 } from '../../src/types/editorial';
import type { EditorManifestV4 } from '../../src/types/video';
import type {
    ManagedEditorPort,
    ManagedEditorPortFactory,
    ManagedEditorPublicationPort,
    ManagedEditorSnapshot,
} from '../coordinator/managed-editor-port';
import { canonicalDigest } from '../persistence/canonical-json';

export const MANAGED_CORE_STATE_VERSION = 1 as const;

export interface ManagedCoreEditorState {
    schemaVersion: typeof MANAGED_CORE_STATE_VERSION;
    snapshot: EditorEngineSnapshot;
    history: EditorHistoryState;
    sessionState: EditorPersistenceCommit['sessionState'];
    transaction: EditorPersistenceCommit['transaction'] | null;
    transcriptPins: EditorPersistenceCommit['transcriptPins'];
    sourcePins: EditorPersistenceCommit['sourcePins'];
}

export type ManagedCoreCommand =
    | { kind: 'plan'; request: EditorCommandBatchRequest }
    | { kind: 'dispatch'; request: EditorCommandBatchRequest }
    | { kind: 'import'; request: EditorMediaImportRequest; hydration: EditorAssetHydration }
    | { kind: 'undo'; request: HistoryMutationRequest }
    | { kind: 'redo'; request: HistoryMutationRequest }
    | { kind: 'jump'; request: HistoryJumpRequest };

export type ManagedCoreResult =
    | EditorCommandPlan
    | EditorCommandResult
    | EditorMediaImportResult;

export interface ManagedCoreAssetAuthorityRequest {
    readonly projectId: string;
    readonly head: ManagedEditorSnapshot<ManagedCoreEditorState>;
    readonly videoSourceIds: readonly string[];
    readonly audioSourceIds: readonly string[];
}

/**
 * Resolves retained media from the exact durable authority for the current managed project head.
 * Implementations must reject missing or changed immutable identities instead of synthesizing one.
 */
export interface ManagedCoreAssetAuthority {
    resolve(request: ManagedCoreAssetAuthorityRequest): Promise<EditorAssetHydration>;
}

export function createEmptyManagedCoreSnapshot(
    projectId: string,
    sessionEpoch: string,
    projectName = 'Untitled project',
): ManagedEditorSnapshot<ManagedCoreEditorState> {
    const manifest = createEmptyManifest();
    const snapshot: EditorEngineSnapshot = {
        projectId,
        project: { name: projectName },
        manifest,
        revisions: {
            sessionEpoch,
            sessionRevision: 0,
            documentRevision: manifest.revision,
            audioGraphRevision: manifest.audioGraphRevision,
        },
        history: {
            past: [],
            future: [],
            currentIndex: 0,
        },
        assetReferences: {
            videoSourceIds: [],
            audioSourceIds: [],
            transcriptRecordIds: [],
        },
    };
    return wrapManagedSnapshot({
        schemaVersion: MANAGED_CORE_STATE_VERSION,
        snapshot,
        history: { past: [], future: [] },
        sessionState: {
            sessionEpoch,
            sessionRevision: 0,
            eventSequence: 0,
            projectName,
            documentRevision: manifest.revision,
            audioGraphRevision: manifest.audioGraphRevision,
        },
        transaction: null,
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
    });
}

/**
 * Builds the one trusted Core head used by managed project import. The
 * imported document becomes one undoable history entry and all revisions
 * remain monotonic relative to the live project it replaces.
 */
export function createImportedManagedCoreSnapshot(input: {
    readonly current: ManagedEditorSnapshot<ManagedCoreEditorState>;
    readonly manifest: EditorManifestV4;
    readonly projectName: string;
    readonly occurredAt?: string;
}): ManagedEditorSnapshot<ManagedCoreEditorState> {
    const validation = validateEditorManifestV4(input.manifest);
    if (!validation.valid) {
        throw new EditorCommandError(
            'INVALID_DOCUMENT',
            'The managed project import manifest is invalid.',
        );
    }
    const before = input.current.state.snapshot;
    const manifest = structuredClone(input.manifest);
    manifest.revision = before.revisions.documentRevision + 1;
    manifest.audioGraphRevision = before.revisions.audioGraphRevision + 1;
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const revisions = {
        sessionEpoch: before.revisions.sessionEpoch,
        sessionRevision: before.revisions.sessionRevision + 1,
        documentRevision: manifest.revision,
        audioGraphRevision: manifest.audioGraphRevision,
        ...(manifest.narrative
            ? {
                narrativeRevision:
                    (before.revisions.narrativeRevision ?? 0) + 1,
            }
            : {}),
    };
    const project = {
        name: input.projectName.trim().slice(0, 200) || before.project.name,
    };
    const historyEntry = createEditorHistoryEntry({
        before: before.manifest,
        after: manifest,
        beforeProject: before.project,
        afterProject: project,
        summary: {
            id: `managed-project-import-${canonicalDigest({
                projectId: before.projectId,
                sessionRevision: revisions.sessionRevision,
            }).slice(7, 31)}`,
            label: 'Import project',
            category: 'project-import',
            occurredAt,
            operationIds: ['project.import'],
            from: omitEpoch(before.revisions),
            to: omitEpoch(revisions),
        },
    });
    const history = appendEditorHistory(
        input.current.state.history,
        historyEntry,
    );
    const videoSourceIds = manifest.videoSourceDescriptors.map(
        (source) => source.id,
    );
    const audioSourceIds = manifest.audioSourceDescriptors.map(
        (source) => source.id,
    );
    const transcriptRecordIds = Array.from(new Set(
        manifest.editorialTranscriptDescriptors.map(
            (descriptor) => descriptor.recordId,
        ),
    ));
    const historyVideoSourceIds = unique([
        ...input.current.state.sourcePins.current.videoSourceIds,
        ...input.current.state.sourcePins.history.videoSourceIds,
        ...historyEntry.sourceReferences.videoSourceIds,
    ]);
    const historyAudioSourceIds = unique([
        ...input.current.state.sourcePins.current.audioSourceIds,
        ...input.current.state.sourcePins.history.audioSourceIds,
        ...historyEntry.sourceReferences.audioSourceIds,
    ]);
    const historyTranscriptRecordIds = unique([
        ...input.current.state.transcriptPins.durableRecordIds,
        ...input.current.state.transcriptPins.historyRecordIds,
        ...historyEntry.transcriptRecordIds,
    ]);
    const snapshot: EditorEngineSnapshot = {
        projectId: before.projectId,
        project,
        manifest,
        revisions,
        history: {
            past: history.past.map((entry) => structuredClone(entry.summary)),
            future: [],
            currentIndex: history.past.length,
        },
        assetReferences: {
            videoSourceIds,
            audioSourceIds,
            transcriptRecordIds,
        },
    };
    return wrapManagedSnapshot({
        schemaVersion: MANAGED_CORE_STATE_VERSION,
        snapshot,
        history,
        sessionState: {
            sessionEpoch: revisions.sessionEpoch,
            sessionRevision: revisions.sessionRevision,
            eventSequence:
                input.current.state.sessionState.eventSequence + 1,
            projectName: project.name,
            documentRevision: revisions.documentRevision,
            audioGraphRevision: revisions.audioGraphRevision,
            ...(revisions.narrativeRevision === undefined
                ? {}
                : { narrativeRevision: revisions.narrativeRevision }),
        },
        transaction: {
            walTransactionId: `managed-project-import-${randomDigestId({
                projectId: before.projectId,
                sessionRevision: revisions.sessionRevision,
            })}`,
            preparedAt: occurredAt,
            operationIds: ['project.import'],
            fromDocumentRevision: before.revisions.documentRevision,
            toDocumentRevision: revisions.documentRevision,
        },
        transcriptPins: {
            durableRecordIds: transcriptRecordIds,
            historyRecordIds: historyTranscriptRecordIds,
            redoRecordIds: [],
        },
        sourcePins: {
            current: { videoSourceIds, audioSourceIds },
            history: {
                videoSourceIds: historyVideoSourceIds,
                audioSourceIds: historyAudioSourceIds,
            },
            redo: { videoSourceIds: [], audioSourceIds: [] },
        },
    });
}

export class CoreEditorPortFactory implements ManagedEditorPortFactory<
    ManagedCoreEditorState,
    ManagedCoreCommand,
    ManagedCoreResult
> {
    constructor(private readonly assetAuthority?: ManagedCoreAssetAuthority) {}

    async create(
        snapshot: ManagedEditorSnapshot<ManagedCoreEditorState>,
        persistence: EditorPersistencePort,
        publication: ManagedEditorPublicationPort,
    ): Promise<ManagedEditorPort<ManagedCoreEditorState, ManagedCoreCommand, ManagedCoreResult>> {
        return new CoreEditorPort(snapshot, persistence, publication, this.assetAuthority);
    }
}

class CoreEditorPort implements ManagedEditorPort<
    ManagedCoreEditorState,
    ManagedCoreCommand,
    ManagedCoreResult
> {
    private managed: ManagedEditorSnapshot<ManagedCoreEditorState>;
    private engine: EditorEngine;
    private activeRequest: import('../coordinator/types').ManagedMutationEnvelope | null = null;

    constructor(
        initial: ManagedEditorSnapshot<ManagedCoreEditorState>,
        private readonly persistence: EditorPersistencePort,
        private readonly publication: ManagedEditorPublicationPort,
        private readonly assetAuthority?: ManagedCoreAssetAuthority,
    ) {
        this.managed = structuredClone(initial);
        this.engine = this.createEngine(initial.state);
    }

    snapshot(): ManagedEditorSnapshot<ManagedCoreEditorState> {
        return structuredClone(this.managed);
    }

    plan(command: ManagedCoreCommand): ManagedCoreResult {
        if (command.kind !== 'plan') {
            throw new Error('Only edit planning is available through the Core read boundary.');
        }
        return this.engine.plan(command.request);
    }

    async dispatch(input: {
        command: ManagedCoreCommand;
        request: import('../coordinator/types').ManagedMutationEnvelope<ManagedCoreCommand>;
    }): Promise<ManagedCoreResult> {
        if (this.activeRequest) {
            throw new Error('The managed Core adapter is already dispatching.');
        }
        this.activeRequest = input.request;
        try {
            switch (input.command.kind) {
                case 'dispatch':
                    return await this.engine.dispatch(input.command.request);
                case 'import':
                    return await this.engine.importMedia(
                        input.command.request,
                        input.command.hydration,
                    );
                case 'undo':
                    return await this.engine.undo(input.command.request);
                case 'redo':
                    return await this.engine.redo(input.command.request);
                case 'jump':
                    return await this.engine.jumpToHistory(input.command.request);
                case 'plan':
                    throw new Error('Planning is read-only and cannot enter the mutation boundary.');
            }
        } finally {
            this.activeRequest = null;
        }
    }

    async hydrate(snapshot: ManagedEditorSnapshot<ManagedCoreEditorState>): Promise<void> {
        validateManagedCoreState(snapshot.state);
        const previous = this.engine;
        this.managed = structuredClone(snapshot);
        this.engine = this.createEngine(snapshot.state);
        await previous.close();
    }

    async close(): Promise<void> {
        await this.engine.close();
    }

    snapshotFromCommit(
        commit: EditorPersistenceCommit,
    ): ManagedEditorSnapshot<ManagedCoreEditorState> {
        return wrapManagedSnapshot({
            schemaVersion: MANAGED_CORE_STATE_VERSION,
            snapshot: structuredClone(commit.next),
            history: structuredClone(commit.history),
            sessionState: structuredClone(commit.sessionState),
            transaction: structuredClone(commit.transaction),
            transcriptPins: structuredClone(commit.transcriptPins),
            sourcePins: structuredClone(commit.sourcePins),
        });
    }

    resultFromReceipt(
        receipt: EditorIdempotencyReceipt,
        replayed: boolean,
    ): ManagedCoreResult {
        return {
            ...structuredClone(receipt.result),
            replayed,
            snapshot: structuredClone(this.managed.state.snapshot),
        } as ManagedCoreResult;
    }

    editorEventSequence(): number {
        return this.managed.state.sessionState.eventSequence;
    }

    prepareEditorialTranscriptionPublication(
        request: EditorialTranscriptionPublicationRequest,
        hydration?: EditorialTranscriptionPublicationHydration,
    ): Promise<EditorPersistenceCommit> {
        return this.prepareDetachedTranscriptionPublication(
            (engine) => engine.publishEditorialTranscription(request, hydration),
        );
    }

    prepareSubtitleTranscriptionPublication(
        request: SubtitleTranscriptionPublicationRequest,
    ): Promise<EditorPersistenceCommit> {
        return this.prepareDetachedTranscriptionPublication(
            (engine) => engine.publishSubtitleTranscription(request),
        );
    }

    rebaseSession(
        snapshot: ManagedEditorSnapshot<ManagedCoreEditorState>,
        session: {
            sessionEpoch: string;
            sessionRevision: number;
            eventSequence?: number;
        },
    ): ManagedEditorSnapshot<ManagedCoreEditorState> {
        const state = structuredClone(snapshot.state);
        state.snapshot.revisions.sessionEpoch = session.sessionEpoch;
        state.snapshot.revisions.sessionRevision = session.sessionRevision;
        state.sessionState.sessionEpoch = session.sessionEpoch;
        state.sessionState.sessionRevision = session.sessionRevision;
        if (session.eventSequence !== undefined) {
            state.sessionState.eventSequence = session.eventSequence;
        }
        return wrapManagedSnapshot(state);
    }

    private createEngine(
        state: ManagedCoreEditorState,
        detached?: {
            commit(commit: EditorPersistenceCommit): Promise<void>;
        },
    ): EditorEngine {
        validateManagedCoreState(state);
        const projectId = state.snapshot.projectId;
        return createEditorEngine({
            projectId,
            sessionEpoch: state.sessionState.sessionEpoch,
            initialManifest: state.snapshot.manifest,
            initialProjectMetadata: state.snapshot.project,
            initialSessionRevision: state.sessionState.sessionRevision,
            initialEventSequence: state.sessionState.eventSequence,
            initialHistory: state.history,
            closePorts: false,
            ports: {
                persistence: {
                    getReceipt: detached
                        ? async () => null
                        : (...args) => this.persistence.getReceipt(...args),
                    commit: detached
                        ? detached.commit
                        : (commit) => this.commitFromCore(commit),
                },
                assets: {
                    hydrate: (request) => this.resolveAssetHydration(request),
                },
                transcripts: {
                    hydrate: async () => ({} as ResolvedEditorialTranscriptMapV1),
                },
                clock: {
                    now: () => {
                        const epochMs = Date.now();
                        return { iso: new Date(epochMs).toISOString(), epochMs };
                    },
                },
                ids: new StableManagedEditorIdGenerator(`managed-${projectId}`),
                events: {
                    emit: detached
                        ? () => undefined
                        : (event) => this.publication.publish(event),
                },
            },
        });
    }

    private async prepareDetachedTranscriptionPublication(
        publish: (engine: EditorEngine) => Promise<{
            ok: boolean;
            error?: {
                code: string;
                message: string;
                retryable: boolean;
                details?: unknown;
            };
        }>,
    ): Promise<EditorPersistenceCommit> {
        let captured: EditorPersistenceCommit | null = null;
        const engine = this.createEngine(structuredClone(this.managed.state), {
            commit: async (commit) => {
                if (captured) {
                    throw new Error('Detached Core transcription prepared more than one commit.');
                }
                captured = structuredClone(commit);
            },
        });
        try {
            const result = await publish(engine);
            if (!result.ok) {
                throw new EditorCommandError(
                    (result.error?.code ?? 'INTERNAL_ERROR') as EditorCommandErrorCode,
                    result.error?.message ?? 'Core rejected the detached transcription publication.',
                    {
                        retryable: result.error?.retryable ?? false,
                    },
                );
            }
            if (!captured) {
                throw new Error('Detached Core transcription returned without an exact commit.');
            }
            return captured;
        } finally {
            await engine.close();
        }
    }

    private async resolveAssetHydration(request: {
        videoSourceIds: readonly string[];
        audioSourceIds: readonly string[];
    }): Promise<EditorAssetHydration> {
        if (!this.assetAuthority) {
            throw new EditorCommandError(
                'COORDINATOR_UNAVAILABLE',
                'Managed media hydration requires a project-scoped source authority.',
            );
        }
        const head = this.snapshot();
        return this.assetAuthority.resolve({
            projectId: head.state.snapshot.projectId,
            head,
            videoSourceIds: [...request.videoSourceIds],
            audioSourceIds: [...request.audioSourceIds],
        });
    }

    private async commitFromCore(commit: EditorPersistenceCommit): Promise<void> {
        if (!this.activeRequest) {
            throw new Error('Core attempted persistence outside a managed dispatch.');
        }
        await this.persistence.commit(commit);
        this.managed = this.snapshotFromCommit(commit);
    }
}

class StableManagedEditorIdGenerator {
    constructor(private readonly prefix: string) {}

    generate(kind: string, scope: string): string {
        const suffix = createHash('sha256')
            .update(kind)
            .update('\0')
            .update(scope)
            .digest('hex')
            .slice(0, 24);
        return `${this.prefix}-${kind}-${suffix}`;
    }
}

function createEmptyManifest(): EditorManifestV4 {
    return {
        version: 4,
        revision: 0,
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
        videoTracks: [{
            id: 'video-track-1',
            name: 'Video 1',
            visible: true,
            locked: false,
        }],
        audioSourceDescriptors: [],
        audioTracks: [],
        activeSubtitleTrackId: null,
        transcriptionByTrackId: {},
        globalEditingMode: 'ripple',
        editorialTranscriptDescriptors: [],
        narrative: null,
        dependentLinks: [],
    };
}

function wrapManagedSnapshot(
    state: ManagedCoreEditorState,
): ManagedEditorSnapshot<ManagedCoreEditorState> {
    const reachableSourceIds = Array.from(new Set([
        ...state.snapshot.assetReferences.videoSourceIds,
        ...state.snapshot.assetReferences.audioSourceIds,
        ...state.sourcePins.current.videoSourceIds,
        ...state.sourcePins.current.audioSourceIds,
        ...state.sourcePins.history.videoSourceIds,
        ...state.sourcePins.history.audioSourceIds,
        ...state.sourcePins.redo.videoSourceIds,
        ...state.sourcePins.redo.audioSourceIds,
    ]));
    const transcriptRecordIds = Array.from(new Set([
        ...state.snapshot.assetReferences.transcriptRecordIds,
        ...state.transcriptPins.durableRecordIds,
        ...state.transcriptPins.historyRecordIds,
        ...state.transcriptPins.redoRecordIds,
    ]));
    return {
        state: structuredClone(state),
        documentRevision: state.snapshot.revisions.documentRevision,
        audioGraphRevision: state.snapshot.revisions.audioGraphRevision,
        ...(state.snapshot.revisions.narrativeRevision === undefined
            ? {}
            : { narrativeRevision: state.snapshot.revisions.narrativeRevision }),
        manifestDigest: canonicalDigest(state.snapshot.manifest),
        historyRevision: state.snapshot.revisions.sessionRevision,
        reachableSourceIds,
        transcriptRecordIds,
    };
}

function validateManagedCoreState(state: ManagedCoreEditorState): void {
    if (
        state.schemaVersion !== MANAGED_CORE_STATE_VERSION
        || !state.snapshot
        || !state.history
        || !state.sessionState
        || !state.transcriptPins
        || !state.sourcePins
    ) {
        throw new Error('Managed Core editor state is invalid.');
    }
}

function omitEpoch(
    revisions: EditorEngineSnapshot['revisions'],
): Omit<EditorEngineSnapshot['revisions'], 'sessionEpoch'> {
    const {
        sessionEpoch: _sessionEpoch,
        ...withoutEpoch
    } = revisions;
    void _sessionEpoch;
    return withoutEpoch;
}

function unique(values: readonly string[]): string[] {
    return Array.from(new Set(values));
}

function randomDigestId(value: unknown): string {
    return canonicalDigest(value).slice(7, 39);
}

export function managedCoreStateDigest(state: ManagedCoreEditorState): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(state)).digest('hex')}`;
}
