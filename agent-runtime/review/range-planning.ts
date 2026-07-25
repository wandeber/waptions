import { ManagedMediaError } from '../media/errors';
import { MEDIA_JOB_LIMITS } from '../media/limits';
import type { MediaReviewScope, MediaTimeRange } from './contracts';

function assertTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ManagedMediaError('INVALID_REQUEST', 'Review time must be a non-negative integer.');
  }
}

export function normalizeReviewRanges(
  scope: MediaReviewScope,
  durationUs: number,
): readonly MediaTimeRange[] {
  assertTime(durationUs);
  if (durationUs === 0) {
    throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'Media duration must be greater than zero.');
  }

  if (!scope || typeof scope !== 'object') {
    throw new ManagedMediaError('INVALID_REQUEST', 'Review scope is invalid.');
  }
  const untrustedScope = scope as {
    readonly kind?: unknown;
    readonly confirmed?: unknown;
    readonly ranges?: unknown;
  };
  let ranges: MediaTimeRange[];
  if (untrustedScope.kind === 'full-source') {
    if (untrustedScope.confirmed !== true) {
      throw new ManagedMediaError(
        'INVALID_REQUEST',
        'Full-source review requires explicit runtime confirmation.',
      );
    }
    ranges = [{ startUs: 0, endUs: durationUs }];
  } else if (untrustedScope.kind === 'used-ranges' && Array.isArray(untrustedScope.ranges)) {
    ranges = untrustedScope.ranges.map((range) => {
      if (!range || typeof range !== 'object') {
        throw new ManagedMediaError('INVALID_REQUEST', 'Review range is invalid.');
      }
      const candidate = range as { readonly startUs?: unknown; readonly endUs?: unknown };
      return {
        startUs: candidate.startUs as number,
        endUs: candidate.endUs as number,
      };
    });
  } else {
    throw new ManagedMediaError('INVALID_REQUEST', 'Review scope is invalid.');
  }

  if (ranges.length === 0 || ranges.length > MEDIA_JOB_LIMITS.maxReviewRanges) {
    throw new ManagedMediaError('INVALID_REQUEST', 'Review range count is outside allowed bounds.');
  }

  for (const range of ranges) {
    assertTime(range.startUs);
    assertTime(range.endUs);
    if (range.endUs <= range.startUs || range.endUs > durationUs) {
      throw new ManagedMediaError('INVALID_REQUEST', 'Review range is outside the media duration.');
    }
  }

  ranges.sort((left, right) => (
    left.startUs - right.startUs || left.endUs - right.endUs
  ));

  const normalized: Array<{ startUs: number; endUs: number }> = [];
  for (const range of ranges) {
    const previous = normalized.at(-1);
    if (previous && range.startUs <= previous.endUs) {
      previous.endUs = Math.max(previous.endUs, range.endUs);
    } else {
      normalized.push({ ...range });
    }
  }

  const totalDurationUs = normalized.reduce(
    (total, range) => total + range.endUs - range.startUs,
    0,
  );
  if (
    !Number.isSafeInteger(totalDurationUs)
    || totalDurationUs > MEDIA_JOB_LIMITS.maxReviewDurationUs
  ) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Review ranges exceed the maximum total duration.',
    );
  }
  return normalized;
}

export function sampleTimesAcrossRanges(
  ranges: readonly MediaTimeRange[],
  requestedCount: number,
): readonly number[] {
  if (!Number.isSafeInteger(requestedCount) || requestedCount <= 0) {
    throw new ManagedMediaError('INVALID_REQUEST', 'Review sample count must be positive.');
  }
  const totalDurationUs = ranges.reduce(
    (total, range) => total + range.endUs - range.startUs,
    0,
  );
  if (totalDurationUs <= 0 || !Number.isSafeInteger(totalDurationUs)) {
    throw new ManagedMediaError('INVALID_REQUEST', 'Review ranges have no sampleable duration.');
  }

  const sampleCount = Math.min(requestedCount, totalDurationUs);
  const result: number[] = [];
  let rangeIndex = 0;
  let elapsedBeforeRange = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const target = Math.floor(((index * 2 + 1) * totalDurationUs) / (sampleCount * 2));
    while (
      rangeIndex < ranges.length - 1
      && target >= elapsedBeforeRange + ranges[rangeIndex].endUs - ranges[rangeIndex].startUs
    ) {
      elapsedBeforeRange += ranges[rangeIndex].endUs - ranges[rangeIndex].startUs;
      rangeIndex += 1;
    }
    const range = ranges[rangeIndex];
    const offset = target - elapsedBeforeRange;
    result.push(Math.min(range.endUs - 1, range.startUs + offset));
  }
  return Array.from(new Set(result));
}

export function rangesContainTime(ranges: readonly MediaTimeRange[], timeUs: number): boolean {
  return ranges.some((range) => timeUs >= range.startUs && timeUs < range.endUs);
}

export function rangesContainRange(
  ranges: readonly MediaTimeRange[],
  candidate: MediaTimeRange,
): boolean {
  return ranges.some(
    (range) => candidate.startUs >= range.startUs && candidate.endUs <= range.endUs,
  );
}
