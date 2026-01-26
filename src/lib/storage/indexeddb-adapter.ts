import { StorageAdapter } from "./types";

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
            request.onsuccess = () => resolve(request.result);

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: "id" });
                }
            };
        });
    }

    async get(key: string): Promise<T | null> {
        const db = await this.getDB();
        const transaction = db.transaction([this.storeName], "readonly");
        const store = transaction.objectStore(this.storeName);

        return new Promise((resolve, reject) => {
            const request = store.get(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result?.data || null);
        });
    }

    async set(key: string, value: T): Promise<void> {
        const db = await this.getDB();
        const transaction = db.transaction([this.storeName], "readwrite");
        const store = transaction.objectStore(this.storeName);

        return new Promise((resolve, reject) => {
            // Wrap value in an object if it's not one, or ensure it has an id if we use keyPath
            // But here we use 'put' which works with keyPath 'id'.
            // The implementation in OpenCut was: store.put({ id: key, ...value });
            // But T might already have id.
            // To be safe and generic, let's store it as { id: key, data: value } to avoid collision if T doesn't have id
            // OR force T to extend object.
            // OpenCut implementation assumes value spreads into object with id.
            // Let's modify usage to match OpenCut's logic closer but strictly:
            // We will store { id: key, data: value } so we don't intrude on T structure.
            // Wait, OpenCut `get` returns `request.result`. If we store {id, ...value}, then result is {id, ...value}.
            // My `get` implementation above used `result?.data`. I should align `set` to match `get`.

            const request = store.put({ id: key, data: value });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    async remove(key: string): Promise<void> {
        const db = await this.getDB();
        const transaction = db.transaction([this.storeName], "readwrite");
        const store = transaction.objectStore(this.storeName);

        return new Promise((resolve, reject) => {
            const request = store.delete(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    async list(): Promise<string[]> {
        const db = await this.getDB();
        const transaction = db.transaction([this.storeName], "readonly");
        const store = transaction.objectStore(this.storeName);

        return new Promise((resolve, reject) => {
            const request = store.getAllKeys();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result as string[]);
        });
    }

    async clear(): Promise<void> {
        const db = await this.getDB();
        const transaction = db.transaction([this.storeName], "readwrite");
        const store = transaction.objectStore(this.storeName);

        return new Promise((resolve, reject) => {
            const request = store.clear();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    async calculateSize(): Promise<number> {
        const db = await this.getDB();
        const transaction = db.transaction([this.storeName], "readonly");
        const store = transaction.objectStore(this.storeName);

        return new Promise((resolve, reject) => {
            let totalSize = 0;
            const request = store.openCursor();

            request.onerror = () => reject(request.error);
            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
                if (cursor) {
                    const value = cursor.value.data;
                    if (value instanceof Blob || value instanceof File) {
                        totalSize += value.size;
                    } else if (typeof value === 'string') {
                        totalSize += value.length * 2; // Rough estimate for UTF-16
                    } else if (value && typeof value === 'object') {
                        totalSize += JSON.stringify(value).length * 2;
                    }
                    cursor.continue();
                } else {
                    resolve(totalSize);
                }
            };
        });
    }

    static async listDatabases(): Promise<string[]> {
        if (!window.indexedDB.databases) {
            return [];
        }
        const dbs = await window.indexedDB.databases();
        return dbs.map(db => db.name || '').filter(Boolean);
    }
}
