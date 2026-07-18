import { ValidationError } from "@/lib/utils/errors";
import type { OpenAICompatibleTranscriptionSettings } from "@/types/transcription";

const DEFAULT_TRANSCRIPTION_PATH = "/v1/audio/transcriptions";
const TRANSCRIPTION_ENDPOINT_SUFFIX = "/audio/transcriptions";

interface OpenAICompatibleTranscriptionRequest {
    settings: OpenAICompatibleTranscriptionSettings;
    audioFile: File | Blob;
    fallbackModel: string;
    options?: Record<string, unknown>;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
}

export function parseOpenAICompatibleTranscriptionSettings(value: FormDataEntryValue | null): OpenAICompatibleTranscriptionSettings | null {
    if (typeof value !== "string" || !value.trim()) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new ValidationError("Custom transcription settings must be valid JSON.");
    }

    if (!isRecord(parsed)) {
        throw new ValidationError("Custom transcription settings must be an object.");
    }

    if (parsed.enabled !== true) {
        return null;
    }

    if (typeof parsed.endpoint !== "string" || !parsed.endpoint.trim()) {
        throw new ValidationError("Custom transcription endpoint is required.");
    }

    return {
        enabled: true,
        requestMode: parsed.requestMode === "browser" ? "browser" : "server",
        endpoint: parsed.endpoint.trim(),
        apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : undefined,
        model: typeof parsed.model === "string" ? parsed.model.trim() : undefined,
    };
}

export function resolveOpenAICompatibleTranscriptionUrl(endpoint: string): string {
    const candidate = endpoint.trim();

    if (!candidate) {
        throw new ValidationError("Custom transcription endpoint is required.");
    }

    let url: URL;
    try {
        url = new URL(hasExplicitProtocol(candidate) ? candidate : `http://${candidate}`);
    } catch {
        throw new ValidationError("Custom transcription endpoint must be a valid URL.");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new ValidationError("Custom transcription endpoint must use http or https.");
    }

    if (url.username || url.password) {
        throw new ValidationError("Put credentials in the API key field, not in the endpoint URL.");
    }

    // The user may provide a domain, a base OpenAI route, or the exact endpoint.
    // Normalizing here keeps the UI flexible while the server always sends one
    // well-known OpenAI-compatible multipart request shape.
    const trimmedPath = url.pathname.replace(/\/+$/, "");
    if (!trimmedPath || trimmedPath === "/") {
        url.pathname = DEFAULT_TRANSCRIPTION_PATH;
    } else if (!trimmedPath.endsWith(TRANSCRIPTION_ENDPOINT_SUFFIX)) {
        url.pathname = `${trimmedPath}${TRANSCRIPTION_ENDPOINT_SUFFIX}`;
    } else {
        url.pathname = trimmedPath;
    }

    url.hash = "";
    return url.toString();
}

export async function transcribeWithOpenAICompatibleEndpoint({
    settings,
    audioFile,
    fallbackModel,
    options = {},
    fetchImpl = fetch,
    signal,
}: OpenAICompatibleTranscriptionRequest): Promise<unknown> {
    const endpointUrl = resolveOpenAICompatibleTranscriptionUrl(settings.endpoint);
    const formData = new FormData();

    formData.append("file", audioFile, getAudioFilename(audioFile));
    formData.append("model", settings.model?.trim() || fallbackModel);
    appendOpenAICompatibleOptions(formData, options);

    const headers = new Headers();
    if (settings.apiKey?.trim()) {
        headers.set("Authorization", `Bearer ${settings.apiKey.trim()}`);
    }

    const response = await fetchImpl(endpointUrl, {
        method: "POST",
        body: formData,
        headers,
        redirect: "error",
        signal,
    });

    const responseText = await response.text();
    const responseBody = parseJsonResponse(responseText);

    if (!response.ok) {
        const responseMessage = extractErrorMessage(responseBody, responseText);
        throw new Error(
            `Custom transcription endpoint error (${response.status}): ${redactConfiguredApiKey(responseMessage, settings.apiKey)}`
        );
    }

    return responseBody;
}

function appendOpenAICompatibleOptions(formData: FormData, options: Record<string, unknown>) {
    for (const [key, value] of Object.entries(options)) {
        if (value === undefined || value === null) {
            continue;
        }

        if (Array.isArray(value)) {
            const multipartKey = key === "timestamp_granularities" ? "timestamp_granularities[]" : key;
            value.forEach(item => formData.append(multipartKey, String(item)));
            continue;
        }

        if (typeof value === "object") {
            formData.append(key, JSON.stringify(value));
            continue;
        }

        formData.append(key, String(value));
    }
}

function getAudioFilename(audioFile: File | Blob): string {
    if ("name" in audioFile && typeof audioFile.name === "string" && audioFile.name.trim()) {
        return audioFile.name;
    }

    return "audio.mp4";
}

function parseJsonResponse(responseText: string): unknown {
    if (!responseText.trim()) {
        return {};
    }

    try {
        return JSON.parse(responseText);
    } catch {
        return responseText;
    }
}

function extractErrorMessage(responseBody: unknown, fallback: string): string {
    if (isRecord(responseBody)) {
        const error = responseBody.error;
        if (isRecord(error) && typeof error.message === "string") {
            return error.message;
        }

        if (typeof responseBody.message === "string") {
            return responseBody.message;
        }
    }

    return fallback.trim() || "No error body returned.";
}

/**
 * Custom services sometimes echo request credentials in their response errors.
 * Only the configured key is redacted so useful provider diagnostics remain
 * available without putting that browser-local secret into UI errors or logs.
 */
function redactConfiguredApiKey(message: string, configuredApiKey: string | undefined): string {
    const candidates = Array.from(new Set([configuredApiKey, configuredApiKey?.trim()]))
        .filter((candidate): candidate is string => Boolean(candidate));

    return candidates
        .sort((left, right) => right.length - left.length)
        .reduce((redacted, candidate) => redacted.split(candidate).join("[REDACTED]"), message);
}

function hasExplicitProtocol(value: string): boolean {
    return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
