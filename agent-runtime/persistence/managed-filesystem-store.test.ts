import { afterEach, describe, expect, it } from 'vitest';
import {
    MANAGED_STATE_JSON_MAX_BYTES,
    ManagedFilesystemStore,
    type DurableReceipt,
} from './managed-filesystem-store';
import { readdir } from 'node:fs/promises';
import type { PersistenceFaultInjector } from './fs-durable';
import { testEnvelope, temporaryRuntime } from '../testing/runtime-test-helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

const FAULT_POINTS = [
    'transaction:wal:opened',
    'transaction:wal:written',
    'transaction:wal:file-synced',
    'transaction:wal:closed',
    'transaction:wal:renamed',
    'transaction:wal:directory-synced',
    'transaction:wal-durable',
    'transaction:commit-marker:opened',
    'transaction:commit-marker:written',
    'transaction:commit-marker:file-synced',
    'transaction:commit-marker:closed',
    'transaction:commit-marker:renamed',
    'transaction:commit-marker:directory-synced',
    'transaction:committed',
    'transaction:write:0:opened',
    'transaction:write:0:written',
    'transaction:write:0:file-synced',
    'transaction:write:0:closed',
    'transaction:write:0:renamed',
    'transaction:write:0:directory-synced',
    'transaction:write:0:published',
    'transaction:state:opened',
    'transaction:state:written',
    'transaction:state:file-synced',
    'transaction:state:closed',
    'transaction:state:renamed',
    'transaction:state:directory-synced',
    'transaction:state-published',
    'transaction:replayed',
    'transaction:cleaned',
] as const;

describe('ManagedFilesystemStore', () => {
    for (const faultPoint of FAULT_POINTS) {
        it(`recovers a complete old or new revision after ${faultPoint}`, async () => {
            const runtime = await temporaryRuntime();
            cleanups.push(runtime.cleanup);
            const baseStore = new ManagedFilesystemStore(runtime.path);
            await baseStore.initialize();
            const initial = testEnvelope();
            await baseStore.createProject(initial);
            let fired = false;
            const injector: PersistenceFaultInjector = {
                hit: (point) => {
                    if (!fired && point === faultPoint) {
                        fired = true;
                        throw new Error(`Injected fault: ${point}`);
                    }
                },
            };
            const faultedStore = new ManagedFilesystemStore(runtime.path, injector);
            await expect(faultedStore.transact({
                baseSessionRevision: 0,
                envelope: { ...initial, sessionRevision: 1, receiptRevision: 1 },
                writes: [{
                    relativePath: 'receipts/receipt.json',
                    value: {
                        schemaVersion: 1,
                        projectId: initial.projectId,
                        toolName: 'test',
                        idempotencyKey: 'key',
                        requestHash: 'sha256:test',
                        result: { changed: true },
                        committedSessionRevision: 1,
                        createdAt: new Date().toISOString(),
                        retainedSourceIds: [],
                    } satisfies DurableReceipt,
                }],
            })).rejects.toThrow(`Injected fault: ${faultPoint}`);

            const recoveredStore = new ManagedFilesystemStore(runtime.path);
            await recoveredStore.initialize();
            const recovered = await recoveredStore.readProject(initial.projectId);
            const receipts = await recoveredStore.readNamespace<DurableReceipt>(
                initial.projectId,
                'receipts',
            );
            expect([0, 1]).toContain(recovered?.sessionRevision);
            expect(receipts.length).toBe(recovered?.sessionRevision === 1 ? 1 : 0);
            if (recovered?.sessionRevision === 1) {
                expect(receipts[0].committedSessionRevision).toBe(1);
            }
        });
    }

    it('recovers a near-history-limit snapshot after the commit marker', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const baseStore = new ManagedFilesystemStore(runtime.path);
        await baseStore.initialize();
        const initial = testEnvelope('large-history-project');
        await baseStore.createProject(initial);
        let fired = false;
        const faulted = new ManagedFilesystemStore(runtime.path, {
            hit: (point) => {
                if (!fired && point === 'transaction:committed') {
                    fired = true;
                    throw new Error('kill after marker');
                }
            },
        });
        const historyProjection = 'h'.repeat(32 * 1024 * 1024);
        await expect(faulted.transact({
            baseSessionRevision: 0,
            envelope: {
                ...initial,
                sessionRevision: 1,
                editor: {
                    ...initial.editor,
                    state: { values: [historyProjection] },
                    documentRevision: 1,
                    historyRevision: 1,
                },
            },
        })).rejects.toThrow('kill after marker');

        const recovered = new ManagedFilesystemStore(runtime.path);
        await recovered.initialize();
        const project = await recovered.readProject<{ values: string[] }>(initial.projectId);
        expect(project?.sessionRevision).toBe(1);
        expect(project?.editor.state.values[0]).toHaveLength(historyProjection.length);
    }, 30_000);

    it('rejects an oversized snapshot before creating a WAL file or marker', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const initial = testEnvelope('oversized-project');
        await store.createProject(initial);
        const oversized = 'x'.repeat(MANAGED_STATE_JSON_MAX_BYTES + 1024);
        await expect(store.transact({
            baseSessionRevision: 0,
            envelope: {
                ...initial,
                sessionRevision: 1,
                editor: {
                    ...initial.editor,
                    state: { values: [oversized] },
                },
            },
        })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
        expect(await readdir(store.projectPath(initial.projectId, 'wal'))).toEqual([]);
        expect((await store.readProject(initial.projectId))?.sessionRevision).toBe(0);
    }, 30_000);
});
