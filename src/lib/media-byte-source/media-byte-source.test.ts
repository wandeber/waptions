import { createHash } from 'node:crypto';
import { open, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaBudgetManager } from './budget-manager';
import { BlobMediaByteSource } from './blob-source';
import { FilesystemMediaByteSource } from './filesystem-source';
import { HttpRangeMediaByteSource } from './http-range-source';
import {
    acquireMediabunnyByteSource,
    createAdmittedMediabunnyInput,
    createMediabunnyByteSource,
    MEDIABUNNY_SOURCE_CACHE_BYTES,
} from './mediabunny-adapter';
import { MediaByteSourceRegistry } from './registry';
import { SparseMediaByteSource } from './testing';
import { MEDIA_READ_CHUNK_BYTES } from './types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
        recursive: true,
        force: true,
    })));
});

describe('MediaByteSource adapters', () => {
    it('reads a sparse multi-gigabyte logical source without scaling memory to source size', async () => {
        const logicalSize = 5 * 1024 ** 3 + 17;
        const budget = new MediaBudgetManager('sparse', MEDIA_READ_CHUNK_BYTES);
        const source = new SparseMediaByteSource({
            sourceId: 'huge',
            immutableVersion: 'v1',
            byteLength: logicalSize,
            stagingBudget: budget,
        });
        const range = { start: logicalSize - 32, endExclusive: logicalSize };
        const bytes = await source.read(range);

        expect(bytes).toHaveLength(32);
        expect(bytes[0]).toBe(range.start % 251);
        expect(source.stats()).toMatchObject({
            bytesRead: 32,
            maxReadBytes: 32,
        });
        expect(budget.snapshot().peakBytes).toBe(32);
        await expect(source.read({
            start: 0,
            endExclusive: MEDIA_READ_CHUNK_BYTES + 1,
        })).rejects.toMatchObject({ code: 'RANGE_TOO_LARGE' });
        expect(source.stats().readCalls).toBe(1);
        await source.close();
        await source.close();
        expect(source.stats().closeCalls).toBe(1);
        budget.assertDrained();
    });

    it('returns caller-owned Blob snapshots and respects aborts', async () => {
        const source = new BlobMediaByteSource(new Blob([new Uint8Array([1, 2, 3, 4])]), {
            stagingBudget: new MediaBudgetManager('blob', 8),
        });
        const first = await source.read({ start: 1, endExclusive: 3 });
        first[0] = 99;
        expect(await source.read({ start: 1, endExclusive: 3 })).toEqual(new Uint8Array([2, 3]));

        const controller = new AbortController();
        controller.abort();
        await expect(source.read({ start: 0, endExclusive: 1 }, controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        await source.close();
        await expect(source.size()).rejects.toMatchObject({ code: 'SOURCE_CLOSED' });
    });

    it('bounds HTTP responses, validates immutable identity, and splits large ranges', async () => {
        const bytes = new Uint8Array(5 * 1024 * 1024);
        bytes.fill(7);
        const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
            if (init?.method === 'HEAD') {
                return new Response(null, {
                    status: 200,
                    headers: { etag: '"v1"', 'content-length': String(bytes.byteLength) },
                });
            }
            const range = new Headers(init?.headers).get('range');
            const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
            if (!match) return new Response(null, { status: 400 });
            const start = Number(match[1]);
            const endInclusive = Number(match[2]);
            const body = bytes.slice(start, endInclusive + 1);
            return new Response(body, {
                status: 206,
                headers: {
                    etag: '"v1"',
                    'content-length': String(body.byteLength),
                    'content-range': `bytes ${start}-${endInclusive}/${bytes.byteLength}`,
                },
            });
        });
        const budget = new MediaBudgetManager('http', 4 * 1024 * 1024);
        const source = new HttpRangeMediaByteSource({
            sourceId: 'remote',
            url: 'http://localhost/media',
            immutableVersion: '"v1"',
            byteLength: bytes.byteLength,
            fetch: fetchMock,
            stagingBudget: budget,
        });

        const result = await source.read({ start: 0, endExclusive: bytes.byteLength });
        expect(result).toHaveLength(bytes.byteLength);
        expect(result[0]).toBe(7);
        expect(result.at(-1)).toBe(7);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('if-range')).toBe('"v1"');
        expect(budget.snapshot().peakBytes).toBe(4 * 1024 * 1024);
        await expect(source.verify()).resolves.toEqual(source.identity);
        await source.close();
        budget.assertDrained();
    });

    it.each([
        ['missing ETag', null, 206],
        ['weak ETag', 'W/"v1"', 206],
        ['mismatched ETag', '"v2"', 206],
        ['full-body fallback', '"v1"', 200],
    ])('rejects %s range responses', async (_label, etag, status) => {
        const headers: Record<string, string> = {
            'content-length': '1',
            'content-range': 'bytes 0-0/1',
        };
        if (etag) headers.etag = etag;
        const source = new HttpRangeMediaByteSource({
            sourceId: 'remote-invalid',
            url: 'http://localhost/media',
            immutableVersion: 'v1',
            byteLength: 1,
            fetch: vi.fn(async () => new Response(new Uint8Array([1]), { status, headers })),
        });
        await expect(source.read({ start: 0, endExclusive: 1 })).rejects.toMatchObject({
            code: status === 200 ? 'INVALID_RANGE_RESPONSE' : 'SOURCE_CHANGED',
        });
        await source.close();
    });

    it.each([
        ['missing ETag', null],
        ['weak ETag', 'W/"v1"'],
        ['mismatched ETag', '"v2"'],
    ])('rejects HEAD verification with %s', async (_label, etag) => {
        const headers: Record<string, string> = { 'content-length': '1' };
        if (etag) headers.etag = etag;
        const source = new HttpRangeMediaByteSource({
            sourceId: 'remote-invalid-head',
            url: 'http://localhost/media',
            immutableVersion: 'v1',
            byteLength: 1,
            fetch: vi.fn(async () => new Response(null, { status: 200, headers })),
        });
        await expect(source.verify()).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
        await source.close();
    });

    it('keeps verified descriptors immutable across path replacement and closes repeated cycles', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'waptions-media-source-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'clip.bin');
        await writeFile(path, new Uint8Array([1, 2, 3, 4]));

        for (let index = 0; index < 50; index++) {
            const source = await FilesystemMediaByteSource.open({
                sourceId: `clip-${index}`,
                path,
                stagingBudget: new MediaBudgetManager(`fs-${index}`, 8),
            });
            expect(await source.read({ start: 1, endExclusive: 3 })).toEqual(new Uint8Array([2, 3]));
            await source.close();
            await source.close();
        }

        const source = await FilesystemMediaByteSource.open({ sourceId: 'replace', path });
        const replacement = join(directory, 'replacement.bin');
        await writeFile(replacement, new Uint8Array([9, 8, 7, 6]));
        await rename(replacement, path);
        await expect(source.read({ start: 0, endExclusive: 1 }))
            .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
        await expect(source.verify()).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
        await source.close();

        const replacementSource = await FilesystemMediaByteSource.open({ sourceId: 'replace-new', path });
        expect(replacementSource.identity.fingerprint).not.toBe(source.identity.fingerprint);
        await replacementSource.close();

        const verifiedBytes = new Uint8Array([5, 4, 3, 2, 1]);
        await writeFile(path, verifiedBytes);
        const verifiedHandle = await open(path, 'r');
        const adopted = await FilesystemMediaByteSource.fromVerifiedHandle({
            sourceId: 'verified-handle',
            handle: verifiedHandle,
            identity: {
                fingerprint: `sha256:${createHash('sha256').update(verifiedBytes).digest('hex')}`,
                sizeBytes: verifiedBytes.byteLength,
            },
        });
        const laterReplacement = join(directory, 'later-replacement.bin');
        await writeFile(laterReplacement, new Uint8Array([0, 0, 0, 0, 0]));
        await rename(laterReplacement, path);
        await expect(adopted.read({ start: 0, endExclusive: verifiedBytes.byteLength }))
            .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
        await adopted.close();
    });

    it('detects in-place replacement even when size and mtime are restored', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'waptions-media-mutation-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'clip.bin');
        await writeFile(path, new Uint8Array([1, 2, 3, 4]));
        const source = await FilesystemMediaByteSource.open({ sourceId: 'mutated', path });
        const before = await stat(path);
        await writeFile(path, new Uint8Array([4, 3, 2, 1]));
        await utimes(path, before.atime, before.mtime);
        await expect(source.read({ start: 0, endExclusive: 1 }))
            .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
        await source.close();
    });

    it('serializes concurrent full hashes through the compressed staging cap', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'waptions-media-hash-'));
        temporaryDirectories.push(directory);
        const bytes = new Uint8Array(MEDIA_READ_CHUNK_BYTES + 1);
        bytes.fill(3);
        const firstPath = join(directory, 'first.bin');
        const secondPath = join(directory, 'second.bin');
        await Promise.all([writeFile(firstPath, bytes), writeFile(secondPath, bytes)]);
        const budget = new MediaBudgetManager('hash-cap', MEDIA_READ_CHUNK_BYTES);
        const [first, second] = await Promise.all([
            FilesystemMediaByteSource.open({ sourceId: 'first', path: firstPath, stagingBudget: budget }),
            FilesystemMediaByteSource.open({ sourceId: 'second', path: secondPath, stagingBudget: budget }),
        ]);
        expect(budget.snapshot().peakBytes).toBe(MEDIA_READ_CHUNK_BYTES);
        await Promise.all([first.close(), second.close()]);
        budget.assertDrained();
    });

    it('cancels a read waiting on budget when the source closes', async () => {
        const budget = new MediaBudgetManager('close-blocked', 1);
        const held = (await budget.reserve(1)).commit();
        const source = new SparseMediaByteSource({
            sourceId: 'blocked',
            immutableVersion: 'v1',
            byteLength: 1,
            stagingBudget: budget,
        });
        const read = source.read({ start: 0, endExclusive: 1 });
        await Promise.resolve();
        await source.close();
        await expect(read).rejects.toMatchObject({ name: 'AbortError' });
        expect(budget.snapshot().queuedReservations).toBe(0);
        held.release();
        budget.assertDrained();
    });

    it('admits Mediabunny caches against one process-wide compressed-byte cap', async () => {
        const budget = new MediaBudgetManager(
            'mediabunny-cache-cap',
            MEDIABUNNY_SOURCE_CACHE_BYTES * 4,
        );
        const admissionBudget = new MediaBudgetManager(
            'mediabunny-cache-admission',
            MEDIABUNNY_SOURCE_CACHE_BYTES * 3,
        );
        const source = new SparseMediaByteSource({
            sourceId: 'shared',
            immutableVersion: 'v1',
            byteLength: MEDIABUNNY_SOURCE_CACHE_BYTES,
            stagingBudget: budget,
        });
        const handles = await Promise.all(Array.from(
            { length: 3 },
            () => acquireMediabunnyByteSource(source, {
                cacheBudget: budget,
                cacheAdmissionBudget: admissionBudget,
            }),
        ));
        await expect(source.read({
            start: 0,
            endExclusive: MEDIABUNNY_SOURCE_CACHE_BYTES,
        })).resolves.toHaveLength(MEDIABUNNY_SOURCE_CACHE_BYTES);
        let admitted = false;
        const blocked = acquireMediabunnyByteSource(source, {
            cacheBudget: budget,
            cacheAdmissionBudget: admissionBudget,
        }).then((handle) => {
            admitted = true;
            return handle;
        });
        await Promise.resolve();
        expect(admitted).toBe(false);
        (handles[0]?.source as unknown as { _dispose(): void })._dispose();
        await handles[0]?.whenDisposed();
        const fifth = await blocked;
        expect(budget.snapshot().peakBytes).toBe(MEDIABUNNY_SOURCE_CACHE_BYTES * 4);
        for (const handle of [...handles.slice(1), fifth]) {
            (handle.source as unknown as { _dispose(): void })._dispose();
            await handle.whenDisposed();
        }
        budget.assertDrained();
        admissionBudget.assertDrained();
        await source.close();

        const uncached = createMediabunnyByteSource(new Blob([new Uint8Array([1])]));
        expect(uncached.cacheBytes).toBe(0);
        (uncached.source as unknown as { _dispose(): void })._dispose();
        await uncached.whenDisposed();
    });

    it('releases an admitted Mediabunny cache when Input construction fails', async () => {
        const budget = new MediaBudgetManager('mediabunny-construction', MEDIABUNNY_SOURCE_CACHE_BYTES);
        const admissionBudget = new MediaBudgetManager(
            'mediabunny-construction-admission',
            MEDIABUNNY_SOURCE_CACHE_BYTES,
        );
        const constructionError = new Error('invalid input options');
        await expect(createAdmittedMediabunnyInput(
            new Blob([new Uint8Array([1])]),
            () => {
                throw constructionError;
            },
            { cacheBudget: budget, cacheAdmissionBudget: admissionBudget },
        )).rejects.toBe(constructionError);
        budget.assertDrained();
        admissionBudget.assertDrained();
    });
});

describe('MediaByteSourceRegistry', () => {
    it('enforces grants and invalidates old leases on immutable replacement', async () => {
        const registry = new MediaByteSourceRegistry();
        const oldSource = new SparseMediaByteSource({
            sourceId: 'clip',
            immutableVersion: 'v1',
            byteLength: 16,
        });
        await registry.register(oldSource);
        const lease = registry.acquire(registry.issueGrant('clip', [{ start: 4, endExclusive: 8 }]));
        expect(await lease.read({ start: 4, endExclusive: 6 })).toHaveLength(2);
        await expect(lease.read({ start: 0, endExclusive: 1 }))
            .rejects.toMatchObject({ code: 'RANGE_NOT_GRANTED' });

        const replacement = new SparseMediaByteSource({
            sourceId: 'clip',
            immutableVersion: 'v2',
            byteLength: 16,
        });
        await registry.register(replacement);
        await expect(lease.read({ start: 4, endExclusive: 5 }))
            .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
        expect(oldSource.stats().closeCalls).toBe(0);
        await lease.close();
        expect(oldSource.stats().closeCalls).toBe(1);
        await registry.close();
        expect(replacement.stats().closeCalls).toBe(1);
        expect(registry.snapshot()).toMatchObject({
            activeLeases: 0,
            invalidations: 1,
            closes: 2,
        });
    });

    it('waits for active leases during registry shutdown', async () => {
        const registry = new MediaByteSourceRegistry();
        const source = new SparseMediaByteSource({
            sourceId: 'clip',
            immutableVersion: 'v1',
            byteLength: 1,
        });
        await registry.register(source);
        const lease = registry.acquire(registry.issueGrant('clip'));
        let settled = false;
        const closing = registry.close().then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        await lease.close();
        await closing;
        expect(source.stats().closeCalls).toBe(1);
    });

    it('awaits cleanup failures when duplicate identities are rejected', async () => {
        const registry = new MediaByteSourceRegistry();
        const original = new SparseMediaByteSource({
            sourceId: 'clip',
            immutableVersion: 'v1',
            byteLength: 1,
        });
        await registry.register(original);
        const cleanupError = new Error('cleanup failed');
        const duplicate = new SparseMediaByteSource({
            sourceId: 'clip',
            immutableVersion: 'v1',
            byteLength: 1,
        });
        duplicate.close = async () => {
            throw cleanupError;
        };
        await expect(registry.register(duplicate)).rejects.toBe(cleanupError);
        await registry.close();
    });
});
