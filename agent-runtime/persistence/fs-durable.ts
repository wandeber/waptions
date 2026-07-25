import { constants } from 'node:fs';
import {
    chmod,
    mkdir,
    open,
    readFile,
    rename,
    rm,
    stat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface PersistenceFaultInjector {
    hit(point: string): void | Promise<void>;
}

export const NO_PERSISTENCE_FAULTS: PersistenceFaultInjector = {
    hit: () => undefined,
};

export async function ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700).catch(() => undefined);
}

export async function fsyncDirectory(path: string): Promise<void> {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY);
        await handle.sync();
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windows and a few filesystems reject directory handles. Atomic rename still applies;
        // supported POSIX hosts retain the stronger directory durability guarantee.
        if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM', 'EACCES'].includes(code ?? '')) throw error;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

export async function atomicWriteFile(
    path: string,
    bytes: string | Uint8Array,
    options: {
        mode?: number;
        injector?: PersistenceFaultInjector;
        faultPrefix?: string;
    } = {},
): Promise<void> {
    const parent = dirname(path);
    const injector = options.injector ?? NO_PERSISTENCE_FAULTS;
    const prefix = options.faultPrefix ?? 'atomic-write';
    await ensurePrivateDirectory(parent);
    const temporary = join(parent, `.${randomUUID()}.tmp`);
    let handle;
    try {
        handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, options.mode ?? 0o600);
        await injector.hit(`${prefix}:opened`);
        await handle.writeFile(bytes);
        await injector.hit(`${prefix}:written`);
        await handle.sync();
        await injector.hit(`${prefix}:file-synced`);
        await handle.close();
        handle = undefined;
        await injector.hit(`${prefix}:closed`);
        await rename(temporary, path);
        await injector.hit(`${prefix}:renamed`);
        await fsyncDirectory(parent);
        await injector.hit(`${prefix}:directory-synced`);
    } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}

export async function atomicWriteJson(
    path: string,
    value: unknown,
    options?: Parameters<typeof atomicWriteFile>[2],
): Promise<void> {
    await atomicWriteFile(path, `${JSON.stringify(value)}\n`, options);
}

export async function readJsonFile<T>(path: string, maxBytes = 16 * 1024 * 1024): Promise<T | null> {
    let metadata;
    try {
        metadata = await stat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
    if (
        !metadata.isFile()
        || !Number.isSafeInteger(metadata.size)
        || metadata.size < 0
        || metadata.size > maxBytes
    ) {
        throw new Error('Managed runtime JSON file is unavailable or oversized.');
    }
    return JSON.parse(await readFile(path, 'utf8')) as T;
}
