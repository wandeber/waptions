import type {
    WaveformWorkerExtractRequest,
    WaveformWorkerResponse,
} from './video-waveform-worker-protocol';
import type { WaveformPeaks } from './video-waveform';

export interface WaveformWorkerPort {
    onmessage: ((event: MessageEvent<WaveformWorkerResponse>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    postMessage(message: WaveformWorkerExtractRequest): void;
    terminate(): void;
}

export type CreateWaveformWorker = () => WaveformWorkerPort;

function createBrowserWaveformWorker(): WaveformWorkerPort {
    return new Worker(
        new URL('./video-waveform.worker.ts', import.meta.url),
        { type: 'module' },
    );
}

/**
 * Runs one full-source waveform extraction in an isolated, disposable worker.
 *
 * The timeline intentionally awaits these calls sequentially. A single off-thread decoder keeps
 * the UI and playback schedulers responsive without opening a burst of competing audio decoders.
 * Aborting terminates the worker immediately, so viewport or project changes cannot retain stale
 * WebCodecs resources or publish peaks for media that is no longer requested.
 */
export function extractWaveformPeaksInWorker(
    file: File,
    duration: number,
    signal: AbortSignal,
    createWorker: CreateWaveformWorker = createBrowserWaveformWorker,
    onProgress?: (peaks: WaveformPeaks) => void,
): Promise<WaveformPeaks | null> {
    if (signal.aborted) return Promise.resolve(null);

    return new Promise((resolve, reject) => {
        const worker = createWorker();
        let settled = false;

        const cleanup = () => {
            signal.removeEventListener('abort', handleAbort);
            worker.terminate();
        };
        const settle = (result: WaveformPeaks | null) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        };
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const handleAbort = () => settle(null);

        worker.onmessage = (event) => {
            if (settled) return;
            if (event.data.type === 'progress') {
                // Progress is advisory. A rendering callback must never strand the worker or
                // convert a successful decode into an unhandled message-event exception.
                try {
                    onProgress?.(event.data.peaks);
                } catch (error) {
                    console.error('Failed to publish progressive waveform peaks:', error);
                }
                return;
            }
            if (event.data.type === 'result') {
                settle(event.data.peaks);
                return;
            }
            fail(new Error(event.data.error || 'Waveform extraction failed.'));
        };
        worker.onerror = (event) => {
            fail(new Error(event.message || 'The waveform worker failed.'));
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        try {
            worker.postMessage({ type: 'extract', file, duration });
        } catch (error) {
            // Structured-clone and startup errors happen synchronously. Route them through the
            // same cleanup path so a failed File handoff cannot leak the disposable worker.
            fail(error instanceof Error ? error : new Error('The waveform worker could not start.'));
        }
    });
}
