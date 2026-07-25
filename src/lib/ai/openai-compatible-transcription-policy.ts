import { resolveOpenAICompatibleTranscriptionUrl } from '@/lib/ai/openai-compatible-transcription';
import { ValidationError } from '@/lib/utils/errors';

const SERVER_ALLOWED_HOSTS_ENV =
    'OPENAI_COMPATIBLE_TRANSCRIPTION_SERVER_ALLOWED_HOSTS';
const LOCAL_DEVELOPMENT_HOST = 'localhost';

export function assertServerTranscriptionEndpointAllowed(endpoint: string) {
    const url = new URL(resolveOpenAICompatibleTranscriptionUrl(endpoint));

    if (
        process.env.NODE_ENV !== 'production'
        && normalizeHostName(url.hostname) === LOCAL_DEVELOPMENT_HOST
    ) {
        return;
    }
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
        throw new ValidationError(
            'Production server-mode transcription endpoints must use HTTPS.',
        );
    }
    if (isBlockedNetworkAddress(normalizeHostName(url.hostname))) {
        throw new ValidationError(
            'Server-mode transcription endpoint resolves to a blocked network.',
        );
    }

    const allowedHosts = getAllowedServerHosts();
    if (allowedHosts.includes(normalizeHostName(url.host))) return;

    throw new ValidationError(
        `Server-mode custom transcription endpoint is not allowed. Add its host to ${
            SERVER_ALLOWED_HOSTS_ENV
        } or use browser mode.`,
    );
}

/**
 * Applies the shared SSRF policy to resolver results supplied by the owning
 * runtime. Keeping DNS and socket implementations out of this module makes the
 * policy statically reusable by both Workerd-facing and packaged Node callers.
 */
export async function assertServerTranscriptionEndpointNetworkAllowedWithResolver(
    endpoint: string,
    resolveHost: (hostname: string) => Promise<readonly string[]>,
): Promise<void> {
    assertServerTranscriptionEndpointAllowed(endpoint);
    const url = new URL(resolveOpenAICompatibleTranscriptionUrl(endpoint));
    const hostname = normalizeHostName(url.hostname);
    if (
        process.env.NODE_ENV !== 'production'
        && hostname === LOCAL_DEVELOPMENT_HOST
    ) {
        return;
    }
    if (isIpAddress(hostname)) {
        if (isBlockedNetworkAddress(hostname)) {
            throw new ValidationError(
                'Server-mode transcription endpoint resolves to a blocked network.',
            );
        }
        return;
    }
    let addresses: readonly string[];
    try {
        addresses = await resolveHost(hostname);
    } catch {
        throw new ValidationError(
            'Server-mode transcription endpoint DNS resolution failed.',
        );
    }
    if (
        addresses.length === 0
        || addresses.some(isBlockedNetworkAddress)
    ) {
        throw new ValidationError(
            'Server-mode transcription endpoint resolves to a blocked network.',
        );
    }
}

export function normalizeHostName(host: string): string {
    return host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

export function isIpAddress(value: string): boolean {
    return parseIpv4(value) !== null || value.includes(':');
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
            || a === 192 && b === 168
            || a === 198 && (b === 18 || b === 19)
            || (a === 198 && b === 51 && c === 100)
            || (a === 203 && b === 0 && c === 113)
            || a >= 224;
    }
    const ipv6 = parseIpv6(normalized);
    if (!ipv6) return false;
    const allZero = ipv6.every((byte) => byte === 0);
    const loopback =
        ipv6.slice(0, 15).every((byte) => byte === 0) && ipv6[15] === 1;
    const ipv4Mapped =
        ipv6.slice(0, 10).every((byte) => byte === 0)
        && ipv6[10] === 0xff
        && ipv6[11] === 0xff;
    if (ipv4Mapped) {
        return isBlockedNetworkAddress(
            `${ipv6[12]}.${ipv6[13]}.${ipv6[14]}.${ipv6[15]}`,
        );
    }
    return allZero
        || loopback
        || matchesIpv6Prefix(
            ipv6,
            [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01],
            48,
        )
        || matchesIpv6Prefix(ipv6, [0x01, 0x00], 64)
        || matchesIpv6Prefix(ipv6, [0x20, 0x01, 0x00, 0x02], 48)
        || matchesIpv6Prefix(ipv6, [0x20, 0x01, 0x0d, 0xb8], 32)
        || matchesIpv6Prefix(ipv6, [0x20, 0x02], 16)
        || matchesIpv6Prefix(ipv6, [0xfc], 7)
        || matchesIpv6Prefix(ipv6, [0xfe, 0x80], 10)
        || matchesIpv6Prefix(ipv6, [0xfe, 0xc0], 10)
        || matchesIpv6Prefix(ipv6, [0xff], 8);
}

function getAllowedServerHosts(): string[] {
    return (process.env[SERVER_ALLOWED_HOSTS_ENV] || '')
        .split(',')
        .map((host) => normalizeAllowlistEntry(host))
        .filter(Boolean);
}

function normalizeAllowlistEntry(entry: string): string {
    const trimmed = entry.trim();
    if (!trimmed) return '';
    try {
        const parsed = new URL(
            trimmed.includes('://') ? trimmed : `https://${trimmed}`,
        );
        return normalizeHostName(parsed.host);
    } catch {
        return normalizeHostName(trimmed);
    }
}

function parseIpv4(
    value: string,
): [number, number, number, number] | null {
    const parts = value.split('.');
    if (
        parts.length !== 4
        || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part))
    ) {
        return null;
    }
    const octets = parts.map(Number);
    return octets.every((octet) => octet >= 0 && octet <= 255)
        ? octets as [number, number, number, number]
        : null;
}

function parseIpv6(value: string): Uint8Array | null {
    if (!value.includes(':') || value.includes('%')) return null;
    let candidate = value;
    const lastColon = candidate.lastIndexOf(':');
    const dottedTail = candidate.slice(lastColon + 1);
    if (dottedTail.includes('.')) {
        const parsedTail = parseIpv4(dottedTail);
        if (!parsedTail) return null;
        const ipv4Tail = [
            parsedTail[0] * 256 + parsedTail[1],
            parsedTail[2] * 256 + parsedTail[3],
        ];
        candidate = `${candidate.slice(0, lastColon)}:${ipv4Tail
            .map((part) => part.toString(16))
            .join(':')}`;
    }
    const doubleColonParts = candidate.split('::');
    if (doubleColonParts.length > 2) return null;
    const parseParts = (part: string): number[] | null => {
        if (!part) return [];
        const groups = part.split(':');
        if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
            return null;
        }
        return groups.map((group) => Number.parseInt(group, 16));
    };
    const left = parseParts(doubleColonParts[0]);
    const right = parseParts(doubleColonParts[1] ?? '');
    if (!left || !right) return null;
    const missing = 8 - left.length - right.length;
    if (
        (doubleColonParts.length === 1 && missing !== 0)
        || (doubleColonParts.length === 2 && missing < 1)
    ) {
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
    return (address[completeBytes] & mask)
        === ((prefix[completeBytes] ?? 0) & mask);
}
