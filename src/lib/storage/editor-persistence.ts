import type { EditorManifestV3 } from '@/types/video';
import { storageService, type EditorPersistentAsset } from './storage-service';

export interface EditorPersistenceWriter {
    saveEditorDocument: (
        projectId: string,
        manifest: EditorManifestV3,
        sourceAssets: readonly EditorPersistentAsset[],
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

        if (!this.latestQueued || manifest.revision > this.latestQueued.manifest.revision) {
            this.latestQueued = { manifest, generation };
        }
        this.startProcessing(false);
    }

    /** Marks a manifest loaded from IndexedDB as authoritative without clearing failed newer work. */
    markManifestDurable(manifest: EditorManifestV3): void {
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
    }

    observeFailure(): unknown | null {
        return this.lastFailure;
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
                await this.writer.saveEditorDocument(this.projectId, request.manifest, transactionAssets);
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
                this.lastFailure = null;
                this.failedRequest = null;
                this.notify({
                    projectId: this.projectId,
                    generation: request.generation,
                    status: 'saved',
                    revision: request.manifest.revision,
                });
            } catch (error) {
                this.recordFailure(request, error);
                // A newer coalesced document gets one immediate attempt and carries every still
                // pending referenced source. Without a successor we stop to avoid retry loops.
                if (!this.latestQueued || this.latestQueued.manifest.revision <= request.manifest.revision) return;
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
    ): void {
        this.getOrCreate(projectId).enqueue(manifest, sourceAssets, generation);
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

    markManifestDurable(projectId: string, manifest: EditorManifestV3): void {
        this.getOrCreate(projectId).markManifestDurable(manifest);
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
        saveEditorDocument: (projectId, manifest, sourceAssets) => (
            storageService.saveEditorDocument(projectId, manifest, sourceAssets)
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
