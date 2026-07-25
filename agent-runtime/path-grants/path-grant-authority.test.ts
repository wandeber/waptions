import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
    PathGrantAuthority,
    type RenderStagingQuotaPolicy,
    type SourceCopyQuotaPolicy,
} from './path-grant-authority';
import { temporaryRuntime } from '../testing/runtime-test-helpers';

const execute = promisify(execFile);
const scope = { sessionId: 'session', sessionEpoch: 'epoch' };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

function authority(
    root: string,
    sourceCopyQuotas?: SourceCopyQuotaPolicy,
    renderStagingQuotas?: RenderStagingQuotaPolicy,
): PathGrantAuthority {
    return new PathGrantAuthority({
        privateCopyRoot: join(root, 'private-source-copies'),
        authoritySecret: Buffer.alloc(32, 7),
        sourceCopyQuotas,
        renderStagingQuotas,
    });
}

describe('PathGrantAuthority', () => {
    it('materializes an immutable source version that survives later source replacement', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const sourceRoot = join(runtime.path, 'sources');
        await mkdir(sourceRoot);
        const source = join(sourceRoot, 'source.mp4');
        await writeFile(source, 'original');
        const grants = authority(runtime.path);
        const grant = await grants.create(scope.sessionId, scope.sessionEpoch, 'read-root', sourceRoot);
        const verified = await grants.openRead(grant.grantId, scope, source);
        await rename(source, join(sourceRoot, 'old.mp4'));
        await writeFile(source, 'replacement');
        await expect(verified.verifyUnchanged()).resolves.toBeUndefined();
        expect(await verified.handle.readFile('utf8')).toBe('original');
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
        const grants = authority(runtime.path);
        const grant = await grants.create(scope.sessionId, scope.sessionEpoch, 'read-root', sourceRoot);
        await expect(grants.openRead(grant.grantId, scope, linked)).rejects.toMatchObject({
            code: 'PATH_NOT_GRANTED',
        });
    });

    it('creates output through the already-open create-only descriptor', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const target = join(runtime.path, 'export.mp4');
        const grants = authority(runtime.path);
        const grant = await grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'create-only-destination',
            target,
        );
        const staged = await grants.stageCreate(grant.grantId, scope);
        await staged.handle.write(Buffer.from('x'), 0);
        await staged.handle.writeFile('managed');
        expect(await staged.handle.hash()).toMatchObject({
            bytes: 7,
            digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        });
        await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        let privatePath = '';
        await staged.handle.inspect(async (path) => {
            privatePath = path;
            expect(await readFile(path, 'utf8')).toBe('managed');
        });
        const publication = await staged.commit();
        expect(await readFile(target, 'utf8')).toBe('managed');
        expect(await readFile(privatePath, 'utf8')).toBe('managed');
        await publication.accept();
        await expect(readFile(privatePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not remove a destination created by another actor after granting', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const target = join(runtime.path, 'export.mp4');
        const grants = authority(runtime.path);
        const grant = await grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'create-only-destination',
            target,
        );
        await writeFile(target, 'other-owner');
        await expect(grants.stageCreate(grant.grantId, scope)).rejects.toMatchObject({
            code: 'WRITE_DESTINATION_NOT_GRANTED',
        });
        expect(await readFile(target, 'utf8')).toBe('other-owner');
    });

    it('reaps an aborted create-only destination', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const target = join(runtime.path, 'export.mp4');
        const grants = authority(runtime.path);
        const grant = await grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'create-only-destination',
            target,
        );
        const staged = await grants.stageCreate(grant.grantId, scope);
        await staged.handle.writeFile('rejected');
        await staged.abort();
        await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('enforces render staging byte, concurrency, and lifetime quotas', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const quotas: RenderStagingQuotaPolicy = {
            maximumOutputBytes: 4,
            maximumSessionBytes: 4,
            maximumSessionCount: 1,
            maximumGlobalBytes: 4,
            maximumGlobalCount: 1,
            maximumConcurrentStages: 1,
            maximumLifetimeMilliseconds: 20,
        };
        const grants = authority(runtime.path, undefined, quotas);
        const firstGrant = await grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'create-only-destination',
            join(runtime.path, 'first.mp4'),
        );
        const secondGrant = await grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'create-only-destination',
            join(runtime.path, 'second.mp4'),
        );
        const first = await grants.stageCreate(firstGrant.grantId, scope);
        await first.handle.writeFile('1234');
        await expect(first.handle.writeFile('12345')).rejects.toMatchObject({
            code: 'PAYLOAD_TOO_LARGE',
        });
        await expect(grants.stageCreate(secondGrant.grantId, scope)).rejects.toMatchObject({
            code: 'PAYLOAD_TOO_LARGE',
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
        await expect(first.handle.stat()).rejects.toMatchObject({ code: 'PATH_NOT_GRANTED' });

        const second = await grants.stageCreate(secondGrant.grantId, scope);
        let privatePath = '';
        await expect(second.handle.inspect(async (path) => {
            privatePath = path;
            await writeFile(path, '12345');
        })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
        await expect(readFile(privatePath)).rejects.toMatchObject({ code: 'ENOENT' });

        const third = await grants.stageCreate(secondGrant.grantId, scope);
        await expect(third.handle.inspect(
            async (_path, signal) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
            { deadlineMilliseconds: 10 },
        )).rejects.toMatchObject({ code: 'COORDINATOR_UNAVAILABLE' });
        await expect(third.handle.stat()).rejects.toMatchObject({ code: 'PATH_NOT_GRANTED' });
        const replacement = await grants.stageCreate(secondGrant.grantId, scope);
        await replacement.abort();
    });

    it('recovers private staging after a crash at atomic publication', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const target = join(runtime.path, 'recovered-export.mp4');
        const grants = authority(runtime.path);
        const grant = await grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'create-only-destination',
            target,
        );
        const staged = await grants.stageCreate(grant.grantId, scope);
        await staged.handle.writeFile('complete-before-publication');
        await staged.handle.sync();
        await staged.commit();

        // The terminal job transaction has not accepted the publication yet, which is the exact
        // durable state after a kill or lost response following the atomic external link.
        const restarted = authority(runtime.path);
        const recovered = await restarted.recoverOutputPublication(
            grant.grantId,
            scope.sessionId,
        );
        expect(recovered?.record.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(await readFile(target, 'utf8')).toBe('complete-before-publication');
        await recovered?.accept();
        expect(await restarted.recoverOutputPublication(
            grant.grantId,
            scope.sessionId,
        )).toBeNull();
    });

    it('rejects a crash-recovered publication with no durable output record', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const target = join(runtime.path, 'orphaned-export.mp4');
        const grants = authority(runtime.path);
        const grant = await grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'create-only-destination',
            target,
        );
        const staged = await grants.stageCreate(grant.grantId, scope);
        await staged.handle.writeFile('complete-but-not-durable');
        await staged.handle.sync();
        await staged.commit();
        expect(await readFile(target, 'utf8')).toBe('complete-but-not-durable');

        const restarted = authority(runtime.path);
        await restarted.reconcileOutputPublications(scope.sessionId, []);
        await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await restarted.recoverOutputPublication(
            grant.grantId,
            scope.sessionId,
        )).toBeNull();
    });

    it('retains recovery authority when the target disappears before acceptance', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const target = join(runtime.path, 'missing-before-accept.mp4');
        const grants = authority(runtime.path);
        const grant = await grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'create-only-destination',
            target,
        );
        const staged = await grants.stageCreate(grant.grantId, scope);
        await staged.handle.writeFile('complete-output');
        const publication = await staged.commit();
        await unlink(target);

        await expect(publication.accept()).rejects.toMatchObject({ code: 'ENOENT' });
        const restarted = authority(runtime.path);
        const recovered = await restarted.recoverOutputPublication(
            grant.grantId,
            scope.sessionId,
        );
        expect(recovered?.record).toEqual(publication.record);
        await recovered?.reject();
        expect(await restarted.recoverOutputPublication(
            grant.grantId,
            scope.sessionId,
        )).toBeNull();
    });

    it('cancels terminal create-only publication without opening the final target', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const target = join(runtime.path, 'cancelled-export.mp4');
        const grants = authority(runtime.path);
        const grant = await grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'create-only-destination',
            target,
        );
        const staged = await grants.stageCreate(grant.grantId, scope);
        await staged.handle.writeFile('cancelled');
        let privatePath = '';
        await staged.handle.inspect(async (path) => {
            privatePath = path;
        });
        const controller = new AbortController();
        controller.abort();
        await expect(staged.commit({ signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });
        await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(privatePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects a destination when its granted parent directory was replaced', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const destinationRoot = join(runtime.path, 'destination');
        await mkdir(destinationRoot);
        const target = join(destinationRoot, 'export.mp4');
        const grants = authority(runtime.path);
        const grant = await grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'create-only-destination',
            target,
        );
        await rename(destinationRoot, join(runtime.path, 'old-destination'));
        await mkdir(destinationRoot);
        await expect(grants.stageCreate(grant.grantId, scope)).rejects.toMatchObject({
            code: 'PATH_IDENTITY_CHANGED',
        });
    });

    it('fails closed and removes staged bytes after a parent replacement', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const destinationRoot = join(runtime.path, 'destination');
        const movedRoot = join(runtime.path, 'destination-original');
        const target = join(destinationRoot, 'export.mp4');
        await mkdir(destinationRoot);
        const grants = authority(runtime.path);
        const grant = await grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'create-only-destination',
            target,
        );
        const staged = await grants.stageCreate(grant.grantId, scope);
        let privatePath = '';
        await staged.handle.inspect(async (path) => {
            privatePath = path;
        });
        await rename(destinationRoot, movedRoot);
        await mkdir(destinationRoot);
        await staged.handle.writeFile('managed');
        await expect(staged.commit()).rejects.toMatchObject({ code: 'PATH_IDENTITY_CHANGED' });
        await expect(readFile(join(movedRoot, 'export.mp4'), 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
        await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(privatePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects a symlink as the grant root itself', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const realRoot = join(runtime.path, 'real-root');
        const linkedRoot = join(runtime.path, 'linked-root');
        await mkdir(realRoot);
        await symlink(realRoot, linkedRoot);
        const grants = authority(runtime.path);
        await expect(grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'read-root',
            linkedRoot,
        )).rejects.toMatchObject({ code: 'PATH_NOT_GRANTED' });
    });

    it('rejects caller-forged, cross-session, stale-epoch, and revoked grant identifiers', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const source = join(runtime.path, 'source.mp4');
        await writeFile(source, 'source');
        const grants = authority(runtime.path);
        const grant = await grants.create(scope.sessionId, scope.sessionEpoch, 'read-root', source);

        await expect(grants.openRead('forged', scope, source)).rejects.toMatchObject({
            code: 'PATH_NOT_GRANTED',
        });
        await expect(grants.openRead(grant.grantId, {
            ...scope,
            sessionId: 'other-session',
        }, source)).rejects.toMatchObject({ code: 'PATH_NOT_GRANTED' });
        await expect(grants.openRead(grant.grantId, {
            ...scope,
            sessionEpoch: 'other-epoch',
        }, source)).rejects.toMatchObject({ code: 'PATH_NOT_GRANTED' });
        const restored = authority(join(runtime.path, 'second-authority'));
        expect(() => restored.register({
            ...grant,
            canonicalPath: join(runtime.path, 'forged-source.mp4'),
        })).toThrowError(expect.objectContaining({ code: 'PATH_NOT_GRANTED' }));
        grants.revoke(grant.grantId, scope);
        await expect(grants.openRead(grant.grantId, scope, source)).rejects.toMatchObject({
            code: 'PATH_NOT_GRANTED',
        });
    });

    it('rejects FIFOs before a blocking open reaches the libuv worker pool', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const root = join(runtime.path, 'sources');
        await mkdir(root);
        const fifo = join(root, 'source.fifo');
        await execute('mkfifo', [fifo]);
        const grants = authority(runtime.path);
        const grant = await grants.create(scope.sessionId, scope.sessionEpoch, 'read-root', root);
        await expect(grants.openRead(grant.grantId, scope, fifo)).rejects.toMatchObject({
            code: 'SOURCE_UNREADABLE',
        });
    });

    it('detects metadata-preserving mutations against a file-root digest', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const source = join(runtime.path, 'source.bin');
        await writeFile(source, Buffer.alloc(4_096, 0x41));
        const grants = authority(runtime.path);
        const grant = await grants.create(scope.sessionId, scope.sessionEpoch, 'read-root', source);
        await writeFile(source, Buffer.alloc(4_096, 0x42));
        await execute('python3', [
            '-c',
            'import os,sys; p=sys.argv[1]; s=os.stat(p); os.utime(p, ns=(s.st_atime_ns, int(sys.argv[2])*1000000))',
            source,
            String(grant.identity!.modifiedMilliseconds),
        ]);
        await expect(grants.openRead(grant.grantId, scope, source)).rejects.toMatchObject({
            code: 'SOURCE_CHANGED',
        });
    });

    it('enforces persistent immutable-source quotas and releases unreachable copies', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const sourceRoot = join(runtime.path, 'quota-sources');
        await mkdir(sourceRoot);
        const firstPath = join(sourceRoot, 'first.bin');
        const secondPath = join(sourceRoot, 'second.bin');
        await writeFile(firstPath, '1234');
        await writeFile(secondPath, '5678');
        const grants = authority(runtime.path, {
            maximumSourceBytes: 4,
            maximumSessionBytes: 4,
            maximumSessionCount: 1,
            maximumGlobalBytes: 4,
            maximumGlobalCount: 1,
            maximumConcurrentCopies: 1,
        });
        const grant = await grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'read-root',
            sourceRoot,
        );
        const first = await grants.openRead(grant.grantId, scope, firstPath);
        const firstDigest = first.digest;
        await first.close();
        const restarted = authority(runtime.path, {
            maximumSourceBytes: 4,
            maximumSessionBytes: 4,
            maximumSessionCount: 1,
            maximumGlobalBytes: 4,
            maximumGlobalCount: 1,
            maximumConcurrentCopies: 1,
        });
        const retained = await restarted.openRetainedSource(
            scope.sessionId,
            'first-source',
            firstDigest,
            4,
        );
        expect(await retained.handle.readFile('utf8')).toBe('1234');
        await retained.close();
        await expect(grants.openRead(grant.grantId, scope, secondPath)).rejects.toMatchObject({
            code: 'PAYLOAD_TOO_LARGE',
        });

        await grants.releaseSourceCopies(scope.sessionId, [firstDigest]);
        const second = await grants.openRead(grant.grantId, scope, secondPath);
        expect(await second.handle.readFile('utf8')).toBe('5678');
        await second.close();
    });

    it('rejects a source larger than the immutable-copy per-source quota', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const sourceRoot = join(runtime.path, 'oversized-sources');
        await mkdir(sourceRoot);
        const source = join(sourceRoot, 'oversized.bin');
        await writeFile(source, '12345');
        const grants = authority(runtime.path, {
            maximumSourceBytes: 4,
            maximumSessionBytes: 8,
            maximumSessionCount: 2,
            maximumGlobalBytes: 8,
            maximumGlobalCount: 2,
            maximumConcurrentCopies: 1,
        });
        const grant = await grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'read-root',
            sourceRoot,
        );
        await expect(grants.openRead(grant.grantId, scope, source)).rejects.toMatchObject({
            code: 'PAYLOAD_TOO_LARGE',
        });
    });

    it('disables exact overwrite because Node cannot bind publication to a target descriptor', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const target = join(runtime.path, 'existing.mp4');
        await writeFile(target, 'existing');
        const grants = authority(runtime.path);
        await expect(grants.create(
            scope.sessionId,
            scope.sessionEpoch,
            'exact-overwrite',
            target,
            true,
        )).rejects.toMatchObject({ code: 'OVERWRITE_NOT_AUTHORIZED' });
    });
});
