import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertServerTranscriptionEndpointAllowed } from './openai-compatible-transcription-server';

const ALLOWLIST_ENV = 'OPENAI_COMPATIBLE_TRANSCRIPTION_SERVER_ALLOWED_HOSTS';

describe('assertServerTranscriptionEndpointAllowed', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('allows localhost server endpoints outside production for local development', () => {
        vi.stubEnv('NODE_ENV', 'development');

        expect(() => assertServerTranscriptionEndpointAllowed('http://localhost:8000/v1')).not.toThrow();
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
});
