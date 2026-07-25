import type JSZip from 'jszip';

/**
 * JSZip intentionally keeps the central-directory sizes on a private loaded-entry field. The
 * public `async()` API otherwise allocates the complete uncompressed value before callers can
 * enforce a limit, which would let a small ZIP expand into an unbounded metadata or transcript
 * allocation. Keep this compatibility read isolated so a JSZip upgrade has one fail-closed
 * boundary to update.
 */
type LoadedZipEntry = JSZip.JSZipObject & {
    _data?: {
        uncompressedSize?: unknown;
    };
};

export interface BoundedZipUtf8Value {
    bytes: Uint8Array;
    text: string;
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

/** Rejects archive names that JSZip sanitized or that are not safe relative ZIP paths. */
export function assertSafeProjectBundleEntries(zip: JSZip, maximumEntries: number): void {
    const entries = Object.values(zip.files);
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
        throw new Error('Project bundle entry limit is invalid.');
    }
    if (entries.length > maximumEntries) {
        throw new Error(`Invalid .waptions file: archive contains more than ${maximumEntries} entries.`);
    }
    entries.forEach((entry) => {
        // JSZip removes `..` components while retaining the attacker-controlled original name.
        // Import must reject that rewrite instead of accidentally allowing a sanitized alias to
        // satisfy a trusted metadata declaration.
        if (entry.unsafeOriginalName !== undefined && entry.unsafeOriginalName !== entry.name) {
            throw new Error('Invalid .waptions file: archive contains an unsafe path.');
        }
        if (!isSafeRelativeArchivePath(entry.name, entry.dir)) {
            throw new Error('Invalid .waptions file: archive contains an unsafe path.');
        }
    });
}

/** Returns the trusted pre-decompression size declared by a loaded ZIP central directory. */
export function getDeclaredZipEntrySize(entry: JSZip.JSZipObject): number {
    const size = (entry as LoadedZipEntry)._data?.uncompressedSize;
    if (!Number.isSafeInteger(size) || (size as number) < 0) {
        // Freshly authored JSZip objects do not have this field, but every import entry has passed
        // through `loadAsync`. Missing size metadata at that boundary is therefore unsupported and
        // must fail closed rather than silently disabling the allocation guard.
        throw new Error('Invalid .waptions file: ZIP entry size is unavailable.');
    }
    return size as number;
}

/**
 * Checks a source Blob against its manifest size before decompression. Source media itself is not
 * capped because valid projects may contain multi-gigabyte files; the signed manifest descriptor
 * remains the exact allocation expectation and hydration verifies its immutable fingerprint.
 */
export function assertZipEntryExactSize(
    entry: JSZip.JSZipObject,
    expectedBytes: number,
    label: string,
): void {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
        throw new Error(`Invalid ${label}: expected byte size is invalid.`);
    }
    if (getDeclaredZipEntrySize(entry) !== expectedBytes) {
        throw new Error(`Invalid ${label}: ZIP byte size does not match its descriptor.`);
    }
}

/**
 * Reads bounded UTF-8 only after checking the central-directory size, then verifies the actual
 * decompressed byte count as a second line of defense. Fatal decoding prevents replacement
 * characters from changing the JSON value whose canonical bytes and hash are later verified.
 */
export async function readBoundedZipUtf8(
    entry: JSZip.JSZipObject,
    maximumBytes: number,
    label: string,
): Promise<BoundedZipUtf8Value> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
        throw new Error('Project bundle byte limit is invalid.');
    }
    const declaredBytes = getDeclaredZipEntrySize(entry);
    if (declaredBytes > maximumBytes) {
        throw new Error(`Invalid ${label}: exceeds the ${maximumBytes}-byte limit.`);
    }
    const bytes = await entry.async('uint8array');
    if (bytes.byteLength !== declaredBytes || bytes.byteLength > maximumBytes) {
        throw new Error(`Invalid ${label}: decompressed byte size is inconsistent.`);
    }
    try {
        return {
            bytes,
            text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        };
    } catch {
        throw new Error(`Invalid ${label}: content is not valid UTF-8.`);
    }
}

function isSafeRelativeArchivePath(path: string, directory: boolean): boolean {
    if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/')) return false;
    const normalized = directory && path.endsWith('/') ? path.slice(0, -1) : path;
    if (!normalized || (!directory && path.endsWith('/'))) return false;
    return normalized.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}
