import type { EditorDocumentV3, EditorDocumentV4 } from './video';

export type ExportFormat = 'mp4' | 'webm';
export type ExportQuality = 'low' | 'medium' | 'high' | 'very_high';

export interface ExportOptions {
    format: ExportFormat;
    quality: ExportQuality;
    includeAudio?: boolean;
    onProgress?: (progress: number) => void;
    signal?: AbortSignal;
}

/** Positional write emitted by Mediabunny's streaming target. */
export interface ExportWriteChunk {
    type: 'write';
    data: Uint8Array<ArrayBuffer>;
    position: number;
}

/**
 * A destination must be authorized before export setup begins.
 *
 * Streaming destinations are acquired from the File System Access API in the click gesture that
 * starts an export. The memory variant is an explicitly bounded compatibility path for browsers
 * without that API; it is never silently upgraded to an unbounded allocation.
 */
export type ExportDestination =
    | {
        kind: 'stream';
        writable: WritableStream<ExportWriteChunk>;
    }
    | {
        kind: 'memory';
        estimatedBytes: number;
        /** Maximum encoded file size after reserving final artifact headroom. */
        maximumBytes: number;
        /** Total memory owned by encoded chunks plus final ArrayBuffer/Blob. */
        memoryAllowanceBytes: number;
    };

/** Canonical export request. Every render surface consumes one immutable validated graph snapshot. */
export interface ExportProjectContext {
    document: EditorDocumentV3 | EditorDocumentV4;
    options: ExportOptions;
    destination: ExportDestination;
}

export type ExportResult =
    | {
        success: true;
        delivery: 'streamed';
        bytesWritten: number;
    }
    | {
        success: true;
        delivery: 'memory';
        bytesWritten: number;
        buffer: ArrayBuffer;
    }
    | {
        success: false;
        cancelled: true;
    }
    | {
        success: false;
        cancelled?: false;
        error: string;
    };
