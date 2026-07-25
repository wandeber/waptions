export type EditorCommandErrorCode =
    | 'INVALID_REQUEST'
    | 'UNSUPPORTED_API_VERSION'
    | 'PAYLOAD_TOO_LARGE'
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
    | 'COORDINATOR_UNAVAILABLE'
    | 'INTERNAL_ERROR';

export interface EditorCommandErrorDetails {
    operationId?: string;
    ids?: string[];
    issues?: Array<{
        code: string;
        path: string;
        message: string;
    }>;
}

export interface EditorCommandFailure {
    ok: false;
    error: {
        code: EditorCommandErrorCode;
        message: string;
        retryable: boolean;
        details?: EditorCommandErrorDetails;
    };
}

export class EditorCommandError extends Error {
    readonly code: EditorCommandErrorCode;
    readonly retryable: boolean;
    readonly details?: EditorCommandErrorDetails;

    constructor(
        code: EditorCommandErrorCode,
        message: string,
        options: {
            retryable?: boolean;
            details?: EditorCommandErrorDetails;
            cause?: unknown;
        } = {},
    ) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'EditorCommandError';
        this.code = code;
        this.retryable = options.retryable ?? false;
        this.details = options.details;
    }
}

export function toEditorCommandFailure(error: unknown): EditorCommandFailure {
    if (error instanceof EditorCommandError) {
        return {
            ok: false,
            error: {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
                ...(error.details ? { details: structuredClone(error.details) } : {}),
            },
        };
    }
    return {
        ok: false,
        error: {
            code: 'INTERNAL_ERROR',
            message: 'The editor command could not be completed.',
            retryable: false,
        },
    };
}
