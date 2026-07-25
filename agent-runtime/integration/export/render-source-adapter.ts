import type {
    HeadlessMediaIdentity,
    RenderMediaByteSourcePort,
    VerifiedRenderMediaByteSourceLease,
    VerifiedRenderMediaSourceSet,
} from '../../../src/lib/render-plan';
import type {
    AcquiredImmutableSourceHandle,
    ImmutableSourceHandleResolverPort,
} from '../../render/node-ffmpeg-handles';
import { HeadlessRenderError } from '../../render/contracts';
import type { PathGrantMediaAdapter } from '../media/path-grant-media-adapter';

const STREAM_CHUNK_BYTES = 1024 * 1024;

/**
 * Shared retained-source adapter for both bounded render byte reads and Node FFmpeg descriptors.
 * It opens only the source named by the resolved plan and revalidates authority on every lease.
 */
export class ManagedRenderSourceAdapter implements
    RenderMediaByteSourcePort,
    ImmutableSourceHandleResolverPort {
    constructor(private readonly media: PathGrantMediaAdapter) {}

    async acquire(
        snapshotId: string,
        expectedIdentity: HeadlessMediaIdentity,
        signal?: AbortSignal,
    ): Promise<VerifiedRenderMediaByteSourceLease>;
    async acquire(
        mediaSources: VerifiedRenderMediaSourceSet,
        expectedIdentity: HeadlessMediaIdentity,
        signal?: AbortSignal,
    ): Promise<AcquiredImmutableSourceHandle>;
    async acquire(
        _snapshotId: string | VerifiedRenderMediaSourceSet,
        expectedIdentity: HeadlessMediaIdentity,
        signal?: AbortSignal,
    ): Promise<VerifiedRenderMediaByteSourceLease | AcquiredImmutableSourceHandle> {
        const record = this.media.getBySourceId(expectedIdentity.sourceId);
        if (!record) {
            throw new HeadlessRenderError('SOURCE_CHANGED', 'Render source is not committed.');
        }
        assertIdentity(record, expectedIdentity);
        const lease = await this.media.open(record.handle.handleId, signal);
        await lease.assertCurrent(signal);
        let closed = false;
        const verify = async (verifySignal?: AbortSignal) => {
            assertOpen(closed);
            await lease.assertCurrent(verifySignal);
            return expectedIdentity;
        };
        if (typeof _snapshotId !== 'string') {
            const selected = _snapshotId.get(expectedIdentity.kind, expectedIdentity.sourceId);
            if (selected.capabilityId !== expectedIdentity.byteSourceCapabilityId) {
                await lease.close();
                throw new HeadlessRenderError(
                    'SOURCE_CHANGED',
                    'Resolved render source capability mismatch.',
                );
            }
            return {
                identity: expectedIdentity,
                fileDescriptor: lease.fileHandle.fd,
                assertCurrent: async (assertSignal) => {
                    await verify(assertSignal);
                    await selected.verify(assertSignal);
                },
                close: async () => {
                    if (closed) return;
                    closed = true;
                    await lease.close();
                },
            };
        }
        return {
            identity: expectedIdentity,
            capabilityId: expectedIdentity.byteSourceCapabilityId,
            size: async () => {
                assertOpen(closed);
                return record.registeredIdentity.byteLength;
            },
            read: async (range, readSignal) => {
                assertOpen(closed);
                throwIfAborted(readSignal);
                const bytes = Buffer.allocUnsafe(range.endExclusive - range.start);
                const result = await lease.fileHandle.read(
                    bytes,
                    0,
                    bytes.byteLength,
                    range.start,
                );
                if (result.bytesRead !== bytes.byteLength) {
                    throw new HeadlessRenderError(
                        'SOURCE_CHANGED',
                        'Render source range was truncated.',
                    );
                }
                return bytes;
            },
            stream: (range = {
                start: 0,
                endExclusive: record.registeredIdentity.byteLength,
            }, streamSignal) => streamHandle(
                lease.fileHandle,
                range,
                streamSignal,
            ),
            verify,
            close: async () => {
                if (closed) return;
                closed = true;
                await lease.close();
            },
        };
    }
}

function assertIdentity(
    record: NonNullable<ReturnType<PathGrantMediaAdapter['getBySourceId']>>,
    expected: HeadlessMediaIdentity,
): void {
    const descriptor = record.videoDescriptor ?? record.audioDescriptor;
    if (!descriptor
        || expected.kind !== record.class
        || expected.byteSourceCapabilityId !== record.handle.capabilityId
        || expected.fingerprint !== descriptor.fingerprint
        || expected.size !== descriptor.size
        || expected.lastModified !== descriptor.lastModified) {
        throw new HeadlessRenderError(
            'SOURCE_CHANGED',
            'Resolved render source identity does not match the committed descriptor.',
        );
    }
}

function streamHandle(
    handle: import('node:fs/promises').FileHandle,
    range: { start: number; endExclusive: number },
    signal?: AbortSignal,
): ReadableStream<Uint8Array> {
    let position = range.start;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                throwIfAborted(signal);
                if (position >= range.endExclusive) {
                    controller.close();
                    return;
                }
                const length = Math.min(STREAM_CHUNK_BYTES, range.endExclusive - position);
                const bytes = Buffer.allocUnsafe(length);
                const result = await handle.read(bytes, 0, length, position);
                if (result.bytesRead !== length) {
                    throw new HeadlessRenderError(
                        'SOURCE_CHANGED',
                        'Render source stream was truncated.',
                    );
                }
                position += result.bytesRead;
                controller.enqueue(bytes);
            } catch (error) {
                controller.error(error);
            }
        },
    });
}

function assertOpen(closed: boolean): void {
    if (closed) throw new HeadlessRenderError('SOURCE_CHANGED', 'Render source lease is closed.');
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
