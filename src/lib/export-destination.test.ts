import { describe, expect, it, vi } from 'vitest';
import { StreamTarget } from 'mediabunny';
import type { ExportWriteChunk } from '@/types/export';
import {
    MAXIMUM_MEMORY_EXPORT_BYTES,
    STREAM_TARGET_CHUNK_BYTES,
    ExportMemoryLimitError,
    acquireExportDestination,
    createExportDestinationRuntime,
    getAdaptiveMemoryExportLimitBytes,
    getMaximumMemoryOutputBytes,
} from './export-destination';

const MEBIBYTE = 1024 * 1024;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
    return { promise, resolve };
}

interface TestTargetWriter {
    start(): void;
    write(data: Uint8Array): void;
    seek(position: number): void;
    flush(): Promise<void>;
    finalize(): Promise<void>;
}

function createTargetWriter(target: StreamTarget): TestTargetWriter {
    return (target as unknown as { _createWriter(): TestTargetWriter })._createWriter();
}

describe('export destination acquisition', () => {
    it('opens the picker immediately and returns its already-authorized writable stream', async () => {
        const writable = new WritableStream<ExportWriteChunk>();
        const createWritable = vi.fn(async () => writable);
        const pickerGate = deferred<{ createWritable(): Promise<WritableStream<ExportWriteChunk>> }>();
        const picker = vi.fn(() => pickerGate.promise);

        const acquisition = acquireExportDestination({
            format: 'mp4',
            suggestedName: 'cut.mp4',
            estimatedBytes: 999 * MEBIBYTE,
            picker,
        });

        // The picker call happens before acquireExportDestination yields its first Promise turn.
        expect(picker).toHaveBeenCalledTimes(1);
        expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'cut.mp4' }));
        pickerGate.resolve({ createWritable });

        await expect(acquisition).resolves.toEqual({ kind: 'stream', writable });
        expect(createWritable).toHaveBeenCalledTimes(1);
    });

    it('uses adaptive memory limits and rejects oversized files before a target is created', async () => {
        expect(getAdaptiveMemoryExportLimitBytes(2)).toBe(96 * MEBIBYTE);
        expect(getAdaptiveMemoryExportLimitBytes(4)).toBe(192 * MEBIBYTE);
        expect(getAdaptiveMemoryExportLimitBytes(8)).toBe(384 * MEBIBYTE);
        expect(getAdaptiveMemoryExportLimitBytes(16)).toBe(MAXIMUM_MEMORY_EXPORT_BYTES);

        await expect(acquireExportDestination({
            format: 'webm',
            suggestedName: 'cut.webm',
            estimatedBytes: 97 * MEBIBYTE,
            deviceMemory: 2,
            picker: null,
        })).rejects.toMatchObject({
            name: 'ExportMemoryLimitError',
            estimatedBytes: 97 * MEBIBYTE,
            maximumBytes: 48 * MEBIBYTE,
            memoryAllowanceBytes: 96 * MEBIBYTE,
        });
        await expect(acquireExportDestination({
            format: 'webm',
            suggestedName: 'cut.webm',
            estimatedBytes: 12 * MEBIBYTE,
            deviceMemory: 2,
            picker: null,
        })).resolves.toEqual({
            kind: 'memory',
            estimatedBytes: 12 * MEBIBYTE,
            maximumBytes: 48 * MEBIBYTE,
            memoryAllowanceBytes: 96 * MEBIBYTE,
        });
        expect(getMaximumMemoryOutputBytes(MAXIMUM_MEMORY_EXPORT_BYTES))
            .toBe(256 * MEBIBYTE);
    });
});

describe('export destination runtime', () => {
    it('rejects a crossing positional write before retaining any memory', async () => {
        expect(() => createExportDestinationRuntime({
            kind: 'memory',
            estimatedBytes: MAXIMUM_MEMORY_EXPORT_BYTES + 1,
            maximumBytes: MAXIMUM_MEMORY_EXPORT_BYTES + 1,
            memoryAllowanceBytes: MAXIMUM_MEMORY_EXPORT_BYTES + 1,
        })).toThrow(ExportMemoryLimitError);

        const allocateMemoryChunk = vi.fn((size: number) => new Uint8Array(size));
        const maximumBytes = 16 * MEBIBYTE;
        const runtime = createExportDestinationRuntime({
            kind: 'memory',
            estimatedBytes: 1,
            maximumBytes,
            memoryAllowanceBytes: 32 * MEBIBYTE,
        }, undefined, { allocateMemoryChunk });
        // Exercise the bounded positional stream installed behind the real StreamTarget. The
        // destination rejects the complete range before its allocator retains any crossing bytes.
        const writer = (runtime.target as StreamTarget & {
            _writable: WritableStream<ExportWriteChunk>;
        })._writable.getWriter();
        await expect(writer.write({
            type: 'write',
            position: maximumBytes - 1,
            data: new Uint8Array([1, 2]),
        })).rejects.toMatchObject({ name: 'ExportMemoryLimitError' });
        expect(allocateMemoryChunk).not.toHaveBeenCalled();
        await runtime.abort();
    });

    it('assembles a positional file within the declared peak-memory allowance', async () => {
        const allocations: Uint8Array<ArrayBuffer>[] = [];
        const memoryAllowanceBytes = 32 * MEBIBYTE;
        const maximumBytes = getMaximumMemoryOutputBytes(memoryAllowanceBytes);
        const runtime = createExportDestinationRuntime({
            kind: 'memory',
            estimatedBytes: 3 * MEBIBYTE,
            maximumBytes,
            memoryAllowanceBytes,
        }, undefined, {
            allocateMemoryChunk: (size) => {
                const chunk = new Uint8Array(size);
                allocations.push(chunk);
                return chunk;
            },
        });
        expect(runtime.target).toBeInstanceOf(StreamTarget);
        const writer = createTargetWriter(runtime.target as StreamTarget);
        writer.start();
        writer.write(new Uint8Array([1, 2, 3]));
        writer.seek(2 * MEBIBYTE);
        writer.write(new Uint8Array([4, 5]));
        runtime.prepareCommit();
        await writer.flush();
        await writer.finalize();

        const buffer = runtime.getMemoryBuffer();
        expect(buffer?.byteLength).toBe(2 * MEBIBYTE + 2);
        const bytes = new Uint8Array(buffer!);
        expect(Array.from(bytes.subarray(0, 3))).toEqual([1, 2, 3]);
        expect(Array.from(bytes.subarray(2 * MEBIBYTE))).toEqual([4, 5]);
        const retainedBeforeAssembly = allocations.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        expect(retainedBeforeAssembly + buffer!.byteLength).toBeLessThanOrEqual(memoryAllowanceBytes);
        expect(Math.max(...allocations.map((chunk) => chunk.byteLength))).toBeLessThanOrEqual(MEBIBYTE);
    });

    it('preserves backpressure and commits an authorized stream exactly once', async () => {
        const writeGate = deferred<void>();
        const write = vi.fn((chunk: ExportWriteChunk) => {
            void chunk;
            return writeGate.promise;
        });
        const close = vi.fn(async () => undefined);
        const abort = vi.fn(async () => undefined);
        const destination = new WritableStream<ExportWriteChunk>({ write, close, abort });
        const runtime = createExportDestinationRuntime({ kind: 'stream', writable: destination });
        const target = runtime.target as StreamTarget & {
            _writable: WritableStream<ExportWriteChunk>;
            _options: { chunkSize?: number };
        };
        expect(target).toBeInstanceOf(StreamTarget);
        expect(target._options.chunkSize).toBe(STREAM_TARGET_CHUNK_BYTES);

        runtime.prepareCommit();
        const writer = target._writable.getWriter();
        const chunk: ExportWriteChunk = {
            type: 'write',
            data: new Uint8Array([1, 2, 3]),
            position: 7,
        };
        let writeSettled = false;
        const pendingWrite = writer.write(chunk).then(() => { writeSettled = true; });
        await Promise.resolve();
        expect(writeSettled).toBe(false);
        writeGate.resolve();
        await pendingWrite;
        await writer.close();

        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0][0]).toBe(chunk);
        expect(close).toHaveBeenCalledTimes(1);
        expect(abort).not.toHaveBeenCalled();
        expect(runtime.getBytesWritten()).toBe(10);
    });

    it('aborts an uncommitted or signalled stream exactly once', async () => {
        const close = vi.fn(async () => undefined);
        const abort = vi.fn(async () => undefined);
        const firstWritable = new WritableStream<ExportWriteChunk>({ close, abort });
        const first = createExportDestinationRuntime({ kind: 'stream', writable: firstWritable });
        const firstWriter = (first.target as StreamTarget & {
            _writable: WritableStream<ExportWriteChunk>;
        })._writable.getWriter();
        await firstWriter.close();
        expect(abort).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();

        const secondAbort = vi.fn(async () => undefined);
        const controller = new AbortController();
        const second = createExportDestinationRuntime({
            kind: 'stream',
            writable: new WritableStream<ExportWriteChunk>({ abort: secondAbort }),
        }, controller.signal);
        controller.abort();
        await Promise.resolve();
        const secondWriter = (second.target as StreamTarget & {
            _writable: WritableStream<ExportWriteChunk>;
        })._writable.getWriter();
        await expect(secondWriter.close()).resolves.toBeUndefined();
        expect(secondAbort).toHaveBeenCalledTimes(1);
    });

    it('shares one awaited abort across repeated export cleanup calls', async () => {
        const abortGate = deferred<void>();
        const abort = vi.fn(() => abortGate.promise);
        const runtime = createExportDestinationRuntime({
            kind: 'stream',
            writable: new WritableStream<ExportWriteChunk>({ abort }),
        });

        const firstCleanup = runtime.abort(new Error('setup failed'));
        const secondCleanup = runtime.abort(new Error('repeated cleanup'));
        expect(firstCleanup).toBe(secondCleanup);
        await Promise.resolve();
        expect(abort).toHaveBeenCalledTimes(1);
        abortGate.resolve();
        await Promise.all([firstCleanup, secondCleanup]);
        expect(abort).toHaveBeenCalledTimes(1);
    });
});
