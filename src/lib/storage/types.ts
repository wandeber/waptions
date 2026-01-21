export interface StorageAdapter<T> {
    get(key: string): Promise<T | null>;
    set(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
    list(): Promise<string[]>;
    clear(): Promise<void>;
}

export interface StorageConfig {
    projectsDb: string;
    timelineDb: string;
    version: number;
}

export interface SerializedProject {
    id: string;
    name: string;
    thumbnail?: string;
    duration?: number;
    createdAt: string;
    updatedAt: string;
}
