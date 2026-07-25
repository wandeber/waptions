import {
  combineReadAccounting,
  createReadAccounting,
  freezeReadAccounting,
  type MediaReadAccounting,
} from '../media/accounting';
import { BoundedConcurrencyGate } from '../media/concurrency';
import type {
  VerifiedMediaGrantPort,
  ManagedJobOpenMediaHandle,
} from '../media/contracts';
import {
  ManagedMediaError,
  throwIfAborted,
  toManagedMediaError,
} from '../media/errors';
import { MEDIA_JOB_LIMITS } from '../media/limits';
import type {
  DecodedMemoryBudgetPort,
  DurableArtifactPublicationPort,
  DurableMediaJobPort,
  MediaDiagnosticsPort,
  PublishedArtifactDescriptor,
  StagedArtifactCapability,
} from '../media/ports';
import type {
  AudioAnalysisProcessResult,
  BoundedMediaProcessPort,
  ManagedMediaProcessResult,
  SceneAnalysisProcessResult,
} from '../media/process-port';
import { executeBoundedMediaProcess } from '../media/process-execution';
import { AsyncResourceScope } from '../media/resource-scope';
import type {
  ImmutableMediaSourceRecord,
  ImmutableSourceRegistryPort,
} from '../source-registry/contracts';
import {
  buildThresholdIntervals,
  normalizeWaveformSamples,
  pickSceneCandidates,
} from './analysis';
import {
  REVIEW_ALGORITHM_VERSION,
  type ManagedMediaReviewRequest,
  type ManagedMediaReviewResult,
} from './contracts';
import { createJsonArrayArtifactStream } from './json-artifact';
import {
  planManagedMediaReview,
  type ManagedMediaReviewPlan,
  type PlannedReviewArtifact,
} from './planning';

interface StagedReviewArtifact {
  readonly plan: PlannedReviewArtifact;
  readonly stage: StagedArtifactCapability;
  committed: boolean;
}

function snapshotsMatch(
  handle: ManagedJobOpenMediaHandle,
  source: ImmutableMediaSourceRecord,
): boolean {
  return (
    handle.snapshot.byteLength === source.identity.byteLength
    && handle.snapshot.statIdentity === source.identity.statIdentity
    && (!handle.snapshot.sha256 || handle.snapshot.sha256 === source.identity.sha256)
  );
}

function resultItems(
  plan: PlannedReviewArtifact,
  result: ManagedMediaProcessResult,
  ranges: ManagedMediaReviewPlan['ranges'],
): readonly unknown[] | undefined {
  if (result.kind === 'audio-analysis') {
    const samples = normalizeWaveformSamples(
      result.samples,
      ranges,
      Number(plan.parameters.bucketDurationUs),
    );
    if (plan.reviewKind === 'silence-map') {
      return buildThresholdIntervals(samples, ranges, {
        mode: 'below',
        thresholdDb: Number(plan.parameters.thresholdDb),
        minimumDurationUs: Number(plan.parameters.minimumDurationUs),
      });
    }
    if (plan.reviewKind === 'speech-map') {
      return buildThresholdIntervals(samples, ranges, {
        mode: 'above',
        thresholdDb: Number(plan.parameters.thresholdDb),
        minimumDurationUs: Number(plan.parameters.minimumDurationUs),
      });
    }
    return samples;
  }
  if (result.kind === 'scene-analysis') {
    return pickSceneCandidates(result.samples, ranges, {
      threshold: Number(plan.parameters.threshold),
      minimumGapUs: Number(plan.parameters.minimumGapUs),
      maxCandidates: Number(plan.parameters.maxCandidates),
    });
  }
  return undefined;
}

function assertStructuredResultBounds(result: ManagedMediaProcessResult): void {
  if (
    result.kind === 'audio-analysis'
    && result.samples.length > MEDIA_JOB_LIMITS.maxAudioBuckets
  ) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Audio process result exceeded its item limit.',
    );
  }
  if (
    result.kind === 'scene-analysis'
    && result.samples.length > MEDIA_JOB_LIMITS.maxSceneSamples
  ) {
    throw new ManagedMediaError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Scene process result exceeded its item limit.',
    );
  }
}

function validateStage(
  stage: StagedArtifactCapability,
  plan: PlannedReviewArtifact,
): void {
  if (
    stage.contentAddress !== plan.contentAddress
    || stage.contentType !== plan.contentType
    || stage.maxBytes !== plan.maxArtifactBytes
    || !stage.stageId
    || !stage.processOutputCapabilityId
  ) {
    throw new ManagedMediaError(
      'INTERNAL_ERROR',
      'Artifact port returned an invalid create-only staging capability.',
    );
  }
}

export class ManagedMediaReviewJobRunner {
  private readonly gate: BoundedConcurrencyGate;

  constructor(
    private readonly registry: ImmutableSourceRegistryPort<unknown, unknown>,
    private readonly grants: VerifiedMediaGrantPort,
    private readonly processes: BoundedMediaProcessPort,
    private readonly artifacts: DurableArtifactPublicationPort,
    private readonly decodedMemory: DecodedMemoryBudgetPort,
    private readonly jobs: DurableMediaJobPort,
    private readonly diagnostics: MediaDiagnosticsPort,
  ) {
    this.gate = new BoundedConcurrencyGate(
      MEDIA_JOB_LIMITS.maxReviewConcurrency,
      'media.review.concurrency',
      diagnostics,
    );
  }

  async run(
    request: ManagedMediaReviewRequest,
    signal?: AbortSignal,
  ): Promise<ManagedMediaReviewResult> {
    let sequence = 1;
    await this.jobs.publish({
      jobId: request.jobId,
      state: 'queued',
      stage: 'waiting-for-review-slot',
      sequence,
      fraction: 0,
    }, signal);

    let release: (() => void) | undefined;
    try {
      release = await this.gate.acquire(request.jobId, signal);
      sequence += 1;
      await this.jobs.publish({
        jobId: request.jobId,
        state: 'running',
        stage: 'reviewing-source',
        sequence,
      }, signal);
      const result = await this.executeReview(request, signal);
      sequence += 1;
      await this.jobs.publish({
        jobId: request.jobId,
        state: 'succeeded',
        stage: 'artifacts-published',
        sequence,
        fraction: 1,
        result: {
          sourceId: result.sourceId,
          artifactIds: result.artifacts.map((artifact) => artifact.artifactId),
          artifactCount: result.artifacts.length,
          bytesRead: result.readAccounting.totalBytes,
        },
      });
      return result;
    } catch (error) {
      const managed = toManagedMediaError(error);
      sequence += 1;
      await this.jobs.publish({
        jobId: request.jobId,
        state: managed.code === 'ABORTED' ? 'cancelled' : 'failed',
        stage: managed.code === 'ABORTED' ? 'cancelled' : 'failed',
        sequence,
        error: {
          code: managed.code,
          message: managed.message,
          retryable: managed.retryable,
        },
      }).catch(() => undefined);
      if (managed.code === 'ABORTED') {
        this.diagnostics.record({
          name: 'media.review.cancelled',
          operationId: request.jobId,
          value: 1,
        });
      }
      throw managed;
    } finally {
      release?.();
    }
  }

  private async executeReview(
    request: ManagedMediaReviewRequest,
    signal?: AbortSignal,
  ): Promise<ManagedMediaReviewResult> {
    throwIfAborted(signal);
    const source = await this.registry.get(request.sourceId, signal);
    if (!source) {
      throw new ManagedMediaError('SOURCE_UNREADABLE', 'Registered media source was not found.');
    }
    const plan = planManagedMediaReview(source, request);
    const scope = new AsyncResourceScope(request.jobId, this.diagnostics);
    const staged: StagedReviewArtifact[] = [];
    const cached = new Map<string, PublishedArtifactDescriptor>();
    const processAccounting: MediaReadAccounting[] = [];
    let primaryError: unknown;

    try {
      const handle = await this.grants.openSource(source.sourceCapabilityId, signal);
      scope.defer(() => handle.close());
      if (!snapshotsMatch(handle, source)) {
        throw this.sourceChanged(request.jobId);
      }

      for (const artifactPlan of plan.artifacts) {
        throwIfAborted(signal);
        const existing = await this.artifacts.findByContentAddress(
          artifactPlan.contentAddress,
          signal,
        );
        if (existing) {
          if (
            existing.contentAddress !== artifactPlan.contentAddress
            || existing.contentType !== artifactPlan.contentType
            || !Number.isSafeInteger(existing.byteLength)
            || existing.byteLength < 0
            || existing.byteLength > artifactPlan.maxArtifactBytes
          ) {
            throw new ManagedMediaError(
              'INTERNAL_ERROR',
              'Cached artifact descriptor does not match the review plan.',
            );
          }
          cached.set(artifactPlan.contentAddress, existing);
          continue;
        }

        const stage = await this.artifacts.stageCreateOnly({
          jobId: request.jobId,
          contentAddress: artifactPlan.contentAddress,
          kind: artifactPlan.reviewKind,
          contentType: artifactPlan.contentType,
          extension: artifactPlan.extension,
          maxBytes: artifactPlan.maxArtifactBytes,
        }, signal);
        const stagedArtifact: StagedReviewArtifact = {
          plan: artifactPlan,
          stage,
          committed: false,
        };
        staged.push(stagedArtifact);
        scope.defer(async () => {
          if (!stagedArtifact.committed) {
            await this.artifacts.discard(stage);
          }
        });
        validateStage(stage, artifactPlan);

        const result = await this.executeArtifactProcess(
          request.jobId,
          handle,
          artifactPlan,
          stage,
          signal,
        );
        assertStructuredResultBounds(result);
        processAccounting.push(result.accounting.input);

        const items = resultItems(artifactPlan, result, plan.ranges);
        if (items) {
          const write = await this.artifacts.writeStream(
            stage,
            createJsonArrayArtifactStream({
              header: {
                algorithmVersion: REVIEW_ALGORITHM_VERSION,
                kind: artifactPlan.reviewKind,
                ranges: plan.ranges,
              },
              arrayKey: artifactPlan.reviewKind === 'scene-candidates'
                ? 'candidates'
                : artifactPlan.reviewKind === 'silence-map'
                  || artifactPlan.reviewKind === 'speech-map'
                  ? 'intervals'
                  : 'samples',
              items,
              signal,
            }),
            signal,
          );
          if (
            write.byteLength > artifactPlan.maxArtifactBytes
            || write.maxBufferedBytes > MEDIA_JOB_LIMITS.processStreamBufferBytes
          ) {
            throw new ManagedMediaError(
              'OUTPUT_LIMIT_EXCEEDED',
              'Structured review artifact exceeded its output bound.',
            );
          }
        }
      }

      // Aggregate descriptor-bounded accounting before crossing the atomic
      // publication boundary so an oversized range set cannot publish bytes.
      const readAccounting = processAccounting.length === 0
        ? freezeReadAccounting(createReadAccounting())
        : combineReadAccounting(
          processAccounting,
          MEDIA_JOB_LIMITS.maxReadAccountingRanges,
        );

      const current = await this.grants.revalidateOpenSource(handle, signal);
      if (
        current.byteLength !== source.identity.byteLength
        || current.statIdentity !== source.identity.statIdentity
        || (current.sha256 !== undefined && current.sha256 !== source.identity.sha256)
      ) {
        throw this.sourceChanged(request.jobId);
      }

      const committed = await this.artifacts.commitBatch(staged.map(({ plan: artifactPlan, stage }) => ({
        stage,
        kind: artifactPlan.reviewKind,
        metadata: {
          algorithmVersion: REVIEW_ALGORITHM_VERSION,
          parameters: artifactPlan.parameters,
          ranges: plan.ranges,
        },
      })), signal);
      if (committed.length !== staged.length) {
        throw new ManagedMediaError(
          'INTERNAL_ERROR',
          'Artifact publication returned an incomplete batch.',
        );
      }
      // Publication has crossed the atomic boundary. Later descriptor
      // validation may fail the job, but must not delete committed cache bytes.
      for (const stagedArtifact of staged) {
        stagedArtifact.committed = true;
      }
      const committedByAddress = new Map(
        committed.map((artifact) => [artifact.contentAddress, artifact]),
      );
      for (const stagedArtifact of staged) {
        const descriptor = committedByAddress.get(stagedArtifact.plan.contentAddress);
        if (
          !descriptor
          || !Number.isSafeInteger(descriptor.byteLength)
          || descriptor.byteLength < 0
          || descriptor.byteLength > stagedArtifact.plan.maxArtifactBytes
        ) {
          throw new ManagedMediaError(
            'INTERNAL_ERROR',
            'Artifact publication returned an invalid descriptor.',
          );
        }
      }

      const descriptors = plan.artifacts.map((artifactPlan) => (
        cached.get(artifactPlan.contentAddress)
        ?? committedByAddress.get(artifactPlan.contentAddress)
      ));
      if (descriptors.some((descriptor) => !descriptor)) {
        throw new ManagedMediaError(
          'INTERNAL_ERROR',
          'Review result is missing an artifact descriptor.',
        );
      }
      this.diagnostics.record({
        name: 'media.review.completed',
        operationId: request.jobId,
        readAccounting,
        attributes: {
          artifacts: descriptors.length,
          cachedArtifacts: cached.size,
        },
      });

      await scope.dispose();
      return {
        jobId: request.jobId,
        sourceId: source.sourceId,
        artifacts: descriptors as PublishedArtifactDescriptor[],
        readAccounting,
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (primaryError !== undefined) {
        await scope.dispose().catch((cleanupError) => {
          this.diagnostics.record({
            name: 'media.resources.cleanup-failed',
            operationId: request.jobId,
            attributes: {
              cleanupError: cleanupError instanceof Error
                ? cleanupError.name
                : 'UnknownCleanupError',
            },
          });
        });
      }
    }
  }

  private async executeArtifactProcess(
    operationId: string,
    handle: ManagedJobOpenMediaHandle,
    plan: PlannedReviewArtifact,
    stage: StagedArtifactCapability,
    signal?: AbortSignal,
  ): Promise<ManagedMediaProcessResult> {
    const lease = plan.decodedReservationBytes > 0
      ? await this.decodedMemory.reserve({
        operationId,
        category: 'review-decode',
        bytes: plan.decodedReservationBytes,
      }, signal)
      : undefined;
    try {
      const result = await executeBoundedMediaProcess(this.processes, {
        operationId,
        source: handle,
        operation: plan.processOperation,
        output: plan.processOperation.kind === 'audio-analysis'
          || plan.processOperation.kind === 'scene-analysis'
          ? undefined
          : stage,
        decodedMemoryLeaseId: lease?.leaseId,
        limits: plan.processLimits,
      }, signal);
      if (result.kind === 'audio-analysis') {
        return result as AudioAnalysisProcessResult;
      }
      if (result.kind === 'scene-analysis') {
        return result as SceneAnalysisProcessResult;
      }
      return result;
    } finally {
      await lease?.release();
    }
  }

  private sourceChanged(operationId: string): ManagedMediaError {
    this.diagnostics.record({
      name: 'source.invalidated',
      operationId,
      value: 1,
    });
    return new ManagedMediaError('SOURCE_CHANGED', 'Registered media source changed.', {
      retryable: true,
    });
  }
}
