import {
    assertMediaRange,
    MEDIA_READ_CHUNK_BYTES,
    type MediaByteRange,
    type MediaByteSource,
    throwIfAborted,
} from './types';

export function createMediaByteStream(
    source: MediaByteSource,
    range: MediaByteRange | undefined,
    signal?: AbortSignal,
): ReadableStream<Uint8Array> {
    const boundedRange = range ?? { start: 0, endExclusive: source.identity.sizeBytes };
    assertMediaRange(boundedRange, source.identity.sizeBytes, source.identity.sizeBytes);

    let position = boundedRange.start;
    let cancelled = false;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (cancelled) return;
            try {
                throwIfAborted(signal);
                if (position >= boundedRange.endExclusive) {
                    controller.close();
                    return;
                }
                const endExclusive = Math.min(
                    boundedRange.endExclusive,
                    position + MEDIA_READ_CHUNK_BYTES,
                );
                const bytes = await source.read({ start: position, endExclusive }, signal);
                throwIfAborted(signal);
                position = endExclusive;
                controller.enqueue(bytes);
            } catch (error) {
                controller.error(error);
            }
        },
        cancel() {
            cancelled = true;
        },
    });
}
