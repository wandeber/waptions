import { describe, expect, it } from 'vitest';
import { IndexedDBAdapter } from './indexeddb-adapter';

function createTransactionalDatabase(values: Map<string, unknown>): IDBDatabase {
    return {
        close: () => undefined,
        transaction: () => {
            const staged = new Map(values);
            let pending = 0;
            let aborted = false;
            let completionQueued = false;
            const transaction = {
                error: null,
                oncomplete: null,
                onabort: null,
                onerror: null,
                abort: () => {
                    if (aborted) return;
                    aborted = true;
                    queueMicrotask(() => transaction.onabort?.(new Event('abort')));
                },
                objectStore: () => ({
                    put: (record: { id: string; data: unknown }) => makeRequest('put', record.id, record.data),
                    delete: (key: string) => makeRequest('delete', key),
                }),
            } as unknown as IDBTransaction;

            const makeRequest = (type: 'put' | 'delete', key: string, value?: unknown): IDBRequest => {
                pending += 1;
                const request = { error: null, onerror: null } as unknown as IDBRequest;
                queueMicrotask(() => {
                    if (aborted) return;
                    if (key === 'fail') {
                        Object.defineProperty(request, 'error', {
                            value: new DOMException('Synthetic write failure.', 'QuotaExceededError'),
                        });
                        request.onerror?.(new Event('error'));
                        return;
                    }
                    if (type === 'put') staged.set(key, value);
                    else staged.delete(key);
                    pending -= 1;
                    if (pending === 0 && !completionQueued) {
                        completionQueued = true;
                        queueMicrotask(() => {
                            if (aborted) return;
                            values.clear();
                            staged.forEach((item, itemKey) => values.set(itemKey, item));
                            transaction.oncomplete?.(new Event('complete'));
                        });
                    }
                });
                return request;
            };
            return transaction;
        },
    } as unknown as IDBDatabase;
}

describe('IndexedDBAdapter.batch', () => {
    it('commits every operation together on transaction completion', async () => {
        const values = new Map<string, unknown>([['old', 'value']]);
        const adapter = new IndexedDBAdapter<unknown>('test', 'timeline');
        Object.defineProperty(adapter, 'getDB', { value: async () => createTransactionalDatabase(values) });

        await adapter.batch([
            { type: 'put', key: 'manifest', value: { revision: 2 } },
            { type: 'delete', key: 'old' },
        ]);

        expect(values).toEqual(new Map([['manifest', { revision: 2 }]]));
    });

    it('does not expose a partial manifest write when a later Blob write aborts', async () => {
        const previous = { revision: 1 };
        const values = new Map<string, unknown>([['manifest', previous]]);
        const adapter = new IndexedDBAdapter<unknown>('test', 'timeline');
        Object.defineProperty(adapter, 'getDB', { value: async () => createTransactionalDatabase(values) });

        await expect(adapter.batch<unknown>([
            { type: 'put', key: 'manifest', value: { revision: 2 } },
            { type: 'put', key: 'fail', value: new Blob(['media']) },
        ])).rejects.toThrow('Synthetic write failure');

        expect(values.get('manifest')).toBe(previous);
        expect(values.has('fail')).toBe(false);
    });
});
