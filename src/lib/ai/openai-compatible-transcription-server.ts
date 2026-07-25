import {
    resolveOpenAICompatibleTranscriptionUrl,
    transcribeWithOpenAICompatibleEndpoint,
    type OpenAICompatibleTranscriptionRequest,
} from "@/lib/ai/openai-compatible-transcription";
import { ValidationError } from "@/lib/utils/errors";

const SERVER_ALLOWED_HOSTS_ENV = "OPENAI_COMPATIBLE_TRANSCRIPTION_SERVER_ALLOWED_HOSTS";
const LOCAL_DEVELOPMENT_HOST = "localhost";
const SERVER_TRANSCRIPTION_HEADERS_TIMEOUT_MS = 30 * 60 * 1_000;
const SERVER_TRANSCRIPTION_BODY_TIMEOUT_MS = 5 * 60 * 1_000;

export function assertServerTranscriptionEndpointAllowed(endpoint: string) {
    const url = new URL(resolveOpenAICompatibleTranscriptionUrl(endpoint));

    if (process.env.NODE_ENV !== "production"
        && normalizeHostName(url.hostname) === LOCAL_DEVELOPMENT_HOST) {
        return;
    }
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
        throw new ValidationError("Production server-mode transcription endpoints must use HTTPS.");
    }
    if (isBlockedNetworkAddress(normalizeHostName(url.hostname))) {
        throw new ValidationError("Server-mode transcription endpoint resolves to a blocked network.");
    }

    const allowedHosts = getAllowedServerHosts();
    if (allowedHosts.includes(normalizeHostName(url.host))) {
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

/**
 * Resolves every address immediately before the server transport. The deployed allowlist remains
 * the first gate; this second gate rejects DNS names that currently point at private, loopback,
 * link-local, multicast, unspecified, or cloud-metadata networks.
 */
export async function assertServerTranscriptionEndpointNetworkAllowed(
    endpoint: string,
    resolveHost: (hostname: string) => Promise<readonly string[]> = resolveServerHostAddresses,
): Promise<void> {
    assertServerTranscriptionEndpointAllowed(endpoint);
    const url = new URL(resolveOpenAICompatibleTranscriptionUrl(endpoint));
    const hostname = normalizeHostName(url.hostname);
    if (process.env.NODE_ENV !== "production" && hostname === LOCAL_DEVELOPMENT_HOST) return;
    if (isIpAddress(hostname)) {
        if (isBlockedNetworkAddress(hostname)) {
            throw new ValidationError("Server-mode transcription endpoint resolves to a blocked network.");
        }
        return;
    }
    let addresses: readonly string[];
    try {
        addresses = await resolveHost(hostname);
    } catch {
        throw new ValidationError("Server-mode transcription endpoint DNS resolution failed.");
    }
    if (addresses.length === 0 || addresses.some(isBlockedNetworkAddress)) {
        throw new ValidationError("Server-mode transcription endpoint resolves to a blocked network.");
    }
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
        return normalizeHostName(parsed.host);
    } catch {
        return normalizeHostName(trimmed);
    }
}

function normalizeHostName(host: string): string {
    return host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
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

function isIpAddress(value: string): boolean {
    return parseIpv4(value) !== null || value.includes(":");
}

export function isBlockedNetworkAddress(value: string): boolean {
    const normalized = normalizeHostName(value).toLowerCase();
    const ipv4 = parseIpv4(normalized);
    if (ipv4) {
        const [a, b, c] = ipv4;
        return a === 0
            || a === 10
            || a === 127
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 0 && c === 0)
            || (a === 192 && b === 0 && c === 2)
            || (a === 192 && b === 88 && c === 99)
            || (a === 192 && b === 168)
            || (a === 198 && (b === 18 || b === 19))
            || (a === 198 && b === 51 && c === 100)
            || (a === 203 && b === 0 && c === 113)
            || a >= 224;
    }
    const ipv6 = parseIpv6(normalized);
    if (!ipv6) return false;
    const allZero = ipv6.every(byte => byte === 0);
    const loopback = ipv6.slice(0, 15).every(byte => byte === 0) && ipv6[15] === 1;
    const ipv4Mapped = ipv6.slice(0, 10).every(byte => byte === 0)
        && ipv6[10] === 0xff
        && ipv6[11] === 0xff;
    if (ipv4Mapped) {
        return isBlockedNetworkAddress(
            `${ipv6[12]}.${ipv6[13]}.${ipv6[14]}.${ipv6[15]}`,
        );
    }
    return allZero
        || loopback
        || matchesIpv6Prefix(ipv6, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)
        || matchesIpv6Prefix(ipv6, [0x01, 0x00], 64)
        || matchesIpv6Prefix(ipv6, [0x20, 0x01, 0x00, 0x02], 48)
        || matchesIpv6Prefix(ipv6, [0x20, 0x01, 0x0d, 0xb8], 32)
        || matchesIpv6Prefix(ipv6, [0x20, 0x02], 16)
        || matchesIpv6Prefix(ipv6, [0xfc], 7)
        || matchesIpv6Prefix(ipv6, [0xfe, 0x80], 10)
        || matchesIpv6Prefix(ipv6, [0xfe, 0xc0], 10)
        || matchesIpv6Prefix(ipv6, [0xff], 8);
}

function parseIpv4(value: string): [number, number, number, number] | null {
    const parts = value.split(".");
    if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part))) return null;
    const octets = parts.map(Number);
    return octets.every(octet => octet >= 0 && octet <= 255)
        ? octets as [number, number, number, number]
        : null;
}

function parseIpv6(value: string): Uint8Array | null {
    if (!value.includes(":") || value.includes("%")) return null;
    let candidate = value;
    let ipv4Tail: number[] = [];
    const lastColon = candidate.lastIndexOf(":");
    const dottedTail = candidate.slice(lastColon + 1);
    if (dottedTail.includes(".")) {
        const parsedTail = parseIpv4(dottedTail);
        if (!parsedTail) return null;
        ipv4Tail = [
            parsedTail[0] * 256 + parsedTail[1],
            parsedTail[2] * 256 + parsedTail[3],
        ];
        candidate = `${candidate.slice(0, lastColon)}:${ipv4Tail
            .map(part => part.toString(16)).join(":")}`;
    }
    const doubleColonParts = candidate.split("::");
    if (doubleColonParts.length > 2) return null;
    const parseParts = (part: string): number[] | null => {
        if (!part) return [];
        const groups = part.split(":");
        if (groups.some(group => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
        return groups.map(group => Number.parseInt(group, 16));
    };
    const left = parseParts(doubleColonParts[0]);
    const right = parseParts(doubleColonParts[1] ?? "");
    if (!left || !right) return null;
    const missing = 8 - left.length - right.length;
    if ((doubleColonParts.length === 1 && missing !== 0)
        || (doubleColonParts.length === 2 && missing < 1)) {
        return null;
    }
    const groups = [
        ...left,
        ...Array.from({ length: missing }, () => 0),
        ...right,
    ];
    if (groups.length !== 8) return null;
    const bytes = new Uint8Array(16);
    groups.forEach((group, index) => {
        bytes[index * 2] = group >>> 8;
        bytes[index * 2 + 1] = group & 0xff;
    });
    return bytes;
}

function matchesIpv6Prefix(
    address: Uint8Array,
    prefix: readonly number[],
    prefixBits: number,
): boolean {
    const completeBytes = Math.floor(prefixBits / 8);
    for (let index = 0; index < completeBytes; index += 1) {
        if (address[index] !== (prefix[index] ?? 0)) return false;
    }
    const remainingBits = prefixBits % 8;
    if (remainingBits === 0) return true;
    const mask = 0xff << (8 - remainingBits);
    return (address[completeBytes] & mask) === ((prefix[completeBytes] ?? 0) & mask);
}
