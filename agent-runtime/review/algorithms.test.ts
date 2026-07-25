import { describe, expect, it } from 'vitest';
import { createManagedReviewArtifactKey } from './artifact-key';
import {
  buildThresholdIntervals,
  normalizeWaveformSamples,
  pickSceneCandidates,
} from './analysis';
import type { MediaReviewScope } from './contracts';
import { planManagedMediaReview } from './planning';
import {
  normalizeReviewRanges,
  sampleTimesAcrossRanges,
} from './range-planning';
import type { ImmutableMediaSourceRecord } from '../source-registry/contracts';

function sourceRecord(sourceId = 'source-1'): ImmutableMediaSourceRecord {
  return {
    version: 1,
    sourceId,
    sourceCapabilityId: `capability-${sourceId}`,
    displayName: 'source.mp4',
    identity: {
      version: 1,
      sha256: `sha256:${'a'.repeat(64)}`,
      byteLength: 1024 * 1024,
      statIdentity: 'stat-v1',
    },
    metadata: {
      containerFormats: ['mp4'],
      durationUs: 100_000,
      videoStreams: [{
        index: 0,
        codec: 'h264',
        width: 640,
        height: 360,
        frameRate: { numerator: 30, denominator: 1 },
      }],
      audioStreams: [{
        index: 1,
        codec: 'aac',
        sampleRate: 48_000,
        channels: 2,
      }],
      primaryVideoStreamIndex: 0,
      primaryAudioStreamIndex: 1,
    },
    registeredAt: '2026-07-25T00:00:00.000Z',
  };
}

describe('managed media review algorithms', () => {
  it('normalizes used ranges and samples their union without reading gaps', () => {
    const ranges = normalizeReviewRanges({
      kind: 'used-ranges',
      ranges: [
        { startUs: 5_000_000, endUs: 6_000_000 },
        { startUs: 1_500_000, endUs: 2_000_000 },
        { startUs: 1_000_000, endUs: 1_500_000 },
      ],
    }, 10_000_000);

    expect(ranges).toEqual([
      { startUs: 1_000_000, endUs: 2_000_000 },
      { startUs: 5_000_000, endUs: 6_000_000 },
    ]);
    const samples = sampleTimesAcrossRanges(ranges, 4);
    expect(samples).toEqual([1_250_000, 1_750_000, 5_250_000, 5_750_000]);
    expect(samples.every((timeUs) => timeUs < 2_000_000 || timeUs >= 5_000_000)).toBe(true);
  });

  it('builds deterministic silence and speech intervals from bounded buckets', () => {
    const ranges = [{ startUs: 0, endUs: 2_000_000 }];
    const samples = [
      {
        startUs: 0,
        endUs: 500_000,
        minimum: -0.1,
        maximum: 0.1,
        rmsDb: -50,
        peakDb: -30,
      },
      {
        startUs: 500_000,
        endUs: 1_000_000,
        minimum: -0.1,
        maximum: 0.1,
        rmsDb: -48,
        peakDb: -20,
      },
      {
        startUs: 1_000_000,
        endUs: 1_500_000,
        minimum: -0.8,
        maximum: 0.8,
        rmsDb: -15,
        peakDb: -1,
      },
      {
        startUs: 1_500_000,
        endUs: 2_000_000,
        minimum: -0.5,
        maximum: 0.5,
        rmsDb: -20,
        peakDb: -3,
      },
    ];

    expect(buildThresholdIntervals(samples, ranges, {
      mode: 'below',
      thresholdDb: -42,
      minimumDurationUs: 500_000,
    })).toEqual([{ startUs: 0, endUs: 1_000_000 }]);
    expect(buildThresholdIntervals(samples, ranges, {
      mode: 'above',
      thresholdDb: -38,
      minimumDurationUs: 500_000,
    })).toEqual([{ startUs: 1_000_000, endUs: 2_000_000 }]);
  });

  it('selects local scene-score maxima without turning them into edit decisions', () => {
    const candidates = pickSceneCandidates([
      { timeUs: 100_000, score: 0.1 },
      { timeUs: 500_000, score: 0.7 },
      { timeUs: 900_000, score: 0.2 },
      { timeUs: 1_200_000, score: 0.9 },
      { timeUs: 1_600_000, score: 0.1 },
      { timeUs: 3_000_000, score: 0.8 },
    ], [{ startUs: 0, endUs: 4_000_000 }], {
      threshold: 0.35,
      minimumGapUs: 1_000_000,
      maxCandidates: 10,
    });

    expect(candidates).toEqual([
      { timeUs: 1_200_000, score: 0.9 },
      { timeUs: 3_000_000, score: 0.8 },
    ]);
  });

  it('evaluates scene maxima independently on each disjoint used range', () => {
    const candidates = pickSceneCandidates([
      { timeUs: 90, score: 0.9 },
      { timeUs: 1_000, score: 0.8 },
      { timeUs: 1_500, score: 0.1 },
    ], [
      { startUs: 0, endUs: 100 },
      { startUs: 1_000, endUs: 2_000 },
    ], {
      threshold: 0.35,
      minimumGapUs: 0,
      maxCandidates: 10,
    });

    expect(candidates).toEqual([
      { timeUs: 90, score: 0.9 },
      { timeUs: 1_000, score: 0.8 },
    ]);
  });

  it('requires complete deterministic audio buckets across every used range', () => {
    const ranges = [
      { startUs: 0, endUs: 20_000 },
      { startUs: 40_000, endUs: 55_000 },
    ];
    const sample = (
      startUs: number,
      endUs: number,
    ) => ({
      startUs,
      endUs,
      minimum: -0.2,
      maximum: 0.2,
      rmsDb: -30,
      peakDb: -5,
    });
    const complete = [
      sample(0, 10_000),
      sample(10_000, 20_000),
      sample(40_000, 50_000),
      sample(50_000, 55_000),
    ];

    expect(normalizeWaveformSamples(complete, ranges, 10_000)).toHaveLength(4);
    expect(() => normalizeWaveformSamples(complete.slice(0, -1), ranges, 10_000))
      .toThrowError(expect.objectContaining({ code: 'PROCESS_FAILED' }));
    expect(() => normalizeWaveformSamples([
      complete[0],
      sample(11_000, 20_000),
      complete[2],
      complete[3],
    ], ranges, 10_000)).toThrowError(expect.objectContaining({ code: 'PROCESS_FAILED' }));
  });

  it('budgets audio buckets per disjoint range rather than across excluded gaps', () => {
    const plan = planManagedMediaReview(sourceRecord(), {
      jobId: 'bucket-plan',
      sourceId: 'source-1',
      scope: {
        kind: 'used-ranges',
        ranges: [
          { startUs: 0, endUs: 10_001 },
          { startUs: 40_000, endUs: 50_001 },
        ],
      },
      reviews: [{ kind: 'waveform', bucketDurationUs: 10_000 }],
    });

    expect(plan.artifacts[0].processOperation).toMatchObject({
      kind: 'audio-analysis',
      maxBuckets: 4,
    });
  });

  it('makes artifact identity stable across equivalent range ordering', () => {
    const first = createManagedReviewArtifactKey({
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      reviewKind: 'contact-sheet',
      ranges: [
        { startUs: 0, endUs: 1_000_000 },
        { startUs: 2_000_000, endUs: 3_000_000 },
      ],
      parameters: {
        columns: 4,
        frameCount: 8,
      },
    });
    const repeated = createManagedReviewArtifactKey({
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      reviewKind: 'contact-sheet',
      ranges: [
        { startUs: 0, endUs: 1_000_000 },
        { startUs: 2_000_000, endUs: 3_000_000 },
      ],
      parameters: {
        frameCount: 8,
        columns: 4,
      },
    });
    const changed = createManagedReviewArtifactKey({
      sourceDigest: `sha256:${'b'.repeat(64)}`,
      reviewKind: 'contact-sheet',
      ranges: [
        { startUs: 0, endUs: 1_000_000 },
        { startUs: 2_000_000, endUs: 3_000_000 },
      ],
      parameters: {
        frameCount: 8,
        columns: 4,
      },
    });

    expect(first).toBe(repeated);
    expect(changed).not.toBe(first);
  });

  it('rejects unsafe and out-of-duration review ranges before decoding', () => {
    expect(() => normalizeReviewRanges({
      kind: 'used-ranges',
      ranges: [{ startUs: -1, endUs: 10 }],
    }, 100)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => normalizeReviewRanges({
      kind: 'used-ranges',
      ranges: [{ startUs: 0, endUs: 101 }],
    }, 100)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => normalizeReviewRanges({
      kind: 'used-ranges',
      ranges: [],
    }, 100)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('enforces explicit full-source confirmation at runtime', () => {
    for (const scope of [
      { kind: 'full-source' },
      { kind: 'full-source', confirmed: false },
      { kind: 'unknown', confirmed: true },
      { kind: 'used-ranges', ranges: 'not-an-array' },
    ]) {
      expect(() => normalizeReviewRanges(
        scope as unknown as MediaReviewScope,
        100,
      )).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    }
    expect(normalizeReviewRanges({
      kind: 'full-source',
      confirmed: true,
    }, 100)).toEqual([{ startUs: 0, endUs: 100 }]);
  });
});
