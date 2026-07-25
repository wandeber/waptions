export const MEDIA_READ_CHUNK_BYTES = 8 * 1024 * 1024;
export const HTTP_RANGE_STAGING_BYTES = 4 * 1024 * 1024;

/** Path-free identity shared by browser and managed media runtimes. */
export interface CoreMediaIdentity {
    readonly fingerprint: string;
    readonly sizeBytes: number;
}

export interface MediaByteRange {
    readonly start: number;
    readonly endExclusive: number;
}

export interface MediaByteSource {
    readonly sourceId: string;
    readonly identity: CoreMediaIdentity;
    size(): Promise<number>;
    read(range: MediaByteRange, signal?: AbortSignal): Promise<Uint8Array>;
    stream(range?: MediaByteRange, signal?: AbortSignal): ReadableStream<Uint8Array>;
    verify(signal?: AbortSignal): Promise<CoreMediaIdentity>;
    close(): Promise<void>;
}

export interface MediaReadGrant {
    readonly sourceId: string;
    readonly immutableVersion: string;
    readonly ranges: readonly MediaByteRange[];
}

export type MediaByteSourceInput = Blob | MediaByteSource;

export function isMediaByteSource(input: MediaByteSourceInput): input is MediaByteSource {
    const candidate = input as Partial<MediaByteSource>;
    return (
        typeof candidate.read === 'function'
        && typeof candidate.verify === 'function'
        && typeof candidate.close === 'function'
        && candidate.identity !== undefined
    );
}

export function freezeMediaIdentity(identity: CoreMediaIdentity): CoreMediaIdentity {
    if (!identity.fingerprint) {
        throw new TypeError('Media identity fingerprint must not be empty.');
    }
    assertSafeByteOffset(identity.sizeBytes, 'Media identity sizeBytes');
    return Object.freeze({ ...identity });
}

export function assertSafeByteOffset(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${label} must be a non-negative safe integer.`);
    }
}

export function assertMediaRange(
    range: MediaByteRange,
    byteLength: number,
    maxLength = MEDIA_READ_CHUNK_BYTES,
): void {
    assertSafeByteOffset(range.start, 'Media range start');
    assertSafeByteOffset(range.endExclusive, 'Media range endExclusive');
    if (range.endExclusive < range.start) {
        throw new RangeError('Media range endExclusive must not precede start.');
    }
    if (range.endExclusive > byteLength) {
        throw new RangeError('Media range exceeds the immutable source size.');
    }
    if (range.endExclusive - range.start > maxLength) {
        throw new MediaByteSourceError(
            'RANGE_TOO_LARGE',
            `Media reads are limited to ${maxLength} bytes.`,
        );
    }
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }
}

export interface LinkedAbortSignal {
    readonly signal: AbortSignal;
    dispose(): void;
}

export function linkAbortSignals(...signals: Array<AbortSignal | undefined>): LinkedAbortSignal {
    const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    if (present.length === 1) return { signal: present[0], dispose: () => undefined };
    const controller = new AbortController();
    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
    for (const signal of present) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        const listener = () => controller.abort(signal.reason);
        signal.addEventListener('abort', listener, { once: true });
        listeners.push({ signal, listener });
    }
    return {
        signal: controller.signal,
        dispose() {
            for (const item of listeners) {
                item.signal.removeEventListener('abort', item.listener);
            }
        },
    };
}

export function createSourceClosedAbortError(): DOMException | Error {
    if (typeof DOMException !== 'undefined') {
        return new DOMException('The media byte source was closed.', 'AbortError');
    }
    const error = new Error('The media byte source was closed.');
    error.name = 'AbortError';
    return error;
}

export async function awaitWithAbort<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    return new Promise<T>((resolve, reject) => {
        const handleAbort = () => reject(
            signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
        );
        signal.addEventListener('abort', handleAbort, { once: true });
        Promise.resolve(value).then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', handleAbort);
        });
    });
}

export class MediaByteSourceError extends Error {
    constructor(
        readonly code:
            | 'SOURCE_CHANGED'
            | 'SOURCE_CLOSED'
            | 'SOURCE_NOT_FOUND'
            | 'SOURCE_UNREADABLE'
            | 'GRANT_MISMATCH'
            | 'RANGE_NOT_GRANTED'
            | 'RANGE_TOO_LARGE'
            | 'INVALID_RANGE_RESPONSE',
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'MediaByteSourceError';
    }
}
