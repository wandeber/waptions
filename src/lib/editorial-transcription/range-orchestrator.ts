import type {
    HalfOpenSampleRange,
    Sha256Digest,
    TranscriptionAcquisitionWindowV2,
    TranscriptionCoverageRecordV2,
} from '@/types/editorial';
import { sha256CanonicalJson } from './canonical-json';
import {
    coverageFromCompatibleRecords,
    createRangeTranscriptionRequestKey,
    createTranscriptionCoverageRecordV2,
    normalizeSampleRanges,
    planIncrementalTranscriptionCoverage,
    type RangeAcquisitionProfile,
} from './range-coverage';
import {
    mergeRangeTranscriptChunks,
    type MergedRangeTranscript,
    type RangeTranscriptChunk,
    type RangeTranscriptSpeakerEvidence,
} from './range-merge';

export interface LocalRangeTranscriptWord {
    text: string;
    startSample: number;
    endSample: number;
    probability: number | null;
    speaker: RangeTranscriptSpeakerEvidence | null;
}

export interface RangeTranscriptChunkRecordV2 {
    version: 2;
    recordId: Sha256Digest;
    sourceFingerprint: string;
    acquisitionProfileDigest: Sha256Digest;
    windowId: Sha256Digest;
    decoded: HalfOpenSampleRange;
    words: LocalRangeTranscriptWord[];
}

export interface RangeTranscriptionStoredMerge {
    recordId: Sha256Digest;
}

export interface RangeTranscriptionRepository {
    listCompatibleCoverage(input: {
        sourceFingerprint: string;
        acquisitionProfileDigest: Sha256Digest;
    }): Promise<readonly TranscriptionCoverageRecordV2[]>;
    getChunk(recordId: Sha256Digest): Promise<RangeTranscriptChunkRecordV2 | null>;
    putChunk(record: RangeTranscriptChunkRecordV2): Promise<void>;
    putCoverage(record: TranscriptionCoverageRecordV2): Promise<void>;
    compareAndSwapCoverage(input: {
        sourceFingerprint: string;
        acquisitionProfileDigest: Sha256Digest;
        expectedRecordIds: readonly Sha256Digest[];
        record: TranscriptionCoverageRecordV2;
    }): Promise<boolean>;
}

export interface RangeTranscriptionProgress {
    stage: 'planning' | 'decoding' | 'transcribing' | 'merging' | 'publishing';
    completedWindows: number;
    totalWindows: number;
}

export interface RangeTranscriptionCoordinatorDependencies<TPcm> {
    repository: RangeTranscriptionRepository;
    decodeWindow(input: {
        sourceFingerprint: string;
        window: TranscriptionAcquisitionWindowV2;
        signal: AbortSignal;
    }): Promise<TPcm>;
    transcribeWindow(input: {
        pcm: TPcm;
        window: TranscriptionAcquisitionWindowV2;
        profile: RangeAcquisitionProfile;
        signal: AbortSignal;
    }): Promise<readonly LocalRangeTranscriptWord[]>;
    buildMergedRecord(input: {
        merged: MergedRangeTranscript;
        profile: RangeAcquisitionProfile;
        coreCoverage: readonly HalfOpenSampleRange[];
        signal: AbortSignal;
    }): Promise<RangeTranscriptionStoredMerge>;
    isPublicationCurrent(input: {
        requestKey: Sha256Digest;
        sourceFingerprint: string;
    }): boolean | Promise<boolean>;
    publish(input: {
        requestKey: Sha256Digest;
        mergedTranscriptRecordId: Sha256Digest;
        coverageRecord: TranscriptionCoverageRecordV2;
        expectedCoverageRecordIds: readonly Sha256Digest[];
    }): Promise<boolean>;
}

export interface RangeTranscriptionAcquireInput {
    profile: RangeAcquisitionProfile;
    signal: AbortSignal;
    compatibleV1FullSource?: { recordId: Sha256Digest };
    onProgress?(progress: RangeTranscriptionProgress): void;
}

export interface RangeTranscriptionAcquireResult {
    requestKey: Sha256Digest;
    coverageRecord: TranscriptionCoverageRecordV2 | null;
    reusedV1RecordId: Sha256Digest | null;
    acquiredWindowCount: number;
}

const MAX_COVERAGE_CAS_ATTEMPTS = 4;

/**
 * Acquires only compatible coverage gaps and publishes one verified terminal result.
 *
 * Immutable chunks and merged bytes may survive a stale/cancelled job as unpinned CAS candidates.
 * Coverage and the caller's graph mutation are withheld until the final guard passes. Windows are
 * decoded and uploaded strictly sequentially, so PCM/WAV residency is bounded by one window.
 */
export class RangeTranscriptionCoordinator<TPcm> {
    constructor(private readonly dependencies: RangeTranscriptionCoordinatorDependencies<TPcm>) {}

    async acquire(input: RangeTranscriptionAcquireInput): Promise<RangeTranscriptionAcquireResult> {
        const provisionalRecords: TranscriptionCoverageRecordV2[] = [];
        let acquiredWindowCount = 0;
        for (let attempt = 0; attempt < MAX_COVERAGE_CAS_ATTEMPTS; attempt += 1) {
            try {
                const result = await this.acquireAttempt(input, provisionalRecords);
                return {
                    ...result,
                    acquiredWindowCount: acquiredWindowCount + result.acquiredWindowCount,
                };
            } catch (error) {
                if (!(error instanceof CoverageCasConflictError)) throw error;
                acquiredWindowCount += error.acquiredWindowCount;
                if (!provisionalRecords.some(record => record.recordId === error.coverageRecord.recordId)) {
                    provisionalRecords.push(error.coverageRecord);
                }
            }
        }
        throw new Error('Range transcription coverage changed too often to publish safely.');
    }

    private async acquireAttempt(
        input: RangeTranscriptionAcquireInput,
        provisionalRecords: readonly TranscriptionCoverageRecordV2[],
    ): Promise<RangeTranscriptionAcquireResult> {
        throwIfAborted(input.signal);
        input.onProgress?.({ stage: 'planning', completedWindows: 0, totalWindows: 0 });
        const requestKey = await createRangeTranscriptionRequestKey(input.profile);
        if (input.compatibleV1FullSource) {
            if (!(await this.dependencies.isPublicationCurrent({
                requestKey,
                sourceFingerprint: input.profile.sourceFingerprint,
            }))) {
                throw createStaleError();
            }
            return {
                requestKey,
                coverageRecord: null,
                reusedV1RecordId: input.compatibleV1FullSource.recordId,
                acquiredWindowCount: 0,
            };
        }
        const probe = await planIncrementalTranscriptionCoverage({ profile: input.profile });
        const repositoryRecords = await this.dependencies.repository.listCompatibleCoverage({
            sourceFingerprint: input.profile.sourceFingerprint,
            acquisitionProfileDigest: probe.acquisitionProfileDigest,
        });
        const compatibleRecords = deduplicateCoverageRecords([
            ...repositoryRecords,
            ...provisionalRecords,
        ]);
        compatibleRecords.forEach(record => assertCompatibleCoverageRecord(record, input.profile, probe.acquisitionProfileDigest));
        const compatibleCoverage = coverageFromCompatibleRecords({
            sourceSampleCount: input.profile.sourceSampleCount,
            hasCompatibleV1FullSource: false,
            compatibleV2Records: compatibleRecords,
        });
        const plan = await planIncrementalTranscriptionCoverage({
            profile: input.profile,
            compatibleCoverage,
        });
        const allChunks = await loadCompatibleChunks(
            this.dependencies.repository,
            compatibleRecords,
            input.signal,
        );
        const acquiredWindows: TranscriptionAcquisitionWindowV2[] = [];
        input.onProgress?.({
            stage: 'planning',
            completedWindows: 0,
            totalWindows: plan.acquisitionWindows.length,
        });

        for (let index = 0; index < plan.acquisitionWindows.length; index += 1) {
            throwIfAborted(input.signal);
            const window = plan.acquisitionWindows[index];
            input.onProgress?.({
                stage: 'decoding',
                completedWindows: index,
                totalWindows: plan.acquisitionWindows.length,
            });
            const pcm = await this.dependencies.decodeWindow({
                sourceFingerprint: input.profile.sourceFingerprint,
                window,
                signal: input.signal,
            });
            throwIfAborted(input.signal);
            input.onProgress?.({
                stage: 'transcribing',
                completedWindows: index,
                totalWindows: plan.acquisitionWindows.length,
            });
            const localWords = await this.dependencies.transcribeWindow({
                pcm,
                window,
                profile: input.profile,
                signal: input.signal,
            });
            throwIfAborted(input.signal);
            const chunk = await createRangeTranscriptChunkRecord({
                sourceFingerprint: input.profile.sourceFingerprint,
                acquisitionProfileDigest: plan.acquisitionProfileDigest,
                window,
                localWords,
            });
            await this.dependencies.repository.putChunk(chunk);
            allChunks.push(toMergeChunk(chunk));
            acquiredWindows.push({
                ...window,
                chunkRecordIds: [chunk.recordId],
            });
        }

        throwIfAborted(input.signal);
        const cumulativeCore = normalizeSampleRanges([
            ...compatibleCoverage,
            ...plan.normalizedCoreCoverage,
        ], input.profile.sourceSampleCount);
        input.onProgress?.({
            stage: 'merging',
            completedWindows: plan.acquisitionWindows.length,
            totalWindows: plan.acquisitionWindows.length,
        });
        const merged = mergeRangeTranscriptChunks(allChunks, cumulativeCore);
        const storedMerge = await this.dependencies.buildMergedRecord({
            merged,
            profile: input.profile,
            coreCoverage: cumulativeCore,
            signal: input.signal,
        });
        throwIfAborted(input.signal);
        const coverageRecord = await createTranscriptionCoverageRecordV2({
            sourceFingerprint: input.profile.sourceFingerprint,
            sourceSampleRate: input.profile.sourceSampleRate,
            sourceSampleCount: input.profile.sourceSampleCount,
            acquisitionProfileDigest: plan.acquisitionProfileDigest,
            endpointIdentityDigest: input.profile.endpointIdentityDigest,
            contextSamples: input.profile.contextSamples,
            requestedModel: input.profile.requestedModel,
            responseSchema: input.profile.responseSchema,
            pcmAlgorithmVersion: input.profile.pcmAlgorithmVersion,
            providerProfileVersion: input.profile.providerProfileVersion,
            language: input.profile.language?.trim().toLowerCase() || 'auto',
            speakerMode: input.profile.speakerMode,
            coreCoverage: cumulativeCore,
            acquisitionWindows: mergeCoverageWindows(compatibleRecords, acquiredWindows),
            mergedTranscriptRecordId: storedMerge.recordId,
        });
        throwIfAborted(input.signal);
        if (!(await this.dependencies.isPublicationCurrent({
            requestKey,
            sourceFingerprint: input.profile.sourceFingerprint,
        }))) {
            throw createStaleError();
        }
        input.onProgress?.({
            stage: 'publishing',
            completedWindows: plan.acquisitionWindows.length,
            totalWindows: plan.acquisitionWindows.length,
        });
        // The repository coverage head and graph descriptor must become visible together in the
        // adapter's transaction. Calling putCoverage first would permit a cancelled job to change
        // gap planning despite never publishing its merged descriptor.
        const published = await this.dependencies.publish({
            requestKey,
            mergedTranscriptRecordId: storedMerge.recordId,
            coverageRecord,
            expectedCoverageRecordIds: repositoryRecords
                .map(record => record.recordId)
                .sort(),
        });
        if (published === false) {
            throw new CoverageCasConflictError(coverageRecord, acquiredWindows.length);
        }
        throwIfAborted(input.signal);
        if (!(await this.dependencies.isPublicationCurrent({
            requestKey,
            sourceFingerprint: input.profile.sourceFingerprint,
        }))) {
            // Immutable CAS bytes may remain as unpinned cache candidates, but no caller-visible
            // descriptor or pin may escape after the source/project guard changed.
            throw createStaleError();
        }
        return {
            requestKey,
            coverageRecord,
            reusedV1RecordId: null,
            acquiredWindowCount: acquiredWindows.length,
        };
    }
}

class CoverageCasConflictError extends Error {
    constructor(
        readonly coverageRecord: TranscriptionCoverageRecordV2,
        readonly acquiredWindowCount: number,
    ) {
        super('Range transcription coverage changed during publication.');
        this.name = 'CoverageCasConflictError';
    }
}

export async function createRangeTranscriptChunkRecord(input: {
    sourceFingerprint: string;
    acquisitionProfileDigest: Sha256Digest;
    window: TranscriptionAcquisitionWindowV2;
    localWords: readonly LocalRangeTranscriptWord[];
}): Promise<RangeTranscriptChunkRecordV2> {
    let previousEnd = 0;
    const words = input.localWords.map((word) => {
        if (!Number.isSafeInteger(word.startSample)
            || !Number.isSafeInteger(word.endSample)
            || word.startSample < 0
            || word.endSample <= word.startSample
            || word.startSample < previousEnd
            || word.endSample > input.window.decoded.endSample - input.window.decoded.startSample) {
            throw new Error('Range transcription returned invalid local timing.');
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
        version: 2 as const,
        sourceFingerprint: input.sourceFingerprint,
        acquisitionProfileDigest: input.acquisitionProfileDigest,
        windowId: input.window.windowId,
        decoded: { ...input.window.decoded },
        words,
    };
    return {
        ...body,
        recordId: await sha256CanonicalJson(body),
    };
}

function toMergeChunk(record: RangeTranscriptChunkRecordV2): RangeTranscriptChunk {
    return {
        recordId: record.recordId,
        windowId: record.windowId,
        decoded: record.decoded,
        words: record.words,
    };
}

async function loadCompatibleChunks(
    repository: RangeTranscriptionRepository,
    records: readonly TranscriptionCoverageRecordV2[],
    signal: AbortSignal,
): Promise<RangeTranscriptChunk[]> {
    const result: RangeTranscriptChunk[] = [];
    const ids = Array.from(new Set(records.flatMap(record => (
        record.acquisitionWindows.flatMap(window => window.chunkRecordIds)
    )))).sort();
    for (const recordId of ids) {
        throwIfAborted(signal);
        const chunk = await repository.getChunk(recordId);
        if (!chunk || chunk.recordId !== recordId) {
            throw new Error('Compatible range transcription chunk is unavailable.');
        }
        result.push(toMergeChunk(chunk));
    }
    return result;
}

function mergeCoverageWindows(
    existing: readonly TranscriptionCoverageRecordV2[],
    acquired: readonly TranscriptionAcquisitionWindowV2[],
): TranscriptionAcquisitionWindowV2[] {
    const byId = new Map<Sha256Digest, TranscriptionAcquisitionWindowV2>();
    [...existing.flatMap(record => record.acquisitionWindows), ...acquired].forEach((window) => {
        const previous = byId.get(window.windowId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(window)) {
            throw new Error('Compatible coverage contains a contradictory window identity.');
        }
        byId.set(window.windowId, {
            ...window,
            core: { ...window.core },
            decoded: { ...window.decoded },
            chunkRecordIds: [...window.chunkRecordIds],
        });
    });
    return Array.from(byId.values()).sort((left, right) => (
        left.core.startSample - right.core.startSample
        || left.core.endSample - right.core.endSample
        || left.windowId.localeCompare(right.windowId)
    ));
}

function deduplicateCoverageRecords(
    records: readonly TranscriptionCoverageRecordV2[],
): TranscriptionCoverageRecordV2[] {
    const byId = new Map<Sha256Digest, TranscriptionCoverageRecordV2>();
    records.forEach((record) => {
        const previous = byId.get(record.recordId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(record)) {
            throw new Error('Range transcription coverage has contradictory immutable bytes.');
        }
        byId.set(record.recordId, record);
    });
    return Array.from(byId.values()).sort((left, right) => (
        left.recordId.localeCompare(right.recordId)
    ));
}

function assertCompatibleCoverageRecord(
    record: TranscriptionCoverageRecordV2,
    profile: RangeAcquisitionProfile,
    acquisitionProfileDigest: Sha256Digest,
): void {
    if (record.sourceFingerprint !== profile.sourceFingerprint
        || record.sourceSampleRate !== profile.sourceSampleRate
        || record.sourceSampleCount !== profile.sourceSampleCount
        || record.acquisitionProfileDigest !== acquisitionProfileDigest
        || record.speakerMode !== profile.speakerMode
        || record.language !== (profile.language?.trim().toLowerCase() || 'auto')) {
        throw new Error('Range transcription cache has contradictory source or profile provenance.');
    }
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('Range transcription was cancelled.', 'AbortError');
}

function createStaleError(): DOMException {
    return new DOMException('Range transcription result became stale.', 'AbortError');
}
