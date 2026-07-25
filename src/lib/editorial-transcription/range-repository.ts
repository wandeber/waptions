import type { Sha256Digest, TranscriptionCoverageRecordV2 } from '@/types/editorial';
import { sha256CanonicalJson } from './canonical-json';
import {
    verifyTranscriptionCoverageRecordV2,
} from './range-coverage';
import type {
    RangeTranscriptChunkRecordV2,
    RangeTranscriptionRepository,
} from './range-orchestrator';

const DATABASE_NAME = 'waptions-range-transcription-v2';
const DATABASE_VERSION = 1;
const CHUNK_STORE = 'chunks';
const COVERAGE_STORE = 'coverage';
const MAX_COMPATIBLE_RECORDS = 10_000;
const CHUNK_KEYS = new Set([
    'version',
    'recordId',
    'sourceFingerprint',
    'acquisitionProfileDigest',
    'windowId',
    'decoded',
    'words',
]);
const CHUNK_WORD_KEYS = new Set([
    'text',
    'startSample',
    'endSample',
    'probability',
    'speaker',
]);
const CHUNK_SPEAKER_KEYS = new Set(['providerSpeakerId', 'evidenceKey']);

export interface RangeTranscriptionRepositoryDriver {
    getChunk(recordId: Sha256Digest): Promise<unknown | null>;
    putChunkIfAbsent(record: RangeTranscriptChunkRecordV2): Promise<unknown | null>;
    getCoverage(recordId: Sha256Digest): Promise<unknown | null>;
    putCoverageIfAbsent(record: TranscriptionCoverageRecordV2): Promise<unknown | null>;
    listCoverage(): Promise<unknown[]>;
    compareAndSwapCoverage(input: {
        sourceFingerprint: string;
        acquisitionProfileDigest: Sha256Digest;
        expectedRecordIds: readonly Sha256Digest[];
        record: TranscriptionCoverageRecordV2;
    }): Promise<{
        swapped: boolean;
        existingRecord: unknown | null;
    }>;
}

export class IndexedRangeTranscriptionRepository implements RangeTranscriptionRepository {
    constructor(private readonly driver: RangeTranscriptionRepositoryDriver = (
        new IndexedDbRangeTranscriptionRepositoryDriver()
    )) {}

    async listCompatibleCoverage(input: {
        sourceFingerprint: string;
        acquisitionProfileDigest: Sha256Digest;
    }): Promise<readonly TranscriptionCoverageRecordV2[]> {
        const values = await this.driver.listCoverage();
        if (values.length > MAX_COMPATIBLE_RECORDS) {
            throw new Error('Range transcription coverage index exceeds its safe record limit.');
        }
        const records: TranscriptionCoverageRecordV2[] = [];
        for (const value of values) {
            if (!isCoverageCandidate(value)) continue;
            await verifyTranscriptionCoverageRecordV2(value);
            if (value.sourceFingerprint === input.sourceFingerprint
                && value.acquisitionProfileDigest === input.acquisitionProfileDigest) {
                records.push(structuredClone(value));
            }
        }
        return records.sort((left, right) => left.recordId.localeCompare(right.recordId));
    }

    async getCoverage(recordId: Sha256Digest): Promise<TranscriptionCoverageRecordV2 | null> {
        const value = await this.driver.getCoverage(recordId);
        if (value === null) return null;
        if (!isCoverageCandidate(value) || value.recordId !== recordId) {
            throw new Error('Range transcription coverage storage is corrupt.');
        }
        await verifyTranscriptionCoverageRecordV2(value);
        return structuredClone(value);
    }

    async getChunk(recordId: Sha256Digest): Promise<RangeTranscriptChunkRecordV2 | null> {
        const value = await this.driver.getChunk(recordId);
        if (value === null) return null;
        await verifyChunkRecord(value, recordId);
        return structuredClone(value as RangeTranscriptChunkRecordV2);
    }

    async putChunk(record: RangeTranscriptChunkRecordV2): Promise<void> {
        await verifyChunkRecord(record, record.recordId);
        const existing = await this.driver.putChunkIfAbsent(structuredClone(record));
        if (existing !== null && JSON.stringify(existing) !== JSON.stringify(record)) {
            throw new Error('Range transcription chunk conflicts with immutable CAS bytes.');
        }
    }

    async putCoverage(record: TranscriptionCoverageRecordV2): Promise<void> {
        await verifyTranscriptionCoverageRecordV2(record);
        const existing = await this.driver.putCoverageIfAbsent(structuredClone(record));
        if (existing !== null && JSON.stringify(existing) !== JSON.stringify(record)) {
            throw new Error('Range transcription coverage conflicts with immutable CAS bytes.');
        }
    }

    async compareAndSwapCoverage(input: {
        sourceFingerprint: string;
        acquisitionProfileDigest: Sha256Digest;
        expectedRecordIds: readonly Sha256Digest[];
        record: TranscriptionCoverageRecordV2;
    }): Promise<boolean> {
        await verifyTranscriptionCoverageRecordV2(input.record);
        if (input.record.sourceFingerprint !== input.sourceFingerprint
            || input.record.acquisitionProfileDigest !== input.acquisitionProfileDigest) {
            throw new Error('Range transcription coverage CAS family does not match the record.');
        }
        const expectedRecordIds = normalizeRecordIds(input.expectedRecordIds);
        const result = await this.driver.compareAndSwapCoverage({
            ...input,
            expectedRecordIds,
            record: structuredClone(input.record),
        });
        if (result.existingRecord !== null
            && JSON.stringify(result.existingRecord) !== JSON.stringify(input.record)) {
            throw new Error('Range transcription coverage conflicts with immutable CAS bytes.');
        }
        return result.swapped;
    }
}

async function verifyChunkRecord(
    value: unknown,
    expectedRecordId: Sha256Digest,
): Promise<void> {
    if (!isRecord(value)) throw new Error('Range transcription chunk storage is corrupt.');
    const record = value as unknown as RangeTranscriptChunkRecordV2;
    if (Object.keys(record).length !== CHUNK_KEYS.size
        || Object.keys(record).some(key => !CHUNK_KEYS.has(key))) {
        throw new Error('Range transcription chunk storage contains unsupported fields.');
    }
    const { recordId, ...body } = record;
    if (record.version !== 2
        || recordId !== expectedRecordId
        || !isDigest(recordId)
        || !isDigest(record.acquisitionProfileDigest)
        || !isDigest(record.windowId)
        || !record.sourceFingerprint?.trim()
        || !isRange(record.decoded)
        || !Array.isArray(record.words)) {
        throw new Error('Range transcription chunk storage is corrupt.');
    }
    let previousEnd = record.decoded.startSample;
    record.words.forEach((word) => {
        if (!isRecord(word)
            || Object.keys(word).length !== CHUNK_WORD_KEYS.size
            || Object.keys(word).some(key => !CHUNK_WORD_KEYS.has(key))
            || typeof word.text !== 'string'
            || !word.text.trim()
            || !Number.isSafeInteger(word.startSample)
            || !Number.isSafeInteger(word.endSample)
            || word.startSample < previousEnd
            || word.endSample <= word.startSample
            || word.endSample > record.decoded.endSample
            || (word.probability !== null && (
                typeof word.probability !== 'number'
                || !Number.isFinite(word.probability)
                || word.probability < 0
                || word.probability > 1
            ))
            || (word.speaker !== null && (
                !isRecord(word.speaker)
                || Object.keys(word.speaker).length !== CHUNK_SPEAKER_KEYS.size
                || Object.keys(word.speaker).some(key => !CHUNK_SPEAKER_KEYS.has(key))
                || typeof word.speaker.providerSpeakerId !== 'string'
                || !word.speaker.providerSpeakerId.trim()
                || typeof word.speaker.evidenceKey !== 'string'
                || !word.speaker.evidenceKey.trim()
            ))) {
            throw new Error('Range transcription chunk word evidence is corrupt.');
        }
        previousEnd = word.endSample;
    });
    if (await sha256CanonicalJson(body) !== recordId) {
        throw new Error('Range transcription chunk hash does not match its canonical body.');
    }
}

function isCoverageCandidate(value: unknown): value is TranscriptionCoverageRecordV2 {
    return isRecord(value)
        && value.version === 2
        && isDigest(value.recordId);
}

function isRange(value: unknown): boolean {
    return isRecord(value)
        && Object.keys(value).length === 2
        && Object.keys(value).every(key => key === 'startSample' || key === 'endSample')
        && Number.isSafeInteger(value.startSample)
        && Number.isSafeInteger(value.endSample)
        && (value.startSample as number) >= 0
        && (value.endSample as number) > (value.startSample as number);
}

function isDigest(value: unknown): value is Sha256Digest {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class IndexedDbRangeTranscriptionRepositoryDriver implements RangeTranscriptionRepositoryDriver {
    private databasePromise: Promise<IDBDatabase> | null = null;

    getChunk(recordId: Sha256Digest): Promise<unknown | null> {
        return this.read(CHUNK_STORE, recordId);
    }

    getCoverage(recordId: Sha256Digest): Promise<unknown | null> {
        return this.read(COVERAGE_STORE, recordId);
    }

    putChunkIfAbsent(record: RangeTranscriptChunkRecordV2): Promise<unknown | null> {
        return this.putIfAbsent(CHUNK_STORE, record.recordId, record);
    }

    putCoverageIfAbsent(record: TranscriptionCoverageRecordV2): Promise<unknown | null> {
        return this.putIfAbsent(COVERAGE_STORE, record.recordId, record);
    }

    async listCoverage(): Promise<unknown[]> {
        const database = await this.open();
        return requestResult(database.transaction(COVERAGE_STORE, 'readonly')
            .objectStore(COVERAGE_STORE).getAll());
    }

    async compareAndSwapCoverage(input: {
        sourceFingerprint: string;
        acquisitionProfileDigest: Sha256Digest;
        expectedRecordIds: readonly Sha256Digest[];
        record: TranscriptionCoverageRecordV2;
    }): Promise<{ swapped: boolean; existingRecord: unknown | null }> {
        const database = await this.open();
        const transaction = database.transaction(COVERAGE_STORE, 'readwrite');
        const store = transaction.objectStore(COVERAGE_STORE);
        const values = await requestResult(store.getAll());
        const currentRecordIds = values
            .filter(value => isRecord(value)
                && value.sourceFingerprint === input.sourceFingerprint
                && value.acquisitionProfileDigest === input.acquisitionProfileDigest
                && isDigest(value.recordId))
            .map(value => value.recordId as Sha256Digest)
            .sort();
        if (!equalRecordIds(currentRecordIds, input.expectedRecordIds)) {
            await transactionDone(transaction);
            return { swapped: false, existingRecord: null };
        }
        const existingRecord = values.find(value => (
            isRecord(value) && value.recordId === input.record.recordId
        )) ?? null;
        if (existingRecord === null) store.add(input.record);
        await transactionDone(transaction);
        return { swapped: true, existingRecord };
    }

    private async read(storeName: string, key: IDBValidKey): Promise<unknown | null> {
        const database = await this.open();
        const result = await requestResult(
            database.transaction(storeName, 'readonly').objectStore(storeName).get(key),
        );
        return result ?? null;
    }

    private async putIfAbsent(
        storeName: string,
        key: IDBValidKey,
        value: unknown,
    ): Promise<unknown | null> {
        const database = await this.open();
        const transaction = database.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        const existing = await requestResult(store.get(key));
        if (existing === undefined) store.add(value);
        await transactionDone(transaction);
        return existing ?? null;
    }

    private open(): Promise<IDBDatabase> {
        this.databasePromise ??= new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                reject(new Error('Range transcription storage requires IndexedDB.'));
                return;
            }
            const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(CHUNK_STORE)) {
                    database.createObjectStore(CHUNK_STORE, { keyPath: 'recordId' });
                }
                if (!database.objectStoreNames.contains(COVERAGE_STORE)) {
                    database.createObjectStore(COVERAGE_STORE, { keyPath: 'recordId' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('Could not open range transcription storage.'));
        });
        return this.databasePromise;
    }
}

function normalizeRecordIds(recordIds: readonly Sha256Digest[]): Sha256Digest[] {
    const normalized = [...recordIds].sort();
    normalized.forEach((recordId, index) => {
        if (!isDigest(recordId) || (index > 0 && normalized[index - 1] === recordId)) {
            throw new Error('Range transcription coverage CAS contains invalid record identities.');
        }
    });
    return normalized;
}

function equalRecordIds(
    left: readonly Sha256Digest[],
    right: readonly Sha256Digest[],
): boolean {
    return left.length === right.length
        && left.every((recordId, index) => recordId === right[index]);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Range transcription storage request failed.'));
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Range transcription transaction failed.'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Range transcription transaction aborted.'));
    });
}
