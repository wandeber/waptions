import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
    assertServerTranscriptionEndpointNetworkAllowed,
    isBlockedNetworkAddress,
} from '../../../src/lib/ai/openai-compatible-transcription-server';
import {
    createEditorialEndpointIdentityDigest,
    normalizeEditorialTranscriptionEndpoint,
} from '../../../src/lib/editorial-transcription/endpoint';
import type {
    ManagedCredentialCapabilityAuthorityPort,
    ManagedCredentialCapabilityIssueRequest,
    ManagedEndpointCapabilityAuthorityPort,
    ManagedEndpointCapabilityIssueRequest,
    ManagedEndpointCapabilityScope,
    ResolvedManagedCredentialCapability,
    ResolvedManagedEndpointCapability,
} from './contracts';
import { ManagedTranscriptionError } from './errors';

const MAX_CAPABILITY_LIFETIME_MS = 24 * 60 * 60 * 1_000;

interface EndpointAuthorityRecord extends ResolvedManagedEndpointCapability {
    readonly revoked: boolean;
}

interface CredentialAuthorityRecord extends ResolvedManagedCredentialCapability {
    readonly revoked: boolean;
}

export interface ManagedEndpointCapabilityAuthorityOptions {
    readonly now?: () => number;
    readonly resolveLocalhost?: () => Promise<readonly {
        address: string;
        family: 4 | 6;
    }[]>;
    readonly validateServerEndpoint?: (endpoint: string) => Promise<void>;
}

/**
 * Process-local endpoint authority. Capability records are issuer-owned and never serializable
 * job inputs, so an endpoint URL cannot enter jobs, events, receipts, artifacts or checkpoints.
 */
export class ManagedEndpointCapabilityAuthority
implements ManagedEndpointCapabilityAuthorityPort {
    private readonly records = new Map<string, EndpointAuthorityRecord>();
    private readonly now: () => number;
    private readonly resolveLocalhost: NonNullable<
        ManagedEndpointCapabilityAuthorityOptions['resolveLocalhost']
    >;
    private readonly validateServerEndpoint: NonNullable<
        ManagedEndpointCapabilityAuthorityOptions['validateServerEndpoint']
    >;

    constructor(options: ManagedEndpointCapabilityAuthorityOptions = {}) {
        this.now = options.now ?? Date.now;
        this.resolveLocalhost = options.resolveLocalhost ?? resolveLoopbackAddresses;
        this.validateServerEndpoint = options.validateServerEndpoint
            ?? assertServerTranscriptionEndpointNetworkAllowed;
    }

    async issue(request: ManagedEndpointCapabilityIssueRequest): Promise<string> {
        assertScope(request.scope);
        const lifetimeMilliseconds = assertLifetime(request.lifetimeMilliseconds);
        let normalized: string;
        try {
            normalized = normalizeEditorialTranscriptionEndpoint(request.endpoint);
        } catch {
            throw endpointPolicyError();
        }
        let pinnedLoopbackAddress: string | undefined;
        let pinnedLoopbackFamily: 4 | 6 | undefined;
        if (request.kind === 'local') {
            assertExactLocalEndpoint(request.endpoint, normalized);
            const addresses = await this.resolveLocalhost();
            const pinned = selectLoopbackAddress(addresses);
            pinnedLoopbackAddress = pinned.address;
            pinnedLoopbackFamily = pinned.family;
        } else if (request.kind === 'server') {
            const hostname = new URL(normalized).hostname
                .toLowerCase()
                .replace(/^\[/, '')
                .replace(/\]$/, '');
            // The shared server policy has a development localhost exception for the web app.
            // Managed jobs must never inherit it: localhost belongs exclusively to the exact,
            // DNS-pinned local capability branch above.
            if (hostname === 'localhost' || isBlockedNetworkAddress(hostname)) {
                throw endpointPolicyError();
            }
            try {
                await this.validateServerEndpoint(normalized);
            } catch {
                throw endpointPolicyError();
            }
        } else {
            throw new ManagedTranscriptionError(
                'ENDPOINT_POLICY_REJECTED',
                false,
                'The managed endpoint kind is unsupported.',
            );
        }
        const capabilityId = `transcription-endpoint:${randomUUID()}`;
        this.records.set(capabilityId, {
            capabilityId,
            kind: request.kind,
            endpoint: normalized,
            endpointIdentityDigest: await createEditorialEndpointIdentityDigest(normalized),
            scope: Object.freeze({ ...request.scope }),
            expiresAtMilliseconds: this.now() + lifetimeMilliseconds,
            ...(pinnedLoopbackAddress
                ? { pinnedLoopbackAddress, pinnedLoopbackFamily }
                : {}),
            revoked: false,
        });
        return capabilityId;
    }

    async resolve(
        capabilityId: string,
        scope: ManagedEndpointCapabilityScope,
    ): Promise<ResolvedManagedEndpointCapability> {
        assertScope(scope);
        const record = this.records.get(capabilityId);
        if (!record || !sameScope(record.scope, scope)) {
            throw new ManagedTranscriptionError(
                'CAPABILITY_EXPIRED',
                true,
                'The managed endpoint capability is unavailable.',
            );
        }
        if (record.revoked || record.expiresAtMilliseconds <= this.now()) {
            this.records.delete(capabilityId);
            throw new ManagedTranscriptionError(
                'CAPABILITY_EXPIRED',
                true,
                'The managed endpoint capability is unavailable.',
            );
        }
        // The server policy is evaluated again at use time, after any queue wait. Local DNS is
        // not re-resolved: its exact loopback result was fixed at issuance and is enforced by the
        // transport's custom lookup callback.
        if (record.kind === 'server') {
            try {
                await this.validateServerEndpoint(record.endpoint);
            } catch {
                throw endpointPolicyError();
            }
        }
        return cloneEndpointRecord(record);
    }

    revoke(capabilityId: string): void {
        this.records.delete(capabilityId);
    }
}

export interface ManagedCredentialCapabilityAuthorityOptions {
    readonly now?: () => number;
}

/** Ephemeral credential vault. No recovery path exists by design. */
export class ManagedCredentialCapabilityAuthority
implements ManagedCredentialCapabilityAuthorityPort {
    private readonly records = new Map<string, CredentialAuthorityRecord>();
    private readonly now: () => number;

    constructor(options: ManagedCredentialCapabilityAuthorityOptions = {}) {
        this.now = options.now ?? Date.now;
    }

    issue(request: ManagedCredentialCapabilityIssueRequest): string {
        assertScope(request.scope);
        const lifetimeMilliseconds = assertLifetime(request.lifetimeMilliseconds);
        const secret = request.secret.trim();
        if (!secret || secret.length > 16 * 1024) {
            throw new ManagedTranscriptionError(
                'INVALID_INPUT',
                false,
                'The managed credential is invalid.',
            );
        }
        if (request.endpointCapabilityId !== undefined
            && !isOpaqueCapabilityId(request.endpointCapabilityId, 'transcription-endpoint:')) {
            throw new ManagedTranscriptionError(
                'INVALID_INPUT',
                false,
                'The managed endpoint capability identity is invalid.',
            );
        }
        const capabilityId = `transcription-credential:${randomUUID()}`;
        this.records.set(capabilityId, {
            capabilityId,
            secret,
            scope: Object.freeze({ ...request.scope }),
            ...(request.endpointCapabilityId
                ? { endpointCapabilityId: request.endpointCapabilityId }
                : {}),
            expiresAtMilliseconds: this.now() + lifetimeMilliseconds,
            revoked: false,
        });
        return capabilityId;
    }

    resolve(
        capabilityId: string,
        scope: ManagedEndpointCapabilityScope,
        endpointCapabilityId: string,
    ): ResolvedManagedCredentialCapability {
        assertScope(scope);
        const record = this.records.get(capabilityId);
        if (!record
            || !sameScope(record.scope, scope)
            || (record.endpointCapabilityId !== undefined
                && record.endpointCapabilityId !== endpointCapabilityId)) {
            throw new ManagedTranscriptionError(
                'CAPABILITY_EXPIRED',
                true,
                'The managed credential capability is unavailable.',
            );
        }
        if (record.revoked || record.expiresAtMilliseconds <= this.now()) {
            // Deleting drops the last authority-owned reference to the secret.
            this.records.delete(capabilityId);
            throw new ManagedTranscriptionError(
                'CAPABILITY_EXPIRED',
                true,
                'The managed credential capability is unavailable.',
            );
        }
        return {
            capabilityId: record.capabilityId,
            secret: record.secret,
            scope: Object.freeze({ ...record.scope }),
            ...(record.endpointCapabilityId
                ? { endpointCapabilityId: record.endpointCapabilityId }
                : {}),
            expiresAtMilliseconds: record.expiresAtMilliseconds,
        };
    }

    revoke(capabilityId: string): void {
        this.records.delete(capabilityId);
    }
}

function assertExactLocalEndpoint(raw: string, normalized: string): void {
    const trimmed = raw.trim();
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw endpointPolicyError();
    }
    if (
        parsed.protocol !== 'http:'
        || parsed.hostname !== 'localhost'
        || !parsed.port
        || parsed.username
        || parsed.password
        || parsed.search
        || parsed.hash
        || parsed.pathname !== '/v1/audio/transcriptions'
        || parsed.href !== normalized
        || !/^http:\/\/localhost:\d+\/v1\/audio\/transcriptions$/.test(trimmed)
    ) {
        throw endpointPolicyError();
    }
    const port = Number(parsed.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw endpointPolicyError();
}

function endpointPolicyError(): ManagedTranscriptionError {
    return new ManagedTranscriptionError(
        'ENDPOINT_POLICY_REJECTED',
        false,
        'The managed local endpoint does not match the exact local transcription policy.',
    );
}

async function resolveLoopbackAddresses(): Promise<readonly {
    address: string;
    family: 4 | 6;
}[]> {
    let addresses: Array<{ address: string; family: number }>;
    try {
        addresses = await lookup('localhost', {
            all: true,
            verbatim: true,
        }) as Array<{ address: string; family: number }>;
    } catch {
        throw endpointPolicyError();
    }
    return addresses.map(({ address, family }) => ({
        address,
        family: family === 6 ? 6 : 4,
    }));
}

function selectLoopbackAddress(
    values: readonly { address: string; family: 4 | 6 }[],
): { address: string; family: 4 | 6 } {
    const loopbacks = values.filter(value => (
        value.family === 4
            ? value.address.startsWith('127.')
            : value.address === '::1'
    ));
    // IPv4 is preferred because the bundled local transcriber commonly binds an IPv4 socket.
    const selected = loopbacks.find(value => value.family === 4) ?? loopbacks[0];
    if (!selected) throw endpointPolicyError();
    return { ...selected };
}

function cloneEndpointRecord(
    record: EndpointAuthorityRecord,
): ResolvedManagedEndpointCapability {
    return {
        capabilityId: record.capabilityId,
        kind: record.kind,
        endpoint: record.endpoint,
        endpointIdentityDigest: record.endpointIdentityDigest,
        scope: Object.freeze({ ...record.scope }),
        expiresAtMilliseconds: record.expiresAtMilliseconds,
        ...(record.pinnedLoopbackAddress
            ? {
                pinnedLoopbackAddress: record.pinnedLoopbackAddress,
                pinnedLoopbackFamily: record.pinnedLoopbackFamily,
            }
            : {}),
    };
}

function assertScope(scope: ManagedEndpointCapabilityScope): void {
    if (
        !scope.projectId
        || scope.projectId.length > 128
        || !scope.sessionEpoch
        || scope.sessionEpoch.length > 256
    ) {
        throw new ManagedTranscriptionError(
            'INVALID_INPUT',
            false,
            'The managed capability scope is invalid.',
        );
    }
}

function assertLifetime(value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CAPABILITY_LIFETIME_MS) {
        throw new ManagedTranscriptionError(
            'INVALID_INPUT',
            false,
            'The managed capability lifetime is invalid.',
        );
    }
    return value;
}

function sameScope(
    left: ManagedEndpointCapabilityScope,
    right: ManagedEndpointCapabilityScope,
): boolean {
    return left.projectId === right.projectId && left.sessionEpoch === right.sessionEpoch;
}

function isOpaqueCapabilityId(value: string, prefix: string): boolean {
    return new RegExp(
        `^${escapeRegExp(prefix)}[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}`
        + '-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    ).test(value);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
