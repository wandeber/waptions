import { describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT,
} from '../../../src/lib/editorial-transcription/preferences';
import {
    ManagedCredentialCapabilityAuthority,
    ManagedEndpointCapabilityAuthority,
} from './capabilities';
import { ManagedTranscriptionError } from './errors';

const scope = {
    projectId: 'project-1',
    sessionEpoch: 'epoch-1',
};
const endpointCapabilityOne =
    'transcription-endpoint:00000000-0000-4000-8000-000000000001';
const endpointCapabilityTwo =
    'transcription-endpoint:00000000-0000-4000-8000-000000000002';

describe('managed transcription capability authorities', () => {
    it('pins the product default to one exact loopback address', async () => {
        const authority = new ManagedEndpointCapabilityAuthority({
            resolveLocalhost: async () => [
                { address: '::1', family: 6 },
                { address: '127.0.0.1', family: 4 },
            ],
        });
        const id = await authority.issue({
            endpoint: DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT,
            kind: 'local',
            scope,
            lifetimeMilliseconds: 10_000,
        });

        const resolved = await authority.resolve(id, scope);
        expect(resolved.endpoint).toBe(DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT);
        expect(resolved.pinnedLoopbackAddress).toBe('127.0.0.1');
        expect(resolved.pinnedLoopbackFamily).toBe(4);
        expect(JSON.stringify({ id })).not.toContain(DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT);
    });

    it.each([
        'http://localhost/v1/audio/transcriptions',
        'https://localhost:43556/v1/audio/transcriptions',
        'http://LOCALHOST:43556/v1/audio/transcriptions',
        'http://localhost.:43556/v1/audio/transcriptions',
        'http://127.0.0.1:43556/v1/audio/transcriptions',
        'http://user@localhost:43556/v1/audio/transcriptions',
        'http://localhost:43556/v1/audio/transcriptions?token=value',
        'http://localhost:43556/v1/audio/transcriptions#fragment',
        'http://localhost:43556/v1/audio/other',
    ])('rejects local endpoint drift: %s', async (endpoint) => {
        const authority = new ManagedEndpointCapabilityAuthority({
            resolveLocalhost: async () => [{ address: '127.0.0.1', family: 4 }],
        });
        await expect(authority.issue({
            endpoint,
            kind: 'local',
            scope,
            lifetimeMilliseconds: 10_000,
        })).rejects.toMatchObject({
            transcriptionCode: 'ENDPOINT_POLICY_REJECTED',
        });
    });

    it('revalidates general server endpoints whenever a capability is resolved', async () => {
        const validateServerEndpoint = vi.fn(async () => undefined);
        const authority = new ManagedEndpointCapabilityAuthority({
            validateServerEndpoint,
        });
        const id = await authority.issue({
            endpoint: 'https://transcriber.example/v1/audio/transcriptions',
            kind: 'server',
            scope,
            lifetimeMilliseconds: 10_000,
        });
        await authority.resolve(id, scope);
        expect(validateServerEndpoint).toHaveBeenCalledTimes(2);
    });

    it('never lets the general server capability inherit the development localhost exception', async () => {
        const authority = new ManagedEndpointCapabilityAuthority();
        await expect(authority.issue({
            endpoint: DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT,
            kind: 'server',
            scope,
            lifetimeMilliseconds: 10_000,
        })).rejects.toMatchObject({
            transcriptionCode: 'ENDPOINT_POLICY_REJECTED',
        });
    });

    it('expires endpoint and credential capabilities without a durable recovery path', async () => {
        let now = 1_000;
        const endpoints = new ManagedEndpointCapabilityAuthority({
            now: () => now,
            resolveLocalhost: async () => [{ address: '127.0.0.1', family: 4 }],
        });
        const endpointId = await endpoints.issue({
            endpoint: DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT,
            kind: 'local',
            scope,
            lifetimeMilliseconds: 10,
        });
        const credentials = new ManagedCredentialCapabilityAuthority({ now: () => now });
        const credentialId = credentials.issue({
            secret: 'test-only-secret',
            scope,
            endpointCapabilityId: endpointId,
            lifetimeMilliseconds: 10,
        });
        now += 11;

        await expect(endpoints.resolve(endpointId, scope)).rejects.toMatchObject({
            code: 'CAPABILITY_EXPIRED',
            transcriptionCode: 'CAPABILITY_EXPIRED',
        });
        expect(() => credentials.resolve(credentialId, scope, endpointId)).toThrowError(
            ManagedTranscriptionError,
        );
    });

    it('binds credentials to their endpoint capability and scope', async () => {
        const credentials = new ManagedCredentialCapabilityAuthority();
        const id = credentials.issue({
            secret: 'test-only-secret',
            scope,
            endpointCapabilityId: endpointCapabilityOne,
            lifetimeMilliseconds: 10_000,
        });

        expect(() => credentials.resolve(
            id,
            scope,
            endpointCapabilityTwo,
        )).toThrowError(ManagedTranscriptionError);
        expect(() => credentials.resolve(
            id,
            { ...scope, sessionEpoch: 'epoch-2' },
            endpointCapabilityOne,
        )).toThrowError(ManagedTranscriptionError);
    });
});
