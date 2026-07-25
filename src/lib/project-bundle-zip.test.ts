import { describe, expect, it } from 'vitest';
import {
    addBoundedZipEntryBytes,
    inspectProjectBundleZipBlob,
} from './project-bundle-zip';

describe('project bundle ZIP allocation policy', () => {
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

    it('rejects physical duplicate, Unicode-alias, traversal, and link entries', async () => {
        await expect(inspectProjectBundleZipBlob(createRawZip([
            { name: 'metadata.json' },
            { name: 'metadata.json' },
        ]), 8)).rejects.toThrow('duplicate');
        await expect(inspectProjectBundleZipBlob(createRawZip([
            { name: 'café.json' },
            { name: 'cafe\u0301.json' },
        ]), 8)).rejects.toThrow('Unicode');
        await expect(inspectProjectBundleZipBlob(createRawZip([
            { name: '../metadata.json' },
        ]), 8)).rejects.toThrow('unsafe path');
        await expect(inspectProjectBundleZipBlob(createRawZip([{
            name: 'metadata.json',
            externalAttributes: 0o120777 << 16,
        }]), 8)).rejects.toThrow('links and device');
    });

    it('rejects encryption, unknown flags, unsafe DOS metadata, and compression bombs', async () => {
        await expect(inspectProjectBundleZipBlob(createRawZip([{
            name: 'metadata.json',
            flags: 0x0001,
        }]), 8)).rejects.toThrow('unsupported or unsafe metadata');
        await expect(inspectProjectBundleZipBlob(createRawZip([{
            name: 'metadata.json',
            flags: 0x4000,
        }]), 8)).rejects.toThrow('unsupported or unsafe metadata');
        await expect(inspectProjectBundleZipBlob(createRawZip([{
            name: 'metadata.json',
            madeBy: 0x0014,
            externalAttributes: 0x0008,
        }]), 8)).rejects.toThrow('DOS attributes');
        await expect(inspectProjectBundleZipBlob(createRawZip([{
            name: 'metadata.json',
            compressionMethod: 8,
            compressedBytes: 1,
            uncompressedBytes: 10_000,
        }]), 8)).rejects.toThrow('compression-ratio');
    });
});

interface RawZipEntry {
    name: string;
    flags?: number;
    compressionMethod?: number;
    compressedBytes?: number;
    uncompressedBytes?: number;
    madeBy?: number;
    externalAttributes?: number;
}

function createRawZip(entries: readonly RawZipEntry[]): Blob {
    const localParts: Uint8Array[] = [];
    const centralParts: Uint8Array[] = [];
    let localOffset = 0;
    entries.forEach((entry) => {
        const name = new TextEncoder().encode(entry.name);
        const compressedBytes = entry.compressedBytes ?? 0;
        const uncompressedBytes = entry.uncompressedBytes ?? compressedBytes;
        const local = new Uint8Array(30 + name.byteLength + compressedBytes);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(6, entry.flags ?? 0x0800, true);
        localView.setUint16(8, entry.compressionMethod ?? 0, true);
        localView.setUint32(18, compressedBytes, true);
        localView.setUint32(22, uncompressedBytes, true);
        localView.setUint16(26, name.byteLength, true);
        local.set(name, 30);
        localParts.push(local);

        const central = new Uint8Array(46 + name.byteLength);
        const centralView = new DataView(central.buffer);
        centralView.setUint32(0, 0x02014b50, true);
        centralView.setUint16(4, entry.madeBy ?? 0x031e, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(8, entry.flags ?? 0x0800, true);
        centralView.setUint16(10, entry.compressionMethod ?? 0, true);
        centralView.setUint32(20, compressedBytes, true);
        centralView.setUint32(24, uncompressedBytes, true);
        centralView.setUint16(28, name.byteLength, true);
        centralView.setUint32(38, entry.externalAttributes ?? (0o100644 << 16), true);
        centralView.setUint32(42, localOffset, true);
        central.set(name, 46);
        centralParts.push(central);
        localOffset += local.byteLength;
    });
    const centralBytes = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, entries.length, true);
    eocdView.setUint16(10, entries.length, true);
    eocdView.setUint32(12, centralBytes, true);
    eocdView.setUint32(16, localOffset, true);
    return new Blob([...localParts, ...centralParts, eocd]);
}
