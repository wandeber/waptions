import { resolveOpenAICompatibleTranscriptionUrl } from "@/lib/ai/openai-compatible-transcription";
import { ValidationError } from "@/lib/utils/errors";

const SERVER_ALLOWED_HOSTS_ENV = "OPENAI_COMPATIBLE_TRANSCRIPTION_SERVER_ALLOWED_HOSTS";
const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function assertServerTranscriptionEndpointAllowed(endpoint: string) {
    const url = new URL(resolveOpenAICompatibleTranscriptionUrl(endpoint));

    if (process.env.NODE_ENV !== "production" && LOCALHOST_NAMES.has(normalizeHostName(url.hostname))) {
        return;
    }

    const allowedHosts = getAllowedServerHosts();
    const candidates = new Set([
        normalizeHostName(url.hostname),
        normalizeHostName(url.host),
    ]);

    if (allowedHosts.some(host => candidates.has(host))) {
        return;
    }

    // Server mode can otherwise become SSRF: the backend would fetch arbitrary
    // user-provided URLs from its own network position. Browser mode remains
    // the flexible option for user-local transcribers because CORS controls
    // whether the browser may read the response.
    throw new ValidationError(
        `Server-mode custom transcription endpoint is not allowed. Add its host to ${SERVER_ALLOWED_HOSTS_ENV} or use browser mode.`
    );
}

function getAllowedServerHosts(): string[] {
    return (process.env[SERVER_ALLOWED_HOSTS_ENV] || "")
        .split(",")
        .map(host => normalizeAllowlistEntry(host))
        .filter(Boolean);
}

function normalizeAllowlistEntry(entry: string): string {
    const trimmed = entry.trim();
    if (!trimmed) {
        return "";
    }

    try {
        const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
        return normalizeHostName(parsed.host || parsed.hostname);
    } catch {
        return normalizeHostName(trimmed);
    }
}

function normalizeHostName(host: string): string {
    return host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}
