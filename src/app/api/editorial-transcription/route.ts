import { assertServerTranscriptionEndpointAllowed } from '@/lib/ai/openai-compatible-transcription-server';
import { normalizeEditorialTranscriptionEndpoint } from '@/lib/editorial-transcription/endpoint';
import {
    buildEditorialTranscriptionProviderMultipart,
    classifyEditorialTranscriptionProviderStatus,
    EDITORIAL_TRANSCRIPTION_FAILURE_HEADER,
    EDITORIAL_TRANSCRIPTION_MAX_WAV_BYTES,
    EditorialTranscriptionResponseTooLargeError,
    readEditorialTranscriptionResponseBytes,
    type EditorialTranscriptionFailureCode,
} from '@/lib/editorial-transcription/request';
import { normalizeEditorialLanguage } from '@/lib/editorial-transcription/preferences';
import {
    EditorialProviderTimeoutError,
    requestEditorialTranscriptionProvider,
} from '@/lib/editorial-transcription/server-provider-transport';

const EDITORIAL_TRANSCRIPTION_MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const EDITORIAL_TRANSCRIPTION_MAX_ENDPOINT_CHARACTERS = 2_048;
const EDITORIAL_TRANSCRIPTION_MAX_API_KEY_CHARACTERS = 16_384;

const ALLOWED_FIELDS = new Set([
    'file',
    'endpoint',
    'apiKey',
    'model',
    'response_format',
    'stream',
    'diarize',
    'language',
]);

/**
 * Strict server proxy for the frozen editorial request.
 *
 * This route intentionally does not use the generic controller error wrapper because that
 * wrapper logs caught errors. Provider/network exceptions can contain an endpoint, transcript
 * text or echoed credential, so every failure here is mapped to a bounded generic response with
 * no logging. The API key exists only in this request scope and the outbound Headers instance.
 */
export async function POST(request: Request): Promise<Response> {
    try {
        let formData: FormData;
        try {
            const contentType = request.headers.get('content-type');
            if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) {
                throw new EditorialRouteValidationError('Multipart form data is required.');
            }
            // request.formData() alone may buffer an arbitrarily large chunked body before the
            // File.size check. Reusing the stream-bounded reader enforces the limit even when an
            // attacker omits Content-Length; only the bounded bytes are handed to the parser.
            const upload = new Response(request.body, { headers: request.headers });
            const bytes = await readEditorialTranscriptionResponseBytes(
                upload,
                EDITORIAL_TRANSCRIPTION_MAX_WAV_BYTES
                    + EDITORIAL_TRANSCRIPTION_MAX_MULTIPART_OVERHEAD_BYTES,
            );
            formData = await new Response(bytes, {
                headers: { 'content-type': contentType },
            }).formData();
        } catch (error) {
            if (error instanceof EditorialTranscriptionResponseTooLargeError) {
                return jsonError('Editorial transcription upload is too large.', 413);
            }
            if (request.signal.aborted) {
                return jsonError('Editorial transcription request cancelled.', 499);
            }
            if (error instanceof EditorialRouteValidationError) throw error;
            throw new EditorialRouteValidationError('Multipart form data is invalid.');
        }
        validateExactFieldSet(formData);
        const wav = formData.get('file');
        if (!(wav instanceof File)) throw new EditorialRouteValidationError('WAV file is required.');
        if (wav.size > EDITORIAL_TRANSCRIPTION_MAX_WAV_BYTES) {
            return jsonError('Editorial transcription upload is too large.', 413);
        }
        await assertCanonicalEditorialWav(wav);

        const endpointEntry = formData.get('endpoint');
        if (typeof endpointEntry !== 'string') {
            throw new EditorialRouteValidationError('Editorial transcription endpoint is required.');
        }
        const endpoint = normalizeEditorialTranscriptionEndpoint(requireBoundedString(
            endpointEntry,
            'endpoint',
            EDITORIAL_TRANSCRIPTION_MAX_ENDPOINT_CHARACTERS,
        ));
        // This check must happen after canonical URL normalization and before constructing any
        // outbound request. In production it preserves the existing explicit host allowlist;
        // development continues to permit a user-owned localhost transcriber.
        assertServerTranscriptionEndpointAllowed(endpoint);

        const languageEntry = formData.get('language');
        const language = languageEntry === null
            ? null
            : normalizeEditorialLanguage(requireString(languageEntry, 'language'));
        const diarize = formData.get('diarize') === 'true';
        const providerForm = buildEditorialTranscriptionProviderMultipart({
            wav,
            language,
            speakerMode: diarize ? 'diarized' : 'none',
        });
        const apiKeyEntry = formData.get('apiKey');
        const apiKey = apiKeyEntry === null ? '' : requireBoundedString(
            apiKeyEntry,
            'apiKey',
            EDITORIAL_TRANSCRIPTION_MAX_API_KEY_CHARACTERS,
        ).trim();
        const headers = new Headers();
        if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`);

        let providerResult;
        try {
            providerResult = await requestEditorialTranscriptionProvider({
                endpoint,
                body: providerForm,
                headers,
                signal: request.signal,
            });
        } catch (error) {
            if (request.signal.aborted) return jsonError('Editorial transcription request cancelled.', 499);
            if (error instanceof EditorialProviderTimeoutError) {
                return jsonError(
                    'Editorial transcription provider timed out.',
                    504,
                    'provider-timeout',
                );
            }
            if (error instanceof EditorialTranscriptionResponseTooLargeError) {
                return jsonError('Editorial transcription provider response is too large.', 502);
            }
            return jsonError(
                'Editorial transcription provider is unavailable.',
                502,
                'network-unreachable',
            );
        }

        if (providerResult.kind === 'rejected') {
            // The transport has already cancelled the untrusted body. Only its bounded numeric
            // status reaches this layer and is collapsed into the closed outward vocabulary.
            return jsonError(
                'Editorial transcription provider request failed.',
                502,
                classifyEditorialTranscriptionProviderStatus(providerResult.status) ?? undefined,
            );
        }
        let payload: unknown;
        try {
            payload = JSON.parse(new TextDecoder().decode(providerResult.bytes));
        } catch {
            return jsonError('Editorial transcription provider returned invalid JSON.', 502);
        }
        return Response.json(payload);
    } catch (error) {
        if (error instanceof EditorialRouteValidationError || isValidationError(error)) {
            return jsonError('Invalid editorial transcription request.', 400);
        }
        return jsonError('Editorial transcription request failed.', 500);
    }
}

function validateExactFieldSet(formData: FormData): void {
    const counts = new Map<string, number>();
    formData.forEach((_value, key) => {
        if (!ALLOWED_FIELDS.has(key)) {
            throw new EditorialRouteValidationError('Unsupported multipart field.');
        }
        counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    if (Array.from(counts.values()).some(count => count !== 1)) {
        throw new EditorialRouteValidationError('Multipart fields must be unique.');
    }
    if (
        formData.get('model') !== 'qwen-1.7b-edit-max'
        || formData.get('response_format') !== 'verbose_json'
        || formData.get('stream') !== 'false'
        || (formData.has('diarize') && formData.get('diarize') !== 'true')
    ) {
        throw new EditorialRouteValidationError('Frozen editorial request fields are invalid.');
    }
}

async function assertCanonicalEditorialWav(file: File): Promise<void> {
    if (file.size < 44) throw new EditorialRouteValidationError('WAV header is incomplete.');
    const header = new DataView(await file.slice(0, 44).arrayBuffer());
    const ascii = (offset: number, length: number) => {
        let value = '';
        const bytes = new Uint8Array(header.buffer, header.byteOffset + offset, length);
        for (let index = 0; index < bytes.length; index += 1) {
            value += String.fromCharCode(bytes[index]);
        }
        return value;
    };
    const dataSize = header.getUint32(40, true);
    if (
        ascii(0, 4) !== 'RIFF'
        || ascii(8, 4) !== 'WAVE'
        || ascii(12, 4) !== 'fmt '
        || header.getUint32(16, true) !== 16
        || header.getUint16(20, true) !== 1
        || header.getUint16(22, true) !== 1
        || header.getUint32(24, true) !== 16_000
        || header.getUint32(28, true) !== 32_000
        || header.getUint16(32, true) !== 2
        || header.getUint16(34, true) !== 16
        || ascii(36, 4) !== 'data'
        || header.getUint32(4, true) !== dataSize + 36
        || file.size !== dataSize + 44
        || dataSize % 2 !== 0
    ) {
        throw new EditorialRouteValidationError('WAV must be canonical mono PCM16 16 kHz.');
    }
}

function requireString(value: FormDataEntryValue, field: string): string {
    if (typeof value !== 'string') throw new EditorialRouteValidationError(`${field} must be text.`);
    return value;
}

function requireBoundedString(
    value: FormDataEntryValue,
    field: string,
    maximumCharacters: number,
): string {
    const parsed = requireString(value, field);
    if (parsed.length > maximumCharacters) {
        throw new EditorialRouteValidationError(`${field} is too long.`);
    }
    return parsed;
}

function jsonError(
    error: string,
    status: number,
    failureCode?: EditorialTranscriptionFailureCode,
): Response {
    return Response.json({ error }, {
        status,
        ...(failureCode
            ? { headers: { [EDITORIAL_TRANSCRIPTION_FAILURE_HEADER]: failureCode } }
            : {}),
    });
}

function isValidationError(error: unknown): boolean {
    return error instanceof Error && error.name === 'ValidationError';
}

class EditorialRouteValidationError extends Error {}
