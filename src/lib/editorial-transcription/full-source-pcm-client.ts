import type { PreparedFullSourceEditorialPcm } from './full-source-pcm';
import type {
    EditorialPcmWorkerRequest,
    EditorialPcmWorkerResponse,
} from './full-source-pcm-worker-protocol';
import type { RationalDuration } from './pcm';

export interface EditorialPcmWorkerLike {
    onmessage: ((event: MessageEvent<EditorialPcmWorkerResponse>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    postMessage(message: EditorialPcmWorkerRequest): void;
    terminate(): void;
}

export type EditorialPcmWorkerFactory = () => EditorialPcmWorkerLike;

const createDefaultWorker: EditorialPcmWorkerFactory = () => new Worker(
    new URL('./full-source-pcm.worker.ts', import.meta.url),
    { type: 'module' },
) as unknown as EditorialPcmWorkerLike;

/**
 * Main-thread owner for one full-source worker job.
 *
 * Normal completion and acknowledged cancellation terminate immediately. A bounded fallback
 * termination covers a wedged decoder that cannot process the cancel message; worker teardown
 * releases its isolated Mediabunny/WebCodecs resources and no partial Blob is published.
 */
export function prepareFullSourceEditorialPcmInWorker(input: {
    file: File;
    declaredDuration: RationalDuration;
    signal?: AbortSignal;
    workerFactory?: EditorialPcmWorkerFactory;
    requestId?: string;
    cancelAcknowledgeTimeoutMs?: number;
}): Promise<PreparedFullSourceEditorialPcm> {
    if (input.signal?.aborted) return Promise.reject(createAbortError());
    const worker = (input.workerFactory ?? createDefaultWorker)();
    const requestId = input.requestId ?? crypto.randomUUID();
    const cancelTimeoutMs = input.cancelAcknowledgeTimeoutMs ?? 1_000;
    return new Promise((resolve, reject) => {
        let settled = false;
        let cancellationRequested = false;
        let cancelTimeout: ReturnType<typeof setTimeout> | null = null;
        const finish = (
            result: { value: PreparedFullSourceEditorialPcm } | { error: unknown },
        ) => {
            if (settled) return;
            settled = true;
            if (cancelTimeout !== null) clearTimeout(cancelTimeout);
            input.signal?.removeEventListener('abort', onAbort);
            worker.onmessage = null;
            worker.onerror = null;
            worker.terminate();
            if ('error' in result) reject(result.error);
            else resolve(result.value);
        };
        const onAbort = () => {
            cancellationRequested = true;
            worker.postMessage({ type: 'cancel', requestId });
            cancelTimeout = setTimeout(() => finish({ error: createAbortError() }), cancelTimeoutMs);
        };
        worker.onmessage = (event) => {
            if (event.data.requestId !== requestId) return;
            if (cancellationRequested) {
                // A decoder may finish concurrently with the cancel message. Once the owning
                // consumer aborts, even a complete late Blob is stale and must not be published.
                finish({ error: createAbortError() });
                return;
            }
            if (event.data.type === 'result') {
                finish({
                    value: {
                        sampleRateHz: 16_000,
                        sampleCount: event.data.sampleCount,
                        hasAudioStream: event.data.hasAudioStream,
                        wav: event.data.wav,
                    },
                });
            } else if (event.data.type === 'aborted') {
                finish({ error: createAbortError() });
            } else {
                finish({ error: new Error('Editorial full-source audio preparation failed.') });
            }
        };
        worker.onerror = () => finish({
            error: cancellationRequested
                ? createAbortError()
                : new Error('Editorial full-source audio worker failed.'),
        });
        input.signal?.addEventListener('abort', onAbort, { once: true });
        worker.postMessage({
            type: 'prepare',
            requestId,
            file: input.file,
            declaredDuration: input.declaredDuration,
        });
    });
}

function createAbortError(): DOMException {
    return new DOMException('Editorial audio preparation was cancelled.', 'AbortError');
}
