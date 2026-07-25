import {
    EDITORIAL_TRANSCRIPTION_RESPONSE_MAX_BYTES,
    EditorialTranscriptionResponseTooLargeError,
    readEditorialTranscriptionResponseBytes,
} from './request';

/**
 * A cold full-source transcription may legitimately spend several minutes before returning its
 * first response byte. Thirty minutes is long enough for that production workload while still
 * preventing an abandoned provider call from owning a server request indefinitely.
 */
export const EDITORIAL_PROVIDER_TOTAL_TIMEOUT_MS = 30 * 60 * 1_000;
export const EDITORIAL_PROVIDER_HEADERS_TIMEOUT_MS = 30 * 60 * 1_000;

/**
 * Once headers arrive, the bounded JSON result should transfer promptly. Five minutes permits a
 * slow 32 MiB response while independently bounding a stalled or trickling response body.
 */
export const EDITORIAL_PROVIDER_BODY_TIMEOUT_MS = 5 * 60 * 1_000;

export class EditorialProviderTimeoutError extends Error {
    constructor() {
        super('Editorial transcription provider timed out.');
        this.name = 'EditorialProviderTimeoutError';
    }
}

export type EditorialProviderTransportResult =
    | { kind: 'success'; status: number; bytes: Uint8Array }
    | { kind: 'rejected'; status: number };

type EditorialProviderFetch = (
    input: string,
    init: RequestInit,
) => Promise<Response>;

export interface EditorialProviderTransportInput {
    endpoint: string;
    body: FormData;
    headers: Headers;
    signal: AbortSignal;
    responseMaxBytes?: number;
    fetchImpl?: EditorialProviderFetch;
}

let nodeProviderFetchPromise: Promise<EditorialProviderFetch> | null = null;

/**
 * Runs the complete upstream exchange under one cancellation and deadline owner.
 *
 * Node's bundled fetch uses Undici's five-minute default response-header timeout, so Node loads a
 * dedicated Undici Agent with the explicit editorial policy. Workerd does not expose Node's
 * bundled Undici runtime and keeps its native fetch implementation; the application-level total
 * and body deadlines still apply there. The dynamic import keeps Node socket code off the normal
 * Workerd execution path while allowing both Next and OpenNext to validate the same route.
 */
export async function requestEditorialTranscriptionProvider(
    input: EditorialProviderTransportInput,
): Promise<EditorialProviderTransportResult> {
    if (input.signal.aborted) throw createAbortError();

    const requestController = new AbortController();
    let applicationTimedOut = false;
    let bodyTimer: ReturnType<typeof setTimeout> | null = null;
    const abortForTimeout = () => {
        if (input.signal.aborted || requestController.signal.aborted) return;
        applicationTimedOut = true;
        requestController.abort(new EditorialProviderTimeoutError());
    };
    const totalTimer = setTimeout(abortForTimeout, EDITORIAL_PROVIDER_TOTAL_TIMEOUT_MS);
    const headersTimer = setTimeout(abortForTimeout, EDITORIAL_PROVIDER_HEADERS_TIMEOUT_MS);
    const abortForCaller = () => {
        if (!requestController.signal.aborted) requestController.abort(createAbortError());
    };
    input.signal.addEventListener('abort', abortForCaller, { once: true });

    try {
        const providerFetch = input.fetchImpl ?? await getDefaultEditorialProviderFetch();
        let response: Response;
        try {
            response = await providerFetch(input.endpoint, {
                method: 'POST',
                body: input.body,
                headers: input.headers,
                redirect: 'error',
                signal: requestController.signal,
            });
        } catch (error) {
            throw classifyTransportFailure(error, input.signal, applicationTimedOut);
        } finally {
            clearTimeout(headersTimer);
        }

        throwIfRequestStopped(input.signal, applicationTimedOut);
        if (!response.ok) {
            // A provider error body is untrusted and unnecessary. Cancelling it here preserves the
            // safe status-only boundary and ensures the dedicated connection can be reclaimed.
            await response.body?.cancel().catch(() => undefined);
            throwIfRequestStopped(input.signal, applicationTimedOut);
            return { kind: 'rejected', status: response.status };
        }

        bodyTimer = setTimeout(abortForTimeout, EDITORIAL_PROVIDER_BODY_TIMEOUT_MS);
        try {
            const bytes = await readEditorialTranscriptionResponseBytes(
                response,
                input.responseMaxBytes ?? EDITORIAL_TRANSCRIPTION_RESPONSE_MAX_BYTES,
            );
            throwIfRequestStopped(input.signal, applicationTimedOut);
            return { kind: 'success', status: response.status, bytes };
        } catch (error) {
            throw classifyTransportFailure(error, input.signal, applicationTimedOut);
        }
    } finally {
        clearTimeout(totalTimer);
        clearTimeout(headersTimer);
        if (bodyTimer !== null) clearTimeout(bodyTimer);
        input.signal.removeEventListener('abort', abortForCaller);
    }
}

async function getDefaultEditorialProviderFetch(): Promise<EditorialProviderFetch> {
    if (!isNodeUndiciRuntime()) {
        return (input, init) => globalThis.fetch(input, init);
    }
    nodeProviderFetchPromise ??= createNodeEditorialProviderFetch();
    return nodeProviderFetchPromise;
}

async function createNodeEditorialProviderFetch(): Promise<EditorialProviderFetch> {
    const undici = await import('undici');
    const dispatcher = new undici.Agent({
        headersTimeout: EDITORIAL_PROVIDER_HEADERS_TIMEOUT_MS,
        bodyTimeout: EDITORIAL_PROVIDER_BODY_TIMEOUT_MS,
    });
    return async (input, init) => globalThis.fetch(input, {
        ...init,
        dispatcher,
        // `dispatcher` is Node's documented Undici extension to fetch rather than a WHATWG field.
        // Keeping the global Node fetch is important: it shares the same FormData/File brands as
        // the parsed Next request, whereas `undici.fetch` from a separate package instance would
        // serialize that body as the literal string "[object FormData]".
    } as RequestInit);
}

function isNodeUndiciRuntime(): boolean {
    return typeof process !== 'undefined'
        && process.release?.name === 'node'
        && typeof process.versions?.undici === 'string';
}

function classifyTransportFailure(
    error: unknown,
    callerSignal: AbortSignal,
    applicationTimedOut: boolean,
): unknown {
    // A caller cancellation always wins, including a race with an Undici timeout. The route can
    // therefore retain its existing 499 semantics without exposing the caller's abort reason.
    if (callerSignal.aborted) return createAbortError();
    if (applicationTimedOut || isTrustedUndiciTimeout(error)) {
        return new EditorialProviderTimeoutError();
    }
    if (error instanceof EditorialTranscriptionResponseTooLargeError) return error;
    return error;
}

function isTrustedUndiciTimeout(error: unknown): boolean {
    const visited = new Set<object>();
    let candidate = error;
    for (let depth = 0; depth < 4 && isObject(candidate); depth += 1) {
        if (visited.has(candidate)) return false;
        visited.add(candidate);
        let code: unknown;
        let cause: unknown;
        try {
            code = Reflect.get(candidate, 'code');
            cause = Reflect.get(candidate, 'cause');
        } catch {
            return false;
        }
        if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return true;
        candidate = cause;
    }
    return false;
}

function isObject(value: unknown): value is object {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function throwIfRequestStopped(signal: AbortSignal, applicationTimedOut: boolean): void {
    if (signal.aborted) throw createAbortError();
    if (applicationTimedOut) throw new EditorialProviderTimeoutError();
}

function createAbortError(): DOMException {
    return new DOMException('Editorial transcription request was cancelled.', 'AbortError');
}
