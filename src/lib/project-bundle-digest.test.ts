import { describe, expect, it } from 'vitest';
import { IncrementalSha256, sha256Blob } from './project-bundle-digest';

describe('streaming project bundle source digest', () => {
    it('matches the SHA-256 standard vectors across fragmented updates', async () => {
        const fragmented = new IncrementalSha256()
            .update(new TextEncoder().encode('a'))
            .update(new TextEncoder().encode('b'))
            .update(new TextEncoder().encode('c'))
            .digest();
        expect(fragmented).toBe(
            'sha256:ba7816bf8f01cfea414140de5dae2223'
            + 'b00361a396177a9cb410ff61f20015ad',
        );
        await expect(sha256Blob(new Blob(['']))).resolves.toBe(
            'sha256:e3b0c44298fc1c149afbf4c8996fb924'
            + '27ae41e4649b934ca495991b7852b855',
        );
        const millionAs = new Uint8Array(1_000_000).fill('a'.charCodeAt(0));
        const long = new IncrementalSha256();
        for (let offset = 0; offset < millionAs.length; offset += 13_337) {
            long.update(millionAs.subarray(offset, offset + 13_337));
        }
        expect(long.digest()).toBe(
            'sha256:cdc76e5c9914fb9281a1c7e284d73e67'
            + 'f1809a48a497200e046d39ccc7112cd0',
        );
    });

    it('observes cancellation while consuming the source stream', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(sha256Blob(new Blob(['source']), controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
    });
});
