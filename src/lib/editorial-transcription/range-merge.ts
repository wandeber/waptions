import {
    EDITORIAL_TRANSCRIPT_MERGE_ALGORITHM_VERSION,
    type HalfOpenSampleRange,
    type Sha256Digest,
} from '@/types/editorial';

export interface RangeTranscriptSpeakerEvidence {
    /** Provider-local label retained for audit only. */
    providerSpeakerId: string;
    /** Stable acoustic identity emitted by a compatible diarization profile. */
    evidenceKey: string;
}

export interface RangeTranscriptWord {
    text: string;
    startSample: number;
    endSample: number;
    probability: number | null;
    speaker: RangeTranscriptSpeakerEvidence | null;
}

export interface RangeTranscriptChunk {
    recordId: Sha256Digest;
    windowId: Sha256Digest;
    decoded: HalfOpenSampleRange;
    words: readonly RangeTranscriptWord[];
}

export interface MergedRangeTranscriptWord extends RangeTranscriptWord {
    windowId: Sha256Digest;
    tokenIndex: number;
    speakerProvenance: {
        chunkRecordId: Sha256Digest;
        windowId: Sha256Digest;
        providerSpeakerId: string;
        evidenceKey: string;
    } | null;
}

export interface MergedRangeTranscript {
    algorithmVersion: typeof EDITORIAL_TRANSCRIPT_MERGE_ALGORITHM_VERSION;
    words: MergedRangeTranscriptWord[];
}

type MergeCandidate = MergedRangeTranscriptWord & {
    decodedWindow: HalfOpenSampleRange;
};

/**
 * Deterministically merges overlapping provider windows in absolute source coordinates.
 *
 * Exact/near-exact duplicate tokens select evidence farthest from a decoded edge, then the
 * highest confidence, then the lower stable window ID. Non-duplicates remain in canonical order.
 * A duplicate carrying conflicting acoustic speaker evidence fails closed.
 */
export function mergeRangeTranscriptChunks(
    chunks: readonly RangeTranscriptChunk[],
    coreCoverage?: readonly HalfOpenSampleRange[],
): MergedRangeTranscript {
    const candidates = chunks.flatMap((chunk) => validateAndProjectChunk(chunk));
    candidates.sort(compareCanonicalWordOrder);
    const groups: MergeCandidate[][] = [];
    for (const candidate of candidates) {
        const duplicateGroup = findDuplicateGroup(groups, candidate);
        if (!duplicateGroup) {
            groups.push([candidate]);
            continue;
        }
        duplicateGroup.push(candidate);
    }
    const speakerAliases = reconcileOverlapSpeakerEvidence(groups);
    const words = groups.map(group => [...group].sort(compareDuplicateEvidence)[0])
        .sort(compareCanonicalWordOrder)
        .map(({ decodedWindow: ignored, ...word }) => {
            void ignored;
            if (!word.speaker) return word;
            return {
                ...word,
                speaker: {
                    ...word.speaker,
                    evidenceKey: speakerAliases.get(word.speaker.evidenceKey)
                        ?? word.speaker.evidenceKey,
                },
            };
        })
        .filter(word => !coreCoverage || ownsWord(coreCoverage, word));
    assertMonotonicMergedWords(words);
    return {
        algorithmVersion: EDITORIAL_TRANSCRIPT_MERGE_ALGORITHM_VERSION,
        words,
    };
}

function ownsWord(
    coreCoverage: readonly HalfOpenSampleRange[],
    word: MergedRangeTranscriptWord,
): boolean {
    const midpoint = word.startSample + (word.endSample - word.startSample) / 2;
    return coreCoverage.some(range => midpoint >= range.startSample && midpoint < range.endSample);
}

function validateAndProjectChunk(chunk: RangeTranscriptChunk): MergeCandidate[] {
    if (!isSha(chunk.recordId) || !isSha(chunk.windowId)) {
        throw new Error('Range transcript chunk identity is invalid.');
    }
    assertRange(chunk.decoded);
    let previousEnd = chunk.decoded.startSample;
    return chunk.words.map((word, tokenIndex) => {
        if (!word.text.trim()
            || !Number.isSafeInteger(word.startSample)
            || !Number.isSafeInteger(word.endSample)
            || word.startSample < chunk.decoded.startSample
            || word.endSample > chunk.decoded.endSample
            || word.endSample <= word.startSample
            || word.startSample < previousEnd
            || (word.probability !== null
                && (!Number.isFinite(word.probability)
                    || word.probability < 0
                    || word.probability > 1))) {
            throw new Error('Range transcript chunk has contradictory or non-monotonic timing.');
        }
        previousEnd = word.endSample;
        if (word.speaker
            && (!word.speaker.providerSpeakerId.trim() || !word.speaker.evidenceKey.trim())) {
            throw new Error('Range transcript speaker evidence is incomplete.');
        }
        return {
            text: word.text.trim(),
            startSample: word.startSample,
            endSample: word.endSample,
            probability: word.probability,
            speaker: word.speaker ? { ...word.speaker } : null,
            windowId: chunk.windowId,
            tokenIndex,
            decodedWindow: { ...chunk.decoded },
            speakerProvenance: word.speaker ? {
                chunkRecordId: chunk.recordId,
                windowId: chunk.windowId,
                providerSpeakerId: word.speaker.providerSpeakerId,
                evidenceKey: word.speaker.evidenceKey,
            } : null,
        };
    });
}

function findDuplicateGroup(
    groups: readonly MergeCandidate[][],
    candidate: MergeCandidate,
): MergeCandidate[] | undefined {
    const normalized = normalizeToken(candidate.text);
    for (let index = groups.length - 1; index >= 0; index -= 1) {
        const representative = groups[index][0];
        if (representative.endSample < candidate.startSample
            && candidate.startSample - representative.endSample > 1) {
            break;
        }
        if (normalizeToken(representative.text) !== normalized) continue;
        const overlap = Math.min(representative.endSample, candidate.endSample)
            - Math.max(representative.startSample, candidate.startSample);
        const shorter = Math.min(
            representative.endSample - representative.startSample,
            candidate.endSample - candidate.startSample,
        );
        const boundaryDistance = Math.max(
            Math.abs(representative.startSample - candidate.startSample),
            Math.abs(representative.endSample - candidate.endSample),
        );
        // Providers may quantize the same word differently at an overlap seam. Requiring either
        // substantial duration overlap or a one-sample exact-boundary tolerance avoids collapsing
        // genuine repeated words.
        if (overlap > 0 && overlap * 2 >= shorter || boundaryDistance <= 1) return groups[index];
    }
    return undefined;
}

function compareDuplicateEvidence(
    left: MergeCandidate,
    right: MergeCandidate,
): number {
    const edgeDistanceDifference = distanceFromWindowEdge(right) - distanceFromWindowEdge(left);
    if (edgeDistanceDifference !== 0) return edgeDistanceDifference;
    const confidenceDifference = (right.probability ?? -1) - (left.probability ?? -1);
    if (confidenceDifference !== 0) return confidenceDifference;
    return left.windowId.localeCompare(right.windowId) || left.tokenIndex - right.tokenIndex;
}

function distanceFromWindowEdge(word: MergeCandidate): number {
    return Math.min(
        word.startSample - word.decodedWindow.startSample,
        word.decodedWindow.endSample - word.endSample,
    );
}

function compareCanonicalWordOrder(
    left: MergedRangeTranscriptWord,
    right: MergedRangeTranscriptWord,
): number {
    return left.startSample - right.startSample
        || left.endSample - right.endSample
        || left.windowId.localeCompare(right.windowId)
        || left.tokenIndex - right.tokenIndex;
}

function reconcileOverlapSpeakerEvidence(
    groups: readonly MergeCandidate[][],
): Map<string, string> {
    const parent = new Map<string, string>();
    const find = (value: string): string => {
        const current = parent.get(value);
        if (!current) {
            parent.set(value, value);
            return value;
        }
        if (current === value) return value;
        const root = find(current);
        parent.set(value, root);
        return root;
    };
    const union = (left: string, right: string): void => {
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot === rightRoot) return;
        const first = leftRoot.localeCompare(rightRoot) <= 0 ? leftRoot : rightRoot;
        const second = first === leftRoot ? rightRoot : leftRoot;
        parent.set(second, first);
    };
    groups.forEach((group) => {
        const evidence = group.flatMap(word => word.speaker ? [{
            windowId: word.windowId,
            evidenceKey: word.speaker.evidenceKey,
        }] : []);
        if (evidence.length !== 0 && evidence.length !== group.length) {
            throw new Error('Range transcript overlap has incomplete speaker evidence.');
        }
        const byWindow = new Map<string, string>();
        evidence.forEach((value) => {
            const previous = byWindow.get(value.windowId);
            if (previous && previous !== value.evidenceKey) {
                throw new Error('Range transcript overlap has irreconcilable speaker evidence.');
            }
            byWindow.set(value.windowId, value.evidenceKey);
            find(value.evidenceKey);
        });
        for (let index = 1; index < evidence.length; index += 1) {
            union(evidence[0].evidenceKey, evidence[index].evidenceKey);
        }
    });
    const result = new Map<string, string>();
    parent.forEach((_value, key) => result.set(key, find(key)));
    return result;
}

function assertMonotonicMergedWords(words: readonly MergedRangeTranscriptWord[]): void {
    let previousStart = -1;
    for (const word of words) {
        if (word.startSample < previousStart) {
            throw new Error('Merged range transcript is non-monotonic.');
        }
        previousStart = word.startSample;
    }
}

function normalizeToken(value: string): string {
    return value.normalize('NFKC').trim().toLocaleLowerCase('und');
}

function assertRange(range: HalfOpenSampleRange): void {
    if (!Number.isSafeInteger(range.startSample)
        || !Number.isSafeInteger(range.endSample)
        || range.startSample < 0
        || range.endSample <= range.startSample) {
        throw new Error('Range transcript chunk window is invalid.');
    }
}

function isSha(value: unknown): value is Sha256Digest {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
