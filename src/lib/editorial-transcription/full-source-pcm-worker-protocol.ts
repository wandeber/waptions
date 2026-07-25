import type { RationalDuration } from './pcm';

export interface EditorialPcmWorkerPrepareRequest {
    type: 'prepare';
    requestId: string;
    file: File;
    declaredDuration: RationalDuration;
}

export interface EditorialPcmWorkerCancelRequest {
    type: 'cancel';
    requestId: string;
}

export type EditorialPcmWorkerRequest =
    | EditorialPcmWorkerPrepareRequest
    | EditorialPcmWorkerCancelRequest;

export type EditorialPcmWorkerResponse =
    | {
        type: 'result';
        requestId: string;
        sampleCount: number;
        hasAudioStream: boolean;
        wav: Blob | null;
    }
    | {
        type: 'aborted';
        requestId: string;
    }
    | {
        type: 'error';
        requestId: string;
        /** Fixed safe category only; decoder/media names are never posted to the main thread. */
        category: 'decode-failed';
    };
