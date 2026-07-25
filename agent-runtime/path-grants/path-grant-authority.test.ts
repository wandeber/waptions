import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PathGrantAuthority } from './path-grant-authority';
import { temporaryRuntime } from '../testing/runtime-test-helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('PathGrantAuthority', () => {
    it('detects source replacement while a verified descriptor remains open', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const sourceRoot = join(runtime.path, 'sources');
        await mkdir(sourceRoot);
        const source = join(sourceRoot, 'source.mp4');
        await writeFile(source, 'original');
        const authority = new PathGrantAuthority();
        const grant = await authority.create('session', 'read-root', sourceRoot);
        const verified = await authority.openRead(grant, source);
        await rename(source, join(sourceRoot, 'old.mp4'));
        await writeFile(source, 'replacement');
        await expect(verified.verifyUnchanged()).rejects.toMatchObject({
            code: 'PATH_IDENTITY_CHANGED',
        });
        await verified.close();
    });

    it('rejects a symlink escape from a read-root grant', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const sourceRoot = join(runtime.path, 'sources');
        await mkdir(sourceRoot);
        const outside = join(runtime.path, 'outside.mp4');
        await writeFile(outside, 'outside');
        const linked = join(sourceRoot, 'linked.mp4');
        await symlink(outside, linked);
        const authority = new PathGrantAuthority();
        const grant = await authority.create('session', 'read-root', sourceRoot);
        await expect(authority.openRead(grant, linked)).rejects.toMatchObject({
            code: 'PATH_NOT_GRANTED',
        });
    });

    it('publishes create-only output without overwriting a raced destination', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const target = join(runtime.path, 'export.mp4');
        const authority = new PathGrantAuthority();
        const grant = await authority.create('session', 'create-only-destination', target);
        const staged = await authority.stageCreate(grant);
        await staged.handle.writeFile('managed');
        await writeFile(target, 'raced');
        await expect(staged.commit()).rejects.toMatchObject({
            code: 'WRITE_DESTINATION_NOT_GRANTED',
        });
        await staged.abort();
    });

    it('rejects a destination when its granted parent directory was replaced', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const destinationRoot = join(runtime.path, 'destination');
        await mkdir(destinationRoot);
        const target = join(destinationRoot, 'export.mp4');
        const authority = new PathGrantAuthority();
        const grant = await authority.create('session', 'create-only-destination', target);
        await rename(destinationRoot, join(runtime.path, 'old-destination'));
        await mkdir(destinationRoot);
        await expect(authority.stageCreate(grant)).rejects.toMatchObject({
            code: 'PATH_IDENTITY_CHANGED',
        });
    });

    it('rejects a symlink as the grant root itself', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const realRoot = join(runtime.path, 'real-root');
        const linkedRoot = join(runtime.path, 'linked-root');
        await mkdir(realRoot);
        await symlink(realRoot, linkedRoot);
        const authority = new PathGrantAuthority();
        await expect(authority.create('session', 'read-root', linkedRoot)).rejects.toMatchObject({
            code: 'PATH_NOT_GRANTED',
        });
    });

    it('stops an already-staged destination at the next boundary after revocation', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const target = join(runtime.path, 'revoked-export.mp4');
        const authority = new PathGrantAuthority();
        const grant = await authority.create('session', 'create-only-destination', target);
        const staged = await authority.stageCreate(grant);
        await staged.handle.writeFile('partial');
        authority.revoke(grant);
        await expect(staged.commit()).rejects.toMatchObject({ code: 'PATH_NOT_GRANTED' });
        await staged.abort();
    });
});
