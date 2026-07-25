import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PrivateMp4ScratchAuthority } from './private-mp4-scratch';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => (
        rm(root, { recursive: true, force: true })
    )));
});

describe('PrivateMp4ScratchAuthority', () => {
    it('sweeps interrupted scratch directories and closes them safely', async () => {
        const root = await mkdtemp(join(tmpdir(), 'waptions-private-scratch-'));
        roots.push(root);
        const scratch = join(root, 'scratch');
        const orphan = join(scratch, '2e1f0b1d-fd8f-4a32-8c5c-596e7932769f');
        await mkdir(orphan, { recursive: true });
        await writeFile(join(orphan, 'render.mp4'), 'partial');

        const authority = new PrivateMp4ScratchAuthority(
            scratch,
            () => {
                throw new Error('The test does not render scratch media.');
            },
        );
        await authority.initialize();
        expect(await readdir(scratch)).toEqual([]);
        await authority.close();
        await expect(readdir(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
