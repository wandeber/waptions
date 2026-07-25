import { createHash } from 'node:crypto';
import {
    createEditorEngine,
    EditorCommandError,
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
    type HistoryJumpRequest,
    type HistoryMutationRequest,
} from '../../src/lib/editor-engine';
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
            currentIndex: -1,
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

    private createEngine(state: ManagedCoreEditorState): EditorEngine {
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
                    getReceipt: (...args) => this.persistence.getReceipt(...args),
                    commit: (commit) => this.commitFromCore(commit),
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
                events: { emit: (event) => this.publication.publish(event) },
            },
        });
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

export function managedCoreStateDigest(state: ManagedCoreEditorState): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(state)).digest('hex')}`;
}
