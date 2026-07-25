import { describe, expect, it } from 'vitest';
import {
    prepareFullSourceEditorialPcmInWorker,
    type EditorialPcmWorkerLike,
} from './full-source-pcm-client';
import type {
    EditorialPcmWorkerRequest,
    EditorialPcmWorkerResponse,
} from './full-source-pcm-worker-protocol';

class FakeWorker implements EditorialPcmWorkerLike {
    onmessage: ((event: MessageEvent<EditorialPcmWorkerResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    readonly messages: EditorialPcmWorkerRequest[] = [];
    terminateCount = 0;

    postMessage(message: EditorialPcmWorkerRequest): void {
        this.messages.push(message);
    }

    terminate(): void {
        this.terminateCount += 1;
    }
}

describe('full-source PCM worker owner', () => {
    it('terminates once after returning only a complete result', async () => {
        const worker = new FakeWorker();
        const promise = prepareFullSourceEditorialPcmInWorker({
            file: new File([], 'source.webm'),
            declaredDuration: { numerator: 1, denominator: 1 },
            workerFactory: () => worker,
            requestId: 'request-1',
        });
        const wav = new Blob([new Uint8Array(44)], { type: 'audio/wav' });
        worker.onmessage?.({ data: {
            type: 'result',
            requestId: 'request-1',
            sampleCount: 0,
            hasAudioStream: true,
            wav,
        } } as MessageEvent<EditorialPcmWorkerResponse>);
        await expect(promise).resolves.toEqual({
            sampleRateHz: 16_000,
            sampleCount: 0,
            hasAudioStream: true,
            wav,
        });
        expect(worker.terminateCount).toBe(1);
    });

    it('requests cancellation and waits for worker acknowledgement before terminating', async () => {
        const worker = new FakeWorker();
        const controller = new AbortController();
        const promise = prepareFullSourceEditorialPcmInWorker({
            file: new File([], 'source.webm'),
            declaredDuration: { numerator: 1, denominator: 1 },
            signal: controller.signal,
            workerFactory: () => worker,
            requestId: 'request-2',
        });
        controller.abort();
        expect(worker.messages.at(-1)).toEqual({ type: 'cancel', requestId: 'request-2' });
        expect(worker.terminateCount).toBe(0);
        worker.onmessage?.({ data: {
            type: 'aborted',
            requestId: 'request-2',
        } } as MessageEvent<EditorialPcmWorkerResponse>);
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(worker.terminateCount).toBe(1);
    });

    it('discards a complete worker result that races with an acknowledged cancellation', async () => {
        const worker = new FakeWorker();
        const controller = new AbortController();
        const promise = prepareFullSourceEditorialPcmInWorker({
            file: new File([], 'source.webm'),
            declaredDuration: { numerator: 1, denominator: 1 },
            signal: controller.signal,
            workerFactory: () => worker,
            requestId: 'request-3',
        });
        controller.abort();
        worker.onmessage?.({ data: {
            type: 'result',
            requestId: 'request-3',
            sampleCount: 16_000,
            hasAudioStream: true,
            wav: new Blob([new Uint8Array(44)], { type: 'audio/wav' }),
        } } as MessageEvent<EditorialPcmWorkerResponse>);

        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(worker.terminateCount).toBe(1);
    });
});
