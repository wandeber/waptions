import type { WaveformPeaks } from './video-waveform';

export interface WaveformWorkerExtractRequest {
    type: 'extract';
    file: File;
    duration: number;
}

export interface WaveformWorkerResultResponse {
    type: 'result';
    peaks: WaveformPeaks;
}

export interface WaveformWorkerProgressResponse {
    type: 'progress';
    peaks: WaveformPeaks;
}

export interface WaveformWorkerErrorResponse {
    type: 'error';
    error: string;
}

export type WaveformWorkerResponse =
    | WaveformWorkerProgressResponse
    | WaveformWorkerResultResponse
    | WaveformWorkerErrorResponse;
