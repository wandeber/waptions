import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SingleInstanceLock } from './single-instance-lock';
import { temporaryRuntime } from '../testing/runtime-test-helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('SingleInstanceLock', () => {
    it('allows exactly one winner when many launches reclaim one stale lock', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const root = resolve(runtime.path);
        await writeFile(join(root, 'coordinator.lock'), `${JSON.stringify({
            schemaVersion: 1,
            pid: 2_147_483_647,
            dataRoot: root,
            token: randomUUID(),
            createdAt: new Date(0).toISOString(),
        })}\n`, { mode: 0o600 });

        const results = await Promise.allSettled(
            Array.from({ length: 16 }, () => SingleInstanceLock.acquire(root)),
        );
        const winners = results.flatMap((result) => (
            result.status === 'fulfilled' ? [result.value] : []
        ));
        expect(winners).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(15);
        await winners[0].release();
    });

    it('reclaims an abandoned reclamation token before the stale coordinator lock', async () => {
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
        await writeFile(`${lockPath}.reclaim`, `${JSON.stringify({
            schemaVersion: 1,
            pid: 2_147_483_647,
            token: randomUUID(),
        })}\n`, { mode: 0o600 });

        const acquired = await SingleInstanceLock.acquire(root);
        await acquired.release();
    });
});
