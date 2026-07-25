import type { ByteRange, MediaReadAccounting } from './accounting';
import type { StagedArtifactCapability } from './ports';
import type { ManagedJobOpenMediaHandle } from './contracts';
import type { MediaTimeRange } from '../review/contracts';

export interface ManagedProcessLimits {
  readonly timeoutMs: number;
  readonly killGraceMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxBufferedBytes: number;
  readonly maxResidentBytes: number;
}

export interface ProbeProcessOperation {
  readonly kind: 'probe';
}

export interface FrameGridProcessOperation {
  readonly kind: 'frame-grid';
  readonly layout: 'contact-sheet' | 'thumbnail-strip';
  readonly ranges: readonly MediaTimeRange[];
  readonly timestampsUs: readonly number[];
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly columns: number;
  readonly format: 'webp';
}

export interface AudioAnalysisProcessOperation {
  readonly kind: 'audio-analysis';
  readonly ranges: readonly MediaTimeRange[];
  readonly bucketDurationUs: number;
  readonly maxBuckets: number;
}

export interface SceneAnalysisProcessOperation {
  readonly kind: 'scene-analysis';
  readonly ranges: readonly MediaTimeRange[];
  readonly sampleIntervalUs: number;
  readonly maxSamples: number;
  readonly analysisWidth: number;
}

export interface ReviewProxyProcessOperation {
  readonly kind: 'review-proxy';
  readonly ranges: readonly MediaTimeRange[];
  readonly width: number;
  readonly height: number;
  readonly maxFrameRate: number;
  readonly videoBitRate: number;
  readonly audioBitRate: number;
  readonly includeAudio: boolean;
  readonly container: 'mp4';
}

export type ManagedMediaProcessOperation =
  | ProbeProcessOperation
  | FrameGridProcessOperation
  | AudioAnalysisProcessOperation
  | SceneAnalysisProcessOperation
  | ReviewProxyProcessOperation;

export interface ManagedMediaProcessRequest {
  readonly operationId: string;
  readonly source: ManagedJobOpenMediaHandle;
  readonly operation: ManagedMediaProcessOperation;
  readonly output?: StagedArtifactCapability;
  readonly decodedMemoryLeaseId?: string;
  readonly limits: ManagedProcessLimits;
}

export interface ManagedProcessAccounting {
  readonly input: MediaReadAccounting;
  readonly outputBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly maxBufferedBytes: number;
  readonly peakResidentBytes: number;
  readonly decodedRanges: readonly MediaTimeRange[];
}

export interface ProbeProcessResult {
  readonly kind: 'probe';
  readonly stdout: Uint8Array;
  readonly accounting: ManagedProcessAccounting;
}

export interface FrameGridProcessResult {
  readonly kind: 'frame-grid';
  readonly accounting: ManagedProcessAccounting;
}

export interface AudioAnalysisSample {
  readonly startUs: number;
  readonly endUs: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly rmsDb: number;
  readonly peakDb: number;
}

export interface AudioAnalysisProcessResult {
  readonly kind: 'audio-analysis';
  readonly samples: readonly AudioAnalysisSample[];
  readonly accounting: ManagedProcessAccounting;
}

export interface SceneScoreSample {
  readonly timeUs: number;
  readonly score: number;
}

export interface SceneAnalysisProcessResult {
  readonly kind: 'scene-analysis';
  readonly samples: readonly SceneScoreSample[];
  readonly accounting: ManagedProcessAccounting;
}

export interface ReviewProxyProcessResult {
  readonly kind: 'review-proxy';
  readonly accounting: ManagedProcessAccounting;
}

export type ManagedMediaProcessResult =
  | ProbeProcessResult
  | FrameGridProcessResult
  | AudioAnalysisProcessResult
  | SceneAnalysisProcessResult
  | ReviewProxyProcessResult;

/**
 * The adapter may use ffprobe/ffmpeg, but must spawn without a shell, resolve
 * only the supplied input/output capabilities, apply every limit, propagate
 * backpressure, and resolve only after the child and pipes are fully closed.
 */
export interface BoundedMediaProcessPort {
  execute(
    request: ManagedMediaProcessRequest,
    signal?: AbortSignal,
  ): Promise<ManagedMediaProcessResult>;
}

export function processReadRanges(result: ManagedMediaProcessResult): readonly ByteRange[] {
  return result.accounting.input.ranges;
}
