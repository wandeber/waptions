import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import {
    addBoundedZipEntryBytes,
    assertSafeProjectBundleEntries,
    assertZipEntryExactSize,
    getDeclaredZipEntrySize,
    readBoundedZipUtf8,
} from './project-bundle-zip';

const loadedEntry = (
    declaredBytes: number | undefined,
    bytes: Uint8Array,
): JSZip.JSZipObject => ({
    name: 'metadata.json',
    dir: false,
    date: new Date(0),
    comment: '',
    unixPermissions: null,
    dosPermissions: null,
    options: {},
    async: vi.fn(async () => bytes),
    nodeStream: vi.fn(),
    _data: declaredBytes === undefined ? {} : { uncompressedSize: declaredBytes },
} as unknown as JSZip.JSZipObject);

describe('project bundle bounded ZIP reader', () => {
    it('enforces per-entry and aggregate bounds without unsafe integer overflow', () => {
        expect(addBoundedZipEntryBytes(4, 5, 5, 10, 'sidecars')).toBe(9);
        expect(() => addBoundedZipEntryBytes(0, 6, 5, 10, 'sidecars')).toThrow('per-entry');
        expect(() => addBoundedZipEntryBytes(7, 4, 5, 10, 'sidecars')).toThrow('aggregate');
        expect(() => addBoundedZipEntryBytes(
            Number.MAX_SAFE_INTEGER,
            1,
            1,
            Number.MAX_SAFE_INTEGER,
            'sidecars',
        )).toThrow('aggregate');
    });

    it('rejects an oversized declaration before asking JSZip to decompress it', async () => {
        const entry = loadedEntry(11, new TextEncoder().encode('not reached'));

        await expect(readBoundedZipUtf8(entry, 10, 'test entry')).rejects.toThrow('exceeds');
        expect(entry.async).not.toHaveBeenCalled();
    });

    it('requires declared and actual sizes to agree and decodes UTF-8 fatally', async () => {
        const mismatched = loadedEntry(4, new TextEncoder().encode('three'));
        await expect(readBoundedZipUtf8(mismatched, 10, 'test entry')).rejects.toThrow('inconsistent');

        const invalidUtf8 = loadedEntry(2, new Uint8Array([0xc3, 0x28]));
        await expect(readBoundedZipUtf8(invalidUtf8, 10, 'test entry')).rejects.toThrow('UTF-8');

        const validBytes = new TextEncoder().encode('{"ok":true}');
        const valid = loadedEntry(validBytes.byteLength, validBytes);
        await expect(readBoundedZipUtf8(valid, validBytes.byteLength, 'test entry')).resolves.toEqual({
            bytes: validBytes,
            text: '{"ok":true}',
        });
    });

    it('fails closed when loaded size metadata is absent or a source size differs', () => {
        const missing = loadedEntry(undefined, new Uint8Array());
        expect(() => getDeclaredZipEntrySize(missing)).toThrow('size is unavailable');

        const source = loadedEntry(7, new Uint8Array(7));
        expect(() => assertZipEntryExactSize(source, 8, 'source')).toThrow('does not match');
        expect(() => assertZipEntryExactSize(source, 7, 'source')).not.toThrow();
    });

    it('rejects ZIP-slip names retained by JSZip and enforces an entry-count limit', async () => {
        const authored = new JSZip();
        authored.file('../metadata.json', '{}');
        const loaded = await JSZip.loadAsync(await authored.generateAsync({ type: 'uint8array' }));

        expect(() => assertSafeProjectBundleEntries(loaded, 10)).toThrow('unsafe path');

        const ordinary = new JSZip();
        ordinary.file('metadata.json', '{}');
        ordinary.file('extra.json', '{}');
        expect(() => assertSafeProjectBundleEntries(ordinary, 1)).toThrow('more than 1');
    });
});
