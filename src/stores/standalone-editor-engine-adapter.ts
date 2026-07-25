import {
    EDITOR_ENGINE_API_VERSION,
    type EditorCommandBatchRequest,
    type EditorExpectedRevisions,
    type EditorSemanticOperation,
} from '@/lib/editor-engine/editor-command';
import {
    createEditorEngine,
} from '@/lib/editor-engine/editor-engine';
import {
    createEditorHistoryEntry,
} from '@/lib/editor-engine/editor-history';
import type {
    EditorCommandResult,
    EditorEngine,
    EditorEngineSnapshot,
    EditorHistoryEntry,
    EditorHistoryState,
    EditorHistorySummary,
} from '@/lib/editor-engine/editor-engine-types';
import {
    StandaloneEditorAssetRepositoryPort,
    StandaloneEditorPersistencePort,
    StandaloneEditorialTranscriptRepositoryPort,
} from '@/lib/editor-engine/standalone-web-ports';
import { validateHydratedEditorDocumentV4 } from '@/lib/editor-document-v4';
import { createEditorManifestV4 } from '@/lib/editor-document-v4-migration';
import { applySerializablePatches } from '@/lib/serializable-patch';
import {
    StorageService,
    storageService,
    type StandaloneEditorSelectionHistoryV1,
} from '@/lib/storage/storage-service';
import type { TransientMediaSelectionV4 } from '@/types/video';
import {
    projectTimelineHistory,
    restoreTimelineHistoryProjection,
    TIMELINE_HISTORY_ROOTS,
} from './timeline-history-projection';
import type {
    TimelineHistoryEntry,
    TimelineHistoryProjection,
    TimelineStore,
} from './timeline-store-types';
import {
    buildEditorManifestFromState,
} from './timeline-store-snapshot';
import {
    timelineEditorialRuntime,
} from './timeline-editorial-runtime';
import { useTimelineStore } from './timeline-store';
import {
    StandaloneEditorUnsupportedError,
    type StandaloneEditorDispatchOptions,
    type StandaloneEditorEngineBridge,
} from './standalone-editor-engine-registry';
import type { TimelineV4CommandResult } from './timeline-v4-command-types';

interface CreateStandaloneEditorEngineAdapterInput {
    projectId: string;
    projectName: string;
    state: TimelineStore;
    storage?: StorageService;
    onError?: (error: unknown) => void;
    onProjection?: (projection: StandaloneEditorProjectionMetadata) => void | Promise<void>;
}

export interface StandaloneEditorProjectionMetadata {
    revision: number;
    projectName: string;
}

interface ConvertedStandaloneHistory {
    history: EditorHistoryState;
    selections: Record<string, StandaloneEditorSelectionHistoryV1>;
}

export class StandaloneEditorEngineAdapter implements StandaloneEditorEngineBridge {
    private readonly engine: EditorEngine;
    private readonly persistence: StandaloneEditorPersistencePort;
    private readonly assets: StandaloneEditorAssetRepositoryPort;
    private dispatchQueue: Promise<void> = Promise.resolve();
    private failedDispatch: {
        request: EditorCommandBatchRequest;
        options: StandaloneEditorDispatchOptions;
        error: unknown;
    } | null = null;
    private operationSequence = 0;
    private closed = false;

    private constructor(input: {
        engine: EditorEngine;
        persistence: StandaloneEditorPersistencePort;
        assets: StandaloneEditorAssetRepositoryPort;
        onError?: (error: unknown) => void;
        onProjection?: (projection: StandaloneEditorProjectionMetadata) => void | Promise<void>;
    }) {
        this.engine = input.engine;
        this.persistence = input.persistence;
        this.assets = input.assets;
        this.onError = input.onError;
        this.onProjection = input.onProjection;
    }

    private readonly onError?: (error: unknown) => void;
    private readonly onProjection?: (
        projection: StandaloneEditorProjectionMetadata,
    ) => void | Promise<void>;

    static async create(
        input: CreateStandaloneEditorEngineAdapterInput,
    ): Promise<StandaloneEditorEngineAdapter> {
        const storage = input.storage ?? storageService;
        const head = await storage.loadStandaloneEditorEngineHead(input.projectId);
        const converted = head ? null : convertStandaloneTimelineHistory(input.state, input.projectName);
        const transcriptRepository = timelineEditorialRuntime.getRepository();
        const assets = new StandaloneEditorAssetRepositoryPort({
            videoSources: input.state.videoSources,
            audioSources: input.state.audioSources,
        });
        const persistence = new StandaloneEditorPersistencePort(
            storage,
            transcriptRepository,
            input.projectId,
            head,
            input.onError,
            converted
                ? {
                    history: converted.history,
                    selectionByHistoryEntryId: converted.selections,
                }
                : undefined,
        );
        const initialManifest = head?.snapshot.manifest
            ?? createEditorManifestV4(input.state.buildEditorDocumentV4());
        const sessionEpoch = `standalone-${crypto.randomUUID()}`;
        const ids = new StandaloneEditorIdGenerator();
        const engine = createEditorEngine({
            projectId: input.projectId,
            sessionEpoch,
            initialManifest,
            initialProjectMetadata: head?.snapshot.project ?? { name: input.projectName },
            initialSessionRevision: head?.sessionState.sessionRevision
                ?? maximumHistorySessionRevision(converted?.history),
            initialHistory: head?.history ?? converted?.history,
            initialEventSequence: head?.sessionState.eventSequence ?? 0,
            closePorts: false,
            ports: {
                persistence,
                assets,
                transcripts: new StandaloneEditorialTranscriptRepositoryPort(transcriptRepository),
                clock: {
                    now: () => {
                        const epochMs = Date.now();
                        return { epochMs, iso: new Date(epochMs).toISOString() };
                    },
                },
                ids,
                events: { emit: () => undefined },
                diagnostics: {
                    record: (entry) => {
                        if (entry.kind === 'failure') input.onError?.(new Error(
                            entry.message ?? 'Standalone editor engine command failed.',
                        ));
                    },
                },
            },
        });
        const adapter = new StandaloneEditorEngineAdapter({
            engine,
            persistence,
            assets,
            onError: input.onError,
            onProjection: input.onProjection,
        });
        await adapter.projectSnapshot(
            engine.getSnapshot(),
            input.state.transientSelection,
        );
        return adapter;
    }

    getSnapshot(): EditorEngineSnapshot {
        return this.engine.getSnapshot();
    }

    enqueueOperations(
        operations: readonly EditorSemanticOperation[],
        options: StandaloneEditorDispatchOptions,
    ): TimelineV4CommandResult {
        if (this.closed) return engineUnavailableResult();
        void this.enqueueDispatch(operations, options).catch((error) => this.onError?.(error));
        return options.compatibilityResult;
    }

    async dispatchOperations(
        operations: readonly EditorSemanticOperation[],
        options: StandaloneEditorDispatchOptions,
    ): Promise<TimelineV4CommandResult> {
        if (this.closed) return engineUnavailableResult();
        const result = await this.enqueueDispatch(operations, options);
        return result.ok ? options.compatibilityResult : coreFailureToTimelineResult(result);
    }

    reportUnsupported(result: Extract<TimelineV4CommandResult, { kind: 'error' }>): void {
        this.onError?.(new StandaloneEditorUnsupportedError(
            `${result.error.code}: ${result.error.message}`,
        ));
    }

    async flush(): Promise<void> {
        await this.dispatchQueue;
        if (this.failedDispatch) {
            throw new Error('Standalone editor persistence still has a failed command.');
        }
    }

    async retryLastFailure(): Promise<boolean> {
        const failed = this.failedDispatch;
        if (!failed || this.closed) return false;
        this.incrementPendingCommands();
        try {
            const result = await this.enqueue(() => this.runDispatch(
                failed.request,
                failed.options,
            ));
            return result.ok;
        } finally {
            this.decrementPendingCommands();
        }
    }

    async undo(): Promise<void> {
        await this.enqueueHistory('undo');
    }

    async redo(): Promise<void> {
        await this.enqueueHistory('redo');
    }

    async jumpToHistory(entryId: string | null, position: 'before' | 'after'): Promise<void> {
        this.incrementPendingCommands();
        try {
            await this.enqueue(async () => {
                await this.assertDispatchQueueReady();
                const resolvedEntryId = entryId
                    ?? this.engine.getSnapshot().history.past[0]?.id
                    ?? this.engine.getSnapshot().history.future.at(-1)?.id;
                if (!resolvedEntryId) return;
                const request = this.historyRequest();
                const effectivePosition = entryId === null ? 'before' : position;
                const result = await this.engine.jumpToHistory({
                    ...request,
                    entryId: resolvedEntryId,
                    position: effectivePosition,
                });
                if (!result.ok) {
                    this.onError?.(new Error(result.error.message));
                    return;
                }
                const selection = this.persistence.selectionForHistory(
                    result.historyEntryId,
                    effectivePosition,
                    useTimelineStore.getState().transientSelection,
                );
                if (!this.closed) await this.projectSnapshot(result.snapshot, selection);
            });
        } finally {
            this.decrementPendingCommands();
        }
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.dispatchQueue;
        await this.engine.close();
    }

    private enqueueDispatch(
        operations: readonly EditorSemanticOperation[],
        options: StandaloneEditorDispatchOptions,
    ): Promise<EditorCommandResult> {
        this.incrementPendingCommands();
        return this.enqueue(async () => {
            await this.assertDispatchQueueReady();
            const snapshot = this.engine.getSnapshot();
            const sequence = ++this.operationSequence;
            const request: EditorCommandBatchRequest = {
                apiVersion: EDITOR_ENGINE_API_VERSION,
                toolName: 'waptions_edit_apply',
                sessionEpoch: snapshot.revisions.sessionEpoch,
                expected: expectedRevisions(snapshot),
                idempotencyKey: `standalone-edit-${sequence}-${crypto.randomUUID()}`,
                operations: structuredClone(operations) as EditorSemanticOperation[],
                history: options.history,
            };
            return this.runDispatch(request, options);
        }).finally(() => this.decrementPendingCommands());
    }

    private async runDispatch(
        request: EditorCommandBatchRequest,
        options: StandaloneEditorDispatchOptions,
    ): Promise<EditorCommandResult> {
        this.persistence.stageSelection(options.selectionBefore, options.selectionAfter);
        let result: EditorCommandResult;
        try {
            result = await this.engine.dispatch(request);
        } catch (error) {
            this.persistence.discardStagedSelection();
            this.failedDispatch = { request, options, error };
            await this.restoreAuthoritativeSnapshot();
            this.onError?.(error);
            throw error;
        }
        if (result.ok) {
            if (this.failedDispatch?.request.idempotencyKey === request.idempotencyKey) {
                this.failedDispatch = null;
            }
            if (result.noOp) this.persistence.discardStagedSelection();
            const selection = result.noOp
                ? useTimelineStore.getState().transientSelection
                : options.selectionAfter;
            if (!this.closed) await this.projectSnapshot(result.snapshot, selection);
        } else {
            this.persistence.discardStagedSelection();
            const error = new Error(result.error.message);
            this.failedDispatch = { request, options, error };
            await this.restoreAuthoritativeSnapshot();
            this.onError?.(error);
        }
        return result;
    }

    private async enqueueHistory(action: 'undo' | 'redo'): Promise<void> {
        this.incrementPendingCommands();
        try {
            await this.enqueue(async () => {
                await this.assertDispatchQueueReady();
                const result = await this.engine[action](this.historyRequest());
                if (!result.ok) {
                    this.onError?.(new Error(result.error.message));
                    return;
                }
                const selection = this.persistence.selectionForHistory(
                    result.historyEntryId,
                    action === 'undo' ? 'before' : 'after',
                    useTimelineStore.getState().transientSelection,
                );
                if (!this.closed) await this.projectSnapshot(result.snapshot, selection);
            });
        } finally {
            this.decrementPendingCommands();
        }
    }

    private incrementPendingCommands(): void {
        useTimelineStore.setState((state) => ({
            standalonePendingCommandCount: state.standalonePendingCommandCount + 1,
        }));
    }

    private decrementPendingCommands(): void {
        useTimelineStore.setState((state) => ({
            standalonePendingCommandCount: Math.max(
                0,
                state.standalonePendingCommandCount - 1,
            ),
        }));
    }

    private async restoreAuthoritativeSnapshot(): Promise<void> {
        if (this.closed) return;
        try {
            await this.projectSnapshot(
                this.engine.getSnapshot(),
                useTimelineStore.getState().transientSelection,
            );
        } catch (error) {
            this.onError?.(error);
        }
    }

    private async assertDispatchQueueReady(): Promise<void> {
        const failed = this.failedDispatch;
        if (!failed) return;
        await this.restoreAuthoritativeSnapshot();
        this.onError?.(failed.error);
        throw new Error(
            'A failed standalone editor command must be retried before another durable command.',
        );
    }

    private historyRequest() {
        const snapshot = this.engine.getSnapshot();
        const sequence = ++this.operationSequence;
        return {
            apiVersion: EDITOR_ENGINE_API_VERSION,
            toolName: 'waptions_history_apply' as const,
            sessionEpoch: snapshot.revisions.sessionEpoch,
            expected: expectedRevisions(snapshot),
            idempotencyKey: `standalone-history-${sequence}-${crypto.randomUUID()}`,
            steps: 1,
        };
    }

    private enqueue<T>(run: () => Promise<T>): Promise<T> {
        const result = this.dispatchQueue.then(run);
        this.dispatchQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    private async projectSnapshot(
        snapshot: EditorEngineSnapshot,
        requestedSelection: TransientMediaSelectionV4,
    ): Promise<void> {
        if (this.closed) return;
        let document = this.assets.hydrateRuntimeDocument(snapshot.manifest, requestedSelection);
        const bodies = await hydrateSnapshotTranscripts(snapshot);
        if (this.closed) return;
        let validation = validateHydratedEditorDocumentV4(document, bodies);
        if (!validation.valid && document.transientSelection.kind !== 'none') {
            document = { ...document, transientSelection: { kind: 'none' } };
            validation = validateHydratedEditorDocumentV4(document, bodies);
        }
        if (!validation.valid) {
            throw new Error(
                `Committed standalone engine snapshot is invalid: ${validation.issues[0]?.message ?? 'unknown issue'}`,
            );
        }
        const context = timelineEditorialRuntime.getProjectContext();
        const history = timelineHistorySummaryProjection(snapshot);
        const published = timelineEditorialRuntime.publishResolvedDocument(
            document,
            bodies,
            context,
            () => useTimelineStore.getState().hydrateEditorDocument(document, history),
        );
        if (!published) {
            throw new DOMException('Standalone editor snapshot publication became stale.', 'AbortError');
        }
        await this.onProjection?.({
            revision: snapshot.manifest.revision,
            projectName: snapshot.project.name,
        });
    }
}

async function hydrateSnapshotTranscripts(
    snapshot: EditorEngineSnapshot,
) {
    const repository = timelineEditorialRuntime.getRepository();
    const entries = await Promise.all(snapshot.manifest.editorialTranscriptDescriptors.map(
        async (descriptor) => {
            const body = await repository.getRecord(descriptor.recordId, {
                descriptor,
                referenced: true,
            });
            if (!body) throw new Error(`Transcript record "${descriptor.recordId}" is unavailable.`);
            return [descriptor.recordId, body] as const;
        },
    ));
    return Object.freeze(Object.fromEntries(entries));
}

function convertStandaloneTimelineHistory(
    state: TimelineStore,
    projectName: string,
): ConvertedStandaloneHistory {
    const selections: Record<string, StandaloneEditorSelectionHistoryV1> = {};
    const current = projectTimelineHistory(state);
    const past = convertPastHistory(state, projectName, current, selections);
    const future = convertFutureHistory(state, projectName, current, selections);
    return { history: { past, future }, selections };
}

function convertPastHistory(
    state: TimelineStore,
    projectName: string,
    current: TimelineHistoryProjection,
    selections: Record<string, StandaloneEditorSelectionHistoryV1>,
): EditorHistoryEntry[] {
    const converted = new Array<EditorHistoryEntry>(state.history.length);
    let after = current;
    for (let index = state.history.length - 1; index >= 0; index -= 1) {
        const source = state.history[index];
        const before = applySerializablePatches(
            after,
            source.inversePatches,
            TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
        );
        converted[index] = convertHistoryEntry(state, projectName, source, before, after);
        selections[source.id] = selectionContext(before, after);
        after = before;
    }
    return converted;
}

function convertFutureHistory(
    state: TimelineStore,
    projectName: string,
    current: TimelineHistoryProjection,
    selections: Record<string, StandaloneEditorSelectionHistoryV1>,
): EditorHistoryEntry[] {
    const converted = new Array<EditorHistoryEntry>(state.redoStack.length);
    let before = current;
    for (let index = state.redoStack.length - 1; index >= 0; index -= 1) {
        const source = state.redoStack[index];
        const after = applySerializablePatches(
            before,
            source.patches,
            TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
        );
        converted[index] = convertHistoryEntry(state, projectName, source, before, after);
        selections[source.id] = selectionContext(before, after);
        before = after;
    }
    return converted;
}

function convertHistoryEntry(
    state: TimelineStore,
    projectName: string,
    source: TimelineHistoryEntry,
    before: TimelineHistoryProjection,
    after: TimelineHistoryProjection,
): EditorHistoryEntry {
    const beforeManifest = manifestForHistoryProjection(state, before);
    const afterManifest = manifestForHistoryProjection(state, after);
    const summary: EditorHistorySummary = {
        id: source.id,
        label: source.label,
        category: 'standalone-compatibility',
        occurredAt: new Date(source.timestamp).toISOString(),
        operationIds: [`standalone-history:${source.id}`],
        from: historySummaryRevisions(source.sequence - 1, beforeManifest),
        to: historySummaryRevisions(source.sequence, afterManifest),
    };
    return createEditorHistoryEntry({
        before: beforeManifest,
        after: afterManifest,
        beforeProject: { name: projectName },
        afterProject: { name: projectName },
        summary,
    });
}

function manifestForHistoryProjection(
    state: TimelineStore,
    projection: TimelineHistoryProjection,
) {
    const restored = restoreTimelineHistoryProjection(projection);
    return buildEditorManifestFromState({ ...state, ...restored } as TimelineStore);
}

function selectionContext(
    before: TimelineHistoryProjection,
    after: TimelineHistoryProjection,
): StandaloneEditorSelectionHistoryV1 {
    return {
        before: structuredClone(before.transientSelection),
        after: structuredClone(after.transientSelection),
    };
}

function historySummaryRevisions(
    sessionRevision: number,
    manifest: ReturnType<typeof buildEditorManifestFromState>,
) {
    return {
        sessionRevision: Math.max(0, sessionRevision),
        documentRevision: manifest.revision,
        audioGraphRevision: manifest.audioGraphRevision,
        ...(manifest.narrative ? { narrativeRevision: manifest.narrative.revision } : {}),
    };
}

function maximumHistorySessionRevision(history?: EditorHistoryState): number {
    if (!history) return 0;
    return Math.max(
        0,
        ...[...history.past, ...history.future].flatMap((entry) => [
            entry.summary.from.sessionRevision,
            entry.summary.to.sessionRevision,
        ]),
    );
}

function timelineHistorySummaryProjection(snapshot: EditorEngineSnapshot) {
    const toEntry = (summary: EditorHistorySummary, index: number): TimelineHistoryEntry => ({
        id: summary.id,
        sequence: summary.to.sessionRevision || index + 1,
        label: summary.label,
        mergeKey: null,
        timestamp: Date.parse(summary.occurredAt),
        patches: [],
        inversePatches: [],
        audioGraphMutationImpact: summary.to.audioGraphRevision === summary.from.audioGraphRevision
            ? 'preserve-transcription'
            : 'invalidate-transcription',
        recalculatesContentBoundary: summary.to.documentRevision !== summary.from.documentRevision,
        byteSize: 0,
        oversized: false,
    });
    const history = snapshot.history.past.map(toEntry);
    const redoStack = snapshot.history.future.map(toEntry);
    return {
        history,
        redoStack,
        historySequence: Math.max(0, ...[...history, ...redoStack].map((entry) => entry.sequence)),
        historyBytes: 0,
    };
}

function expectedRevisions(snapshot: EditorEngineSnapshot): EditorExpectedRevisions {
    return {
        sessionRevision: snapshot.revisions.sessionRevision,
        documentRevision: snapshot.revisions.documentRevision,
        audioGraphRevision: snapshot.revisions.audioGraphRevision,
        ...(snapshot.revisions.narrativeRevision === undefined
            ? {}
            : { narrativeRevision: snapshot.revisions.narrativeRevision }),
    };
}

function coreFailureToTimelineResult(
    result: Exclude<EditorCommandResult, { ok: true }>,
): TimelineV4CommandResult {
    return {
        kind: 'error',
        error: {
            code: result.error.code,
            message: result.error.message,
            ids: result.error.details?.ids ?? [],
        },
    };
}

function engineUnavailableResult(): TimelineV4CommandResult {
    return {
        kind: 'error',
        error: {
            code: 'COORDINATOR_UNAVAILABLE',
            message: 'The standalone editor engine is closed.',
            ids: [],
        },
    };
}

class StandaloneEditorIdGenerator {
    private readonly values = new Map<string, string>();

    generate(kind: string, scope: string): string {
        const key = `${kind}\u0000${scope}`;
        const existing = this.values.get(key);
        if (existing) return existing;
        const value = `${kind}-${crypto.randomUUID()}`;
        this.values.set(key, value);
        return value;
    }
}
