import type { FileHandle } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { VerifiedReadHandle } from '../../path-grants/path-grant-authority';
import {
    MANAGED_TRANSCRIPTION_SOURCE_READ_MAX_BYTES,
    VerifiedReadHandleMediaByteSource,
} from './media-byte-source';

describe('verified retained source MediaByteSource adapter', () => {
    it('uses only the already-open handle, brackets reads with verification and closes once', async () => {
        const bytes = new TextEncoder().encode('bounded managed source');
        const verifyUnchanged = vi.fn(async () => undefined);
        const close = vi.fn(async () => undefined);
        const read = vi.fn(async (
            target: Uint8Array,
            offset: number,
            length: number,
            position: number,
        ) => {
            target.set(bytes.subarray(position, position + length), offset);
            return { bytesRead: length, buffer: target };
        });
        const capability = {
            capabilityType: 'verified-read-handle',
            grantId: 'retained:source-1',
            handle: { read } as unknown as FileHandle,
            identity: {
                device: '1',
                inode: '2',
                size: bytes.length,
                modifiedMilliseconds: 1,
            },
            digest: `sha256:${'9'.repeat(64)}`,
            verifyUnchanged,
            close,
        } satisfies VerifiedReadHandle;
        const source = new VerifiedReadHandleMediaByteSource('source-1', capability);

        const result = await source.read({ start: 8, endExclusive: 15 });
        expect(new TextDecoder().decode(result)).toBe('managed');
        expect(verifyUnchanged).toHaveBeenCalledTimes(2);
        expect(read).toHaveBeenCalledWith(expect.any(Uint8Array), 0, 7, 8);
        await source.close();
        await source.close();
        expect(close).toHaveBeenCalledTimes(1);
        await expect(source.verify()).rejects.toMatchObject({ code: 'SOURCE_CLOSED' });
    });

    it('rejects reads above the managed staging bound before I/O', async () => {
        const read = vi.fn();
        const capability = {
            capabilityType: 'verified-read-handle',
            grantId: 'retained:source-1',
            handle: { read } as unknown as FileHandle,
            identity: {
                device: '1',
                inode: '2',
                size: 9 * 1024 * 1024,
                modifiedMilliseconds: 1,
            },
            digest: `sha256:${'9'.repeat(64)}`,
            verifyUnchanged: async () => undefined,
            close: async () => undefined,
        } satisfies VerifiedReadHandle;
        const source = new VerifiedReadHandleMediaByteSource('source-1', capability);

        await expect(source.read({
            start: 0,
            endExclusive: MANAGED_TRANSCRIPTION_SOURCE_READ_MAX_BYTES + 1,
        })).rejects.toMatchObject({ code: 'RANGE_TOO_LARGE' });
        expect(read).not.toHaveBeenCalled();
        await source.close();
    });
});
