import { createHash } from 'node:crypto';
import type { ManagedOutputStagingHandle } from '../../path-grants/path-grant-authority';

export interface ManagedStreamingSink {
    readonly bytesWritten: number;
    write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
    sync(signal?: AbortSignal): Promise<void>;
    digest(): `sha256:${string}`;
}

export function createManagedStreamingSink(
    handle: ManagedOutputStagingHandle,
    maximumBytes = 64 * 1024 * 1024 * 1024,
): ManagedStreamingSink {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
        throw new RangeError('Streaming output limit must be a positive safe integer.');
    }
    const hash = createHash('sha256');
    let position = 0;
    let sealed = false;
    return {
        get bytesWritten() {
            return position;
        },
        async write(bytes, signal) {
            throwIfAborted(signal);
            if (sealed) throw new Error('Streaming output is sealed.');
            if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
                throw new TypeError('Streaming output chunks must be non-empty Uint8Array values.');
            }
            if (bytes.byteLength > 8 * 1024 * 1024
                || !Number.isSafeInteger(position + bytes.byteLength)
                || position + bytes.byteLength > maximumBytes) {
                throw new RangeError('Streaming output exceeded its byte bounds.');
            }
            let offset = 0;
            while (offset < bytes.byteLength) {
                throwIfAborted(signal);
                const result = await handle.write(bytes.subarray(offset), position + offset);
                if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
                    throw new Error('Streaming output write made no progress.');
                }
                offset += result.bytesWritten;
            }
            position += bytes.byteLength;
            hash.update(bytes);
        },
        async sync(signal) {
            throwIfAborted(signal);
            await handle.sync();
            sealed = true;
        },
        digest() {
            if (!sealed) throw new Error('Streaming output must be synced before hashing.');
            return `sha256:${hash.copy().digest('hex')}`;
        },
    };
}

export async function writeAsyncIterable(
    sink: ManagedStreamingSink,
    source: AsyncIterable<Uint8Array>,
    options: {
        readonly expectedBytes: number;
        readonly expectedDigest?: `sha256:${string}`;
        readonly signal?: AbortSignal;
    },
): Promise<{ readonly digest: `sha256:${string}`; readonly bytes: number }> {
    if (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes < 0) {
        throw new RangeError('Expected stream length is invalid.');
    }
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of source) {
        throwIfAborted(options.signal);
        if (!(chunk instanceof Uint8Array)
            || chunk.byteLength === 0
            || chunk.byteLength > 8 * 1024 * 1024
            || !Number.isSafeInteger(bytes + chunk.byteLength)
            || bytes + chunk.byteLength > options.expectedBytes) {
            throw new RangeError('Managed stream emitted an invalid chunk.');
        }
        await sink.write(chunk, options.signal);
        hash.update(chunk);
        bytes += chunk.byteLength;
    }
    if (bytes !== options.expectedBytes) {
        throw new Error('Managed stream ended outside its declared byte length.');
    }
    const digest = `sha256:${hash.digest('hex')}` as const;
    if (options.expectedDigest && options.expectedDigest !== digest) {
        throw new Error('Managed stream digest changed during export.');
    }
    return { digest, bytes };
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
