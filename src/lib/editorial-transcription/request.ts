import type { EditorialSpeakerMode } from '@/types/editorial';
import { normalizeEditorialTranscriptionEndpoint } from './endpoint';
import {
    normalizeEditorialLanguage,
    type EditorialTranscriptionRequestMode,
} from './preferences';

export const EDITORIAL_TRANSCRIPTION_MODEL = 'qwen-1.7b-edit-max';
export const EDITORIAL_TRANSCRIPTION_RESPONSE_FORMAT = 'verbose_json';
export const EDITORIAL_TRANSCRIPTION_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
export const EDITORIAL_TRANSCRIPTION_MAX_WAV_BYTES = 512 * 1024 * 1024;
export const EDITORIAL_TRANSCRIPTION_FAILURE_HEADER = 'x-waptions-editorial-failure';

/**
 * Closed failure vocabulary allowed to cross the provider and server-proxy trust boundaries.
 * It deliberately carries no status text, endpoint, response body, media name, transcript, or
 * credential. UI-facing copy is selected later by trusted application code from this enum only.
 */
export type EditorialTranscriptionFailureCode =
    | 'network-unreachable'
    | 'provider-unauthorized'
    | 'provider-forbidden'
    | 'provider-not-found'
    | 'provider-rate-limited'
    | 'provider-rejected'
    | 'provider-unavailable'
    | 'provider-timeout';

const EDITORIAL_TRANSCRIPTION_FAILURE_CODES = new Set<EditorialTranscriptionFailureCode>([
    'network-unreachable',
    'provider-unauthorized',
    'provider-forbidden',
    'provider-not-found',
    'provider-rate-limited',
    'provider-rejected',
    'provider-unavailable',
    'provider-timeout',
]);

export class EditorialTranscriptionRequestError extends Error {
    readonly code: EditorialTranscriptionFailureCode;

    constructor(code: EditorialTranscriptionFailureCode) {
        // The code itself is allowlisted, but the Error message stays generic so an unexpected
        // consumer cannot accidentally treat this transport object as ready-to-render UI copy.
        super('Editorial transcription request failed.');
        this.name = 'EditorialTranscriptionRequestError';
        this.code = code;
    }
}

/** Maps only a bounded HTTP class/status to the closed failure vocabulary. */
export function classifyEditorialTranscriptionProviderStatus(
    status: number,
): EditorialTranscriptionFailureCode | null {
    if (status === 401) return 'provider-unauthorized';
    if (status === 403) return 'provider-forbidden';
    if (status === 404) return 'provider-not-found';
    if (status === 429) return 'provider-rate-limited';
    if (Number.isSafeInteger(status) && status >= 400 && status < 500) return 'provider-rejected';
    if (Number.isSafeInteger(status) && status >= 500 && status < 600) return 'provider-unavailable';
    return null;
}

function parseEditorialTranscriptionFailureCode(
    value: string | null,
): EditorialTranscriptionFailureCode | null {
    return value && EDITORIAL_TRANSCRIPTION_FAILURE_CODES.has(value as EditorialTranscriptionFailureCode)
        ? value as EditorialTranscriptionFailureCode
        : null;
}

export class EditorialTranscriptionResponseTooLargeError extends Error {
    constructor() {
        super('Editorial transcription response exceeded the safe size limit.');
        this.name = 'EditorialTranscriptionResponseTooLargeError';
    }
}

export interface EditorialTranscriptionRequest {
    endpoint: string;
    requestMode: EditorialTranscriptionRequestMode;
    wav: Blob;
    apiKey?: string;
    language: string | null;
    speakerMode: EditorialSpeakerMode;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    serverRoute?: string;
}

/** Builds the exact frozen provider multipart payload, with no extensible options bag. */
export function buildEditorialTranscriptionProviderMultipart(input: {
    wav: Blob;
    language: string | null;
    speakerMode: EditorialSpeakerMode;
}): FormData {
    if (!(input.wav instanceof Blob)) {
        throw new Error('Editorial transcription requires a canonical WAV Blob.');
    }
    if (input.speakerMode !== 'none' && input.speakerMode !== 'diarized') {
        throw new Error('Editorial transcription speaker mode is invalid.');
    }
    const formData = new FormData();
    formData.append('file', input.wav, 'source.wav');
    formData.append('model', EDITORIAL_TRANSCRIPTION_MODEL);
    formData.append('response_format', EDITORIAL_TRANSCRIPTION_RESPONSE_FORMAT);
    formData.append('stream', 'false');
    if (input.speakerMode === 'diarized') formData.append('diarize', 'true');
    const language = normalizeEditorialLanguage(input.language);
    if (language) formData.append('language', language);
    return formData;
}

/**
 * Sends one exact full-source WAV request through browser or Waptions server mode.
 *
 * Browser mode exposes the endpoint/key only to the configured provider. Server mode adds those
 * transient values to the browser-to-Waptions multipart envelope; neither value is returned from
 * this function or retained after fetch settles. Redirects always fail, preventing a credential
 * from being replayed to a provider-selected location.
 */
export async function requestEditMaxEditorialTranscript(
    input: EditorialTranscriptionRequest,
): Promise<unknown> {
    const fetchImpl = input.fetchImpl ?? fetch;
    const normalizedEndpoint = normalizeEditorialTranscriptionEndpoint(input.endpoint);
    const providerForm = buildEditorialTranscriptionProviderMultipart(input);
    let url: string;
    let body: FormData;
    const headers = new Headers();

    if (input.requestMode === 'browser') {
        url = normalizedEndpoint;
        body = providerForm;
        const apiKey = input.apiKey?.trim();
        if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`);
    } else if (input.requestMode === 'server') {
        url = input.serverRoute ?? '/api/editorial-transcription';
        body = providerForm;
        body.append('endpoint', normalizedEndpoint);
        const apiKey = input.apiKey?.trim();
        if (apiKey) body.append('apiKey', apiKey);
    } else {
        throw new Error('Editorial transcription request mode is invalid.');
    }

    let response: Response;
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            body,
            headers,
            redirect: 'error',
            signal: input.signal,
        });
    } catch {
        if (input.signal?.aborted) throw createAbortError();
        // Fetch exceptions can include the raw URL, provider text or an echoed credential. No
        // arbitrary exception detail crosses this boundary, so redaction cannot miss a second
        // unrelated secret embedded in the same message.
        throw new EditorialTranscriptionRequestError('network-unreachable');
    }

    if (!response.ok) {
        // A rejected provider body has no trusted value and may itself be hostile or enormous.
        // Cancel it before classification so a known status cannot be replaced by a stream error.
        await response.body?.cancel().catch(() => undefined);
        // Browser mode classifies the provider's bounded status directly. Server mode trusts only
        // the same-origin proxy's allowlisted header because its outward 502 intentionally hides
        // the provider status; a missing/unknown header remains a generic internal failure.
        const failureCode = input.requestMode === 'browser'
            ? classifyEditorialTranscriptionProviderStatus(response.status)
            : parseEditorialTranscriptionFailureCode(
                response.headers.get(EDITORIAL_TRANSCRIPTION_FAILURE_HEADER),
            );
        if (failureCode) throw new EditorialTranscriptionRequestError(failureCode);
        throw new Error('Editorial transcription provider request failed.');
    }

    let responseBytes: Uint8Array;
    try {
        responseBytes = await readEditorialTranscriptionResponseBytes(response);
    } catch (error) {
        if (error instanceof EditorialTranscriptionResponseTooLargeError) throw error;
        if (input.signal?.aborted) throw createAbortError();
        // Stream failures are provider-controlled diagnostics just like fetch exceptions.
        throw new EditorialTranscriptionRequestError('network-unreachable');
    }
    try {
        return JSON.parse(new TextDecoder().decode(responseBytes));
    } catch {
        throw new Error('Editorial transcription provider returned invalid JSON.');
    }
}

/** Reads a provider body with an enforced stream bound even when Content-Length is absent. */
export async function readEditorialTranscriptionResponseBytes(
    response: Response,
    maxBytes = EDITORIAL_TRANSCRIPTION_RESPONSE_MAX_BYTES,
): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new Error('Editorial transcription response bound is invalid.');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new EditorialTranscriptionResponseTooLargeError();
    }
    if (!response.body) return new Uint8Array();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                // Stop the upstream body immediately instead of buffering past the fixed limit.
                await reader.cancel().catch(() => undefined);
                throw new EditorialTranscriptionResponseTooLargeError();
            }
            // A stream source may reuse its backing buffer after the next read.
            chunks.push(value.slice());
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function createAbortError(): DOMException {
    return new DOMException('Editorial transcription was cancelled.', 'AbortError');
}
