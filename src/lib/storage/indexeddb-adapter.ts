import { StorageAdapter } from './types';

export type IndexedDBBatchOperation<T = unknown> =
    | { type: 'put'; key: string; value: T }
    | { type: 'delete'; key: string };

interface TransactionControls<R> {
    setResult: (result: R) => void;
    failRequest: (request: IDBRequest) => void;
}

export class IndexedDBAdapter<T> implements StorageAdapter<T> {
    private dbName: string;
    private storeName: string;
    private version: number;

    constructor(dbName: string, storeName: string, version = 1) {
        this.dbName = dbName;
        this.storeName = storeName;
        this.version = version;
    }

    private async getDB(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                // Another tab upgrading or deleting this project must not be held hostage by a
                // stale connection. Every operation also closes its connection on settlement.
                db.onversionchange = () => db.close();
                resolve(db);
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'id' });
                }
            };
        });
    }

    /**
     * Runs one transaction and settles only from the transaction lifecycle. Request success is
     * not durability: IndexedDB may still abort before oncomplete, so writes must never resolve
     * from individual request callbacks.
     */
    private async runTransaction<R>(
        mode: IDBTransactionMode,
        run: (store: IDBObjectStore, controls: TransactionControls<R>) => void,
    ): Promise<R> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            let result: R;
            let requestError: DOMException | null = null;
            let settled = false;
            let transaction: IDBTransaction;

            const finish = (error?: unknown) => {
                if (settled) return;
                settled = true;
                db.close();
                if (error !== undefined) reject(error);
                else resolve(result);
            };

            try {
                transaction = db.transaction([this.storeName], mode);
            } catch (error) {
                finish(error);
                return;
            }

            transaction.oncomplete = () => finish();
            transaction.onabort = () => finish(requestError ?? transaction.error ?? new Error('IndexedDB transaction aborted.'));
            transaction.onerror = () => finish(requestError ?? transaction.error ?? new Error('IndexedDB transaction failed.'));

            const controls: TransactionControls<R> = {
                setResult: (nextResult) => {
                    result = nextResult;
                },
                failRequest: (request) => {
                    requestError = request.error ?? new DOMException('IndexedDB request failed.', 'UnknownError');
                    try {
                        transaction.abort();
                    } catch {
                        // The transaction may already be aborting. Its lifecycle event still
                        // owns final settlement and connection cleanup.
                    }
                },
            };

            try {
                run(transaction.objectStore(this.storeName), controls);
            } catch (error) {
                requestError = error instanceof DOMException
                    ? error
                    : new DOMException(error instanceof Error ? error.message : 'IndexedDB operation failed.');
                try {
                    transaction.abort();
                } catch {
                    finish(error);
                }
            }
        });
    }

    async get(key: string): Promise<T | null> {
        return this.runTransaction<T | null>('readonly', (store, controls) => {
            controls.setResult(null);
            const request = store.get(key);
            request.onerror = () => controls.failRequest(request);
            request.onsuccess = () => controls.setResult(request.result?.data ?? null);
        });
    }

    async getMany<Value = T>(keys: readonly string[]): Promise<Map<string, Value | null>> {
        return this.runTransaction<Map<string, Value | null>>('readonly', (store, controls) => {
            const values = new Map<string, Value | null>();
            keys.forEach((key) => values.set(key, null));
            controls.setResult(values);

            keys.forEach((key) => {
                const request = store.get(key);
                request.onerror = () => controls.failRequest(request);
                request.onsuccess = () => values.set(key, request.result?.data ?? null);
            });
        });
    }

    async set(key: string, value: T): Promise<void> {
        await this.batch([{ type: 'put', key, value }]);
    }

    async remove(key: string): Promise<void> {
        await this.batch([{ type: 'delete', key }]);
    }

    async batch<Value = T>(operations: readonly IndexedDBBatchOperation<Value>[]): Promise<void> {
        await this.runTransaction<void>('readwrite', (store, controls) => {
            controls.setResult(undefined);
            operations.forEach((operation) => {
                const request = operation.type === 'put'
                    ? store.put({ id: operation.key, data: operation.value })
                    : store.delete(operation.key);
                request.onerror = () => controls.failRequest(request);
            });
        });
    }

    async list(): Promise<string[]> {
        return this.runTransaction<string[]>('readonly', (store, controls) => {
            controls.setResult([]);
            const request = store.getAllKeys();
            request.onerror = () => controls.failRequest(request);
            request.onsuccess = () => controls.setResult(request.result as string[]);
        });
    }

    async clear(): Promise<void> {
        await this.runTransaction<void>('readwrite', (store, controls) => {
            controls.setResult(undefined);
            const request = store.clear();
            request.onerror = () => controls.failRequest(request);
        });
    }

    async calculateSize(): Promise<number> {
        return this.runTransaction<number>('readonly', (store, controls) => {
            let totalSize = 0;
            controls.setResult(totalSize);
            const request = store.openCursor();

            request.onerror = () => controls.failRequest(request);
            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
                if (!cursor) {
                    controls.setResult(totalSize);
                    return;
                }
                const value = cursor.value.data;
                if (value instanceof Blob) {
                    totalSize += value.size;
                } else if (typeof value === 'string') {
                    totalSize += value.length * 2;
                } else if (value && typeof value === 'object') {
                    totalSize += JSON.stringify(value).length * 2;
                }
                cursor.continue();
            };
        });
    }

    static async listDatabases(): Promise<string[]> {
        if (typeof indexedDB === 'undefined' || !indexedDB.databases) {
            return [];
        }
        const dbs = await indexedDB.databases();
        return dbs.map((db) => db.name || '').filter(Boolean);
    }
}
