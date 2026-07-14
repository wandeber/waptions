import type { SubtitleTrack } from './timeline';
import type { EditorDocumentV3, VideoClip, VideoSourceAsset } from './video';

export type ExportFormat = 'mp4' | 'webm';
export type ExportQuality = 'low' | 'medium' | 'high' | 'very_high';

export interface ExportOptions {
    format: ExportFormat;
    quality: ExportQuality;
    fps?: number;
    includeAudio?: boolean;
    onProgress?: (progress: number) => void;
    onCancel?: () => boolean;
}

export interface ExportResult {
    success: boolean;
    buffer?: ArrayBuffer;
    error?: string;
    cancelled?: boolean;
}

/** Canonical export request. Every render surface consumes the complete v3 editor graph. */
export interface ExportProjectContext {
    document: EditorDocumentV3;
    options: ExportOptions;
}

/**
 * Transitional request retained until the editor UI has moved to `buildEditorDocument()`.
 *
 * It cannot describe independent audio, so new callers must use `ExportProjectContext`.
 */
export interface LegacyExportProjectContext {
    videoSources: VideoSourceAsset[];
    videoClips: VideoClip[];
    tracks: SubtitleTrack[];
    options: ExportOptions;
}

export type ExportProjectRequest = ExportProjectContext | LegacyExportProjectContext;
