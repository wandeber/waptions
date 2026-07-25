import type { HeadlessMediaIdentity } from './render-plan';

export interface RenderMediaByteRange {
    start: number;
    endExclusive: number;
}

export interface VerifiedRenderMediaByteSourceLease {
    readonly identity: HeadlessMediaIdentity;
    readonly capabilityId: string;
    size(): Promise<number>;
    read(
        range: RenderMediaByteRange,
        signal?: AbortSignal,
    ): Promise<Uint8Array>;
    stream(
        range?: RenderMediaByteRange,
        signal?: AbortSignal,
    ): ReadableStream<Uint8Array>;
    verify(signal?: AbortSignal): Promise<HeadlessMediaIdentity>;
    close(): Promise<void>;
}

export interface VerifiedRenderMediaSourceSet {
    readonly snapshotId: string;
    readonly identities: readonly HeadlessMediaIdentity[];
    get(
        kind: HeadlessMediaIdentity['kind'],
        sourceId: string,
    ): VerifiedRenderMediaByteSourceLease;
    close(): Promise<void>;
}

/**
 * Shared standalone/managed media seam for descriptor-first rendering.
 *
 * Browser adapters may wrap File.slice and managed adapters may wrap descriptor/range reads, but
 * neither consumer exposes File or filesystem paths to the render plan. Mediabunny integrations
 * must adapt this lease to a bounded custom source instead of constructing BlobSource(file).
 */
export interface RenderMediaByteSourcePort {
    acquire(
        snapshotId: string,
        expectedIdentity: HeadlessMediaIdentity,
        signal?: AbortSignal,
    ): Promise<VerifiedRenderMediaByteSourceLease>;
}

/**
 * Resolves and verifies every path-free source identity before a renderer can decode any bytes.
 *
 * The same helper is intended for the standalone export adapter and managed headless backends.
 * It keeps source verification, bounded reads, and close ownership out of timeline interpretation.
 */
export async function acquireVerifiedRenderMediaSources(
    port: RenderMediaByteSourcePort,
    snapshotId: string,
    expectedIdentities: readonly HeadlessMediaIdentity[],
    maximumReadChunkBytes: number,
    signal?: AbortSignal,
): Promise<VerifiedRenderMediaSourceSet> {
    if (!Number.isSafeInteger(maximumReadChunkBytes) || maximumReadChunkBytes <= 0) {
        throw new RangeError('maximumReadChunkBytes must be a positive safe integer.');
    }
    const leases = new Map<string, VerifiedRenderMediaByteSourceLease>();
    try {
        for (const expected of expectedIdentities) {
            throwIfMediaAcquisitionAborted(signal);
            const sourceKey = getSourceKey(expected.kind, expected.sourceId);
            if (leases.has(sourceKey)) {
                throw new Error(`Duplicate render media source "${sourceKey}".`);
            }
            const acquired = await port.acquire(snapshotId, expected, signal);
            let bounded: VerifiedRenderMediaByteSourceLease;
            try {
                bounded = createBoundedVerifiedLease(
                    acquired,
                    expected,
                    maximumReadChunkBytes,
                );
            } catch (error) {
                await acquired.close();
                throw error;
            }
            try {
                if (await bounded.size() !== expected.size) {
                    throw new Error(`Render media source "${expected.sourceId}" changed size.`);
                }
                await bounded.verify(signal);
            } catch (error) {
                await bounded.close();
                throw error;
            }
            leases.set(sourceKey, bounded);
        }
        throwIfMediaAcquisitionAborted(signal);
    } catch (error) {
        await closeLeases(leases.values());
        throw error;
    }

    const identities = Object.freeze(expectedIdentities.map(freezeIdentity));
    let closed = false;
    return Object.freeze({
        snapshotId,
        identities,
        get(kind: HeadlessMediaIdentity['kind'], sourceId: string) {
            if (closed) throw new Error('Render media sources are closed.');
            const sourceKey = getSourceKey(kind, sourceId);
            const lease = leases.get(sourceKey);
            if (!lease) throw new Error(`Unknown render media source "${sourceKey}".`);
            return lease;
        },
        async close() {
            if (closed) return;
            closed = true;
            await closeLeases(leases.values());
        },
    });
}

export function assertRenderMediaReadRange(
    range: RenderMediaByteRange,
    sourceSize: number,
    maximumReadChunkBytes: number,
): void {
    if (!Number.isSafeInteger(range.start)
        || !Number.isSafeInteger(range.endExclusive)
        || range.start < 0
        || range.endExclusive <= range.start
        || range.endExclusive > sourceSize
        || range.endExclusive - range.start > maximumReadChunkBytes) {
        throw new RangeError('Render media reads must be bounded half-open ranges inside the source.');
    }
}

function createBoundedVerifiedLease(
    lease: VerifiedRenderMediaByteSourceLease,
    expected: HeadlessMediaIdentity,
    maximumReadChunkBytes: number,
): VerifiedRenderMediaByteSourceLease {
    assertIdentityMatches(expected, lease.identity);
    if (lease.capabilityId !== expected.byteSourceCapabilityId) {
        throw new Error(`Render media source "${expected.sourceId}" used the wrong capability.`);
    }
    const identity = freezeIdentity(expected);
    let closed = false;
    return Object.freeze({
        identity,
        capabilityId: expected.byteSourceCapabilityId,
        async size() {
            assertLeaseOpen(closed);
            const size = await lease.size();
            if (size !== expected.size) {
                throw new Error(`Render media source "${expected.sourceId}" changed size.`);
            }
            return size;
        },
        async read(range: RenderMediaByteRange, signal?: AbortSignal) {
            assertLeaseOpen(closed);
            throwIfMediaAcquisitionAborted(signal);
            assertRenderMediaReadRange(range, expected.size, maximumReadChunkBytes);
            const bytes = await lease.read(range, signal);
            throwIfMediaAcquisitionAborted(signal);
            const expectedLength = range.endExclusive - range.start;
            if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expectedLength) {
                throw new Error(`Render media source "${expected.sourceId}" returned an invalid range.`);
            }
            return bytes;
        },
        stream(range?: RenderMediaByteRange, signal?: AbortSignal) {
            assertLeaseOpen(closed);
            throwIfMediaAcquisitionAborted(signal);
            const boundedRange = range ?? { start: 0, endExclusive: expected.size };
            assertRenderMediaReadRange(
                boundedRange,
                expected.size,
                expected.size,
            );
            return createBoundedStream(
                lease.stream(boundedRange, signal),
                boundedRange.endExclusive - boundedRange.start,
                maximumReadChunkBytes,
                signal,
            );
        },
        async verify(signal?: AbortSignal) {
            assertLeaseOpen(closed);
            throwIfMediaAcquisitionAborted(signal);
            const actual = await lease.verify(signal);
            throwIfMediaAcquisitionAborted(signal);
            assertIdentityMatches(expected, actual);
            return identity;
        },
        async close() {
            if (closed) return;
            closed = true;
            await lease.close();
        },
    });
}

function createBoundedStream(
    input: ReadableStream<Uint8Array>,
    expectedBytes: number,
    maximumReadChunkBytes: number,
    signal?: AbortSignal,
): ReadableStream<Uint8Array> {
    const reader = input.getReader();
    let consumedBytes = 0;
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        reader.releaseLock();
    };
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                throwIfMediaAcquisitionAborted(signal);
                const result = await reader.read();
                throwIfMediaAcquisitionAborted(signal);
                if (result.done) {
                    if (consumedBytes !== expectedBytes) {
                        throw new Error('Render media stream ended outside its requested range.');
                    }
                    release();
                    controller.close();
                    return;
                }
                if (!(result.value instanceof Uint8Array)
                    || result.value.byteLength === 0
                    || result.value.byteLength > maximumReadChunkBytes
                    || consumedBytes + result.value.byteLength > expectedBytes) {
                    throw new RangeError('Render media stream emitted an unbounded chunk.');
                }
                consumedBytes += result.value.byteLength;
                controller.enqueue(result.value);
            } catch (error) {
                await reader.cancel(error).catch(() => undefined);
                release();
                controller.error(error);
            }
        },
        async cancel(reason) {
            await reader.cancel(reason);
            release();
        },
    });
}

async function closeLeases(
    leases: Iterable<VerifiedRenderMediaByteSourceLease>,
): Promise<void> {
    const results = await Promise.allSettled(Array.from(leases, (lease) => lease.close()));
    const failure = results.find((result): result is PromiseRejectedResult => (
        result.status === 'rejected'
    ));
    if (failure) throw failure.reason;
}

function freezeIdentity(identity: HeadlessMediaIdentity): HeadlessMediaIdentity {
    return Object.freeze({ ...identity });
}

function assertIdentityMatches(
    expected: HeadlessMediaIdentity,
    actual: HeadlessMediaIdentity,
): void {
    const keys: Array<keyof HeadlessMediaIdentity> = [
        'sourceId',
        'kind',
        'byteSourceCapabilityId',
        'fingerprint',
        'size',
        'lastModified',
    ];
    if (keys.some((key) => actual[key] !== expected[key])) {
        throw new Error(`Render media source "${expected.sourceId}" changed identity.`);
    }
}

function assertLeaseOpen(closed: boolean): void {
    if (closed) throw new Error('Render media source is closed.');
}

function throwIfMediaAcquisitionAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    throw new DOMException('Render media acquisition was cancelled.', 'AbortError');
}

function getSourceKey(kind: HeadlessMediaIdentity['kind'], sourceId: string): string {
    return `${kind}:${sourceId}`;
}
