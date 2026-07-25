const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_EOCD_MAX_SEARCH_BYTES = 65_557;
const ZIP_CENTRAL_DIRECTORY_MAX_BYTES = 16 * 1024 * 1024;
const ZIP_ENTRY_NAME_MAX_BYTES = 1_024;
const ZIP_ENTRY_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024 * 1024;
const ZIP_AGGREGATE_MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024 * 1024;
const ZIP_MAX_COMPRESSION_RATIO = 200;
const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;
const ZIP_UNIX_REGULAR_FILE = 0o100000;
const ZIP_UNIX_DIRECTORY = 0o040000;

export interface InspectedProjectBundleZipEntry {
    name: string;
    compressedBytes: number;
    uncompressedBytes: number;
    directory: boolean;
    compressionMethod: 0 | 8;
    flags: number;
    crc32: number;
    localHeaderOffset: number;
}

/**
 * Inspects raw central-directory entries before JSZip collapses duplicate names or inflates data.
 *
 * Only the bounded EOCD tail and bounded central directory enter memory. Encrypted/multi-disk
 * archives, unsafe file types, bombs, and Unicode aliases fail closed.
 */
export async function inspectProjectBundleZipBlob(
    blob: Blob,
    maximumEntries: number,
): Promise<InspectedProjectBundleZipEntry[]> {
    if (!blob || typeof blob.size !== 'number' || typeof blob.slice !== 'function'
        || !Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
        throw new Error('Invalid .waptions file: ZIP input policy is invalid.');
    }
    const tailOffset = Math.max(0, blob.size - ZIP_EOCD_MAX_SEARCH_BYTES);
    const tail = new Uint8Array(await blob.slice(tailOffset).arrayBuffer());
    const eocdOffset = findEocdOffset(tail);
    if (eocdOffset < 0) throw new Error('Invalid .waptions file: ZIP end record is missing.');
    const eocd = new DataView(tail.buffer, tail.byteOffset + eocdOffset);
    const diskNumber = eocd.getUint16(4, true);
    const centralDisk = eocd.getUint16(6, true);
    let diskEntries = eocd.getUint16(8, true);
    let totalEntries = eocd.getUint16(10, true);
    let centralBytes = eocd.getUint32(12, true);
    let centralOffset = eocd.getUint32(16, true);
    const commentBytes = eocd.getUint16(20, true);
    if (eocdOffset + ZIP_EOCD_MIN_BYTES + commentBytes !== tail.byteLength
        || diskNumber !== 0
        || centralDisk !== 0
        || diskEntries !== totalEntries) {
        throw new Error('Invalid .waptions file: multi-disk or trailing ZIP data is unsupported.');
    }
    if (totalEntries === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) {
        if (eocdOffset < 20) {
            throw new Error('Invalid .waptions file: ZIP64 locator is missing.');
        }
        const locator = new DataView(tail.buffer, tail.byteOffset + eocdOffset - 20, 20);
        if (locator.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE
            || locator.getUint32(4, true) !== 0
            || locator.getUint32(16, true) !== 1) {
            throw new Error('Invalid .waptions file: ZIP64 locator is malformed.');
        }
        const zip64Offset = safeBigIntNumber(locator.getBigUint64(8, true), 'ZIP64 directory offset');
        const zip64Bytes = new Uint8Array(await blob.slice(zip64Offset, zip64Offset + 56).arrayBuffer());
        if (zip64Bytes.byteLength !== 56) {
            throw new Error('Invalid .waptions file: ZIP64 end record is truncated.');
        }
        const zip64 = new DataView(zip64Bytes.buffer, zip64Bytes.byteOffset);
        if (zip64.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE
            || zip64.getBigUint64(4, true) !== BigInt(44)
            || zip64.getUint32(16, true) !== 0
            || zip64.getUint32(20, true) !== 0) {
            throw new Error('Invalid .waptions file: ZIP64 end record is malformed.');
        }
        diskEntries = safeBigIntNumber(zip64.getBigUint64(24, true), 'ZIP64 disk entry count');
        totalEntries = safeBigIntNumber(zip64.getBigUint64(32, true), 'ZIP64 entry count');
        centralBytes = safeBigIntNumber(zip64.getBigUint64(40, true), 'ZIP64 central size');
        centralOffset = safeBigIntNumber(zip64.getBigUint64(48, true), 'ZIP64 central offset');
        if (diskEntries !== totalEntries) {
            throw new Error('Invalid .waptions file: multi-disk ZIP64 is unsupported.');
        }
    }
    if (totalEntries > maximumEntries || centralBytes > ZIP_CENTRAL_DIRECTORY_MAX_BYTES
        || centralOffset + centralBytes > blob.size) {
        throw new Error('Invalid .waptions file: ZIP directory exceeds its safe limits.');
    }
    const central = new Uint8Array(
        await blob.slice(centralOffset, centralOffset + centralBytes).arrayBuffer(),
    );
    const entries: InspectedProjectBundleZipEntry[] = [];
    const names = new Set<string>();
    const normalizedNames = new Set<string>();
    let offset = 0;
    let aggregateBytes = 0;
    while (offset < central.byteLength) {
        if (entries.length >= totalEntries || offset + 46 > central.byteLength) {
            throw new Error('Invalid .waptions file: ZIP directory is truncated.');
        }
        const view = new DataView(central.buffer, central.byteOffset + offset);
        if (view.getUint32(0, true) !== ZIP_CENTRAL_ENTRY_SIGNATURE) {
            throw new Error('Invalid .waptions file: ZIP directory entry is malformed.');
        }
        const madeBy = view.getUint16(4, true);
        const flags = view.getUint16(8, true);
        const compression = view.getUint16(10, true);
        let compressedBytes = view.getUint32(20, true);
        let uncompressedBytes = view.getUint32(24, true);
        const nameBytes = view.getUint16(28, true);
        const extraBytes = view.getUint16(30, true);
        const entryCommentBytes = view.getUint16(32, true);
        const diskStart = view.getUint16(34, true);
        const externalAttributes = view.getUint32(38, true);
        let localHeaderOffset = view.getUint32(42, true);
        const entryBytes = 46 + nameBytes + extraBytes + entryCommentBytes;
        const allowedFlags = compression === 8 ? 0x080e : 0x0808;
        if (nameBytes === 0 || nameBytes > ZIP_ENTRY_NAME_MAX_BYTES
            || offset + entryBytes > central.byteLength
            || diskStart !== 0
            || (flags & 0x1) !== 0
            || (flags & ~allowedFlags) !== 0
            || (compression !== 0 && compression !== 8)
        ) {
            throw new Error('Invalid .waptions file: ZIP entry uses unsupported or unsafe metadata.');
        }
        const nameData = central.subarray(offset + 46, offset + 46 + nameBytes);
        let name: string;
        try {
            name = new TextDecoder('utf-8', {
                fatal: true,
            }).decode(nameData);
        } catch {
            throw new Error('Invalid .waptions file: ZIP entry name is not valid UTF-8.');
        }
        const directory = name.endsWith('/');
        if (compressedBytes === 0xffffffff
            || uncompressedBytes === 0xffffffff
            || localHeaderOffset === 0xffffffff) {
            const extra = central.subarray(
                offset + 46 + nameBytes,
                offset + 46 + nameBytes + extraBytes,
            );
            const zip64 = readZip64EntryValues(extra, {
                uncompressed: uncompressedBytes === 0xffffffff,
                compressed: compressedBytes === 0xffffffff,
                offset: localHeaderOffset === 0xffffffff,
            });
            if (uncompressedBytes === 0xffffffff) uncompressedBytes = zip64.uncompressed;
            if (compressedBytes === 0xffffffff) compressedBytes = zip64.compressed;
            if (localHeaderOffset === 0xffffffff) localHeaderOffset = zip64.offset;
        }
        if (!isSafeRelativeArchivePath(name, directory)) {
            throw new Error('Invalid .waptions file: archive contains an unsafe path.');
        }
        const normalizedName = name.normalize('NFKC').toLocaleLowerCase('und');
        if (name !== name.normalize('NFC')
            || names.has(name)
            || normalizedNames.has(normalizedName)) {
            throw new Error('Invalid .waptions file: archive contains duplicate or Unicode-conflicting paths.');
        }
        names.add(name);
        normalizedNames.add(normalizedName);
        assertSafeZipFileType(madeBy, externalAttributes, directory);
        if (uncompressedBytes > ZIP_ENTRY_MAX_UNCOMPRESSED_BYTES) {
            throw new Error('Invalid .waptions file: ZIP entry exceeds the uncompressed byte limit.');
        }
        aggregateBytes += uncompressedBytes;
        if (!Number.isSafeInteger(aggregateBytes)
            || aggregateBytes > ZIP_AGGREGATE_MAX_UNCOMPRESSED_BYTES) {
            throw new Error('Invalid .waptions file: ZIP aggregate exceeds the uncompressed byte limit.');
        }
        if (uncompressedBytes > 1024
            && (compressedBytes === 0 || uncompressedBytes / compressedBytes > ZIP_MAX_COMPRESSION_RATIO)) {
            throw new Error('Invalid .waptions file: ZIP entry exceeds the compression-ratio limit.');
        }
        entries.push({
            name,
            compressedBytes,
            uncompressedBytes,
            directory,
            compressionMethod: compression,
            flags,
            crc32: view.getUint32(16, true),
            localHeaderOffset,
        });
        offset += entryBytes;
    }
    if (offset !== central.byteLength || entries.length !== totalEntries) {
        throw new Error('Invalid .waptions file: ZIP entry count is inconsistent.');
    }
    return entries;
}

function readZip64EntryValues(
    extra: Uint8Array,
    requested: { uncompressed: boolean; compressed: boolean; offset: boolean },
): { uncompressed: number; compressed: number; offset: number } {
    let cursor = 0;
    while (cursor + 4 <= extra.byteLength) {
        const view = new DataView(extra.buffer, extra.byteOffset + cursor);
        const id = view.getUint16(0, true);
        const size = view.getUint16(2, true);
        if (cursor + 4 + size > extra.byteLength) break;
        if (id === 0x0001) {
            const values = new DataView(extra.buffer, extra.byteOffset + cursor + 4, size);
            let valueOffset = 0;
            const read = (needed: boolean, label: string): number => {
                if (!needed) return 0;
                if (valueOffset + 8 > values.byteLength) {
                    throw new Error('Invalid .waptions file: ZIP64 entry extra is truncated.');
                }
                const value = safeBigIntNumber(values.getBigUint64(valueOffset, true), label);
                valueOffset += 8;
                return value;
            };
            return {
                uncompressed: read(requested.uncompressed, 'ZIP64 entry size'),
                compressed: read(requested.compressed, 'ZIP64 compressed size'),
                offset: read(requested.offset, 'ZIP64 local offset'),
            };
        }
        cursor += 4 + size;
    }
    throw new Error('Invalid .waptions file: ZIP64 entry extra is missing.');
}

function safeBigIntNumber(value: bigint, label: string): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`Invalid .waptions file: ${label} exceeds the safe integer domain.`);
    }
    return Number(value);
}

/** Applies independent per-entry and running aggregate allocation limits with safe arithmetic. */
export function addBoundedZipEntryBytes(
    aggregateBytes: number,
    entryBytes: number,
    maximumEntryBytes: number,
    maximumAggregateBytes: number,
    label: string,
): number {
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes < 0
        || !Number.isSafeInteger(entryBytes) || entryBytes < 0
        || !Number.isSafeInteger(maximumEntryBytes) || maximumEntryBytes <= 0
        || !Number.isSafeInteger(maximumAggregateBytes) || maximumAggregateBytes <= 0) {
        throw new Error(`Invalid ${label}: byte bounds are invalid.`);
    }
    if (entryBytes > maximumEntryBytes) {
        throw new Error(`Invalid ${label}: exceeds the per-entry byte limit.`);
    }
    const next = aggregateBytes + entryBytes;
    if (!Number.isSafeInteger(next) || next > maximumAggregateBytes) {
        throw new Error(`Invalid ${label}: exceeds the aggregate byte limit.`);
    }
    return next;
}

function isSafeRelativeArchivePath(path: string, directory: boolean): boolean {
    if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/')) return false;
    const normalized = directory && path.endsWith('/') ? path.slice(0, -1) : path;
    if (!normalized || (!directory && path.endsWith('/'))) return false;
    return normalized.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function findEocdOffset(bytes: Uint8Array): number {
    for (let offset = bytes.byteLength - ZIP_EOCD_MIN_BYTES; offset >= 0; offset -= 1) {
        if (new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true)
            === ZIP_EOCD_SIGNATURE) {
            return offset;
        }
    }
    return -1;
}

function assertSafeZipFileType(
    versionMadeBy: number,
    externalAttributes: number,
    directory: boolean,
): void {
    const platform = versionMadeBy >>> 8;
    if (platform !== 3) {
        const dosAttributes = externalAttributes & 0xffff;
        const allowedDosAttributes = 0x37;
        if ((dosAttributes & ~allowedDosAttributes) !== 0
            || directory !== ((dosAttributes & 0x10) !== 0)) {
            throw new Error('Invalid .waptions file: ZIP DOS attributes are unsafe.');
        }
        return;
    }
    const mode = externalAttributes >>> 16;
    const fileType = mode & ZIP_UNIX_FILE_TYPE_MASK;
    if (fileType !== 0
        && fileType !== ZIP_UNIX_REGULAR_FILE
        && fileType !== ZIP_UNIX_DIRECTORY) {
        throw new Error('Invalid .waptions file: ZIP links and device entries are forbidden.');
    }
    if (directory !== (fileType === ZIP_UNIX_DIRECTORY || (mode === 0 && directory))) {
        throw new Error('Invalid .waptions file: ZIP directory attributes are inconsistent.');
    }
}
