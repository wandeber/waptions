import { ManagedMediaError } from '../media/errors';
import { MEDIA_JOB_LIMITS } from '../media/limits';
import type {
  AudioAnalysisProcessOperation,
  FrameGridProcessOperation,
  ManagedMediaProcessOperation,
  ManagedProcessLimits,
  ReviewProxyProcessOperation,
  SceneAnalysisProcessOperation,
} from '../media/process-port';
import type {
  ImmutableMediaSourceRecord,
} from '../source-registry/contracts';
import { createManagedReviewArtifactKey } from './artifact-key';
import type {
  ManagedMediaReviewRequest,
  MediaReviewSpecification,
  MediaTimeRange,
} from './contracts';
import { normalizeReviewRanges, sampleTimesAcrossRanges } from './range-planning';

export interface PlannedReviewArtifact {
  readonly reviewKind: MediaReviewSpecification['kind'];
  readonly contentAddress: `sha256:${string}`;
  readonly contentType: string;
  readonly extension: string;
  readonly maxArtifactBytes: number;
  readonly decodedReservationBytes: number;
  readonly processOperation: ManagedMediaProcessOperation;
  readonly processLimits: ManagedProcessLimits;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
}

export interface ManagedMediaReviewPlan {
  readonly ranges: readonly MediaTimeRange[];
  readonly artifacts: readonly PlannedReviewArtifact[];
}

function assertIntegerWithin(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ManagedMediaError('INVALID_REQUEST', `${label} is outside allowed bounds.`);
  }
  return value;
}

function assertNumberWithin(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ManagedMediaError('INVALID_REQUEST', `${label} is outside allowed bounds.`);
  }
  return value;
}

function totalRangeDuration(ranges: readonly MediaTimeRange[]): number {
  return ranges.reduce((sum, range) => sum + range.endUs - range.startUs, 0);
}

function sampleCountAcrossRanges(
  ranges: readonly MediaTimeRange[],
  intervalUs: number,
): number {
  const count = ranges.reduce(
    (sum, range) => sum + Math.ceil((range.endUs - range.startUs) / intervalUs),
    0,
  );
  if (!Number.isSafeInteger(count)) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Review sample count exceeds safe integer bounds.',
    );
  }
  return count;
}

function decodedReservationBytes(
  source: ImmutableMediaSourceRecord,
  outputRasterBytes = 0,
): number {
  const primary = source.metadata.videoStreams.find(
    (stream) => stream.index === source.metadata.primaryVideoStreamIndex,
  );
  if (!primary) {
    throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'Primary video stream is missing.');
  }
  const bytes = primary.width * primary.height * 4 * 2 + outputRasterBytes;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Decoded frame reservation exceeds safe integer bounds.',
    );
  }
  return bytes;
}

function baseLimits(input: {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly maxResidentBytes: number;
}): ManagedProcessLimits {
  return {
    timeoutMs: input.timeoutMs,
    killGraceMs: MEDIA_JOB_LIMITS.processKillGraceMs,
    maxInputBytes: input.maxInputBytes,
    maxOutputBytes: input.maxOutputBytes,
    maxStdoutBytes: MEDIA_JOB_LIMITS.maxAnalysisArtifactBytes,
    maxStderrBytes: 64 * 1024,
    maxBufferedBytes: MEDIA_JOB_LIMITS.processStreamBufferBytes,
    maxResidentBytes: input.maxResidentBytes,
  };
}

function frameGridPlan(
  source: ImmutableMediaSourceRecord,
  ranges: readonly MediaTimeRange[],
  spec: Extract<MediaReviewSpecification, { kind: 'contact-sheet' | 'thumbnail-strip' }>,
): PlannedReviewArtifact {
  const isContactSheet = spec.kind === 'contact-sheet';
  const frameCount = assertIntegerWithin(
    spec.frameCount ?? (isContactSheet ? 24 : 48),
    1,
    isContactSheet
      ? MEDIA_JOB_LIMITS.maxContactSheetFrames
      : MEDIA_JOB_LIMITS.maxThumbnailFrames,
    'Frame count',
  );
  const cellWidth = assertIntegerWithin(
    spec.cellWidth ?? (isContactSheet ? 320 : 160),
    64,
    512,
    'Cell width',
  );
  const cellHeight = assertIntegerWithin(
    spec.cellHeight ?? (isContactSheet ? 180 : 90),
    36,
    512,
    'Cell height',
  );
  const columns = assertIntegerWithin(
    spec.columns ?? Math.min(frameCount, isContactSheet ? 6 : 12),
    1,
    frameCount,
    'Grid column count',
  );
  const timestampsUs = sampleTimesAcrossRanges(ranges, frameCount);
  const parameters = {
    cellHeight,
    cellWidth,
    columns,
    frameCount: timestampsUs.length,
    format: 'webp',
  } as const;
  const rows = Math.ceil(timestampsUs.length / columns);
  const outputWidth = columns * cellWidth;
  const outputHeight = rows * cellHeight;
  const outputRasterBytes = outputWidth * outputHeight * 4;
  if (
    !Number.isSafeInteger(outputRasterBytes)
    || outputWidth > MEDIA_JOB_LIMITS.maxGridDimension
    || outputHeight > MEDIA_JOB_LIMITS.maxGridDimension
    || outputRasterBytes > MEDIA_JOB_LIMITS.maxGridPixelBytes
  ) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Frame grid raster exceeds its decoded-memory bounds.',
    );
  }
  const boundedParameters = {
    ...parameters,
    outputHeight,
    outputWidth,
    rows,
  } as const;
  const operation: FrameGridProcessOperation = {
    kind: 'frame-grid',
    layout: isContactSheet ? 'contact-sheet' : 'thumbnail-strip',
    ranges,
    timestampsUs,
    cellWidth,
    cellHeight,
    columns,
    format: 'webp',
  };
  return {
    reviewKind: spec.kind,
    contentAddress: createManagedReviewArtifactKey({
      sourceDigest: source.identity.sha256,
      reviewKind: spec.kind,
      ranges,
      parameters: boundedParameters,
    }),
    contentType: 'image/webp',
    extension: '.webp',
    maxArtifactBytes: MEDIA_JOB_LIMITS.maxImageArtifactBytes,
    decodedReservationBytes: decodedReservationBytes(source, outputRasterBytes),
    processOperation: operation,
    processLimits: baseLimits({
      maxInputBytes: source.identity.byteLength,
      maxOutputBytes: MEDIA_JOB_LIMITS.maxImageArtifactBytes,
      timeoutMs: 120_000,
      maxResidentBytes: 256 * 1024 * 1024,
    }),
    parameters: boundedParameters,
  };
}

function audioPlan(
  source: ImmutableMediaSourceRecord,
  ranges: readonly MediaTimeRange[],
  spec: Extract<
    MediaReviewSpecification,
    { kind: 'waveform' | 'audio-map' | 'silence-map' | 'speech-map' }
  >,
): PlannedReviewArtifact {
  if (source.metadata.audioStreams.length === 0) {
    throw new ManagedMediaError('NO_AUDIO', 'Requested review requires an audio stream.');
  }
  const bucketDurationUs = assertIntegerWithin(
    spec.bucketDurationUs
      ?? (spec.kind === 'audio-map' ? 500_000 : 100_000),
    10_000,
    5_000_000,
    'Audio bucket duration',
  );
  const bucketCount = sampleCountAcrossRanges(ranges, bucketDurationUs);
  if (bucketCount > MEDIA_JOB_LIMITS.maxAudioBuckets) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Audio review would exceed the maximum bucket count.',
    );
  }

  const parameters: Record<string, string | number | boolean> = {
    bucketDurationUs,
  };
  if (spec.kind === 'silence-map') {
    parameters.minimumDurationUs = assertIntegerWithin(
        spec.minimumDurationUs ?? 500_000,
        bucketDurationUs,
        60_000_000,
        'Minimum silence duration',
      );
    parameters.thresholdDb = assertNumberWithin(
      spec.thresholdDb ?? -42,
      -120,
      0,
      'Silence threshold',
    );
  } else if (spec.kind === 'speech-map') {
    parameters.minimumDurationUs = assertIntegerWithin(
      spec.minimumDurationUs ?? 250_000,
      bucketDurationUs,
      60_000_000,
      'Minimum speech duration',
    );
    parameters.thresholdDb = assertNumberWithin(
      spec.thresholdDb ?? -38,
      -120,
      0,
      'Speech threshold',
    );
  }
  const operation: AudioAnalysisProcessOperation = {
    kind: 'audio-analysis',
    ranges,
    bucketDurationUs,
    maxBuckets: bucketCount,
  };
  return {
    reviewKind: spec.kind,
    contentAddress: createManagedReviewArtifactKey({
      sourceDigest: source.identity.sha256,
      reviewKind: spec.kind,
      ranges,
      parameters,
    }),
    contentType: 'application/json',
    extension: '.json',
    maxArtifactBytes: MEDIA_JOB_LIMITS.maxAnalysisArtifactBytes,
    decodedReservationBytes: 0,
    processOperation: operation,
    processLimits: baseLimits({
      maxInputBytes: source.identity.byteLength,
      maxOutputBytes: 0,
      timeoutMs: 180_000,
      maxResidentBytes: 128 * 1024 * 1024,
    }),
    parameters,
  };
}

function scenePlan(
  source: ImmutableMediaSourceRecord,
  ranges: readonly MediaTimeRange[],
  spec: Extract<MediaReviewSpecification, { kind: 'scene-candidates' }>,
): PlannedReviewArtifact {
  const sampleIntervalUs = assertIntegerWithin(
    spec.sampleIntervalUs ?? 500_000,
    100_000,
    10_000_000,
    'Scene sample interval',
  );
  const sampleCount = sampleCountAcrossRanges(ranges, sampleIntervalUs);
  if (sampleCount > MEDIA_JOB_LIMITS.maxSceneSamples) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Scene review would exceed the maximum sample count.',
    );
  }
  const parameters = {
    analysisWidth: assertIntegerWithin(spec.analysisWidth ?? 320, 64, 640, 'Analysis width'),
    maxCandidates: assertIntegerWithin(
      spec.maxCandidates ?? 100,
      1,
      MEDIA_JOB_LIMITS.maxSceneCandidates,
      'Scene candidate count',
    ),
    minimumGapUs: assertIntegerWithin(
      spec.minimumGapUs ?? 1_000_000,
      0,
      60_000_000,
      'Scene minimum gap',
    ),
    sampleIntervalUs,
    threshold: assertNumberWithin(spec.threshold ?? 0.35, 0, 1, 'Scene threshold'),
  };
  const operation: SceneAnalysisProcessOperation = {
    kind: 'scene-analysis',
    ranges,
    sampleIntervalUs,
    maxSamples: sampleCount,
    analysisWidth: parameters.analysisWidth,
  };
  return {
    reviewKind: spec.kind,
    contentAddress: createManagedReviewArtifactKey({
      sourceDigest: source.identity.sha256,
      reviewKind: spec.kind,
      ranges,
      parameters,
    }),
    contentType: 'application/json',
    extension: '.json',
    maxArtifactBytes: MEDIA_JOB_LIMITS.maxAnalysisArtifactBytes,
    decodedReservationBytes: decodedReservationBytes(source),
    processOperation: operation,
    processLimits: baseLimits({
      maxInputBytes: source.identity.byteLength,
      maxOutputBytes: 0,
      timeoutMs: 180_000,
      maxResidentBytes: 192 * 1024 * 1024,
    }),
    parameters,
  };
}

function proxyPlan(
  source: ImmutableMediaSourceRecord,
  ranges: readonly MediaTimeRange[],
  spec: Extract<MediaReviewSpecification, { kind: 'review-proxy' }>,
): PlannedReviewArtifact {
  const durationUs = totalRangeDuration(ranges);
  if (durationUs > MEDIA_JOB_LIMITS.maxProxyDurationUs) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Review proxy duration exceeds its hard limit.',
    );
  }
  const includeAudio = spec.includeAudio ?? source.metadata.audioStreams.length > 0;
  if (includeAudio && source.metadata.audioStreams.length === 0) {
    throw new ManagedMediaError('NO_AUDIO', 'Review proxy requested unavailable audio.');
  }
  const parameters = {
    audioBitRate: assertIntegerWithin(
      spec.audioBitRate ?? 128_000,
      32_000,
      320_000,
      'Proxy audio bit rate',
    ),
    container: 'mp4',
    height: assertIntegerWithin(spec.height ?? 720, 144, 1080, 'Proxy height'),
    includeAudio,
    maxFrameRate: assertNumberWithin(
      spec.maxFrameRate ?? 30,
      1,
      60,
      'Proxy frame rate',
    ),
    videoBitRate: assertIntegerWithin(
      spec.videoBitRate ?? 2_000_000,
      100_000,
      10_000_000,
      'Proxy video bit rate',
    ),
    width: assertIntegerWithin(spec.width ?? 1280, 256, 1920, 'Proxy width'),
  };
  const operation: ReviewProxyProcessOperation = {
    kind: 'review-proxy',
    ranges,
    width: parameters.width,
    height: parameters.height,
    maxFrameRate: parameters.maxFrameRate,
    videoBitRate: parameters.videoBitRate,
    audioBitRate: parameters.audioBitRate,
    includeAudio,
    container: 'mp4',
  };
  return {
    reviewKind: spec.kind,
    contentAddress: createManagedReviewArtifactKey({
      sourceDigest: source.identity.sha256,
      reviewKind: spec.kind,
      ranges,
      parameters,
    }),
    contentType: 'video/mp4',
    extension: '.mp4',
    maxArtifactBytes: MEDIA_JOB_LIMITS.maxProxyArtifactBytes,
    decodedReservationBytes: decodedReservationBytes(source),
    processOperation: operation,
    processLimits: baseLimits({
      maxInputBytes: source.identity.byteLength,
      maxOutputBytes: MEDIA_JOB_LIMITS.maxProxyArtifactBytes,
      timeoutMs: 10 * 60_000,
      maxResidentBytes: 384 * 1024 * 1024,
    }),
    parameters,
  };
}

function planSpecification(
  source: ImmutableMediaSourceRecord,
  ranges: readonly MediaTimeRange[],
  specification: MediaReviewSpecification,
): PlannedReviewArtifact {
  switch (specification.kind) {
    case 'contact-sheet':
    case 'thumbnail-strip':
      return frameGridPlan(source, ranges, specification);
    case 'waveform':
    case 'audio-map':
    case 'silence-map':
    case 'speech-map':
      return audioPlan(source, ranges, specification);
    case 'scene-candidates':
      return scenePlan(source, ranges, specification);
    case 'review-proxy':
      return proxyPlan(source, ranges, specification);
  }
}

export function planManagedMediaReview(
  source: ImmutableMediaSourceRecord,
  request: ManagedMediaReviewRequest,
): ManagedMediaReviewPlan {
  if (
    request.reviews.length === 0
    || request.reviews.length > MEDIA_JOB_LIMITS.maxReviewArtifacts
  ) {
    throw new ManagedMediaError('INVALID_REQUEST', 'Review artifact count is outside bounds.');
  }
  const uniqueKinds = new Set(request.reviews.map((review) => review.kind));
  if (uniqueKinds.size !== request.reviews.length) {
    throw new ManagedMediaError('INVALID_REQUEST', 'Review kinds must be unique within one job.');
  }
  const ranges = normalizeReviewRanges(request.scope, source.metadata.durationUs);
  return {
    ranges,
    artifacts: request.reviews.map((review) => planSpecification(source, ranges, review)),
  };
}
