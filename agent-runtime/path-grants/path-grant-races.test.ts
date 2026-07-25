import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type FsPromises = typeof import('node:fs/promises');
type OpenedHandle = Awaited<ReturnType<FsPromises['open']>>;
type LstatHook = (path: string, actual: FsPromises) => Promise<void>;
type RealpathHook = (path: string, canonical: string, actual: FsPromises) => Promise<void>;
type OpenHook = (path: string, actual: FsPromises, handle: OpenedHandle) => Promise<void>;
type LinkHook = (destination: string, actual: FsPromises) => Promise<void>;

const hooks = vi.hoisted(() => ({
    afterLstat: undefined as LstatHook | undefined,
    afterRealpath: undefined as RealpathHook | undefined,
    afterOpen: undefined as OpenHook | undefined,
    afterLink: undefined as LinkHook | undefined,
}));

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<FsPromises>('node:fs/promises');
    return {
        ...actual,
        lstat: async (...args: unknown[]) => {
            const metadata = await (actual.lstat as (...values: unknown[]) => Promise<unknown>)(...args);
            await hooks.afterLstat?.(String(args[0]), actual);
            return metadata;
        },
        realpath: async (...args: unknown[]) => {
            const canonical = await (actual.realpath as (...values: unknown[]) => Promise<string>)(
                ...args,
            );
            await hooks.afterRealpath?.(String(args[0]), canonical, actual);
            return canonical;
        },
        open: async (...args: unknown[]) => {
            const handle = await (actual.open as (...values: unknown[]) => Promise<OpenedHandle>)(
                ...args,
            );
            await hooks.afterOpen?.(String(args[0]), actual, handle);
            return handle;
        },
        link: async (...args: unknown[]) => {
            await (actual.link as (...values: unknown[]) => Promise<void>)(...args);
            await hooks.afterLink?.(String(args[1]), actual);
        },
    };
});

import { PathGrantAuthority } from './path-grant-authority';
import { temporaryRuntime } from '../testing/runtime-test-helpers';

let fs: FsPromises;
const cleanups: (() => Promise<void>)[] = [];
const scope = { sessionId: 'session', sessionEpoch: 'epoch' };

beforeAll(async () => {
    fs = await vi.importActual<FsPromises>('node:fs/promises');
});

afterEach(async () => {
    hooks.afterLstat = undefined;
    hooks.afterRealpath = undefined;
    hooks.afterOpen = undefined;
    hooks.afterLink = undefined;
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('PathGrantAuthority adversarial races', () => {
    it('fails closed when a selected root is swapped after initial inspection', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const selected = join(runtime.path, 'selected');
        const original = join(runtime.path, 'selected-original');
        const outside = join(runtime.path, 'outside');
        await fs.mkdir(selected);
        await fs.mkdir(outside);
        let swapped = false;
        hooks.afterLstat = async (path, actual) => {
            if (swapped || path !== selected) return;
            swapped = true;
            await actual.rename(selected, original);
            await actual.symlink(outside, selected, 'dir');
        };
        const authority = new PathGrantAuthority({
            privateCopyRoot: join(runtime.path, 'private-copies'),
            authoritySecret: Buffer.alloc(32, 7),
        });
        await expect(authority.create(
            scope.sessionId,
            scope.sessionEpoch,
            'read-root',
            selected,
        )).rejects.toMatchObject({ code: 'PATH_IDENTITY_CHANGED' });
    });

    it('does not open outside bytes when an intermediate directory changes after realpath', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const granted = join(runtime.path, 'granted');
        const mutable = join(granted, 'mutable');
        const moved = join(granted, 'mutable-old');
        const requested = join(mutable, 'source.mp4');
        const outside = join(runtime.path, 'outside');
        await fs.mkdir(mutable, { recursive: true });
        await fs.mkdir(outside);
        await fs.writeFile(requested, 'inside');
        await fs.writeFile(join(outside, 'source.mp4'), 'outside-secret');
        const authority = new PathGrantAuthority({
            privateCopyRoot: join(runtime.path, 'private-copies'),
            authoritySecret: Buffer.alloc(32, 7),
        });
        const grant = await authority.create(
            scope.sessionId,
            scope.sessionEpoch,
            'read-root',
            granted,
        );
        let swapped = false;
        hooks.afterRealpath = async (path, _canonical, actual) => {
            if (swapped || path !== requested) return;
            swapped = true;
            await actual.rename(mutable, moved);
            await actual.symlink(outside, mutable, 'dir');
        };
        await expect(authority.openRead(grant.grantId, scope, requested)).rejects.toMatchObject({
            code: 'PATH_IDENTITY_CHANGED',
        });
    });

    it('charges source growth against aggregate immutable-copy quotas before writing it', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const sourceRoot = join(runtime.path, 'growing-sources');
        const retained = join(sourceRoot, 'retained.bin');
        const growing = join(sourceRoot, 'growing.bin');
        await fs.mkdir(sourceRoot);
        await fs.writeFile(retained, '1234');
        await fs.writeFile(growing, '5678');
        const authority = new PathGrantAuthority({
            privateCopyRoot: join(runtime.path, 'private-copies'),
            authoritySecret: Buffer.alloc(32, 7),
            sourceCopyQuotas: {
                maximumSourceBytes: 8,
                maximumSessionBytes: 8,
                maximumSessionCount: 2,
                maximumGlobalBytes: 12,
                maximumGlobalCount: 3,
                maximumConcurrentCopies: 1,
            },
        });
        const grant = await authority.create(
            scope.sessionId,
            scope.sessionEpoch,
            'read-root',
            sourceRoot,
        );
        const first = await authority.openRead(grant.grantId, scope, retained);
        await first.close();

        let expanded = false;
        hooks.afterOpen = async (path, actual, handle) => {
            if (path !== growing) return;
            const originalRead = handle.read.bind(handle) as (
                ...args: unknown[]
            ) => Promise<{ bytesRead: number; buffer: unknown }>;
            Object.defineProperty(handle, 'read', {
                configurable: true,
                value: async (...args: unknown[]) => {
                    const result = await originalRead(...args);
                    if (!expanded && result.bytesRead > 0) {
                        expanded = true;
                        await actual.appendFile(growing, '9012');
                    }
                    return result;
                },
            });
        };

        await expect(authority.openRead(grant.grantId, scope, growing)).rejects.toMatchObject({
            code: 'PAYLOAD_TOO_LARGE',
        });
    });

    it('fails closed when the destination parent changes during terminal publication', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const destinationRoot = join(runtime.path, 'destination');
        const movedRoot = join(runtime.path, 'destination-moved');
        const target = join(destinationRoot, 'export.mp4');
        await fs.mkdir(destinationRoot);
        const authority = new PathGrantAuthority({
            privateCopyRoot: join(runtime.path, 'private-copies'),
            authoritySecret: Buffer.alloc(32, 7),
        });
        const grant = await authority.create(
            scope.sessionId,
            scope.sessionEpoch,
            'create-only-destination',
            target,
        );
        const staged = await authority.stageCreate(grant.grantId, scope);
        await staged.handle.writeFile('private-render');
        let privatePath = '';
        await staged.handle.inspect(async (path) => {
            privatePath = path;
        });
        let swapped = false;
        hooks.afterLink = async (path, actual) => {
            if (swapped || !path.endsWith('/destination/export.mp4')) return;
            swapped = true;
            expect(await actual.readFile(path, 'utf8')).toBe('private-render');
            await actual.rename(destinationRoot, movedRoot);
            await actual.mkdir(destinationRoot);
        };
        await expect(staged.commit()).rejects.toMatchObject({ code: 'PATH_IDENTITY_CHANGED' });
        expect(await fs.readFile(join(movedRoot, 'export.mp4'), 'utf8')).toBe('');
        await expect(fs.readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.readFile(privatePath, 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });
});
