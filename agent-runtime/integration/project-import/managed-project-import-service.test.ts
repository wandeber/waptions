import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyManagedCoreSnapshot } from '../core-editor-port';
import { writeManagedPortableBundle } from '../export/portable-bundle-writer';
import type { ManagedStreamingEntry } from '../export/contracts';
import type { ManagedStreamingSink } from '../export/streaming-output';
import type {
    ManagedProjectImportReadLease,
    ManagedProjectImportServiceDependencies,
} from './contracts';
import { ManagedProjectImportService } from './managed-project-import-service';
import { ManagedProjectImportZip } from './managed-zip-reader';

describe('managed project import service', () => {
    it('round-trips a portable-writer V4 bundle through receipt-first preparation', async () => {
        const bundle = await bundleBytes();
        const lease = memoryLease(bundle);
        const published = vi.fn(async (
            input: Parameters<ManagedProjectImportServiceDependencies['receipts']['publishReceiptFirst']>[0],
        ) => {
            void input;
            return success();
        });
        const service = new ManagedProjectImportService(dependencies(lease, published));

        await expect(service.handler(scopedCall('bundle-path'), { signal: new AbortController().signal }))
            .resolves.toEqual(success());
        expect(published).toHaveBeenCalledOnce();
        const prepared = published.mock.calls[0]![0].prepared;
        expect(prepared).toMatchObject({ formatVersion: 4, media: [], transcripts: [] });
        expect(JSON.stringify(prepared)).not.toContain('/private/');
    });

    it('rejects corrupt bytes, stored ZIP traversal, and compressed ZIP metadata before publication', async () => {
        const original = await bundleBytes();
        const corrupt = Uint8Array.from(original);
        corrupt[indexOf(corrupt, new TextEncoder().encode('"4.0"'))] ^= 1;
        const traversal = Uint8Array.from(original);
        const central = indexOf(traversal, Uint8Array.of(0x50, 0x4b, 0x01, 0x02));
        traversal.set(new TextEncoder().encode('../evil0.json'), central + 46);
        const compressed = Uint8Array.from(original);
        const compressedCentral = indexOf(compressed, Uint8Array.of(0x50, 0x4b, 0x01, 0x02));
        new DataView(compressed.buffer).setUint16(compressedCentral + 10, 8, true);

        for (const bytes of [corrupt, traversal, compressed]) {
            const published = vi.fn(async (
                input: Parameters<ManagedProjectImportServiceDependencies['receipts']['publishReceiptFirst']>[0],
            ) => {
                void input;
                return success();
            });
            const service = new ManagedProjectImportService(dependencies(memoryLease(bytes), published));
            await expect(service.handler(scopedCall('bundle-path'), { signal: new AbortController().signal }))
                .rejects.toThrow();
            expect(published).not.toHaveBeenCalled();
        }
    });

    it('rejects duplicate Unicode aliases from raw central-directory metadata', async () => {
        const bytes = await bundleBytes([
            bytesEntry('metadata.json', JSON.stringify(metadata())),
            bytesEntry('second0000000', 'unused'),
        ]);
        const duplicate = Uint8Array.from(bytes);
        replaceAll(duplicate, new TextEncoder().encode('second0000000'), new TextEncoder().encode('METAdata.json'));
        await expect(ManagedProjectImportZip.open(
            memoryLease(duplicate),
            importLimits(),
        )).rejects.toThrow(/duplicate or Unicode-conflicting/i);
    });

    it('does not reopen a stale grant and replays a receipt before source access', async () => {
        const bundle = await bundleBytes();
        const stale = memoryLease(bundle, { stale: true });
        const published = vi.fn(async (
            input: Parameters<ManagedProjectImportServiceDependencies['receipts']['publishReceiptFirst']>[0],
        ) => {
            void input;
            return success();
        });
        const staleService = new ManagedProjectImportService(dependencies(stale, published));
        await expect(staleService.handler(scopedCall('bundle-path'), { signal: new AbortController().signal }))
            .rejects.toThrow(/stale/i);
        expect(published).not.toHaveBeenCalled();

        const replay = { ...success(), replayed: true };
        const paths = { openPath: vi.fn(async () => memoryLease(bundle)) };
        const service = new ManagedProjectImportService({
            paths,
            receipts: { replay: vi.fn(async () => replay), publishReceiptFirst: published },
        });
        await expect(service.handler(scopedCall('bundle-path'), { signal: new AbortController().signal }))
            .resolves.toEqual(replay);
        expect(paths.openPath).not.toHaveBeenCalled();
        expect(published).not.toHaveBeenCalled();
    });

    it('honours cancellation before any project publication', async () => {
        const published = vi.fn(async (
            input: Parameters<ManagedProjectImportServiceDependencies['receipts']['publishReceiptFirst']>[0],
        ) => {
            void input;
            return success();
        });
        const service = new ManagedProjectImportService(dependencies(await bundleLease(), published));
        const controller = new AbortController();
        controller.abort(new DOMException('cancelled', 'AbortError'));
        await expect(service.handler(scopedCall('bundle-path'), { signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(published).not.toHaveBeenCalled();
    });

    it('reads large entries in bounded chunks and can restart from the immutable lease', async () => {
        const large = new Uint8Array(3 * 1024 * 1024).fill(7);
        const bytes = await bundleBytes([
            bytesEntry('metadata.json', JSON.stringify(metadata())),
            bytesEntry('large.bin', large),
        ]);
        const first = memoryLease(bytes);
        const archive = await ManagedProjectImportZip.open(first, importLimits());
        await archive.digest('large.bin');
        expect(first.maximumRead).toBeLessThanOrEqual(1024 * 1024);

        const restarted = memoryLease(bytes);
        const recovered = await ManagedProjectImportZip.open(restarted, importLimits());
        await expect(recovered.digest('large.bin')).resolves.toBe(await archive.digest('large.bin'));
        expect(restarted.maximumRead).toBeLessThanOrEqual(1024 * 1024);
    });
});

async function bundleBytes(entries = [bytesEntry('metadata.json', JSON.stringify(metadata()))]): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let bytesWritten = 0;
    const hash = createHash('sha256');
    const sink: ManagedStreamingSink = {
        get bytesWritten() { return bytesWritten; },
        async write(chunk) {
            chunks.push(chunk.slice());
            bytesWritten += chunk.byteLength;
            hash.update(chunk);
        },
        async sync() {},
        digest: () => `sha256:${hash.copy().digest('hex')}`,
    };
    await writeManagedPortableBundle({ entries, sink });
    const result = new Uint8Array(bytesWritten);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

async function bundleLease() {
    return memoryLease(await bundleBytes());
}

function metadata() {
    return {
        version: '4.0',
        project: { id: 'bundle-project', name: 'Imported bundle' },
        editorManifest: createEmptyManagedCoreSnapshot('bundle-project', 'epoch').state.snapshot.manifest,
        sourceFiles: { video: {}, audio: {} },
        editorialTranscriptFiles: {},
        presets: [],
    };
}

function bytesEntry(name: string, value: string | Uint8Array): ManagedStreamingEntry {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    return {
        name,
        byteLength: bytes.byteLength,
        async *stream() {
            for (let offset = 0; offset < bytes.byteLength; offset += 1024 * 1024) {
                yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + 1024 * 1024));
            }
        },
        async revalidate() {},
    };
}

function dependencies(
    lease: ManagedProjectImportReadLease,
    publishReceiptFirst: ManagedProjectImportServiceDependencies['receipts']['publishReceiptFirst'],
): ManagedProjectImportServiceDependencies {
    return {
        paths: { openPath: vi.fn(async () => lease) },
        receipts: { replay: vi.fn(async () => null), publishReceiptFirst },
        limits: importLimits(),
    };
}

function importLimits() {
    return {
        maximumArchiveBytes: 16 * 1024 * 1024,
        maximumEntries: 32,
        maximumCentralDirectoryBytes: 1024 * 1024,
        maximumMetadataBytes: 1024 * 1024,
        maximumDetachedBodyBytes: 1024 * 1024,
        maximumAggregateDetachedBodyBytes: 2 * 1024 * 1024,
        maximumEntryBytes: 8 * 1024 * 1024,
        maximumAggregateBytes: 12 * 1024 * 1024,
        maximumReadChunkBytes: 1024 * 1024,
    } as const;
}

function memoryLease(bytes: Uint8Array, options: { stale?: boolean } = {}) {
    let closed = false;
    const lease: ManagedProjectImportReadLease & { maximumRead: number } = {
        capabilityId: 'managed-import-test-capability',
        byteLength: bytes.byteLength,
        maximumRead: 0,
        async read(position, length) {
            if (closed) throw new Error('closed');
            lease.maximumRead = Math.max(lease.maximumRead, length);
            return bytes.slice(position, position + length);
        },
        async assertCurrent() {
            if (options.stale) throw new Error('stale read grant');
        },
        async close() { closed = true; },
    };
    return lease;
}

function scopedCall(kind: 'bundle-path' | 'manifest-path') {
    return {
        toolName: 'waptions_project_import',
        request: {
            apiVersion: '2026-07-25',
            sessionId: 'session-import',
            sessionEpoch: 'epoch-import',
            expected: { sessionRevision: 0, documentRevision: 0 },
            idempotencyKey: 'import-key',
            source: { kind, grantId: 'grant-import', path: '/private/project.waptions' },
        },
        canonicalRequest: '{}',
        requestHash: `sha256:${'a'.repeat(64)}`,
        mutation: true,
        identity: { sessionId: 'session-import', sessionEpoch: 'epoch-import', idempotencyKey: 'import-key' },
        receiptScope: {
            projectId: 'project-import',
            toolName: 'waptions_project_import',
            idempotencyKey: 'import-key',
        },
    } as const;
}

function success() {
    return { ok: true as const, data: { jobId: 'import-job' }, warnings: [] };
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
    outer: for (let index = 0; index <= haystack.byteLength - needle.byteLength; index += 1) {
        for (let inner = 0; inner < needle.byteLength; inner += 1) {
            if (haystack[index + inner] !== needle[inner]) continue outer;
        }
        return index;
    }
    throw new Error('needle not found');
}

function replaceAll(bytes: Uint8Array, from: Uint8Array, to: Uint8Array): void {
    if (from.byteLength !== to.byteLength) throw new Error('replacement length must match');
    for (let offset = 0; offset <= bytes.byteLength - from.byteLength; offset += 1) {
        if (from.every((value, index) => bytes[offset + index] === value)) {
            bytes.set(to, offset);
            offset += from.byteLength - 1;
        }
    }
}
