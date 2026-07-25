import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import type {
    StagedOutputDestinationCapabilityV1,
} from '../../../src/types/waptions-agent-protocol';
import type {
    HeadlessStagedOutputCapability,
} from '../../render/contracts';
import type {
    AcquiredNodeStagedOutputHandle,
    NodeStagedOutputHandleAccess,
    NodeStagedOutputHandleResolverPort,
} from '../../export/node-staged-output-handle';
import type {
    ManagedOutputStagingHandle,
    StagedDestination,
} from '../../path-grants/path-grant-authority';
import { managedError } from '../../coordinator/errors';
import type { ManagedOutputCandidate } from './contracts';

interface BoundDestination {
    readonly publicCapability: StagedOutputDestinationCapabilityV1;
    readonly staged: StagedDestination;
    readonly renderCapability: HeadlessStagedOutputCapability;
    acquired: boolean;
    settled: boolean;
}

export interface ManagedOutputLease {
    readonly outputId: string;
    readonly renderCapability: HeadlessStagedOutputCapability;
    readonly handle: ManagedOutputStagingHandle;
    reset(signal?: AbortSignal): Promise<void>;
    sync(signal?: AbortSignal): Promise<void>;
    size(signal?: AbortSignal): Promise<number>;
    hash(signal?: AbortSignal): Promise<{ digest: `sha256:${string}`; bytes: number }>;
    stream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
    candidate(input: {
        contentDigest: `sha256:${string}`;
        byteLength: number;
    }): ManagedOutputCandidate;
    abort(): Promise<void>;
}

/**
 * Binds a coordinator-issued public destination capability to PathGrantAuthority private staging.
 *
 * Registration is intentionally separate from acquisition: the coordinator validates the grant
 * and creates staging before dispatching the export handler.
 */
export class PathGrantOutputAuthority implements NodeStagedOutputHandleResolverPort {
    private readonly destinations = new Map<string, BoundDestination>();

    register(
        capability: StagedOutputDestinationCapabilityV1,
        staged: StagedDestination,
    ): void {
        validatePublicCapability(capability);
        if (capability.mode !== 'create-only'
            || capability.grantId !== staged.grantId
            || this.destinations.has(capability.stagingHandleId)) {
            throw managedError(
                'WRITE_DESTINATION_NOT_GRANTED',
                'The create-only output capability is invalid or duplicated.',
            );
        }
        this.destinations.set(capability.stagingHandleId, {
            publicCapability: structuredClone(capability),
            staged,
            renderCapability: Object.freeze({
                version: 1,
                kind: 'create-only-staged-output',
                capabilityId: capability.destinationId,
                grantId: capability.grantId,
                stagingId: capability.stagingHandleId,
            }),
            acquired: false,
            settled: false,
        });
    }

    acquireDestination(
        capability: StagedOutputDestinationCapabilityV1,
    ): ManagedOutputLease {
        validatePublicCapability(capability);
        const bound = this.requireBound(capability.stagingHandleId);
        assertSameCapability(bound.publicCapability, capability);
        if (bound.acquired || bound.settled) {
            throw managedError(
                'WRITE_DESTINATION_NOT_GRANTED',
                'The output staging capability is already in use.',
            );
        }
        bound.acquired = true;
        const outputId = capability.destinationId;
        return {
            outputId,
            renderCapability: bound.renderCapability,
            handle: bound.staged.handle,
            reset: async (signal) => {
                await this.withFile(bound, 'read-write', signal, async (handle) => {
                    await handle.truncate(0);
                    await handle.sync();
                });
            },
            sync: async (signal) => {
                throwIfAborted(signal);
                await bound.staged.handle.sync();
            },
            size: async (signal) => {
                throwIfAborted(signal);
                return (await bound.staged.handle.stat()).byteLength;
            },
            hash: async (signal) => {
                const value = await bound.staged.handle.hash({ signal });
                return {
                    digest: normalizeDigest(value.digest),
                    bytes: value.bytes,
                };
            },
            stream: (signal) => streamStagedOutput(bound.staged.handle, signal),
            candidate: ({ contentDigest, byteLength }) => {
                const expectedDigest = normalizeDigest(contentDigest);
                if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
                    throw managedError(
                        'PATH_IDENTITY_CHANGED',
                        'The staged output length is invalid.',
                    );
                }
                if (bound.settled) {
                    throw managedError(
                        'WRITE_DESTINATION_NOT_GRANTED',
                        'The output staging capability is settled.',
                    );
                }
                let prepared = false;
                return Object.freeze({
                    outputId,
                    contentDigest: expectedDigest,
                    byteLength,
                    preparePublication: async (signal?: AbortSignal) => {
                        if (prepared || bound.settled) {
                            throw managedError(
                                'WRITE_DESTINATION_NOT_GRANTED',
                                'Output publication was already prepared.',
                            );
                        }
                        throwIfAborted(signal);
                        validatePublicCapability(bound.publicCapability);
                        const current = await bound.staged.handle.hash({ signal });
                        if (normalizeDigest(current.digest) !== expectedDigest
                            || current.bytes !== byteLength) {
                            throw managedError(
                                'PATH_IDENTITY_CHANGED',
                                'Staged output changed before terminal publication.',
                            );
                        }
                        const publication = await bound.staged.commit({ signal });
                        if (normalizeDigest(publication.record.digest) !== expectedDigest
                            || publication.record.byteLength !== byteLength) {
                            bound.settled = true;
                            this.destinations.delete(capability.stagingHandleId);
                            await publication.reject();
                            throw managedError(
                                'PATH_IDENTITY_CHANGED',
                                'Staged output changed during terminal publication.',
                            );
                        }
                        prepared = true;
                        bound.settled = true;
                        this.destinations.delete(capability.stagingHandleId);
                        return publication;
                    },
                    abort: async () => {
                        if (prepared || bound.settled) return;
                        bound.settled = true;
                        this.destinations.delete(capability.stagingHandleId);
                        await bound.staged.abort();
                    },
                });
            },
            abort: async () => {
                if (bound.settled) return;
                bound.settled = true;
                this.destinations.delete(capability.stagingHandleId);
                await bound.staged.abort();
            },
        };
    }

    async acquire(
        outputCapability: HeadlessStagedOutputCapability,
        access: NodeStagedOutputHandleAccess,
        signal?: AbortSignal,
    ): Promise<AcquiredNodeStagedOutputHandle> {
        const bound = this.requireBound(outputCapability.stagingId);
        assertRenderCapability(bound.renderCapability, outputCapability);
        const file = await this.openPrivateHandle(bound, access, signal);
        const initial = await file.stat({ bigint: true });
        let closed = false;
        return {
            outputCapability: bound.renderCapability,
            fileDescriptor: file.fd,
            access,
            size: async (sizeSignal) => {
                throwIfAborted(sizeSignal);
                assertOpen(closed);
                const stat = await file.stat({ bigint: true });
                assertFileIdentity(initial, stat);
                return Number(stat.size);
            },
            assertCurrent: async (assertSignal) => {
                throwIfAborted(assertSignal);
                assertOpen(closed);
                const stat = await file.stat({ bigint: true });
                assertFileIdentity(initial, stat);
                if (bound.settled) {
                    throw managedError(
                        'WRITE_DESTINATION_NOT_GRANTED',
                        'Output staging capability is settled.',
                    );
                }
            },
            sync: async (syncSignal) => {
                throwIfAborted(syncSignal);
                assertOpen(closed);
                await file.sync();
            },
            close: async () => {
                if (closed) return;
                closed = true;
                await file.close();
            },
        };
    }

    private async withFile<T>(
        bound: BoundDestination,
        access: NodeStagedOutputHandleAccess,
        signal: AbortSignal | undefined,
        operation: (handle: FileHandle) => Promise<T>,
    ): Promise<T> {
        const handle = await this.openPrivateHandle(bound, access, signal);
        try {
            return await operation(handle);
        } finally {
            await handle.close();
        }
    }

    private async openPrivateHandle(
        bound: BoundDestination,
        access: NodeStagedOutputHandleAccess,
        signal?: AbortSignal,
    ): Promise<FileHandle> {
        throwIfAborted(signal);
        return bound.staged.handle.inspect(
            async (privatePath, inspectSignal) => {
                throwIfAborted(inspectSignal);
                return open(
                    privatePath,
                    (access === 'read-only' ? constants.O_RDONLY : constants.O_RDWR)
                        | constants.O_NONBLOCK
                        | noFollowFlag(),
                );
            },
            { signal },
        );
    }

    private requireBound(stagingId: string): BoundDestination {
        const bound = this.destinations.get(stagingId);
        if (!bound || bound.settled) {
            throw managedError(
                'WRITE_DESTINATION_NOT_GRANTED',
                'Output staging capability is not active.',
            );
        }
        return bound;
    }
}

async function* streamStagedOutput(
    handle: ManagedOutputStagingHandle,
    signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
    throwIfAborted(signal);
    const initial = await handle.stat();
    let position = 0;
    while (position < initial.byteLength) {
        throwIfAborted(signal);
        const length = Math.min(1024 * 1024, initial.byteLength - position);
        const bytes = Buffer.allocUnsafe(length);
        const read = await handle.read(bytes, 0, length, position);
        if (read.bytesRead !== length) {
            throw managedError('PATH_IDENTITY_CHANGED', 'Staged output was truncated while read.');
        }
        position += read.bytesRead;
        yield bytes;
    }
    const current = await handle.stat();
    if (current.byteLength !== initial.byteLength
        || current.device !== initial.device
        || current.inode !== initial.inode) {
        throw managedError('PATH_IDENTITY_CHANGED', 'Staged output changed while read.');
    }
}

function validatePublicCapability(value: StagedOutputDestinationCapabilityV1): void {
    if (value.schemaVersion !== 1
        || !isOpaque(value.destinationId)
        || !isOpaque(value.grantId)
        || !isOpaque(value.stagingHandleId)
        || value.mode !== 'create-only'
        || !/^[^/\\\0]{1,255}$/.test(value.outputName)
        || !Number.isFinite(Date.parse(value.expiresAt))
        || Date.parse(value.expiresAt) <= Date.now()) {
        throw managedError(
            'WRITE_DESTINATION_NOT_GRANTED',
            'Output destination capability is invalid or expired.',
        );
    }
}

function assertSameCapability(
    expected: StagedOutputDestinationCapabilityV1,
    actual: StagedOutputDestinationCapabilityV1,
): void {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        throw managedError(
            'WRITE_DESTINATION_NOT_GRANTED',
            'Output destination capability changed.',
        );
    }
}

function assertRenderCapability(
    expected: HeadlessStagedOutputCapability,
    actual: HeadlessStagedOutputCapability,
): void {
    if (expected.version !== actual.version
        || expected.kind !== actual.kind
        || expected.capabilityId !== actual.capabilityId
        || expected.grantId !== actual.grantId
        || expected.stagingId !== actual.stagingId) {
        throw managedError(
            'WRITE_DESTINATION_NOT_GRANTED',
            'Render output capability mismatch.',
        );
    }
}

function assertFileIdentity(
    expected: Awaited<ReturnType<FileHandle['stat']>>,
    actual: Awaited<ReturnType<FileHandle['stat']>>,
): void {
    if (!actual.isFile() || expected.dev !== actual.dev || expected.ino !== actual.ino) {
        throw managedError('PATH_IDENTITY_CHANGED', 'Output staging inode changed.');
    }
}

function normalizeDigest(value: string): `sha256:${string}` {
    const digest = value.startsWith('sha256:') ? value : `sha256:${value}`;
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
        throw new Error('Output staging digest is invalid.');
    }
    return digest as `sha256:${string}`;
}

function isOpaque(value: string): boolean {
    return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,256}$/.test(value);
}

function assertOpen(closed: boolean): void {
    if (closed) throw managedError('WRITE_DESTINATION_NOT_GRANTED', 'Output handle is closed.');
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function noFollowFlag(): number {
    return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
}
