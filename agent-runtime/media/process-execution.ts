import { assertByteRange } from './accounting';
import { ManagedMediaError, throwIfAborted, toManagedMediaError } from './errors';
import { MEDIA_JOB_LIMITS } from './limits';
import type {
  BoundedMediaProcessPort,
  ManagedMediaProcessRequest,
  ManagedMediaProcessResult,
} from './process-port';
import { rangesContainRange } from '../review/range-planning';

function validateProcessResult(
  request: ManagedMediaProcessRequest,
  result: ManagedMediaProcessResult,
): void {
  if (result.kind !== request.operation.kind) {
    throw new ManagedMediaError('INTERNAL_ERROR', 'Media process returned the wrong result kind.');
  }

  const { accounting } = result;
  const { limits } = request;
  if (
    !Number.isSafeInteger(accounting.input.totalBytes)
    || accounting.input.totalBytes < 0
    || accounting.input.totalBytes > limits.maxInputBytes
    || !Number.isSafeInteger(accounting.input.maxChunkBytes)
    || accounting.input.maxChunkBytes < 0
    || accounting.input.maxChunkBytes > limits.maxBufferedBytes
    || !Number.isSafeInteger(accounting.outputBytes)
    || accounting.outputBytes < 0
    || accounting.outputBytes > limits.maxOutputBytes
    || !Number.isSafeInteger(accounting.stdoutBytes)
    || accounting.stdoutBytes < 0
    || accounting.stdoutBytes > limits.maxStdoutBytes
    || !Number.isSafeInteger(accounting.stderrBytes)
    || accounting.stderrBytes < 0
    || accounting.stderrBytes > limits.maxStderrBytes
    || !Number.isSafeInteger(accounting.maxBufferedBytes)
    || accounting.maxBufferedBytes < 0
    || accounting.maxBufferedBytes > limits.maxBufferedBytes
    || !Number.isSafeInteger(accounting.peakResidentBytes)
    || accounting.peakResidentBytes < 0
    || accounting.peakResidentBytes > limits.maxResidentBytes
  ) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Media process exceeded a configured resource limit.',
    );
  }

  if (accounting.input.ranges.length > MEDIA_JOB_LIMITS.maxReadAccountingRanges) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Media process returned too many read ranges.',
    );
  }
  let previousEnd = -1;
  let coveredBytes = 0;
  for (const range of accounting.input.ranges) {
    assertByteRange(range, request.source.snapshot.byteLength);
    if (range.start < previousEnd) {
      throw new ManagedMediaError(
        'INTERNAL_ERROR',
        'Media process returned overlapping or unsorted read ranges.',
      );
    }
    coveredBytes += range.endExclusive - range.start;
    if (!Number.isSafeInteger(coveredBytes)) {
      throw new ManagedMediaError(
        'RESOURCE_LIMIT_EXCEEDED',
        'Media process read accounting overflowed.',
      );
    }
    previousEnd = range.endExclusive;
  }
  if (
    coveredBytes > accounting.input.totalBytes
    || (accounting.input.totalBytes === 0
      && (accounting.input.ranges.length > 0 || accounting.input.maxChunkBytes !== 0))
    || (accounting.input.totalBytes > 0
      && (coveredBytes === 0
        || accounting.input.maxChunkBytes === 0
        || accounting.input.maxChunkBytes > accounting.input.totalBytes))
  ) {
    throw new ManagedMediaError(
      'INTERNAL_ERROR',
      'Media process returned impossible read accounting.',
    );
  }

  if (
    result.kind === 'probe'
    && result.stdout.byteLength !== accounting.stdoutBytes
  ) {
    throw new ManagedMediaError(
      'INTERNAL_ERROR',
      'Probe process stdout accounting does not match its payload.',
    );
  }
  if (
    request.operation.kind === 'audio-analysis'
    && result.kind === 'audio-analysis'
    && result.samples.length > request.operation.maxBuckets
  ) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Audio process returned more buckets than requested.',
    );
  }
  if (
    request.operation.kind === 'scene-analysis'
    && result.kind === 'scene-analysis'
    && result.samples.length > request.operation.maxSamples
  ) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Scene process returned more samples than requested.',
    );
  }

  if ('ranges' in request.operation) {
    if (accounting.decodedRanges.length > MEDIA_JOB_LIMITS.maxReviewRanges) {
      throw new ManagedMediaError(
        'RESOURCE_LIMIT_EXCEEDED',
        'Media process returned too many decoded ranges.',
      );
    }
    let previousDecodedEnd = -1;
    for (const decodedRange of accounting.decodedRanges) {
      if (
        !Number.isSafeInteger(decodedRange.startUs)
        || !Number.isSafeInteger(decodedRange.endUs)
        || decodedRange.startUs < 0
        || decodedRange.endUs <= decodedRange.startUs
        || decodedRange.startUs < previousDecodedEnd
        || !rangesContainRange(request.operation.ranges, decodedRange)
      ) {
        throw new ManagedMediaError(
          'INTERNAL_ERROR',
          'Media process decoded outside the authorized review ranges.',
        );
      }
      previousDecodedEnd = decodedRange.endUs;
    }
  } else if (accounting.decodedRanges.length > 0) {
    throw new ManagedMediaError(
      'INTERNAL_ERROR',
      'Media process reported unexpected decoded ranges.',
    );
  }
}

export async function executeBoundedMediaProcess(
  port: BoundedMediaProcessPort,
  request: ManagedMediaProcessRequest,
  signal?: AbortSignal,
): Promise<ManagedMediaProcessResult> {
  throwIfAborted(signal);
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Managed media process timed out.'));
  }, request.limits.timeoutMs);

  try {
    const result = await port.execute(request, controller.signal);
    throwIfAborted(signal);
    if (timedOut) {
      throw new ManagedMediaError('PROCESS_TIMEOUT', 'Managed media process timed out.', {
        retryable: true,
      });
    }
    validateProcessResult(request, result);
    return result;
  } catch (error) {
    if (timedOut) {
      throw new ManagedMediaError('PROCESS_TIMEOUT', 'Managed media process timed out.', {
        retryable: true,
        cause: error,
      });
    }
    throwIfAborted(signal);
    const managedError = toManagedMediaError(error);
    if (managedError.code === 'ABORTED') {
      throw new ManagedMediaError('PROCESS_FAILED', 'Managed media process was interrupted.', {
        retryable: true,
        cause: error,
      });
    }
    throw managedError;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}
