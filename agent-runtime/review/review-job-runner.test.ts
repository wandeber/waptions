import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MediaReadAccounting } from '../media/accounting';
import type { DurableArtifactPublicationPort } from '../media/ports';
import type {
  ArtifactCommitRequest,
  ArtifactStageRequest,
  DecodedMemoryBudgetPort,
  DecodedMemoryLease,
  DurableMediaJobPort,
  ManagedMediaJobUpdate,
  MediaDiagnosticsPort,
  PublishedArtifactDescriptor,
  StagedArtifactCapability,
} from '../media/ports';
import type {
  BoundedMediaProcessPort,
  ManagedMediaProcessRequest,
  ManagedMediaProcessResult,
} from '../media/process-port';
import {
  FakeVerifiedMediaGrantPort,
  RecordingDiagnostics,
} from '../media/test-fixtures';
import type {
  AtomicSourceRegistrationResult,
  ImmutableMediaSourceRecord,
  ImmutableSourceRegistryPort,
} from '../source-registry/contracts';
import type { ManagedMediaReviewRequest } from './contracts';
import { ManagedMediaReviewJobRunner } from './review-job-runner';

class FakeRegistry implements ImmutableSourceRegistryPort<unknown, unknown> {
  constructor(readonly source: ImmutableMediaSourceRecord) {}

  async registerVerifiedAtomically(): Promise<AtomicSourceRegistrationResult<unknown>> {
    throw new Error('Not used by review tests.');
  }

  async get(sourceId: string): Promise<ImmutableMediaSourceRecord | undefined> {
    return sourceId === this.source.sourceId ? this.source : undefined;
  }
}

class RecordingJobs implements DurableMediaJobPort {
  readonly updates: ManagedMediaJobUpdate[] = [];

  async publish(update: ManagedMediaJobUpdate): Promise<void> {
    this.updates.push(update);
  }
}

class FakeDecodedMemoryBudget implements DecodedMemoryBudgetPort {
  activeBytes = 0;
  peakBytes = 0;
  leases = 0;
  releases = 0;

  constructor(private readonly capBytes: number) {}

  async reserve(
    request: {
      readonly operationId: string;
      readonly category: 'review-decode';
      readonly bytes: number;
    },
    signal?: AbortSignal,
  ): Promise<DecodedMemoryLease> {
    if (signal?.aborted) {
      throw signal.reason;
    }
    if (this.activeBytes + request.bytes > this.capBytes) {
      throw Object.assign(new Error('budget exceeded'), {
        code: 'RESOURCE_LIMIT_EXCEEDED',
      });
    }
    this.activeBytes += request.bytes;
    this.peakBytes = Math.max(this.peakBytes, this.activeBytes);
    this.leases += 1;
    let released = false;
    return {
      leaseId: `lease-${this.leases}`,
      reservedBytes: request.bytes,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        this.activeBytes -= request.bytes;
        this.releases += 1;
      },
    };
  }
}

class FakeArtifacts implements DurableArtifactPublicationPort {
  readonly discarded: string[] = [];
  readonly committed: string[] = [];
  readonly commitRequests: ArtifactCommitRequest[][] = [];
  readonly stages = new Map<string, { request: ArtifactStageRequest; bytes: number }>();
  readonly payloads = new Map<string, Uint8Array>();
  maximumWriteChunk = 0;
  commitCalls = 0;
  invalidNextStage = false;
  private stageSequence = 0;

  async findByContentAddress(): Promise<undefined> {
    return undefined;
  }

  async stageCreateOnly(request: ArtifactStageRequest): Promise<StagedArtifactCapability> {
    this.stageSequence += 1;
    const stageId = `stage-${this.stageSequence}`;
    this.stages.set(stageId, { request, bytes: 0 });
    const stage: StagedArtifactCapability = {
      stageId,
      processOutputCapabilityId: `output-capability-${this.stageSequence}`,
      contentAddress: request.contentAddress,
      contentType: request.contentType,
      maxBytes: request.maxBytes,
    };
    if (this.invalidNextStage) {
      this.invalidNextStage = false;
      return {
        ...stage,
        processOutputCapabilityId: '',
      };
    }
    return stage;
  }

  async writeStream(
    stage: StagedArtifactCapability,
    stream: ReadableStream<Uint8Array>,
  ): Promise<{ readonly byteLength: number; readonly maxBufferedBytes: number }> {
    const record = this.stages.get(stage.stageId);
    if (!record) {
      throw new Error('Missing fixture stage.');
    }
    const reader = stream.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        total += value.byteLength;
        chunks.push(value.slice());
        this.maximumWriteChunk = Math.max(this.maximumWriteChunk, value.byteLength);
        if (total > stage.maxBytes) {
          throw new Error('Fixture artifact exceeded stage limit.');
        }
      }
    } finally {
      reader.releaseLock();
    }
    record.bytes = total;
    const payload = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      payload.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.payloads.set(stage.stageId, payload);
    return {
      byteLength: total,
      maxBufferedBytes: this.maximumWriteChunk,
    };
  }

  async commitBatch(
    requests: readonly ArtifactCommitRequest[],
  ): Promise<readonly PublishedArtifactDescriptor[]> {
    this.commitCalls += 1;
    this.commitRequests.push(requests.map((request) => ({
      ...request,
      metadata: { ...request.metadata },
    })));
    return requests.map(({ stage }) => {
      const record = this.stages.get(stage.stageId);
      if (!record) {
        throw new Error('Missing fixture stage.');
      }
      this.committed.push(stage.stageId);
      return {
        artifactId: `artifact-${stage.stageId}`,
        contentAddress: stage.contentAddress,
        contentType: stage.contentType,
        byteLength: record.bytes,
        sha256: `sha256:${createHash('sha256').update(stage.stageId).digest('hex')}`,
      };
    });
  }

  async discard(stage: StagedArtifactCapability): Promise<void> {
    this.discarded.push(stage.stageId);
  }

  setProcessOutput(stage: StagedArtifactCapability | undefined, bytes: number): void {
    if (!stage) {
      throw new Error('Process output stage is required.');
    }
    const record = this.stages.get(stage.stageId);
    if (!record) {
      throw new Error('Missing fixture stage.');
    }
    record.bytes = bytes;
  }
}

function sourceRecord(audio = true, byteLength = 16 * 1024 * 1024 * 1024): ImmutableMediaSourceRecord {
  return {
    version: 1,
    sourceId: 'source-1',
    sourceCapabilityId: 'source-capability',
    displayName: 'logical-large.mp4',
    identity: {
      version: 1,
      sha256: `sha256:${'a'.repeat(64)}`,
      byteLength,
      statIdentity: 'stat-v1',
    },
    metadata: {
      containerFormats: ['mp4'],
      durationUs: 20_000_000,
      videoStreams: [{
        index: 0,
        codec: 'h264',
        width: 1920,
        height: 1080,
        frameRate: { numerator: 30, denominator: 1 },
      }],
      audioStreams: audio
        ? [{
          index: 1,
          codec: 'aac',
          sampleRate: 48_000,
          channels: 2,
        }]
        : [],
      primaryVideoStreamIndex: 0,
      primaryAudioStreamIndex: audio ? 1 : undefined,
    },
    registeredAt: '2026-07-25T00:00:00.000Z',
  };
}

function processAccounting(
  request: ManagedMediaProcessRequest,
  sourceSize: number,
  outputBytes: number,
): ManagedMediaProcessResult['accounting'] {
  const rangeStart = sourceSize - 4096;
  const input: MediaReadAccounting = {
    totalBytes: 4096,
    maxChunkBytes: 4096,
    ranges: [{ start: rangeStart, endExclusive: sourceSize }],
  };
  return {
    input,
    outputBytes,
    stdoutBytes: 0,
    stderrBytes: 0,
    maxBufferedBytes: 32 * 1024,
    peakResidentBytes: 32 * 1024 * 1024,
    decodedRanges: 'ranges' in request.operation ? request.operation.ranges : [],
  };
}

class ReviewProcess implements BoundedMediaProcessPort {
  readonly requests: ManagedMediaProcessRequest[] = [];
  active = 0;
  peakActive = 0;

  constructor(
    private readonly source: ImmutableMediaSourceRecord,
    private readonly artifacts: FakeArtifacts,
    private readonly beforeReturn?: (
      request: ManagedMediaProcessRequest,
      signal?: AbortSignal,
    ) => Promise<void> | void,
    private readonly accountingFor?: (
      request: ManagedMediaProcessRequest,
      outputBytes: number,
    ) => ManagedMediaProcessResult['accounting'],
  ) {}

  async execute(
    request: ManagedMediaProcessRequest,
    signal?: AbortSignal,
  ): Promise<ManagedMediaProcessResult> {
    this.requests.push(request);
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    try {
      if (signal?.aborted) {
        throw signal.reason;
      }
      await this.beforeReturn?.(request, signal);
      if (signal?.aborted) {
        throw signal.reason;
      }
      const resultAccounting = (outputBytes: number) => (
        this.accountingFor?.(request, outputBytes)
        ?? processAccounting(request, this.source.identity.byteLength, outputBytes)
      );
      switch (request.operation.kind) {
        case 'frame-grid':
          this.artifacts.setProcessOutput(request.output, 2048);
          return {
            kind: 'frame-grid',
            accounting: resultAccounting(2048),
          };
        case 'audio-analysis':
          return {
            kind: 'audio-analysis',
            samples: [
              {
                startUs: 1_000_000,
                endUs: 1_500_000,
                minimum: -0.1,
                maximum: 0.1,
                rmsDb: -50,
                peakDb: -30,
              },
              {
                startUs: 1_500_000,
                endUs: 2_000_000,
                minimum: -0.5,
                maximum: 0.5,
                rmsDb: -20,
                peakDb: -3,
              },
              {
                startUs: 5_000_000,
                endUs: 5_500_000,
                minimum: -0.2,
                maximum: 0.2,
                rmsDb: -45,
                peakDb: -12,
              },
              {
                startUs: 5_500_000,
                endUs: 6_000_000,
                minimum: -0.4,
                maximum: 0.4,
                rmsDb: -18,
                peakDb: -2,
              },
            ],
            accounting: resultAccounting(0),
          };
        case 'scene-analysis':
          return {
            kind: 'scene-analysis',
            samples: [
              { timeUs: 1_100_000, score: 0.1 },
              { timeUs: 1_500_000, score: 0.8 },
              { timeUs: 1_900_000, score: 0.2 },
              { timeUs: 5_200_000, score: 0.7 },
            ],
            accounting: resultAccounting(0),
          };
        case 'review-proxy':
          this.artifacts.setProcessOutput(request.output, 4096);
          return {
            kind: 'review-proxy',
            accounting: resultAccounting(4096),
          };
        case 'probe':
          throw new Error('Probe is not used by review tests.');
      }
    } finally {
      this.active -= 1;
    }
  }
}

function makeRunner(input: {
  readonly source: ImmutableMediaSourceRecord;
  readonly grants?: FakeVerifiedMediaGrantPort;
  readonly artifacts?: FakeArtifacts;
  readonly budget?: FakeDecodedMemoryBudget;
  readonly jobs?: RecordingJobs;
  readonly diagnostics?: MediaDiagnosticsPort;
  readonly beforeProcessReturn?: (
    request: ManagedMediaProcessRequest,
    signal?: AbortSignal,
  ) => Promise<void> | void;
  readonly accountingFor?: (
    request: ManagedMediaProcessRequest,
    outputBytes: number,
  ) => ManagedMediaProcessResult['accounting'];
}): {
  readonly runner: ManagedMediaReviewJobRunner;
  readonly grants: FakeVerifiedMediaGrantPort;
  readonly artifacts: FakeArtifacts;
  readonly budget: FakeDecodedMemoryBudget;
  readonly jobs: RecordingJobs;
  readonly process: ReviewProcess;
  readonly diagnostics: MediaDiagnosticsPort;
} {
  const grants = input.grants ?? new FakeVerifiedMediaGrantPort([], {
    'source-capability': {
      version: 1,
      byteLength: input.source.identity.byteLength,
      statIdentity: input.source.identity.statIdentity,
    },
  });
  const artifacts = input.artifacts ?? new FakeArtifacts();
  const budget = input.budget ?? new FakeDecodedMemoryBudget(64 * 1024 * 1024);
  const jobs = input.jobs ?? new RecordingJobs();
  const diagnostics = input.diagnostics ?? new RecordingDiagnostics();
  const process = new ReviewProcess(
    input.source,
    artifacts,
    input.beforeProcessReturn,
    input.accountingFor,
  );
  return {
    runner: new ManagedMediaReviewJobRunner(
      new FakeRegistry(input.source),
      grants,
      process,
      artifacts,
      budget,
      jobs,
      diagnostics,
    ),
    grants,
    artifacts,
    budget,
    jobs,
    process,
    diagnostics,
  };
}

function completeReviewRequest(jobId = 'review-1'): ManagedMediaReviewRequest {
  return {
    jobId,
    sourceId: 'source-1',
    scope: {
      kind: 'used-ranges',
      ranges: [
        { startUs: 5_000_000, endUs: 6_000_000 },
        { startUs: 1_000_000, endUs: 2_000_000 },
      ],
    },
    reviews: [
      { kind: 'contact-sheet', frameCount: 4 },
      { kind: 'thumbnail-strip', frameCount: 5 },
      { kind: 'waveform', bucketDurationUs: 500_000 },
      { kind: 'audio-map', bucketDurationUs: 500_000 },
      {
        kind: 'silence-map',
        bucketDurationUs: 500_000,
        minimumDurationUs: 500_000,
      },
      {
        kind: 'speech-map',
        bucketDurationUs: 500_000,
        minimumDurationUs: 500_000,
      },
      { kind: 'scene-candidates', sampleIntervalUs: 500_000 },
      { kind: 'review-proxy', includeAudio: true },
    ],
  };
}

describe('managed media review jobs', () => {
  it('creates descriptor-only artifacts for every bounded used-range review', async () => {
    const source = sourceRecord();
    const fixture = makeRunner({ source });

    const result = await fixture.runner.run(completeReviewRequest());

    expect(result.artifacts).toHaveLength(8);
    expect(result.artifacts.every((artifact) => !('bytes' in artifact))).toBe(true);
    expect(result.readAccounting.totalBytes).toBe(8 * 4096);
    expect(result.readAccounting.ranges.every(
      (range) => range.start >= source.identity.byteLength - 4096,
    )).toBe(true);
    expect(fixture.process.requests).toHaveLength(8);
    for (const request of fixture.process.requests) {
      if ('ranges' in request.operation) {
        expect(request.operation.ranges).toEqual([
          { startUs: 1_000_000, endUs: 2_000_000 },
          { startUs: 5_000_000, endUs: 6_000_000 },
        ]);
      }
      expect(request.source.processInputCapabilityId).toBe('process:source-capability');
      expect(request.output && 'path' in request.output).toBeFalsy();
    }
    expect(fixture.artifacts.commitCalls).toBe(1);
    expect(fixture.artifacts.discarded).toHaveLength(0);
    expect(fixture.artifacts.maximumWriteChunk).toBeLessThan(4096);
    expect(new TextDecoder().decode(fixture.artifacts.payloads.get('stage-3')))
      .not.toContain('source-1');
    expect(JSON.stringify(fixture.artifacts.commitRequests)).not.toContain('source-1');
    expect(fixture.budget.peakBytes).toBeGreaterThan(1920 * 1080 * 4 * 2);
    expect(fixture.budget.peakBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(fixture.budget.activeBytes).toBe(0);
    expect(fixture.budget.leases).toBe(fixture.budget.releases);
    expect(fixture.process.active).toBe(0);
    expect(fixture.grants.closeCounts.get('source-capability')).toBe(1);
    expect(fixture.jobs.updates.map((update) => update.state)).toEqual([
      'queued',
      'running',
      'succeeded',
    ]);
  });

  it('returns NO_AUDIO before staging an audio-dependent review', async () => {
    const source = sourceRecord(false);
    const fixture = makeRunner({ source });

    await expect(fixture.runner.run({
      jobId: 'no-audio',
      sourceId: source.sourceId,
      scope: {
        kind: 'used-ranges',
        ranges: [{ startUs: 0, endUs: 1_000_000 }],
      },
      reviews: [{ kind: 'waveform' }],
    })).rejects.toMatchObject({ code: 'NO_AUDIO' });
    expect(fixture.process.requests).toHaveLength(0);
    expect(fixture.artifacts.stages.size).toBe(0);
    expect(fixture.jobs.updates.at(-1)).toMatchObject({
      state: 'failed',
      error: { code: 'NO_AUDIO' },
    });
  });

  it('cancels process work, releases memory, closes the handle, and discards staging', async () => {
    const source = sourceRecord();
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const fixture = makeRunner({
      source,
      beforeProcessReturn: async (_request, signal) => {
        notifyStarted?.();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    const controller = new AbortController();
    const pending = fixture.runner.run({
      jobId: 'review-abort',
      sourceId: source.sourceId,
      scope: {
        kind: 'used-ranges',
        ranges: [{ startUs: 0, endUs: 1_000_000 }],
      },
      reviews: [{ kind: 'contact-sheet', frameCount: 2 }],
    }, controller.signal);
    await started;
    controller.abort(new Error('test cancellation'));

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fixture.budget.activeBytes).toBe(0);
    expect(fixture.budget.leases).toBe(fixture.budget.releases);
    expect(fixture.grants.closeCounts.get('source-capability')).toBe(1);
    expect(fixture.artifacts.discarded).toEqual(['stage-1']);
    expect(fixture.artifacts.commitCalls).toBe(0);
    expect(fixture.jobs.updates.at(-1)?.state).toBe('cancelled');
  });

  it('detects source replacement before publication and removes partial outputs', async () => {
    const source = sourceRecord();
    const grants = new FakeVerifiedMediaGrantPort([], {
      'source-capability': {
        version: 1,
        byteLength: source.identity.byteLength,
        statIdentity: source.identity.statIdentity,
      },
    });
    const diagnostics = new RecordingDiagnostics();
    const fixture = makeRunner({
      source,
      grants,
      diagnostics,
      beforeProcessReturn: () => {
        grants.mutate('source-capability', {
          version: 1,
          byteLength: source.identity.byteLength,
          statIdentity: 'stat-v2',
        });
      },
    });

    await expect(fixture.runner.run({
      jobId: 'review-mutated',
      sourceId: source.sourceId,
      scope: {
        kind: 'used-ranges',
        ranges: [{ startUs: 0, endUs: 1_000_000 }],
      },
      reviews: [{ kind: 'contact-sheet', frameCount: 2 }],
    })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(fixture.artifacts.commitCalls).toBe(0);
    expect(fixture.artifacts.discarded).toEqual(['stage-1']);
    expect(fixture.budget.activeBytes).toBe(0);
    expect(diagnostics.events.some((event) => event.name === 'source.invalidated')).toBe(true);
  });

  it('queues excess review work and never exceeds two concurrent decoders', async () => {
    const source = sourceRecord();
    let active = 0;
    let peak = 0;
    let notifyTwoStarted: (() => void) | undefined;
    const twoStarted = new Promise<void>((resolve) => {
      notifyTwoStarted = resolve;
    });
    let releaseProcesses: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      releaseProcesses = resolve;
    });
    const fixture = makeRunner({
      source,
      beforeProcessReturn: async () => {
        active += 1;
        peak = Math.max(peak, active);
        if (active === 2) {
          notifyTwoStarted?.();
        }
        await released;
        active -= 1;
      },
    });
    const requests = [0, 1, 2].map((index) => fixture.runner.run({
      jobId: `concurrent-${index}`,
      sourceId: source.sourceId,
      scope: {
        kind: 'used-ranges' as const,
        ranges: [{
          startUs: index * 1_000_000,
          endUs: (index + 1) * 1_000_000,
        }],
      },
      reviews: [{ kind: 'contact-sheet' as const, frameCount: 2 }],
    }));
    await twoStarted;
    expect(peak).toBe(2);
    releaseProcesses?.();
    await Promise.all(requests);

    expect(peak).toBe(2);
    expect(fixture.process.peakActive).toBe(2);
    expect(fixture.budget.peakBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(fixture.budget.activeBytes).toBe(0);
  });

  it('rejects an oversized frame-grid raster before opening or staging', async () => {
    const source = sourceRecord();
    const fixture = makeRunner({ source });

    await expect(fixture.runner.run({
      jobId: 'oversized-grid',
      sourceId: source.sourceId,
      scope: {
        kind: 'used-ranges',
        ranges: [{ startUs: 0, endUs: 1_000_000 }],
      },
      reviews: [{
        kind: 'thumbnail-strip',
        frameCount: 120,
        cellWidth: 512,
        cellHeight: 512,
        columns: 1,
      }],
    })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    expect(fixture.grants.openCounts.size).toBe(0);
    expect(fixture.artifacts.stages.size).toBe(0);
  });

  it('discards a malformed staging capability instead of leaking it', async () => {
    const source = sourceRecord();
    const artifacts = new FakeArtifacts();
    artifacts.invalidNextStage = true;
    const fixture = makeRunner({ source, artifacts });

    await expect(fixture.runner.run({
      jobId: 'malformed-stage',
      sourceId: source.sourceId,
      scope: {
        kind: 'used-ranges',
        ranges: [{ startUs: 0, endUs: 1_000_000 }],
      },
      reviews: [{ kind: 'contact-sheet', frameCount: 2 }],
    })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(artifacts.discarded).toEqual(['stage-1']);
    expect(artifacts.commitCalls).toBe(0);
  });

  it('rejects aggregate read-range overflow before artifact publication', async () => {
    const source = sourceRecord();
    let requestIndex = 0;
    const fixture = makeRunner({
      source,
      accountingFor: (request, outputBytes) => {
        const base = requestIndex * 100;
        requestIndex += 1;
        const ranges = Array.from({ length: 33 }, (_unused, index) => ({
          start: base + index * 2,
          endExclusive: base + index * 2 + 1,
        }));
        return {
          input: {
            totalBytes: ranges.length,
            maxChunkBytes: 1,
            ranges,
          },
          outputBytes,
          stdoutBytes: 0,
          stderrBytes: 0,
          maxBufferedBytes: 32 * 1024,
          peakResidentBytes: 32 * 1024 * 1024,
          decodedRanges: 'ranges' in request.operation ? request.operation.ranges : [],
        };
      },
    });

    await expect(fixture.runner.run(completeReviewRequest('range-overflow')))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    expect(fixture.artifacts.commitCalls).toBe(0);
    expect(fixture.artifacts.discarded).toHaveLength(8);
  });
});
