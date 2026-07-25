import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    assertServerTranscriptionEndpointAllowed,
    assertServerTranscriptionEndpointNetworkAllowedWithResolver,
    isBlockedNetworkAddress,
} from './openai-compatible-transcription-policy';

const ALLOWLIST_ENV = 'OPENAI_COMPATIBLE_TRANSCRIPTION_SERVER_ALLOWED_HOSTS';

describe('assertServerTranscriptionEndpointAllowed', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('allows localhost server endpoints outside production for local development', () => {
        vi.stubEnv('NODE_ENV', 'development');

        expect(() => assertServerTranscriptionEndpointAllowed('http://localhost:8000/v1')).not.toThrow();
    });

    it('does not treat loopback IP aliases as the explicit local-development policy', () => {
        vi.stubEnv('NODE_ENV', 'development');
        vi.stubEnv(ALLOWLIST_ENV, '127.0.0.1,[::1]');

        expect(() => assertServerTranscriptionEndpointAllowed('http://127.0.0.1:8000/v1'))
            .toThrow('blocked network');
        expect(() => assertServerTranscriptionEndpointAllowed('http://[::1]:8000/v1'))
            .toThrow('blocked network');
    });

    it('requires an allowlisted server host in production', () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv(ALLOWLIST_ENV, '');

        expect(() => assertServerTranscriptionEndpointAllowed('https://transcriber.example.com/v1')).toThrow('not allowed');
    });

    it('allows production server endpoints when their host is explicitly allowlisted', () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv(ALLOWLIST_ENV, 'transcriber.example.com,api.example.com:8443');

        expect(() => assertServerTranscriptionEndpointAllowed('https://transcriber.example.com/v1')).not.toThrow();
        expect(() => assertServerTranscriptionEndpointAllowed('https://api.example.com:8443/v1')).not.toThrow();
    });

    it('requires HTTPS and an exact allowlisted port in production', () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv(ALLOWLIST_ENV, 'transcriber.example.com,api.example.com:8443');

        expect(() => assertServerTranscriptionEndpointAllowed('http://transcriber.example.com/v1'))
            .toThrow('HTTPS');
        expect(() => assertServerTranscriptionEndpointAllowed('https://api.example.com:9443/v1'))
            .toThrow('not allowed');
    });

    it('rejects private, link-local, metadata, mapped, and documentation addresses', () => {
        const blocked = [
            '0.0.0.0',
            '10.0.0.1',
            '100.64.0.1',
            '127.0.0.1',
            '169.254.169.254',
            '172.31.0.1',
            '192.168.0.1',
            '198.18.0.1',
            '203.0.113.10',
            '::1',
            'fc00::1',
            'fe80::1',
            '::ffff:127.0.0.1',
            '::ffff:7f00:1',
            '2001:db8::1',
            '2001:2::1',
            '2002::1',
            'fec0::1',
            'ff02::1',
        ];
        expect(Object.fromEntries(blocked.map(address => [
            address,
            isBlockedNetworkAddress(address),
        ]))).toEqual(Object.fromEntries(blocked.map(address => [address, true])));
        expect(isBlockedNetworkAddress('8.8.8.8')).toBe(false);
        expect(isBlockedNetworkAddress('2606:4700:4700::1111')).toBe(false);
    });

    it('rejects an allowlisted hostname when any current DNS answer is private', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv(ALLOWLIST_ENV, 'transcriber.example.com');

        await expect(assertServerTranscriptionEndpointNetworkAllowedWithResolver(
            'https://transcriber.example.com/v1',
            async () => ['203.0.114.1', '10.0.0.1'],
        )).rejects.toThrow('blocked network');
        await expect(assertServerTranscriptionEndpointNetworkAllowedWithResolver(
            'https://transcriber.example.com/v1',
            async () => ['203.0.114.1'],
        )).resolves.toBeUndefined();
    });
});
