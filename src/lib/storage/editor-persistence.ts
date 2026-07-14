import type { EditorManifestV3 } from '@/types/video';
import { storageService, type EditorPersistentAsset } from './storage-service';
import {
    createHistoryIndex,
    getManifestSourceSignature,
    recoveryEntryStorageKey,
    type EditorHistoryCheckpoint,
    type PersistedRecoveryEntry,
    type PersistedRecoveryIndex,
} from './editor-history-storage';
import type {
    TimelineHistoryEntry,
    TimelineHistoryProjection,
    TimelineHistoryRuntimeState,
} from '@/stores/timeline-store-types';
import { createSerializablePatches } from '@/lib/serializable-patch';
import { TIMELINE_HISTORY_ROOTS } from '@/stores/timeline-history-projection';

export interface EditorPersistenceWriter {
    saveEditorDocument: (
        projectId: string,
        manifest: EditorManifestV3,
        sourceAssets: readonly EditorPersistentAsset[],
        historyCheckpoint: EditorHistoryCheckpoint,
    ) => Promise<void>;
    writeEditorRecovery: (
        projectId: string,
        index: PersistedRecoveryIndex,
        entryKey: string,
        entry: PersistedRecoveryEntry,
    ) => Promise<void>;
}

export type ProjectDatabaseDeleteDriver = (
    projectId: string,
    onBlocked: () => void,
) => Promise<void>;

export type EditorPersistenceStatus =
    | 'saving'
    | 'saved'
    | 'error'
    | 'deletion-pending'
    | 'deletion-blocked'
    | 'deleted';

export interface EditorPersistenceStatusEvent {
    projectId: string;
    generation: number;
    status: EditorPersistenceStatus;
    revision?: number;
    error?: unknown;
}

export interface EditorPersistenceSnapshot {
    projectId: string;
    lastSavedRevision: number;
    pendingAssetPairs: string[];
    durableFingerprints: Record<string, string>;
    lastFailure: unknown | null;
    hasNondurableDocument: boolean;
    isSettled: boolean;
    deletionPending: boolean;
    disposed: boolean;
}

interface SaveRequest {
    manifest: EditorManifestV3;
    generation: number;
    historyRuntime: TimelineHistoryRuntimeState;
    historyCheckpoint: EditorHistoryCheckpoint;
    recoveryWrite: RecoveryWrite | null;
    sourceBarrier: boolean;
}

interface RecoveryWrite {
    index: PersistedRecoveryIndex;
    entryKey: string;
    entry: PersistedRecoveryEntry;
    attempt: Promise<void>;
}

const assetIdentity = (asset: EditorPersistentAsset) => `${asset.kind}:${asset.asset.id}`;
const assetPairKey = (identity: string, fingerprint: string) => `${identity}\u0000${fingerprint}`;

export class EditorPersistenceCoordinator {
    readonly projectId: string;

    private writer: EditorPersistenceWriter;
    private notify: (event: EditorPersistenceStatusEvent) => void;
    private pendingAssets = new Map<string, EditorPersistentAsset>();
    private durableFingerprints = new Map<string, string>();
    private latestQueued: SaveRequest | null = null;
    private failedRequest: SaveRequest | null = null;
    private processing: Promise<void> | null = null;
    private lastSavedRevision = 0;
    private lastFailure: unknown | null = null;
    private deletionPending = false;
    private disposed = false;
    private durableProjection: TimelineHistoryProjection | null = null;
    private durableSourceSignature: string | null = null;
    private lastEnqueuedProjection: TimelineHistoryProjection | null = null;
    private lastEnqueuedRevision = 0;
    private lastEnqueuedSourceSignature: string | null = null;
    private lastEnqueuedAudioGraphRevision = 0;
    private recoveryEntryKeys: string[] = [];
    private recoveryGarbageKeys = new Set<string>();
    private recoverySerial: Promise<void> = Promise.resolve();
    private recoveryWriteGeneration = 0;
    private recoveryChainInvalid = false;
    private durableHistorySignatures = new Map<string, string>();
    private durableAudioGraphRevision = 0;

    constructor(
        projectId: string,
        writer: EditorPersistenceWriter,
        notify: (event: EditorPersistenceStatusEvent) => void,
    ) {
        this.projectId = projectId;
        this.writer = writer;
        this.notify = notify;
    }

    assertCanOpen(): void {
        if (this.deletionPending || this.disposed) {
            throw new Error(`Project ${this.projectId} cannot be opened while deletion is pending.`);
        }
    }

    enqueue(
        manifest: EditorManifestV3,
        sourceAssets: readonly EditorPersistentAsset[],
        generation: number,
        historyRuntime: TimelineHistoryRuntimeState,
    ): void {
        this.assertCanOpen();
        if (manifest.revision <= this.lastSavedRevision) {
            return;
        }

        const descriptorsByIdentity = getManifestDescriptors(manifest);
        sourceAssets.forEach((asset) => {
            const identity = assetIdentity(asset);
            const descriptor = descriptorsByIdentity.get(identity);
            if (!descriptor || descriptor.fingerprint !== asset.asset.fingerprint) {
                throw new Error(`Source asset ${identity} is not referenced by revision ${manifest.revision}.`);
            }
            if (this.durableFingerprints.get(identity) !== asset.asset.fingerprint) {
                this.pendingAssets.set(assetPairKey(identity, asset.asset.fingerprint), asset);
            }
        });

        const sourceSignature = getManifestSourceSignature(manifest);
        if (this.recoveryChainInvalid) {
            // A later enqueue after a settled WAL failure must not extend the missing entry. Reset
            // its in-memory predecessor to the durable checkpoint before constructing this write.
            this.recoveryEntryKeys.forEach((key) => this.recoveryGarbageKeys.add(key));
            this.recoveryEntryKeys = [];
            this.lastEnqueuedProjection = this.durableProjection;
            this.lastEnqueuedRevision = this.lastSavedRevision;
            this.lastEnqueuedSourceSignature = this.durableSourceSignature;
            this.lastEnqueuedAudioGraphRevision = this.durableAudioGraphRevision;
            this.recoveryChainInvalid = false;
        }
        const historyDelta = this.createHistoryDelta(historyRuntime);
        const historyIndex = createHistoryIndex(manifest, historyRuntime);
        const sourceBarrier = sourceAssets.length > 0
            || (this.lastEnqueuedSourceSignature !== null
                && this.lastEnqueuedSourceSignature !== sourceSignature);
        let recoveryWrite: RecoveryWrite | null = null;
        if (
            !sourceBarrier
            && this.durableProjection
            && this.durableSourceSignature === sourceSignature
            && this.lastEnqueuedProjection
            && this.lastEnqueuedSourceSignature === sourceSignature
            && manifest.revision > this.lastEnqueuedRevision
        ) {
            const pair = createSerializablePatches(
                this.lastEnqueuedProjection,
                historyRuntime.projection,
                TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
            );
            if (pair.patches.length > 0) {
                const entryKey = recoveryEntryStorageKey(manifest.revision);
                const entry: PersistedRecoveryEntry = {
                    version: 1,
                    fromRevision: this.lastEnqueuedRevision,
                    toRevision: manifest.revision,
                    fromAudioGraphRevision: this.lastEnqueuedAudioGraphRevision,
                    toAudioGraphRevision: manifest.audioGraphRevision,
                    patches: pair.patches,
                    historyIndex,
                    historyEntries: historyDelta.changedEntries,
                };
                const entryKeys = [...this.recoveryEntryKeys, entryKey];
                const index: PersistedRecoveryIndex = {
                    version: 1,
                    documentRevision: this.lastSavedRevision,
                    sourceSignature,
                    entryKeys,
                };
                this.recoveryEntryKeys = entryKeys;
                recoveryWrite = this.scheduleRecoveryWrite({ index, entryKey, entry });
            }
        }

        const historyCheckpoint: EditorHistoryCheckpoint = {
            index: historyIndex,
            changedEntries: historyDelta.changedEntries,
            deletedEntryIds: historyDelta.deletedEntryIds,
            recoveryKeysToDelete: this.getRecoveryKeysToDelete(),
            clearRecoveryIndex: true,
        };
        if (!this.latestQueued || manifest.revision > this.latestQueued.manifest.revision) {
            this.latestQueued = {
                manifest,
                generation,
                historyRuntime,
                historyCheckpoint,
                recoveryWrite,
                sourceBarrier,
            };
        }
        this.lastEnqueuedProjection = historyRuntime.projection;
        this.lastEnqueuedRevision = manifest.revision;
        this.lastEnqueuedSourceSignature = sourceSignature;
        this.lastEnqueuedAudioGraphRevision = manifest.audioGraphRevision;
        this.startProcessing(false);
    }

    /** Marks a manifest loaded from IndexedDB as authoritative without clearing failed newer work. */
    markManifestDurable(
        manifest: EditorManifestV3,
        historyRuntime?: TimelineHistoryRuntimeState,
        recoveryEntryKeys: readonly string[] = [],
    ): void {
        this.lastSavedRevision = Math.max(this.lastSavedRevision, manifest.revision);
        getManifestDescriptors(manifest).forEach((descriptor, identity) => {
            // A v2/v1 File resolved under a legacy key is still durable. Marking it here avoids
            // a quota-heavy duplicate typed-key Blob write on the first post-migration edit.
            this.durableFingerprints.set(identity, descriptor.fingerprint);
            this.pendingAssets.delete(assetPairKey(identity, descriptor.fingerprint));
        });
        if (this.failedRequest && this.failedRequest.manifest.revision <= manifest.revision) {
            this.failedRequest = null;
            this.lastFailure = null;
        }
        const sourceSignature = getManifestSourceSignature(manifest);
        this.durableSourceSignature = sourceSignature;
        this.lastEnqueuedSourceSignature = sourceSignature;
        this.lastEnqueuedRevision = manifest.revision;
        this.lastEnqueuedAudioGraphRevision = manifest.audioGraphRevision;
        this.durableAudioGraphRevision = manifest.audioGraphRevision;
        this.durableHistorySignatures.clear();
        // Recovery keys discovered during startup remain garbage even when their chain was
        // rejected. The next successful checkpoint deletes them with its manifest transaction.
        recoveryEntryKeys.forEach((key) => this.recoveryGarbageKeys.add(key));
        if (historyRuntime) {
            this.durableProjection = historyRuntime.projection;
            this.lastEnqueuedProjection = historyRuntime.projection;
            [...historyRuntime.history, ...historyRuntime.redoStack].forEach((entry) => {
                this.durableHistorySignatures.set(entry.id, historyEntrySignature(entry));
            });
        } else {
            // Without an auxiliary checkpoint we know neither a safe projection baseline nor which
            // entry payloads exist. Force the next save through the ordinary checkpoint path.
            this.durableProjection = null;
            this.lastEnqueuedProjection = null;
        }
    }

    observeFailure(): unknown | null {
        return this.lastFailure;
    }

    /** Returns the exact retained manifest so a reopened editor can align its live revision. */
    getFailedManifest(): EditorManifestV3 | null {
        return this.failedRequest?.manifest ?? null;
    }

    getSnapshot(): EditorPersistenceSnapshot {
        return {
            projectId: this.projectId,
            lastSavedRevision: this.lastSavedRevision,
            pendingAssetPairs: Array.from(this.pendingAssets.keys()),
            durableFingerprints: Object.fromEntries(this.durableFingerprints),
            lastFailure: this.lastFailure,
            hasNondurableDocument: this.failedRequest !== null || this.latestQueued !== null,
            isSettled: this.processing === null && this.latestQueued === null,
            deletionPending: this.deletionPending,
            disposed: this.disposed,
        };
    }

    async drain(options: { retryFailed?: boolean } = {}): Promise<void> {
        const retryFailed = options.retryFailed ?? true;
        let retriedFailedRequest = false;

        while (true) {
            if (!this.processing) {
                if (this.latestQueued) {
                    this.startProcessing(false);
                } else if (retryFailed && this.failedRequest && !retriedFailedRequest) {
                    retriedFailedRequest = true;
                    this.startProcessing(true);
                } else {
                    break;
                }
            }
            await this.processing;
        }

        if (this.lastFailure) {
            throw this.lastFailure;
        }
    }

    /**
     * Waits for work that is already running or queued, but deliberately leaves a previously
     * settled failed request untouched. Reopening a project may read the last durable manifest;
     * it must not launch a hidden retry that can race that read or overwrite its outcome.
     */
    async settleCurrentWork(): Promise<unknown | null> {
        while (true) {
            if (!this.processing) {
                if (this.latestQueued) this.startProcessing(false);
                else break;
            }
            await this.processing;
        }
        return this.lastFailure;
    }

    /**
     * Retries the newest nondurable document exactly once.
     *
     * Failed requests retain their referenced Files in pendingAssets, so retrying here never
     * rebuilds a manifest from possibly newer UI state and never falls back to an older durable
     * document. A concurrent enqueue is drained first because it is already the newest command.
     */
    async retryLatestFailure(generation: number): Promise<boolean> {
        await this.settleCurrentWork();
        if (!this.failedRequest) return false;

        // A failure can survive close/reopen. Rebinding only its notification generation keeps the
        // exact manifest/assets while allowing the newly attached project store to observe success.
        const failedRequest = this.failedRequest;
        if (failedRequest.recoveryWrite) this.recoveryChainInvalid = false;
        this.failedRequest = {
            ...failedRequest,
            generation,
            // The WAL write is part of the exact retained request, but its Promise represents only
            // one IndexedDB attempt. Retry the same immutable payload instead of awaiting a
            // permanently rejected Promise from the original transaction.
            recoveryWrite: failedRequest.recoveryWrite
                ? this.scheduleRecoveryWrite(failedRequest.recoveryWrite)
                : null,
        };
        this.startProcessing(true);
        if (this.processing) await this.processing;
        if (this.lastFailure) throw this.lastFailure;
        return true;
    }

    markDeletionPending(generation: number): void {
        if (this.deletionPending) return;
        this.deletionPending = true;
        this.notify({ projectId: this.projectId, generation, status: 'deletion-pending' });
    }

    reportDeletionBlocked(generation: number): void {
        this.notify({ projectId: this.projectId, generation, status: 'deletion-blocked' });
    }

    cancelDeletionAfterError(
        generation: number,
        error: unknown,
        failureBeforeDeletion: unknown | null,
    ): void {
        // onblocked keeps deletion pending, but an onerror result is terminal for that delete
        // request. Re-enable normal project use so the user can save, reopen, or retry deletion.
        this.deletionPending = false;
        this.disposed = false;
        this.lastFailure = failureBeforeDeletion ?? error;
        this.notify({ projectId: this.projectId, generation, status: 'error', error });
    }

    async dispose(): Promise<void> {
        if (this.processing) await this.processing;
        this.disposed = true;
    }

    markDeleted(generation: number): void {
        this.latestQueued = null;
        this.failedRequest = null;
        this.pendingAssets.clear();
        this.durableFingerprints.clear();
        this.lastFailure = null;
        this.disposed = true;
        this.notify({ projectId: this.projectId, generation, status: 'deleted' });
    }

    canEvict(): boolean {
        return this.processing === null
            && this.latestQueued === null
            && this.failedRequest === null
            && this.pendingAssets.size === 0;
    }

    private startProcessing(includeFailedRequest: boolean): void {
        if (this.processing) return;
        if (!this.latestQueued && !(includeFailedRequest && this.failedRequest)) return;

        this.processing = this.processQueue(includeFailedRequest).finally(() => {
            this.processing = null;
            // An enqueue occurring while the final transaction settles must not be stranded.
            if (this.latestQueued) this.startProcessing(false);
        });
    }

    private async processQueue(includeFailedRequest: boolean): Promise<void> {
        let canUseFailedRequest = includeFailedRequest;
        while (true) {
            const request = this.latestQueued
                ?? (canUseFailedRequest ? this.failedRequest : null);
            canUseFailedRequest = false;
            if (!request) return;

            if (this.latestQueued === request) this.latestQueued = null;
            if (this.failedRequest === request) this.failedRequest = null;
            if (request.manifest.revision <= this.lastSavedRevision) continue;

            let transactionAssets: EditorPersistentAsset[];
            try {
                transactionAssets = this.collectRequiredAssets(request.manifest);
            } catch (error) {
                this.recordFailure(request, error);
                return;
            }

            this.notify({
                projectId: this.projectId,
                generation: request.generation,
                status: 'saving',
                revision: request.manifest.revision,
            });

            try {
                if (request.recoveryWrite) await request.recoveryWrite.attempt;
                await this.writer.saveEditorDocument(
                    this.projectId,
                    request.manifest,
                    transactionAssets,
                    request.historyCheckpoint,
                );
                transactionAssets.forEach((asset) => {
                    const identity = assetIdentity(asset);
                    const pair = assetPairKey(identity, asset.asset.fingerprint);
                    // Only the exact pair captured by this transaction becomes durable. A newer
                    // File for the same ID cannot be accidentally cleared by an older completion.
                    if (this.pendingAssets.get(pair) === asset) this.pendingAssets.delete(pair);
                    this.durableFingerprints.set(identity, asset.asset.fingerprint);
                });
                this.pruneUnreferencedPendingAssets();
                this.lastSavedRevision = request.manifest.revision;
                this.durableProjection = request.historyRuntime.projection;
                this.durableSourceSignature = getManifestSourceSignature(request.manifest);
                this.durableAudioGraphRevision = request.manifest.audioGraphRevision;
                request.historyCheckpoint.deletedEntryIds.forEach((entryId) => {
                    this.durableHistorySignatures.delete(entryId);
                });
                request.historyCheckpoint.changedEntries.forEach((entry) => {
                    this.durableHistorySignatures.set(entry.id, historyEntrySignature(entry));
                });
                const deletedRecoveryKeys = new Set(request.historyCheckpoint.recoveryKeysToDelete);
                this.recoveryEntryKeys = this.recoveryEntryKeys.filter((key) => !deletedRecoveryKeys.has(key));
                deletedRecoveryKeys.forEach((key) => this.recoveryGarbageKeys.delete(key));
                this.lastFailure = null;
                this.failedRequest = null;
                this.notify({
                    projectId: this.projectId,
                    generation: request.generation,
                    status: 'saved',
                    revision: request.manifest.revision,
                });
                this.rebaseQueuedRequestFromDurable();
            } catch (error) {
                this.recordFailure(request, error);
                // A newer coalesced document gets one immediate attempt and carries every still
                // pending referenced source. Without a successor we stop to avoid retry loops.
                if (!this.latestQueued || this.latestQueued.manifest.revision <= request.manifest.revision) return;
                // The failed request's WAL may not exist, while the successor's prebuilt index may
                // still reference it. Rebase the successor directly from the durable checkpoint
                // so a crash can never expose an index containing a missing predecessor key.
                this.rebaseQueuedRequestFromDurable();
            }
        }
    }

    private collectRequiredAssets(manifest: EditorManifestV3): EditorPersistentAsset[] {
        return Array.from(getManifestDescriptors(manifest)).flatMap(([identity, descriptor]) => {
            if (this.durableFingerprints.get(identity) === descriptor.fingerprint) return [];
            const asset = this.pendingAssets.get(assetPairKey(identity, descriptor.fingerprint));
            if (!asset) {
                throw new Error(
                    `Revision ${manifest.revision} references nondurable source ${identity} without its File.`,
                );
            }
            return [asset];
        });
    }

    private pruneUnreferencedPendingAssets(): void {
        // A failed revision may reference fingerprint A while its coalesced successor replaces it
        // with fingerprint B. Once B commits, retaining A would pin a large File in memory and
        // prevent registry eviction forever. Preserve only pairs needed by the still-queued
        // successor; the just-committed request is already represented by durableFingerprints.
        const livePairs = new Set<string>();
        if (this.latestQueued) {
            getManifestDescriptors(this.latestQueued.manifest).forEach((descriptor, identity) => {
                livePairs.add(assetPairKey(identity, descriptor.fingerprint));
            });
        }
        this.pendingAssets.forEach((_asset, pair) => {
            if (!livePairs.has(pair)) this.pendingAssets.delete(pair);
        });
    }

    private recordFailure(request: SaveRequest, error: unknown): void {
        this.lastFailure = error;
        this.failedRequest = request;
        this.notify({
            projectId: this.projectId,
            generation: request.generation,
            status: 'error',
            revision: request.manifest.revision,
            error,
        });
    }

    /** Rebuilds the queued WAL as one complete step from the current durable checkpoint. */
    private rebaseQueuedRequestFromDurable(): void {
        const queued = this.latestQueued;
        if (!queued) return;
        // An old WAL attempt can still be in flight when its checkpoint makes this rebase
        // necessary. Give the replacement an independent generation so a late old failure cannot
        // invalidate the newly scheduled write and allow its checkpoint to run without a WAL.
        this.recoveryWriteGeneration += 1;
        // Coalescing may have already written intermediate WAL entries. They are no longer part of
        // the live chain, but must remain scheduled for deletion by the next atomic checkpoint.
        this.recoveryEntryKeys.forEach((key) => this.recoveryGarbageKeys.add(key));
        this.recoveryEntryKeys = [];
        this.recoveryChainInvalid = false;
        const historyDelta = this.createHistoryDelta(queued.historyRuntime);
        const rebasedCheckpoint: EditorHistoryCheckpoint = {
            ...queued.historyCheckpoint,
            changedEntries: historyDelta.changedEntries,
            deletedEntryIds: historyDelta.deletedEntryIds,
            recoveryKeysToDelete: this.getRecoveryKeysToDelete(),
        };
        if (queued.sourceBarrier) {
            this.latestQueued = { ...queued, recoveryWrite: null, historyCheckpoint: rebasedCheckpoint };
            return;
        }
        const sourceSignature = getManifestSourceSignature(queued.manifest);
        if (sourceSignature !== this.durableSourceSignature || !this.durableProjection) {
            this.latestQueued = { ...queued, recoveryWrite: null, historyCheckpoint: rebasedCheckpoint };
            return;
        }
        const pair = createSerializablePatches(
            this.durableProjection,
            queued.historyRuntime.projection,
            TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
        );
        if (pair.patches.length === 0) {
            this.latestQueued = { ...queued, recoveryWrite: null, historyCheckpoint: rebasedCheckpoint };
            return;
        }

        const entryKey = recoveryEntryStorageKey(queued.manifest.revision);
        const entry: PersistedRecoveryEntry = {
            version: 1,
            fromRevision: this.lastSavedRevision,
            toRevision: queued.manifest.revision,
            fromAudioGraphRevision: this.durableAudioGraphRevision,
            toAudioGraphRevision: queued.manifest.audioGraphRevision,
            patches: pair.patches,
            historyIndex: rebasedCheckpoint.index,
            historyEntries: rebasedCheckpoint.changedEntries,
        };
        const index: PersistedRecoveryIndex = {
            version: 1,
            documentRevision: this.lastSavedRevision,
            sourceSignature,
            entryKeys: [entryKey],
        };
        this.recoveryEntryKeys = [entryKey];
        const recoveryWrite = this.scheduleRecoveryWrite({ index, entryKey, entry });
        this.latestQueued = {
            ...queued,
            recoveryWrite,
            historyCheckpoint: {
                ...rebasedCheckpoint,
                recoveryKeysToDelete: this.getRecoveryKeysToDelete(),
                clearRecoveryIndex: true,
            },
        };
    }

    private getRecoveryKeysToDelete(): string[] {
        return Array.from(new Set([
            ...Array.from(this.recoveryGarbageKeys),
            ...this.recoveryEntryKeys,
        ]));
    }

    private createHistoryDelta(historyRuntime: TimelineHistoryRuntimeState): Pick<
        EditorHistoryCheckpoint,
        'changedEntries' | 'deletedEntryIds'
    > {
        const allEntries = [...historyRuntime.history, ...historyRuntime.redoStack];
        const retainedIds = new Set(allEntries.map((entry) => entry.id));
        return {
            changedEntries: allEntries.filter((entry) => (
                this.durableHistorySignatures.get(entry.id) !== historyEntrySignature(entry)
            )),
            // History bounds remove commands from the logical index. Persist the complementary
            // delete delta so their potentially large patch payloads do not remain orphaned in
            // IndexedDB after the manifest and new index commit.
            deletedEntryIds: Array.from(this.durableHistorySignatures.keys())
                .filter((entryId) => !retainedIds.has(entryId)),
        };
    }

    private scheduleRecoveryWrite(
        payload: Pick<RecoveryWrite, 'index' | 'entryKey' | 'entry'>,
    ): RecoveryWrite {
        // A failed WAL attempt must not poison the serialization chain. Each SaveRequest retains
        // its exact payload, while the next attempt starts after the previous one has settled.
        const generation = this.recoveryWriteGeneration;
        this.recoverySerial = this.recoverySerial
            .catch(() => undefined)
            .then(async () => {
                // A failed predecessor invalidates successor indexes that referenced it. Those
                // already-scheduled writes become no-ops; processQueue rebases the newest request
                // from the durable checkpoint and schedules it in the next generation.
                if (generation !== this.recoveryWriteGeneration) return;
                try {
                    await this.writer.writeEditorRecovery(
                        this.projectId,
                        payload.index,
                        payload.entryKey,
                        payload.entry,
                    );
                } catch (error) {
                    if (generation === this.recoveryWriteGeneration) {
                        this.recoveryWriteGeneration += 1;
                        this.recoveryChainInvalid = true;
                    }
                    throw error;
                }
            });
        return { ...payload, attempt: this.recoverySerial };
    }
}

export interface EditorPersistenceAttachment {
    projectId: string;
    generation: number;
    coordinator: EditorPersistenceCoordinator;
}

export class EditorPersistenceRegistry {
    private writer: EditorPersistenceWriter;
    private deleteDriver: ProjectDatabaseDeleteDriver;
    private coordinators = new Map<string, EditorPersistenceCoordinator>();
    private activeProjectId: string | null = null;
    private activeGeneration = 0;
    private nextGeneration = 1;
    private activeStatusListener: ((event: EditorPersistenceStatusEvent) => void) | null;

    constructor(
        writer: EditorPersistenceWriter,
        deleteDriver: ProjectDatabaseDeleteDriver,
        activeStatusListener: ((event: EditorPersistenceStatusEvent) => void) | null = null,
    ) {
        this.writer = writer;
        this.deleteDriver = deleteDriver;
        this.activeStatusListener = activeStatusListener;
    }

    setActiveStatusListener(listener: ((event: EditorPersistenceStatusEvent) => void) | null): void {
        this.activeStatusListener = listener;
    }

    attach(projectId: string): EditorPersistenceAttachment {
        const coordinator = this.getOrCreate(projectId);
        coordinator.assertCanOpen();
        const generation = this.nextGeneration;
        this.nextGeneration += 1;
        this.activeProjectId = projectId;
        this.activeGeneration = generation;
        return { projectId, generation, coordinator };
    }

    close(projectId: string, generation: number): void {
        if (this.activeProjectId === projectId && this.activeGeneration === generation) {
            this.activeProjectId = null;
            this.activeGeneration = 0;
        }
    }

    get(projectId: string): EditorPersistenceCoordinator | null {
        return this.coordinators.get(projectId) ?? null;
    }

    enqueue(
        projectId: string,
        generation: number,
        manifest: EditorManifestV3,
        sourceAssets: readonly EditorPersistentAsset[],
        historyRuntime: TimelineHistoryRuntimeState,
    ): void {
        this.getOrCreate(projectId).enqueue(manifest, sourceAssets, generation, historyRuntime);
    }

    async flush(projectId: string): Promise<void> {
        const coordinator = this.coordinators.get(projectId);
        if (coordinator) await coordinator.drain();
    }

    async settleBeforeOpen(projectId: string): Promise<unknown | null> {
        const coordinator = this.coordinators.get(projectId);
        if (!coordinator) return null;
        coordinator.assertCanOpen();
        return coordinator.settleCurrentWork();
    }

    observeFailure(projectId: string): unknown | null {
        return this.coordinators.get(projectId)?.observeFailure() ?? null;
    }

    getFailedManifest(projectId: string): EditorManifestV3 | null {
        return this.coordinators.get(projectId)?.getFailedManifest() ?? null;
    }

    async retry(projectId: string, generation: number): Promise<boolean> {
        const coordinator = this.coordinators.get(projectId);
        if (!coordinator) return false;
        coordinator.assertCanOpen();
        return coordinator.retryLatestFailure(generation);
    }

    markManifestDurable(
        projectId: string,
        manifest: EditorManifestV3,
        historyRuntime?: TimelineHistoryRuntimeState,
        recoveryEntryKeys: readonly string[] = [],
    ): void {
        this.getOrCreate(projectId).markManifestDurable(
            manifest,
            historyRuntime,
            recoveryEntryKeys,
        );
    }

    async deleteProject(projectId: string): Promise<void> {
        const coordinator = this.getOrCreate(projectId);
        const generation = this.activeProjectId === projectId ? this.activeGeneration : 0;
        coordinator.markDeletionPending(generation);

        try {
            await coordinator.drain({ retryFailed: false });
        } catch {
            // A failed save is irrelevant once the whole project is intentionally deleted. Its
            // failure remains observable until the database deletion itself succeeds.
        }
        const failureBeforeDeletion = coordinator.observeFailure();
        await coordinator.dispose();

        try {
            await this.deleteDriver(projectId, () => coordinator.reportDeletionBlocked(generation));
            coordinator.markDeleted(generation);
            if (this.activeProjectId === projectId) {
                this.activeProjectId = null;
                this.activeGeneration = 0;
            }
            this.evict(projectId);
        } catch (error) {
            coordinator.cancelDeletionAfterError(generation, error, failureBeforeDeletion);
            throw error;
        }
    }

    evict(projectId: string): boolean {
        const coordinator = this.coordinators.get(projectId);
        if (
            !coordinator
            || this.activeProjectId === projectId
            || !coordinator.canEvict()
        ) return false;
        this.coordinators.delete(projectId);
        return true;
    }

    private getOrCreate(projectId: string): EditorPersistenceCoordinator {
        const existing = this.coordinators.get(projectId);
        if (existing) return existing;
        const coordinator = new EditorPersistenceCoordinator(
            projectId,
            this.writer,
            (event) => this.handleStatus(event),
        );
        this.coordinators.set(projectId, coordinator);
        return coordinator;
    }

    private handleStatus(event: EditorPersistenceStatusEvent): void {
        if (event.projectId === this.activeProjectId && event.generation === this.activeGeneration) {
            this.activeStatusListener?.(event);
        }
    }
}

export const editorPersistenceRegistry = new EditorPersistenceRegistry(
    {
        saveEditorDocument: (projectId, manifest, sourceAssets, historyCheckpoint) => (
            storageService.saveEditorDocument(projectId, manifest, sourceAssets, historyCheckpoint)
        ),
        writeEditorRecovery: (projectId, index, entryKey, entry) => (
            storageService.writeEditorRecovery(projectId, index, entryKey, entry)
        ),
    },
    (projectId, onBlocked) => storageService.deleteProjectDatabase(projectId, onBlocked),
);

function getManifestDescriptors(manifest: EditorManifestV3): Map<string, { fingerprint: string }> {
    const entries: Array<readonly [string, { fingerprint: string }]> = [
        ...manifest.videoSourceDescriptors.map((descriptor): readonly [string, { fingerprint: string }] => [
            `video-source:${descriptor.id}`,
            descriptor,
        ]),
        ...manifest.audioSourceDescriptors.map((descriptor): readonly [string, { fingerprint: string }] => [
            `audio-source:${descriptor.id}`,
            descriptor,
        ]),
    ];
    return new Map(entries);
}

const historyEntrySignature = (entry: TimelineHistoryEntry): string => JSON.stringify({
    id: entry.id,
    sequence: entry.sequence,
    label: entry.label,
    mergeKey: entry.mergeKey,
    timestamp: entry.timestamp,
    patches: entry.patches,
    inversePatches: entry.inversePatches,
    audioGraphMutationImpact: entry.audioGraphMutationImpact,
    recalculatesContentBoundary: entry.recalculatesContentBoundary,
    byteSize: entry.byteSize,
    oversized: entry.oversized,
});
