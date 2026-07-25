import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ManagedProjectEnvelopeV1 } from '../coordinator/types';
import { managedError } from '../coordinator/errors';
import { canonicalDigest } from './canonical-json';
import {
    atomicWriteFile,
    atomicWriteJson,
    ensurePrivateDirectory,
    fsyncDirectory,
    NO_PERSISTENCE_FAULTS,
    type PersistenceFaultInjector,
    readJsonFile,
} from './fs-durable';

export interface DurableReceipt<Result = unknown> {
    schemaVersion: 1;
    projectId: string;
    toolName: string;
    idempotencyKey: string;
    requestHash: string;
    result: Result;
    committedSessionRevision: number;
    createdAt: string;
    retainedSourceIds: readonly string[];
}

export interface DurableWrite {
    relativePath: string;
    value?: unknown;
    delete?: true;
    mode?: number;
}

export interface ManagedTransaction<State = unknown> {
    schemaVersion: 1;
    transactionId: string;
    projectId: string;
    baseSessionRevision: number;
    nextSessionRevision: number;
    envelope: ManagedProjectEnvelopeV1<State>;
    writes: readonly DurableWrite[];
    createdAt: string;
}

export interface StoreTransactionInput<State = unknown> {
    envelope: ManagedProjectEnvelopeV1<State>;
    baseSessionRevision: number;
    writes?: readonly DurableWrite[];
}

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const MANAGED_STATE_JSON_MAX_BYTES = 64 * 1024 * 1024;
export const MANAGED_WAL_JSON_MAX_BYTES = 80 * 1024 * 1024;
export const MANAGED_RECEIPT_JSON_MAX_BYTES = 1024 * 1024;
export const MANAGED_EVENT_JSON_MAX_BYTES = 64 * 1024;
export const MANAGED_JOB_JSON_MAX_BYTES = 2 * 1024 * 1024;
export const MANAGED_METADATA_JSON_MAX_BYTES = 256 * 1024;

/**
 * Filesystem persistence with a redo WAL.
 *
 * The committed marker is the linearization point. A crash before it preserves the old
 * revision; a crash after it causes recovery to replay every write and publish the complete
 * new revision. Callers must stop using an instance after a transaction error.
 */
export class ManagedFilesystemStore {
    readonly projectsRoot: string;
    readonly coordinatorRoot: string;

    constructor(
        readonly dataRoot: string,
        private readonly injector: PersistenceFaultInjector = NO_PERSISTENCE_FAULTS,
    ) {
        this.dataRoot = resolve(dataRoot);
        this.projectsRoot = join(this.dataRoot, 'projects');
        this.coordinatorRoot = join(this.dataRoot, 'coordinator');
    }

    async initialize(): Promise<void> {
        await Promise.all([
            ensurePrivateDirectory(this.dataRoot),
            ensurePrivateDirectory(this.projectsRoot),
            ensurePrivateDirectory(this.coordinatorRoot),
        ]);
        await this.recover();
    }

    async recover(): Promise<void> {
        for (const projectId of await this.listProjectIds()) {
            await this.recoverProject(projectId);
        }
    }

    async recoverProject(projectId: string): Promise<void> {
        const walRoot = this.projectPath(projectId, 'wal');
        let entries: string[] = [];
        try {
            entries = await readdir(walRoot);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const transactionIds = entries
            .filter((entry) => entry.endsWith('.json'))
            .map((entry) => entry.slice(0, -5))
            .sort();
        for (const transactionId of transactionIds) {
            const walPath = join(walRoot, `${transactionId}.json`);
            const markerPath = join(walRoot, `${transactionId}.commit`);
            const transaction = await readJsonFile<ManagedTransaction>(
                walPath,
                MANAGED_WAL_JSON_MAX_BYTES,
            );
            if (!transaction) continue;
            if (!await isRegularFile(markerPath)) {
                await rm(walPath, { force: true });
                continue;
            }
            const expectedMarker = `${canonicalDigest(transaction, MANAGED_WAL_JSON_MAX_BYTES)}\n`;
            if (await readFile(markerPath, 'utf8') !== expectedMarker) {
                throw new Error('Managed transaction commit marker is corrupt.');
            }
            await this.replay(transaction);
            await this.cleanupWal(walPath, markerPath);
        }
    }

    async listProjectIds(): Promise<string[]> {
        let entries;
        try {
            entries = await readdir(this.projectsRoot, { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
        return entries
            .filter((entry) => entry.isDirectory() && PROJECT_ID.test(entry.name))
            .map((entry) => entry.name)
            .sort();
    }

    async readProject<State>(projectId: string): Promise<ManagedProjectEnvelopeV1<State> | null> {
        return readJsonFile(this.projectPath(projectId, 'state.json'), MANAGED_STATE_JSON_MAX_BYTES);
    }

    async createProject<State>(envelope: ManagedProjectEnvelopeV1<State>): Promise<void> {
        const root = this.projectPath(envelope.projectId);
        await ensurePrivateDirectory(root);
        for (const namespace of ['wal', 'receipts', 'jobs', 'events', 'artifacts', 'grants']) {
            await ensurePrivateDirectory(join(root, namespace));
        }
        const statePath = join(root, 'state.json');
        const serializedEnvelope = serializeBoundedJson(
            envelope,
            MANAGED_STATE_JSON_MAX_BYTES,
            'managed project snapshot',
        );
        let handle;
        try {
            handle = await open(
                statePath,
                constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
                0o600,
            );
            await handle.writeFile(serializedEnvelope);
            await handle.sync();
        } finally {
            await handle?.close().catch(() => undefined);
        }
        await fsyncDirectory(root);
    }

    async transact<State>(input: StoreTransactionInput<State>): Promise<string> {
        const transactionId = `${Date.now().toString(36)}-${randomUUID()}`;
        const transaction: ManagedTransaction<State> = {
            schemaVersion: 1,
            transactionId,
            projectId: input.envelope.projectId,
            baseSessionRevision: input.baseSessionRevision,
            nextSessionRevision: input.envelope.sessionRevision,
            envelope: input.envelope,
            writes: input.writes ?? [],
            createdAt: new Date().toISOString(),
        };
        serializeBoundedJson(
            transaction.envelope,
            MANAGED_STATE_JSON_MAX_BYTES,
            'managed project snapshot',
        );
        for (const write of transaction.writes) validateDurableWrite(write);
        const serializedTransaction = serializeBoundedJson(
            transaction,
            MANAGED_WAL_JSON_MAX_BYTES,
            'managed transaction WAL',
        );
        const walRoot = this.projectPath(transaction.projectId, 'wal');
        await ensurePrivateDirectory(walRoot);
        const walPath = join(walRoot, `${transactionId}.json`);
        const markerPath = join(walRoot, `${transactionId}.commit`);

        await atomicWriteFile(walPath, serializedTransaction, {
            injector: this.injector,
            faultPrefix: 'transaction:wal',
        });
        await this.injector.hit('transaction:wal-durable');
        await atomicWriteFile(
            markerPath,
            `${canonicalDigest(transaction, MANAGED_WAL_JSON_MAX_BYTES)}\n`,
            {
            injector: this.injector,
            faultPrefix: 'transaction:commit-marker',
            },
        );
        await this.injector.hit('transaction:committed');
        await this.replay(transaction);
        await this.injector.hit('transaction:replayed');
        await this.cleanupWal(walPath, markerPath);
        await this.injector.hit('transaction:cleaned');
        return transactionId;
    }

    async readReceipt<Result>(
        projectId: string,
        toolName: string,
        idempotencyKey: string,
    ): Promise<DurableReceipt<Result> | null> {
        return readJsonFile(
            this.receiptPath(projectId, toolName, idempotencyKey),
            MANAGED_RECEIPT_JSON_MAX_BYTES,
        );
    }

    receiptWrite(receipt: DurableReceipt): DurableWrite {
        return {
            relativePath: relative(
                this.projectPath(receipt.projectId),
                this.receiptPath(receipt.projectId, receipt.toolName, receipt.idempotencyKey),
            ),
            value: receipt,
        };
    }

    async receiptRetentionDeletes(
        projectId: string,
        now = Date.now(),
        maximumCount = 10_000,
        maximumAgeMilliseconds = 30 * 24 * 60 * 60 * 1000,
    ): Promise<DurableWrite[]> {
        const receipts = await this.readNamespace<DurableReceipt>(projectId, 'receipts');
        const retained = receipts
            .filter((receipt) => Date.parse(receipt.createdAt) >= now - maximumAgeMilliseconds)
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
            .slice(-maximumCount);
        const retainedScopes = new Set(
            retained.map((receipt) => `${receipt.toolName}\0${receipt.idempotencyKey}`),
        );
        return receipts
            .filter((receipt) => !retainedScopes.has(`${receipt.toolName}\0${receipt.idempotencyKey}`))
            .map((receipt) => ({
                relativePath: relative(
                    this.projectPath(projectId),
                    this.receiptPath(projectId, receipt.toolName, receipt.idempotencyKey),
                ),
                delete: true as const,
            }));
    }

    projectPath(projectId: string, ...segments: string[]): string {
        if (!PROJECT_ID.test(projectId)) throw new Error('Invalid managed project identifier.');
        const root = join(this.projectsRoot, projectId);
        return safeJoin(root, ...segments);
    }

    async readNamespace<T>(projectId: string, namespace: string): Promise<T[]> {
        const root = this.projectPath(projectId, namespace);
        let names: string[] = [];
        try {
            names = await readdir(root);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
        const values: T[] = [];
        for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
            const value = await readJsonFile<T>(
                safeJoin(root, name),
                namespaceJsonLimit(namespace),
            );
            if (value) values.push(value);
        }
        return values;
    }

    private receiptPath(projectId: string, toolName: string, idempotencyKey: string): string {
        const scopeHash = canonicalDigest({ projectId, toolName, idempotencyKey }).slice(7);
        return this.projectPath(projectId, 'receipts', `${scopeHash}.json`);
    }

    private async replay(transaction: ManagedTransaction): Promise<void> {
        const current = await this.readProject(transaction.projectId);
        if (
            current
            && current.sessionRevision !== transaction.baseSessionRevision
            && current.sessionRevision !== transaction.nextSessionRevision
        ) {
            throw new Error('WAL base revision does not match the durable project state.');
        }
        for (let index = 0; index < transaction.writes.length; index += 1) {
            const write = transaction.writes[index];
            const path = this.transactionWritePath(transaction.projectId, write.relativePath);
            if (write.delete) {
                await rm(path, { force: true });
                await fsyncDirectory(dirname(path));
            } else {
                await atomicWriteJson(path, write.value, {
                    mode: write.mode,
                    injector: this.injector,
                    faultPrefix: `transaction:write:${index}`,
                });
            }
            await this.injector.hit(`transaction:write:${index}:published`);
        }
        await atomicWriteJson(this.projectPath(transaction.projectId, 'state.json'), transaction.envelope, {
            injector: this.injector,
            faultPrefix: 'transaction:state',
        });
        await this.injector.hit('transaction:state-published');
    }

    private transactionWritePath(projectId: string, path: string): string {
        if (!path || path.includes('\0') || resolve(path) === path) {
            throw new Error('Transaction paths must be safe project-relative paths.');
        }
        return safeJoin(this.projectPath(projectId), ...path.split(/[\\/]/));
    }

    private async cleanupWal(walPath: string, markerPath: string): Promise<void> {
        await Promise.all([rm(walPath, { force: true }), rm(markerPath, { force: true })]);
        await fsyncDirectory(dirname(walPath));
    }
}

function validateDurableWrite(write: DurableWrite): void {
    if (write.delete) return;
    const namespace = write.relativePath.split(/[\\/]/, 1)[0];
    serializeBoundedJson(
        write.value,
        namespaceJsonLimit(namespace),
        `managed ${namespace || 'metadata'} record`,
    );
}

function namespaceJsonLimit(namespace: string): number {
    switch (namespace) {
        case 'receipts':
            return MANAGED_RECEIPT_JSON_MAX_BYTES;
        case 'events':
            return MANAGED_EVENT_JSON_MAX_BYTES;
        case 'jobs':
            return MANAGED_JOB_JSON_MAX_BYTES;
        case 'artifacts':
        case 'grants':
            return MANAGED_METADATA_JSON_MAX_BYTES;
        default:
            return MANAGED_METADATA_JSON_MAX_BYTES;
    }
}

function serializeBoundedJson(value: unknown, maximumBytes: number, label: string): string {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
        throw managedError('INVALID_REQUEST', `The ${label} is not valid JSON.`);
    }
    const serialized = `${encoded}\n`;
    if (Buffer.byteLength(serialized) > maximumBytes) {
        throw managedError(
            'PAYLOAD_TOO_LARGE',
            `The ${label} exceeds its durable size limit.`,
        );
    }
    return serialized;
}

function safeJoin(root: string, ...segments: string[]): string {
    const canonicalRoot = resolve(root);
    const candidate = resolve(canonicalRoot, ...segments);
    if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}${sep}`)) {
        throw new Error('Managed persistence path escapes its namespace.');
    }
    return candidate;
}

async function isRegularFile(path: string): Promise<boolean> {
    try {
        const metadata = await lstat(path);
        return metadata.isFile() && !metadata.isSymbolicLink();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}
