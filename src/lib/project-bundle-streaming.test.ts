import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import {
    createBoundedMemoryZipSink,
    openRangeBackedProjectBundleArchive,
    writeStoredProjectBundleZip,
    type ProjectBundleZipSink,
} from './project-bundle-streaming';

describe('streaming project bundle ZIP', () => {
    it('writes interoperable stored entries without one archive-sized source read', async () => {
        const memory = createBoundedMemoryZipSink();
        await writeStoredProjectBundleZip({
            entries: [{
                name: 'metadata.json',
                data: new Blob(['{"version":"4.0"}']),
            }, {
                name: 'sources/video/source.mp4',
                data: new Blob([new Uint8Array(5 * 1024 * 1024)]),
            }],
            sink: memory.sink,
        });

        const zip = await JSZip.loadAsync(await memory.toBlob().arrayBuffer(), {
            checkCRC32: true,
        });
        expect(await zip.file('metadata.json')?.async('text')).toBe('{"version":"4.0"}');
        expect((await zip.file('sources/video/source.mp4')?.async('uint8array'))?.byteLength)
            .toBe(5 * 1024 * 1024);
    });

    it('aborts the destination and stops publication when cancellation is observed', async () => {
        const controller = new AbortController();
        const abort = vi.fn(async () => undefined);
        const close = vi.fn(async () => undefined);
        const sink: ProjectBundleZipSink = {
            write: vi.fn(async () => {
                controller.abort();
            }),
            close,
            abort,
        };

        await expect(writeStoredProjectBundleZip({
            entries: [{ name: 'metadata.json', data: new Blob(['{}']) }],
            sink,
            signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(abort).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
    });

    it('aborts when a source stream disagrees with its declared size', async () => {
        const abort = vi.fn(async () => undefined);
        const sink: ProjectBundleZipSink = {
            write: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
            abort,
        };
        const inconsistent = {
            size: 1,
            stream: () => new Blob([new Uint8Array([1, 2])]).stream(),
        } as unknown as Blob;

        await expect(writeStoredProjectBundleZip({
            entries: [{ name: 'source.bin', data: inconsistent }],
            sink,
        })).rejects.toThrow('exceeds its declared byte size');
        expect(abort).toHaveBeenCalledOnce();
        expect(sink.close).not.toHaveBeenCalled();
    });

    it('cancels range-backed reads without materializing the entry', async () => {
        const memory = createBoundedMemoryZipSink();
        await writeStoredProjectBundleZip({
            entries: [{ name: 'metadata.json', data: new Blob(['{}']) }],
            sink: memory.sink,
        });
        const controller = new AbortController();
        const archive = await openRangeBackedProjectBundleArchive(
            memory.toBlob(),
            8,
            controller.signal,
        );
        controller.abort();

        await expect(archive.get('metadata.json')?.readBytes(64))
            .rejects.toMatchObject({ name: 'AbortError' });
    });

    it('opens a sparse three-gigabyte stored entry through bounded range reads only', async () => {
        const source = createSparseStoredZip(3 * 1024 * 1024 * 1024);
        const archive = await openRangeBackedProjectBundleArchive(source.blob, 8);
        const entry = archive.get('sources/video/huge.mp4');

        expect(entry?.uncompressedBytes).toBe(3 * 1024 * 1024 * 1024);
        expect(Math.max(...source.requestedSliceBytes)).toBeLessThanOrEqual(65_557);
        expect(source.requestedSliceBytes.reduce((sum, value) => sum + value, 0))
            .toBeLessThan(256 * 1024);
    });

    it('opens a sparse five-gigabyte ZIP64 entry without source-sized allocation', async () => {
        const source = createSparseStoredZip(5 * 1024 * 1024 * 1024);
        const archive = await openRangeBackedProjectBundleArchive(source.blob, 8);

        expect(archive.get('sources/video/huge.mp4')?.uncompressedBytes)
            .toBe(5 * 1024 * 1024 * 1024);
        expect(Math.max(...source.requestedSliceBytes)).toBeLessThanOrEqual(65_557);
    });
});

function createSparseStoredZip(dataBytes: number): {
    blob: Blob;
    requestedSliceBytes: number[];
} {
    const nameBytes = new TextEncoder().encode('sources/video/huge.mp4');
    const zip64 = dataBytes >= 0xffff_ffff;
    const localExtra = zip64 ? createZip64Extra([dataBytes, dataBytes]) : new Uint8Array();
    const local = new Uint8Array(30 + nameBytes.byteLength + localExtra.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, zip64 ? 45 : 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint32(18, zip64 ? 0xffff_ffff : dataBytes, true);
    localView.setUint32(22, zip64 ? 0xffff_ffff : dataBytes, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    localView.setUint16(28, localExtra.byteLength, true);
    local.set(nameBytes, 30);
    local.set(localExtra, 30 + nameBytes.byteLength);
    const centralOffset = local.byteLength + dataBytes;
    const centralExtra = zip64 ? createZip64Extra([dataBytes, dataBytes]) : new Uint8Array();
    const central = new Uint8Array(46 + nameBytes.byteLength + centralExtra.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 0x031e, true);
    centralView.setUint16(6, zip64 ? 45 : 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint32(20, zip64 ? 0xffff_ffff : dataBytes, true);
    centralView.setUint32(24, zip64 ? 0xffff_ffff : dataBytes, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint16(30, centralExtra.byteLength, true);
    centralView.setUint32(38, 0o100644 << 16, true);
    central.set(nameBytes, 46);
    central.set(centralExtra, 46 + nameBytes.byteLength);
    const terminalParts: Array<{ bytes: Uint8Array; offset: number }> = [];
    let terminalOffset = centralOffset + central.byteLength;
    if (zip64) {
        const zip64Eocd = new Uint8Array(56);
        const zip64View = new DataView(zip64Eocd.buffer);
        zip64View.setUint32(0, 0x06064b50, true);
        zip64View.setBigUint64(4, BigInt(44), true);
        zip64View.setUint16(12, 45, true);
        zip64View.setUint16(14, 45, true);
        zip64View.setBigUint64(24, BigInt(1), true);
        zip64View.setBigUint64(32, BigInt(1), true);
        zip64View.setBigUint64(40, BigInt(central.byteLength), true);
        zip64View.setBigUint64(48, BigInt(centralOffset), true);
        terminalParts.push({ bytes: zip64Eocd, offset: terminalOffset });
        const locator = new Uint8Array(20);
        const locatorView = new DataView(locator.buffer);
        locatorView.setUint32(0, 0x07064b50, true);
        locatorView.setBigUint64(8, BigInt(terminalOffset), true);
        locatorView.setUint32(16, 1, true);
        terminalOffset += zip64Eocd.byteLength;
        terminalParts.push({ bytes: locator, offset: terminalOffset });
        terminalOffset += locator.byteLength;
    }
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, zip64 ? 0xffff : 1, true);
    eocdView.setUint16(10, zip64 ? 0xffff : 1, true);
    eocdView.setUint32(12, zip64 ? 0xffff_ffff : central.byteLength, true);
    eocdView.setUint32(16, zip64 ? 0xffff_ffff : centralOffset, true);
    terminalParts.push({ bytes: eocd, offset: terminalOffset });
    const size = terminalOffset + eocd.byteLength;
    const requestedSliceBytes: number[] = [];
    const sparse = {
        size,
        slice(start = 0, end = size) {
            requestedSliceBytes.push(end - start);
            const bytes = new Uint8Array(end - start);
            copyOverlap(bytes, start, local, 0);
            copyOverlap(bytes, start, central, centralOffset);
            terminalParts.forEach(part => copyOverlap(bytes, start, part.bytes, part.offset));
            return new Blob([bytes]);
        },
    };
    return { blob: sparse as unknown as Blob, requestedSliceBytes };
}

function createZip64Extra(values: readonly number[]): Uint8Array {
    const extra = new Uint8Array(4 + values.length * 8);
    const view = new DataView(extra.buffer);
    view.setUint16(0, 0x0001, true);
    view.setUint16(2, values.length * 8, true);
    values.forEach((value, index) => view.setBigUint64(4 + index * 8, BigInt(value), true));
    return extra;
}

function copyOverlap(
    target: Uint8Array,
    targetAbsoluteStart: number,
    source: Uint8Array,
    sourceAbsoluteStart: number,
): void {
    const overlapStart = Math.max(targetAbsoluteStart, sourceAbsoluteStart);
    const overlapEnd = Math.min(
        targetAbsoluteStart + target.byteLength,
        sourceAbsoluteStart + source.byteLength,
    );
    if (overlapEnd <= overlapStart) return;
    target.set(
        source.subarray(
            overlapStart - sourceAbsoluteStart,
            overlapEnd - sourceAbsoluteStart,
        ),
        overlapStart - targetAbsoluteStart,
    );
}
