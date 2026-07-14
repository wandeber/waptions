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
            () => false,
            undefined,
            {
                onProgress: (progressPeaks) => {
                    // Progress owns sliced buffers, not the decoder's live accumulator. Transfer
                    // therefore avoids a main-thread copy without detaching arrays that the next
                    // decoded sample still needs to update.
                    workerScope.postMessage(
                        { type: 'progress', peaks: progressPeaks },
                        [progressPeaks.min.buffer, progressPeaks.max.buffer],
                    );
                },
            },
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
