import { Readable } from 'node:stream';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type FsPromises = typeof import('node:fs/promises');
type StatHook = (path: string, actual: FsPromises) => Promise<void>;

const hooks = vi.hoisted(() => ({
    afterStat: undefined as StatHook | undefined,
}));

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<FsPromises>('node:fs/promises');
    return {
        ...actual,
        stat: async (...args: unknown[]) => {
            const metadata = await (actual.stat as (...values: unknown[]) => Promise<unknown>)(...args);
            await hooks.afterStat?.(String(args[0]), actual);
            return metadata;
        },
    };
});

import { ArtifactRegistry } from './artifact-registry';
import { ManagedFilesystemStore } from '../persistence/managed-filesystem-store';
import { temporaryRuntime, testEnvelope } from '../testing/runtime-test-helpers';

let fs: FsPromises;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    fs = await vi.importActual<FsPromises>('node:fs/promises');
});

afterEach(async () => {
    hooks.afterStat = undefined;
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('ArtifactRegistry publication races', () => {
    it('honors cancellation during final deduplication and reaps only its own staging', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('artifact-final-abort');
        await store.createProject(envelope);
        const registry = new ArtifactRegistry(store, Buffer.alloc(32, 21));
        const first = await registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('shared-content')]),
        );

        const controller = new AbortController();
        hooks.afterStat = async (path) => {
            if (path.endsWith('.blob')) controller.abort();
        };
        await expect(registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('shared-content')]),
            { signal: controller.signal },
        )).rejects.toMatchObject({ name: 'AbortError' });
        expect(await fs.readdir(store.projectPath(
            envelope.projectId,
            'artifacts',
            'staging',
        ))).toEqual([]);

        hooks.afterStat = undefined;
        await first.reject();
    });
});
