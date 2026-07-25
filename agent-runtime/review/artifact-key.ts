import { createHash } from 'node:crypto';
import { MANAGED_MEDIA_ALGORITHM_VERSION } from '../media/contracts';
import { ManagedMediaError } from '../media/errors';
import type { Sha256Digest } from '../source-registry/contracts';
import type {
    MediaTimeRange,
    ReviewKind,
    ReviewParameters,
    ReviewRange,
} from './contracts';
import { REVIEW_ALGORITHM_VERSION } from './contracts';

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

type CanonicalValue =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function canonicalize(value: CanonicalValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ManagedMediaError('INVALID_REQUEST', 'Review parameters must be finite.');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const object = value as { readonly [key: string]: CanonicalValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(',')}}`;
}

export function createManagedReviewArtifactKey(input: {
  readonly sourceDigest: Sha256Digest;
  readonly reviewKind: string;
  readonly ranges: readonly MediaTimeRange[];
  readonly parameters: { readonly [key: string]: CanonicalValue };
  readonly algorithmVersion?: string;
}): `sha256:${string}` {
  const canonical = canonicalize({
    algorithmVersion: input.algorithmVersion ?? REVIEW_ALGORITHM_VERSION,
    parameters: input.parameters,
    ranges: input.ranges.map((range) => ({
      endUs: range.endUs,
      startUs: range.startUs,
    })),
    reviewKind: input.reviewKind,
    sourceDigest: input.sourceDigest,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
