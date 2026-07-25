import type { DurableJobHandler } from '../../jobs/durable-job-scheduler';
import type { ArtifactRegistry, StagedArtifact } from '../../artifacts/artifact-registry';
import { executeBoundedMediaProcess } from '../../media/process-execution';
import { ManagedMediaError, throwIfAborted } from '../../media/errors';
import type { BoundedMediaProcessPort } from '../../media/process-port';
import type { DecodedMemoryBudgetPort } from '../../media/ports';
import type {
    ImmutableMediaSourceRecord,
} from '../../source-registry/contracts';
import {
    buildThresholdIntervals,
    normalizeWaveformSamples,
    pickSceneCandidates,
} from '../../review/analysis';
import {
    planManagedMediaReview,
    type PlannedReviewArtifact,
} from '../../review/planning';
import type {
    ManagedMediaReviewRequest as InternalReviewRequest,
    MediaReviewSpecification,
    MediaTimeRange,
} from '../../review/contracts';
import type {
    ManagedMediaReviewJobResult,
    ManagedMediaReviewRequest,
} from './contracts';
import type { PathGrantMediaAdapter } from './path-grant-media-adapter';
import type { PrivateReviewArtifactStager } from './review-artifact-staging';

const MAX_TERMINAL_ARTIFACTS = 64;

export class ManagedMediaReviewJobHandler implements DurableJobHandler<
    ManagedMediaReviewRequest,
    never,
    Omit<ManagedMediaReviewJobResult, 'terminalPublication'>
> {
    constructor(
        private readonly catalog: PathGrantMediaAdapter,
        private readonly processes: BoundedMediaProcessPort,
        private readonly staging: PrivateReviewArtifactStager,
        private readonly artifacts: ArtifactRegistry,
        private readonly decodedMemory: DecodedMemoryBudgetPort,
    ) {}

    async run(
        input: ManagedMediaReviewRequest,
        context: Parameters<DurableJobHandler<ManagedMediaReviewRequest, never>['run']>[1],
    ) {
        validateInput(input);
        if (input.reviewKind === 'transcription-assisted') {
            throw new ManagedMediaError(
                'INVALID_REQUEST',
                'Transcription-assisted review belongs to the transcription service.',
            );
        }
        const specifications = toSpecifications(input);
        if (input.sourceIds.length * specifications.length > MAX_TERMINAL_ARTIFACTS) {
            throw new ManagedMediaError(
                'RESOURCE_LIMIT_EXCEEDED',
                `One review job may stage at most ${MAX_TERMINAL_ARTIFACTS} artifacts.`,
            );
        }
        const publications: StagedArtifact[] = [];
        try {
            let completed = 0;
            const total = input.sourceIds.length * specifications.length;
            for (const sourceId of input.sourceIds) {
                throwIfAborted(context.signal);
                const record = this.catalog.getBySourceId(sourceId);
                if (!record) {
                    throw new ManagedMediaError(
                        'SOURCE_UNREADABLE',
                        'A committed media source was not found.',
                    );
                }
                const source = toSourceRecord(record);
                const request: InternalReviewRequest = {
                    jobId: input.jobId,
                    sourceId,
                    scope: input.intervalsSeconds && input.intervalsSeconds.length > 0
                        ? {
                            kind: 'used-ranges',
                            ranges: input.intervalsSeconds.map((range) => ({
                                startUs: Math.round(range.startSeconds * 1_000_000),
                                endUs: Math.round(range.endSeconds * 1_000_000),
                            })),
                        }
                        : { kind: 'full-source', confirmed: true },
                    reviews: specifications,
                };
                const plan = planManagedMediaReview(source, request);
                for (const artifactPlan of plan.artifacts) {
                    throwIfAborted(context.signal);
                    const staged = await this.runArtifact(
                        input,
                        record.handle.capabilityId,
                        source,
                        plan.ranges,
                        artifactPlan,
                        context.signal,
                    );
                    publications.push(staged);
                    completed += 1;
                    await context.update({
                        stage: `review:${artifactPlan.reviewKind}`,
                        fraction: completed / total,
                    });
                }
            }
            return {
                result: {
                    sourceIds: Object.freeze([...input.sourceIds]),
                    reviewKind: input.reviewKind,
                    artifactIds: Object.freeze(
                        publications.map((publication) => publication.record.artifactId),
                    ),
                },
                artifactIds: publications.map((publication) => publication.record.artifactId),
                terminalPublication: {
                    artifacts: publications,
                },
            };
        } catch (error) {
            const rollback = await Promise.allSettled(
                publications.map((publication) => publication.reject()),
            );
            const failures = rollback.flatMap((result) => (
                result.status === 'rejected' ? [result.reason] : []
            ));
            throw failures.length > 0
                ? new AggregateError([error, ...failures], 'Review artifact rollback failed.')
                : error;
        }
    }

    private async runArtifact(
        input: ManagedMediaReviewRequest,
        sourceCapabilityId: string,
        source: ImmutableMediaSourceRecord,
        ranges: readonly MediaTimeRange[],
        plan: PlannedReviewArtifact,
        signal?: AbortSignal,
    ): Promise<StagedArtifact> {
        const stage = await this.staging.create(plan.maxArtifactBytes, signal);
        let handle: Awaited<ReturnType<PathGrantMediaAdapter['openSource']>> | undefined;
        let decodedLease: Awaited<ReturnType<DecodedMemoryBudgetPort['reserve']>> | undefined;
        let publication: StagedArtifact | undefined;
        let operationError: unknown;
        try {
            handle = await this.catalog.openSource(sourceCapabilityId, signal);
            decodedLease = plan.decodedReservationBytes > 0
                ? await this.decodedMemory.reserve({
                    operationId: `${input.jobId}:${source.sourceId}:${plan.reviewKind}`,
                    category: 'review-decode',
                    bytes: plan.decodedReservationBytes,
                }, signal)
                : undefined;
            const result = await executeBoundedMediaProcess(this.processes, {
                operationId: `${input.jobId}:${source.sourceId}:${plan.reviewKind}`,
                source: handle,
                operation: plan.processOperation,
                output: plan.processOperation.kind === 'audio-analysis'
                    || plan.processOperation.kind === 'scene-analysis'
                    ? undefined
                    : {
                        stageId: stage.stageId,
                        processOutputCapabilityId: stage.processOutputCapabilityId,
                        contentAddress: plan.contentAddress,
                        contentType: plan.contentType,
                        maxBytes: plan.maxArtifactBytes,
                    },
                limits: plan.processLimits,
            }, signal);
            const structured = structuredArtifact(plan, result, ranges);
            if (structured !== undefined) {
                await stage.writeJson(structured, signal);
            }
            await validateStagedArtifact(stage, plan, signal);
            await this.catalog.revalidateOpenSource(handle, signal);
            publication = await this.artifacts.stage(
                input.projectId,
                canonicalArtifactKind(plan.reviewKind),
                plan.contentType,
                stage.stream(signal),
                {
                    sourceIds: [source.sourceId],
                    signal,
                },
            );
        } catch (error) {
            operationError = error;
        }
        const cleanup = await Promise.allSettled([
            handle?.close() ?? Promise.resolve(),
            stage.discard(),
            decodedLease?.release() ?? Promise.resolve(),
        ]);
        const cleanupErrors = cleanup.flatMap((result) => (
            result.status === 'rejected' ? [result.reason] : []
        ));
        if (operationError !== undefined || cleanupErrors.length > 0) {
            if (publication) {
                const rejected = await Promise.allSettled([publication.reject()]);
                if (rejected[0]?.status === 'rejected') cleanupErrors.push(rejected[0].reason);
            }
            const errors = [
                ...(operationError === undefined ? [] : [operationError]),
                ...cleanupErrors,
            ];
            throw errors.length === 1
                ? errors[0]
                : new AggregateError(errors, 'Review artifact cleanup failed.');
        }
        return publication!;
    }
}

async function validateStagedArtifact(
    stage: Awaited<ReturnType<PrivateReviewArtifactStager['create']>>,
    plan: PlannedReviewArtifact,
    signal?: AbortSignal,
): Promise<void> {
    const byteLength = await stage.byteLength(signal);
    if (byteLength <= 0 || byteLength > plan.maxArtifactBytes) {
        throw new ManagedMediaError(
            'OUTPUT_LIMIT_EXCEEDED',
            'Review process produced an empty or oversized artifact.',
        );
    }
    const prefix: Uint8Array[] = [];
    let collected = 0;
    for await (const chunk of stage.stream(signal)) {
        const take = Math.min(chunk.byteLength, 12 - collected);
        if (take > 0) {
            prefix.push(chunk.subarray(0, take));
            collected += take;
        }
        if (collected >= 12) break;
    }
    const header = Buffer.concat(prefix.map((chunk) => Buffer.from(chunk)), collected);
    if (plan.contentType === 'image/webp'
        && (header.byteLength < 12
            || header.subarray(0, 4).toString('ascii') !== 'RIFF'
            || header.subarray(8, 12).toString('ascii') !== 'WEBP')) {
        throw new ManagedMediaError('PROCESS_FAILED', 'Review WebP artifact is invalid.');
    }
    if (plan.contentType === 'video/mp4'
        && (header.byteLength < 8 || header.subarray(4, 8).toString('ascii') !== 'ftyp')) {
        throw new ManagedMediaError('PROCESS_FAILED', 'Review MP4 artifact is invalid.');
    }
    if (plan.contentType === 'application/json') {
        try {
            JSON.parse(header.byteLength === byteLength
                ? header.toString('utf8')
                : await collectStructuredStage(stage, byteLength, signal));
        } catch {
            throw new ManagedMediaError('PROCESS_FAILED', 'Structured review artifact is invalid.');
        }
    }
}

async function collectStructuredStage(
    stage: Awaited<ReturnType<PrivateReviewArtifactStager['create']>>,
    byteLength: number,
    signal?: AbortSignal,
): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stage.stream(signal)) {
        total += chunk.byteLength;
        if (total > byteLength) {
            throw new ManagedMediaError('PATH_IDENTITY_CHANGED', 'Review JSON changed during read.');
        }
        chunks.push(Buffer.from(chunk));
    }
    if (total !== byteLength) {
        throw new ManagedMediaError('PATH_IDENTITY_CHANGED', 'Review JSON was truncated.');
    }
    return Buffer.concat(chunks, total).toString('utf8');
}

function toSpecifications(
    input: ManagedMediaReviewRequest,
): readonly MediaReviewSpecification[] {
    const maximum = input.maximumSamples;
    switch (input.reviewKind) {
        case 'contact-sheet':
            return [{ kind: 'contact-sheet', frameCount: maximum }];
        case 'thumbnail-strip':
            return [{ kind: 'thumbnail-strip', frameCount: maximum }];
        case 'waveform-audio-map':
            return [
                { kind: 'waveform', bucketDurationUs: bucketDuration(input) },
                { kind: 'audio-map', bucketDurationUs: bucketDuration(input) },
            ];
        case 'silence-speech-map':
            return [
                { kind: 'silence-map', bucketDurationUs: bucketDuration(input) },
                { kind: 'speech-map', bucketDurationUs: bucketDuration(input) },
            ];
        case 'scene-cut-candidates':
            return [{
                kind: 'scene-candidates',
                maxCandidates: maximum,
            }];
        case 'review-proxy':
            return [{ kind: 'review-proxy' }];
        case 'transcription-assisted':
            return [];
    }
}

function bucketDuration(input: ManagedMediaReviewRequest): number | undefined {
    if (!input.maximumSamples) return undefined;
    const seconds = input.intervalsSeconds?.reduce(
        (sum, range) => sum + range.endSeconds - range.startSeconds,
        0,
    );
    if (!seconds || seconds <= 0) return undefined;
    return Math.max(10_000, Math.ceil(seconds * 1_000_000 / input.maximumSamples));
}

function structuredArtifact(
    plan: PlannedReviewArtifact,
    result: Awaited<ReturnType<typeof executeBoundedMediaProcess>>,
    ranges: readonly MediaTimeRange[],
): unknown {
    if (result.kind === 'audio-analysis') {
        const samples = normalizeWaveformSamples(
            result.samples,
            ranges,
            Number(plan.parameters.bucketDurationUs),
        );
        if (plan.reviewKind === 'silence-map') {
            return {
                algorithmVersion: 'managed-media-review-v1',
                kind: plan.reviewKind,
                ranges,
                intervals: buildThresholdIntervals(samples, ranges, {
                    mode: 'below',
                    thresholdDb: Number(plan.parameters.thresholdDb),
                    minimumDurationUs: Number(plan.parameters.minimumDurationUs),
                }),
            };
        }
        if (plan.reviewKind === 'speech-map') {
            return {
                algorithmVersion: 'managed-media-review-v1',
                kind: plan.reviewKind,
                ranges,
                intervals: buildThresholdIntervals(samples, ranges, {
                    mode: 'above',
                    thresholdDb: Number(plan.parameters.thresholdDb),
                    minimumDurationUs: Number(plan.parameters.minimumDurationUs),
                }),
            };
        }
        return {
            algorithmVersion: 'managed-media-review-v1',
            kind: plan.reviewKind,
            ranges,
            samples,
        };
    }
    if (result.kind === 'scene-analysis') {
        return {
            algorithmVersion: 'managed-media-review-v1',
            kind: 'scene-cut-candidates',
            ranges,
            candidates: pickSceneCandidates(result.samples, ranges, {
                threshold: Number(plan.parameters.threshold),
                minimumGapUs: Number(plan.parameters.minimumGapUs),
                maxCandidates: Number(plan.parameters.maxCandidates),
            }),
        };
    }
    return undefined;
}

function toSourceRecord(
    record: NonNullable<ReturnType<PathGrantMediaAdapter['getBySourceId']>>,
): ImmutableMediaSourceRecord {
    return {
        version: 1,
        sourceId: record.sourceId,
        sourceCapabilityId: record.handle.capabilityId,
        displayName: record.displayName,
        identity: record.registeredIdentity,
        metadata: record.metadata,
        registeredAt: record.handle.verifiedAt,
    };
}

function canonicalArtifactKind(kind: PlannedReviewArtifact['reviewKind']): string {
    switch (kind) {
        case 'scene-candidates':
            return 'scene-cuts';
        case 'silence-map':
        case 'speech-map':
            return 'silence-speech-map';
        case 'review-proxy':
            return 'review-proxy';
        default:
            return kind;
    }
}

function validateInput(input: ManagedMediaReviewRequest): void {
    if (input.sourceIds.length < 1 || input.sourceIds.length > 256
        || new Set(input.sourceIds).size !== input.sourceIds.length) {
        throw new ManagedMediaError('INVALID_REQUEST', 'Review source IDs are invalid.');
    }
    if (input.maximumSamples !== undefined
        && (!Number.isSafeInteger(input.maximumSamples)
            || input.maximumSamples < 1
            || input.maximumSamples > 10_000)) {
        throw new ManagedMediaError('INVALID_REQUEST', 'Review sample bound is invalid.');
    }
}
