import { resolveOpenAICompatibleTranscriptionUrl } from '@/lib/ai/openai-compatible-transcription';
import { ValidationError } from '@/lib/utils/errors';
import type { Sha256Digest } from '@/types/editorial';
import { sha256Utf8 } from './canonical-json';

/**
 * Normalizes the non-secret endpoint identity shared by browser and server editorial requests.
 *
 * The generic OpenAI-compatible normalizer supplies the established path behavior. Editorial
 * transcription adds a stricter URL boundary: fragments and query parameters are rejected,
 * rather than stripped or retained, because an API key must never be smuggled into a URL that
 * can reach browser history, logs, screenshots, request indexes or project artifacts.
 */
export function normalizeEditorialTranscriptionEndpoint(endpoint: string): string {
    const candidate = endpoint.trim();
    if (!candidate) {
        throw new ValidationError('Editorial transcription endpoint is required.');
    }

    const explicitCandidate = /^[a-z][a-z\d+.-]*:\/\//i.test(candidate)
        ? candidate
        : `http://${candidate}`;
    let parsed: URL;
    try {
        parsed = new URL(explicitCandidate);
    } catch {
        throw new ValidationError('Editorial transcription endpoint must be a valid URL.');
    }
    if (parsed.hash) {
        throw new ValidationError('Editorial transcription endpoint must not contain a fragment.');
    }
    if (parsed.search) {
        throw new ValidationError('Editorial transcription endpoint must not contain query parameters.');
    }

    return resolveOpenAICompatibleTranscriptionUrl(candidate);
}

export async function createEditorialEndpointIdentityDigest(endpoint: string): Promise<Sha256Digest> {
    return sha256Utf8(normalizeEditorialTranscriptionEndpoint(endpoint));
}
