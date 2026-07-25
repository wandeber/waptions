import { prepareFullSourceEditorialPcm } from './full-source-pcm';
import type {
    EditorialPcmWorkerRequest,
    EditorialPcmWorkerResponse,
} from './full-source-pcm-worker-protocol';

interface EditorialPcmWorkerScope {
    onmessage: ((event: MessageEvent<EditorialPcmWorkerRequest>) => void) | null;
    postMessage(message: EditorialPcmWorkerResponse): void;
}

const workerScope = self as unknown as EditorialPcmWorkerScope;
const operations = new Map<string, AbortController>();

workerScope.onmessage = (event) => {
    if (event.data.type === 'cancel') {
        operations.get(event.data.requestId)?.abort();
        return;
    }
    const request = event.data;
    if (operations.has(request.requestId)) return;
    const controller = new AbortController();
    operations.set(request.requestId, controller);
    void prepareFullSourceEditorialPcm({
        file: request.file,
        declaredDuration: request.declaredDuration,
        signal: controller.signal,
    }).then((result) => {
        workerScope.postMessage({
            type: 'result',
            requestId: request.requestId,
            sampleCount: result.sampleCount,
            hasAudioStream: result.hasAudioStream,
            wav: result.wav,
        });
    }).catch((error: unknown) => {
        workerScope.postMessage(error instanceof DOMException && error.name === 'AbortError'
            ? { type: 'aborted', requestId: request.requestId }
            : { type: 'error', requestId: request.requestId, category: 'decode-failed' });
    }).finally(() => {
        operations.delete(request.requestId);
    });
};

export {};
