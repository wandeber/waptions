import { createHash } from 'node:crypto';
import type {
    ManagedProjectImportLimits,
    ManagedProjectImportReadLease,
} from './contracts';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD_MIN_BYTES = 22;
const EOCD_SEARCH_BYTES = 65_557;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

interface InternalEntry {
    readonly name: string;
    readonly crc32: number;
    readonly byteLength: number;
    readonly compressedBytes: number;
    readonly localHeaderOffset: number;
    readonly dataOffset: number;
    readonly descriptorOffset: number;
    readonly descriptorBytes: number;
}

export interface ManagedZipEntry {
    readonly name: string;
    readonly byteLength: number;
}

/**
 * Strict stored-ZIP reader for portable bundles. Deflated ZIP is deliberately not admitted: the
 * portable writer uses stored records, and refusing a second decompression implementation removes
 * an entire zip-bomb and allocator attack surface from the managed runtime.
 */
export class ManagedProjectImportZip {
    private constructor(
        private readonly lease: ManagedProjectImportReadLease,
        private readonly limits: ManagedProjectImportLimits,
        private readonly entriesByName: ReadonlyMap<string, InternalEntry>,
    ) {}

    static async open(
        lease: ManagedProjectImportReadLease,
        limits: ManagedProjectImportLimits,
        signal?: AbortSignal,
    ): Promise<ManagedProjectImportZip> {
        throwIfAborted(signal);
        validateLimits(limits);
        if (!Number.isSafeInteger(lease.byteLength) || lease.byteLength < EOCD_MIN_BYTES
            || lease.byteLength > limits.maximumArchiveBytes) {
            throw new Error('Managed project bundle exceeds its archive byte limit.');
        }
        await lease.assertCurrent(signal);
        const tailOffset = Math.max(0, lease.byteLength - EOCD_SEARCH_BYTES);
        const tail = await readRange(lease, tailOffset, lease.byteLength - tailOffset, limits, signal);
        const eocdOffset = findEocd(tail);
        if (eocdOffset < 0) throw new Error('Managed project bundle has no ZIP end record.');
        const eocd = viewAt(tail, eocdOffset, EOCD_MIN_BYTES, 'ZIP end record');
        if (eocd.getUint16(4, true) !== 0 || eocd.getUint16(6, true) !== 0) {
            throw new Error('Managed project bundle does not support multi-disk ZIP.');
        }
        const commentBytes = eocd.getUint16(20, true);
        if (eocdOffset + EOCD_MIN_BYTES + commentBytes !== tail.byteLength) {
            throw new Error('Managed project bundle has trailing ZIP data.');
        }

        let diskEntries = eocd.getUint16(8, true);
        let totalEntries = eocd.getUint16(10, true);
        let centralBytes = eocd.getUint32(12, true);
        let centralOffset = eocd.getUint32(16, true);
        if (diskEntries === UINT16_MAX || totalEntries === UINT16_MAX
            || centralBytes === UINT32_MAX || centralOffset === UINT32_MAX) {
            const zip64 = await readZip64End(lease, tail, eocdOffset, tailOffset, limits, signal);
            diskEntries = zip64.diskEntries;
            totalEntries = zip64.totalEntries;
            centralBytes = zip64.centralBytes;
            centralOffset = zip64.centralOffset;
        }
        if (diskEntries !== totalEntries || totalEntries < 1 || totalEntries > limits.maximumEntries
            || centralBytes > limits.maximumCentralDirectoryBytes
            || !safeRange(centralOffset, centralBytes, lease.byteLength)) {
            throw new Error('Managed project bundle ZIP directory exceeds its safe limits.');
        }
        const central = await readRange(lease, centralOffset, centralBytes, limits, signal);
        const entries = parseCentralDirectory(central, totalEntries, centralOffset, limits);
        await locateAndValidateEntries(lease, entries, centralOffset, limits, signal);
        await lease.assertCurrent(signal);
        return new ManagedProjectImportZip(lease, limits, new Map(entries.map((entry) => [entry.name, entry])));
    }

    entries(): readonly ManagedZipEntry[] {
        const entries = Array.from(this.entriesByName.values(), (entry): ManagedZipEntry => Object.freeze({
            name: entry.name,
            byteLength: entry.byteLength,
        }));
        entries.sort((left, right) => left.name.localeCompare(right.name));
        return Object.freeze(entries);
    }

    has(name: string): boolean {
        return this.entriesByName.has(name);
    }

    entrySize(name: string): number {
        return this.require(name).byteLength;
    }

    async readBytes(name: string, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
        const entry = this.require(name);
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || entry.byteLength > maximumBytes) {
            throw new Error('Managed project bundle entry exceeds its bounded read limit.');
        }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for await (const chunk of this.stream(name, signal)) {
            bytes += chunk.byteLength;
            chunks.push(chunk);
        }
        const output = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return output;
    }

    async *stream(name: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
        const entry = this.require(name);
        await this.lease.assertCurrent(signal);
        const hash = createHash('sha256');
        let crc32 = 0;
        let offset = 0;
        while (offset < entry.byteLength) {
            throwIfAborted(signal);
            const length = Math.min(this.limits.maximumReadChunkBytes, entry.byteLength - offset);
            const chunk = await readRange(
                this.lease,
                entry.dataOffset + offset,
                length,
                this.limits,
                signal,
            );
            crc32 = updateCrc32(crc32, chunk);
            hash.update(chunk);
            offset += chunk.byteLength;
            yield chunk;
        }
        const descriptor = await readRange(
            this.lease,
            entry.descriptorOffset,
            entry.descriptorBytes,
            this.limits,
            signal,
        );
        verifyDescriptor(descriptor, entry, crc32);
        await this.lease.assertCurrent(signal);
        // Keep the digest operation in the streaming path even for an entry without a declaration:
        // it guarantees all bytes reached the hash/CRC boundary before the stream succeeds.
        hash.digest('hex');
    }

    async digest(name: string, signal?: AbortSignal): Promise<`sha256:${string}`> {
        const hash = createHash('sha256');
        for await (const chunk of this.stream(name, signal)) hash.update(chunk);
        return `sha256:${hash.digest('hex')}`;
    }

    private require(name: string): InternalEntry {
        const entry = this.entriesByName.get(name);
        if (!entry) throw new Error('Managed project bundle is missing a declared entry.');
        return entry;
    }
}

async function readZip64End(
    lease: ManagedProjectImportReadLease,
    tail: Uint8Array,
    eocdOffset: number,
    tailOffset: number,
    limits: ManagedProjectImportLimits,
    signal?: AbortSignal,
): Promise<{ diskEntries: number; totalEntries: number; centralBytes: number; centralOffset: number }> {
    if (eocdOffset < 20) throw new Error('Managed project bundle ZIP64 locator is missing.');
    const locator = viewAt(tail, eocdOffset - 20, 20, 'ZIP64 locator');
    if (locator.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE
        || locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) !== 1) {
        throw new Error('Managed project bundle ZIP64 locator is malformed.');
    }
    const zip64Offset = safeBigIntNumber(locator.getBigUint64(8, true), 'ZIP64 end offset');
    if (zip64Offset + 56 > lease.byteLength || zip64Offset >= tailOffset + eocdOffset) {
        throw new Error('Managed project bundle ZIP64 end record is outside the archive.');
    }
    const bytes = await readRange(lease, zip64Offset, 56, limits, signal);
    const zip64 = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (zip64.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE
        || zip64.getBigUint64(4, true) !== BigInt(44)
        || zip64.getUint32(16, true) !== 0 || zip64.getUint32(20, true) !== 0) {
        throw new Error('Managed project bundle ZIP64 end record is malformed.');
    }
    return {
        diskEntries: safeBigIntNumber(zip64.getBigUint64(24, true), 'ZIP64 disk entries'),
        totalEntries: safeBigIntNumber(zip64.getBigUint64(32, true), 'ZIP64 total entries'),
        centralBytes: safeBigIntNumber(zip64.getBigUint64(40, true), 'ZIP64 central bytes'),
        centralOffset: safeBigIntNumber(zip64.getBigUint64(48, true), 'ZIP64 central offset'),
    };
}

function parseCentralDirectory(
    bytes: Uint8Array,
    totalEntries: number,
    centralOffset: number,
    limits: ManagedProjectImportLimits,
): InternalEntry[] {
    const names = new Set<string>();
    const aliases = new Set<string>();
    const entries: InternalEntry[] = [];
    let aggregateBytes = 0;
    let offset = 0;
    while (offset < bytes.byteLength) {
        if (entries.length >= totalEntries || offset + 46 > bytes.byteLength) {
            throw new Error('Managed project bundle ZIP directory is truncated.');
        }
        const view = viewAt(bytes, offset, 46, 'ZIP directory entry');
        if (view.getUint32(0, true) !== CENTRAL_HEADER_SIGNATURE) {
            throw new Error('Managed project bundle ZIP directory is malformed.');
        }
        const flags = view.getUint16(8, true);
        const method = view.getUint16(10, true);
        let compressedBytes = view.getUint32(20, true);
        let byteLength = view.getUint32(24, true);
        const nameBytes = view.getUint16(28, true);
        const extraBytes = view.getUint16(30, true);
        const commentBytes = view.getUint16(32, true);
        const diskStart = view.getUint16(34, true);
        let localHeaderOffset = view.getUint32(42, true);
        const total = 46 + nameBytes + extraBytes + commentBytes;
        if (nameBytes === 0 || nameBytes > 1_024 || offset + total > bytes.byteLength
            || diskStart !== 0 || (flags & 0x1) !== 0 || (flags & ~0x0808) !== 0
            || method !== 0) {
            throw new Error('Managed project bundle uses unsupported or unsafe ZIP metadata.');
        }
        const name = decodeName(bytes.subarray(offset + 46, offset + 46 + nameBytes));
        if (!safeArchivePath(name)) throw new Error('Managed project bundle contains an unsafe path.');
        const alias = name.normalize('NFKC').toLocaleLowerCase('und');
        if (name !== name.normalize('NFC') || names.has(name) || aliases.has(alias)) {
            throw new Error('Managed project bundle contains duplicate or Unicode-conflicting paths.');
        }
        names.add(name);
        aliases.add(alias);
        const extra = bytes.subarray(offset + 46 + nameBytes, offset + 46 + nameBytes + extraBytes);
        if (compressedBytes === UINT32_MAX || byteLength === UINT32_MAX || localHeaderOffset === UINT32_MAX) {
            const zip64 = readZip64Extra(extra, {
                compressed: compressedBytes === UINT32_MAX,
                uncompressed: byteLength === UINT32_MAX,
                offset: localHeaderOffset === UINT32_MAX,
            });
            if (compressedBytes === UINT32_MAX) compressedBytes = zip64.compressed;
            if (byteLength === UINT32_MAX) byteLength = zip64.uncompressed;
            if (localHeaderOffset === UINT32_MAX) localHeaderOffset = zip64.offset;
        }
        if (compressedBytes !== byteLength || byteLength > limits.maximumEntryBytes
            || !safeRange(localHeaderOffset, 30, centralOffset)) {
            throw new Error('Managed project bundle ZIP entry is outside its safe limits.');
        }
        aggregateBytes = checkedAdd(aggregateBytes, byteLength, limits.maximumAggregateBytes);
        entries.push({
            name,
            crc32: view.getUint32(16, true),
            byteLength,
            compressedBytes,
            localHeaderOffset,
            dataOffset: -1,
            descriptorOffset: -1,
            descriptorBytes: byteLength >= UINT32_MAX ? 24 : 16,
        });
        offset += total;
    }
    if (offset !== bytes.byteLength || entries.length !== totalEntries) {
        throw new Error('Managed project bundle ZIP directory count is inconsistent.');
    }
    return entries;
}

async function locateAndValidateEntries(
    lease: ManagedProjectImportReadLease,
    entries: InternalEntry[],
    centralOffset: number,
    limits: ManagedProjectImportLimits,
    signal?: AbortSignal,
): Promise<void> {
    const ranges: Array<{ start: number; end: number; name: string }> = [];
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]!;
        const header = await readRange(lease, entry.localHeaderOffset, 30, limits, signal);
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        if (view.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE
            || view.getUint16(6, true) !== 0x0808 || view.getUint16(8, true) !== 0) {
            throw new Error('Managed project bundle local ZIP header is malformed.');
        }
        const nameBytes = view.getUint16(26, true);
        const extraBytes = view.getUint16(28, true);
        const nameAndExtra = await readRange(lease, entry.localHeaderOffset + 30, nameBytes + extraBytes, limits, signal);
        if (decodeName(nameAndExtra.subarray(0, nameBytes)) !== entry.name) {
            throw new Error('Managed project bundle ZIP headers disagree on an entry name.');
        }
        const dataOffset = checkedAdd(entry.localHeaderOffset, 30 + nameBytes + extraBytes, centralOffset);
        const descriptorOffset = checkedAdd(dataOffset, entry.compressedBytes, centralOffset);
        const end = checkedAdd(descriptorOffset, entry.descriptorBytes, centralOffset);
        entries[index] = Object.freeze({ ...entry, dataOffset, descriptorOffset });
        ranges.push({ start: entry.localHeaderOffset, end, name: entry.name });
    }
    ranges.sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < ranges.length; index += 1) {
        if (ranges[index - 1]!.end > ranges[index]!.start) {
            throw new Error('Managed project bundle ZIP entries overlap physically.');
        }
    }
}

function verifyDescriptor(bytes: Uint8Array, entry: InternalEntry, crc32: number): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== DATA_DESCRIPTOR_SIGNATURE || view.getUint32(4, true) !== crc32) {
        throw new Error('Managed project bundle entry checksum is corrupt.');
    }
    if (entry.descriptorBytes === 24) {
        if (safeBigIntNumber(view.getBigUint64(8, true), 'ZIP64 data descriptor size') !== entry.byteLength
            || safeBigIntNumber(view.getBigUint64(16, true), 'ZIP64 data descriptor size') !== entry.byteLength) {
            throw new Error('Managed project bundle ZIP64 data descriptor is corrupt.');
        }
    } else if (view.getUint32(8, true) !== entry.byteLength || view.getUint32(12, true) !== entry.byteLength) {
        throw new Error('Managed project bundle data descriptor is corrupt.');
    }
}

async function readRange(
    lease: ManagedProjectImportReadLease,
    position: number,
    length: number,
    limits: ManagedProjectImportLimits,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    if (!safeRange(position, length, lease.byteLength)) {
        throw new Error('Managed project bundle attempted an out-of-bounds read.');
    }
    const chunks: Uint8Array[] = [];
    let remaining = length;
    let cursor = position;
    while (remaining > 0) {
        throwIfAborted(signal);
        const requested = Math.min(remaining, limits.maximumReadChunkBytes);
        const chunk = await lease.read(cursor, requested, signal);
        if (!(chunk instanceof Uint8Array) || chunk.byteLength !== requested) {
            throw new Error('Managed project bundle source returned an incomplete read.');
        }
        chunks.push(chunk);
        cursor += requested;
        remaining -= requested;
    }
    if (chunks.length === 1) return chunks[0]!;
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

function findEocd(tail: Uint8Array): number {
    for (let offset = tail.byteLength - EOCD_MIN_BYTES; offset >= 0; offset -= 1) {
        if (new DataView(tail.buffer, tail.byteOffset + offset, 4).getUint32(0, true) === EOCD_SIGNATURE) {
            return offset;
        }
    }
    return -1;
}

function readZip64Extra(
    bytes: Uint8Array,
    requested: { compressed: boolean; uncompressed: boolean; offset: boolean },
): { compressed: number; uncompressed: number; offset: number } {
    let cursor = 0;
    while (cursor + 4 <= bytes.byteLength) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 4);
        const id = view.getUint16(0, true);
        const length = view.getUint16(2, true);
        if (cursor + 4 + length > bytes.byteLength) break;
        if (id === 0x0001) {
            const values = new DataView(bytes.buffer, bytes.byteOffset + cursor + 4, length);
            let offset = 0;
            const take = (needed: boolean, label: string) => {
                if (!needed) return 0;
                if (offset + 8 > values.byteLength) throw new Error(`Managed project bundle ${label} is truncated.`);
                const value = safeBigIntNumber(values.getBigUint64(offset, true), label);
                offset += 8;
                return value;
            };
            return {
                uncompressed: take(requested.uncompressed, 'ZIP64 entry size'),
                compressed: take(requested.compressed, 'ZIP64 compressed size'),
                offset: take(requested.offset, 'ZIP64 local offset'),
            };
        }
        cursor += 4 + length;
    }
    throw new Error('Managed project bundle ZIP64 entry metadata is missing.');
}

function decodeName(bytes: Uint8Array): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new Error('Managed project bundle ZIP entry name is not valid UTF-8.');
    }
}

function safeArchivePath(name: string): boolean {
    return Boolean(name) && !name.includes('\0') && !name.includes('\\') && !name.startsWith('/')
        && !name.endsWith('/') && name.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function viewAt(bytes: Uint8Array, offset: number, length: number, label: string): DataView {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.byteLength) {
        throw new Error(`Managed project bundle ${label} is truncated.`);
    }
    return new DataView(bytes.buffer, bytes.byteOffset + offset, length);
}

function safeBigIntNumber(value: bigint, label: string): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Managed project bundle ${label} is too large.`);
    return Number(value);
}

function safeRange(offset: number, length: number, total: number): boolean {
    return Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length >= 0
        && Number.isSafeInteger(total) && total >= 0 && offset <= total && length <= total - offset;
}

function checkedAdd(left: number, right: number, maximum: number): number {
    const result = left + right;
    if (!Number.isSafeInteger(result) || result > maximum) {
        throw new Error('Managed project bundle exceeds its safe byte bounds.');
    }
    return result;
}

function validateLimits(limits: ManagedProjectImportLimits): void {
    for (const value of Object.values(limits)) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Managed project import limits are invalid.');
    }
    if (limits.maximumReadChunkBytes > 8 * 1024 * 1024) {
        throw new RangeError('Managed project import chunk limit is too large.');
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

let crcTable: Uint32Array | undefined;

function updateCrc32(current: number, bytes: Uint8Array): number {
    const table = crcTable ??= createCrcTable();
    let crc = current ^ 0xffff_ffff;
    for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    return (crc ^ 0xffff_ffff) >>> 0;
}

function createCrcTable(): Uint32Array {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb8_8320 : 0);
        table[index] = value >>> 0;
    }
    return table;
}
