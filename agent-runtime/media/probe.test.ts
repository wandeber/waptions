import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MediaReadAccounting } from './accounting';
import { ManagedMediaProbeService } from './probe';
import type { MediaByteSourceFactoryPort } from './contracts';
import type {
  BoundedMediaProcessPort,
  ManagedMediaProcessRequest,
  ManagedMediaProcessResult,
} from './process-port';
import {
  FakeMediaByteSourceFactory,
  FakeVerifiedMediaGrantPort,
  RecordingDiagnostics,
  ffprobeJson,
} from './test-fixtures';

function accounting(
  overrides: Partial<ManagedMediaProcessResult['accounting']> = {},
): ManagedMediaProcessResult['accounting'] {
  const input: MediaReadAccounting = {
    totalBytes: 4096,
    maxChunkBytes: 4096,
    ranges: [{ start: 0, endExclusive: 4096 }],
  };
  return {
    input,
    outputBytes: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    maxBufferedBytes: 4096,
    peakResidentBytes: 16 * 1024 * 1024,
    decodedRanges: [],
    ...overrides,
  };
}

class ProbeProcess implements BoundedMediaProcessPort {
  active = 0;
  peakActive = 0;
  completed = 0;

  constructor(
    private readonly output: (request: ManagedMediaProcessRequest) => Uint8Array,
  ) {}

  async execute(
    request: ManagedMediaProcessRequest,
    signal?: AbortSignal,
  ): Promise<ManagedMediaProcessResult> {
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    try {
      if (signal?.aborted) {
        throw signal.reason;
      }
      const stdout = this.output(request);
      this.completed += 1;
      return {
        kind: 'probe',
        stdout,
        accounting: accounting({ stdoutBytes: stdout.byteLength }),
      };
    } finally {
      this.active -= 1;
    }
  }
}

function fixture(audio = true): {
  readonly bytes: Uint8Array;
  readonly grants: FakeVerifiedMediaGrantPort;
  readonly sources: FakeMediaByteSourceFactory;
  readonly diagnostics: RecordingDiagnostics;
} {
  const bytes = new Uint8Array(9 * 1024 * 1024 + 17);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index % 251;
  }
  const grants = new FakeVerifiedMediaGrantPort([
    {
      displayName: audio ? 'source.mp4' : 'source-no-audio.mp4',
      sourceCapabilityId: 'source-cap',
      fileType: 'regular-file',
    },
  ], {
    'source-cap': {
      version: 1,
      byteLength: bytes.byteLength,
      statIdentity: 'stat-v1',
    },
  });
  return {
    bytes,
    grants,
    sources: new FakeMediaByteSourceFactory(grants, { 'source-cap': bytes }),
    diagnostics: new RecordingDiagnostics(),
  };
}

describe('managed media probing', () => {
  it('streams SHA-256, parses bounded metadata, and closes owned resources once', async () => {
    const testFixture = fixture(false);
    const process = new ProbeProcess(() => ffprobeJson({
      size: testFixture.bytes.byteLength,
      audio: false,
    }));
    const service = new ManagedMediaProbeService(
      testFixture.grants,
      testFixture.sources,
      process,
      testFixture.diagnostics,
    );

    const result = await service.probeCapability('source-cap', 'probe-1');

    expect(result.identity).toEqual({
      version: 1,
      sha256: `sha256:${createHash('sha256').update(testFixture.bytes).digest('hex')}`,
      byteLength: testFixture.bytes.byteLength,
      statIdentity: 'stat-v1',
    });
    expect(result.metadata.videoStreams).toHaveLength(1);
    expect(result.metadata.audioStreams).toHaveLength(0);
    expect(result.readAccounting.totalBytes).toBe(testFixture.bytes.byteLength + 4096);
    expect(result.readAccounting.maxChunkBytes).toBe(1024 * 1024);
    expect(testFixture.sources.opened[0].maximumChunkBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(testFixture.sources.opened[0].closeCount).toBe(1);
    expect(testFixture.grants.closeCounts.get('source-cap')).toBe(1);
    expect(process.active).toBe(0);
  });

  it('fails closed and cleans resources when the open source identity changes', async () => {
    const testFixture = fixture();
    const process = new ProbeProcess(() => {
      testFixture.grants.mutate('source-cap', {
        version: 1,
        byteLength: testFixture.bytes.byteLength,
        statIdentity: 'stat-v2',
      });
      return ffprobeJson({ size: testFixture.bytes.byteLength });
    });
    const service = new ManagedMediaProbeService(
      testFixture.grants,
      testFixture.sources,
      process,
      testFixture.diagnostics,
    );

    await expect(service.probeCapability('source-cap', 'probe-mutated')).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });
    expect(testFixture.sources.opened[0].closeCount).toBe(1);
    expect(testFixture.grants.closeCounts.get('source-cap')).toBe(1);
    expect(process.active).toBe(0);
  });

  it('aborts a bounded process and waits for deterministic child cleanup', async () => {
    const testFixture = fixture();
    let active = 0;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const process: BoundedMediaProcessPort = {
      execute: async (_request, signal) => {
        active += 1;
        notifyStarted?.();
        try {
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(signal?.reason);
            signal?.addEventListener('abort', abort, { once: true });
          });
          throw new Error('unreachable');
        } finally {
          active -= 1;
        }
      },
    };
    const service = new ManagedMediaProbeService(
      testFixture.grants,
      testFixture.sources,
      process,
      testFixture.diagnostics,
    );
    const controller = new AbortController();
    const pending = service.probeCapability('source-cap', 'probe-abort', controller.signal);
    await started;
    controller.abort(new Error('test cancellation'));

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(active).toBe(0);
    expect(testFixture.sources.opened[0].closeCount).toBe(1);
    expect(testFixture.grants.closeCounts.get('source-cap')).toBe(1);
  });

  it('rejects process accounting that exceeds configured memory', async () => {
    const testFixture = fixture();
    const process: BoundedMediaProcessPort = {
      execute: async () => {
        const stdout = ffprobeJson({ size: testFixture.bytes.byteLength });
        return {
          kind: 'probe',
          stdout,
          accounting: accounting({
            stdoutBytes: stdout.byteLength,
            peakResidentBytes: 129 * 1024 * 1024,
          }),
        };
      },
    };
    const service = new ManagedMediaProbeService(
      testFixture.grants,
      testFixture.sources,
      process,
      testFixture.diagnostics,
    );

    await expect(service.probeCapability('source-cap', 'probe-memory')).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
    });
    expect(testFixture.sources.opened[0].closeCount).toBe(1);
  });

  it('binds streamed bytes to both the handle size and any verified digest', async () => {
    const sizeMismatch = fixture();
    sizeMismatch.grants.mutate('source-cap', {
      version: 1,
      byteLength: sizeMismatch.bytes.byteLength + 1,
      statIdentity: 'stat-v1',
    });
    const sizeProcess = new ProbeProcess(() => ffprobeJson({
      size: sizeMismatch.bytes.byteLength,
    }));
    const sizeService = new ManagedMediaProbeService(
      sizeMismatch.grants,
      sizeMismatch.sources,
      sizeProcess,
      sizeMismatch.diagnostics,
    );

    await expect(sizeService.probeCapability('source-cap', 'probe-size-mismatch'))
      .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(sizeProcess.completed).toBe(0);

    const digestMismatch = fixture();
    digestMismatch.grants.mutate('source-cap', {
      version: 1,
      byteLength: digestMismatch.bytes.byteLength,
      statIdentity: 'stat-v1',
      sha256: `sha256:${'b'.repeat(64)}`,
    });
    const digestProcess = new ProbeProcess(() => ffprobeJson({
      size: digestMismatch.bytes.byteLength,
    }));
    const digestService = new ManagedMediaProbeService(
      digestMismatch.grants,
      digestMismatch.sources,
      digestProcess,
      digestMismatch.diagnostics,
    );

    await expect(digestService.probeCapability('source-cap', 'probe-digest-mismatch'))
      .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(digestProcess.completed).toBe(0);
    expect(digestMismatch.sources.opened[0].closeCount).toBe(1);
    expect(digestMismatch.grants.closeCounts.get('source-cap')).toBe(1);
  });

  it('detects a digest-bearing replacement during the process probe', async () => {
    const testFixture = fixture();
    const process = new ProbeProcess(() => {
      testFixture.grants.mutate('source-cap', {
        version: 1,
        byteLength: testFixture.bytes.byteLength,
        statIdentity: 'stat-v1',
        sha256: `sha256:${'c'.repeat(64)}`,
      });
      return ffprobeJson({ size: testFixture.bytes.byteLength });
    });
    const service = new ManagedMediaProbeService(
      testFixture.grants,
      testFixture.sources,
      process,
      testFixture.diagnostics,
    );

    await expect(service.probeCapability('source-cap', 'probe-replaced-digest'))
      .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(process.completed).toBe(1);
    expect(testFixture.sources.opened[0].closeCount).toBe(1);
    expect(testFixture.grants.closeCounts.get('source-cap')).toBe(1);
  });

  it('normalizes a plain stream failure to ABORTED when hashing is cancelled', async () => {
    const testFixture = fixture();
    let closeCount = 0;
    let notifyHashStarted: (() => void) | undefined;
    const hashStarted = new Promise<void>((resolve) => {
      notifyHashStarted = resolve;
    });
    const sources: MediaByteSourceFactoryPort = {
      open: async (handle) => ({
        identity: handle.snapshot,
        size: async () => handle.snapshot.byteLength,
        read: async () => {
          throw new Error('not used');
        },
        stream: (_range, signal) => new ReadableStream<Uint8Array>({
          pull: async () => {
            notifyHashStarted?.();
            await new Promise<void>((_resolve, reject) => {
              const abort = () => reject(new Error('plain stream abort'));
              if (signal?.aborted) {
                abort();
                return;
              }
              signal?.addEventListener('abort', abort, { once: true });
            });
          },
        }),
        verify: async () => testFixture.grants.currentSnapshot(handle.sourceCapabilityId),
        close: async () => {
          closeCount += 1;
        },
      }),
    };
    const process = new ProbeProcess(() => ffprobeJson({
      size: testFixture.bytes.byteLength,
    }));
    const service = new ManagedMediaProbeService(
      testFixture.grants,
      sources,
      process,
      testFixture.diagnostics,
    );
    const controller = new AbortController();
    const pending = service.probeCapability(
      'source-cap',
      'probe-hash-abort',
      controller.signal,
    );
    await hashStarted;
    controller.abort(new Error('caller cancelled'));

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(process.completed).toBe(0);
    expect(closeCount).toBe(1);
    expect(testFixture.grants.closeCounts.get('source-cap')).toBe(1);
  });
});
