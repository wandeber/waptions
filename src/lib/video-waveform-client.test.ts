import { describe, expect, it } from 'vitest';
import type {
    WaveformWorkerExtractRequest,
    WaveformWorkerResponse,
} from './video-waveform-worker-protocol';
import {
    extractWaveformPeaksInWorker,
    type WaveformWorkerPort,
} from './video-waveform-client';

class FakeWaveformWorker implements WaveformWorkerPort {
    onmessage: ((event: MessageEvent<WaveformWorkerResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    postedRequest: WaveformWorkerExtractRequest | null = null;
    terminateCount = 0;
    throwOnPost = false;

    postMessage(message: WaveformWorkerExtractRequest) {
        if (this.throwOnPost) throw new Error('clone failed');
        this.postedRequest = message;
    }

    terminate() {
        this.terminateCount += 1;
    }

    emit(message: WaveformWorkerResponse) {
        this.onmessage?.({ data: message } as MessageEvent<WaveformWorkerResponse>);
    }
}

const createFile = () => new File(['audio'], 'audio.wav', { type: 'audio/wav' });

describe('waveform worker client', () => {
    it('returns transferred peaks and terminates the disposable worker', async () => {
        const worker = new FakeWaveformWorker();
        const controller = new AbortController();
        const promise = extractWaveformPeaksInWorker(
            createFile(),
            2,
            controller.signal,
            () => worker,
        );
        const peaks = {
            duration: 2,
            sampleRate: 48_000,
            bucketCount: 2,
            min: Float32Array.from([-0.25, -0.5]),
            max: Float32Array.from([0.25, 0.5]),
        };

        expect(worker.postedRequest).toMatchObject({ type: 'extract', duration: 2 });
        worker.emit({ type: 'result', peaks });

        await expect(promise).resolves.toBe(peaks);
        expect(worker.terminateCount).toBe(1);
    });

    it('terminates an in-flight decoder and resolves without stale peaks when aborted', async () => {
        const worker = new FakeWaveformWorker();
        const controller = new AbortController();
        const promise = extractWaveformPeaksInWorker(
            createFile(),
            2,
            controller.signal,
            () => worker,
        );

        controller.abort();

        await expect(promise).resolves.toBeNull();
        expect(worker.terminateCount).toBe(1);
    });

    it('propagates worker errors after releasing its resources', async () => {
        const worker = new FakeWaveformWorker();
        const promise = extractWaveformPeaksInWorker(
            createFile(),
            2,
            new AbortController().signal,
            () => worker,
        );

        worker.emit({ type: 'error', error: 'decoder failed' });

        await expect(promise).rejects.toThrow('decoder failed');
        expect(worker.terminateCount).toBe(1);
    });

    it('cleans up when the initial File handoff fails synchronously', async () => {
        const worker = new FakeWaveformWorker();
        worker.throwOnPost = true;

        await expect(extractWaveformPeaksInWorker(
            createFile(),
            2,
            new AbortController().signal,
            () => worker,
        )).rejects.toThrow('clone failed');
        expect(worker.terminateCount).toBe(1);
    });
});
