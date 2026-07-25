import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { managedError } from './errors';
import { ensurePrivateDirectory, fsyncDirectory } from '../persistence/fs-durable';

interface LockRecord {
    schemaVersion: 1;
    pid: number;
    dataRoot: string;
    token: string;
    createdAt: string;
}

interface BoundTokenFile {
    handle: FileHandle;
    device: bigint;
    inode: bigint;
    record: { pid?: number; dataRoot?: string; token?: string };
}

export class SingleInstanceLock {
    private released = false;

    private constructor(
        readonly path: string,
        private readonly token: string,
        private readonly device: bigint,
        private readonly inode: bigint,
    ) {}

    static async acquire(dataRoot: string): Promise<SingleInstanceLock> {
        const canonicalRoot = resolve(dataRoot);
        await ensurePrivateDirectory(canonicalRoot);
        const path = join(canonicalRoot, 'coordinator.lock');

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const token = randomUUID();
            let handle: FileHandle | undefined;
            try {
                handle = await open(
                    path,
                    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
                    0o600,
                );
                const record: LockRecord = {
                    schemaVersion: 1,
                    pid: process.pid,
                    dataRoot: canonicalRoot,
                    token,
                    createdAt: new Date().toISOString(),
                };
                await handle.writeFile(`${JSON.stringify(record)}\n`);
                await handle.sync();
                const metadata = await handle.stat({ bigint: true });
                await handle.close();
                handle = undefined;
                await fsyncDirectory(canonicalRoot);
                return new SingleInstanceLock(path, token, metadata.dev, metadata.ino);
            } catch (error) {
                await handle?.close().catch(() => undefined);
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                if (!await quarantineStaleLock(path, canonicalRoot)) {
                    throw managedError(
                        'COORDINATOR_UNAVAILABLE',
                        'Another managed editor coordinator owns this data directory.',
                        true,
                    );
                }
            }
        }
        throw managedError('COORDINATOR_UNAVAILABLE', 'Could not acquire the coordinator lock.', true);
    }

    async release(): Promise<void> {
        if (this.released) return;
        this.released = true;
        const removed = await removeOwnedTokenFile(
            this.path,
            this.token,
            { device: this.device, inode: this.inode },
        );
        if (removed) await fsyncDirectory(dirname(this.path));
    }
}

async function quarantineStaleLock(path: string, dataRoot: string): Promise<boolean> {
    const reclaimPath = `${path}.reclaim`;
    const reclaimToken = randomUUID();
    let reclaimHandle: FileHandle | undefined;
    let reclaimIdentity: { device: bigint; inode: bigint } | undefined;
    try {
        reclaimHandle = await open(
            reclaimPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
        );
        await reclaimHandle.writeFile(`${JSON.stringify({
            schemaVersion: 1,
            pid: process.pid,
            token: reclaimToken,
        })}\n`);
        await reclaimHandle.sync();
        const metadata = await reclaimHandle.stat({ bigint: true });
        reclaimIdentity = { device: metadata.dev, inode: metadata.ino };
        await reclaimHandle.close();
        reclaimHandle = undefined;
    } catch (error) {
        await reclaimHandle?.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!await removeAbandonedReclaim(reclaimPath)) return false;
        return quarantineStaleLock(path, dataRoot);
    }

    let stale: BoundTokenFile | undefined;
    try {
        stale = await openBoundTokenFile(path);
        if (
            stale.record.dataRoot !== dataRoot
            || !isLiveProcessIdentifier(stale.record.pid)
            || !stale.record.token
        ) {
            return false;
        }
        try {
            process.kill(stale.record.pid, 0);
            return false;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
        }

        return await quarantineBoundTokenFile(path, stale, stale.record.token);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        return false;
    } finally {
        await stale?.handle.close().catch(() => undefined);
        if (reclaimIdentity) {
            await removeOwnedTokenFile(reclaimPath, reclaimToken, reclaimIdentity)
                .catch(() => undefined);
        }
    }
}

async function removeAbandonedReclaim(path: string): Promise<boolean> {
    let reclaim: BoundTokenFile | undefined;
    try {
        reclaim = await openBoundTokenFile(path);
        if (!isLiveProcessIdentifier(reclaim.record.pid) || !reclaim.record.token) return false;
        try {
            process.kill(reclaim.record.pid, 0);
            return false;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
        }
        return await quarantineBoundTokenFile(path, reclaim, reclaim.record.token);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
    } finally {
        await reclaim?.handle.close().catch(() => undefined);
    }
}

async function removeOwnedTokenFile(
    path: string,
    token: string,
    identity?: { device: bigint; inode: bigint },
): Promise<boolean> {
    let bound: BoundTokenFile | undefined;
    try {
        bound = await openBoundTokenFile(path);
        if (
            bound.record.token !== token
            || (identity && (
                bound.device !== identity.device
                || bound.inode !== identity.inode
            ))
        ) {
            return false;
        }
        return await quarantineBoundTokenFile(path, bound, token);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    } finally {
        await bound?.handle.close().catch(() => undefined);
    }
}

async function openBoundTokenFile(path: string): Promise<BoundTokenFile> {
    const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
        const metadata = await handle.stat({ bigint: true });
        if (
            !metadata.isFile()
            || metadata.isSymbolicLink()
            || metadata.size <= BigInt(0)
            || metadata.size > BigInt(16_384)
        ) {
            throw managedError('COORDINATOR_UNAVAILABLE', 'The coordinator lock is invalid.', true);
        }
        const record = JSON.parse(await handle.readFile('utf8')) as BoundTokenFile['record'];
        return {
            handle,
            device: metadata.dev,
            inode: metadata.ino,
            record,
        };
    } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}

async function quarantineBoundTokenFile(
    path: string,
    expected: BoundTokenFile,
    token: string,
): Promise<boolean> {
    const quarantined = `${path}.stale-${randomUUID()}`;
    let renamed = false;
    try {
        await rename(path, quarantined);
        renamed = true;
        let moved: BoundTokenFile | undefined;
        try {
            moved = await openBoundTokenFile(quarantined);
            if (
                moved.device !== expected.device
                || moved.inode !== expected.inode
                || moved.record.token !== token
            ) {
                await restoreWithoutOverwrite(quarantined, path);
                return false;
            }
        } finally {
            await moved?.handle.close().catch(() => undefined);
        }
        await rm(quarantined);
        renamed = false;
        await fsyncDirectory(dirname(path));
        return true;
    } catch (error) {
        if (renamed) await restoreWithoutOverwrite(quarantined, path).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

async function restoreWithoutOverwrite(quarantined: string, destination: string): Promise<void> {
    try {
        // link() is create-only. Unlike rename(), it cannot overwrite a successor coordinator lock.
        await link(quarantined, destination);
        await rm(quarantined);
        await fsyncDirectory(dirname(destination));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A successor owns the canonical path. Preserve the quarantined file for diagnosis rather
        // than deleting either authority record.
    }
}

function isLiveProcessIdentifier(value: number | undefined): value is number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0;
}
