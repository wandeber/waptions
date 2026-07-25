import { createHash } from 'node:crypto';
import type { ManagedStreamingEntry } from './contracts';
import type { ManagedStreamingSink } from './streaming-output';
import { throwIfAborted } from './streaming-output';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;
const UTF8_DATA_DESCRIPTOR_FLAGS = 0x0808;
const MAX_ENTRIES = 4_096;

interface CentralEntry {
    readonly name: string;
    readonly nameBytes: Uint8Array;
    readonly crc32: number;
    readonly size: number;
    readonly localHeaderOffset: number;
    readonly digest: `sha256:${string}`;
}

/** Writes a deterministic stored ZIP/ZIP64 archive with one bounded source chunk in memory. */
export async function writeManagedPortableBundle(input: {
    readonly entries: readonly ManagedStreamingEntry[];
    readonly sink: ManagedStreamingSink;
    readonly signal?: AbortSignal;
    readonly onEntry?: (completed: number, total: number) => void;
}): Promise<readonly {
    readonly name: string;
    readonly digest: `sha256:${string}`;
    readonly byteLength: number;
}[]> {
    const entries = normalizeEntries(input.entries);
    const central: CentralEntry[] = [];
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        throwIfAborted(input.signal);
        await entry.revalidate(input.signal);
        const nameBytes = new TextEncoder().encode(entry.name);
        const localHeaderOffset = input.sink.bytesWritten;
        const zip64 = entry.byteLength >= UINT32_MAX;
        const localExtra = zip64
            ? zip64Extra([entry.byteLength, entry.byteLength])
            : new Uint8Array();
        const header = new Uint8Array(30 + nameBytes.byteLength + localExtra.byteLength);
        const view = new DataView(header.buffer);
        view.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
        view.setUint16(4, zip64 ? 45 : 20, true);
        view.setUint16(6, UTF8_DATA_DESCRIPTOR_FLAGS, true);
        view.setUint16(8, 0, true);
        view.setUint32(18, zip64 ? UINT32_MAX : entry.byteLength, true);
        view.setUint32(22, zip64 ? UINT32_MAX : entry.byteLength, true);
        view.setUint16(26, nameBytes.byteLength, true);
        view.setUint16(28, localExtra.byteLength, true);
        header.set(nameBytes, 30);
        header.set(localExtra, 30 + nameBytes.byteLength);
        await input.sink.write(header, input.signal);

        const hash = createHash('sha256');
        let crc32 = 0;
        let written = 0;
        for await (const chunk of entry.stream(input.signal)) {
            throwIfAborted(input.signal);
            if (!(chunk instanceof Uint8Array)
                || chunk.byteLength === 0
                || chunk.byteLength > 8 * 1024 * 1024
                || !Number.isSafeInteger(written + chunk.byteLength)
                || written + chunk.byteLength > entry.byteLength) {
                throw new RangeError('Portable bundle entry emitted an invalid chunk.');
            }
            await input.sink.write(chunk, input.signal);
            hash.update(chunk);
            crc32 = updateCrc32(crc32, chunk);
            written += chunk.byteLength;
        }
        if (written !== entry.byteLength) {
            throw new Error('Portable bundle entry length changed during export.');
        }
        const digest = `sha256:${hash.digest('hex')}` as const;
        if (entry.expectedDigest && digest !== entry.expectedDigest) {
            throw new Error('Portable bundle entry digest changed during export.');
        }
        await entry.revalidate(input.signal);
        const descriptor = new Uint8Array(zip64 ? 24 : 16);
        const descriptorView = new DataView(descriptor.buffer);
        descriptorView.setUint32(0, DATA_DESCRIPTOR_SIGNATURE, true);
        descriptorView.setUint32(4, crc32, true);
        if (zip64) {
            descriptorView.setBigUint64(8, BigInt(entry.byteLength), true);
            descriptorView.setBigUint64(16, BigInt(entry.byteLength), true);
        } else {
            descriptorView.setUint32(8, entry.byteLength, true);
            descriptorView.setUint32(12, entry.byteLength, true);
        }
        await input.sink.write(descriptor, input.signal);
        central.push({
            name: entry.name,
            nameBytes,
            crc32,
            size: entry.byteLength,
            localHeaderOffset,
            digest,
        });
        input.onEntry?.(index + 1, entries.length);
    }

    const centralOffset = input.sink.bytesWritten;
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
        view.setUint32(16, entry.crc32, true);
        view.setUint32(20, zip64Size ? UINT32_MAX : entry.size, true);
        view.setUint32(24, zip64Size ? UINT32_MAX : entry.size, true);
        view.setUint16(28, entry.nameBytes.byteLength, true);
        view.setUint16(30, extra.byteLength, true);
        view.setUint32(38, 0o100644 << 16, true);
        view.setUint32(42, zip64Offset ? UINT32_MAX : entry.localHeaderOffset, true);
        header.set(entry.nameBytes, 46);
        header.set(extra, 46 + entry.nameBytes.byteLength);
        await input.sink.write(header, input.signal);
    }
    const centralBytes = input.sink.bytesWritten - centralOffset;
    const requiresZip64 = central.length >= UINT16_MAX
        || centralOffset >= UINT32_MAX
        || centralBytes >= UINT32_MAX
        || central.some((entry) => (
            entry.size >= UINT32_MAX || entry.localHeaderOffset >= UINT32_MAX
        ));
    if (requiresZip64) {
        const zip64Offset = input.sink.bytesWritten;
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
        await input.sink.write(zip64, input.signal);
        const locator = new Uint8Array(20);
        const locatorView = new DataView(locator.buffer);
        locatorView.setUint32(0, ZIP64_LOCATOR_SIGNATURE, true);
        locatorView.setBigUint64(8, BigInt(zip64Offset), true);
        locatorView.setUint32(16, 1, true);
        await input.sink.write(locator, input.signal);
    }
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, EOCD_SIGNATURE, true);
    eocdView.setUint16(8, requiresZip64 ? UINT16_MAX : central.length, true);
    eocdView.setUint16(10, requiresZip64 ? UINT16_MAX : central.length, true);
    eocdView.setUint32(12, requiresZip64 ? UINT32_MAX : centralBytes, true);
    eocdView.setUint32(16, requiresZip64 ? UINT32_MAX : centralOffset, true);
    await input.sink.write(eocd, input.signal);
    return Object.freeze(central.map((entry) => Object.freeze({
        name: entry.name,
        digest: entry.digest,
        byteLength: entry.size,
    })));
}

function normalizeEntries(
    entries: readonly ManagedStreamingEntry[],
): readonly ManagedStreamingEntry[] {
    if (entries.length < 1 || entries.length > MAX_ENTRIES) {
        throw new RangeError(`Portable bundles require between 1 and ${MAX_ENTRIES} entries.`);
    }
    const sorted = [...entries].sort((left, right) => (
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ));
    if (new Set(sorted.map((entry) => entry.name)).size !== sorted.length) {
        throw new Error('Portable bundle entry names must be unique.');
    }
    const aliases = new Set<string>();
    for (const entry of sorted) {
        validateEntryName(entry.name);
        const alias = entry.name.normalize('NFKC').toLocaleLowerCase('und');
        if (entry.name !== entry.name.normalize('NFC') || aliases.has(alias)) {
            throw new Error('Portable bundle entry names contain a Unicode alias.');
        }
        aliases.add(alias);
        if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
            throw new RangeError('Portable bundle entry length is invalid.');
        }
    }
    if (!sorted.some((entry) => entry.name === 'metadata.json')) {
        throw new Error('Portable bundle requires metadata.json.');
    }
    return Object.freeze(sorted);
}

function validateEntryName(name: string): void {
    if (!name
        || name.length > 1_024
        || name.includes('\0')
        || name.includes('\\')
        || name.startsWith('/')
        || name.endsWith('/')
        || name.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error('Portable bundle entry name is unsafe.');
    }
}

function zip64Extra(values: readonly number[]): Uint8Array {
    const extra = new Uint8Array(4 + values.length * 8);
    const view = new DataView(extra.buffer);
    view.setUint16(0, 0x0001, true);
    view.setUint16(2, values.length * 8, true);
    values.forEach((value, index) => {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new RangeError('ZIP64 value is invalid.');
        }
        view.setBigUint64(4 + index * 8, BigInt(value), true);
    });
    return extra;
}

let crcTable: Uint32Array | undefined;

function updateCrc32(current: number, bytes: Uint8Array): number {
    const table = crcTable ??= createCrcTable();
    let crc = current ^ 0xffffffff;
    for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function createCrcTable(): Uint32Array {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) {
            value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
        }
        table[index] = value >>> 0;
    }
    return table;
}
