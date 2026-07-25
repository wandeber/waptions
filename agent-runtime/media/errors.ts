export type ManagedMediaErrorCode =
  | 'ABORTED'
  | 'CODEC_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'INVALID_REQUEST'
  | 'NO_AUDIO'
  | 'NOT_ENOUGH_VIDEO_SOURCES'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'PATH_IDENTITY_CHANGED'
  | 'PATH_NOT_GRANTED'
  | 'PAYLOAD_TOO_LARGE'
  | 'PROCESS_FAILED'
  | 'PROCESS_TIMEOUT'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'SOURCE_CHANGED'
  | 'SOURCE_UNREADABLE'
  | 'UNSUPPORTED_MEDIA';

export class ManagedMediaError extends Error {
  readonly code: ManagedMediaErrorCode;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: ManagedMediaErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Readonly<Record<string, string | number | boolean>>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ManagedMediaError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ManagedMediaError('ABORTED', 'Managed media operation was cancelled.', {
      retryable: true,
      cause: signal.reason,
    });
  }
}

export function toManagedMediaError(error: unknown): ManagedMediaError {
  if (error instanceof ManagedMediaError) {
    return error;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ManagedMediaError('ABORTED', 'Managed media operation was cancelled.', {
      retryable: true,
      cause: error,
    });
  }
  return new ManagedMediaError('INTERNAL_ERROR', 'Managed media operation failed.', {
    cause: error,
  });
}
