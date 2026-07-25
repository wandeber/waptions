import { describe, expect, it, vi } from 'vitest';
import {
    acquireVerifiedRenderMediaSources,
    assertRenderMediaReadRange,
    type HeadlessMediaIdentity,
    type RenderMediaByteSourcePort,
} from '../render-plan';

const IDENTITY: HeadlessMediaIdentity = {
    sourceId: 'video-source',
    kind: 'video',
    byteSourceCapabilityId: 'media-capability:video-source',
    fingerprint: 'sha256:immutable',
    size: 8,
    lastModified: 1_700_000_000_000,
};

function createPort(options: {
    identity?: HeadlessMediaIdentity;
    streamChunks?: Uint8Array[];
} = {}) {
    const close = vi.fn().mockResolvedValue(undefined);
    const identity = options.identity ?? IDENTITY;
    const port: RenderMediaByteSourcePort = {
        acquire: vi.fn().mockResolvedValue({
            identity,
            capabilityId: identity.byteSourceCapabilityId,
            size: vi.fn().mockResolvedValue(identity.size),
            read: vi.fn(async (range) => new Uint8Array(range.endExclusive - range.start)),
            stream: vi.fn(() => new ReadableStream<Uint8Array>({
                start(controller) {
                    (options.streamChunks ?? [new Uint8Array(4), new Uint8Array(4)])
                        .forEach((chunk) => controller.enqueue(chunk));
                    controller.close();
                },
            })),
            verify: vi.fn().mockResolvedValue(identity),
            close,
        }),
    };
    return { port, close };
}

async function readChunkLengths(stream: ReadableStream<Uint8Array>): Promise<number[]> {
    const reader = stream.getReader();
    const lengths: number[] = [];
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) return lengths;
            lengths.push(result.value.byteLength);
        }
    } finally {
        reader.releaseLock();
    }
}

describe('shared render media byte-source contract', () => {
    it('verifies immutable path-free identities and bounds direct and streaming reads', async () => {
        const source = createPort();
        const set = await acquireVerifiedRenderMediaSources(
            source.port,
            'snapshot:verified',
            [IDENTITY],
            4,
        );
        const lease = set.get(IDENTITY.kind, IDENTITY.sourceId);

        await expect(lease.read({ start: 2, endExclusive: 6 }))
            .resolves.toHaveLength(4);
        expect(() => lease.read({ start: 0, endExclusive: 5 }))
            .rejects.toThrow(/bounded/i);
        const streamed = await readChunkLengths(lease.stream());
        expect(streamed).toEqual([4, 4]);
        expect(set.identities[0]).not.toHaveProperty('path');
        expect(set.identities[0]).not.toHaveProperty('file');

        await set.close();
        await set.close();
        expect(source.close).toHaveBeenCalledOnce();
    });

    it('fails closed and closes the acquired source when identity verification changes', async () => {
        const changed = { ...IDENTITY, fingerprint: 'sha256:changed' };
        const source = createPort({ identity: changed });

        await expect(acquireVerifiedRenderMediaSources(
            source.port,
            'snapshot:verified',
            [IDENTITY],
            4,
        )).rejects.toThrow(/changed identity/i);
        expect(source.close).toHaveBeenCalledOnce();
    });

    it('rejects oversized stream chunks and exact-range underflow', async () => {
        const oversized = createPort({ streamChunks: [new Uint8Array(8)] });
        const set = await acquireVerifiedRenderMediaSources(
            oversized.port,
            'snapshot:verified',
            [IDENTITY],
            4,
        );

        await expect(readChunkLengths(set.get(IDENTITY.kind, IDENTITY.sourceId).stream()))
            .rejects.toThrow(/unbounded/i);
        await set.close();

        const underflow = createPort({ streamChunks: [new Uint8Array(4)] });
        const underflowSet = await acquireVerifiedRenderMediaSources(
            underflow.port,
            'snapshot:verified',
            [IDENTITY],
            4,
        );
        await expect(readChunkLengths(
            underflowSet.get(IDENTITY.kind, IDENTITY.sourceId).stream(),
        ))
            .rejects.toThrow(/outside its requested range/i);
        await underflowSet.close();
    });

    it('accepts only safe half-open ranges under the configured hard chunk cap', () => {
        expect(() => assertRenderMediaReadRange(
            { start: 0, endExclusive: 4 },
            8,
            4,
        )).not.toThrow();
        expect(() => assertRenderMediaReadRange(
            { start: 0, endExclusive: 5 },
            8,
            4,
        )).toThrow(RangeError);
        expect(() => assertRenderMediaReadRange(
            { start: 7, endExclusive: 9 },
            8,
            4,
        )).toThrow(RangeError);
    });

    it('keeps video and audio identities with the same namespace-local sourceId distinct', async () => {
        const audioIdentity: HeadlessMediaIdentity = {
            ...IDENTITY,
            kind: 'audio',
            byteSourceCapabilityId: 'media-capability:audio-source',
            fingerprint: 'sha256:audio-immutable',
        };
        const port: RenderMediaByteSourcePort = {
            acquire: vi.fn(async (_snapshotId, identity) => ({
                identity,
                capabilityId: identity.byteSourceCapabilityId,
                size: vi.fn().mockResolvedValue(identity.size),
                read: vi.fn(async (range) => (
                    new Uint8Array(range.endExclusive - range.start)
                )),
                stream: vi.fn(() => new ReadableStream<Uint8Array>()),
                verify: vi.fn().mockResolvedValue(identity),
                close: vi.fn().mockResolvedValue(undefined),
            })),
        };

        const set = await acquireVerifiedRenderMediaSources(
            port,
            'snapshot:namespaced',
            [IDENTITY, audioIdentity],
            4,
        );

        expect(set.get('video', IDENTITY.sourceId).capabilityId)
            .toBe(IDENTITY.byteSourceCapabilityId);
        expect(set.get('audio', audioIdentity.sourceId).capabilityId)
            .toBe(audioIdentity.byteSourceCapabilityId);
        await set.close();
    });
});
