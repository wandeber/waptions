import { describe, expect, it } from 'vitest';
import { ManagedMediaError } from './errors';
import { ManagedMediaImportService } from './import';
import type {
  ManagedMediaProbePort,
  ManagedMediaProbeResult,
} from './probe';
import { FakeVerifiedMediaGrantPort } from './test-fixtures';
import type {
  AtomicSourceRegistrationRequest,
  AtomicSourceRegistrationResult,
  ImmutableMediaSourceRecord,
  ImmutableSourceRegistryPort,
} from '../source-registry/contracts';

function probeResult(
  sourceCapabilityId: string,
  displayName: string,
  withAudio = true,
): ManagedMediaProbeResult {
  return {
    sourceCapabilityId,
    displayName,
    identity: {
      version: 1,
      sha256: `sha256:${sourceCapabilityId.padEnd(64, '0').slice(0, 64)}`,
      byteLength: 1000,
      statIdentity: `stat:${sourceCapabilityId}`,
    },
    metadata: {
      containerFormats: ['mov', 'mp4'],
      durationUs: 10_000_000,
      videoStreams: [{
        index: 0,
        codec: 'h264',
        width: 1920,
        height: 1080,
        frameRate: { numerator: 30, denominator: 1 },
      }],
      audioStreams: withAudio
        ? [{
          index: 1,
          codec: 'aac',
          sampleRate: 48_000,
          channels: 2,
        }]
        : [],
      primaryVideoStreamIndex: 0,
      primaryAudioStreamIndex: withAudio ? 1 : undefined,
    },
    readAccounting: {
      totalBytes: 1000,
      maxChunkBytes: 1000,
      ranges: [{ start: 0, endExclusive: 1000 }],
    },
  };
}

class FakeProbePort implements ManagedMediaProbePort {
  readonly calls: string[] = [];

  constructor(
    private readonly names: Readonly<Record<string, string>>,
    private readonly unsupported: ReadonlySet<string> = new Set(),
    private readonly failures: ReadonlySet<string> = new Set(),
  ) {}

  async probeCapability(sourceCapabilityId: string): Promise<ManagedMediaProbeResult> {
    this.calls.push(sourceCapabilityId);
    if (this.unsupported.has(sourceCapabilityId)) {
      throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'Fixture has no video stream.');
    }
    if (this.failures.has(sourceCapabilityId)) {
      throw new ManagedMediaError('SOURCE_CHANGED', 'Fixture source changed.');
    }
    return probeResult(sourceCapabilityId, this.names[sourceCapabilityId]);
  }
}

class FakeRegistry<TPlacement>
implements ImmutableSourceRegistryPort<TPlacement, { readonly placementId: string }> {
  calls: AtomicSourceRegistrationRequest<TPlacement>[] = [];

  async registerVerifiedAtomically(
    request: AtomicSourceRegistrationRequest<TPlacement>,
  ): Promise<AtomicSourceRegistrationResult<{ readonly placementId: string }>> {
    this.calls.push(request);
    const sources: ImmutableMediaSourceRecord[] = request.sources.map((source, index) => ({
      version: 1,
      sourceId: `source-${index + 1}`,
      sourceCapabilityId: source.sourceCapabilityId,
      displayName: source.displayName,
      identity: source.identity,
      metadata: source.metadata,
      registeredAt: '2026-07-25T00:00:00.000Z',
    }));
    return {
      registryRevision: 1,
      sources,
      placementResult: { placementId: 'placement-1' },
    };
  }

  async get(): Promise<undefined> {
    return undefined;
  }
}

describe('atomic managed media import', () => {
  it('natural-sorts candidates, skips probed non-video containers, and publishes once', async () => {
    const names = {
      unsupported: '1000-audio-only.mp4',
      first: '3840.mp4',
      second: '244754_medium.mp4',
      third: 'IMG_3619.mov',
      fourth: 'IMG_3620.mov',
      fifth: 'IMG_3621.mov',
    };
    const candidates = [
      { displayName: names.fifth, sourceCapabilityId: 'fifth', fileType: 'regular-file' as const },
      { displayName: names.second, sourceCapabilityId: 'second', fileType: 'regular-file' as const },
      { displayName: names.first, sourceCapabilityId: 'first', fileType: 'regular-file' as const },
      { displayName: names.unsupported, sourceCapabilityId: 'unsupported', fileType: 'regular-file' as const },
      { displayName: names.fourth, sourceCapabilityId: 'fourth', fileType: 'regular-file' as const },
      { displayName: names.third, sourceCapabilityId: 'third', fileType: 'regular-file' as const },
      { displayName: '../escape.mp4', sourceCapabilityId: 'escape', fileType: 'regular-file' as const },
      { displayName: 'photo.jpg', sourceCapabilityId: 'photo', fileType: 'regular-file' as const },
    ];
    const grants = new FakeVerifiedMediaGrantPort(candidates, {});
    const probes = new FakeProbePort(names, new Set(['unsupported']));
    const registry = new FakeRegistry<{ readonly mode: 'append-in-source-order' }>();
    const service = new ManagedMediaImportService(grants, probes, registry);

    const result = await service.import({
      jobId: 'import-1',
      selection: {
        kind: 'directory',
        directory: { capabilityId: 'directory-cap' },
        count: 5,
      },
      placementRequest: { mode: 'append-in-source-order' },
    });

    expect(result.registration.sources.map((source) => source.displayName)).toEqual([
      '3840.mp4',
      '244754_medium.mp4',
      'IMG_3619.mov',
      'IMG_3620.mov',
      'IMG_3621.mov',
    ]);
    expect(result.rejectedCandidateCount).toBe(3);
    expect(registry.calls).toHaveLength(1);
    expect(registry.calls[0].sources).toHaveLength(5);
    expect(registry.calls[0].placementRequest).toEqual({
      mode: 'append-in-source-order',
    });
  });

  it('never publishes a partial registration when one exact source fails', async () => {
    const grants = new FakeVerifiedMediaGrantPort([], {});
    const probes = new FakeProbePort(
      { good: 'good.mp4', changed: 'changed.mp4' },
      new Set(),
      new Set(['changed']),
    );
    const registry = new FakeRegistry<never>();
    const service = new ManagedMediaImportService(grants, probes, registry);

    await expect(service.import({
      jobId: 'import-failed',
      selection: {
        kind: 'capabilities',
        sourceCapabilityIds: ['good', 'changed'],
      },
    })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(registry.calls).toHaveLength(0);
  });

  it('rejects duplicate exact capabilities before any probe', async () => {
    const probes = new FakeProbePort({ repeated: 'repeated.mp4' });
    const registry = new FakeRegistry<never>();
    const service = new ManagedMediaImportService(
      new FakeVerifiedMediaGrantPort([], {}),
      probes,
      registry,
    );

    await expect(service.import({
      jobId: 'import-duplicates',
      selection: {
        kind: 'capabilities',
        sourceCapabilityIds: ['repeated', 'repeated'],
      },
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(probes.calls).toHaveLength(0);
    expect(registry.calls).toHaveLength(0);
  });

  it('rejects duplicate directory capabilities before any probe', async () => {
    const probes = new FakeProbePort({ repeated: 'repeated.mp4' });
    const registry = new FakeRegistry<never>();
    const service = new ManagedMediaImportService(
      new FakeVerifiedMediaGrantPort([
        {
          displayName: 'repeated-1.mp4',
          sourceCapabilityId: 'repeated',
          fileType: 'regular-file',
        },
        {
          displayName: 'repeated-2.mp4',
          sourceCapabilityId: 'repeated',
          fileType: 'regular-file',
        },
      ], {}),
      probes,
      registry,
    );

    await expect(service.import({
      jobId: 'import-directory-duplicates',
      selection: {
        kind: 'directory',
        directory: { capabilityId: 'directory-cap' },
        count: 1,
      },
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(probes.calls).toHaveLength(0);
    expect(registry.calls).toHaveLength(0);
  });

  it('aborts and joins a sibling explicit probe before rejecting the batch', async () => {
    let activeSiblingProbes = 0;
    let siblingAborted = false;
    const probes: ManagedMediaProbePort = {
      probeCapability: async (sourceCapabilityId, _operationId, signal) => {
        if (sourceCapabilityId === 'failed') {
          throw new ManagedMediaError('SOURCE_CHANGED', 'Fixture source changed.');
        }
        activeSiblingProbes += 1;
        try {
          await new Promise<void>((_resolve, reject) => {
            const abort = () => {
              siblingAborted = true;
              reject(signal?.reason);
            };
            if (signal?.aborted) {
              abort();
              return;
            }
            signal?.addEventListener('abort', abort, { once: true });
          });
          throw new Error('unreachable');
        } finally {
          activeSiblingProbes -= 1;
        }
      },
    };
    const registry = new FakeRegistry<never>();
    const service = new ManagedMediaImportService(
      new FakeVerifiedMediaGrantPort([], {}),
      probes,
      registry,
    );

    await expect(service.import({
      jobId: 'import-join-failure',
      selection: {
        kind: 'capabilities',
        sourceCapabilityIds: ['failed', 'blocked-sibling'],
      },
    })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(siblingAborted).toBe(true);
    expect(activeSiblingProbes).toBe(0);
    expect(registry.calls).toHaveLength(0);
  });

  it('requires in-transaction capability revalidation before registry publication', async () => {
    const grants = new FakeVerifiedMediaGrantPort([], {
      good: {
        version: 1,
        byteLength: 1000,
        statIdentity: 'stat:good',
      },
    });
    const probes: ManagedMediaProbePort = {
      probeCapability: async () => {
        const result = probeResult('good', 'good.mp4');
        grants.mutate('good', {
          version: 1,
          byteLength: 1000,
          statIdentity: 'stat:replacement',
        });
        return result;
      },
    };
    let publications = 0;
    const registry: ImmutableSourceRegistryPort<never, never> = {
      registerVerifiedAtomically: async (request) => {
        const pending = request.sources[0];
        const current = grants.currentSnapshot(pending.sourceCapabilityId);
        if (
          current.byteLength !== pending.identity.byteLength
          || current.statIdentity !== pending.identity.statIdentity
          || (current.sha256 !== undefined && current.sha256 !== pending.identity.sha256)
        ) {
          throw new ManagedMediaError('SOURCE_CHANGED', 'Capability changed in transaction.');
        }
        publications += 1;
        throw new Error('unreachable');
      },
      get: async () => undefined,
    };
    const service = new ManagedMediaImportService(grants, probes, registry);

    await expect(service.import({
      jobId: 'import-transaction-revalidation',
      selection: {
        kind: 'capabilities',
        sourceCapabilityIds: ['good'],
      },
    })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(publications).toBe(0);
  });
});
