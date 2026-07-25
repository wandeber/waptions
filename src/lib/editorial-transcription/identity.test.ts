import { describe, expect, it } from 'vitest';
import { createEditorialTranscriptRequestKey } from './identity';

const endpointIdentityDigest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

describe('editorial transcript request identity', () => {
    it('is deterministic and excludes clip crops, source IDs and credentials by construction', async () => {
        const identity = {
            sourceFingerprint: 'source-fingerprint',
            sampleCount: 16_000,
            language: null,
            speakerMode: 'none' as const,
            endpointIdentityDigest,
        };
        const first = await createEditorialTranscriptRequestKey(identity);
        const second = await createEditorialTranscriptRequestKey({ ...identity });
        expect(first).toBe(second);
        expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('changes for every frozen request-provenance field', async () => {
        const base = {
            sourceFingerprint: 'source-fingerprint',
            sampleCount: 16_000,
            language: null,
            speakerMode: 'none' as const,
            endpointIdentityDigest,
        };
        const baseKey = await createEditorialTranscriptRequestKey(base);
        await expect(createEditorialTranscriptRequestKey({ ...base, sampleCount: 16_001 }))
            .resolves.not.toBe(baseKey);
        await expect(createEditorialTranscriptRequestKey({ ...base, language: 'es' }))
            .resolves.not.toBe(baseKey);
        await expect(createEditorialTranscriptRequestKey({ ...base, speakerMode: 'diarized' }))
            .resolves.not.toBe(baseKey);
        await expect(createEditorialTranscriptRequestKey({
            ...base,
            endpointIdentityDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        })).resolves.not.toBe(baseKey);
    });
});
