import {
    resolveOpenAICompatibleTranscriptionUrl,
    transcribeWithOpenAICompatibleEndpoint,
    type OpenAICompatibleTranscriptionRequest,
} from "@/lib/ai/openai-compatible-transcription";
import {
    assertServerTranscriptionEndpointNetworkAllowedWithResolver,
    isBlockedNetworkAddress,
    isIpAddress,
    normalizeHostName,
} from "@/lib/ai/openai-compatible-transcription-policy";
import { ValidationError } from "@/lib/utils/errors";

const LOCAL_DEVELOPMENT_HOST = "localhost";
const SERVER_TRANSCRIPTION_HEADERS_TIMEOUT_MS = 30 * 60 * 1_000;
const SERVER_TRANSCRIPTION_BODY_TIMEOUT_MS = 5 * 60 * 1_000;

export {
    assertServerTranscriptionEndpointAllowed,
    assertServerTranscriptionEndpointNetworkAllowedWithResolver,
    isBlockedNetworkAddress,
    isIpAddress,
} from "@/lib/ai/openai-compatible-transcription-policy";

export async function assertServerTranscriptionEndpointNetworkAllowed(
    endpoint: string,
): Promise<void> {
    await assertServerTranscriptionEndpointNetworkAllowedWithResolver(
        endpoint,
        resolveServerHostAddresses,
    );
}

export interface ServerTranscriptionTransport {
    fetch: typeof fetch;
    dispose(): Promise<void>;
}

/**
 * Keeps Node-only transport policy out of the browser transcription module.
 * Server callers must enter through this wrapper so allowlisting, DNS pinning,
 * and dispatcher disposal remain inseparable from the outbound request.
 */
export async function transcribeWithServerOpenAICompatibleEndpoint(
    request: OpenAICompatibleTranscriptionRequest,
): Promise<unknown> {
    const endpoint = resolveOpenAICompatibleTranscriptionUrl(request.settings.endpoint);
    const transport = await createServerTranscriptionTransport(endpoint, request.fetchImpl);
    try {
        return await transcribeWithOpenAICompatibleEndpoint({
            ...request,
            fetchImpl: transport.fetch,
        });
    } finally {
        await transport.dispose();
    }
}

/**
 * Pins Node connections to one address that passed the private-network policy.
 *
 * A validation-only DNS lookup would still permit rebinding between the check and Undici's own
 * lookup. The custom lookup callback removes that race. Workerd uses its strict-public global
 * fetch routing and therefore needs no Node dispatcher.
 */
export async function createServerTranscriptionTransport(
    endpoint: string,
    fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ServerTranscriptionTransport> {
    await assertServerTranscriptionEndpointNetworkAllowed(endpoint);
    const url = new URL(resolveOpenAICompatibleTranscriptionUrl(endpoint));
    const hostname = normalizeHostName(url.hostname);
    if (typeof process === "undefined"
        || process.release?.name !== "node"
        || fetchImpl !== globalThis.fetch) {
        return { fetch: fetchImpl, dispose: async () => undefined };
    }
    const { Agent } = await import("undici");
    const isDevelopmentLocalhost = process.env.NODE_ENV !== "production"
        && hostname === LOCAL_DEVELOPMENT_HOST;
    let connect: {
        lookup: (
            hostname: string,
            options: unknown,
            callback: (error: Error | null, address: string, family: number) => void,
        ) => void;
    } | undefined;
    if (!isDevelopmentLocalhost) {
        const addresses = isIpAddress(hostname)
            ? [hostname]
            : await resolveServerHostAddresses(hostname);
        if (addresses.length === 0 || addresses.some(isBlockedNetworkAddress)) {
            throw new ValidationError("Server-mode transcription endpoint resolves to a blocked network.");
        }
        const pinnedAddress = [...addresses].sort()[0];
        if (!pinnedAddress) {
            throw new ValidationError("Server-mode transcription endpoint resolves to a blocked network.");
        }
        const family = pinnedAddress.includes(":") ? 6 : 4;
        connect = {
            lookup: (
                _hostname: string,
                _options: unknown,
                callback: (error: Error | null, address: string, family: number) => void,
            ) => callback(null, pinnedAddress, family),
        };
    }
    const dispatcher = new Agent({
        headersTimeout: SERVER_TRANSCRIPTION_HEADERS_TIMEOUT_MS,
        bodyTimeout: SERVER_TRANSCRIPTION_BODY_TIMEOUT_MS,
        ...(connect ? { connect } : {}),
    });
    return {
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, {
            ...init,
            dispatcher,
        } as RequestInit)) as typeof fetch,
        dispose: async () => { await dispatcher.close(); },
    };
}

async function resolveServerHostAddresses(hostname: string): Promise<readonly string[]> {
    if (typeof process === "undefined" || process.release?.name !== "node") {
        // Workerd's global_fetch_strictly_public routing is the network enforcement layer. Literal
        // IPs were already classified above and the hostname still passed the production allowlist.
        return ["8.8.8.8"];
    }
    const dns = await import("node:dns/promises");
    const [ipv4, ipv6] = await Promise.all([
        dns.resolve4(hostname).catch(error => isNoDataDnsError(error) ? [] : Promise.reject(error)),
        dns.resolve6(hostname).catch(error => isNoDataDnsError(error) ? [] : Promise.reject(error)),
    ]);
    return [...ipv4, ...ipv6];
}

function isNoDataDnsError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const code = Reflect.get(error, "code");
    return code === "ENODATA" || code === "ENOTFOUND" || code === "EAI_NONAME";
}
