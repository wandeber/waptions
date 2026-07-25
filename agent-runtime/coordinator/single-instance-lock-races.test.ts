import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { temporaryRuntime } from '../testing/runtime-test-helpers';

type FsPromises = typeof import('node:fs/promises');

const race = vi.hoisted(() => ({
    targetPath: '',
    pauseQuarantine: false,
    quarantineEntered: false,
    releaseQuarantine: false,
    replaceBeforeRename: false,
    replacementToken: '',
    replacementDataRoot: '',
}));

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<FsPromises>('node:fs/promises');
    return {
        ...actual,
        rename: async (...args: Parameters<typeof actual.rename>) => {
            const [from, to] = args;
            if (String(from) !== race.targetPath) return actual.rename(from, to);
            if (race.replaceBeforeRename) {
                race.replaceBeforeRename = false;
                await actual.rename(from, `${String(from)}.previous-owner`);
                await actual.writeFile(from, `${JSON.stringify({
                    schemaVersion: 1,
                    pid: process.pid,
                    dataRoot: race.replacementDataRoot,
                    token: race.replacementToken,
                    createdAt: new Date().toISOString(),
                })}\n`, { mode: 0o600 });
            }
            if (race.pauseQuarantine) {
                race.quarantineEntered = true;
                while (!race.releaseQuarantine) {
                    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
                }
            }
            return actual.rename(from, to);
        },
    };
});

import { SingleInstanceLock } from './single-instance-lock';

const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
    race.targetPath = '';
    race.pauseQuarantine = false;
    race.quarantineEntered = false;
    race.releaseQuarantine = false;
    race.replaceBeforeRename = false;
    race.replacementToken = '';
    race.replacementDataRoot = '';
});

afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('SingleInstanceLock adversarial races', () => {
    it('keeps the reclamation token exclusive while a stale lock is quarantined', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const root = resolve(runtime.path);
        const lockPath = join(root, 'coordinator.lock');
        await writeFile(lockPath, `${JSON.stringify({
            schemaVersion: 1,
            pid: 2_147_483_647,
            dataRoot: root,
            token: randomUUID(),
            createdAt: new Date(0).toISOString(),
        })}\n`, { mode: 0o600 });
        race.targetPath = lockPath;
        race.pauseQuarantine = true;

        const first = SingleInstanceLock.acquire(root);
        await waitFor(() => race.quarantineEntered);
        const second = SingleInstanceLock.acquire(root);
        await expect(second).rejects.toMatchObject({ code: 'COORDINATOR_UNAVAILABLE' });
        race.releaseQuarantine = true;
        const owner = await first;
        await owner.release();
    });

    it('never removes a successor lock when release races with pathname replacement', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const root = resolve(runtime.path);
        const lockPath = join(root, 'coordinator.lock');
        const owner = await SingleInstanceLock.acquire(root);
        race.targetPath = lockPath;
        race.replaceBeforeRename = true;
        race.replacementToken = randomUUID();
        race.replacementDataRoot = root;

        await owner.release();
        const current = JSON.parse(await readFile(lockPath, 'utf8')) as { token: string };
        expect(current.token).toBe(race.replacementToken);
        await rm(`${lockPath}.previous-owner`, { force: true });
    });
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the lock race hook.');
        await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }
}
