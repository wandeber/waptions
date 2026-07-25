import {
    isSha256Digest,
    type EditorialTranscriptDescriptorV1,
    type EditorialTranscriptRecordBodyV1,
    type Sha256Digest,
} from '@/types/editorial';
import {
    assertEditorialDescriptorMatchesBody,
    createEditorialTranscriptRequestKey,
} from '@/lib/editorial-transcription/identity';
import {
    verifyCanonicalEditorialTranscriptRecord,
    type CanonicalEditorialTranscriptRecordV1,
} from '@/lib/editorial-transcription/transcript-body';

export const EDITORIAL_TRANSCRIPT_DATABASE = 'waptions-editorial-transcripts';
const EDITORIAL_TRANSCRIPT_DATABASE_VERSION = 1;
const RECORD_STORE = 'records';
const REQUEST_STORE = 'request-index';
const PIN_STORE = 'pins';
const STORED_RECORD_KEYS = new Set(['recordId', 'canonicalJson', 'byteLength', 'lastAccess']);
const REQUEST_INDEX_KEYS = new Set(['requestKey', 'descriptor', 'updatedAt']);
const PIN_SET_KEYS = new Set([
    'id',
    'kind',
    'projectId',
    'scopeId',
    'generation',
    'recordIds',
    'updatedAt',
]);
const DESCRIPTOR_KEYS = new Set([
    'version',
    'recordId',
    'requestKey',
    'sourceKind',
    'sourceId',
    'sourceFingerprint',
    'pcmAlgorithmVersion',
    'recordBodyVersion',
    'canonicalJsonVersion',
    'responseSchema',
    'requestedModel',
    'canonicalModel',
    'sampleRateHz',
    'sampleCount',
    'language',
    'speakerMode',
    'endpointIdentityDigest',
    'acquisition',
    'createdAt',
]);

export type EditorialTranscriptPinKind =
    | 'session'
    | 'pending'
    | 'durable'
    | 'history'
    | 'redo'
    | 'wal';

export interface StoredEditorialTranscriptRecord {
    recordId: Sha256Digest;
    canonicalJson: string;
    byteLength: number;
    lastAccess: number;
}

export interface StoredEditorialRequestIndex {
    requestKey: Sha256Digest;
    descriptor: EditorialTranscriptDescriptorV1;
    updatedAt: number;
}

export interface EditorialTranscriptPinSet {
    id: string;
    kind: EditorialTranscriptPinKind;
    projectId: string;
    scopeId: string;
    generation: number | null;
    recordIds: Sha256Digest[];
    updatedAt: number;
}

export interface PublishEditorialProjectPinsInput {
    projectId: string;
    generation: number;
    durableRecordIds: readonly Sha256Digest[];
    historyRecordIds: readonly Sha256Digest[];
    redoRecordIds: readonly Sha256Digest[];
    walRecordIds: readonly Sha256Digest[];
    updatedAt: number;
}

/** Narrow driver contract keeps quota, corruption, interruption and CAS races deterministic. */
export interface EditorialTranscriptRepositoryDriver {
    readRecord(recordId: Sha256Digest): Promise<StoredEditorialTranscriptRecord | null>;
    writeRecordIfAbsent(record: StoredEditorialTranscriptRecord): Promise<StoredEditorialTranscriptRecord | null>;
    touchRecord(recordId: Sha256Digest, lastAccess: number): Promise<void>;
    readRequest(requestKey: Sha256Digest): Promise<StoredEditorialRequestIndex | null>;
    compareAndSwapRequest(
        requestKey: Sha256Digest,
        expectedRecordId: Sha256Digest | null,
        next: StoredEditorialRequestIndex,
    ): Promise<boolean>;
    replacePinSet(pinSet: EditorialTranscriptPinSet): Promise<void>;
    removePinSet(pinId: string): Promise<void>;
    publishProjectPins(input: PublishEditorialProjectPinsInput): Promise<void>;
    listRecords(): Promise<StoredEditorialTranscriptRecord[]>;
    listRequests(): Promise<StoredEditorialRequestIndex[]>;
    listPinSets(): Promise<EditorialTranscriptPinSet[]>;
    removeRecordsAndRequests(
        recordIds: readonly Sha256Digest[],
        requestKeys: readonly Sha256Digest[],
    ): Promise<void>;
    removeUnpinnedRecordsAndRequests(
        recordIds: readonly Sha256Digest[],
        requestKeys: readonly Sha256Digest[],
    ): Promise<Sha256Digest[]>;
}

export class EditorialTranscriptCorruptionError extends Error {
    constructor(message = 'A referenced editorial transcript record is missing or corrupt.') {
        super(message);
        this.name = 'EditorialTranscriptCorruptionError';
    }
}

export class EditorialTranscriptRepository {
    private readonly driver: EditorialTranscriptRepositoryDriver;
    private readonly now: () => number;

    constructor(options: {
        driver?: EditorialTranscriptRepositoryDriver;
        now?: () => number;
    } = {}) {
        this.driver = options.driver ?? new IndexedDbEditorialTranscriptRepositoryDriver();
        this.now = options.now ?? Date.now;
    }

    async putRecord(record: CanonicalEditorialTranscriptRecordV1): Promise<void> {
        let verified: CanonicalEditorialTranscriptRecordV1;
        try {
            verified = await verifyCanonicalEditorialTranscriptRecord(record.body, record.recordId);
            if (verified.canonicalJson !== record.canonicalJson
                || !equalBytes(verified.canonicalBytes, record.canonicalBytes)) {
                throw new Error('Editorial transcript record representations disagree.');
            }
        } catch {
            // The write boundary never trusts a type assertion or imported sidecar wrapper. Only
            // a body whose stable IDs, canonical bytes and outer content address all agree may
            // enter immutable storage.
            throw new EditorialTranscriptCorruptionError(
                'Editorial transcript record failed immutable identity verification.',
            );
        }
        const stored: StoredEditorialTranscriptRecord = {
            recordId: verified.recordId,
            canonicalJson: verified.canonicalJson,
            byteLength: verified.canonicalBytes.byteLength,
            lastAccess: this.now(),
        };
        const existing = await this.driver.writeRecordIfAbsent(stored);
        if (existing) {
            // A content address is immutable. Equal bytes are an idempotent dedupe; unequal bytes
            // indicate corruption or a cryptographic collision and must never be overwritten.
            if (existing.canonicalJson !== stored.canonicalJson
                || existing.byteLength !== stored.byteLength) {
                throw new EditorialTranscriptCorruptionError(
                    'Immutable editorial transcript bytes conflict with an existing record.',
                );
            }
            await this.driver.touchRecord(record.recordId, this.now());
        }
    }

    async getRecord(
        recordId: Sha256Digest,
        options: {
            descriptor?: EditorialTranscriptDescriptorV1;
            referenced?: boolean;
        } = {},
    ): Promise<EditorialTranscriptRecordBodyV1 | null> {
        const stored = await this.driver.readRecord(recordId);
        if (!stored) {
            if (options.referenced || options.descriptor) throw new EditorialTranscriptCorruptionError();
            return null;
        }
        try {
            if (!isStoredEditorialTranscriptRecord(stored, recordId)) {
                throw new Error('Editorial transcript storage wrapper is invalid.');
            }
            if (stored.byteLength !== new TextEncoder().encode(stored.canonicalJson).byteLength) {
                throw new Error('Editorial transcript byte length is invalid.');
            }
            const parsed: unknown = JSON.parse(stored.canonicalJson);
            const verified = await verifyCanonicalEditorialTranscriptRecord(parsed, recordId);
            if (verified.canonicalJson !== stored.canonicalJson) {
                throw new Error('Editorial transcript bytes are not canonical JSON.');
            }
            if (options.descriptor) assertEditorialDescriptorMatchesBody(options.descriptor, verified.body);
            // Access metadata is best effort. A touch failure must never delete a valid pinned
            // body or turn a durable project reference into corruption.
            void this.driver.touchRecord(recordId, this.now()).catch(() => undefined);
            return deepFreeze(verified.body);
        } catch {
            const pinned = await this.isRecordPinned(recordId);
            if (pinned || options.referenced || options.descriptor) {
                throw new EditorialTranscriptCorruptionError();
            }
            const removed = await this.removeUnpinnedCorruptRecord(recordId);
            if (!removed) throw new EditorialTranscriptCorruptionError();
            return null;
        }
    }

    async getRequestDescriptor(
        requestKey: Sha256Digest,
    ): Promise<EditorialTranscriptDescriptorV1 | null> {
        const index = await this.driver.readRequest(requestKey);
        if (!index) return null;
        if (!isStoredRequestIndex(index, requestKey)) {
            await this.driver.removeRecordsAndRequests([], [requestKey]);
            return null;
        }
        const body = await this.getRecord(index.descriptor.recordId);
        if (!body) {
            await this.driver.removeRecordsAndRequests([], [requestKey]);
            return null;
        }
        try {
            assertEditorialDescriptorMatchesBody(index.descriptor, body);
            await assertEditorialRequestKeyMatchesDescriptor(index.descriptor);
            return index.descriptor;
        } catch {
            await this.driver.removeRecordsAndRequests([], [requestKey]);
            return null;
        }
    }

    /**
     * Publishes request provenance only when the caller-observed record still matches. Regenerate
     * callers pass the previously observed record ID; a concurrent winner remains authoritative
     * rather than being silently overwritten by a stale completion.
     */
    async compareAndSwapRequestIndex(input: {
        requestKey: Sha256Digest;
        expectedRecordId: Sha256Digest | null;
        descriptor: EditorialTranscriptDescriptorV1;
    }): Promise<boolean> {
        if (input.descriptor.requestKey !== input.requestKey) {
            throw new Error('Editorial request descriptor key mismatch.');
        }
        if (!isEditorialTranscriptDescriptor(input.descriptor)) {
            throw new Error('Editorial request descriptor metadata is invalid.');
        }
        await assertEditorialRequestKeyMatchesDescriptor(input.descriptor);
        await this.getRecord(input.descriptor.recordId, {
            descriptor: input.descriptor,
            referenced: true,
        });
        return this.driver.compareAndSwapRequest(
            input.requestKey,
            input.expectedRecordId,
            {
                requestKey: input.requestKey,
                descriptor: input.descriptor,
                updatedAt: this.now(),
            },
        );
    }

    async setSessionPins(
        projectId: string,
        sessionId: string,
        recordIds: readonly Sha256Digest[],
    ): Promise<void> {
        await this.replacePinSet('session', projectId, sessionId, null, recordIds);
    }

    async clearSessionPins(projectId: string, sessionId: string): Promise<void> {
        await this.driver.removePinSet(pinSetId('session', projectId, sessionId));
    }

    async setPendingGenerationPins(
        projectId: string,
        generation: number,
        recordIds: readonly Sha256Digest[],
    ): Promise<void> {
        assertGeneration(generation);
        await this.replacePinSet('pending', projectId, String(generation), generation, recordIds);
    }

    /** Clears one superseded persistence generation without disturbing newer pending work. */
    async clearPendingGenerationPins(projectId: string, generation: number): Promise<void> {
        assertGeneration(generation);
        await this.driver.removePinSet(pinSetId('pending', projectId, String(generation)));
    }

    /**
     * Makes durable/history/redo/WAL sets visible before removing the matching pending set, all in
     * one transcript-database transaction. The project database must already have committed its
     * descriptor-only generation before callers invoke this method.
     */
    async publishDurableProjectPins(input: Omit<PublishEditorialProjectPinsInput, 'updatedAt'>): Promise<void> {
        assertGeneration(input.generation);
        await this.assertRecordsExist([
            ...input.durableRecordIds,
            ...input.historyRecordIds,
            ...input.redoRecordIds,
            ...input.walRecordIds,
        ]);
        await this.driver.publishProjectPins({ ...input, updatedAt: this.now() });
    }

    async replaceHistoryPins(projectId: string, generation: number, recordIds: readonly Sha256Digest[]): Promise<void> {
        await this.replacePinSet('history', projectId, 'current', generation, recordIds);
    }

    async replaceRedoPins(projectId: string, generation: number, recordIds: readonly Sha256Digest[]): Promise<void> {
        await this.replacePinSet('redo', projectId, 'current', generation, recordIds);
    }

    async replaceWalPins(projectId: string, generation: number, recordIds: readonly Sha256Digest[]): Promise<void> {
        await this.replacePinSet('wal', projectId, 'current', generation, recordIds);
    }

    async deleteProjectPins(projectId: string): Promise<void> {
        const pins = await this.listVerifiedPinSets();
        await Promise.all(pins
            .filter(pin => pin.projectId === projectId)
            .map(pin => this.driver.removePinSet(pin.id)));
    }

    async reconcileProjectPins(input: {
        projects: readonly Omit<PublishEditorialProjectPinsInput, 'updatedAt'>[];
        completeProjectSnapshot: boolean;
        stalePendingBefore: number;
    }): Promise<{ rebuiltProjects: number; removedPendingPins: number }> {
        let rebuiltProjects = 0;
        for (const project of input.projects) {
            await this.publishDurableProjectPins(project);
            rebuiltProjects += 1;
        }
        if (!input.completeProjectSnapshot) {
            return { rebuiltProjects, removedPendingPins: 0 };
        }
        const committedGenerations = new Set(input.projects.map(project => (
            `${project.projectId}:${project.generation}`
        )));
        const pins = await this.listVerifiedPinSets();
        let removedPendingPins = 0;
        for (const pin of pins) {
            if (pin.kind !== 'pending' || pin.updatedAt >= input.stalePendingBefore) continue;
            if (pin.generation !== null
                && committedGenerations.has(`${pin.projectId}:${pin.generation}`)) continue;
            await this.driver.removePinSet(pin.id);
            removedPendingPins += 1;
        }
        return { rebuiltProjects, removedPendingPins };
    }

    async collectGarbage(input: {
        maxRecordCount: number;
        batchSize: number;
    }): Promise<{ removedRecordIds: Sha256Digest[]; hasMore: boolean }> {
        if (!Number.isSafeInteger(input.maxRecordCount) || input.maxRecordCount < 0
            || !Number.isSafeInteger(input.batchSize) || input.batchSize <= 0) {
            throw new Error('Editorial GC bounds are invalid.');
        }
        const [records, requests, pins] = await Promise.all([
            this.driver.listRecords(),
            this.driver.listRequests(),
            this.listVerifiedPinSets(),
        ]);
        if (records.length <= input.maxRecordCount) return { removedRecordIds: [], hasMore: false };
        const pinned = new Set(pins.flatMap(pin => pin.recordIds));
        const candidates = records
            .filter(record => !pinned.has(record.recordId))
            .sort((left, right) => left.lastAccess - right.lastAccess
                || left.recordId.localeCompare(right.recordId));
        const requiredRemoval = records.length - input.maxRecordCount;
        const removedRecordIds = candidates
            .slice(0, Math.min(requiredRemoval, input.batchSize))
            .map(record => record.recordId);
        const removedSet = new Set(removedRecordIds);
        const requestKeys = requests
            .filter(request => removedSet.has(request.descriptor.recordId))
            .map(request => request.requestKey);
        const actuallyRemoved = await this.driver.removeUnpinnedRecordsAndRequests(
            removedRecordIds,
            requestKeys,
        );
        return {
            removedRecordIds: actuallyRemoved,
            hasMore: requiredRemoval > actuallyRemoved.length
                && candidates.length > actuallyRemoved.length,
        };
    }

    private async replacePinSet(
        kind: EditorialTranscriptPinKind,
        projectId: string,
        scopeId: string,
        generation: number | null,
        recordIds: readonly Sha256Digest[],
    ): Promise<void> {
        if (!projectId || !scopeId) throw new Error('Editorial pin identity is required.');
        if (generation !== null) assertGeneration(generation);
        const normalized = uniqueRecordIds(recordIds);
        await this.assertRecordsExist(normalized);
        await this.driver.replacePinSet({
            id: pinSetId(kind, projectId, scopeId),
            kind,
            projectId,
            scopeId,
            generation,
            recordIds: normalized,
            updatedAt: this.now(),
        });
    }

    private async assertRecordsExist(recordIds: readonly Sha256Digest[]): Promise<void> {
        for (const recordId of uniqueRecordIds(recordIds)) {
            await this.getRecord(recordId, { referenced: true });
        }
    }

    private async isRecordPinned(recordId: Sha256Digest): Promise<boolean> {
        return (await this.listVerifiedPinSets()).some(pin => pin.recordIds.includes(recordId));
    }

    private async listVerifiedPinSets(): Promise<EditorialTranscriptPinSet[]> {
        const pins = await this.driver.listPinSets();
        if (pins.some(pin => !isEditorialTranscriptPinSet(pin))) {
            // Pin metadata is the authority that prevents GC from creating dangling project,
            // history or WAL references. Unlike a disposable request index, corruption here must
            // fail closed and leave every record untouched for explicit recovery/reconciliation.
            throw new EditorialTranscriptCorruptionError(
                'Editorial transcript pin metadata is corrupt.',
            );
        }
        return pins;
    }

    private async removeUnpinnedCorruptRecord(recordId: Sha256Digest): Promise<boolean> {
        const requests = await this.driver.listRequests();
        const removed = await this.driver.removeUnpinnedRecordsAndRequests(
            [recordId],
            requests
                .filter(request => request.descriptor.recordId === recordId)
                .map(request => request.requestKey),
        );
        return removed.includes(recordId);
    }
}

interface InFlightConsumer<Result> {
    active: boolean;
    resolve(value: Result): void;
    reject(error: unknown): void;
    removeAbortListener(): void;
}

interface InFlightEntry<Result> {
    controller: AbortController;
    consumers: Set<InFlightConsumer<Result>>;
}

/** Reference-counted requestKey job registry used across projects and repeated occurrences. */
export class EditorialTranscriptInFlightRegistry<Result> {
    private readonly entries = new Map<Sha256Digest, InFlightEntry<Result>>();

    subscribe(input: {
        requestKey: Sha256Digest;
        signal?: AbortSignal;
        run(signal: AbortSignal): Promise<Result>;
    }): Promise<Result> {
        if (input.signal?.aborted) return Promise.reject(createAbortError());
        let entry = this.entries.get(input.requestKey);
        if (!entry) {
            entry = { controller: new AbortController(), consumers: new Set() };
            this.entries.set(input.requestKey, entry);
            const ownedEntry = entry;
            void Promise.resolve().then(() => input.run(ownedEntry.controller.signal)).then(
                value => this.settle(input.requestKey, ownedEntry, { value }),
                error => this.settle(input.requestKey, ownedEntry, { error }),
            );
        }
        const subscribedEntry = entry;
        return new Promise<Result>((resolve, reject) => {
            const onAbort = () => {
                if (!consumer.active) return;
                consumer.active = false;
                subscribedEntry.consumers.delete(consumer);
                reject(createAbortError());
                if (subscribedEntry.consumers.size === 0) {
                    if (this.entries.get(input.requestKey) === subscribedEntry) {
                        this.entries.delete(input.requestKey);
                    }
                    subscribedEntry.controller.abort();
                }
            };
            const consumer: InFlightConsumer<Result> = {
                active: true,
                resolve,
                reject,
                removeAbortListener: () => input.signal?.removeEventListener('abort', onAbort),
            };
            subscribedEntry.consumers.add(consumer);
            input.signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    get activeJobCount(): number {
        return this.entries.size;
    }

    private settle(
        requestKey: Sha256Digest,
        entry: InFlightEntry<Result>,
        result: { value: Result } | { error: unknown },
    ): void {
        if (this.entries.get(requestKey) === entry) this.entries.delete(requestKey);
        for (const consumer of Array.from(entry.consumers)) {
            if (!consumer.active) continue;
            consumer.active = false;
            consumer.removeAbortListener();
            if ('error' in result) consumer.reject(result.error);
            else consumer.resolve(result.value);
        }
        entry.consumers.clear();
    }
}

export class IndexedDbEditorialTranscriptRepositoryDriver
implements EditorialTranscriptRepositoryDriver {
    private disabled = false;

    constructor(private readonly databaseProvider?: () => Promise<IDBDatabase>) {}

    async readRecord(recordId: Sha256Digest): Promise<StoredEditorialTranscriptRecord | null> {
        return this.readOne(RECORD_STORE, recordId);
    }

    async writeRecordIfAbsent(
        record: StoredEditorialTranscriptRecord,
    ): Promise<StoredEditorialTranscriptRecord | null> {
        return this.runTransaction([RECORD_STORE], 'readwrite', (transaction, setResult, fail) => {
            const store = transaction.objectStore(RECORD_STORE);
            setResult(null);
            const request = store.get(record.recordId);
            request.onerror = () => fail(request.error);
            request.onsuccess = () => {
                const existing = request.result as StoredEditorialTranscriptRecord | undefined;
                if (existing) {
                    setResult(existing);
                    return;
                }
                const put = store.put(record);
                put.onerror = () => fail(put.error);
            };
        });
    }

    async touchRecord(recordId: Sha256Digest, lastAccess: number): Promise<void> {
        await this.runTransaction([RECORD_STORE], 'readwrite', (transaction, setResult, fail) => {
            const store = transaction.objectStore(RECORD_STORE);
            setResult(undefined);
            const request = store.get(recordId);
            request.onerror = () => fail(request.error);
            request.onsuccess = () => {
                if (!request.result) return;
                const put = store.put({ ...request.result, lastAccess });
                put.onerror = () => fail(put.error);
            };
        });
    }

    async readRequest(requestKey: Sha256Digest): Promise<StoredEditorialRequestIndex | null> {
        return this.readOne(REQUEST_STORE, requestKey);
    }

    async compareAndSwapRequest(
        requestKey: Sha256Digest,
        expectedRecordId: Sha256Digest | null,
        next: StoredEditorialRequestIndex,
    ): Promise<boolean> {
        return this.runTransaction([RECORD_STORE, REQUEST_STORE], 'readwrite', (transaction, setResult, fail) => {
            const store = transaction.objectStore(REQUEST_STORE);
            setResult(false);
            const request = store.get(requestKey);
            request.onerror = () => fail(request.error);
            request.onsuccess = () => {
                const current = request.result as StoredEditorialRequestIndex | undefined;
                if ((current?.descriptor.recordId ?? null) !== expectedRecordId) return;
                // The record-existence check shares the same transaction as the index write and
                // overlaps GC's records/request-index transaction. A record verified by the
                // repository immediately before this call therefore cannot disappear in the
                // gap and leave a newly published dangling request entry.
                this.afterRecordsExist(transaction, [next.descriptor.recordId], fail, () => {
                    const put = store.put(next);
                    put.onerror = () => fail(put.error);
                    setResult(true);
                });
            };
        });
    }

    async replacePinSet(pinSet: EditorialTranscriptPinSet): Promise<void> {
        await this.runTransaction([RECORD_STORE, PIN_STORE], 'readwrite', (
            transaction,
            setResult,
            fail,
        ) => {
            setResult(undefined);
            this.afterRecordsExist(transaction, pinSet.recordIds, fail, () => {
                const request = transaction.objectStore(PIN_STORE).put(pinSet);
                request.onerror = () => fail(request.error);
            });
        });
    }

    async removePinSet(pinId: string): Promise<void> {
        await this.deleteOne(PIN_STORE, pinId);
    }

    async publishProjectPins(input: PublishEditorialProjectPinsInput): Promise<void> {
        await this.runTransaction([RECORD_STORE, PIN_STORE], 'readwrite', (transaction, setResult, fail) => {
            setResult(undefined);
            const definitions: [EditorialTranscriptPinKind, readonly Sha256Digest[]][] = [
                ['durable', input.durableRecordIds],
                ['history', input.historyRecordIds],
                ['redo', input.redoRecordIds],
                ['wal', input.walRecordIds],
            ];
            this.afterRecordsExist(
                transaction,
                definitions.flatMap(definition => Array.from(definition[1])),
                fail,
                () => {
                    const store = transaction.objectStore(PIN_STORE);
                    for (const [kind, recordIds] of definitions) {
                        const put = store.put({
                            id: pinSetId(kind, input.projectId, 'current'),
                            kind,
                            projectId: input.projectId,
                            scopeId: 'current',
                            generation: input.generation,
                            recordIds: uniqueRecordIds(recordIds),
                            updatedAt: input.updatedAt,
                        } satisfies EditorialTranscriptPinSet);
                        put.onerror = () => fail(put.error);
                    }
                    // Pending is released last in program order, after all conservative durable
                    // sets have been enqueued in this same atomic transaction.
                    const remove = store.delete(pinSetId(
                        'pending',
                        input.projectId,
                        String(input.generation),
                    ));
                    remove.onerror = () => fail(remove.error);
                },
            );
        });
    }

    async listRecords(): Promise<StoredEditorialTranscriptRecord[]> {
        return this.listStore(RECORD_STORE);
    }

    async listRequests(): Promise<StoredEditorialRequestIndex[]> {
        return this.listStore(REQUEST_STORE);
    }

    async listPinSets(): Promise<EditorialTranscriptPinSet[]> {
        return this.listStore(PIN_STORE);
    }

    async removeRecordsAndRequests(
        recordIds: readonly Sha256Digest[],
        requestKeys: readonly Sha256Digest[],
    ): Promise<void> {
        await this.runTransaction(
            [RECORD_STORE, REQUEST_STORE],
            'readwrite',
            (transaction, setResult, fail) => {
                setResult(undefined);
                for (const recordId of recordIds) {
                    const request = transaction.objectStore(RECORD_STORE).delete(recordId);
                    request.onerror = () => fail(request.error);
                }
                for (const requestKey of requestKeys) {
                    const request = transaction.objectStore(REQUEST_STORE).delete(requestKey);
                    request.onerror = () => fail(request.error);
                }
            },
        );
    }

    async removeUnpinnedRecordsAndRequests(
        recordIds: readonly Sha256Digest[],
        requestKeys: readonly Sha256Digest[],
    ): Promise<Sha256Digest[]> {
        return this.runTransaction(
            [RECORD_STORE, REQUEST_STORE, PIN_STORE],
            'readwrite',
            (transaction, setResult, fail) => {
                setResult([]);
                const pinsRequest = transaction.objectStore(PIN_STORE).getAll();
                pinsRequest.onerror = () => fail(pinsRequest.error);
                pinsRequest.onsuccess = () => {
                    const pins = pinsRequest.result as EditorialTranscriptPinSet[];
                    if (pins.some(pin => !isEditorialTranscriptPinSet(pin))) {
                        fail(new EditorialTranscriptCorruptionError(
                            'Editorial transcript pin metadata is corrupt.',
                        ));
                        return;
                    }
                    const pinned = new Set(pins.flatMap(pin => pin.recordIds));
                    const removed = recordIds.filter(recordId => !pinned.has(recordId));
                    const removedSet = new Set(removed);
                    for (const recordId of removed) {
                        const request = transaction.objectStore(RECORD_STORE).delete(recordId);
                        request.onerror = () => fail(request.error);
                    }
                    for (const requestKey of requestKeys) {
                        const read = transaction.objectStore(REQUEST_STORE).get(requestKey);
                        read.onerror = () => fail(read.error);
                        read.onsuccess = () => {
                            const index = read.result as StoredEditorialRequestIndex | undefined;
                            if (!index || !removedSet.has(index.descriptor.recordId)) return;
                            const remove = transaction.objectStore(REQUEST_STORE).delete(requestKey);
                            remove.onerror = () => fail(remove.error);
                        };
                    }
                    setResult(removed);
                };
            },
        );
    }

    private async readOne<Value>(storeName: string, key: IDBValidKey): Promise<Value | null> {
        return this.runTransaction([storeName], 'readonly', (transaction, setResult, fail) => {
            setResult(null);
            const request = transaction.objectStore(storeName).get(key);
            request.onerror = () => fail(request.error);
            request.onsuccess = () => setResult((request.result as Value | undefined) ?? null);
        });
    }

    private async listStore<Value>(storeName: string): Promise<Value[]> {
        return this.runTransaction([storeName], 'readonly', (transaction, setResult, fail) => {
            setResult([]);
            const request = transaction.objectStore(storeName).getAll();
            request.onerror = () => fail(request.error);
            request.onsuccess = () => setResult(request.result as Value[]);
        });
    }

    private async deleteOne(storeName: string, key: IDBValidKey): Promise<void> {
        await this.runTransaction([storeName], 'readwrite', (transaction, setResult, fail) => {
            setResult(undefined);
            const request = transaction.objectStore(storeName).delete(key);
            request.onerror = () => fail(request.error);
        });
    }

    private afterRecordsExist(
        transaction: IDBTransaction,
        recordIds: readonly Sha256Digest[],
        fail: (error: unknown) => void,
        next: () => void,
    ): void {
        const unique = uniqueRecordIds(recordIds);
        if (unique.length === 0) {
            next();
            return;
        }
        let remaining = unique.length;
        for (const recordId of unique) {
            const request = transaction.objectStore(RECORD_STORE).get(recordId);
            request.onerror = () => fail(request.error);
            request.onsuccess = () => {
                if (!request.result) {
                    fail(new EditorialTranscriptCorruptionError());
                    return;
                }
                remaining -= 1;
                if (remaining === 0) next();
            };
        }
    }

    private async openDatabase(): Promise<IDBDatabase> {
        if (this.databaseProvider) return this.databaseProvider();
        if (this.disabled || typeof indexedDB === 'undefined') {
            throw new Error('Editorial transcript IndexedDB is unavailable.');
        }
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(
                EDITORIAL_TRANSCRIPT_DATABASE,
                EDITORIAL_TRANSCRIPT_DATABASE_VERSION,
            );
            let settled = false;
            const fail = (error: unknown) => {
                if (settled) return;
                settled = true;
                this.disabled = true;
                reject(error);
            };
            request.onerror = () => fail(request.error);
            request.onblocked = () => fail(new Error('Opening editorial transcript storage was blocked.'));
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(RECORD_STORE)) {
                    request.result.createObjectStore(RECORD_STORE, { keyPath: 'recordId' });
                }
                if (!request.result.objectStoreNames.contains(REQUEST_STORE)) {
                    request.result.createObjectStore(REQUEST_STORE, { keyPath: 'requestKey' });
                }
                if (!request.result.objectStoreNames.contains(PIN_STORE)) {
                    request.result.createObjectStore(PIN_STORE, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => {
                if (settled) {
                    request.result.close();
                    return;
                }
                settled = true;
                request.result.onversionchange = () => request.result.close();
                resolve(request.result);
            };
        });
    }

    private async runTransaction<Result>(
        storeNames: readonly string[],
        mode: IDBTransactionMode,
        run: (
            transaction: IDBTransaction,
            setResult: (result: Result) => void,
            fail: (error: unknown) => void,
        ) => void,
    ): Promise<Result> {
        const database = await this.openDatabase();
        return new Promise((resolve, reject) => {
            let result: Result;
            let explicitError: unknown;
            let settled = false;
            let transaction: IDBTransaction;
            try {
                transaction = database.transaction(storeNames, mode);
            } catch (error) {
                database.close();
                reject(error);
                return;
            }
            const finish = (error?: unknown) => {
                if (settled) return;
                settled = true;
                database.close();
                if (error !== undefined) reject(error);
                else resolve(result);
            };
            const fail = (error: unknown) => {
                explicitError = error ?? new Error('Editorial transcript storage request failed.');
                try {
                    transaction.abort();
                } catch {
                    finish(explicitError);
                }
            };
            transaction.oncomplete = () => finish();
            transaction.onerror = () => finish(explicitError ?? transaction.error);
            transaction.onabort = () => finish(explicitError ?? transaction.error);
            try {
                run(transaction, next => {
                    result = next;
                }, fail);
            } catch (error) {
                fail(error);
            }
        });
    }
}

function pinSetId(kind: EditorialTranscriptPinKind, projectId: string, scopeId: string): string {
    return `${kind}:${encodeURIComponent(projectId)}:${encodeURIComponent(scopeId)}`;
}

function isEditorialTranscriptPinSet(value: unknown): value is EditorialTranscriptPinSet {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const pin = value as Partial<EditorialTranscriptPinSet>;
    if (Object.keys(value).length !== PIN_SET_KEYS.size
        || Object.keys(value).some(key => !PIN_SET_KEYS.has(key))
        || (pin.kind !== 'session'
            && pin.kind !== 'pending'
            && pin.kind !== 'durable'
            && pin.kind !== 'history'
            && pin.kind !== 'redo'
            && pin.kind !== 'wal')
        || typeof pin.projectId !== 'string' || !pin.projectId
        || typeof pin.scopeId !== 'string' || !pin.scopeId
        || pin.id !== pinSetId(pin.kind, pin.projectId, pin.scopeId)
        || !Array.isArray(pin.recordIds)
        || pin.recordIds.some(recordId => !isSha256Digest(recordId))
        || new Set(pin.recordIds).size !== pin.recordIds.length
        || !Number.isFinite(pin.updatedAt) || (pin.updatedAt as number) < 0) {
        return false;
    }
    if (pin.kind === 'session') return pin.generation === null;
    if (!Number.isSafeInteger(pin.generation) || (pin.generation as number) < 0) return false;
    return pin.kind === 'pending'
        ? pin.scopeId === String(pin.generation)
        : pin.scopeId === 'current';
}

function uniqueRecordIds(recordIds: readonly Sha256Digest[]): Sha256Digest[] {
    const unique = Array.from(new Set(recordIds));
    if (unique.some(recordId => !isSha256Digest(recordId))) {
        throw new Error('Editorial pin contains an invalid record ID.');
    }
    return unique.sort();
}

function assertGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new Error('Editorial persistence generation must be a non-negative safe integer.');
    }
}

function isStoredRequestIndex(
    value: StoredEditorialRequestIndex,
    expectedRequestKey: Sha256Digest,
): boolean {
    return typeof value === 'object'
        && value !== null
        && Object.keys(value).length === REQUEST_INDEX_KEYS.size
        && Object.keys(value).every(key => REQUEST_INDEX_KEYS.has(key))
        && value.requestKey === expectedRequestKey
        && value.descriptor?.requestKey === expectedRequestKey
        && isEditorialTranscriptDescriptor(value.descriptor)
        && Number.isFinite(value.updatedAt)
        && value.updatedAt >= 0;
}

function isStoredEditorialTranscriptRecord(
    value: unknown,
    expectedRecordId: Sha256Digest,
): value is StoredEditorialTranscriptRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Partial<StoredEditorialTranscriptRecord>;
    return Object.keys(value).length === STORED_RECORD_KEYS.size
        && Object.keys(value).every(key => STORED_RECORD_KEYS.has(key))
        && record.recordId === expectedRecordId
        && isSha256Digest(record.recordId)
        && typeof record.canonicalJson === 'string'
        && Number.isSafeInteger(record.byteLength)
        && (record.byteLength as number) >= 0
        && Number.isFinite(record.lastAccess)
        && (record.lastAccess as number) >= 0;
}

function isEditorialTranscriptDescriptor(
    value: unknown,
): value is EditorialTranscriptDescriptorV1 {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const descriptor = value as Partial<EditorialTranscriptDescriptorV1>;
    return Object.keys(value).every(key => DESCRIPTOR_KEYS.has(key))
        && Object.keys(value).length === DESCRIPTOR_KEYS.size
        && descriptor.version === 1
        && isSha256Digest(descriptor.recordId)
        && isSha256Digest(descriptor.requestKey)
        && descriptor.sourceKind === 'video-source-audio'
        && typeof descriptor.sourceId === 'string'
        && descriptor.sourceId.trim().length > 0
        && typeof descriptor.sourceFingerprint === 'string'
        && descriptor.sourceFingerprint.trim().length > 0
        && descriptor.pcmAlgorithmVersion === 1
        && descriptor.recordBodyVersion === 1
        && descriptor.canonicalJsonVersion === 1
        && descriptor.responseSchema === 'edit-max-v1'
        && descriptor.requestedModel === 'qwen-1.7b-edit-max'
        && typeof descriptor.canonicalModel === 'string'
        && descriptor.canonicalModel.trim().length > 0
        && descriptor.sampleRateHz === 16_000
        && Number.isSafeInteger(descriptor.sampleCount)
        && (descriptor.sampleCount as number) >= 0
        && (descriptor.language === null
            || (typeof descriptor.language === 'string' && descriptor.language.trim().length > 0))
        && (descriptor.speakerMode === 'none' || descriptor.speakerMode === 'diarized')
        && isSha256Digest(descriptor.endpointIdentityDigest)
        && (descriptor.acquisition === 'provider' || descriptor.acquisition === 'local-no-audio')
        && typeof descriptor.createdAt === 'string'
        && descriptor.createdAt.length > 0
        && !Number.isNaN(Date.parse(descriptor.createdAt));
}

async function assertEditorialRequestKeyMatchesDescriptor(
    descriptor: EditorialTranscriptDescriptorV1,
): Promise<void> {
    const expected = await createEditorialTranscriptRequestKey({
        sourceFingerprint: descriptor.sourceFingerprint,
        sampleCount: descriptor.sampleCount,
        language: descriptor.language,
        speakerMode: descriptor.speakerMode,
        endpointIdentityDigest: descriptor.endpointIdentityDigest,
    });
    if (expected !== descriptor.requestKey) {
        throw new Error('Editorial request descriptor provenance does not match its request key.');
    }
}

function createAbortError(): DOMException {
    return new DOMException('Editorial transcription request was cancelled.', 'AbortError');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

function deepFreeze<Value>(value: Value): Value {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
    for (const nested of Object.values(value)) deepFreeze(nested);
    return Object.freeze(value);
}
