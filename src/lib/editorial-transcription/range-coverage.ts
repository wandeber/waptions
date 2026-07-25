import {
    EDITORIAL_TRANSCRIPT_MERGE_ALGORITHM_VERSION,
    type EditorialSpeakerMode,
    type HalfOpenSampleRange,
    type Sha256Digest,
    type TranscriptionAcquisitionWindowV2,
    type TranscriptionCoverageRecordV2,
} from '@/types/editorial';
import { sha256CanonicalJson } from './canonical-json';

export const DEFAULT_TRANSCRIPTION_CONTEXT_SECONDS = 2;
export const MAX_TRANSCRIPTION_CONTEXT_SECONDS = 10;
export const MAX_TRANSCRIPTION_WINDOW_SECONDS = 30;
export const TRANSCRIPTION_COVERAGE_PROFILE_VERSION = 1;
const COVERAGE_RECORD_KEYS = new Set([
    'version',
    'recordId',
    'sourceFingerprint',
    'sourceSampleRate',
    'sourceSampleCount',
    'acquisitionProfileDigest',
    'endpointIdentityDigest',
    'contextSamples',
    'requestedModel',
    'responseSchema',
    'pcmAlgorithmVersion',
    'providerProfileVersion',
    'language',
    'speakerMode',
    'mergeAlgorithmVersion',
    'coreCoverage',
    'acquisitionWindows',
    'mergedTranscriptRecordId',
]);

export interface RangeAcquisitionProfile {
    sourceFingerprint: string;
    sourceSampleRate: number;
    sourceSampleCount: number;
    coreCoverage: readonly HalfOpenSampleRange[];
    contextSamples: number;
    language: string | null;
    speakerMode: EditorialSpeakerMode;
    endpointIdentityDigest: Sha256Digest;
    requestedModel: string;
    responseSchema: string;
    pcmAlgorithmVersion: number;
    providerProfileVersion: number;
    mergeAlgorithmVersion?: typeof EDITORIAL_TRANSCRIPT_MERGE_ALGORITHM_VERSION;
}

export interface IncrementalCoveragePlan {
    normalizedCoreCoverage: HalfOpenSampleRange[];
    reusableCoverage: HalfOpenSampleRange[];
    missingCoreCoverage: HalfOpenSampleRange[];
    acquisitionProfileDigest: Sha256Digest;
    acquisitionWindows: TranscriptionAcquisitionWindowV2[];
}

type CoverageRecordBodyV2 = Omit<TranscriptionCoverageRecordV2, 'recordId'>;

/** Normalizes arbitrary ranges into one sorted, disjoint, adjacency-coalesced union. */
export function normalizeSampleRanges(
    ranges: readonly HalfOpenSampleRange[],
    sourceSampleCount: number,
): HalfOpenSampleRange[] {
    assertSourceSampleCount(sourceSampleCount);
    const ordered = ranges.map((range) => {
        assertRange(range, sourceSampleCount);
        return { startSample: range.startSample, endSample: range.endSample };
    }).sort(compareRanges);
    const normalized: HalfOpenSampleRange[] = [];
    for (const range of ordered) {
        const previous = normalized.at(-1);
        if (!previous || range.startSample > previous.endSample) {
            normalized.push(range);
            continue;
        }
        previous.endSample = Math.max(previous.endSample, range.endSample);
    }
    return normalized;
}

/** Returns exactly the requested intervals not already covered by compatible records. */
export function subtractSampleRanges(
    requested: readonly HalfOpenSampleRange[],
    covered: readonly HalfOpenSampleRange[],
    sourceSampleCount: number,
): HalfOpenSampleRange[] {
    const requestedUnion = normalizeSampleRanges(requested, sourceSampleCount);
    const coveredUnion = normalizeSampleRanges(covered, sourceSampleCount);
    const missing: HalfOpenSampleRange[] = [];
    let coveredIndex = 0;
    for (const request of requestedUnion) {
        let cursor = request.startSample;
        while (coveredIndex < coveredUnion.length
            && coveredUnion[coveredIndex].endSample <= cursor) {
            coveredIndex += 1;
        }
        let index = coveredIndex;
        while (index < coveredUnion.length
            && coveredUnion[index].startSample < request.endSample) {
            const retained = coveredUnion[index];
            if (retained.startSample > cursor) {
                missing.push({
                    startSample: cursor,
                    endSample: Math.min(retained.startSample, request.endSample),
                });
            }
            cursor = Math.max(cursor, retained.endSample);
            if (cursor >= request.endSample) break;
            index += 1;
        }
        if (cursor < request.endSample) {
            missing.push({ startSample: cursor, endSample: request.endSample });
        }
    }
    return missing;
}

/**
 * Treats V1 descriptors as complete coverage and V2 records as their explicit core union.
 *
 * Callers must first filter V2 records by the exact acquisition profile digest. A mismatched
 * language, speaker policy, provider/model, schema, resampler, context, or merge version is not
 * compatible cache evidence.
 */
export function coverageFromCompatibleRecords(input: {
    sourceSampleCount: number;
    hasCompatibleV1FullSource: boolean;
    compatibleV2Records: readonly TranscriptionCoverageRecordV2[];
}): HalfOpenSampleRange[] {
    if (input.hasCompatibleV1FullSource) {
        return input.sourceSampleCount === 0
            ? []
            : [{ startSample: 0, endSample: input.sourceSampleCount }];
    }
    return normalizeSampleRanges(
        input.compatibleV2Records.flatMap(record => record.coreCoverage),
        input.sourceSampleCount,
    );
}

/** Creates an incremental plan whose windows contain only missing core plus bounded context. */
export async function planIncrementalTranscriptionCoverage(input: {
    profile: RangeAcquisitionProfile;
    compatibleCoverage?: readonly HalfOpenSampleRange[];
}): Promise<IncrementalCoveragePlan> {
    const profile = normalizeProfile(input.profile);
    const normalizedCoreCoverage = normalizeSampleRanges(
        profile.coreCoverage,
        profile.sourceSampleCount,
    );
    const reusableCoverage = normalizeSampleRanges(
        input.compatibleCoverage ?? [],
        profile.sourceSampleCount,
    );
    const missingCoreCoverage = subtractSampleRanges(
        normalizedCoreCoverage,
        reusableCoverage,
        profile.sourceSampleCount,
    );
    const acquisitionProfileDigest = await createAcquisitionProfileDigest(profile);
    const acquisitionWindows = await createAcquisitionWindows({
        coreCoverage: missingCoreCoverage,
        contextSamples: profile.contextSamples,
        sourceSampleCount: profile.sourceSampleCount,
        acquisitionProfileDigest,
    });
    return {
        normalizedCoreCoverage,
        reusableCoverage,
        missingCoreCoverage,
        acquisitionProfileDigest,
        acquisitionWindows,
    };
}

/** Request/cache identity for one exact desired union, not for a full source by default. */
export async function createRangeTranscriptionRequestKey(
    profile: RangeAcquisitionProfile,
): Promise<Sha256Digest> {
    const normalized = normalizeProfile(profile);
    return sha256CanonicalJson({
        version: TRANSCRIPTION_COVERAGE_PROFILE_VERSION,
        sourceFingerprint: normalized.sourceFingerprint,
        sourceSampleRate: normalized.sourceSampleRate,
        sourceSampleCount: normalized.sourceSampleCount,
        coreCoverage: normalizeSampleRanges(
            normalized.coreCoverage,
            normalized.sourceSampleCount,
        ),
        contextSamples: normalized.contextSamples,
        language: canonicalLanguage(normalized.language),
        speakerMode: normalized.speakerMode,
        endpointIdentityDigest: normalized.endpointIdentityDigest,
        requestedModel: normalized.requestedModel,
        responseSchema: normalized.responseSchema,
        pcmAlgorithmVersion: normalized.pcmAlgorithmVersion,
        providerProfileVersion: normalized.providerProfileVersion,
        mergeAlgorithmVersion: normalized.mergeAlgorithmVersion,
    });
}

export async function createAcquisitionProfileDigest(
    profile: RangeAcquisitionProfile,
): Promise<Sha256Digest> {
    const normalized = normalizeProfile(profile);
    return sha256CanonicalJson({
        version: TRANSCRIPTION_COVERAGE_PROFILE_VERSION,
        sourceFingerprint: normalized.sourceFingerprint,
        sourceSampleRate: normalized.sourceSampleRate,
        sourceSampleCount: normalized.sourceSampleCount,
        contextSamples: normalized.contextSamples,
        language: canonicalLanguage(normalized.language),
        speakerMode: normalized.speakerMode,
        endpointIdentityDigest: normalized.endpointIdentityDigest,
        requestedModel: normalized.requestedModel,
        responseSchema: normalized.responseSchema,
        pcmAlgorithmVersion: normalized.pcmAlgorithmVersion,
        providerProfileVersion: normalized.providerProfileVersion,
        mergeAlgorithmVersion: normalized.mergeAlgorithmVersion,
    });
}

export async function createTranscriptionCoverageRecordV2(
    body: Omit<CoverageRecordBodyV2, 'version' | 'mergeAlgorithmVersion'> & {
        mergeAlgorithmVersion?: typeof EDITORIAL_TRANSCRIPT_MERGE_ALGORITHM_VERSION;
    },
): Promise<TranscriptionCoverageRecordV2> {
    const canonicalBody: CoverageRecordBodyV2 = {
        ...body,
        version: 2,
        mergeAlgorithmVersion: body.mergeAlgorithmVersion
            ?? EDITORIAL_TRANSCRIPT_MERGE_ALGORITHM_VERSION,
        coreCoverage: normalizeSampleRanges(body.coreCoverage, body.sourceSampleCount),
        acquisitionWindows: normalizeAcquisitionWindows(
            body.acquisitionWindows,
            body.sourceSampleCount,
        ),
    };
    assertCoverageRecordBody(canonicalBody);
    return {
        ...canonicalBody,
        recordId: await sha256CanonicalJson(canonicalBody),
    };
}

export async function verifyTranscriptionCoverageRecordV2(
    record: TranscriptionCoverageRecordV2,
): Promise<void> {
    if (Object.keys(record).length !== COVERAGE_RECORD_KEYS.size
        || Object.keys(record).some(key => !COVERAGE_RECORD_KEYS.has(key))) {
        throw new Error('Transcription coverage record contains unsupported fields.');
    }
    const { recordId, ...body } = record;
    assertCoverageRecordBody(body);
    if (!equalRanges(
        body.coreCoverage,
        normalizeSampleRanges(body.coreCoverage, body.sourceSampleCount),
    )) {
        throw new Error('Transcription coverage must be normalized.');
    }
    const normalizedWindows = normalizeAcquisitionWindows(
        body.acquisitionWindows,
        body.sourceSampleCount,
    );
    if (!equalAcquisitionWindows(normalizedWindows, body.acquisitionWindows)) {
        throw new Error('Transcription acquisition windows are not canonical.');
    }
    if (await sha256CanonicalJson(body) !== recordId) {
        throw new Error('Transcription coverage record hash does not match its canonical body.');
    }
}

async function createAcquisitionWindows(input: {
    coreCoverage: readonly HalfOpenSampleRange[];
    contextSamples: number;
    sourceSampleCount: number;
    acquisitionProfileDigest: Sha256Digest;
}): Promise<TranscriptionAcquisitionWindowV2[]> {
    const maximumWindowSamples = MAX_TRANSCRIPTION_WINDOW_SECONDS * 16_000;
    const maximumCoreSamples = maximumWindowSamples - input.contextSamples * 2;
    if (maximumCoreSamples <= 0) {
        throw new Error('Transcription context leaves no bounded window core.');
    }
    const boundedCores = input.coreCoverage.flatMap((core) => {
        const pieces: HalfOpenSampleRange[] = [];
        for (let startSample = core.startSample; startSample < core.endSample;) {
            const endSample = Math.min(core.endSample, startSample + maximumCoreSamples);
            pieces.push({ startSample, endSample });
            startSample = endSample;
        }
        return pieces;
    });
    const contextual = boundedCores.map(core => ({
        core: { ...core },
        decoded: {
            startSample: Math.max(0, core.startSample - input.contextSamples),
            endSample: Math.min(input.sourceSampleCount, core.endSample + input.contextSamples),
        },
    }));
    // Keep distinct cores separate even when their context overlaps. The persisted V2 schema has
    // one core per window; widening that core to the decoded bounding box would falsely grant
    // ownership to an unused gap. Sequential overlap is intentional merge evidence.
    return Promise.all(contextual.map(async (window) => ({
        windowId: await sha256CanonicalJson({
            acquisitionProfileDigest: input.acquisitionProfileDigest,
            core: window.core,
            decoded: window.decoded,
        }),
        core: window.core,
        decoded: window.decoded,
        chunkRecordIds: [],
    })));
}

function normalizeAcquisitionWindows(
    windows: readonly TranscriptionAcquisitionWindowV2[],
    sourceSampleCount: number,
): TranscriptionAcquisitionWindowV2[] {
    const normalized = windows.map(window => {
        if (Object.keys(window).length !== 4
            || Object.keys(window).some(key => (
                key !== 'windowId'
                && key !== 'core'
                && key !== 'decoded'
                && key !== 'chunkRecordIds'
            ))
            || !isSha(window.windowId)) {
            throw new Error('Transcription window ID is invalid.');
        }
        assertRange(window.core, sourceSampleCount);
        assertRange(window.decoded, sourceSampleCount);
        if (window.decoded.startSample > window.core.startSample
            || window.decoded.endSample < window.core.endSample) {
            throw new Error('Transcription decoded window must contain its core range.');
        }
        if (new Set(window.chunkRecordIds).size !== window.chunkRecordIds.length
            || window.chunkRecordIds.some(recordId => !isSha(recordId))) {
            throw new Error('Transcription window chunk records are invalid.');
        }
        return {
            windowId: window.windowId,
            core: { ...window.core },
            decoded: { ...window.decoded },
            chunkRecordIds: [...window.chunkRecordIds],
        };
    }).sort((left, right) => (
        compareRanges(left.core, right.core)
        || left.windowId.localeCompare(right.windowId)
    ));
    for (let index = 1; index < normalized.length; index += 1) {
        if (normalized[index - 1].core.endSample > normalized[index].core.startSample) {
            throw new Error('Transcription acquisition window cores must not overlap.');
        }
    }
    return normalized;
}

function equalAcquisitionWindows(
    left: readonly TranscriptionAcquisitionWindowV2[],
    right: readonly TranscriptionAcquisitionWindowV2[],
): boolean {
    return left.length === right.length && left.every((window, index) => {
        const candidate = right[index];
        return candidate !== undefined
            && window.windowId === candidate.windowId
            && window.core.startSample === candidate.core.startSample
            && window.core.endSample === candidate.core.endSample
            && window.decoded.startSample === candidate.decoded.startSample
            && window.decoded.endSample === candidate.decoded.endSample
            && window.chunkRecordIds.length === candidate.chunkRecordIds.length
            && window.chunkRecordIds.every((recordId, recordIndex) => (
                recordId === candidate.chunkRecordIds[recordIndex]
            ));
    });
}

function normalizeProfile(profile: RangeAcquisitionProfile): Required<RangeAcquisitionProfile> {
    if (!profile.sourceFingerprint.trim()) throw new Error('Transcription source fingerprint is required.');
    assertSourceSampleCount(profile.sourceSampleCount);
    if (!Number.isSafeInteger(profile.sourceSampleRate) || profile.sourceSampleRate <= 0) {
        throw new Error('Transcription source sample rate is invalid.');
    }
    if (!Number.isSafeInteger(profile.contextSamples) || profile.contextSamples < 0
        || profile.contextSamples > profile.sourceSampleRate * MAX_TRANSCRIPTION_CONTEXT_SECONDS) {
        throw new Error('Transcription context exceeds the supported ten-second maximum.');
    }
    if (profile.speakerMode !== 'none' && profile.speakerMode !== 'diarized') {
        throw new Error('Transcription speaker mode is invalid.');
    }
    if (!isSha(profile.endpointIdentityDigest)) {
        throw new Error('Transcription endpoint identity digest is invalid.');
    }
    if (!profile.requestedModel.trim() || !profile.responseSchema.trim()
        || !Number.isSafeInteger(profile.pcmAlgorithmVersion) || profile.pcmAlgorithmVersion <= 0
        || !Number.isSafeInteger(profile.providerProfileVersion) || profile.providerProfileVersion <= 0) {
        throw new Error('Transcription acquisition profile is invalid.');
    }
    return {
        ...profile,
        mergeAlgorithmVersion: profile.mergeAlgorithmVersion
            ?? EDITORIAL_TRANSCRIPT_MERGE_ALGORITHM_VERSION,
    };
}

function assertCoverageRecordBody(body: CoverageRecordBodyV2): void {
    if (body.version !== 2
        || !body.sourceFingerprint.trim()
        || !isSha(body.acquisitionProfileDigest)
        || !isSha(body.endpointIdentityDigest)
        || !isSha(body.mergedTranscriptRecordId)
        || body.mergeAlgorithmVersion !== EDITORIAL_TRANSCRIPT_MERGE_ALGORITHM_VERSION) {
        throw new Error('Transcription coverage record metadata is invalid.');
    }
    if (!Number.isSafeInteger(body.sourceSampleRate) || body.sourceSampleRate <= 0) {
        throw new Error('Transcription coverage sample rate is invalid.');
    }
    if (!Number.isSafeInteger(body.contextSamples) || body.contextSamples < 0
        || body.contextSamples > body.sourceSampleRate * MAX_TRANSCRIPTION_CONTEXT_SECONDS
        || !body.requestedModel.trim()
        || !body.responseSchema.trim()
        || !Number.isSafeInteger(body.pcmAlgorithmVersion)
        || body.pcmAlgorithmVersion <= 0
        || !Number.isSafeInteger(body.providerProfileVersion)
        || body.providerProfileVersion <= 0) {
        throw new Error('Transcription coverage acquisition profile is invalid.');
    }
    assertSourceSampleCount(body.sourceSampleCount);
    normalizeSampleRanges(body.coreCoverage, body.sourceSampleCount);
    normalizeAcquisitionWindows(body.acquisitionWindows, body.sourceSampleCount);
    if (body.language !== canonicalLanguage(body.language)
        || (body.speakerMode !== 'none' && body.speakerMode !== 'diarized')) {
        throw new Error('Transcription coverage language or speaker mode is invalid.');
    }
}

function canonicalLanguage(language: string | null): string {
    const normalized = language?.trim().toLowerCase() ?? '';
    return normalized || 'auto';
}

function compareRanges(left: HalfOpenSampleRange, right: HalfOpenSampleRange): number {
    return left.startSample - right.startSample || left.endSample - right.endSample;
}

function assertRange(range: HalfOpenSampleRange, sourceSampleCount: number): void {
    if (Object.keys(range).length !== 2
        || Object.keys(range).some(key => key !== 'startSample' && key !== 'endSample')
        || !Number.isSafeInteger(range.startSample)
        || !Number.isSafeInteger(range.endSample)
        || range.startSample < 0
        || range.endSample <= range.startSample
        || range.endSample > sourceSampleCount) {
        throw new Error('Transcription range is not a valid half-open source interval.');
    }
}

function assertSourceSampleCount(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('Transcription source sample count is invalid.');
    }
}

function equalRanges(
    left: readonly HalfOpenSampleRange[],
    right: readonly HalfOpenSampleRange[],
): boolean {
    return left.length === right.length && left.every((range, index) => (
        range.startSample === right[index].startSample
        && range.endSample === right[index].endSample
    ));
}

function isSha(value: unknown): value is Sha256Digest {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
