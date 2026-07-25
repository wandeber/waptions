export const DEFAULT_EDITORIAL_PCM_MEMORY_CACHE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_EDITORIAL_PCM_PERSISTENT_CACHE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_EDITORIAL_PCM_MAX_WINDOW_SAMPLES = 16_000 * 30;

const DATABASE_NAME = 'waptions-derived-editorial-pcm';
const DATABASE_VERSION = 1;
const WINDOW_STORE = 'pcm-windows';
const METADATA_STORE = 'pcm-window-metadata';
const RECORD_VERSION = 1;

export interface EditorialPcmWindowIdentity {
    sourceFingerprint: string;
    pcmAlgorithmVersion: 1;
    startSample: number;
    endSample: number;
}

export interface StoredEditorialPcmWindow extends EditorialPcmWindowIdentity {
    key: string;
    recordVersion: 1;
    samples: Int16Array;
    bytes: number;
    lastAccess: number;
}

interface EditorialPcmWindowMetadata {
    key: string;
    bytes: number;
    lastAccess: number;
}

export interface EditorialPcmWindowCacheDriver {
    read(key: string, lastAccess: number): Promise<unknown | null>;
    write(record: StoredEditorialPcmWindow, maxBytes: number): Promise<void>;
    remove(key: string): Promise<void>;
}

export interface EditorialPcmWindowDecoder {
    decodeWindow(request: EditorialPcmWindowIdentity & {
        /** Native decoder/resampler support outside the retained half-open target. */
        filterPaddingSamples: number;
        signal?: AbortSignal;
    }): Promise<Int16Array>;
}

export function createEditorialPcmWindowKey(identity: EditorialPcmWindowIdentity): string {
    assertWindowIdentity(identity);
    return `editorial-pcm:${encodeURIComponent(identity.sourceFingerprint)}:v${identity.pcmAlgorithmVersion}:${identity.startSample}-${identity.endSample}`;
}

export function readStoredEditorialPcmWindow(
    value: unknown,
    expectedKey: string,
): StoredEditorialPcmWindow | null {
    if (!isRecord(value)) return null;
    if (value.key !== expectedKey || value.recordVersion !== RECORD_VERSION
        || typeof value.sourceFingerprint !== 'string' || !value.sourceFingerprint
        || value.pcmAlgorithmVersion !== 1
        || !Number.isSafeInteger(value.startSample) || (value.startSample as number) < 0
        || !Number.isSafeInteger(value.endSample) || (value.endSample as number) <= (value.startSample as number)
        || !(value.samples instanceof Int16Array)
        || value.samples.length !== (value.endSample as number) - (value.startSample as number)
        || value.bytes !== value.samples.byteLength
        || !Number.isFinite(value.lastAccess) || (value.lastAccess as number) < 0) {
        return null;
    }
    return value as unknown as StoredEditorialPcmWindow;
}

/**
 * Strict memory LRU plus optional best-effort derived IndexedDB storage.
 *
 * Returned arrays are copies so a waveform/refinement consumer cannot mutate another consumer's
 * cached PCM. Persistent failure disables only that optional tier; callers can always re-decode a
 * bounded window and project durability never depends on this repository.
 */
export class EditorialPcmWindowRepository {
    private readonly driver: EditorialPcmWindowCacheDriver;
    private readonly memoryMaxBytes: number;
    private readonly persistentMaxBytes: number;
    private readonly maxWindowSamples: number;
    private readonly now: () => number;
    private readonly memory = new Map<string, StoredEditorialPcmWindow>();
    private memoryBytes = 0;
    private persistentAvailable = true;

    constructor(options: {
        driver?: EditorialPcmWindowCacheDriver;
        memoryMaxBytes?: number;
        persistentMaxBytes?: number;
        maxWindowSamples?: number;
        now?: () => number;
    } = {}) {
        this.driver = options.driver ?? new IndexedDbEditorialPcmWindowCacheDriver();
        this.memoryMaxBytes = options.memoryMaxBytes ?? DEFAULT_EDITORIAL_PCM_MEMORY_CACHE_BYTES;
        this.persistentMaxBytes = options.persistentMaxBytes
            ?? DEFAULT_EDITORIAL_PCM_PERSISTENT_CACHE_BYTES;
        this.maxWindowSamples = options.maxWindowSamples ?? DEFAULT_EDITORIAL_PCM_MAX_WINDOW_SAMPLES;
        this.now = options.now ?? Date.now;
        for (const [name, value] of [
            ['memory cap', this.memoryMaxBytes],
            ['persistent cap', this.persistentMaxBytes],
            ['window cap', this.maxWindowSamples],
        ] as const) {
            if (!Number.isSafeInteger(value) || value < 0) {
                throw new Error(`Editorial PCM ${name} must be a non-negative safe integer.`);
            }
        }
    }

    async get(identity: EditorialPcmWindowIdentity): Promise<Int16Array | null> {
        const key = createEditorialPcmWindowKey(identity);
        const memoryRecord = this.memory.get(key);
        if (memoryRecord) {
            this.memory.delete(key);
            memoryRecord.lastAccess = this.now();
            this.memory.set(key, memoryRecord);
            return memoryRecord.samples.slice();
        }
        if (!this.persistentAvailable) return null;
        try {
            const value = await this.driver.read(key, this.now());
            if (value === null) return null;
            const record = readStoredEditorialPcmWindow(value, key);
            if (!record || !sameIdentity(record, identity) || record.samples.length > this.maxWindowSamples) {
                await this.driver.remove(key);
                return null;
            }
            this.insertMemory({ ...record, samples: record.samples.slice() });
            return record.samples.slice();
        } catch {
            this.persistentAvailable = false;
            return null;
        }
    }

    async put(identity: EditorialPcmWindowIdentity, samples: Int16Array): Promise<void> {
        const key = createEditorialPcmWindowKey(identity);
        if (samples.length !== identity.endSample - identity.startSample) {
            throw new Error('Editorial PCM window length does not match its half-open key.');
        }
        if (samples.length > this.maxWindowSamples) {
            throw new Error('Editorial PCM refinement window exceeds the configured bound.');
        }
        const record: StoredEditorialPcmWindow = {
            ...identity,
            key,
            recordVersion: 1,
            samples: samples.slice(),
            bytes: samples.byteLength,
            lastAccess: this.now(),
        };
        this.insertMemory(record);
        if (!this.persistentAvailable || record.bytes > this.persistentMaxBytes) return;
        try {
            await this.driver.write({ ...record, samples: record.samples.slice() }, this.persistentMaxBytes);
        } catch {
            this.persistentAvailable = false;
        }
    }

    async getOrDecode(
        identity: EditorialPcmWindowIdentity,
        decoder: EditorialPcmWindowDecoder,
        options: { signal?: AbortSignal; filterPaddingSamples?: number } = {},
    ): Promise<Int16Array> {
        const cached = await this.get(identity);
        if (cached) return cached;
        if (options.signal?.aborted) throw createAbortError();
        const filterPaddingSamples = options.filterPaddingSamples ?? 64;
        if (!Number.isSafeInteger(filterPaddingSamples) || filterPaddingSamples < 0
            || filterPaddingSamples > 4_096) {
            throw new Error('Editorial PCM filter padding is outside the safe bound.');
        }
        const samples = await decoder.decodeWindow({
            ...identity,
            filterPaddingSamples,
            signal: options.signal,
        });
        if (options.signal?.aborted) throw createAbortError();
        if (!(samples instanceof Int16Array)
            || samples.length !== identity.endSample - identity.startSample) {
            throw new Error('Editorial PCM decoder returned an invalid bounded window.');
        }
        await this.put(identity, samples);
        return samples.slice();
    }

    clearMemory(): void {
        this.memory.clear();
        this.memoryBytes = 0;
    }

    private insertMemory(record: StoredEditorialPcmWindow): void {
        const existing = this.memory.get(record.key);
        if (existing) {
            this.memoryBytes -= existing.bytes;
            this.memory.delete(record.key);
        }
        if (record.bytes > this.memoryMaxBytes) return;
        this.memory.set(record.key, record);
        this.memoryBytes += record.bytes;
        while (this.memoryBytes > this.memoryMaxBytes) {
            const oldest = this.memory.entries().next().value as [string, StoredEditorialPcmWindow] | undefined;
            if (!oldest) break;
            this.memory.delete(oldest[0]);
            this.memoryBytes -= oldest[1].bytes;
        }
    }
}

export interface QuietBoundarySearchInput {
    /** PCM samples for [windowStartSample, windowStartSample + samples.length). */
    samples: Int16Array;
    windowStartSample: number;
    originalSample: number;
    minimumSample: number;
    maximumSample: number;
}

/**
 * Selects the minimum 10 ms RMS valley, then the nearest zero crossing within 5 ms.
 *
 * Callers clamp minimum/maximum to neighboring word cores before decoding. The helper enforces a
 * hard ±120 ms bound around the original boundary as a second line of defense. Equal RMS values
 * prefer the candidate nearest the original sample, then the earlier sample; zero-crossing ties
 * use the same deterministic ordering.
 */
export function findQuietEditorialBoundary(input: QuietBoundarySearchInput): number {
    const tenMilliseconds = 160;
    const fiveMilliseconds = 80;
    const maximumSearch = 1_920;
    const windowEnd = input.windowStartSample + input.samples.length;
    if (!(input.samples instanceof Int16Array)
        || !Number.isSafeInteger(input.windowStartSample) || input.windowStartSample < 0
        || !Number.isSafeInteger(input.originalSample)
        || !Number.isSafeInteger(input.minimumSample)
        || !Number.isSafeInteger(input.maximumSample)
        || input.minimumSample > input.originalSample
        || input.originalSample > input.maximumSample
        || input.originalSample < input.windowStartSample
        || input.originalSample > windowEnd) {
        throw new Error('Editorial quiet-boundary search bounds are invalid.');
    }
    const minimum = Math.max(
        input.minimumSample,
        input.originalSample - maximumSearch,
        input.windowStartSample + Math.floor(tenMilliseconds / 2),
    );
    const maximum = Math.min(
        input.maximumSample,
        input.originalSample + maximumSearch,
        windowEnd - Math.ceil(tenMilliseconds / 2),
    );
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum) {
        return input.originalSample;
    }

    const halfLeft = Math.floor(tenMilliseconds / 2);
    const halfRight = tenMilliseconds - halfLeft;
    let bestSample = minimum;
    let bestEnergy = Number.POSITIVE_INFINITY;
    for (let candidate = minimum; candidate <= maximum; candidate += 1) {
        let energy = 0;
        for (let sample = candidate - halfLeft; sample < candidate + halfRight; sample += 1) {
            const value = input.samples[sample - input.windowStartSample] / 32_768;
            energy += value * value;
        }
        if (energy < bestEnergy || (energy === bestEnergy && isPreferredTie(
            candidate,
            bestSample,
            input.originalSample,
        ))) {
            bestEnergy = energy;
            bestSample = candidate;
        }
    }

    let crossing = bestSample;
    let crossingDistance = Number.POSITIVE_INFINITY;
    const crossingMinimum = Math.max(minimum, bestSample - fiveMilliseconds);
    const crossingMaximum = Math.min(maximum, bestSample + fiveMilliseconds);
    for (let sample = crossingMinimum; sample <= crossingMaximum; sample += 1) {
        const index = sample - input.windowStartSample;
        const left = input.samples[Math.max(0, index - 1)] ?? 0;
        const right = input.samples[Math.min(input.samples.length - 1, index)] ?? 0;
        if (!((left <= 0 && right >= 0) || (left >= 0 && right <= 0))) continue;
        const distance = Math.abs(sample - bestSample);
        if (distance < crossingDistance || (distance === crossingDistance && isPreferredTie(
            sample,
            crossing,
            input.originalSample,
        ))) {
            crossing = sample;
            crossingDistance = distance;
        }
    }
    return crossing;
}

export class IndexedDbEditorialPcmWindowCacheDriver implements EditorialPcmWindowCacheDriver {
    private disabled = false;

    constructor(private readonly databaseProvider?: () => Promise<IDBDatabase>) {}

    async read(key: string, lastAccess: number): Promise<unknown | null> {
        return this.runTransaction([WINDOW_STORE, METADATA_STORE], 'readwrite', (
            transaction,
            setResult,
            fail,
        ) => {
            const request = transaction.objectStore(WINDOW_STORE).get(key);
            setResult(null);
            request.onerror = () => fail(request.error);
            request.onsuccess = () => {
                setResult(request.result ?? null);
                if (!request.result) return;
                const metadata = transaction.objectStore(METADATA_STORE).put({
                    key,
                    bytes: request.result.bytes,
                    lastAccess,
                } satisfies EditorialPcmWindowMetadata);
                metadata.onerror = () => fail(metadata.error);
            };
        });
    }

    async write(record: StoredEditorialPcmWindow, maxBytes: number): Promise<void> {
        if (record.bytes > maxBytes) return;
        await this.runTransaction([WINDOW_STORE, METADATA_STORE], 'readwrite', (
            transaction,
            setResult,
            fail,
        ) => {
            setResult(undefined);
            const windows = transaction.objectStore(WINDOW_STORE);
            const metadata = transaction.objectStore(METADATA_STORE);
            const list = metadata.getAll();
            list.onerror = () => fail(list.error);
            list.onsuccess = () => {
                const records = (list.result as unknown[]).filter(isPcmMetadata);
                const retained = records.filter(item => item.key !== record.key);
                let bytes = retained.reduce((total, item) => total + item.bytes, 0) + record.bytes;
                for (const item of retained.sort((left, right) => (
                    left.lastAccess - right.lastAccess || left.key.localeCompare(right.key)
                ))) {
                    if (bytes <= maxBytes) break;
                    bytes -= item.bytes;
                    const removeWindow = windows.delete(item.key);
                    removeWindow.onerror = () => fail(removeWindow.error);
                    const removeMetadata = metadata.delete(item.key);
                    removeMetadata.onerror = () => fail(removeMetadata.error);
                }
                const putWindow = windows.put(record);
                putWindow.onerror = () => fail(putWindow.error);
                const putMetadata = metadata.put({
                    key: record.key,
                    bytes: record.bytes,
                    lastAccess: record.lastAccess,
                } satisfies EditorialPcmWindowMetadata);
                putMetadata.onerror = () => fail(putMetadata.error);
            };
        });
    }

    async remove(key: string): Promise<void> {
        await this.runTransaction([WINDOW_STORE, METADATA_STORE], 'readwrite', (
            transaction,
            setResult,
            fail,
        ) => {
            setResult(undefined);
            const windowRequest = transaction.objectStore(WINDOW_STORE).delete(key);
            windowRequest.onerror = () => fail(windowRequest.error);
            const metadataRequest = transaction.objectStore(METADATA_STORE).delete(key);
            metadataRequest.onerror = () => fail(metadataRequest.error);
        });
    }

    private async openDatabase(): Promise<IDBDatabase> {
        if (this.databaseProvider) return this.databaseProvider();
        if (this.disabled || typeof indexedDB === 'undefined') {
            throw new Error('Editorial PCM IndexedDB is unavailable.');
        }
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
            let settled = false;
            const fail = (error: unknown) => {
                if (settled) return;
                settled = true;
                this.disabled = true;
                reject(error);
            };
            request.onerror = () => fail(request.error);
            request.onblocked = () => fail(new Error('Opening editorial PCM cache was blocked.'));
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(WINDOW_STORE)) {
                    request.result.createObjectStore(WINDOW_STORE, { keyPath: 'key' });
                }
                if (!request.result.objectStoreNames.contains(METADATA_STORE)) {
                    request.result.createObjectStore(METADATA_STORE, { keyPath: 'key' });
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
            setResult: (value: Result) => void,
            fail: (error: unknown) => void,
        ) => void,
    ): Promise<Result> {
        const database = await this.openDatabase();
        return new Promise((resolve, reject) => {
            let result: Result;
            let explicitError: unknown;
            let settled = false;
            const transaction = database.transaction(storeNames, mode);
            const finish = (error?: unknown) => {
                if (settled) return;
                settled = true;
                database.close();
                if (error !== undefined) reject(error);
                else resolve(result);
            };
            const fail = (error: unknown) => {
                explicitError = error ?? new Error('Editorial PCM cache request failed.');
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

function assertWindowIdentity(identity: EditorialPcmWindowIdentity): void {
    if (!identity.sourceFingerprint
        || identity.pcmAlgorithmVersion !== 1
        || !Number.isSafeInteger(identity.startSample) || identity.startSample < 0
        || !Number.isSafeInteger(identity.endSample) || identity.endSample <= identity.startSample) {
        throw new Error('Editorial PCM window key is invalid.');
    }
}

function sameIdentity(
    record: StoredEditorialPcmWindow,
    identity: EditorialPcmWindowIdentity,
): boolean {
    return record.sourceFingerprint === identity.sourceFingerprint
        && record.pcmAlgorithmVersion === identity.pcmAlgorithmVersion
        && record.startSample === identity.startSample
        && record.endSample === identity.endSample;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPcmMetadata(value: unknown): value is EditorialPcmWindowMetadata {
    return isRecord(value) && typeof value.key === 'string'
        && Number.isFinite(value.bytes) && (value.bytes as number) >= 0
        && Number.isFinite(value.lastAccess) && (value.lastAccess as number) >= 0;
}

function isPreferredTie(candidate: number, incumbent: number, origin: number): boolean {
    const candidateDistance = Math.abs(candidate - origin);
    const incumbentDistance = Math.abs(incumbent - origin);
    return candidateDistance < incumbentDistance
        || (candidateDistance === incumbentDistance && candidate < incumbent);
}

function createAbortError(): DOMException {
    return new DOMException('Editorial PCM window decode was cancelled.', 'AbortError');
}
