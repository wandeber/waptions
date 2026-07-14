import { StreamTarget, type Target } from 'mediabunny';
import type {
    ExportDestination,
    ExportFormat,
    ExportWriteChunk,
} from '@/types/export';
import { runtimeDiagnostics } from './runtime-diagnostics';
import { createExportAbortError, throwIfExportAborted } from './export-job';

const MEBIBYTE = 1024 * 1024;
const MEMORY_FILE_CHUNK_BYTES = MEBIBYTE;
const MINIMUM_MEMORY_ALLOWANCE_BYTES = 32 * MEBIBYTE;

/** Absolute peak-memory allowance, including encoded chunks and the final downloadable artifact. */
export const MAXIMUM_MEMORY_EXPORT_BYTES = 512 * MEBIBYTE;

/**
 * Mediabunny may transiently allocate a third bucket before flushing the first two. Four MiB
 * buckets keep its random-write staging plus the current sections at no more than sixteen MiB,
 * while preserving real WritableStream backpressure.
 */
export const STREAM_TARGET_CHUNK_BYTES = 4 * MEBIBYTE;

interface SaveFilePickerHandle {
    createWritable(): Promise<WritableStream<ExportWriteChunk>>;
}

interface SaveFilePickerOptions {
    suggestedName: string;
    types: Array<{
        description: string;
        accept: Record<string, string[]>;
    }>;
}

type SaveFilePicker = (options: SaveFilePickerOptions) => Promise<SaveFilePickerHandle>;

export interface AcquireExportDestinationOptions {
    format: ExportFormat;
    suggestedName: string;
    estimatedBytes: number;
    deviceMemory?: number;
    picker?: SaveFilePicker | null;
}

export class ExportMemoryLimitError extends Error {
    constructor(
        readonly estimatedBytes: number,
        /** Maximum encoded file size, not the total device-memory allowance. */
        readonly maximumBytes: number,
        readonly memoryAllowanceBytes = maximumBytes * 2,
    ) {
        super(
            `This export is estimated at ${formatBytes(estimatedBytes)}, above the safe encoded-file `
            + `limit of ${formatBytes(maximumBytes)} within this browser's `
            + `${formatBytes(memoryAllowanceBytes)} export memory allowance. Half of that allowance `
            + 'is reserved for final ArrayBuffer and Blob creation. Use direct-to-disk streaming, '
            + 'lower the output quality, or shorten the timeline.',
        );
        this.name = 'ExportMemoryLimitError';
    }
}

/** Conservative total allocation allowance used only when direct-to-disk streaming is unavailable. */
export function getAdaptiveMemoryExportLimitBytes(deviceMemory?: number): number {
    if (typeof deviceMemory !== 'number' || !Number.isFinite(deviceMemory)) return 256 * MEBIBYTE;
    if (deviceMemory <= 2) return 96 * MEBIBYTE;
    if (deviceMemory <= 4) return 192 * MEBIBYTE;
    if (deviceMemory <= 8) return 384 * MEBIBYTE;
    return MAXIMUM_MEMORY_EXPORT_BYTES;
}

/**
 * Reserves equal peak headroom for retained encoded chunks and final ArrayBuffer/Blob creation.
 * StreamTarget's at-most-sixteen-MiB staging fits inside the unoccupied half during encoding.
 */
export function getMaximumMemoryOutputBytes(memoryAllowanceBytes: number): number {
    return Math.floor(Math.max(0, memoryAllowanceBytes) / 2);
}

/**
 * Acquires the file picker synchronously up to its first browser-controlled await.
 *
 * Callers must invoke (not await) this function directly inside the click handler before any
 * unrelated asynchronous work. Browsers without the API receive a compatibility destination whose
 * encoded size and final artifact together remain inside one adaptive peak-memory allowance.
 */
export async function acquireExportDestination(
    options: AcquireExportDestinationOptions,
): Promise<ExportDestination> {
    const picker = options.picker === undefined ? getBrowserSaveFilePicker() : options.picker;
    if (picker) {
        const handle = await picker({
            suggestedName: options.suggestedName,
            types: [getPickerType(options.format)],
        });
        // This is intentionally the next await after the picker. Opening the authorized stream
        // before export setup prevents a later permission prompt from losing user activation.
        const writable = await handle.createWritable();
        return { kind: 'stream', writable };
    }

    const memoryAllowanceBytes = Math.min(
        MAXIMUM_MEMORY_EXPORT_BYTES,
        getAdaptiveMemoryExportLimitBytes(options.deviceMemory ?? getBrowserDeviceMemory()),
    );
    const maximumBytes = getMaximumMemoryOutputBytes(memoryAllowanceBytes);
    if (options.estimatedBytes > maximumBytes) {
        throw new ExportMemoryLimitError(
            options.estimatedBytes,
            maximumBytes,
            memoryAllowanceBytes,
        );
    }
    return {
        kind: 'memory',
        estimatedBytes: options.estimatedBytes,
        maximumBytes,
        memoryAllowanceBytes,
    };
}

export interface ExportDestinationRuntime {
    readonly target: Target;
    readonly kind: ExportDestination['kind'];
    prepareCommit(): void;
    /** Releases an uncommitted destination even when Mediabunny never started its own writer. */
    abort(reason?: unknown): Promise<void>;
    getBytesWritten(): number;
    getMemoryBuffer(): ArrayBuffer | undefined;
}

export interface ExportDestinationRuntimeDependencies {
    allocateMemoryChunk?: (size: number) => Uint8Array<ArrayBuffer>;
}

/**
 * Establishes destination ownership before export validation or any other fallible asynchronous
 * phase. A pre-aborted signal still returns an owner whose terminal promise can be awaited by the
 * export job, rather than throwing while an already-authorized file writer remains open.
 */
export function createExportDestinationRuntime(
    destination: ExportDestination,
    signal?: AbortSignal,
    dependencies: ExportDestinationRuntimeDependencies = {},
): ExportDestinationRuntime {
    if (destination.kind === 'memory') {
        return createMemoryRuntime(destination, signal, dependencies);
    }
    return createStreamRuntime(destination, signal);
}

function createMemoryRuntime(
    destination: Extract<ExportDestination, { kind: 'memory' }>,
    signal: AbortSignal | undefined,
    dependencies: ExportDestinationRuntimeDependencies,
): ExportDestinationRuntime {
    const memoryAllowanceBytes = Math.min(
        destination.memoryAllowanceBytes,
        MAXIMUM_MEMORY_EXPORT_BYTES,
    );
    const maximumBytes = Math.min(
        destination.maximumBytes,
        getMaximumMemoryOutputBytes(memoryAllowanceBytes),
    );
    if (
        !Number.isSafeInteger(destination.estimatedBytes)
        || destination.estimatedBytes < 0
        || !Number.isSafeInteger(memoryAllowanceBytes)
        || memoryAllowanceBytes < MINIMUM_MEMORY_ALLOWANCE_BYTES
        || !Number.isSafeInteger(maximumBytes)
        || maximumBytes <= 0
        || destination.estimatedBytes > maximumBytes
    ) {
        throw new ExportMemoryLimitError(
            destination.estimatedBytes,
            Math.max(0, maximumBytes),
            Math.max(0, memoryAllowanceBytes),
        );
    }

    const memoryFile = new BoundedMemoryExportFile(
        maximumBytes,
        memoryAllowanceBytes,
        dependencies.allocateMemoryChunk,
    );
    let commitRequested = false;
    let abortPromise: Promise<void> | null = null;
    let publishedByteBucket = 0;
    const handleAbort = () => {
        void abort(signal?.reason).catch(() => undefined);
    };
    const abort = (reason?: unknown): Promise<void> => {
        if (abortPromise) return abortPromise;
        signal?.removeEventListener('abort', handleAbort);
        abortPromise = memoryFile.abort(reason);
        return abortPromise;
    };
    if (signal?.aborted) void abort(signal.reason).catch(() => undefined);
    else signal?.addEventListener('abort', handleAbort, { once: true });

    const target = new StreamTarget(memoryFile.writable, {
        chunked: true,
        chunkSize: STREAM_TARGET_CHUNK_BYTES,
    });
    target.onwrite = (_start, end) => {
        const nextBucket = Math.floor(end / MEBIBYTE);
        if (nextBucket > publishedByteBucket) {
            publishedByteBucket = nextBucket;
            runtimeDiagnostics.setGauge('export', 'bufferedBytes', end);
        }
    };

    return {
        target,
        kind: 'memory',
        prepareCommit: () => { commitRequested = true; },
        abort,
        getBytesWritten: () => memoryFile.bytesWritten,
        getMemoryBuffer: () => commitRequested ? memoryFile.assemble() : undefined,
    };
}

function createStreamRuntime(
    destination: Extract<ExportDestination, { kind: 'stream' }>,
    signal?: AbortSignal,
): ExportDestinationRuntime {
    const underlyingWriter = destination.writable.getWriter();
    let bytesWritten = 0;
    let commitRequested = false;
    let terminalPromise: Promise<void> | null = null;

    const terminate = (commit: boolean, reason?: unknown): Promise<void> => {
        if (terminalPromise) return terminalPromise;
        signal?.removeEventListener('abort', handleAbort);
        terminalPromise = commit && !signal?.aborted
            ? underlyingWriter.close()
            : underlyingWriter.abort(reason ?? createExportAbortError());
        return terminalPromise;
    };
    const handleAbort = () => {
        void terminate(false, signal?.reason).catch(() => undefined);
    };

    let target: StreamTarget;
    try {
        const writable = new WritableStream<ExportWriteChunk>({
            write: async (chunk) => {
                throwIfExportAborted(signal);
                const startedAt = now();
                await underlyingWriter.write(chunk);
                bytesWritten = Math.max(bytesWritten, chunk.position + chunk.data.byteLength);
                runtimeDiagnostics.observeTiming('export', 'write', Math.max(0, now() - startedAt));
            },
            close: () => terminate(commitRequested),
            abort: (reason) => terminate(false, reason),
        }, {
            // One queued chunk complements Mediabunny's bounded staging buckets without building
            // an additional list of pending writes. desiredSize propagates disk backpressure.
            highWaterMark: 1,
        });
        target = new StreamTarget(writable, {
            chunked: true,
            chunkSize: STREAM_TARGET_CHUNK_BYTES,
        });
    } catch (error) {
        void underlyingWriter.abort(error).catch(() => undefined);
        throw error;
    }

    if (signal?.aborted) void terminate(false, signal.reason).catch(() => undefined);
    else signal?.addEventListener('abort', handleAbort, { once: true });

    return {
        target,
        kind: 'stream',
        prepareCommit: () => { commitRequested = true; },
        // terminate() owns the single terminal promise shared by the AbortSignal listener, the
        // StreamTarget close callback, and export-job cleanup.
        abort: (reason) => terminate(false, reason),
        getBytesWritten: () => bytesWritten,
        getMemoryBuffer: () => undefined,
    };
}

/** Positional, sparse, pre-write-bounded storage used behind the memory StreamTarget. */
class BoundedMemoryExportFile {
    readonly writable: WritableStream<ExportWriteChunk>;
    private readonly chunks = new Map<number, Uint8Array<ArrayBuffer>>();
    private readonly allocateChunk: (size: number) => Uint8Array<ArrayBuffer>;
    private outputBuffer: ArrayBuffer | null = null;
    private aborted = false;
    private closed = false;
    private storedBytes = 0;
    private highWaterMark = 0;
    private abortPromise: Promise<void> | null = null;

    constructor(
        private readonly maximumBytes: number,
        private readonly memoryAllowanceBytes: number,
        allocateChunk?: (size: number) => Uint8Array<ArrayBuffer>,
    ) {
        this.allocateChunk = allocateChunk ?? ((size) => new Uint8Array(size));
        this.writable = new WritableStream<ExportWriteChunk>({
            write: (chunk) => this.write(chunk),
            close: () => { this.closed = true; },
            abort: (reason) => this.abort(reason),
        });
    }

    get bytesWritten(): number {
        return this.highWaterMark;
    }

    abort(reason?: unknown): Promise<void> {
        void reason;
        if (this.abortPromise) return this.abortPromise;
        this.abortPromise = Promise.resolve().then(() => {
            this.aborted = true;
            this.chunks.clear();
            this.storedBytes = 0;
            this.outputBuffer = null;
        });
        return this.abortPromise;
    }

    assemble(): ArrayBuffer | undefined {
        if (this.aborted || !this.closed) return undefined;
        if (this.outputBuffer) return this.outputBuffer;
        // At this point StreamTarget has flushed and released its staging buckets. Retained chunks
        // use at most half the allowance; the final buffer uses at most the other half. Chunks are
        // released immediately afterwards, leaving that same half available if Blob copies bytes.
        const output = new Uint8Array(this.highWaterMark);
        this.chunks.forEach((chunk, index) => {
            const start = index * MEMORY_FILE_CHUNK_BYTES;
            const writableLength = Math.min(chunk.byteLength, this.highWaterMark - start);
            if (writableLength > 0) output.set(chunk.subarray(0, writableLength), start);
        });
        if (this.storedBytes + output.byteLength > this.memoryAllowanceBytes) {
            throw new ExportMemoryLimitError(
                this.storedBytes + output.byteLength,
                this.maximumBytes,
                this.memoryAllowanceBytes,
            );
        }
        this.outputBuffer = output.buffer;
        this.chunks.clear();
        this.storedBytes = 0;
        return this.outputBuffer;
    }

    private write(chunk: ExportWriteChunk): void {
        if (this.aborted) throw createExportAbortError();
        if (this.closed) throw new Error('Cannot write to a finalized memory export.');
        if (
            chunk.type !== 'write'
            || !Number.isSafeInteger(chunk.position)
            || chunk.position < 0
        ) {
            throw new TypeError('Memory export writes require a non-negative integer position.');
        }
        const end = chunk.position + chunk.data.byteLength;
        // Check the complete positional range before allocating or retaining a single new chunk.
        if (!Number.isSafeInteger(end) || end > this.maximumBytes) {
            throw new ExportMemoryLimitError(end, this.maximumBytes, this.memoryAllowanceBytes);
        }

        let sourceOffset = 0;
        while (sourceOffset < chunk.data.byteLength) {
            const position = chunk.position + sourceOffset;
            const index = Math.floor(position / MEMORY_FILE_CHUNK_BYTES);
            const chunkStart = index * MEMORY_FILE_CHUNK_BYTES;
            const relativeOffset = position - chunkStart;
            const allocationSize = Math.min(
                MEMORY_FILE_CHUNK_BYTES,
                this.maximumBytes - chunkStart,
            );
            let retained = this.chunks.get(index);
            if (!retained) {
                if (this.storedBytes + allocationSize > this.maximumBytes) {
                    throw new ExportMemoryLimitError(
                        this.storedBytes + allocationSize,
                        this.maximumBytes,
                        this.memoryAllowanceBytes,
                    );
                }
                retained = this.allocateChunk(allocationSize);
                if (retained.byteLength !== allocationSize) {
                    throw new Error('Memory export allocator returned an unexpected chunk size.');
                }
                this.chunks.set(index, retained);
                this.storedBytes += allocationSize;
            }
            const length = Math.min(
                chunk.data.byteLength - sourceOffset,
                retained.byteLength - relativeOffset,
            );
            retained.set(chunk.data.subarray(sourceOffset, sourceOffset + length), relativeOffset);
            sourceOffset += length;
        }
        this.highWaterMark = Math.max(this.highWaterMark, end);
    }
}

function getBrowserSaveFilePicker(): SaveFilePicker | null {
    if (typeof window === 'undefined') return null;
    const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
    return picker ? picker.bind(window) : null;
}

function getBrowserDeviceMemory(): number | undefined {
    if (typeof navigator === 'undefined') return undefined;
    return (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
}

function getPickerType(format: ExportFormat): SaveFilePickerOptions['types'][number] {
    return format === 'webm'
        ? { description: 'WebM video', accept: { 'video/webm': ['.webm'] } }
        : { description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } };
}

function formatBytes(value: number): string {
    return `${Math.ceil(Math.max(0, value) / MEBIBYTE)} MiB`;
}

function now(): number {
    return typeof performance === 'undefined' ? Date.now() : performance.now();
}
