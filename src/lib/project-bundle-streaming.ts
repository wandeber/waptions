import {
    inspectProjectBundleZipBlob,
    type InspectedProjectBundleZipEntry,
} from './project-bundle-zip';
import type { Sha256Digest } from '@/types/editorial';
import { IncrementalSha256 } from './project-bundle-digest';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;
const UTF8_DATA_DESCRIPTOR_FLAGS = 0x0808;
const MAX_LOCAL_HEADER_BYTES = 64 * 1024;
export const MAX_IN_MEMORY_BUNDLE_BYTES = 128 * 1024 * 1024;
const MAX_COMPRESSED_LEGACY_ENTRY_BYTES = 8 * 1024 * 1024;

export interface ProjectBundleZipSink {
    write(bytes: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort?(reason: unknown): Promise<void>;
}

export interface StoredProjectBundleEntry {
    name: string;
    data: Blob;
}

export interface ProjectBundleArchiveEntry {
    name: string;
    directory: boolean;
    compressedBytes: number;
    uncompressedBytes: number;
    readBlob(options?: { expectedSha256?: Sha256Digest }): Promise<Blob>;
    readBytes(maximumBytes: number): Promise<Uint8Array>;
}

export interface ProjectBundleArchive {
    readonly entries: ReadonlyMap<string, ProjectBundleArchiveEntry>;
    get(name: string): ProjectBundleArchiveEntry | null;
}

interface WrittenCentralEntry {
    nameBytes: Uint8Array;
    crc32: number;
    size: number;
    localHeaderOffset: number;
}

/** Writes an uncompressed ZIP directly to a backpressured destination with one chunk in flight. */
export async function writeStoredProjectBundleZip(input: {
    entries: readonly StoredProjectBundleEntry[];
    sink: ProjectBundleZipSink;
    signal?: AbortSignal;
}): Promise<void> {
    const central: WrittenCentralEntry[] = [];
    let offset = 0;
    let closed = false;
    const write = async (bytes: Uint8Array): Promise<void> => {
        throwIfAborted(input.signal);
        await input.sink.write(bytes);
        offset = checkedAdd(offset, bytes.byteLength);
    };
    try {
        for (const entry of input.entries) {
            assertEntryName(entry.name);
            const nameBytes = new TextEncoder().encode(entry.name);
            const localHeaderOffset = offset;
            const zip64 = entry.data.size >= UINT32_MAX;
            const localExtra = zip64 ? zip64Extra([entry.data.size, entry.data.size]) : new Uint8Array();
            const header = new Uint8Array(30 + nameBytes.byteLength + localExtra.byteLength);
            const view = new DataView(header.buffer);
            view.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
            view.setUint16(4, zip64 ? 45 : 20, true);
            view.setUint16(6, UTF8_DATA_DESCRIPTOR_FLAGS, true);
            view.setUint16(8, 0, true);
            view.setUint32(14, 0, true);
            view.setUint32(18, zip64 ? UINT32_MAX : entry.data.size, true);
            view.setUint32(22, zip64 ? UINT32_MAX : entry.data.size, true);
            view.setUint16(26, nameBytes.byteLength, true);
            view.setUint16(28, localExtra.byteLength, true);
            header.set(nameBytes, 30);
            header.set(localExtra, 30 + nameBytes.byteLength);
            await write(header);

            let crc32 = 0;
            let writtenEntryBytes = 0;
            const writeEntryChunk = async (value: Uint8Array): Promise<void> => {
                writtenEntryBytes = checkedAdd(writtenEntryBytes, value.byteLength);
                if (writtenEntryBytes > entry.data.size) {
                    throw new Error('Project bundle entry stream exceeds its declared byte size.');
                }
                crc32 = updateCrc32(crc32, value);
                await write(value);
            };
            const byteView = ArrayBuffer.isView(entry.data)
                ? new Uint8Array(
                    entry.data.buffer,
                    entry.data.byteOffset,
                    entry.data.byteLength,
                )
                : null;
            if (byteView) {
                for (let start = 0; start < byteView.byteLength; start += 4 * 1024 * 1024) {
                    const value = byteView.subarray(start, start + 4 * 1024 * 1024);
                    await writeEntryChunk(value);
                }
            } else if (typeof entry.data.stream === 'function') {
                const reader = entry.data.stream().getReader();
                try {
                    while (true) {
                        throwIfAborted(input.signal);
                        const { done, value } = await reader.read();
                        if (done) break;
                        await writeEntryChunk(value);
                    }
                } finally {
                    reader.releaseLock();
                }
            } else {
                // Older test/browser Blob shims may omit stream(), but slice reads remain bounded.
                const chunkBytes = 4 * 1024 * 1024;
                for (let start = 0; start < entry.data.size; start += chunkBytes) {
                    throwIfAborted(input.signal);
                    const value = new Uint8Array(
                        await entry.data.slice(start, start + chunkBytes).arrayBuffer(),
                    );
                    await writeEntryChunk(value);
                }
            }
            if (writtenEntryBytes !== entry.data.size) {
                throw new Error('Project bundle entry stream ended before its declared byte size.');
            }
            const descriptor = new Uint8Array(zip64 ? 24 : 16);
            const descriptorView = new DataView(descriptor.buffer);
            descriptorView.setUint32(0, DATA_DESCRIPTOR_SIGNATURE, true);
            descriptorView.setUint32(4, crc32, true);
            if (zip64) {
                descriptorView.setBigUint64(8, BigInt(entry.data.size), true);
                descriptorView.setBigUint64(16, BigInt(entry.data.size), true);
            } else {
                descriptorView.setUint32(8, entry.data.size, true);
                descriptorView.setUint32(12, entry.data.size, true);
            }
            await write(descriptor);
            central.push({ nameBytes, crc32, size: entry.data.size, localHeaderOffset });
        }

        const centralOffset = offset;
        for (const entry of central) {
            const zip64Size = entry.size >= UINT32_MAX;
            const zip64Offset = entry.localHeaderOffset >= UINT32_MAX;
            const values = [
                ...(zip64Size ? [entry.size, entry.size] : []),
                ...(zip64Offset ? [entry.localHeaderOffset] : []),
            ];
            const extra = values.length > 0 ? zip64Extra(values) : new Uint8Array();
            const header = new Uint8Array(46 + entry.nameBytes.byteLength + extra.byteLength);
            const view = new DataView(header.buffer);
            view.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
            view.setUint16(4, 0x031e, true);
            view.setUint16(6, values.length > 0 ? 45 : 20, true);
            view.setUint16(8, UTF8_DATA_DESCRIPTOR_FLAGS, true);
            view.setUint16(10, 0, true);
            view.setUint32(16, entry.crc32, true);
            view.setUint32(20, zip64Size ? UINT32_MAX : entry.size, true);
            view.setUint32(24, zip64Size ? UINT32_MAX : entry.size, true);
            view.setUint16(28, entry.nameBytes.byteLength, true);
            view.setUint16(30, extra.byteLength, true);
            view.setUint32(38, 0o100644 << 16, true);
            view.setUint32(42, zip64Offset ? UINT32_MAX : entry.localHeaderOffset, true);
            header.set(entry.nameBytes, 46);
            header.set(extra, 46 + entry.nameBytes.byteLength);
            await write(header);
        }
        const centralBytes = offset - centralOffset;
        const requiresZip64 = central.length >= UINT16_MAX
            || centralOffset >= UINT32_MAX
            || centralBytes >= UINT32_MAX
            || central.some(entry => entry.size >= UINT32_MAX || entry.localHeaderOffset >= UINT32_MAX);
        if (requiresZip64) {
            const zip64Offset = offset;
            const zip64 = new Uint8Array(56);
            const view = new DataView(zip64.buffer);
            view.setUint32(0, ZIP64_EOCD_SIGNATURE, true);
            view.setBigUint64(4, BigInt(44), true);
            view.setUint16(12, 45, true);
            view.setUint16(14, 45, true);
            view.setBigUint64(24, BigInt(central.length), true);
            view.setBigUint64(32, BigInt(central.length), true);
            view.setBigUint64(40, BigInt(centralBytes), true);
            view.setBigUint64(48, BigInt(centralOffset), true);
            await write(zip64);
            const locator = new Uint8Array(20);
            const locatorView = new DataView(locator.buffer);
            locatorView.setUint32(0, ZIP64_LOCATOR_SIGNATURE, true);
            locatorView.setBigUint64(8, BigInt(zip64Offset), true);
            locatorView.setUint32(16, 1, true);
            await write(locator);
        }
        const eocd = new Uint8Array(22);
        const eocdView = new DataView(eocd.buffer);
        eocdView.setUint32(0, EOCD_SIGNATURE, true);
        eocdView.setUint16(8, requiresZip64 ? UINT16_MAX : central.length, true);
        eocdView.setUint16(10, requiresZip64 ? UINT16_MAX : central.length, true);
        eocdView.setUint32(12, requiresZip64 ? UINT32_MAX : centralBytes, true);
        eocdView.setUint32(16, requiresZip64 ? UINT32_MAX : centralOffset, true);
        await write(eocd);
        await input.sink.close();
        closed = true;
    } catch (error) {
        if (!closed) await input.sink.abort?.(error).catch(() => undefined);
        throw error;
    }
}

/** Opens stored media as Blob slices; no archive-sized ArrayBuffer is ever created. */
export async function openRangeBackedProjectBundleArchive(
    blob: Blob,
    maximumEntries: number,
    signal?: AbortSignal,
): Promise<ProjectBundleArchive> {
    throwIfAborted(signal);
    const inspected = await inspectProjectBundleZipBlob(blob, maximumEntries);
    const entries = new Map<string, ProjectBundleArchiveEntry>();
    const physicalRanges: Array<{ start: number; end: number; name: string }> = [];
    for (const entry of inspected) {
        throwIfAborted(signal);
        const data = await locateEntryData(blob, entry);
        physicalRanges.push({
            start: entry.localHeaderOffset,
            end: data.end,
            name: entry.name,
        });
        entries.set(entry.name, {
            name: entry.name,
            directory: entry.directory,
            compressedBytes: entry.compressedBytes,
            uncompressedBytes: entry.uncompressedBytes,
            readBlob: async (options) => {
                throwIfAborted(signal);
                if (entry.compressionMethod === 0) {
                    await verifyStoredEntry(blob, data, entry, options?.expectedSha256, signal);
                    return blob.slice(data.start, data.end);
                }
                if (entry.uncompressedBytes > MAX_COMPRESSED_LEGACY_ENTRY_BYTES) {
                    throw new Error(
                        'Compressed legacy media exceeds the bounded compatibility limit.',
                    );
                }
                const bytes = await readEntryBytes(
                    blob,
                    data,
                    entry,
                    MAX_COMPRESSED_LEGACY_ENTRY_BYTES,
                    signal,
                );
                if (options?.expectedSha256
                    && new IncrementalSha256().update(bytes).digest() !== options.expectedSha256) {
                    throw new Error('Bundle source entry failed its SHA-256 integrity check.');
                }
                return new Blob([bytes]);
            },
            readBytes: async (maximumBytes) => {
                throwIfAborted(signal);
                if (!Number.isSafeInteger(maximumBytes)
                    || maximumBytes <= 0
                    || entry.uncompressedBytes > maximumBytes) {
                    throw new Error('Bundle entry exceeds its bounded read limit.');
                }
                return readEntryBytes(blob, data, entry, maximumBytes, signal);
            },
        });
    }
    physicalRanges.sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < physicalRanges.length; index += 1) {
        if (physicalRanges[index - 1].end > physicalRanges[index].start) {
            throw new Error(
                `Bundle ZIP entries overlap physically near "${physicalRanges[index].name}".`,
            );
        }
    }
    return {
        entries,
        get: name => entries.get(name) ?? null,
    };
}

async function verifyStoredEntry(
    blob: Blob,
    data: { start: number; end: number },
    entry: InspectedProjectBundleZipEntry,
    expectedSha256?: Sha256Digest,
    signal?: AbortSignal,
): Promise<void> {
    const reader = blob.slice(data.start, data.end).stream().getReader();
    let crc32 = 0;
    let bytes = 0;
    const sha256 = expectedSha256 ? new IncrementalSha256() : null;
    try {
        while (true) {
            throwIfAborted(signal);
            const { done, value } = await reader.read();
            if (done) break;
            bytes = checkedAdd(bytes, value.byteLength);
            if (bytes > entry.uncompressedBytes) {
                await reader.cancel();
                throw new Error('Bundle entry exceeds its declared byte size.');
            }
            crc32 = updateCrc32(crc32, value);
            sha256?.update(value);
        }
    } finally {
        reader.releaseLock();
    }
    if (bytes !== entry.uncompressedBytes || crc32 !== entry.crc32) {
        throw new Error('Bundle entry bytes or CRC are corrupt.');
    }
    if (sha256 && sha256.digest() !== expectedSha256) {
        throw new Error('Bundle source entry failed its SHA-256 integrity check.');
    }
}

async function readEntryBytes(
    blob: Blob,
    data: { start: number; end: number },
    entry: InspectedProjectBundleZipEntry,
    maximumBytes: number,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    throwIfAborted(signal);
    if (entry.uncompressedBytes > maximumBytes) {
        throw new Error('Bundle entry exceeds its bounded read limit.');
    }
    if (entry.compressionMethod === 0) {
        const bytes = new Uint8Array(await blob.slice(data.start, data.end).arrayBuffer());
        assertEntryBytes(bytes, entry);
        return bytes;
    }
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('This runtime cannot read compressed legacy bundle entries.');
    }
    const format = 'deflate-raw' as CompressionFormat;
    const stream = blob.slice(data.start, data.end).stream()
        .pipeThrough(new DecompressionStream(format));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            throwIfAborted(signal);
            const { done, value } = await reader.read();
            if (done) break;
            total = checkedAdd(total, value.byteLength);
            if (total > maximumBytes || total > entry.uncompressedBytes) {
                await reader.cancel();
                throw new Error('Compressed bundle entry exceeds its bounded read limit.');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    chunks.forEach((chunk) => {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    });
    assertEntryBytes(bytes, entry);
    return bytes;
}

function assertEntryBytes(
    bytes: Uint8Array,
    entry: InspectedProjectBundleZipEntry,
): void {
    if (bytes.byteLength !== entry.uncompressedBytes
        || updateCrc32(0, bytes) !== entry.crc32) {
        throw new Error('Bundle entry bytes or CRC are corrupt.');
    }
}

export function createWritableStreamZipSink(
    stream: WritableStream<Uint8Array>,
): ProjectBundleZipSink {
    const writer = stream.getWriter();
    return {
        write: bytes => writer.write(bytes),
        close: () => writer.close(),
        abort: reason => writer.abort(reason),
    };
}

export function createBoundedMemoryZipSink(maximumBytes = MAX_IN_MEMORY_BUNDLE_BYTES): {
    sink: ProjectBundleZipSink;
    toBlob(): Blob;
} {
    const parts: Uint8Array[] = [];
    let bytes = 0;
    let closed = false;
    return {
        sink: {
            write: async (chunk) => {
                if (closed) throw new Error('Bundle memory sink is closed.');
                bytes = checkedAdd(bytes, chunk.byteLength);
                if (bytes > maximumBytes) {
                    throw new Error('Project bundle exceeds the in-memory compatibility limit.');
                }
                parts.push(chunk.slice());
            },
            close: async () => { closed = true; },
            abort: async () => {
                closed = true;
                parts.length = 0;
            },
        },
        toBlob: () => {
            if (!closed) throw new Error('Bundle memory sink has not completed.');
            return new Blob(parts, { type: 'application/zip' });
        },
    };
}

function zip64Extra(values: readonly number[]): Uint8Array {
    const extra = new Uint8Array(4 + values.length * 8);
    const view = new DataView(extra.buffer);
    view.setUint16(0, 0x0001, true);
    view.setUint16(2, values.length * 8, true);
    values.forEach((value, index) => {
        view.setBigUint64(4 + index * 8, BigInt(value), true);
    });
    return extra;
}

async function locateEntryData(
    blob: Blob,
    entry: InspectedProjectBundleZipEntry,
): Promise<{ start: number; end: number }> {
    const fixed = new Uint8Array(
        await blob.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer(),
    );
    if (fixed.byteLength !== 30) throw new Error('Bundle local ZIP header is truncated.');
    const view = new DataView(fixed.buffer, fixed.byteOffset);
    if (view.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE
        || view.getUint16(6, true) !== entry.flags
        || view.getUint16(8, true) !== entry.compressionMethod) {
        throw new Error('Bundle local ZIP header conflicts with the central directory.');
    }
    const nameBytes = view.getUint16(26, true);
    const extraBytes = view.getUint16(28, true);
    if (30 + nameBytes + extraBytes > MAX_LOCAL_HEADER_BYTES) {
        throw new Error('Bundle local ZIP header exceeds its safe limit.');
    }
    const nameData = new Uint8Array(
        await blob.slice(
            entry.localHeaderOffset + 30,
            entry.localHeaderOffset + 30 + nameBytes,
        ).arrayBuffer(),
    );
    const localName = new TextDecoder('utf-8', { fatal: true }).decode(nameData);
    if (localName !== entry.name) {
        throw new Error('Bundle local ZIP path conflicts with the central directory.');
    }
    const start = checkedAdd(entry.localHeaderOffset, 30 + nameBytes + extraBytes);
    const end = checkedAdd(start, entry.compressedBytes);
    if (end > blob.size) throw new Error('Bundle ZIP entry extends beyond the archive.');
    return { start, end };
}

function assertEntryName(name: string): void {
    const bytes = new TextEncoder().encode(name);
    if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')
        || name.split('/').some(part => !part || part === '.' || part === '..')
        || bytes.byteLength > 1_024) {
        throw new Error('Project bundle entry path is unsafe.');
    }
}

function checkedAdd(left: number, right: number): number {
    const result = left + right;
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new Error('Project bundle exceeds the safe ZIP byte domain.');
    }
    return result;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Project bundle operation was cancelled.', 'AbortError');
}

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[index] = value >>> 0;
    }
    return table;
})();

function updateCrc32(previous: number, bytes: Uint8Array): number {
    let crc = (previous ^ 0xffff_ffff) >>> 0;
    for (let index = 0; index < bytes.byteLength; index += 1) {
        crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffff_ffff) >>> 0;
}
