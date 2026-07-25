import { ManagedMediaError } from '../media/errors';
import { MEDIA_JOB_LIMITS } from '../media/limits';
import type {
  AudioAnalysisSample,
  SceneScoreSample,
} from '../media/process-port';
import type {
  MediaTimeRange,
  ReviewInterval,
  SceneCandidate,
} from './contracts';
import {
  rangesContainRange,
  rangesContainTime,
} from './range-planning';

function validateAudioSamples(
  samples: readonly AudioAnalysisSample[],
  ranges: readonly MediaTimeRange[],
  bucketDurationUs?: number,
): void {
  if (samples.length > MEDIA_JOB_LIMITS.maxAudioBuckets) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Audio analysis returned too many samples.',
    );
  }
  let previousEnd = -1;
  for (const sample of samples) {
    if (
      !Number.isSafeInteger(sample.startUs)
      || !Number.isSafeInteger(sample.endUs)
      || sample.startUs < 0
      || sample.endUs <= sample.startUs
      || sample.startUs < previousEnd
      || !rangesContainRange(ranges, sample)
      || !Number.isFinite(sample.minimum)
      || !Number.isFinite(sample.maximum)
      || !Number.isFinite(sample.rmsDb)
      || !Number.isFinite(sample.peakDb)
      || sample.minimum < -1
      || sample.maximum > 1
      || sample.minimum > sample.maximum
    ) {
      throw new ManagedMediaError(
        'PROCESS_FAILED',
        'Audio process returned invalid bounded samples.',
      );
    }
    previousEnd = sample.endUs;
  }
  if (bucketDurationUs !== undefined) {
    if (!Number.isSafeInteger(bucketDurationUs) || bucketDurationUs <= 0) {
      throw new ManagedMediaError('INVALID_REQUEST', 'Audio bucket duration is invalid.');
    }
    let sampleIndex = 0;
    for (const range of ranges) {
      let cursorUs = range.startUs;
      while (cursorUs < range.endUs) {
        const sample = samples[sampleIndex];
        const expectedEndUs = Math.min(cursorUs + bucketDurationUs, range.endUs);
        if (
          !sample
          || sample.startUs !== cursorUs
          || sample.endUs !== expectedEndUs
        ) {
          throw new ManagedMediaError(
            'PROCESS_FAILED',
            'Audio process returned incomplete bucket coverage.',
          );
        }
        sampleIndex += 1;
        cursorUs = expectedEndUs;
      }
    }
    if (sampleIndex !== samples.length) {
      throw new ManagedMediaError(
        'PROCESS_FAILED',
        'Audio process returned buckets outside the requested coverage.',
      );
    }
  }
}

export function normalizeWaveformSamples(
  samples: readonly AudioAnalysisSample[],
  ranges: readonly MediaTimeRange[],
  bucketDurationUs: number,
): readonly AudioAnalysisSample[] {
  validateAudioSamples(samples, ranges, bucketDurationUs);
  return samples.map((sample) => ({
    startUs: sample.startUs,
    endUs: sample.endUs,
    minimum: Math.max(-1, Math.min(1, sample.minimum)),
    maximum: Math.max(-1, Math.min(1, sample.maximum)),
    rmsDb: sample.rmsDb,
    peakDb: sample.peakDb,
  }));
}

export function buildThresholdIntervals(
  samples: readonly AudioAnalysisSample[],
  ranges: readonly MediaTimeRange[],
  options: {
    readonly mode: 'below' | 'above';
    readonly thresholdDb: number;
    readonly minimumDurationUs: number;
  },
): readonly ReviewInterval[] {
  validateAudioSamples(samples, ranges);
  if (
    !Number.isFinite(options.thresholdDb)
    || !Number.isSafeInteger(options.minimumDurationUs)
    || options.minimumDurationUs <= 0
  ) {
    throw new ManagedMediaError('INVALID_REQUEST', 'Audio threshold parameters are invalid.');
  }

  const intervals: ReviewInterval[] = [];
  let open: { startUs: number; endUs: number } | undefined;
  for (const sample of samples) {
    const matches = options.mode === 'below'
      ? sample.rmsDb <= options.thresholdDb
      : sample.rmsDb >= options.thresholdDb;
    if (matches) {
      if (open && sample.startUs === open.endUs) {
        open.endUs = sample.endUs;
      } else {
        if (open && open.endUs - open.startUs >= options.minimumDurationUs) {
          intervals.push({ ...open });
        }
        open = { startUs: sample.startUs, endUs: sample.endUs };
      }
    } else if (open) {
      if (open.endUs - open.startUs >= options.minimumDurationUs) {
        intervals.push({ ...open });
      }
      open = undefined;
    }
  }
  if (open && open.endUs - open.startUs >= options.minimumDurationUs) {
    intervals.push({ ...open });
  }
  return intervals;
}

export function pickSceneCandidates(
  samples: readonly SceneScoreSample[],
  ranges: readonly MediaTimeRange[],
  options: {
    readonly threshold: number;
    readonly minimumGapUs: number;
    readonly maxCandidates: number;
  },
): readonly SceneCandidate[] {
  if (
    samples.length > MEDIA_JOB_LIMITS.maxSceneSamples
    || !Number.isFinite(options.threshold)
    || options.threshold < 0
    || options.threshold > 1
    || !Number.isSafeInteger(options.minimumGapUs)
    || options.minimumGapUs < 0
    || !Number.isSafeInteger(options.maxCandidates)
    || options.maxCandidates <= 0
    || options.maxCandidates > MEDIA_JOB_LIMITS.maxSceneCandidates
  ) {
    throw new ManagedMediaError('INVALID_REQUEST', 'Scene candidate parameters are invalid.');
  }

  let previousTime = -1;
  for (const sample of samples) {
    if (
      !Number.isSafeInteger(sample.timeUs)
      || sample.timeUs < previousTime
      || !Number.isFinite(sample.score)
      || sample.score < 0
      || sample.score > 1
      || !rangesContainTime(ranges, sample.timeUs)
    ) {
      throw new ManagedMediaError(
        'PROCESS_FAILED',
        'Scene process returned invalid bounded samples.',
      );
    }
    previousTime = sample.timeUs;
  }

  const localMaxima: SceneScoreSample[] = [];
  let sampleIndex = 0;
  for (const range of ranges) {
    const inRange: SceneScoreSample[] = [];
    while (
      sampleIndex < samples.length
      && samples[sampleIndex].timeUs >= range.startUs
      && samples[sampleIndex].timeUs < range.endUs
    ) {
      inRange.push(samples[sampleIndex]);
      sampleIndex += 1;
    }
    inRange.forEach((sample, index) => {
      if (
        sample.score >= options.threshold
        && sample.score >= (inRange[index - 1]?.score ?? -Infinity)
        && sample.score > (inRange[index + 1]?.score ?? -Infinity)
      ) {
        localMaxima.push(sample);
      }
    });
  }
  const selected: SceneCandidate[] = [];
  for (const sample of localMaxima) {
    const previous = selected.at(-1);
    if (!previous || sample.timeUs - previous.timeUs >= options.minimumGapUs) {
      selected.push({ timeUs: sample.timeUs, score: sample.score });
      continue;
    }
    if (sample.score > previous.score) {
      selected[selected.length - 1] = { timeUs: sample.timeUs, score: sample.score };
    }
  }
  return selected.slice(0, options.maxCandidates);
}
