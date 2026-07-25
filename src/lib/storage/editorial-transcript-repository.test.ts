import { describe, expect, it, vi } from 'vitest';
import {
    createEditorialTranscriptDescriptor,
    createEditorialTranscriptRequestKey,
} from '@/lib/editorial-transcription/identity';
import { createLocalNoAudioTranscriptRecord } from '@/lib/editorial-transcription/transcript-body';
import type { EditorialTranscriptDescriptorV1, Sha256Digest } from '@/types/editorial';
import {
    EditorialTranscriptCorruptionError,
    IndexedDbEditorialTranscriptRepositoryDriver,
    EditorialTranscriptInFlightRegistry,
    EditorialTranscriptRepository,
    type EditorialTranscriptPinSet,
    type EditorialTranscriptRepositoryDriver,
    type PublishEditorialProjectPinsInput,
    type StoredEditorialRequestIndex,
    type StoredEditorialTranscriptRecord,
} from './editorial-transcript-repository';

const requestKey = 'sha256:1111111111111111111111111111111111111111111111111111111111111111' as const;
const endpointDigest = 'sha256:2222222222222222222222222222222222222222222222222222222222222222' as const;

class MemoryDriver implements EditorialTranscriptRepositoryDriver {
    readonly records = new Map<Sha256Digest, StoredEditorialTranscriptRecord>();
    readonly requests = new Map<Sha256Digest, StoredEditorialRequestIndex>();
    readonly pins = new Map<string, EditorialTranscriptPinSet>();
    failRecordWrites = false;

    async readRecord(recordId: Sha256Digest) {
        return this.records.get(recordId) ?? null;
    }

    async writeRecordIfAbsent(record: StoredEditorialTranscriptRecord) {
        if (this.failRecordWrites) throw new DOMException('Synthetic quota.', 'QuotaExceededError');
        const existing = this.records.get(record.recordId) ?? null;
        if (!existing) this.records.set(record.recordId, { ...record });
        return existing;
    }

    async touchRecord(recordId: Sha256Digest, lastAccess: number) {
        const record = this.records.get(recordId);
        if (record) this.records.set(recordId, { ...record, lastAccess });
    }

    async readRequest(key: Sha256Digest) {
        return this.requests.get(key) ?? null;
    }

    async compareAndSwapRequest(
        key: Sha256Digest,
        expectedRecordId: Sha256Digest | null,
        next: StoredEditorialRequestIndex,
    ) {
        const current = this.requests.get(key);
        if ((current?.descriptor.recordId ?? null) !== expectedRecordId) return false;
        this.requests.set(key, next);
        return true;
    }

    async replacePinSet(pinSet: EditorialTranscriptPinSet) {
        if (pinSet.recordIds.some(recordId => !this.records.has(recordId))) {
            throw new EditorialTranscriptCorruptionError();
        }
        this.pins.set(pinSet.id, { ...pinSet, recordIds: [...pinSet.recordIds] });
    }

    async removePinSet(pinId: string) {
        this.pins.delete(pinId);
    }

    async publishProjectPins(input: PublishEditorialProjectPinsInput) {
        const allRecordIds = [
            ...input.durableRecordIds,
            ...input.historyRecordIds,
            ...input.redoRecordIds,
            ...input.walRecordIds,
        ];
        if (allRecordIds.some(recordId => !this.records.has(recordId))) {
            throw new EditorialTranscriptCorruptionError();
        }
        for (const [kind, recordIds] of [
            ['durable', input.durableRecordIds],
            ['history', input.historyRecordIds],
            ['redo', input.redoRecordIds],
            ['wal', input.walRecordIds],
        ] as const) {
            const id = `${kind}:${encodeURIComponent(input.projectId)}:current`;
            this.pins.set(id, {
                id,
                kind,
                projectId: input.projectId,
                scopeId: 'current',
                generation: input.generation,
                recordIds: Array.from(new Set(recordIds)).sort(),
                updatedAt: input.updatedAt,
            });
        }
        this.pins.delete(`pending:${encodeURIComponent(input.projectId)}:${input.generation}`);
    }

    async listRecords() {
        return Array.from(this.records.values());
    }

    async listRequests() {
        return Array.from(this.requests.values());
    }

    async listPinSets() {
        return Array.from(this.pins.values());
    }

    async removeRecordsAndRequests(
        recordIds: readonly Sha256Digest[],
        requestKeys: readonly Sha256Digest[],
    ) {
        recordIds.forEach(recordId => this.records.delete(recordId));
        requestKeys.forEach(key => this.requests.delete(key));
    }

    async removeUnpinnedRecordsAndRequests(
        recordIds: readonly Sha256Digest[],
        requestKeys: readonly Sha256Digest[],
    ) {
        const pinned = new Set(Array.from(this.pins.values()).flatMap(pin => pin.recordIds));
        const removed = recordIds.filter(recordId => !pinned.has(recordId));
        const removedSet = new Set(removed);
        removed.forEach(recordId => this.records.delete(recordId));
        requestKeys.forEach((key) => {
            const request = this.requests.get(key);
            if (request && removedSet.has(request.descriptor.recordId)) this.requests.delete(key);
        });
        return removed;
    }
}

function createEditorialDatabase(
    values: Record<string, Map<IDBValidKey, unknown>>,
): IDBDatabase {
    return {
        close: () => undefined,
        transaction: (storeNames: string | string[]) => {
            const names = Array.isArray(storeNames) ? storeNames : [storeNames];
            const staged = new Map(names.map(name => [name, new Map(values[name])]));
            let pending = 0;
            let completionQueued = false;
            let aborted = false;
            const transaction = {
                error: null,
                oncomplete: null,
                onerror: null,
                onabort: null,
                abort: () => {
                    if (aborted) return;
                    aborted = true;
                    queueMicrotask(() => transaction.onabort?.(new Event('abort')));
                },
                objectStore: (name: string) => {
                    const store = staged.get(name);
                    if (!store) throw new DOMException(`Unknown store ${name}.`, 'NotFoundError');
                    const keyFor = (value: Record<string, unknown>): IDBValidKey => {
                        const key = name === 'records'
                            ? value.recordId
                            : name === 'request-index'
                                ? value.requestKey
                                : value.id;
                        if (typeof key !== 'string') throw new Error('Missing fake IndexedDB key.');
                        return key;
                    };
                    return {
                        get: (key: IDBValidKey) => request(() => store.get(key)),
                        getAll: () => request(() => Array.from(store.values())),
                        put: (value: Record<string, unknown>) => request(() => {
                            const key = keyFor(value);
                            store.set(key, value);
                            return key;
                        }),
                        delete: (key: IDBValidKey) => request(() => {
                            store.delete(key);
                            return undefined;
                        }),
                    };
                },
            } as unknown as IDBTransaction;

            const queueCompletion = () => {
                if (completionQueued || pending !== 0 || aborted) return;
                completionQueued = true;
                queueMicrotask(() => {
                    completionQueued = false;
                    if (pending !== 0 || aborted) return;
                    staged.forEach((store, name) => {
                        values[name] = new Map(store);
                    });
                    transaction.oncomplete?.(new Event('complete'));
                });
            };
            const request = <Result>(operation: () => Result): IDBRequest<Result> => {
                pending += 1;
                const result = {
                    result: undefined,
                    error: null,
                    onsuccess: null,
                    onerror: null,
                } as unknown as IDBRequest<Result>;
                queueMicrotask(() => {
                    if (aborted) return;
                    try {
                        Object.defineProperty(result, 'result', { value: operation() });
                        result.onsuccess?.(new Event('success'));
                    } catch (error) {
                        Object.defineProperty(result, 'error', { value: error });
                        result.onerror?.(new Event('error'));
                    } finally {
                        pending -= 1;
                        queueCompletion();
                    }
                });
                return result;
            };
            return transaction;
        },
    } as unknown as IDBDatabase;
}

async function fixture(now = 1) {
    const record = await createLocalNoAudioTranscriptRecord({
        sourceFingerprint: `fingerprint-${now}`,
        sampleCount: 16_000,
        language: null,
        speakerMode: 'none',
    });
    const descriptorRequestKey = await createEditorialTranscriptRequestKey({
        sourceFingerprint: record.body.sourceFingerprint,
        sampleCount: record.body.sampleCount,
        language: record.body.language,
        speakerMode: record.body.speakerMode,
        endpointIdentityDigest: endpointDigest,
    });
    const descriptor = createEditorialTranscriptDescriptor({
        recordId: record.recordId,
        requestKey: descriptorRequestKey,
        sourceId: `source-${now}`,
        sourceFingerprint: record.body.sourceFingerprint,
        endpointIdentityDigest: endpointDigest,
        body: record.body,
        acquisition: 'local-no-audio',
        createdAt: '2026-07-22T00:00:00.000Z',
    });
    return { record, descriptor, requestKey: descriptorRequestKey };
}

describe('immutable editorial transcript CAS and request index', () => {
    it('deduplicates equal canonical bytes and rejects an unequal immutable collision', async () => {
        const driver = new MemoryDriver();
        const repository = new EditorialTranscriptRepository({ driver, now: () => 10 });
        const { record } = await fixture();
        await repository.putRecord(record);
        await expect(repository.putRecord(record)).resolves.toBeUndefined();

        driver.records.set(record.recordId, {
            ...driver.records.get(record.recordId)!,
            canonicalJson: '{}',
            byteLength: 2,
        });
        await expect(repository.putRecord(record)).rejects.toBeInstanceOf(
            EditorialTranscriptCorruptionError,
        );
    });

    it('rejects a forged body/bytes wrapper before immutable storage', async () => {
        const driver = new MemoryDriver();
        const repository = new EditorialTranscriptRepository({ driver });
        const { record } = await fixture();
        await expect(repository.putRecord({
            ...record,
            canonicalJson: '{}',
            canonicalBytes: new TextEncoder().encode('{}'),
        })).rejects.toBeInstanceOf(EditorialTranscriptCorruptionError);
        expect(driver.records.size).toBe(0);
    });

    it('keeps requestKey CAS separate from the content-derived recordId', async () => {
        const driver = new MemoryDriver();
        const repository = new EditorialTranscriptRepository({ driver, now: () => 10 });
        const { record, descriptor, requestKey: descriptorRequestKey } = await fixture();
        await repository.putRecord(record);
        expect(descriptor.requestKey).not.toBe(descriptor.recordId);
        await expect(repository.compareAndSwapRequestIndex({
            requestKey: descriptorRequestKey,
            expectedRecordId: null,
            descriptor,
        })).resolves.toBe(true);
        await expect(repository.compareAndSwapRequestIndex({
            requestKey: descriptorRequestKey,
            expectedRecordId: null,
            descriptor,
        })).resolves.toBe(false);
        await expect(repository.getRequestDescriptor(descriptorRequestKey)).resolves.toEqual(descriptor);
        const hydrated = await repository.getRecord(record.recordId, { referenced: true });
        expect(Object.isFrozen(hydrated)).toBe(true);
        expect(Object.isFrozen(hydrated?.words)).toBe(true);
    });

    it('drops secret-bearing or provenance-mismatched request-index descriptors', async () => {
        const driver = new MemoryDriver();
        const repository = new EditorialTranscriptRepository({ driver, now: () => 10 });
        const { record, descriptor, requestKey: descriptorRequestKey } = await fixture();
        await repository.putRecord(record);
        driver.requests.set(descriptorRequestKey, {
            requestKey: descriptorRequestKey,
            descriptor: { ...descriptor, apiKey: 'sentinel-secret' } as EditorialTranscriptDescriptorV1,
            updatedAt: 10,
        });
        await expect(repository.getRequestDescriptor(descriptorRequestKey)).resolves.toBeNull();
        expect(driver.requests.has(descriptorRequestKey)).toBe(false);

        const mismatched = { ...descriptor, requestKey };
        await expect(repository.compareAndSwapRequestIndex({
            requestKey,
            expectedRecordId: null,
            descriptor: mismatched,
        })).rejects.toThrow('provenance');
        expect(driver.requests.has(requestKey)).toBe(false);
    });

    it('removes only an unpinned corrupt cache candidate and fails referenced corruption closed', async () => {
        const driver = new MemoryDriver();
        const repository = new EditorialTranscriptRepository({ driver, now: () => 10 });
        const { record } = await fixture();
        await repository.putRecord(record);
        driver.records.get(record.recordId)!.canonicalJson = '{"corrupt":true}';
        await expect(repository.getRecord(record.recordId)).resolves.toBeNull();
        expect(driver.records.has(record.recordId)).toBe(false);

        await repository.putRecord(record);
        await repository.setSessionPins('project', 'session', [record.recordId]);
        driver.records.get(record.recordId)!.canonicalJson = '{"corrupt":true}';
        await expect(repository.getRecord(record.recordId)).rejects.toBeInstanceOf(
            EditorialTranscriptCorruptionError,
        );
        expect(driver.records.has(record.recordId)).toBe(true);
    });

    it('propagates quota failure before any request index or pin can reference a record', async () => {
        const driver = new MemoryDriver();
        driver.failRecordWrites = true;
        const repository = new EditorialTranscriptRepository({ driver });
        const { record } = await fixture();
        await expect(repository.putRecord(record)).rejects.toMatchObject({ name: 'QuotaExceededError' });
        expect(driver.records.size).toBe(0);
        expect(driver.requests.size).toBe(0);
        expect(driver.pins.size).toBe(0);
    });
});

describe('IndexedDB editorial transcript driver transactions', () => {
    it('atomically guards pin creation and unpinned deletion against missing/pinned records', async () => {
        const values = {
            records: new Map<IDBValidKey, unknown>(),
            'request-index': new Map<IDBValidKey, unknown>(),
            pins: new Map<IDBValidKey, unknown>(),
        };
        const driver = new IndexedDbEditorialTranscriptRepositoryDriver(
            async () => createEditorialDatabase(values),
        );
        const repository = new EditorialTranscriptRepository({ driver, now: () => 1 });
        const { record, descriptor, requestKey: descriptorRequestKey } = await fixture();
        await repository.putRecord(record);
        await repository.setSessionPins('project', 'session', [record.recordId]);
        await expect(driver.removeUnpinnedRecordsAndRequests([record.recordId], []))
            .resolves.toEqual([]);
        expect(values.records.has(record.recordId)).toBe(true);

        await repository.clearSessionPins('project', 'session');
        await expect(driver.removeUnpinnedRecordsAndRequests([record.recordId], []))
            .resolves.toEqual([record.recordId]);
        expect(values.records.has(record.recordId)).toBe(false);

        await expect(driver.replacePinSet({
            id: 'session:project:missing',
            kind: 'session',
            projectId: 'project',
            scopeId: 'missing',
            generation: null,
            recordIds: [record.recordId],
            updatedAt: 1,
        })).rejects.toBeInstanceOf(EditorialTranscriptCorruptionError);
        expect(values.pins.size).toBe(0);

        await expect(driver.compareAndSwapRequest(descriptorRequestKey, null, {
            requestKey: descriptorRequestKey,
            descriptor,
            updatedAt: 2,
        })).rejects.toBeInstanceOf(EditorialTranscriptCorruptionError);
        expect(values['request-index'].size).toBe(0);

        await repository.putRecord(record);
        values.pins.set('corrupt-pin', { id: 'corrupt-pin', recordIds: 'not-an-array' });
        await expect(driver.removeUnpinnedRecordsAndRequests([record.recordId], []))
            .rejects.toBeInstanceOf(EditorialTranscriptCorruptionError);
        expect(values.records.has(record.recordId)).toBe(true);
    });
});

describe('editorial transcript pin choreography and GC', () => {
    it('publishes durable/history/redo/WAL pins before clearing matching pending generation', async () => {
        const driver = new MemoryDriver();
        const repository = new EditorialTranscriptRepository({ driver, now: () => 20 });
        const { record } = await fixture();
        await repository.putRecord(record);
        await repository.setPendingGenerationPins('project', 7, [record.recordId]);
        expect(Array.from(driver.pins.values()).some(pin => pin.kind === 'pending')).toBe(true);
        await repository.publishDurableProjectPins({
            projectId: 'project',
            generation: 7,
            durableRecordIds: [record.recordId],
            historyRecordIds: [record.recordId],
            redoRecordIds: [],
            walRecordIds: [record.recordId],
        });
        expect(Array.from(driver.pins.values()).some(pin => pin.kind === 'pending')).toBe(false);
        expect(new Set(Array.from(driver.pins.values()).map(pin => pin.kind))).toEqual(
            new Set(['durable', 'history', 'redo', 'wal']),
        );
    });

    it('rebuilds authoritative pins and removes stale pending only with a complete snapshot', async () => {
        const driver = new MemoryDriver();
        let now = 1;
        const repository = new EditorialTranscriptRepository({ driver, now: () => now });
        const { record } = await fixture();
        await repository.putRecord(record);
        await repository.setPendingGenerationPins('project', 6, [record.recordId]);
        now = 100;
        await expect(repository.reconcileProjectPins({
            projects: [{
                projectId: 'project',
                generation: 7,
                durableRecordIds: [record.recordId],
                historyRecordIds: [],
                redoRecordIds: [],
                walRecordIds: [],
            }],
            completeProjectSnapshot: true,
            stalePendingBefore: 50,
        })).resolves.toEqual({ rebuiltProjects: 1, removedPendingPins: 1 });
    });

    it('evicts only unpinned LRU records in bounded resumable batches', async () => {
        const driver = new MemoryDriver();
        let now = 1;
        const repository = new EditorialTranscriptRepository({ driver, now: () => now++ });
        const fixtures = await Promise.all([fixture(1), fixture(2), fixture(3)]);
        for (const item of fixtures) await repository.putRecord(item.record);
        await repository.setSessionPins('project', 'session', [fixtures[0].record.recordId]);
        const result = await repository.collectGarbage({ maxRecordCount: 1, batchSize: 1 });
        expect(result.removedRecordIds).toEqual([fixtures[1].record.recordId]);
        expect(result.hasMore).toBe(true);
        expect(driver.records.has(fixtures[0].record.recordId)).toBe(true);
    });

    it('fails GC closed when pin metadata is corrupt', async () => {
        const driver = new MemoryDriver();
        const repository = new EditorialTranscriptRepository({ driver });
        const { record } = await fixture();
        await repository.putRecord(record);
        driver.pins.set('corrupt-pin', {
            id: 'corrupt-pin',
            kind: 'session',
            projectId: 'project',
            scopeId: 'session',
            generation: null,
            recordIds: [record.recordId],
            updatedAt: 1,
            unexpected: true,
        } as EditorialTranscriptPinSet);

        await expect(repository.collectGarbage({ maxRecordCount: 0, batchSize: 1 }))
            .rejects.toBeInstanceOf(EditorialTranscriptCorruptionError);
        expect(driver.records.has(record.recordId)).toBe(true);
    });
});

describe('reference-counted editorial in-flight jobs', () => {
    it('coalesces by requestKey and aborts only after the final consumer cancels', async () => {
        const registry = new EditorialTranscriptInFlightRegistry<string>();
        const firstController = new AbortController();
        const secondController = new AbortController();
        let resolveJob!: (value: string) => void;
        let sharedSignal: AbortSignal | undefined;
        const run = vi.fn((signal: AbortSignal) => {
            sharedSignal = signal;
            return new Promise<string>(resolve => {
                resolveJob = resolve;
            });
        });
        const first = registry.subscribe({ requestKey, signal: firstController.signal, run });
        const second = registry.subscribe({ requestKey, signal: secondController.signal, run });
        await Promise.resolve();
        expect(run).toHaveBeenCalledTimes(1);
        firstController.abort();
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        expect(sharedSignal?.aborted).toBe(false);
        resolveJob('record');
        await expect(second).resolves.toBe('record');

        const thirdController = new AbortController();
        const third = registry.subscribe({ requestKey, signal: thirdController.signal, run });
        thirdController.abort();
        await expect(third).rejects.toMatchObject({ name: 'AbortError' });
        expect(sharedSignal?.aborted).toBe(true);
    });
});
