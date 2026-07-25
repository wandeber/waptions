// A canonical 30-second 16 kHz mono PCM window is below one MiB. Eight MiB leaves generous
// multipart/container overhead while keeping the bounded spool safely below worker memory limits.
export const TRANSCRIPTION_REQUEST_MAX_BYTES = 8 * 1024 * 1024;
export const TRANSCRIPTION_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
export const TRANSCRIPTION_ERROR_EXCERPT_MAX_BYTES = 4 * 1024;
export const TRANSCRIPTION_TOTAL_TIMEOUT_MS = 30 * 60 * 1_000;
export const TRANSCRIPTION_RESPONSE_BODY_TIMEOUT_MS = 5 * 60 * 1_000;
export const TRANSCRIPTION_MAX_CONCURRENT_REQUESTS = 2;
export const TRANSCRIPTION_RATE_WINDOW_MS = 60_000;
export const TRANSCRIPTION_RATE_MAX_REQUESTS = 20;
export const TRANSCRIPTION_ADMISSION_MAX_KEYS = 1_024;

export class TranscriptionPayloadTooLargeError extends Error {
    constructor(readonly kind: 'request' | 'response') {
        super(`Transcription ${kind} exceeded its byte limit.`);
        this.name = 'TranscriptionPayloadTooLargeError';
    }
}

export class TranscriptionAdmissionError extends Error {
    constructor(readonly kind: 'concurrency' | 'rate') {
        super(`Transcription ${kind} limit exceeded.`);
        this.name = 'TranscriptionAdmissionError';
    }
}

export class TranscriptionTimeoutError extends Error {
    constructor() {
        super('Transcription request timed out.');
        this.name = 'TranscriptionTimeoutError';
    }
}

/** Reads a stream under a hard allocation bound even when Content-Length is absent or false. */
export async function readBoundedResponseBytes(
    response: Response,
    options: {
        maximumBytes?: number;
        signal?: AbortSignal;
        bodyTimeoutMs?: number;
    } = {},
): Promise<Uint8Array> {
    const maximumBytes = options.maximumBytes ?? TRANSCRIPTION_RESPONSE_MAX_BYTES;
    assertPositiveLimit(maximumBytes);
    assertContentLength(response.headers.get('content-length'), maximumBytes, 'response');
    if (!response.body) return new Uint8Array();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        void reader.cancel().catch(() => undefined);
    }, options.bodyTimeoutMs ?? TRANSCRIPTION_RESPONSE_BODY_TIMEOUT_MS);
    const cancelForAbort = () => { void reader.cancel().catch(() => undefined); };
    options.signal?.addEventListener('abort', cancelForAbort, { once: true });
    try {
        while (true) {
            if (options.signal?.aborted) throw createAbortError();
            if (timedOut) throw new TranscriptionTimeoutError();
            const { done, value } = await reader.read();
            if (timedOut) throw new TranscriptionTimeoutError();
            if (options.signal?.aborted) throw createAbortError();
            if (done) break;
            totalBytes += value.byteLength;
            if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) {
                await reader.cancel().catch(() => undefined);
                throw new TranscriptionPayloadTooLargeError('response');
            }
            chunks.push(value.slice());
        }
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', cancelForAbort);
        reader.releaseLock();
    }

    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

export async function readBoundedJsonResponse(
    response: Response,
    options: {
        maximumBytes?: number;
        signal?: AbortSignal;
        bodyTimeoutMs?: number;
    } = {},
): Promise<unknown> {
    const bytes = await readBoundedResponseBytes(response, options);
    if (bytes.byteLength === 0) return {};
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new Error('Transcription response is not valid UTF-8.');
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new Error('Transcription response is not valid JSON.');
    }
}

/**
 * Parses multipart only after a streaming byte cap.
 *
 * The Fetch API does not expose a streaming multipart parser in every supported browser/worker.
 * This fixed-size spool is therefore the fail-closed fallback: RAM is bounded by policy and never
 * grows with source size. Acquisition windows keep normal requests far below this ceiling.
 */
export async function readBoundedMultipartFormData(
    request: Request,
    maximumBytes = TRANSCRIPTION_REQUEST_MAX_BYTES,
): Promise<FormData> {
    assertPositiveLimit(maximumBytes);
    const contentType = request.headers.get('content-type');
    if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) {
        throw new Error('Multipart form data is required.');
    }
    assertContentLength(request.headers.get('content-length'), maximumBytes, 'request');
    const response = new Response(request.body, { headers: request.headers });
    let bytes: Uint8Array;
    try {
        bytes = await readBoundedResponseBytes(response, {
            maximumBytes,
            signal: request.signal,
            bodyTimeoutMs: TRANSCRIPTION_RESPONSE_BODY_TIMEOUT_MS,
        });
    } catch (error) {
        if (error instanceof TranscriptionPayloadTooLargeError) {
            throw new TranscriptionPayloadTooLargeError('request');
        }
        throw error;
    }
    return new Response(bytes, {
        headers: { 'content-type': contentType },
    }).formData();
}

export function boundedErrorExcerpt(
    bytes: Uint8Array,
    maximumBytes = TRANSCRIPTION_ERROR_EXCERPT_MAX_BYTES,
): string {
    assertPositiveLimit(maximumBytes);
    const excerpt = bytes.subarray(0, Math.min(bytes.byteLength, maximumBytes));
    return new TextDecoder('utf-8', { fatal: false }).decode(excerpt).trim();
}

/** Reads at most the configured diagnostic prefix, then cancels the hostile provider body. */
export async function readBoundedErrorExcerpt(
    response: Response,
    options: {
        maximumBytes?: number;
        signal?: AbortSignal;
    } = {},
): Promise<string> {
    const maximumBytes = options.maximumBytes ?? TRANSCRIPTION_ERROR_EXCERPT_MAX_BYTES;
    assertPositiveLimit(maximumBytes);
    if (!response.body) return '';
    const reader = response.body.getReader();
    const result = new Uint8Array(maximumBytes);
    let offset = 0;
    const cancelForAbort = () => { void reader.cancel().catch(() => undefined); };
    options.signal?.addEventListener('abort', cancelForAbort, { once: true });
    try {
        while (offset < maximumBytes) {
            if (options.signal?.aborted) throw createAbortError();
            const { done, value } = await reader.read();
            if (done) break;
            const retained = value.subarray(0, Math.min(value.byteLength, maximumBytes - offset));
            result.set(retained, offset);
            offset += retained.byteLength;
            if (retained.byteLength < value.byteLength || offset === maximumBytes) {
                await reader.cancel().catch(() => undefined);
                break;
            }
        }
    } finally {
        options.signal?.removeEventListener('abort', cancelForAbort);
        reader.releaseLock();
    }
    return boundedErrorExcerpt(result.subarray(0, offset), maximumBytes);
}

/**
 * Process-local admission gate. It is deliberately small and fail-fast so route queues cannot
 * become an alternate unbounded memory store while provider requests are slow.
 */
export class TranscriptionAdmissionGate {
    private active = 0;
    private readonly arrivals = new Map<string, number[]>();

    constructor(private readonly policy: {
        maximumConcurrent?: number;
        maximumPerWindow?: number;
        windowMs?: number;
        maximumKeys?: number;
        now?: () => number;
    } = {}) {}

    acquire(key: string): () => void {
        const now = (this.policy.now ?? Date.now)();
        const windowMs = this.policy.windowMs ?? TRANSCRIPTION_RATE_WINDOW_MS;
        const maximumPerWindow = this.policy.maximumPerWindow ?? TRANSCRIPTION_RATE_MAX_REQUESTS;
        const maximumConcurrent = this.policy.maximumConcurrent
            ?? TRANSCRIPTION_MAX_CONCURRENT_REQUESTS;
        const maximumKeys = this.policy.maximumKeys ?? TRANSCRIPTION_ADMISSION_MAX_KEYS;
        this.arrivals.forEach((timestamps, existingKey) => {
            const retained = timestamps.filter(timestamp => now - timestamp < windowMs);
            if (retained.length === 0) this.arrivals.delete(existingKey);
            else if (retained.length !== timestamps.length) this.arrivals.set(existingKey, retained);
        });
        if (!this.arrivals.has(key) && this.arrivals.size >= maximumKeys) {
            throw new TranscriptionAdmissionError('rate');
        }
        const recent = (this.arrivals.get(key) ?? []).filter(timestamp => now - timestamp < windowMs);
        if (recent.length >= maximumPerWindow) {
            this.arrivals.set(key, recent);
            throw new TranscriptionAdmissionError('rate');
        }
        if (this.active >= maximumConcurrent) {
            throw new TranscriptionAdmissionError('concurrency');
        }
        recent.push(now);
        this.arrivals.set(key, recent);
        this.active += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.active -= 1;
        };
    }
}

export const sharedTranscriptionAdmissionGate = new TranscriptionAdmissionGate();

/** Uses one bounded, non-secret routing key; spoofing it cannot bypass the global semaphore. */
export function getTranscriptionAdmissionKey(request: Request): string {
    const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const candidate = forwarded || request.headers.get('cf-connecting-ip')?.trim() || 'anonymous';
    return candidate.slice(0, 128);
}

export function createTotalTimeoutSignal(
    callerSignal: AbortSignal | undefined,
    timeoutMs = TRANSCRIPTION_TOTAL_TIMEOUT_MS,
): { signal: AbortSignal; dispose(): void; didTimeout(): boolean } {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error('Transcription timeout is invalid.');
    }
    const controller = new AbortController();
    let timedOut = false;
    const abortForCaller = () => controller.abort(createAbortError());
    if (callerSignal?.aborted) abortForCaller();
    else callerSignal?.addEventListener('abort', abortForCaller, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new TranscriptionTimeoutError());
    }, timeoutMs);
    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timer);
            callerSignal?.removeEventListener('abort', abortForCaller);
        },
        didTimeout: () => timedOut,
    };
}

function assertContentLength(
    header: string | null,
    maximumBytes: number,
    kind: 'request' | 'response',
): void {
    if (header === null) return;
    if (!/^\d+$/.test(header)) throw new Error(`Transcription ${kind} Content-Length is invalid.`);
    const value = Number(header);
    if (!Number.isSafeInteger(value)) {
        throw new TranscriptionPayloadTooLargeError(kind);
    }
    if (value > maximumBytes) throw new TranscriptionPayloadTooLargeError(kind);
}

function assertPositiveLimit(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('Transcription byte limit is invalid.');
    }
}

function createAbortError(): DOMException {
    return new DOMException('Transcription request was cancelled.', 'AbortError');
}
