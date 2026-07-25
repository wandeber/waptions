import type {
  VerifiedDirectoryCapability,
  VerifiedMediaCandidate,
  VerifiedMediaGrantPort,
} from './contracts';
import {
  ManagedMediaError,
  throwIfAborted,
  toManagedMediaError,
} from './errors';
import { MEDIA_JOB_LIMITS } from './limits';
import type { ManagedMediaProbePort, ManagedMediaProbeResult } from './probe';
import type {
  AtomicSourceRegistrationResult,
  ImmutableSourceRegistryPort,
  PendingMediaSourceRegistration,
} from '../source-registry/contracts';
import { selectNaturalVideoCandidates } from '../source-registry/natural-sort';

export interface DirectoryMediaImportSelection {
  readonly kind: 'directory';
  readonly directory: VerifiedDirectoryCapability;
  readonly count: number;
  readonly maximumCandidates?: number;
}

export interface ExplicitMediaImportSelection {
  readonly kind: 'capabilities';
  readonly sourceCapabilityIds: readonly string[];
}

export type MediaImportSelection =
  | DirectoryMediaImportSelection
  | ExplicitMediaImportSelection;

export interface ManagedMediaImportRequest<TPlacementRequest = never> {
  readonly jobId: string;
  readonly selection: MediaImportSelection;
  readonly placementRequest?: TPlacementRequest;
}

export interface ManagedMediaImportResult<TPlacementResult = never> {
  readonly registration: AtomicSourceRegistrationResult<TPlacementResult>;
  readonly rejectedCandidateCount: number;
}

interface ProbeOutcome {
  readonly result?: ManagedMediaProbeResult;
  readonly error?: ManagedMediaError;
}

function assertSelectionCount(count: number): void {
  if (!Number.isSafeInteger(count) || count <= 0 || count > 500) {
    throw new ManagedMediaError('INVALID_REQUEST', 'Media import count is outside allowed bounds.');
  }
}

function toRegistration(
  probe: ManagedMediaProbeResult,
  index: number,
): PendingMediaSourceRegistration {
  return {
    registrationAlias: `import-source-${String(index + 1).padStart(4, '0')}`,
    sourceCapabilityId: probe.sourceCapabilityId,
    displayName: probe.displayName,
    identity: probe.identity,
    metadata: probe.metadata,
    readAccounting: probe.readAccounting,
  };
}

export class ManagedMediaImportService<
  TPlacementRequest = never,
  TPlacementResult = never,
> {
  constructor(
    private readonly grants: VerifiedMediaGrantPort,
    private readonly probes: ManagedMediaProbePort,
    private readonly registry: ImmutableSourceRegistryPort<
      TPlacementRequest,
      TPlacementResult
    >,
  ) {}

  async import(
    request: ManagedMediaImportRequest<TPlacementRequest>,
    signal?: AbortSignal,
  ): Promise<ManagedMediaImportResult<TPlacementResult>> {
    const selected = request.selection.kind === 'directory'
      ? await this.probeDirectorySelection(
        request.jobId,
        request.selection,
        signal,
      )
      : await this.probeExplicitSelection(
        request.jobId,
        request.selection,
        signal,
      );
    const sources = selected.probes.map(toRegistration);

    // The registry/coordinator binding owns the transaction that registers all
    // sources and optionally publishes the typed engine placement request.
    const registration = await this.registry.registerVerifiedAtomically({
      jobId: request.jobId,
      sources,
      placementRequest: request.placementRequest,
    }, signal);

    if (registration.sources.length !== sources.length) {
      throw new ManagedMediaError(
        'INTERNAL_ERROR',
        'Atomic source registration returned an incomplete result.',
      );
    }
    const expectedIdentities = new Map(sources.map((source) => [
      source.sourceCapabilityId,
      {
        byteLength: source.identity.byteLength,
        sha256: source.identity.sha256,
        statIdentity: source.identity.statIdentity,
      },
    ]));
    for (const source of registration.sources) {
      const expected = expectedIdentities.get(source.sourceCapabilityId);
      if (
        !expected
        || expected.sha256 !== source.identity.sha256
        || expected.byteLength !== source.identity.byteLength
        || expected.statIdentity !== source.identity.statIdentity
      ) {
        throw new ManagedMediaError(
          'INTERNAL_ERROR',
          'Atomic source registration returned a mismatched immutable identity.',
        );
      }
      expectedIdentities.delete(source.sourceCapabilityId);
    }
    if (expectedIdentities.size > 0) {
      throw new ManagedMediaError(
        'INTERNAL_ERROR',
        'Atomic source registration omitted an immutable identity.',
      );
    }
    return {
      registration,
      rejectedCandidateCount: selected.rejectedCandidateCount,
    };
  }

  private async probeDirectorySelection(
    jobId: string,
    selection: DirectoryMediaImportSelection,
    signal?: AbortSignal,
  ): Promise<{
    readonly probes: readonly ManagedMediaProbeResult[];
    readonly rejectedCandidateCount: number;
  }> {
    assertSelectionCount(selection.count);
    const maximumCandidates = selection.maximumCandidates
      ?? MEDIA_JOB_LIMITS.maxDirectoryEntries;
    if (
      !Number.isSafeInteger(maximumCandidates)
      || maximumCandidates <= 0
      || maximumCandidates > MEDIA_JOB_LIMITS.maxDirectoryEntries
    ) {
      throw new ManagedMediaError(
        'INVALID_REQUEST',
        'Directory candidate bound is outside allowed limits.',
      );
    }

    const entries = this.grants.listDirectory(
      selection.directory,
      { maxEntries: maximumCandidates },
      signal,
    );
    const selected = await selectNaturalVideoCandidates(entries, {
      maxEntries: maximumCandidates,
    });
    if (
      new Set(selected.candidates.map((candidate) => candidate.sourceCapabilityId)).size
      !== selected.candidates.length
    ) {
      throw new ManagedMediaError(
        'INVALID_REQUEST',
        'Directory media capabilities must be unique.',
      );
    }
    const probes: ManagedMediaProbeResult[] = [];
    let rejectedCandidateCount = selected.rejectedCount;

    for (let index = 0; index < selected.candidates.length; index += 2) {
      if (probes.length >= selection.count) {
        break;
      }
      const batch = selected.candidates.slice(index, index + 2);
      const outcomes = await Promise.all(
        batch.map((candidate, batchIndex) => this.probeCandidate(
          candidate,
          `${jobId}:candidate:${index + batchIndex}`,
          signal,
        )),
      );
      for (const outcome of outcomes) {
        if (probes.length >= selection.count) {
          break;
        }
        if (outcome.result) {
          probes.push(outcome.result);
          continue;
        }
        if (outcome.error?.code === 'UNSUPPORTED_MEDIA') {
          rejectedCandidateCount += 1;
          continue;
        }
        throw outcome.error ?? new ManagedMediaError(
          'INTERNAL_ERROR',
          'Directory media probe failed without an error.',
        );
      }
    }

    if (probes.length !== selection.count) {
      throw new ManagedMediaError(
        'NOT_ENOUGH_VIDEO_SOURCES',
        'Directory did not contain enough supported video sources.',
        {
          details: {
            requested: selection.count,
            available: probes.length,
          },
        },
      );
    }
    return { probes, rejectedCandidateCount };
  }

  private async probeExplicitSelection(
    jobId: string,
    selection: ExplicitMediaImportSelection,
    signal?: AbortSignal,
  ): Promise<{
    readonly probes: readonly ManagedMediaProbeResult[];
    readonly rejectedCandidateCount: number;
  }> {
    assertSelectionCount(selection.sourceCapabilityIds.length);
    if (new Set(selection.sourceCapabilityIds).size !== selection.sourceCapabilityIds.length) {
      throw new ManagedMediaError('INVALID_REQUEST', 'Media import capabilities must be unique.');
    }

    const probes: ManagedMediaProbeResult[] = [];
    for (let index = 0; index < selection.sourceCapabilityIds.length; index += 2) {
      const batch = selection.sourceCapabilityIds.slice(index, index + 2);
      const controller = new AbortController();
      let primaryError: unknown;
      const abortFromCaller = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abortFromCaller, { once: true });
      if (signal?.aborted) {
        controller.abort(signal.reason);
      }
      const outcomes = await Promise.allSettled(batch.map(async (
        sourceCapabilityId,
        batchIndex,
      ) => {
        try {
          return await this.probes.probeCapability(
            sourceCapabilityId,
            `${jobId}:source:${index + batchIndex}`,
            controller.signal,
          );
        } catch (error) {
          if (primaryError === undefined && !signal?.aborted) {
            primaryError = error;
            controller.abort(error);
          }
          throw error;
        }
      }));
      signal?.removeEventListener('abort', abortFromCaller);
      throwIfAborted(signal);
      if (primaryError !== undefined) {
        throw toManagedMediaError(primaryError);
      }
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          throw toManagedMediaError(outcome.reason);
        }
        probes.push(outcome.value);
      }
    }
    return { probes, rejectedCandidateCount: 0 };
  }

  private async probeCandidate(
    candidate: VerifiedMediaCandidate,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ProbeOutcome> {
    try {
      return {
        result: await this.probes.probeCapability(
          candidate.sourceCapabilityId,
          operationId,
          signal,
        ),
      };
    } catch (error) {
      return { error: toManagedMediaError(error) };
    }
  }
}
