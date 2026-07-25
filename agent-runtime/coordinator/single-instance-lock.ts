import { constants } from 'node:fs';
import { lstat, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { managedError } from './errors';
import { ensurePrivateDirectory, fsyncDirectory } from '../persistence/fs-durable';

interface LockRecord {
    schemaVersion: 1;
    pid: number;
    dataRoot: string;
    token: string;
    createdAt: string;
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
            let handle;
            try {
                handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
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
        try {
            const [metadata, raw] = await Promise.all([
                stat(this.path, { bigint: true }),
                readFile(this.path, 'utf8'),
            ]);
            const record = JSON.parse(raw) as LockRecord;
            if (metadata.dev !== this.device || metadata.ino !== this.inode || record.token !== this.token) {
                return;
            }
            await rm(this.path);
            await fsyncDirectory(dirname(this.path));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
}

async function quarantineStaleLock(path: string, dataRoot: string): Promise<boolean> {
    let metadata;
    let record: LockRecord | null = null;
    try {
        metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
        record = JSON.parse(await readFile(path, 'utf8')) as LockRecord;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    }
    if (record?.dataRoot !== dataRoot || !Number.isSafeInteger(record?.pid) || (record?.pid ?? 0) <= 0) {
        return false;
    }
    try {
        process.kill(record.pid, 0);
        return false;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') return false;
    }

    const quarantined = `${path}.stale-${randomUUID()}`;
    try {
        await rename(path, quarantined);
        await fsyncDirectory(dataRoot);
        await rm(quarantined, { force: true });
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
}
