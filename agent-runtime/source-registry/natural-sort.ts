import type { VerifiedMediaCandidate } from '../media/contracts';
import { ManagedMediaError } from '../media/errors';

const DEFAULT_VIDEO_EXTENSIONS = Object.freeze([
  '.avi',
  '.m2ts',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.mts',
  '.webm',
]);

interface TextToken {
  readonly kind: 'text';
  readonly value: string;
}

interface NumberToken {
  readonly kind: 'number';
  readonly raw: string;
  readonly significant: string;
}

type NaturalToken = TextToken | NumberToken;

export interface NaturalCandidateSelection {
  readonly candidates: readonly VerifiedMediaCandidate[];
  readonly rejectedCount: number;
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function tokenize(value: string): readonly NaturalToken[] {
  const normalized = value.normalize('NFC').toLowerCase();
  const tokens: NaturalToken[] = [];
  let cursor = 0;
  const pattern = /[0-9]+/g;
  let match = pattern.exec(normalized);
  while (match) {
    const index = match.index;
    if (index > cursor) {
      tokens.push({ kind: 'text', value: normalized.slice(cursor, index) });
    }
    const raw = match[0];
    const significant = raw.replace(/^0+(?=[0-9])/, '');
    tokens.push({ kind: 'number', raw, significant });
    cursor = index + raw.length;
    match = pattern.exec(normalized);
  }

  if (cursor < normalized.length) {
    tokens.push({ kind: 'text', value: normalized.slice(cursor) });
  }
  return tokens;
}

export function compareCanonicalNaturalNames(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  const tokenCount = Math.min(leftTokens.length, rightTokens.length);

  for (let index = 0; index < tokenCount; index += 1) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];
    if (leftToken.kind !== rightToken.kind) {
      return leftToken.kind === 'number' ? -1 : 1;
    }
    if (leftToken.kind === 'text' && rightToken.kind === 'text') {
      const comparison = compareCodePoints(leftToken.value, rightToken.value);
      if (comparison !== 0) {
        return comparison;
      }
      continue;
    }
    if (leftToken.kind === 'number' && rightToken.kind === 'number') {
      if (leftToken.significant.length !== rightToken.significant.length) {
        return leftToken.significant.length - rightToken.significant.length;
      }
      const numericComparison = compareCodePoints(leftToken.significant, rightToken.significant);
      if (numericComparison !== 0) {
        return numericComparison;
      }
      if (leftToken.raw.length !== rightToken.raw.length) {
        return leftToken.raw.length - rightToken.raw.length;
      }
    }
  }

  if (leftTokens.length !== rightTokens.length) {
    return leftTokens.length - rightTokens.length;
  }

  const normalizedComparison = compareCodePoints(
    left.normalize('NFC').toLowerCase(),
    right.normalize('NFC').toLowerCase(),
  );
  if (normalizedComparison !== 0) {
    return normalizedComparison;
  }
  return compareCodePoints(left.normalize('NFC'), right.normalize('NFC'));
}

export function isSafeCandidateName(name: string): boolean {
  if (
    name.length === 0
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(name)
  ) {
    return false;
  }
  return name.normalize('NFC').length <= 255;
}

export function hasSupportedVideoExtension(
  name: string,
  extensions: readonly string[] = DEFAULT_VIDEO_EXTENSIONS,
): boolean {
  const normalized = name.normalize('NFC').toLowerCase();
  return extensions.some((extension) => normalized.endsWith(extension));
}

export async function selectNaturalVideoCandidates(
  entries: AsyncIterable<VerifiedMediaCandidate>,
  options: {
    readonly maxEntries: number;
    readonly extensions?: readonly string[];
  },
): Promise<NaturalCandidateSelection> {
  if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
    throw new ManagedMediaError('INVALID_REQUEST', 'Directory candidate limit is invalid.');
  }

  const accepted: VerifiedMediaCandidate[] = [];
  let rejectedCount = 0;
  let totalEntries = 0;

  for await (const entry of entries) {
    totalEntries += 1;
    if (totalEntries > options.maxEntries) {
      throw new ManagedMediaError(
        'RESOURCE_LIMIT_EXCEEDED',
        'Directory contains more entries than this media job allows.',
      );
    }
    if (
      entry.fileType !== 'regular-file'
      || !isSafeCandidateName(entry.displayName)
      || !hasSupportedVideoExtension(entry.displayName, options.extensions)
    ) {
      rejectedCount += 1;
      continue;
    }
    accepted.push(entry);
  }

  accepted.sort((left, right) => {
    const nameComparison = compareCanonicalNaturalNames(left.displayName, right.displayName);
    if (nameComparison !== 0) {
      return nameComparison;
    }
    return compareCodePoints(left.sourceCapabilityId, right.sourceCapabilityId);
  });

  return {
    candidates: accepted,
    rejectedCount,
  };
}

export const SUPPORTED_VIDEO_EXTENSIONS = DEFAULT_VIDEO_EXTENSIONS;
