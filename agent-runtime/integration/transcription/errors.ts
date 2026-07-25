import {
    ManagedRuntimeError,
    type ManagedRuntimeErrorCode,
} from '../../coordinator/errors';

export type ManagedTranscriptionErrorCode =
    | 'INVALID_INPUT'
    | 'CAPABILITY_EXPIRED'
    | 'ENDPOINT_POLICY_REJECTED'
    | 'HEADLESS_BROWSER_LOCAL_UNAVAILABLE'
    | 'PROVIDER_UNREACHABLE'
    | 'PROVIDER_REJECTED'
    | 'PROVIDER_TIMEOUT'
    | 'PROVIDER_RESPONSE_TOO_LARGE'
    | 'SOURCE_CHANGED'
    | 'DOCUMENT_STALE'
    | 'COVERAGE_CONFLICT'
    | 'CAS_CORRUPT'
    | 'MEMORY_LIMIT_EXCEEDED';

export class ManagedTranscriptionError extends ManagedRuntimeError {
    readonly transcriptionCode: ManagedTranscriptionErrorCode;

    constructor(
        transcriptionCode: ManagedTranscriptionErrorCode,
        retryable: boolean,
        message: string,
        options?: ErrorOptions,
    ) {
        super({
            code: toRuntimeCode(transcriptionCode),
            retryable,
            message,
        });
        if (options?.cause !== undefined) {
            Object.defineProperty(this, 'cause', {
                value: options.cause,
                configurable: true,
                writable: true,
                enumerable: false,
            });
        }
        this.name = 'ManagedTranscriptionError';
        this.transcriptionCode = transcriptionCode;
    }
}

/** Stale project/source state is deliberately not an AbortError and must never become cancelled. */
export class ManagedTranscriptionStaleError extends ManagedTranscriptionError {
    constructor(code: 'SOURCE_CHANGED' | 'DOCUMENT_STALE' = 'DOCUMENT_STALE') {
        super(code, true, 'The transcription input is stale.');
        this.name = 'ManagedTranscriptionStaleError';
    }
}

export function throwIfManagedTranscriptionAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw signal.reason instanceof DOMException && signal.reason.name === 'AbortError'
            ? signal.reason
            : new DOMException('Managed transcription was cancelled.', 'AbortError');
    }
}

function toRuntimeCode(code: ManagedTranscriptionErrorCode): ManagedRuntimeErrorCode {
    switch (code) {
        case 'CAPABILITY_EXPIRED':
            return 'CAPABILITY_EXPIRED';
        case 'SOURCE_CHANGED':
            return 'SOURCE_CHANGED';
        case 'DOCUMENT_STALE':
        case 'COVERAGE_CONFLICT':
            return 'REVISION_CONFLICT';
        case 'PROVIDER_UNREACHABLE':
        case 'PROVIDER_TIMEOUT':
            return 'COORDINATOR_UNAVAILABLE';
        case 'CAS_CORRUPT':
            return 'INTERNAL_ERROR';
        default:
            return 'INVALID_REQUEST';
    }
}
