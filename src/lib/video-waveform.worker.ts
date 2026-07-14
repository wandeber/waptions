import { extractAudioFileWaveformPeaks } from './video-waveform';
import type {
    WaveformWorkerExtractRequest,
    WaveformWorkerResponse,
} from './video-waveform-worker-protocol';

interface WaveformWorkerScope {
    onmessage: ((event: MessageEvent<WaveformWorkerExtractRequest>) => void) | null;
    postMessage(message: WaveformWorkerResponse, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WaveformWorkerScope;

/**
 * Decodes and aggregates waveform peaks away from React's main thread.
 *
 * One worker owns one extraction and is terminated by the caller after this response. Transferring
 * both typed-array buffers avoids copying up to the complete 100k-bucket waveform back to the UI.
 */
workerScope.onmessage = async (event) => {
    if (event.data.type !== 'extract') return;

    try {
        const peaks = await extractAudioFileWaveformPeaks(
            event.data.file,
            event.data.duration,
        );
        if (!peaks) {
            throw new Error('Waveform extraction ended before producing peaks.');
        }
        workerScope.postMessage(
            { type: 'result', peaks },
            [peaks.min.buffer, peaks.max.buffer],
        );
    } catch (error) {
        workerScope.postMessage({
            type: 'error',
            error: error instanceof Error ? error.message : 'Waveform extraction failed.',
        });
    }
};

export {};
