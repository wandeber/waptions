export type ManagedRuntimeErrorCode =
    | 'INVALID_REQUEST'
    | 'UNSUPPORTED_API_VERSION'
    | 'PAYLOAD_TOO_LARGE'
    | 'SESSION_NOT_FOUND'
    | 'SESSION_EPOCH_MISMATCH'
    | 'SESSION_REVISION_CONFLICT'
    | 'REVISION_CONFLICT'
    | 'NARRATIVE_REVISION_CONFLICT'
    | 'AUDIO_REVISION_CONFLICT'
    | 'IDEMPOTENCY_KEY_CONFLICT'
    | 'PLAN_NOT_FOUND'
    | 'PLAN_EXPIRED'
    | 'PLAN_INPUT_CHANGED'
    | 'NOT_FOUND'
    | 'INVALID_DOCUMENT'
    | 'INVALID_OPERATION'
    | 'OVERLAP_CONFLICT'
    | 'LOCKED_TARGET'
    | 'ORDER_NOT_MEANINGFUL'
    | 'SOURCE_CHANGED'
    | 'SOURCE_UNREADABLE'
    | 'PATH_NOT_GRANTED'
    | 'WRITE_DESTINATION_NOT_GRANTED'
    | 'OVERWRITE_NOT_AUTHORIZED'
    | 'PATH_IDENTITY_CHANGED'
    | 'UNSUPPORTED_MEDIA'
    | 'NO_AUDIO'
    | 'CODEC_UNAVAILABLE'
    | 'TRANSCRIPTION_POLICY_REJECTED'
    | 'TRANSCRIPTION_ENDPOINT_UNREACHABLE'
    | 'SSRF_POLICY_REJECTED'
    | 'JOB_NOT_CANCELLABLE'
    | 'EVENT_CURSOR_EXPIRED'
    | 'ARTIFACT_EXPIRED'
    | 'CAPABILITY_EXPIRED'
    | 'COORDINATOR_UNAVAILABLE'
    | 'INTERNAL_ERROR';

export interface ManagedRuntimeErrorShape {
    code: ManagedRuntimeErrorCode;
    message: string;
    retryable: boolean;
    details?: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Stable domain error boundary for the managed runtime.
 *
 * Details are deliberately restricted to bounded scalar values. Filesystem errors, stack traces,
 * endpoint responses, credentials, and capability material must never cross this boundary.
 */
export class ManagedRuntimeError extends Error {
    readonly code: ManagedRuntimeErrorCode;
    readonly retryable: boolean;
    readonly details?: Readonly<Record<string, string | number | boolean | null>>;

    constructor(shape: ManagedRuntimeErrorShape) {
        super(shape.message);
        this.name = 'ManagedRuntimeError';
        this.code = shape.code;
        this.retryable = shape.retryable;
        this.details = shape.details;
    }

    toJSON(): ManagedRuntimeErrorShape {
        return {
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            ...(this.details ? { details: this.details } : {}),
        };
    }
}

export function managedError(
    code: ManagedRuntimeErrorCode,
    message: string,
    retryable = false,
    details?: Readonly<Record<string, string | number | boolean | null>>,
): ManagedRuntimeError {
    return new ManagedRuntimeError({ code, message, retryable, ...(details ? { details } : {}) });
}

export function asManagedRuntimeError(error: unknown): ManagedRuntimeError {
    if (error instanceof ManagedRuntimeError) return error;
    return managedError('INTERNAL_ERROR', 'The managed editor operation failed.', false);
}
