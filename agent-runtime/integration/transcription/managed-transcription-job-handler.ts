import { randomUUID } from 'node:crypto';
import { BoundedConcurrency } from '../../media/concurrency';
import type {
    DurableJobHandler,
    DurableJobScheduler,
    JobExecutionContext,
} from '../../jobs/durable-job-scheduler';
import type { DurableWrite } from '../../persistence/managed-filesystem-store';
import { canonicalDigest } from '../../persistence/canonical-json';
import { MediaBudgetManager } from '../../../src/lib/media-byte-source/budget-manager';
import {
    coverageFromCompatibleRecords,
    createRangeTranscriptionRequestKey,
    createTranscriptionCoverageRecordV2,
    normalizeSampleRanges,
    planIncrementalTranscriptionCoverage,
    type RangeAcquisitionProfile,
} from '../../../src/lib/editorial-transcription/range-coverage';
import { sha256CanonicalJson } from '../../../src/lib/editorial-transcription/canonical-json';
import {
    DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT,
    normalizeEditorialLanguage,
} from '../../../src/lib/editorial-transcription/preferences';
import {
    EDITORIAL_TRANSCRIPTION_MODEL,
} from '../../../src/lib/editorial-transcription/request';
import type {
    HalfOpenSampleRange,
    Sha256Digest,
    TranscriptionAcquisitionWindowV2,
    TranscriptionCoverageRecordV2,
} from '../../../src/types/editorial';
import { VerifiedReadHandleMediaByteSource } from './media-byte-source';
import { ManagedTranscriptionProvider } from './provider-transport';
import {
    MANAGED_TRANSCRIPTION_MEMORY_MAX_BYTES,
    ManagedStreamingPcmWindowDecoder,
} from './streaming-pcm-window-decoder';
import type {
    ManagedChunkRecordV1,
    ManagedEndpointCapabilityScope,
    ManagedTranscriptionCheckpointSourceV1,
    ManagedTranscriptionCheckpointV1,
    ManagedTranscriptionFactoryDependencies,
    ManagedTranscriptionJobInputV1,
    ManagedTranscriptionJobKind,
    ManagedTranscriptionJobResultV1,
    ManagedProviderTranscript,
    ManagedTranscriptionSourceRequest,
    ManagedTranscriptionSourceResult,
    ManagedTranscriptionTerminalProposalV1,
    ManagedTranscriptionTerminalPublication,
    PreparedManagedCommitCapability,
    PreparedManagedCoverageUpdate,
    ResolvedManagedCredentialCapability,
    ResolvedManagedEndpointCapability,
} from './contracts';
import {
    ManagedTranscriptionError,
    ManagedTranscriptionStaleError,
    throwIfManagedTranscriptionAborted,
} from './errors';

const MAX_COVERAGE_CAS_ATTEMPTS = 4;
const DEFAULT_INTERNAL_CAPABILITY_LIFETIME_MS = 6 * 60 * 60 * 1_000;
const MAX_SOURCES = 256;
const MAX_RANGES_PER_SOURCE = 10_000;
const MAX_TARGETS = 10_000;

interface ManagedChunkReference {
    readonly recordId: Sha256Digest;
    readonly sourceFingerprint: Sha256Digest;
    readonly acquisitionProfileDigest: Sha256Digest;
    readonly windowId: Sha256Digest;
    readonly decoded: HalfOpenSampleRange;
    readonly canonicalModel: string;
}

/** One process-wide gate shared by editorial and subtitle handler instances. */
export const managedTranscriptionGlobalSemaphore = new BoundedConcurrency(1);

export interface ManagedTranscriptionJobHandlerOptions {
    readonly semaphore?: BoundedConcurrency;
}

export class ManagedTranscriptionJobHandler implements DurableJobHandler<
    ManagedTranscriptionJobInputV1,
    ManagedTranscriptionCheckpointV1,
    ManagedTranscriptionJobResultV1
> {
    private readonly semaphore: BoundedConcurrency;
    private readonly provider: NonNullable<ManagedTranscriptionFactoryDependencies['provider']>;
    private readonly decoder: NonNullable<ManagedTranscriptionFactoryDependencies['decoder']>;

    constructor(
        readonly kind: ManagedTranscriptionJobKind,
        private readonly dependencies: ManagedTranscriptionFactoryDependencies,
        options: ManagedTranscriptionJobHandlerOptions = {},
    ) {
        this.semaphore = options.semaphore ?? managedTranscriptionGlobalSemaphore;
        if (dependencies.provider && dependencies.decoder) {
            this.provider = dependencies.provider;
            this.decoder = dependencies.decoder;
        } else if (!dependencies.provider && !dependencies.decoder) {
            const budget = new MediaBudgetManager(
                'managed-transcription-total-bytes',
                MANAGED_TRANSCRIPTION_MEMORY_MAX_BYTES,
            );
            this.provider = new ManagedTranscriptionProvider({ memoryBudget: budget });
            this.decoder = new ManagedStreamingPcmWindowDecoder({ memoryBudget: budget });
        } else {
            throw new Error(
                'Managed transcription provider and decoder overrides must be supplied together.',
            );
        }
    }

    run(
        input: ManagedTranscriptionJobInputV1,
        context: JobExecutionContext<ManagedTranscriptionCheckpointV1>,
    ): Promise<{
        result: ManagedTranscriptionJobResultV1;
        artifactIds: readonly string[];
        terminalPublication: ManagedTranscriptionTerminalPublication;
    }> {
        this.validateInput(input);
        return this.semaphore.run(
            () => this.runExclusive(input, context),
            context.signal,
        );
    }

    validateInput(input: ManagedTranscriptionJobInputV1): void {
        validateManagedTranscriptionJobInput(input, this.kind);
    }

    private async runExclusive(
        input: ManagedTranscriptionJobInputV1,
        context: JobExecutionContext<ManagedTranscriptionCheckpointV1>,
    ): Promise<{
        result: ManagedTranscriptionJobResultV1;
        artifactIds: readonly string[];
        terminalPublication: ManagedTranscriptionTerminalPublication;
    }> {
        throwIfManagedTranscriptionAborted(context.signal);
        const inputDigest = canonicalDigest(input, 512 * 1024) as Sha256Digest;
        const checkpoint = validateCheckpoint(context.checkpoint, input, inputDigest);
        if (input.providerPolicy.kind === 'browser-local') {
            throw new ManagedTranscriptionError(
                'HEADLESS_BROWSER_LOCAL_UNAVAILABLE',
                false,
                'Browser-local transcription is unavailable in the headless managed runtime.',
            );
        }
        const scope: ManagedEndpointCapabilityScope = {
            projectId: input.projectId,
            sessionEpoch: input.capturedState.sessionEpoch,
        };
        let internalEndpointCapabilityId: string | null = null;
        const preparedCoverage: PreparedManagedCoverageUpdate[] = [];
        let preparedCore: PreparedManagedCommitCapability | null = null;
        try {
            const endpointCapabilityId = input.providerPolicy.endpointCapabilityId
                ?? await this.dependencies.endpoints.issue({
                    endpoint: DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT,
                    kind: 'local',
                    scope,
                    lifetimeMilliseconds: DEFAULT_INTERNAL_CAPABILITY_LIFETIME_MS,
                });
            if (!input.providerPolicy.endpointCapabilityId) {
                internalEndpointCapabilityId = endpointCapabilityId;
            }
            const endpoint = await this.resolveEndpoint(input, endpointCapabilityId, scope);
            await this.assertFresh(input, context.signal);
            const sourceResults: ManagedTranscriptionSourceResult[] = [];
            const sourceChunkRecordIds: Sha256Digest[] = [];
            const checkpointSources = [...(checkpoint?.sources ?? [])];
            for (let sourceIndex = 0; sourceIndex < input.sources.length; sourceIndex += 1) {
                throwIfManagedTranscriptionAborted(context.signal);
                const source = input.sources[sourceIndex];
                const sourceCheckpoint = checkpointSources.find(value => (
                    value.sourceId === source.sourceId
                    && value.sourceFingerprint === source.sourceFingerprint
                ));
                const result = await this.acquireSource({
                    input,
                    source,
                    endpoint,
                    endpointCapabilityId,
                    scope,
                    checkpoint: sourceCheckpoint,
                    startCasAttempt: sourceCheckpoint?.casAttempt ?? 0,
                    context,
                    onCheckpoint: async (sourceCheckpoint) => {
                        const index = checkpointSources.findIndex(value => (
                            value.sourceId === sourceCheckpoint.sourceId
                        ));
                        if (index === -1) checkpointSources.push(sourceCheckpoint);
                        else checkpointSources[index] = sourceCheckpoint;
                        await context.update({
                            stage: 'transcribing',
                            fraction: calculateFraction(
                                sourceIndex,
                                input.sources.length,
                                sourceCheckpoint.completedWindowIds.length,
                                Math.max(1, sourceCheckpoint.completedWindowIds.length + 1),
                            ),
                            checkpoint: {
                                schemaVersion: 1,
                                kind: input.kind,
                                inputDigest,
                                sourceIndex,
                                sources: checkpointSources.map(cloneCheckpointSource),
                                casAttempt: sourceCheckpoint.casAttempt,
                            },
                        });
                    },
                });
                preparedCoverage.push(result.preparedCoverage);
                sourceResults.push(result.result);
                sourceChunkRecordIds.push(...result.chunkRecordIds);
            }
            throwIfManagedTranscriptionAborted(context.signal);
            await this.assertFresh(input, context.signal);
            try {
                preparedCore = input.kind === 'editorial-transcription'
                    ? await this.dependencies.publisher.prepareEditorialPublication({
                        projectId: input.projectId,
                        capturedState: input.capturedState,
                        targetIds: input.targetIds,
                        sources: sourceResults,
                        signal: context.signal,
                    })
                    : await this.dependencies.publisher.prepareSubtitlePublication({
                        projectId: input.projectId,
                        capturedState: input.capturedState,
                        targetIds: input.targetIds,
                        sources: sourceResults,
                        signal: context.signal,
                    });
            } catch (error) {
                if (context.signal.aborted) throwIfManagedTranscriptionAborted(context.signal);
                if (
                    isRecord(error)
                    && (
                        error.code === 'STALE_TRANSCRIPTION_PUBLICATION'
                        || error.name === 'StaleTranscriptionPublicationError'
                    )
                ) {
                    throw new ManagedTranscriptionStaleError('DOCUMENT_STALE');
                }
                throw error;
            }
            preparedCore = sealCoreCapability(preparedCore, input);
            throwIfManagedTranscriptionAborted(context.signal);
            await this.assertFresh(input, context.signal);
            const proposal: ManagedTranscriptionTerminalProposalV1 = {
                schemaVersion: 1,
                proposalId: `transcription-proposal:${randomUUID()}`,
                projectId: input.projectId,
                kind: input.kind,
                inputDigest,
                preparedCorePublication: preparedCore,
                preparedCoverageUpdates: preparedCoverage,
                stagedArtifacts: [],
                transcriptRecordIds: sourceResults.map(value => value.mergedRecordId),
                coverageRecordIds: sourceResults.map(value => value.coverageRecordId),
                chunkRecordIds: normalizeDigests(sourceChunkRecordIds),
                sourceIds: sourceResults.map(value => value.sourceId),
            };
            validateTerminalProposal(proposal);
            const acquiredWindowCount = sourceResults.reduce(
                (sum, source) => sum + source.acquiredWindowCount,
                0,
            );
            const reusedWindowCount = sourceResults.reduce(
                (sum, source) => sum + source.reusedWindowCount,
                0,
            );
            const result: ManagedTranscriptionJobResultV1 = {
                schemaVersion: 1,
                kind: input.kind,
                sourceCount: sourceResults.length,
                acquiredWindowCount,
                reusedWindowCount,
                publicationId: preparedCore.capabilityId,
                sources: sourceResults,
            };
            await context.update({ stage: 'prepared', fraction: 0.99 });
            throwIfManagedTranscriptionAborted(context.signal);
            // Ownership of every prepared capability transfers to the coordinator through this
            // terminal publication. No Core descriptor or coverage head has been published yet.
            preparedCore = null;
            preparedCoverage.length = 0;
            return {
                result,
                artifactIds: [],
                terminalPublication: {
                    artifacts: [],
                    transcription: proposal,
                },
            };
        } finally {
            if (internalEndpointCapabilityId) {
                this.dependencies.endpoints.revoke(internalEndpointCapabilityId);
            }
            if (preparedCore) {
                await Promise.resolve()
                    .then(() => preparedCore?.reject())
                    .catch(() => undefined);
            }
            await Promise.allSettled(preparedCoverage.map(
                value => Promise.resolve().then(() => value.reject()),
            ));
        }
    }

    private async acquireSource(input: {
        readonly input: ManagedTranscriptionJobInputV1;
        readonly source: ManagedTranscriptionSourceRequest;
        readonly endpoint: ResolvedManagedEndpointCapability;
        readonly endpointCapabilityId: string;
        readonly scope: ManagedEndpointCapabilityScope;
        readonly checkpoint?: ManagedTranscriptionCheckpointSourceV1;
        readonly startCasAttempt: number;
        readonly context: JobExecutionContext<ManagedTranscriptionCheckpointV1>;
        readonly onCheckpoint: (
            checkpoint: ManagedTranscriptionCheckpointSourceV1,
        ) => Promise<void>;
    }): Promise<{
        readonly result: ManagedTranscriptionSourceResult;
        readonly preparedCoverage: PreparedManagedCoverageUpdate;
        readonly chunkRecordIds: readonly Sha256Digest[];
    }> {
        let byteSource: VerifiedReadHandleMediaByteSource | null = null;
        let primaryFailure: unknown;
        let completedCoverage: PreparedManagedCoverageUpdate | null = null;
        try {
            const handle = await this.dependencies.sources.openRetainedSource(
                input.input.projectId,
                input.source.sourceId,
                input.context.signal,
            );
            byteSource = new VerifiedReadHandleMediaByteSource(input.source.sourceId, handle);
            throwIfManagedTranscriptionAborted(input.context.signal);
            const identity = await this.verifySource(byteSource, input.context.signal);
            if (identity.fingerprint !== input.source.sourceFingerprint) {
                throw new ManagedTranscriptionStaleError('SOURCE_CHANGED');
            }
            const provisionalChunks = new Map<Sha256Digest, ManagedChunkReference>();
            let totalAcquiredWindowCount = 0;
            for (
                let attempt = input.startCasAttempt;
                attempt < MAX_COVERAGE_CAS_ATTEMPTS;
                attempt += 1
            ) {
                throwIfManagedTranscriptionAborted(input.context.signal);
                await this.assertFresh(input.input, input.context.signal);
                const profile = createProfile(
                    input.source,
                    input.endpoint,
                    input.input,
                );
                const probe = await planIncrementalTranscriptionCoverage({ profile });
                const family = await this.dependencies.cas.listCompatibleCoverage({
                    projectId: input.input.projectId,
                    sourceFingerprint: input.source.sourceFingerprint,
                    acquisitionProfileDigest: probe.acquisitionProfileDigest,
                });
                const compatible = await this.filterRecoverableCoverage(
                    family.records,
                    input.context.signal,
                );
                const compatibleCoverage = coverageFromCompatibleRecords({
                    sourceSampleCount: input.source.sourceSampleCount,
                    hasCompatibleV1FullSource: false,
                    compatibleV2Records: compatible,
                });
                const plan = await planIncrementalTranscriptionCoverage({
                    profile,
                    compatibleCoverage,
                });
                const requestKey = await createRangeTranscriptionRequestKey(profile);
                const chunks = await this.collectCoverageChunks(
                    compatible,
                    input.context.signal,
                );
                const checkpointChunks = await this.recoverCheckpointChunks({
                    checkpoint: input.checkpoint,
                    profileDigest: plan.acquisitionProfileDigest,
                    source: input.source,
                    windows: plan.acquisitionWindows,
                    signal: input.context.signal,
                });
                for (const [windowId, chunk] of provisionalChunks) {
                    if (
                        chunk.acquisitionProfileDigest === plan.acquisitionProfileDigest
                        && plan.acquisitionWindows.some(window => window.windowId === windowId)
                    ) {
                        checkpointChunks.set(windowId, chunk);
                    }
                }
                let reusedWindowCount = chunks.length;
                const completedWindowIds: Sha256Digest[] = [];
                const completedChunkIds: Sha256Digest[] = [];
                for (let windowIndex = 0; windowIndex < plan.acquisitionWindows.length; windowIndex += 1) {
                    const window = plan.acquisitionWindows[windowIndex];
                    throwIfManagedTranscriptionAborted(input.context.signal);
                    await this.assertFresh(input.input, input.context.signal);
                    await this.verifySource(byteSource, input.context.signal);
                    const recovered = checkpointChunks.get(window.windowId);
                    let chunk: ManagedChunkReference;
                    if (recovered) {
                        chunk = recovered;
                        reusedWindowCount += 1;
                    } else {
                        const decoded = await this.decoder.decode({
                            source: byteSource,
                            sourceSampleCount: input.source.sourceSampleCount,
                            window,
                            signal: input.context.signal,
                        });
                        try {
                            let transcript: ManagedProviderTranscript;
                            if (decoded.hasAudioStream && decoded.wav) {
                                // Re-resolve immediately before I/O. A capability revoked or
                                // expired during a long decode must never authorize the request.
                                const resolvedEndpoint = await this.resolveEndpoint(
                                    input.input,
                                    input.endpointCapabilityId,
                                    input.scope,
                                );
                                const credential = this.resolveCredential(
                                    input.input,
                                    input.endpointCapabilityId,
                                    input.scope,
                                );
                                transcript = await this.provider.transcribe({
                                    endpoint: resolvedEndpoint,
                                    ...(credential ? { credential } : {}),
                                    wav: decoded.wav,
                                    sourceFingerprint: input.source.sourceFingerprint,
                                    window,
                                    language: input.input.language,
                                    speakerMode: input.input.speakerMode,
                                    signal: input.context.signal,
                                });
                            } else {
                                transcript = {
                                    canonicalModel: 'local-no-audio',
                                    words: [],
                                    release: () => undefined,
                                };
                            }
                            try {
                                const chunkRecord = await createManagedChunkRecord({
                                    sourceFingerprint: input.source.sourceFingerprint,
                                    acquisitionProfileDigest: plan.acquisitionProfileDigest,
                                    window,
                                    canonicalModel: transcript.canonicalModel,
                                    words: transcript.words,
                                });
                                await this.dependencies.cas.stageChunk(
                                    chunkRecord,
                                    input.context.signal,
                                );
                                chunk = toChunkReference(chunkRecord);
                                totalAcquiredWindowCount += 1;
                            } finally {
                                transcript.release();
                            }
                        } finally {
                            decoded.release();
                        }
                    }
                    chunks.push(chunk);
                    provisionalChunks.set(window.windowId, chunk);
                    completedWindowIds.push(window.windowId);
                    completedChunkIds.push(chunk.recordId);
                    await input.onCheckpoint({
                        sourceId: input.source.sourceId,
                        sourceFingerprint: input.source.sourceFingerprint,
                        acquisitionProfileDigest: plan.acquisitionProfileDigest,
                        requestKey,
                        expectedCoverageRecordIds: family.records
                            .map(record => record.recordId)
                            .sort(),
                        completedWindowIds: [...completedWindowIds],
                        chunkRecordIds: [...completedChunkIds],
                        casAttempt: attempt,
                    });
                }
                const canonicalModels = new Set(chunks.map(chunk => chunk.canonicalModel));
                const canonicalModel = canonicalModels.size === 0
                    ? 'local-no-audio'
                    : canonicalModels.size === 1
                        ? [...canonicalModels][0]
                        : null;
                if (!canonicalModel) {
                    throw new ManagedTranscriptionError(
                        'CAS_CORRUPT',
                        false,
                        'Compatible managed chunks disagree on the canonical provider model.',
                    );
                }
                const cumulativeCore = normalizeSampleRanges([
                    ...compatibleCoverage,
                    ...plan.normalizedCoreCoverage,
                ], input.source.sourceSampleCount);
                const uniqueChunks = deduplicateChunks(chunks);
                const manifest = await this.dependencies.cas.stageMergedTranscript({
                    sourceFingerprint: input.source.sourceFingerprint,
                    acquisitionProfileDigest: plan.acquisitionProfileDigest,
                    sourceSampleCount: input.source.sourceSampleCount,
                    language: input.input.language,
                    speakerMode: input.input.speakerMode,
                    canonicalModel,
                    coreCoverage: cumulativeCore,
                    chunks: uniqueChunks.map(chunk => ({
                        recordId: chunk.recordId,
                        windowId: chunk.windowId,
                        decoded: chunk.decoded,
                    })),
                    signal: input.context.signal,
                });
                const coverageRecord = await createTranscriptionCoverageRecordV2({
                    sourceFingerprint: input.source.sourceFingerprint,
                    sourceSampleRate: 16_000,
                    sourceSampleCount: input.source.sourceSampleCount,
                    acquisitionProfileDigest: plan.acquisitionProfileDigest,
                    endpointIdentityDigest: input.endpoint.endpointIdentityDigest,
                    contextSamples: input.input.contextSamples,
                    requestedModel: EDITORIAL_TRANSCRIPTION_MODEL,
                    responseSchema: 'edit-max-v1',
                    pcmAlgorithmVersion: 1,
                    providerProfileVersion: 1,
                    language: input.input.language ?? 'auto',
                    speakerMode: input.input.speakerMode,
                    coreCoverage: cumulativeCore,
                    acquisitionWindows: mergeCoverageWindows(
                        compatible,
                        plan.acquisitionWindows.map(window => ({
                            ...window,
                            chunkRecordIds: [
                                uniqueChunks.find(chunk => chunk.windowId === window.windowId)
                                    ?.recordId
                                ?? (() => {
                                    throw new ManagedTranscriptionError(
                                        'CAS_CORRUPT',
                                        false,
                                        'The acquired window has no immutable chunk.',
                                    );
                                })(),
                            ],
                        })),
                    ),
                    mergedTranscriptRecordId: manifest.recordId,
                });
                const pinRecordIds = normalizeDigests([
                    ...uniqueChunks.map(chunk => chunk.recordId),
                    manifest.recordId,
                    manifest.mergedWordsRecordId,
                ]);
                await this.verifySource(byteSource, input.context.signal);
                await this.assertFresh(input.input, input.context.signal);
                const rawPreparedCoverage = await this.dependencies.cas.prepareCoverageUpdate({
                    projectId: input.input.projectId,
                    sourceFingerprint: input.source.sourceFingerprint,
                    acquisitionProfileDigest: plan.acquisitionProfileDigest,
                    expectedCoverageRecordIds: family.records
                        .map(record => record.recordId)
                        .sort(),
                    record: coverageRecord,
                    pinRecordIds,
                    signal: input.context.signal,
                });
                if (!rawPreparedCoverage) {
                    await input.onCheckpoint({
                        sourceId: input.source.sourceId,
                        sourceFingerprint: input.source.sourceFingerprint,
                        acquisitionProfileDigest: plan.acquisitionProfileDigest,
                        requestKey,
                        expectedCoverageRecordIds: family.records
                            .map(record => record.recordId)
                            .sort(),
                        completedWindowIds,
                        chunkRecordIds: completedChunkIds,
                        casAttempt: attempt + 1,
                        mergedRecordId: manifest.recordId,
                        coverageRecordId: coverageRecord.recordId,
                    });
                    continue;
                }
                let preparedCoverage: PreparedManagedCoverageUpdate;
                try {
                    preparedCoverage = sealCoverageCapability(
                        rawPreparedCoverage,
                        input.input,
                    );
                } catch (error) {
                    await Promise.resolve()
                        .then(() => rawPreparedCoverage.reject())
                        .catch(() => undefined);
                    throw error;
                }
                completedCoverage = preparedCoverage;
                return {
                    result: {
                        sourceId: input.source.sourceId,
                        sourceFingerprint: input.source.sourceFingerprint,
                        requestKey,
                        acquisitionProfileDigest: plan.acquisitionProfileDigest,
                        mergedRecordId: manifest.recordId,
                        coverageRecordId: coverageRecord.recordId,
                        acquiredWindowCount: totalAcquiredWindowCount,
                        reusedWindowCount,
                    },
                    preparedCoverage,
                    chunkRecordIds: uniqueChunks.map(chunk => chunk.recordId),
                };
            }
            throw new ManagedTranscriptionError(
                'COVERAGE_CONFLICT',
                true,
                'Managed transcription coverage changed too often.',
            );
        } catch (error) {
            primaryFailure = error;
            if (input.context.signal.aborted) {
                throwIfManagedTranscriptionAborted(input.context.signal);
            }
            if (
                isRecord(error)
                && (
                    error.code === 'SOURCE_CHANGED'
                    || error.code === 'SOURCE_NOT_FOUND'
                    || error.code === 'NOT_FOUND'
                    || error.code === 'ENOENT'
                )
            ) {
                throw new ManagedTranscriptionStaleError('SOURCE_CHANGED');
            }
            throw error;
        } finally {
            if (byteSource) {
                try {
                    await byteSource.close();
                } catch (closeError) {
                    // Preserve the primary error, but never report a successful source
                    // acquisition when its retained handle could not be closed cleanly.
                    if (primaryFailure === undefined) {
                        await Promise.resolve()
                            .then(() => completedCoverage?.reject())
                            .catch(() => undefined);
                        throw closeError;
                    }
                }
            }
        }
    }

    private async verifySource(
        source: VerifiedReadHandleMediaByteSource,
        signal: AbortSignal,
    ) {
        try {
            return await source.verify(signal);
        } catch (error) {
            if (signal.aborted) throwIfManagedTranscriptionAborted(signal);
            if (
                isRecord(error)
                && (
                    error.code === 'SOURCE_CHANGED'
                    || error.code === 'SOURCE_NOT_FOUND'
                    || error.code === 'NOT_FOUND'
                    || error.code === 'ENOENT'
                )
            ) {
                throw new ManagedTranscriptionStaleError('SOURCE_CHANGED');
            }
            throw error;
        }
    }

    private async filterRecoverableCoverage(
        records: readonly TranscriptionCoverageRecordV2[],
        signal: AbortSignal,
    ): Promise<TranscriptionCoverageRecordV2[]> {
        const result: TranscriptionCoverageRecordV2[] = [];
        for (const record of records) {
            throwIfManagedTranscriptionAborted(signal);
            const manifest = await this.dependencies.cas.getManifest(
                record.mergedTranscriptRecordId,
            ).catch(() => null);
            const recordIds = [
                record.mergedTranscriptRecordId,
                ...(manifest ? [manifest.mergedWordsRecordId] : []),
                ...record.acquisitionWindows.flatMap(window => window.chunkRecordIds),
            ];
            let valid = true;
            if (!manifest) valid = false;
            for (const recordId of recordIds) {
                if (!await this.dependencies.cas.verifyRecord(recordId, signal)) {
                    valid = false;
                    break;
                }
            }
            if (valid) result.push(record);
        }
        return result;
    }

    private async collectCoverageChunks(
        records: readonly TranscriptionCoverageRecordV2[],
        signal: AbortSignal,
    ): Promise<ManagedChunkReference[]> {
        const result: ManagedChunkReference[] = [];
        const ids = normalizeDigests(
            records.flatMap(record => record.acquisitionWindows.flatMap(
                window => window.chunkRecordIds,
            )),
        );
        for (const recordId of ids) {
            throwIfManagedTranscriptionAborted(signal);
            const chunk = await this.dependencies.cas.getChunk(recordId);
            if (!chunk) {
                throw new ManagedTranscriptionError(
                    'CAS_CORRUPT',
                    true,
                    'A verified managed transcript chunk disappeared.',
                );
            }
            result.push(toChunkReference(chunk));
        }
        return result;
    }

    private async recoverCheckpointChunks(input: {
        readonly checkpoint?: ManagedTranscriptionCheckpointSourceV1;
        readonly profileDigest: Sha256Digest;
        readonly source: ManagedTranscriptionSourceRequest;
        readonly windows: readonly TranscriptionAcquisitionWindowV2[];
        readonly signal: AbortSignal;
    }): Promise<Map<Sha256Digest, ManagedChunkReference>> {
        const result = new Map<Sha256Digest, ManagedChunkReference>();
        if (
            !input.checkpoint
            || input.checkpoint.acquisitionProfileDigest !== input.profileDigest
            || input.checkpoint.sourceFingerprint !== input.source.sourceFingerprint
        ) {
            return result;
        }
        for (let index = 0; index < input.checkpoint.completedWindowIds.length; index += 1) {
            throwIfManagedTranscriptionAborted(input.signal);
            const windowId = input.checkpoint.completedWindowIds[index];
            const recordId = input.checkpoint.chunkRecordIds[index];
            const expectedWindow = input.windows.find(window => window.windowId === windowId);
            if (!recordId || !expectedWindow) continue;
            const chunk = await this.dependencies.cas.getChunk(recordId).catch(() => null);
            if (
                chunk
                && chunk.sourceFingerprint === input.source.sourceFingerprint
                && chunk.acquisitionProfileDigest === input.profileDigest
                && chunk.windowId === windowId
                && equalRange(chunk.decoded, expectedWindow.decoded)
            ) {
                result.set(windowId, toChunkReference(chunk));
            }
        }
        return result;
    }

    private async resolveEndpoint(
        input: ManagedTranscriptionJobInputV1,
        endpointCapabilityId: string,
        scope: ManagedEndpointCapabilityScope,
    ): Promise<ResolvedManagedEndpointCapability> {
        const endpoint = await this.dependencies.endpoints.resolve(endpointCapabilityId, scope);
        const expectedKind = input.providerPolicy.kind === 'managed-local-endpoint'
            ? 'local'
            : 'server';
        if (endpoint.kind !== expectedKind) {
            throw new ManagedTranscriptionError(
                'ENDPOINT_POLICY_REJECTED',
                false,
                'The endpoint capability does not match the managed provider policy.',
            );
        }
        return endpoint;
    }

    private resolveCredential(
        input: ManagedTranscriptionJobInputV1,
        endpointCapabilityId: string,
        scope: ManagedEndpointCapabilityScope,
    ): ResolvedManagedCredentialCapability | undefined {
        const capabilityId = input.providerPolicy.kind === 'browser-local'
            ? undefined
            : input.providerPolicy.credentialCapabilityId;
        return capabilityId
            ? this.dependencies.credentials.resolve(capabilityId, scope, endpointCapabilityId)
            : undefined;
    }

    private async assertFresh(
        input: ManagedTranscriptionJobInputV1,
        signal: AbortSignal,
    ): Promise<void> {
        try {
            await this.dependencies.freshness.assertCurrent({
                projectId: input.projectId,
                capturedState: input.capturedState,
                sources: input.sources.map(source => ({
                    sourceId: source.sourceId,
                    sourceFingerprint: source.sourceFingerprint,
                })),
                targetIds: input.targetIds,
                signal,
            });
        } catch (error) {
            if (signal.aborted) throwIfManagedTranscriptionAborted(signal);
            const code = isRecord(error) ? error.code : undefined;
            if (
                code === 'SOURCE_CHANGED'
                || code === 'REVISION_CONFLICT'
                || code === 'SESSION_REVISION_CONFLICT'
                || code === 'NARRATIVE_REVISION_CONFLICT'
                || code === 'AUDIO_REVISION_CONFLICT'
            ) {
                throw new ManagedTranscriptionStaleError(
                    code === 'SOURCE_CHANGED' ? 'SOURCE_CHANGED' : 'DOCUMENT_STALE',
                );
            }
            if (error instanceof ManagedTranscriptionStaleError) throw error;
            throw error;
        }
    }
}

export function createManagedTranscriptionJobHandlers(
    dependencies: ManagedTranscriptionFactoryDependencies,
): Readonly<Record<ManagedTranscriptionJobKind, ManagedTranscriptionJobHandler>> {
    const semaphore = managedTranscriptionGlobalSemaphore;
    return Object.freeze({
        'editorial-transcription': new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            dependencies,
            { semaphore },
        ),
        'subtitle-transcription': new ManagedTranscriptionJobHandler(
            'subtitle-transcription',
            dependencies,
            { semaphore },
        ),
    });
}

/** Must be called during runtime construction, before `DurableJobScheduler.recover()`. */
export function registerManagedTranscriptionJobHandlers(
    scheduler: DurableJobScheduler,
    dependencies: ManagedTranscriptionFactoryDependencies,
): Readonly<Record<ManagedTranscriptionJobKind, ManagedTranscriptionJobHandler>> {
    const handlers = createManagedTranscriptionJobHandlers(dependencies);
    scheduler.register('editorial-transcription', handlers['editorial-transcription']);
    scheduler.register('subtitle-transcription', handlers['subtitle-transcription']);
    return handlers;
}

export function managedTranscriptionTerminalWrites(
    publication: ManagedTranscriptionTerminalPublication,
): readonly DurableWrite[] {
    return [
        ...publication.transcription.preparedCorePublication.durableWrites(),
        ...publication.transcription.preparedCoverageUpdates.flatMap(
            update => update.durableWrites(),
        ),
        ...publication.transcription.stagedArtifacts.map(artifact => artifact.registryWrite),
    ];
}

/** Invoke only after the coordinator transaction commit marker is durable. */
export async function acceptManagedTranscriptionTerminalPublication(
    publication: ManagedTranscriptionTerminalPublication,
): Promise<void> {
    await Promise.all([
        Promise.resolve().then(
            () => publication.transcription.preparedCorePublication.accept(),
        ),
        ...publication.transcription.preparedCoverageUpdates.map(
            value => Promise.resolve().then(() => value.accept()),
        ),
        ...publication.transcription.stagedArtifacts.map(
            artifact => Promise.resolve().then(() => artifact.accept()),
        ),
    ]);
}

/**
 * Coordinator rejection seam missing from the base scheduler. The owning integration must invoke
 * this before marking a prepared job failed/cancelled or when its terminal transaction aborts.
 */
export async function rejectManagedTranscriptionTerminalPublication(
    publication: ManagedTranscriptionTerminalPublication | undefined,
): Promise<void> {
    if (!publication?.transcription) return;
    await Promise.allSettled([
        Promise.resolve().then(
            () => publication.transcription.preparedCorePublication.reject(),
        ),
        ...publication.transcription.preparedCoverageUpdates.map(
            value => Promise.resolve().then(() => value.reject()),
        ),
        ...publication.transcription.stagedArtifacts.map(
            value => Promise.resolve().then(() => value.reject()),
        ),
    ]);
}

function createProfile(
    source: ManagedTranscriptionSourceRequest,
    endpoint: ResolvedManagedEndpointCapability,
    input: Pick<
        ManagedTranscriptionJobInputV1,
        'contextSamples' | 'language' | 'speakerMode'
    >,
): RangeAcquisitionProfile {
    return {
        sourceFingerprint: source.sourceFingerprint,
        sourceSampleRate: 16_000,
        sourceSampleCount: source.sourceSampleCount,
        coreCoverage: source.ranges,
        contextSamples: input.contextSamples,
        language: input.language,
        speakerMode: input.speakerMode,
        endpointIdentityDigest: endpoint.endpointIdentityDigest,
        requestedModel: EDITORIAL_TRANSCRIPTION_MODEL,
        responseSchema: 'edit-max-v1',
        pcmAlgorithmVersion: 1,
        providerProfileVersion: 1,
    };
}

async function createManagedChunkRecord(input: {
    readonly sourceFingerprint: Sha256Digest;
    readonly acquisitionProfileDigest: Sha256Digest;
    readonly window: TranscriptionAcquisitionWindowV2;
    readonly canonicalModel: string;
    readonly words: readonly import('./contracts').ManagedChunkWordV1[];
}): Promise<ManagedChunkRecordV1> {
    let previousEnd = 0;
    const words = input.words.map((word) => {
        if (
            !Number.isSafeInteger(word.startSample)
            || !Number.isSafeInteger(word.endSample)
            || word.startSample < previousEnd
            || word.endSample <= word.startSample
            || word.endSample > input.window.decoded.endSample - input.window.decoded.startSample
        ) {
            throw new ManagedTranscriptionError(
                'PROVIDER_REJECTED',
                false,
                'The provider returned invalid local word timing.',
            );
        }
        previousEnd = word.endSample;
        return {
            ...word,
            startSample: word.startSample + input.window.decoded.startSample,
            endSample: word.endSample + input.window.decoded.startSample,
            speaker: word.speaker ? { ...word.speaker } : null,
        };
    });
    const body = {
        schemaVersion: 1 as const,
        sourceFingerprint: input.sourceFingerprint,
        acquisitionProfileDigest: input.acquisitionProfileDigest,
        windowId: input.window.windowId,
        decoded: { ...input.window.decoded },
        canonicalModel: input.canonicalModel,
        words,
    };
    return { ...body, recordId: await sha256CanonicalJson(body) };
}

export function validateManagedTranscriptionJobInput(
    input: ManagedTranscriptionJobInputV1,
    registeredKind: ManagedTranscriptionJobKind,
): void {
    if (
        !isRecord(input)
        || !hasExactKeys(input, [
            'schemaVersion',
            'kind',
            'projectId',
            'capturedState',
            'providerPolicy',
            'language',
            'speakerMode',
            'contextSamples',
            'sources',
            'targetIds',
        ])
        || input.schemaVersion !== 1
        || input.kind !== registeredKind
        || !isOpaqueId(input.projectId, 128)
        || input.projectId !== input.capturedState?.projectId
        || !validateStateToken(input.capturedState)
        || (input.speakerMode !== 'none' && input.speakerMode !== 'diarized')
        || !Number.isSafeInteger(input.contextSamples)
        || input.contextSamples < 0
        || input.contextSamples > 160_000
        || !Array.isArray(input.sources)
        || input.sources.length === 0
        || input.sources.length > MAX_SOURCES
        || !Array.isArray(input.targetIds)
        || input.targetIds.length > MAX_TARGETS
        || input.targetIds.some(id => !isOpaqueId(id, 256))
    ) {
        throw invalidInput();
    }
    if (normalizeEditorialLanguage(input.language) !== input.language) throw invalidInput();
    validateProviderPolicy(input.providerPolicy);
    for (const source of input.sources) {
        if (
            !hasExactKeys(source, [
                'sourceId',
                'sourceFingerprint',
                'sourceSampleCount',
                'ranges',
            ])
            || !isOpaqueId(source.sourceId, 200)
            || !isDigest(source.sourceFingerprint)
            || !Number.isSafeInteger(source.sourceSampleCount)
            || source.sourceSampleCount < 0
            || !Array.isArray(source.ranges)
            || source.ranges.length === 0
            || source.ranges.length > MAX_RANGES_PER_SOURCE
        ) {
            throw invalidInput();
        }
        normalizeSampleRanges(source.ranges, source.sourceSampleCount);
    }
}

function validateProviderPolicy(
    value: ManagedTranscriptionJobInputV1['providerPolicy'],
): void {
    if (!isRecord(value) || typeof value.kind !== 'string') throw invalidInput();
    if (value.kind === 'browser-local') {
        if (!hasExactKeys(value, ['kind'])) throw invalidInput();
        return;
    }
    if (value.kind === 'managed-local-endpoint') {
        if (
            !hasOnlyKeys(value, ['kind', 'endpointCapabilityId', 'credentialCapabilityId'])
            || (value.endpointCapabilityId !== undefined
                && !isCapabilityId(value.endpointCapabilityId, 'transcription-endpoint:'))
            || (value.credentialCapabilityId !== undefined
                && !isCapabilityId(value.credentialCapabilityId, 'transcription-credential:'))
        ) {
            throw invalidInput();
        }
        return;
    }
    if (value.kind === 'managed-server-endpoint') {
        if (
            !hasOnlyKeys(value, ['kind', 'endpointCapabilityId', 'credentialCapabilityId'])
            || !isCapabilityId(value.endpointCapabilityId, 'transcription-endpoint:')
            || (value.credentialCapabilityId !== undefined
                && !isCapabilityId(value.credentialCapabilityId, 'transcription-credential:'))
        ) {
            throw invalidInput();
        }
        return;
    }
    throw invalidInput();
}

function validateCheckpoint(
    checkpoint: ManagedTranscriptionCheckpointV1 | undefined,
    input: ManagedTranscriptionJobInputV1,
    inputDigest: Sha256Digest,
): ManagedTranscriptionCheckpointV1 | undefined {
    if (!checkpoint) return undefined;
    if (
        checkpoint.schemaVersion !== 1
        || checkpoint.kind !== input.kind
        || checkpoint.inputDigest !== inputDigest
        || !Number.isSafeInteger(checkpoint.sourceIndex)
        || checkpoint.sourceIndex < 0
        || checkpoint.sourceIndex >= input.sources.length
        || !Number.isSafeInteger(checkpoint.casAttempt)
        || checkpoint.casAttempt < 0
        || checkpoint.casAttempt > MAX_COVERAGE_CAS_ATTEMPTS
        || !Array.isArray(checkpoint.sources)
        || checkpoint.sources.some(source => (
            !hasOnlyKeys(source, [
                'sourceId',
                'sourceFingerprint',
                'acquisitionProfileDigest',
                'requestKey',
                'expectedCoverageRecordIds',
                'completedWindowIds',
                'chunkRecordIds',
                'casAttempt',
                'mergedRecordId',
                'coverageRecordId',
            ])
            || !isOpaqueId(source.sourceId, 200)
            || !isDigest(source.sourceFingerprint)
            || !isDigest(source.acquisitionProfileDigest)
            || !isDigest(source.requestKey)
            || !Array.isArray(source.expectedCoverageRecordIds)
            || source.expectedCoverageRecordIds.some((id: unknown) => !isDigest(id))
            || !Array.isArray(source.completedWindowIds)
            || !Array.isArray(source.chunkRecordIds)
            || source.completedWindowIds.length !== source.chunkRecordIds.length
            || source.completedWindowIds.some((id: unknown) => !isDigest(id))
            || source.chunkRecordIds.some((id: unknown) => !isDigest(id))
            || !Number.isSafeInteger(source.casAttempt)
            || source.casAttempt < 0
            || source.casAttempt > MAX_COVERAGE_CAS_ATTEMPTS
            || (source.mergedRecordId !== undefined && !isDigest(source.mergedRecordId))
            || (source.coverageRecordId !== undefined && !isDigest(source.coverageRecordId))
        ))
    ) {
        throw new ManagedTranscriptionError(
            'CAS_CORRUPT',
            false,
            'The managed transcription checkpoint is invalid.',
        );
    }
    return checkpoint;
}

function sealCoreCapability(
    capability: PreparedManagedCommitCapability,
    input: ManagedTranscriptionJobInputV1,
): PreparedManagedCommitCapability {
    const expectedKind = input.kind === 'editorial-transcription' ? 'editorial' : 'subtitle';
    if (
        !capability
        || !isOpaqueId(capability.capabilityId, 256)
        || capability.projectId !== input.projectId
        || capability.kind !== expectedKind
        || typeof capability.durableWrites !== 'function'
        || typeof capability.accept !== 'function'
        || typeof capability.reject !== 'function'
        || !hasOnlyKeys(capability, [
            'capabilityId',
            'projectId',
            'kind',
            'durableWrites',
            'accept',
            'reject',
        ])
    ) {
        throw new ManagedTranscriptionError(
            'INVALID_INPUT',
            false,
            'The authoritative Core publisher returned an invalid capability.',
        );
    }
    const writes = snapshotDurableWrites(capability.durableWrites());
    return Object.freeze({
        capabilityId: capability.capabilityId,
        projectId: capability.projectId,
        kind: capability.kind,
        durableWrites: () => writes,
        accept: () => capability.accept(),
        reject: () => capability.reject(),
    });
}

function sealCoverageCapability(
    capability: PreparedManagedCoverageUpdate,
    input: ManagedTranscriptionJobInputV1,
): PreparedManagedCoverageUpdate {
    if (
        !capability
        || !isOpaqueId(capability.capabilityId, 256)
        || capability.projectId !== input.projectId
        || capability.kind !== 'coverage'
        || !input.sources.some(source => (
            source.sourceFingerprint === capability.sourceFingerprint
        ))
        || !isDigest(capability.sourceFingerprint)
        || !isDigest(capability.acquisitionProfileDigest)
        || !Array.isArray(capability.expectedCoverageRecordIds)
        || capability.expectedCoverageRecordIds.some(value => !isDigest(value))
        || !isDigest(capability.coverageRecordId)
        || !Array.isArray(capability.pinRecordIds)
        || capability.pinRecordIds.some(value => !isDigest(value))
        || typeof capability.durableWrites !== 'function'
        || typeof capability.accept !== 'function'
        || typeof capability.reject !== 'function'
        || !hasOnlyKeys(capability, [
            'capabilityId',
            'projectId',
            'kind',
            'sourceFingerprint',
            'acquisitionProfileDigest',
            'expectedCoverageRecordIds',
            'coverageRecordId',
            'pinRecordIds',
            'durableWrites',
            'accept',
            'reject',
        ])
    ) {
        throw new ManagedTranscriptionError(
            'INVALID_INPUT',
            false,
            'The managed coverage repository returned an invalid capability.',
        );
    }
    const writes = snapshotDurableWrites(capability.durableWrites());
    return Object.freeze({
        capabilityId: capability.capabilityId,
        projectId: capability.projectId,
        kind: capability.kind,
        sourceFingerprint: capability.sourceFingerprint,
        acquisitionProfileDigest: capability.acquisitionProfileDigest,
        expectedCoverageRecordIds: Object.freeze([
            ...capability.expectedCoverageRecordIds,
        ]),
        coverageRecordId: capability.coverageRecordId,
        pinRecordIds: Object.freeze([...capability.pinRecordIds]),
        durableWrites: () => writes,
        accept: () => capability.accept(),
        reject: () => capability.reject(),
    });
}

function snapshotDurableWrites(values: readonly DurableWrite[]): readonly DurableWrite[] {
    if (!Array.isArray(values) || values.length > 10_000) {
        throw invalidTerminalWrites();
    }
    const scanBudget = { nodes: 0, stringCharacters: 0 };
    const writes = values.map((value) => {
        if (!isRecord(value) || !hasOnlyKeys(value, [
            'relativePath',
            'value',
            'delete',
            'mode',
        ])) {
            throw invalidTerminalWrites();
        }
        const hasValue = Object.prototype.hasOwnProperty.call(value, 'value');
        if (
            typeof value.relativePath !== 'string'
            || !isSafeDurableRelativePath(value.relativePath)
            || hasValue === (value.delete === true)
            || (value.delete !== undefined && value.delete !== true)
            || (value.mode !== undefined && value.mode !== 0o600)
        ) {
            throw invalidTerminalWrites();
        }
        if (hasValue) assertNoSensitiveDurableMaterial(value.value, scanBudget);
        const cloned: DurableWrite = value.delete
            ? {
                relativePath: value.relativePath,
                delete: true,
                ...(value.mode === undefined ? {} : { mode: value.mode }),
            }
            : {
                relativePath: value.relativePath,
                value: structuredClone(value.value),
                ...(value.mode === undefined ? {} : { mode: value.mode }),
            };
        return deepFreeze(cloned);
    });
    return Object.freeze(writes);
}

function isSafeDurableRelativePath(value: string): boolean {
    if (!value || value.length > 1_024 || value.startsWith('/') || value.includes('\\')) {
        return false;
    }
    const segments = value.split('/');
    return segments.every(segment => (
        segment !== ''
        && segment !== '.'
        && segment !== '..'
        && /^[A-Za-z0-9_.-]+$/.test(segment)
    ));
}

function assertNoSensitiveDurableMaterial(
    value: unknown,
    budget: { nodes: number; stringCharacters: number },
): void {
    const seen = new WeakSet<object>();
    const visit = (current: unknown, depth: number): void => {
        budget.nodes += 1;
        if (budget.nodes > 100_000 || depth > 64) throw invalidTerminalWrites();
        if (
            current === null
            || typeof current === 'boolean'
            || typeof current === 'number'
        ) {
            if (typeof current === 'number' && !Number.isFinite(current)) {
                throw invalidTerminalWrites();
            }
            return;
        }
        if (typeof current === 'string') {
            budget.stringCharacters += current.length;
            if (
                budget.stringCharacters > 2 * 1024 * 1024
                || /https?:\/\//i.test(current)
                || /\bbearer\s+\S+/i.test(current)
                || /\bsk-[A-Za-z0-9_-]{12,}/.test(current)
            ) {
                throw invalidTerminalWrites();
            }
            return;
        }
        if (typeof current !== 'object' || seen.has(current)) {
            throw invalidTerminalWrites();
        }
        seen.add(current);
        if (Array.isArray(current)) {
            current.forEach(item => visit(item, depth + 1));
            return;
        }
        if (Object.getPrototypeOf(current) !== Object.prototype) {
            throw invalidTerminalWrites();
        }
        for (const [key, nested] of Object.entries(current)) {
            const normalizedKey = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
            const safeTranscriptReference = normalizedKey === 'transcriptrecordid'
                || normalizedKey === 'transcriptrecordids'
                || normalizedKey === 'mergedtranscriptrecordid';
            const safeEndpointReference = normalizedKey === 'endpointidentitydigest';
            if (
                (normalizedKey.includes('endpoint') && !safeEndpointReference)
                || normalizedKey === 'auth'
                || normalizedKey.includes('authorization')
                || normalizedKey.includes('apikey')
                || normalizedKey.includes('credential')
                || normalizedKey.includes('secret')
                || normalizedKey.includes('password')
                || normalizedKey === 'providerbody'
                || normalizedKey === 'providerresponse'
                || normalizedKey === 'rawresponse'
                || normalizedKey === 'words'
                || (normalizedKey.includes('transcript') && !safeTranscriptReference)
            ) {
                throw invalidTerminalWrites();
            }
            visit(nested, depth + 1);
        }
    };
    visit(value, 0);
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value).forEach(nested => deepFreeze(nested));
    }
    return value;
}

function invalidTerminalWrites(): ManagedTranscriptionError {
    return new ManagedTranscriptionError(
        'INVALID_INPUT',
        false,
        'A managed terminal capability contains invalid durable writes.',
    );
}

function validateTerminalProposal(proposal: ManagedTranscriptionTerminalProposalV1): void {
    if (
        proposal.stagedArtifacts.length !== 0
        || proposal.preparedCoverageUpdates.some(update => !hasOnlyKeys(update, [
            'capabilityId',
            'projectId',
            'kind',
            'sourceFingerprint',
            'acquisitionProfileDigest',
            'expectedCoverageRecordIds',
            'coverageRecordId',
            'pinRecordIds',
            'durableWrites',
            'accept',
            'reject',
        ]))
    ) {
        throw new ManagedTranscriptionError(
            'INVALID_INPUT',
            false,
            'The managed terminal proposal contains an invalid capability.',
        );
    }
    const text = JSON.stringify(
        proposal,
        (_key, value) => typeof value === 'function' ? undefined : value,
    );
    if (
        /https?:\/\//i.test(text)
        || /bearer\s/i.test(text)
        || /"(?:endpoint|authorization|api.?key|secret|password|words|text|response)"\s*:/i
            .test(text)
    ) {
        throw new ManagedTranscriptionError(
            'INVALID_INPUT',
            false,
            'The managed terminal proposal contains forbidden material.',
        );
    }
}

function mergeCoverageWindows(
    existing: readonly TranscriptionCoverageRecordV2[],
    acquired: readonly TranscriptionAcquisitionWindowV2[],
): TranscriptionAcquisitionWindowV2[] {
    const values = new Map<Sha256Digest, TranscriptionAcquisitionWindowV2>();
    for (const window of [
        ...existing.flatMap(record => record.acquisitionWindows),
        ...acquired,
    ]) {
        const previous = values.get(window.windowId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(window)) {
            throw new ManagedTranscriptionError(
                'CAS_CORRUPT',
                false,
                'Managed coverage contains contradictory window identity.',
            );
        }
        values.set(window.windowId, {
            ...window,
            core: { ...window.core },
            decoded: { ...window.decoded },
            chunkRecordIds: [...window.chunkRecordIds],
        });
    }
    return [...values.values()].sort((left, right) => (
        left.core.startSample - right.core.startSample
        || left.core.endSample - right.core.endSample
        || left.windowId.localeCompare(right.windowId)
    ));
}

function deduplicateChunks(values: readonly ManagedChunkReference[]): ManagedChunkReference[] {
    const byId = new Map<Sha256Digest, ManagedChunkReference>();
    for (const value of values) {
        const previous = byId.get(value.recordId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(value)) {
            throw new ManagedTranscriptionError(
                'CAS_CORRUPT',
                false,
                'Managed transcript chunks conflict by content address.',
            );
        }
        byId.set(value.recordId, value);
    }
    return [...byId.values()].sort((left, right) => (
        left.decoded.startSample - right.decoded.startSample
        || left.decoded.endSample - right.decoded.endSample
        || left.windowId.localeCompare(right.windowId)
    ));
}

function toChunkReference(record: ManagedChunkRecordV1): ManagedChunkReference {
    return {
        recordId: record.recordId,
        sourceFingerprint: record.sourceFingerprint,
        acquisitionProfileDigest: record.acquisitionProfileDigest,
        windowId: record.windowId,
        decoded: { ...record.decoded },
        canonicalModel: record.canonicalModel,
    };
}

function normalizeDigests(values: readonly Sha256Digest[]): Sha256Digest[] {
    if (values.some(value => !isDigest(value))) throw invalidInput();
    return [...new Set(values)].sort();
}

function cloneCheckpointSource(
    source: ManagedTranscriptionCheckpointSourceV1,
): ManagedTranscriptionCheckpointSourceV1 {
    return {
        ...source,
        expectedCoverageRecordIds: [...source.expectedCoverageRecordIds],
        completedWindowIds: [...source.completedWindowIds],
        chunkRecordIds: [...source.chunkRecordIds],
        casAttempt: source.casAttempt,
    };
}

function calculateFraction(
    sourceIndex: number,
    sourceCount: number,
    completedWindows: number,
    totalWindows: number,
): number {
    return Math.min(
        0.95,
        (sourceIndex + Math.min(1, completedWindows / totalWindows)) / sourceCount * 0.95,
    );
}

function equalRange(left: HalfOpenSampleRange, right: HalfOpenSampleRange): boolean {
    return left.startSample === right.startSample && left.endSample === right.endSample;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
    const present = Object.keys(value).sort();
    const expected = [...keys].sort();
    return present.length === expected.length
        && present.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
    const allowed = new Set(keys);
    return Object.keys(value).every(key => allowed.has(key));
}

function isCapabilityId(value: unknown, prefix: string): value is string {
    return typeof value === 'string'
        && new RegExp(
            `^${escapeRegExp(prefix)}[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}`
            + '-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        ).test(value);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateStateToken(value: unknown): boolean {
    if (!isRecord(value)) return false;
    const keys = [
        'sessionId',
        'projectId',
        'sessionEpoch',
        'sessionRevision',
        'documentRevision',
        'audioGraphRevision',
        'eventCursor',
        ...(value.narrativeRevision === undefined ? [] : ['narrativeRevision']),
    ];
    return hasExactKeys(value, keys)
        && isOpaqueId(value.sessionId, 128)
        && isOpaqueId(value.projectId, 128)
        && isOpaqueId(value.sessionEpoch, 256)
        && isOpaqueId(value.eventCursor, 256)
        && isRevision(value.sessionRevision)
        && isRevision(value.documentRevision)
        && isRevision(value.audioGraphRevision)
        && (value.narrativeRevision === undefined || isRevision(value.narrativeRevision));
}

function isRevision(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOpaqueId(value: unknown, maximumLength: number): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maximumLength
        && /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value);
}

function isDigest(value: unknown): value is Sha256Digest {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidInput(): ManagedTranscriptionError {
    return new ManagedTranscriptionError(
        'INVALID_INPUT',
        false,
        'The managed transcription request is invalid.',
    );
}
