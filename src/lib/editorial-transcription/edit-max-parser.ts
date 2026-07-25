import type {
    EditorialSpeakerMode,
    EditorialSpeechRegionEvidenceV1,
} from '@/types/editorial';
import {
    createCanonicalEditorialTranscriptRecord,
    type CanonicalEditorialTranscriptRecordV1,
    type UnidentifiedEditorialBoundaryV1,
    type UnidentifiedEditorialSpeakerV1,
    type UnidentifiedEditorialSpeechRegionV1,
    type UnidentifiedEditorialWordV1,
} from './transcript-body';

const SAMPLE_RATE_HZ = 16_000;

export interface ParseEditMaxEditorialTranscriptInput {
    sourceFingerprint: string;
    sampleCount: number;
    language: string | null;
    speakerMode: EditorialSpeakerMode;
}

export class EditMaxEditorialTranscriptError extends Error {
    constructor(public readonly path: string, message: string) {
        // Values are deliberately absent from this error. Provider responses can contain full
        // transcript text, speaker labels or echoed credentials, none of which may enter logs.
        super(`${path}: ${message}`);
        this.name = 'EditMaxEditorialTranscriptError';
    }
}

interface ParsedEditMaxWord {
    text: string;
    alignedStartSample: number;
    alignedEndSample: number;
    probability: number | null;
    speakerLabel: string | null;
}

/**
 * Parses only the frozen qwen edit-max-v1 response contract.
 *
 * A generic OpenAI text/segment response is intentionally not accepted. All validation finishes
 * before canonical bytes or a descriptor can be published, and the function never mutates a
 * project/history surface.
 */
export async function parseEditMaxEditorialTranscript(
    response: unknown,
    submitted: ParseEditMaxEditorialTranscriptInput,
): Promise<CanonicalEditorialTranscriptRecordV1> {
    if (!isRecord(response)) fail('$', 'response must be an object.');
    const topLevelModel = requireNonEmptyString(response.model, '$.model');
    const text = requireString(response.text, '$.text');
    const editing = requireRecord(response.editing, '$.editing');
    if (editing.schema_version !== 1) fail('$.editing.schema_version', 'must equal 1.');
    if (editing.profile !== 'edit-max-v1') fail('$.editing.profile', 'must equal edit-max-v1.');
    if (editing.requested_model !== 'qwen-1.7b-edit-max') {
        fail('$.editing.requested_model', 'must equal qwen-1.7b-edit-max.');
    }
    const editingCanonicalModel = requireNonEmptyString(
        editing.canonical_model,
        '$.editing.canonical_model',
    );
    if (editingCanonicalModel !== topLevelModel) {
        fail('$.editing.canonical_model', 'must equal the top-level canonical model.');
    }

    const timeline = requireRecord(editing.timeline, '$.editing.timeline');
    if (timeline.sample_rate_hz !== SAMPLE_RATE_HZ) {
        fail('$.editing.timeline.sample_rate_hz', 'must equal 16000.');
    }
    if (!Number.isSafeInteger(submitted.sampleCount) || submitted.sampleCount < 0) {
        fail('submitted.sampleCount', 'must be a non-negative safe integer.');
    }
    if (timeline.sample_count !== submitted.sampleCount) {
        fail('$.editing.timeline.sample_count', 'must equal the submitted WAV sample count.');
    }
    if (timeline.time_origin !== 'decoded_audio_start') {
        fail('$.editing.timeline.time_origin', 'must equal decoded_audio_start.');
    }
    const timelineDuration = requireNonNegativeFinite(
        timeline.duration,
        '$.editing.timeline.duration',
    );
    assertSecondsMatchSample(
        timelineDuration,
        submitted.sampleCount,
        '$.editing.timeline.duration',
    );

    if (!Array.isArray(response.words)) fail('$.words', 'must be an array.');
    if (text.trim() && response.words.length === 0) {
        fail('$.words', 'must contain aligned words when response text is non-empty.');
    }
    const speechRegions = parseSpeechRegions(
        editing.speech_regions,
        submitted,
        response.words.length,
    );
    const words = parseWords(response.words, submitted, speechRegions);
    const editBoundaries = parseBoundaries(editing.edit_boundaries, submitted, speechRegions);
    const speakers = parseSpeakers(response.diarization, submitted, words);

    return createCanonicalEditorialTranscriptRecord({
        sourceFingerprint: submitted.sourceFingerprint,
        sampleCount: submitted.sampleCount,
        canonicalModel: topLevelModel,
        language: submitted.language,
        speakerMode: submitted.speakerMode,
        noAudioStream: false,
        words,
        speechRegions,
        editBoundaries,
        speakers,
    });
}

function parseWords(
    value: unknown,
    submitted: ParseEditMaxEditorialTranscriptInput,
    speechRegions: readonly UnidentifiedEditorialSpeechRegionV1[],
): UnidentifiedEditorialWordV1[] {
    if (!Array.isArray(value)) fail('$.words', 'must be an array.');
    const parsedWords: ParsedEditMaxWord[] = [];
    let previousStart = -1;
    let previousEnd = -1;
    for (let index = 0; index < value.length; index += 1) {
        const path = `$.words[${index}]`;
        const word = requireRecord(value[index], path);
        const text = requireNonEmptyString(word.word, `${path}.word`);
        const startSeconds = requireNonNegativeFinite(word.start, `${path}.start`);
        const endSeconds = requireNonNegativeFinite(word.end, `${path}.end`);
        const alignedStartSample = parseAuthoritativeOrDerivedSample(
            word.start_sample,
            startSeconds,
            submitted.sampleCount,
            `${path}.start`,
        );
        const alignedEndSample = parseAuthoritativeOrDerivedSample(
            word.end_sample,
            endSeconds,
            submitted.sampleCount,
            `${path}.end`,
        );
        if (alignedStartSample > alignedEndSample) {
            fail(path, 'word interval end must not precede its start.');
        }
        if (alignedStartSample < previousStart || alignedEndSample < previousEnd) {
            fail(path, 'words must remain in non-decreasing provider order.');
        }
        previousStart = alignedStartSample;
        previousEnd = alignedEndSample;
        const probability = word.probability === undefined || word.probability === null
            ? null
            : requireFinite(word.probability, `${path}.probability`);
        const speakerLabel = submitted.speakerMode === 'diarized'
            ? requireNonEmptyString(word.speaker, `${path}.speaker`)
            : null;
        parsedWords.push({
            text,
            alignedStartSample,
            alignedEndSample,
            probability,
            speakerLabel,
        });
    }

    const words = parsedWords.map((word, index): UnidentifiedEditorialWordV1 => {
        const interval = word.alignedStartSample === word.alignedEndSample
            ? normalizePointAnchoredWord(parsedWords, index, speechRegions)
            : {
                startSample: word.alignedStartSample,
                endSample: word.alignedEndSample,
            };
        return {
            text: word.text,
            alignedStartSample: interval.startSample,
            alignedEndSample: interval.endSample,
            editableStartSample: interval.startSample,
            editableEndSample: interval.endSample,
            probability: word.probability,
            speakerLabel: word.speakerLabel,
        };
    });

    // Non-degenerate provider ranges remain immutable diagnostics. Point-anchors use only the
    // structural one-sample encoding above. Editable ranges alone are then partitioned, at the
    // midpoint of each overlap with half ties moving toward the later sample.
    for (let index = 1; index < words.length; index += 1) {
        const previous = words[index - 1];
        const current = words[index];
        if (previous.editableEndSample <= current.editableStartSample) continue;
        const midpoint = divideRoundTiesLater(
            previous.editableEndSample + current.editableStartSample,
            2,
        );
        if (midpoint <= previous.editableStartSample || midpoint >= current.editableEndSample) {
            fail(`$.words[${index}]`, 'overlap cannot leave at least one editable sample per word.');
        }
        previous.editableEndSample = midpoint;
        current.editableStartSample = midpoint;
    }
    return words;
}

/**
 * Encodes one provider point-anchor as the minimum representable half-open sample interval.
 *
 * This is structural normalization, not an acoustic-duration estimate or a precision upgrade. It
 * is allowed only when one alignment-backed speech region explicitly catalogs the word ordinal
 * and contains the sample immediately to the right. The mandatory region boundaries are validated
 * before the normalized body can be published. Every ambiguous or unsupported point remains a
 * fail-closed parser error.
 */
function normalizePointAnchoredWord(
    words: readonly ParsedEditMaxWord[],
    index: number,
    speechRegions: readonly UnidentifiedEditorialSpeechRegionV1[],
): { startSample: number; endSample: number } {
    const path = `$.words[${index}]`;
    const anchor = words[index].alignedStartSample;
    const owners = speechRegions.filter((region) => (
        region.wordStartIndex !== null
        && region.wordEndIndex !== null
        && region.wordStartIndex <= index
        && index < region.wordEndIndex
    ));
    if (owners.length !== 1) {
        fail(path, 'point-anchor must have one explicit speech-region owner.');
    }
    const owner = owners[0];
    if (owner.evidence === 'acoustic_only') {
        fail(path, 'point-anchor requires alignment-backed speech-region evidence.');
    }
    if (anchor < owner.startSample || anchor >= owner.endSample) {
        fail(path, 'point-anchor must leave one sample inside its owning speech region.');
    }
    const next = words[index + 1];
    if (next?.alignedStartSample === anchor && next.alignedEndSample === anchor) {
        fail(path, 'adjacent point-anchors cannot be partitioned without inventing timing.');
    }
    const endSample = anchor + 1;
    if (next && endSample > next.alignedEndSample) {
        fail(path, 'point-anchor cannot preserve provider word order.');
    }
    if (next?.alignedStartSample === anchor && next.alignedEndSample <= endSample) {
        fail(path, 'point-anchor overlap cannot leave one editable sample per word.');
    }
    return { startSample: anchor, endSample };
}

function parseSpeechRegions(
    value: unknown,
    submitted: ParseEditMaxEditorialTranscriptInput,
    wordCount: number,
): UnidentifiedEditorialSpeechRegionV1[] {
    if (!Array.isArray(value)) fail('$.editing.speech_regions', 'must be an array.');
    const regions: UnidentifiedEditorialSpeechRegionV1[] = [];
    const providerIds = new Set<number>();
    let priorEnd = 0;
    for (let index = 0; index < value.length; index += 1) {
        const path = `$.editing.speech_regions[${index}]`;
        const region = requireRecord(value[index], path);
        const providerRegionId = requireNonNegativeSafeInteger(region.id, `${path}.id`);
        if (providerIds.has(providerRegionId)) fail(`${path}.id`, 'must be unique.');
        providerIds.add(providerRegionId);
        const startSample = requireBoundSample(region.start_sample, submitted.sampleCount, `${path}.start_sample`);
        const endSample = requireBoundSample(region.end_sample, submitted.sampleCount, `${path}.end_sample`);
        if (startSample >= endSample || startSample < priorEnd) {
            fail(path, 'regions must be sorted non-empty half-open intervals.');
        }
        priorEnd = endSample;
        assertSecondsMatchSample(
            requireNonNegativeFinite(region.start, `${path}.start`),
            startSample,
            `${path}.start`,
        );
        assertSecondsMatchSample(
            requireNonNegativeFinite(region.end, `${path}.end`),
            endSample,
            `${path}.end`,
        );
        const [wordStartIndex, wordEndIndex] = parseNullableWordIndexRange(
            region.word_start_index,
            region.word_end_index,
            wordCount,
            path,
        );
        regions.push({
            providerRegionId,
            startSample,
            endSample,
            evidence: requireEvidence(region.evidence, `${path}.evidence`),
            wordStartIndex,
            wordEndIndex,
            vadPeakProbability: requireNullableProbability(
                region.vad_peak_probability,
                `${path}.vad_peak_probability`,
            ),
            vadMeanProbability: requireNullableProbability(
                region.vad_mean_probability,
                `${path}.vad_mean_probability`,
            ),
            startEnergyConfirmed: requireBoolean(
                region.start_energy_confirmed,
                `${path}.start_energy_confirmed`,
            ),
            endEnergyConfirmed: requireBoolean(
                region.end_energy_confirmed,
                `${path}.end_energy_confirmed`,
            ),
        });
    }
    return regions;
}

function parseBoundaries(
    value: unknown,
    submitted: ParseEditMaxEditorialTranscriptInput,
    regions: readonly UnidentifiedEditorialSpeechRegionV1[],
): UnidentifiedEditorialBoundaryV1[] {
    if (!Array.isArray(value)) fail('$.editing.edit_boundaries', 'must be an array.');
    const regionsById = new Map(regions.map(region => [region.providerRegionId, region]));
    const seenEdges = new Set<string>();
    const boundaries: UnidentifiedEditorialBoundaryV1[] = [];
    let priorSample = -1;
    for (let index = 0; index < value.length; index += 1) {
        const path = `$.editing.edit_boundaries[${index}]`;
        const boundary = requireRecord(value[index], path);
        const providerRegionId = requireNonNegativeSafeInteger(
            boundary.region_id,
            `${path}.region_id`,
        );
        const region = regionsById.get(providerRegionId);
        if (!region) fail(`${path}.region_id`, 'must reference a real speech region.');
        const type = boundary.type === 'speech_start' || boundary.type === 'speech_end'
            ? boundary.type
            : fail(`${path}.type`, 'must be speech_start or speech_end.');
        const sample = requireBoundSample(boundary.sample, submitted.sampleCount, `${path}.sample`);
        if (sample < priorSample) fail(path, 'boundaries must be sorted by sample.');
        priorSample = sample;
        const expectedSample = type === 'speech_start' ? region.startSample : region.endSample;
        if (sample !== expectedSample) fail(`${path}.sample`, 'must equal the referenced region edge.');
        assertSecondsMatchSample(
            requireNonNegativeFinite(boundary.time, `${path}.time`),
            sample,
            `${path}.time`,
        );
        const evidence = requireEvidence(boundary.evidence, `${path}.evidence`);
        if (evidence !== region.evidence) {
            fail(`${path}.evidence`, 'must equal the referenced region evidence.');
        }
        const edgeKey = `${providerRegionId}:${type}`;
        if (seenEdges.has(edgeKey)) fail(path, 'region edge boundary must be unique.');
        seenEdges.add(edgeKey);
        const energyConfirmed = requireBoolean(
            boundary.energy_confirmed,
            `${path}.energy_confirmed`,
        );
        const expectedEnergyConfirmed = type === 'speech_start'
            ? region.startEnergyConfirmed
            : region.endEnergyConfirmed;
        if (energyConfirmed !== expectedEnergyConfirmed) {
            fail(
                `${path}.energy_confirmed`,
                'must equal the referenced region edge energy diagnostic.',
            );
        }
        boundaries.push({
            providerRegionId,
            type,
            sample,
            evidence,
            energyConfirmed,
        });
    }
    for (const region of regions) {
        if (!seenEdges.has(`${region.providerRegionId}:speech_start`)
            || !seenEdges.has(`${region.providerRegionId}:speech_end`)) {
            fail('$.editing.edit_boundaries', 'must contain both edges for every speech region.');
        }
    }
    return boundaries;
}

function parseSpeakers(
    value: unknown,
    submitted: ParseEditMaxEditorialTranscriptInput,
    words: readonly UnidentifiedEditorialWordV1[],
): UnidentifiedEditorialSpeakerV1[] {
    if (submitted.speakerMode === 'none') return [];
    const diarization = requireRecord(value, '$.diarization');
    if (!Array.isArray(diarization.speakers)) fail('$.diarization.speakers', 'must be an array.');
    const labels = diarization.speakers.map((label, index) => (
        requireNonEmptyString(label, `$.diarization.speakers[${index}]`)
    ));
    if (new Set(labels).size !== labels.length) fail('$.diarization.speakers', 'must be unique.');
    if (requireNonNegativeSafeInteger(
        diarization.num_speakers,
        '$.diarization.num_speakers',
    ) !== labels.length) {
        fail('$.diarization.num_speakers', 'must match the speaker catalog size.');
    }
    const labelSet = new Set(labels);
    if (words.some(word => word.speakerLabel === null || !labelSet.has(word.speakerLabel))) {
        fail('$.words', 'every diarized word must reference the speaker catalog.');
    }
    if (!Array.isArray(diarization.segments)) fail('$.diarization.segments', 'must be an array.');
    const segmentsByLabel = new Map(labels.map(label => [label, [] as { startSample: number; endSample: number }[]]));
    let priorStart = -1;
    for (let index = 0; index < diarization.segments.length; index += 1) {
        const path = `$.diarization.segments[${index}]`;
        const segment = requireRecord(diarization.segments[index], path);
        const label = requireNonEmptyString(segment.speaker, `${path}.speaker`);
        const target = segmentsByLabel.get(label);
        if (!target) fail(`${path}.speaker`, 'must reference the speaker catalog.');
        const startSample = secondsToNearestSample(
            requireNonNegativeFinite(segment.start, `${path}.start`),
            `${path}.start`,
        );
        const endSample = secondsToNearestSample(
            requireNonNegativeFinite(segment.end, `${path}.end`),
            `${path}.end`,
        );
        if (startSample >= endSample || endSample > submitted.sampleCount || startSample < priorStart) {
            fail(path, 'segments must be sorted non-empty intervals within the submitted duration.');
        }
        priorStart = startSample;
        target.push({ startSample, endSample });
    }
    return labels.map(label => ({ label, segments: segmentsByLabel.get(label) ?? [] }));
}

function parseAuthoritativeOrDerivedSample(
    sampleValue: unknown,
    seconds: number,
    sampleCount: number,
    path: string,
): number {
    const derived = secondsToNearestSample(seconds, path);
    if (derived > sampleCount) fail(path, 'must be within the submitted duration.');
    if (sampleValue === undefined || sampleValue === null) return derived;
    const authoritative = requireBoundSample(sampleValue, sampleCount, `${path}_sample`);
    if (Math.abs(authoritative - derived) > 1) {
        fail(path, 'seconds and integer samples differ by more than one sample.');
    }
    return authoritative;
}

function assertSecondsMatchSample(seconds: number, sample: number, path: string): void {
    if (Math.abs(secondsToNearestSample(seconds, path) - sample) > 1) {
        fail(path, 'seconds and integer samples differ by more than one sample.');
    }
}

export function secondsToNearestSample(seconds: number, path = 'seconds'): number {
    if (!Number.isFinite(seconds) || seconds < 0) fail(path, 'must be non-negative and finite.');
    const scaled = seconds * SAMPLE_RATE_HZ;
    if (!Number.isSafeInteger(Math.floor(scaled))) fail(path, 'exceeds the safe sample range.');
    return Math.floor(scaled + 0.5);
}

function divideRoundTiesLater(numerator: number, denominator: number): number {
    return Math.floor((numerator + denominator / 2) / denominator);
}

function parseNullableWordIndexRange(
    start: unknown,
    end: unknown,
    wordCount: number,
    path: string,
): [number | null, number | null] {
    if (start === null || end === null) {
        if (start !== null || end !== null) fail(path, 'word index bounds must both be null.');
        return [null, null];
    }
    const parsedStart = requireNonNegativeSafeInteger(start, `${path}.word_start_index`);
    const parsedEnd = requireNonNegativeSafeInteger(end, `${path}.word_end_index`);
    if (parsedStart >= parsedEnd || parsedEnd > wordCount) {
        fail(path, 'word index range must be non-empty and within the words array.');
    }
    return [parsedStart, parsedEnd];
}

function requireEvidence(value: unknown, path: string): EditorialSpeechRegionEvidenceV1 {
    if (value === 'alignment_acoustic' || value === 'alignment_only' || value === 'acoustic_only') {
        return value;
    }
    return fail(path, 'contains an unsupported evidence value.');
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
    if (!isRecord(value)) fail(path, 'must be an object.');
    return value;
}

function requireString(value: unknown, path: string): string {
    if (typeof value !== 'string') fail(path, 'must be a string.');
    return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
    const parsed = requireString(value, path);
    if (!parsed.trim()) fail(path, 'must be non-empty.');
    return parsed;
}

function requireFinite(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be finite.');
    return value;
}

function requireNonNegativeFinite(value: unknown, path: string): number {
    const parsed = requireFinite(value, path);
    if (parsed < 0) fail(path, 'must be non-negative.');
    return parsed;
}

function requireNullableFinite(value: unknown, path: string): number | null {
    if (value === null) return null;
    return requireFinite(value, path);
}

function requireNullableProbability(value: unknown, path: string): number | null {
    const parsed = requireNullableFinite(value, path);
    if (parsed !== null && (parsed < 0 || parsed > 1)) {
        fail(path, 'must be a probability between zero and one.');
    }
    return parsed;
}

function requireNonNegativeSafeInteger(value: unknown, path: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        fail(path, 'must be a non-negative safe integer.');
    }
    return value as number;
}

function requireBoundSample(value: unknown, sampleCount: number, path: string): number {
    const sample = requireNonNegativeSafeInteger(value, path);
    if (sample > sampleCount) fail(path, 'must be within the submitted sample count.');
    return sample;
}

function requireBoolean(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') fail(path, 'must be boolean.');
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
    throw new EditMaxEditorialTranscriptError(path, message);
}
