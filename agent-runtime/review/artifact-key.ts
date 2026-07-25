import { createHash } from 'node:crypto';
import { MANAGED_MEDIA_ALGORITHM_VERSION } from '../media/contracts';
import type {
    ReviewKind,
    ReviewParameters,
    ReviewRange,
} from './contracts';

export function createReviewArtifactKey(input: {
    sourceFingerprint: string;
    backendVersion: string;
    kind: ReviewKind;
    range: ReviewRange;
    parameters: Required<ReviewParameters>;
}): string {
    const canonical = canonicalJson({
        algorithmVersion: MANAGED_MEDIA_ALGORITHM_VERSION,
        backendVersion: input.backendVersion,
        sourceFingerprint: input.sourceFingerprint,
        kind: input.kind,
        range: input.range,
        parameters: input.parameters,
    });
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(',')}}`;
}
