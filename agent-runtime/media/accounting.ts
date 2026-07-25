import { ManagedMediaError } from './errors';

export interface ByteRange {
  readonly start: number;
  readonly endExclusive: number;
}

export interface MediaReadAccounting {
  readonly totalBytes: number;
  readonly maxChunkBytes: number;
  readonly ranges: readonly ByteRange[];
}

export interface MutableMediaReadAccounting {
  totalBytes: number;
  maxChunkBytes: number;
  ranges: ByteRange[];
}

export function assertByteRange(range: ByteRange, size: number): void {
  if (
    !Number.isSafeInteger(range.start)
    || !Number.isSafeInteger(range.endExclusive)
    || !Number.isSafeInteger(size)
    || size < 0
    || range.start < 0
    || range.endExclusive < range.start
    || range.endExclusive > size
  ) {
    throw new ManagedMediaError('INVALID_REQUEST', 'Invalid media byte range.');
  }
}

export function createReadAccounting(): MutableMediaReadAccounting {
  return {
    totalBytes: 0,
    maxChunkBytes: 0,
    ranges: [],
  };
}

export function addReadRange(
  accounting: MutableMediaReadAccounting,
  range: ByteRange,
  bytesRead: number,
  maxRanges: number,
): void {
  if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) {
    throw new ManagedMediaError('INTERNAL_ERROR', 'Invalid byte accounting from media port.');
  }

  accounting.totalBytes += bytesRead;
  if (!Number.isSafeInteger(accounting.totalBytes)) {
    throw new ManagedMediaError('RESOURCE_LIMIT_EXCEEDED', 'Media byte accounting overflowed.');
  }

  if (accounting.ranges.length >= maxRanges) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Media read accounting exceeded its range limit.',
    );
  }
  accounting.ranges.push(range);
}

export function freezeReadAccounting(
  accounting: MutableMediaReadAccounting,
): MediaReadAccounting {
  return {
    totalBytes: accounting.totalBytes,
    maxChunkBytes: accounting.maxChunkBytes,
    ranges: accounting.ranges.map((range) => ({ ...range })),
  };
}

export function combineReadAccounting(
  parts: readonly MediaReadAccounting[],
  maxRanges: number,
): MediaReadAccounting {
  const combined = createReadAccounting();
  for (const part of parts) {
    if (
      !Number.isSafeInteger(part.totalBytes)
      || part.totalBytes < 0
      || !Number.isSafeInteger(part.maxChunkBytes)
      || part.maxChunkBytes < 0
    ) {
      throw new ManagedMediaError('INTERNAL_ERROR', 'Invalid media read accounting.');
    }
    combined.totalBytes += part.totalBytes;
    combined.maxChunkBytes = Math.max(combined.maxChunkBytes, part.maxChunkBytes);
    if (!Number.isSafeInteger(combined.totalBytes)) {
      throw new ManagedMediaError('RESOURCE_LIMIT_EXCEEDED', 'Media byte accounting overflowed.');
    }
    combined.ranges.push(...part.ranges.map((range) => ({ ...range })));
  }
  combined.ranges.sort((left, right) => (
    left.start - right.start || left.endExclusive - right.endExclusive
  ));
  const merged: Array<{ start: number; endExclusive: number }> = [];
  for (const range of combined.ranges) {
    if (
      !Number.isSafeInteger(range.start)
      || !Number.isSafeInteger(range.endExclusive)
      || range.start < 0
      || range.endExclusive < range.start
    ) {
      throw new ManagedMediaError('INTERNAL_ERROR', 'Invalid media read accounting range.');
    }
    const previous = merged.at(-1);
    if (previous && range.start <= previous.endExclusive) {
      previous.endExclusive = Math.max(previous.endExclusive, range.endExclusive);
    } else {
      merged.push({ ...range });
    }
  }
  if (merged.length > maxRanges) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Media read accounting exceeded its range limit.',
    );
  }
  combined.ranges = merged;
  return freezeReadAccounting(combined);
}
