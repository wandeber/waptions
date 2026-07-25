import type { FileHandle } from 'node:fs/promises';
import {
    FilesystemHandleAdoptionError,
    FilesystemMediaByteSource,
    type FilesystemStatToken,
} from '../../src/lib/media-byte-source/filesystem-source';
import {
    linkAbortSignals,
    MediaByteSourceError,
    throwIfAborted,
    type CoreMediaIdentity,
    type MediaByteRange,
} from '../../src/lib/media-byte-source/types';
import type {
    ManagedMediaDescriptor,
    ManagedSourceLease,
    ManagedSourceRegistryPort,
    ProbedMediaMetadata,
    VerifiedOpenMediaHandle,
} from '../media/contracts';

interface SourceEntry {
    readonly descriptor: ManagedMediaDescriptor;
    /** Internal audit metadata only; paths never cross the descriptor or lease boundary. */
    readonly canonicalPath: string;
    readonly handle: FileHandle;
    readonly statToken: FilesystemStatToken;
    readonly source: FilesystemMediaByteSource;
    readonly replacementController: AbortController;
    leases: number;
    invalidated: boolean;
    closing: Promise<void> | null;
    cleanupFailure: unknown | null;
    readonly closeWaiters: Array<() => void>;
}

export interface ImmutableSourceRegistryDiagnostics {
    readonly currentSources: number;
    readonly retiredSources: number;
    readonly activeLeases: number;
    readonly peakLeases: number;
    readonly replacements: number;
    readonly invalidations: number;
    readonly closes: number;
    readonly cleanupFailures: number;
    readonly failedOwnedHandles: number;
}

export class ImmutableSourceRegistry implements ManagedSourceRegistryPort {
    private readonly current = new Map<string, SourceEntry>();
    private readonly retired = new Set<SourceEntry>();
    private activeLeases = 0;
    private peakLeases = 0;
    private replacements = 0;
    private invalidations = 0;
    private closes = 0;
    private cleanupFailures = 0;
    private readonly failedHandleCleanup = new Map<FileHandle, unknown>();
    private closed = false;
    private closing: Promise<void> | null = null;
    private mutationTail: Promise<void> = Promise.resolve();

    register(
        capability: VerifiedOpenMediaHandle,
        identity: CoreMediaIdentity,
        metadata: ProbedMediaMetadata,
    ): Promise<ManagedMediaDescriptor> {
        return this.registerBatch([{ handle: capability, identity, metadata }]).then((descriptors) => {
            const descriptor = descriptors[0];
            if (!descriptor) throw new Error('Source registration produced no descriptor.');
            return descriptor;
        });
    }

    registerBatch(entries: readonly {
        handle: VerifiedOpenMediaHandle;
        identity: CoreMediaIdentity;
        metadata: ProbedMediaMetadata;
    }[]): Promise<readonly ManagedMediaDescriptor[]> {
        const operation = this.mutationTail.catch(() => undefined).then(() => (
            this.registerBatchExclusive(entries)
        ));
        this.mutationTail = operation.then(() => undefined, () => undefined);
        return operation;
    }

    private async registerBatchExclusive(entries: readonly {
        handle: VerifiedOpenMediaHandle;
        identity: CoreMediaIdentity;
        metadata: ProbedMediaMetadata;
    }[]): Promise<readonly ManagedMediaDescriptor[]> {
        if (entries.length === 0) return Object.freeze([]);
        if (this.closed) {
            await this.settleRawHandles(entries.map((entry) => entry.handle.handle));
            throw new Error('The immutable source registry is closed.');
        }
        const sourceIds = new Set(entries.map((entry) => entry.handle.sourceId));
        const handles = new Set(entries.map((entry) => entry.handle.handle));
        if (sourceIds.size !== entries.length || handles.size !== entries.length) {
            await this.settleRawHandles(handles);
            throw new Error('A source registration batch contains duplicate source IDs or handles.');
        }

        const prepared: SourceEntry[] = [];
        const consumedHandles = new Set<FileHandle>();
        try {
            for (const entry of entries) {
                // Ownership transfers at call entry, including adoption failures.
                consumedHandles.add(entry.handle.handle);
                const source = await FilesystemMediaByteSource.fromVerifiedHandle({
                    sourceId: entry.handle.sourceId,
                    handle: entry.handle.handle,
                    identity: entry.identity,
                    statToken: entry.handle.statToken,
                });
                prepared.push({
                    descriptor: Object.freeze({
                        sourceId: entry.handle.sourceId,
                        displayName: entry.handle.displayName,
                        identity: source.identity,
                        metadata: freezeMetadata(entry.metadata),
                    }),
                    canonicalPath: entry.handle.canonicalPath,
                    handle: entry.handle.handle,
                    statToken: entry.handle.statToken,
                    source,
                    replacementController: new AbortController(),
                    leases: 0,
                    invalidated: false,
                    closing: null,
                    cleanupFailure: null,
                    closeWaiters: [],
                });
            }
        } catch (error) {
            if (error instanceof FilesystemHandleAdoptionError) {
                const failedHandle = entries
                    .map((entry) => entry.handle.handle)
                    .find((handle) => consumedHandles.has(handle) && !prepared.some(
                        (preparedEntry) => preparedEntry.handle === handle,
                    ));
                if (failedHandle) this.recordFailedHandle(failedHandle, error.cleanupError);
            }
            for (const entry of prepared) this.retireUnpublished(entry);
            await this.settleEntries(prepared);
            await this.settleRawHandles(entries
                .map((entry) => entry.handle.handle)
                .filter((handle) => !consumedHandles.has(handle)));
            throw error;
        }

        const descriptors: ManagedMediaDescriptor[] = [];
        const cleanup: SourceEntry[] = [];
        for (const incoming of prepared) {
            const previous = this.current.get(incoming.descriptor.sourceId);
            if (
                previous
                && previous.descriptor.identity.fingerprint
                    === incoming.descriptor.identity.fingerprint
                && previous.descriptor.identity.sizeBytes
                    === incoming.descriptor.identity.sizeBytes
            ) {
                descriptors.push(previous.descriptor);
                this.retireUnpublished(incoming);
                cleanup.push(incoming);
                continue;
            }
            if (previous) {
                this.replacements++;
                this.invalidate(previous, 'The registered source was replaced.');
                cleanup.push(previous);
            }
            this.current.set(incoming.descriptor.sourceId, incoming);
            descriptors.push(incoming.descriptor);
        }
        // Publication is the transaction boundary. Retired/duplicate cleanup is observable through
        // diagnostics but cannot turn an already-published atomic batch into an apparent failure.
        await this.settleEntries(cleanup);
        return Object.freeze(descriptors);
    }

    async acquire(sourceId: string, signal?: AbortSignal): Promise<ManagedSourceLease> {
        throwIfAborted(signal);
        const entry = this.current.get(sourceId);
        if (!entry || entry.invalidated || this.closed) {
            throw new MediaByteSourceError('SOURCE_NOT_FOUND', `No current source exists for "${sourceId}".`);
        }
        let currentToken: FilesystemStatToken;
        try {
            currentToken = await statToken(entry.handle);
        } catch (error) {
            this.invalidate(entry, 'The registered source became unreadable before review.');
            await this.closeIfUnused(entry);
            throw new MediaByteSourceError(
                'SOURCE_UNREADABLE',
                'The registered media source became unreadable.',
                { cause: error },
            );
        }
        if (!tokensEqual(currentToken, entry.statToken)) {
            this.invalidate(entry, 'The registered source changed before review.');
            await this.closeIfUnused(entry);
            throw new MediaByteSourceError('SOURCE_CHANGED', 'The registered media source changed.');
        }
        throwIfAborted(signal);
        if (entry.invalidated || this.current.get(sourceId) !== entry) {
            throw new MediaByteSourceError('SOURCE_CHANGED', 'The registered media source was replaced.');
        }
        entry.leases++;
        this.activeLeases++;
        this.peakLeases = Math.max(this.peakLeases, this.activeLeases);
        let released = false;
        const assertCurrent = async (assertSignal?: AbortSignal) => {
            if (released) {
                throw new MediaByteSourceError('SOURCE_CLOSED', 'The managed source lease is closed.');
            }
            const linked = linkAbortSignals(
                signal,
                assertSignal,
                entry.replacementController.signal,
            );
            try {
                throwIfAborted(linked.signal);
                let token: FilesystemStatToken;
                try {
                    token = await statToken(entry.handle);
                } catch (error) {
                    this.invalidate(entry, 'The registered source became unreadable during managed work.');
                    throw new MediaByteSourceError(
                        'SOURCE_UNREADABLE',
                        'The registered media source became unreadable.',
                        { cause: error },
                    );
                }
                throwIfAborted(linked.signal);
                if (!tokensEqual(token, entry.statToken)) {
                    this.invalidate(entry, 'The registered source changed during managed work.');
                    throw new MediaByteSourceError('SOURCE_CHANGED', 'The registered media source changed.');
                }
                if (entry.invalidated || this.current.get(sourceId) !== entry) {
                    throw new MediaByteSourceError('SOURCE_CHANGED', 'The registered media source was replaced.');
                }
            } finally {
                linked.dispose();
            }
        };
        return {
            descriptor: entry.descriptor,
            handle: entry.handle,
            replacementSignal: entry.replacementController.signal,
            assertCurrent,
            read: async (range: MediaByteRange, readSignal?: AbortSignal) => {
                if (released) {
                    throw new MediaByteSourceError('SOURCE_CLOSED', 'The managed source lease is closed.');
                }
                const linked = linkAbortSignals(
                    signal,
                    readSignal,
                    entry.replacementController.signal,
                );
                try {
                    return await entry.source.read(range, linked.signal);
                } finally {
                    linked.dispose();
                }
            },
            close: async () => {
                if (released) return;
                released = true;
                entry.leases--;
                this.activeLeases--;
                await this.closeIfUnused(entry);
            },
        };
    }

    diagnostics(): ImmutableSourceRegistryDiagnostics {
        return Object.freeze({
            currentSources: this.current.size,
            retiredSources: this.retired.size,
            activeLeases: this.activeLeases,
            peakLeases: this.peakLeases,
            replacements: this.replacements,
            invalidations: this.invalidations,
            closes: this.closes,
            cleanupFailures: this.cleanupFailures,
            failedOwnedHandles: this.failedHandleCleanup.size,
        });
    }

    assertDrained(): void {
        const diagnostics = this.diagnostics();
        if (
            diagnostics.currentSources !== 0
            || diagnostics.retiredSources !== 0
            || diagnostics.activeLeases !== 0
            || diagnostics.failedOwnedHandles !== 0
        ) {
            throw new Error(
                `Immutable source registry leaked resources: ${JSON.stringify(diagnostics)}`,
            );
        }
    }

    async close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closing = this.mutationTail.catch(() => undefined).then(async () => {
            if (this.closed) return;
            this.closed = true;
            const entries = [...Array.from(this.current.values()), ...Array.from(this.retired)];
            for (const entry of Array.from(this.current.values())) {
                this.invalidate(entry, 'The source registry closed.');
            }
            this.current.clear();
            const settled = await Promise.allSettled(entries.map((entry) => this.whenClosed(entry)));
            const failures = [
                ...settled
                    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                    .map((result) => result.reason),
                ...Array.from(this.failedHandleCleanup.values()),
            ];
            if (failures.length > 0) {
                throw new AggregateError(
                    failures,
                    'The immutable source registry retained resources whose cleanup failed.',
                );
            }
        });
        this.mutationTail = this.closing.then(() => undefined, () => undefined);
        return this.closing;
    }

    private invalidate(entry: SourceEntry, message: string): void {
        if (entry.invalidated) return;
        entry.invalidated = true;
        if (this.current.get(entry.descriptor.sourceId) === entry) {
            this.current.delete(entry.descriptor.sourceId);
        }
        this.retired.add(entry);
        this.invalidations++;
        entry.replacementController.abort(new MediaByteSourceError('SOURCE_CHANGED', message));
    }

    private closeIfUnused(entry: SourceEntry): Promise<void> | null {
        if (!entry.invalidated || entry.leases > 0) return null;
        if (entry.closing) return entry.closing;
        this.closes++;
        entry.closing = entry.source.close()
            .then(() => {
                this.retired.delete(entry);
            })
            .catch((error) => {
                entry.cleanupFailure = error;
                this.cleanupFailures++;
                throw error;
            })
            .finally(() => {
                for (const resolve of entry.closeWaiters.splice(0)) resolve();
            });
        return entry.closing;
    }

    private async whenClosed(entry: SourceEntry): Promise<void> {
        const closing = this.closeIfUnused(entry);
        if (closing) return closing;
        await new Promise<void>((resolve) => entry.closeWaiters.push(resolve));
        await entry.closing;
    }

    private retireUnpublished(entry: SourceEntry): void {
        entry.invalidated = true;
        this.retired.add(entry);
        entry.replacementController.abort(new MediaByteSourceError(
            'SOURCE_CHANGED',
            'The unpublished source was retired.',
        ));
    }

    private async settleEntries(entries: Iterable<SourceEntry>): Promise<void> {
        await Promise.allSettled(Array.from(entries).map((entry) => this.closeIfUnused(entry)));
    }

    private async settleRawHandles(handles: Iterable<FileHandle>): Promise<void> {
        const owned = Array.from(handles);
        const settled = await Promise.allSettled(owned.map((handle) => handle.close()));
        for (let index = 0; index < settled.length; index++) {
            const result = settled[index];
            const handle = owned[index];
            if (!result || !handle) continue;
            if (result.status === 'rejected') {
                this.recordFailedHandle(handle, result.reason);
            } else {
                this.failedHandleCleanup.delete(handle);
            }
        }
    }

    private recordFailedHandle(handle: FileHandle, error: unknown): void {
        if (this.failedHandleCleanup.has(handle)) return;
        this.failedHandleCleanup.set(handle, error);
        this.cleanupFailures++;
    }
}

async function statToken(handle: FileHandle): Promise<FilesystemStatToken> {
    const value = await handle.stat({ bigint: true });
    if (!value.isFile()) {
        throw new MediaByteSourceError('SOURCE_UNREADABLE', 'Registered media is not a regular file.');
    }
    return {
        dev: String(value.dev),
        ino: String(value.ino),
        size: String(value.size),
        mtimeNs: String(value.mtimeNs),
        ctimeNs: String(value.ctimeNs),
    };
}

function tokensEqual(left: FilesystemStatToken, right: FilesystemStatToken): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}

function freezeMetadata(metadata: ProbedMediaMetadata): ProbedMediaMetadata {
    return Object.freeze({
        ...metadata,
        video: metadata.video ? Object.freeze({ ...metadata.video }) : null,
        audio: metadata.audio ? Object.freeze({ ...metadata.audio }) : null,
    });
}
