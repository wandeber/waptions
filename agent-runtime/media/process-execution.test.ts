import { describe, expect, it } from 'vitest';
import { executeBoundedMediaProcess } from './process-execution';
import type {
  BoundedMediaProcessPort,
  ManagedMediaProcessRequest,
} from './process-port';

function request(
  overrides: Partial<ManagedMediaProcessRequest['limits']> = {},
): ManagedMediaProcessRequest {
  return {
    operationId: 'process-test',
    source: {
      handleId: 'handle-1',
      sourceCapabilityId: 'source-cap',
      displayName: 'source.mp4',
      snapshot: {
        version: 1,
        byteLength: 1024 * 1024,
        statIdentity: 'stat-1',
      },
      processInputCapabilityId: 'process-cap',
      close: async () => undefined,
    },
    operation: {
      kind: 'review-proxy',
      ranges: [{ startUs: 0, endUs: 1_000_000 }],
      width: 640,
      height: 360,
      maxFrameRate: 30,
      videoBitRate: 1_000_000,
      audioBitRate: 128_000,
      includeAudio: false,
      container: 'mp4',
    },
    output: {
      stageId: 'stage-1',
      processOutputCapabilityId: 'output-cap',
      contentAddress: `sha256:${'a'.repeat(64)}`,
      contentType: 'video/mp4',
      maxBytes: 1024 * 1024,
    },
    limits: {
      timeoutMs: 100,
      killGraceMs: 10,
      maxInputBytes: 1024 * 1024,
      maxOutputBytes: 1024 * 1024,
      maxStdoutBytes: 0,
      maxStderrBytes: 1024,
      maxBufferedBytes: 64 * 1024,
      maxResidentBytes: 64 * 1024 * 1024,
      ...overrides,
    },
  };
}

describe('bounded media process execution', () => {
  it('times out, aborts, and waits for process cleanup', async () => {
    let active = 0;
    const port: BoundedMediaProcessPort = {
      execute: async (_request, signal) => {
        active += 1;
        try {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          throw new Error('unreachable');
        } finally {
          active -= 1;
        }
      },
    };

    await expect(executeBoundedMediaProcess(port, request({ timeoutMs: 5 }))).rejects.toMatchObject({
      code: 'PROCESS_TIMEOUT',
    });
    expect(active).toBe(0);
  });

  it('rejects decoded ranges outside the requested used-range scope', async () => {
    const port: BoundedMediaProcessPort = {
      execute: async () => ({
        kind: 'review-proxy',
        accounting: {
          input: {
            totalBytes: 4096,
            maxChunkBytes: 4096,
            ranges: [{ start: 0, endExclusive: 4096 }],
          },
          outputBytes: 1024,
          stdoutBytes: 0,
          stderrBytes: 0,
          maxBufferedBytes: 1024,
          peakResidentBytes: 1024 * 1024,
          decodedRanges: [{ startUs: 1_000_000, endUs: 2_000_000 }],
        },
      }),
    };

    await expect(executeBoundedMediaProcess(port, request())).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('rejects under-reported and overlapping process reads', async () => {
    for (const input of [
      {
        totalBytes: 1,
        maxChunkBytes: 1,
        ranges: [{ start: 0, endExclusive: 10 }],
      },
      {
        totalBytes: 20,
        maxChunkBytes: 10,
        ranges: [
          { start: 0, endExclusive: 10 },
          { start: 5, endExclusive: 15 },
        ],
      },
    ]) {
      const port: BoundedMediaProcessPort = {
        execute: async (processRequest) => ({
          kind: 'review-proxy',
          accounting: {
            input,
            outputBytes: 0,
            stdoutBytes: 0,
            stderrBytes: 0,
            maxBufferedBytes: 0,
            peakResidentBytes: 0,
            decodedRanges: 'ranges' in processRequest.operation
              ? processRequest.operation.ranges
              : [],
          },
        }),
      };

      await expect(executeBoundedMediaProcess(port, request())).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      });
    }
  });

  it('requires probe stdout accounting to match the returned payload', async () => {
    const stdout = new TextEncoder().encode('{}');
    const port: BoundedMediaProcessPort = {
      execute: async () => ({
        kind: 'probe',
        stdout,
        accounting: {
          input: {
            totalBytes: 10,
            maxChunkBytes: 10,
            ranges: [{ start: 0, endExclusive: 10 }],
          },
          outputBytes: 0,
          stdoutBytes: stdout.byteLength - 1,
          stderrBytes: 0,
          maxBufferedBytes: stdout.byteLength,
          peakResidentBytes: 1024,
          decodedRanges: [],
        },
      }),
    };
    const probeRequest: ManagedMediaProcessRequest = {
      ...request({ maxStdoutBytes: 1024 }),
      operation: { kind: 'probe' },
      output: undefined,
    };

    await expect(executeBoundedMediaProcess(port, probeRequest)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('enforces operation-specific structured result limits', async () => {
    const port: BoundedMediaProcessPort = {
      execute: async (processRequest) => ({
        kind: 'audio-analysis',
        samples: [
          {
            startUs: 0,
            endUs: 500_000,
            minimum: -0.1,
            maximum: 0.1,
            rmsDb: -20,
            peakDb: -1,
          },
          {
            startUs: 500_000,
            endUs: 1_000_000,
            minimum: -0.1,
            maximum: 0.1,
            rmsDb: -20,
            peakDb: -1,
          },
        ],
        accounting: {
          input: {
            totalBytes: 10,
            maxChunkBytes: 10,
            ranges: [{ start: 0, endExclusive: 10 }],
          },
          outputBytes: 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          maxBufferedBytes: 0,
          peakResidentBytes: 1024,
          decodedRanges: 'ranges' in processRequest.operation
            ? processRequest.operation.ranges
            : [],
        },
      }),
    };
    const audioRequest: ManagedMediaProcessRequest = {
      ...request(),
      operation: {
        kind: 'audio-analysis',
        ranges: [{ startUs: 0, endUs: 1_000_000 }],
        bucketDurationUs: 500_000,
        maxBuckets: 1,
      },
      output: undefined,
    };

    await expect(executeBoundedMediaProcess(port, audioRequest)).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
    });
  });
});
