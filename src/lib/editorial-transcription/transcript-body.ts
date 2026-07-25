import {
    EDITORIAL_CANONICAL_JSON_VERSION,
    EDITORIAL_TRANSCRIPT_PCM_ALGORITHM_VERSION,
    EDITORIAL_TRANSCRIPT_RECORD_BODY_VERSION,
    EDITORIAL_TRANSCRIPT_REQUESTED_MODEL,
    EDITORIAL_TRANSCRIPT_RESPONSE_SCHEMA,
    EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ,
    isSha256Digest,
    type EditorialEditBoundaryTypeV1,
    type EditorialEditBoundaryV1,
    type EditorialSpeakerMode,
    type EditorialSpeakerSegmentV1,
    type EditorialSpeakerV1,
    type EditorialSpeechRegionEvidenceV1,
    type EditorialSpeechRegionV1,
    type EditorialTranscriptRecordBodyV1,
    type EditorialWordV1,
    type Sha256Digest,
} from '@/types/editorial';
import {
    canonicalizeJson,
    canonicalizeJsonBytes,
    sha256CanonicalJson,
    sha256Bytes,
} from './canonical-json';

export interface UnidentifiedEditorialWordV1 {
    text: string;
    alignedStartSample: number;
    alignedEndSample: number;
    editableStartSample: number;
    editableEndSample: number;
    probability: number | null;
    speakerLabel: string | null;
}

export interface UnidentifiedEditorialSpeechRegionV1 {
    providerRegionId: number;
    startSample: number;
    endSample: number;
    evidence: EditorialSpeechRegionEvidenceV1;
    wordStartIndex: number | null;
    wordEndIndex: number | null;
    vadPeakProbability: number | null;
    vadMeanProbability: number | null;
    startEnergyConfirmed: boolean;
    endEnergyConfirmed: boolean;
}

export interface UnidentifiedEditorialBoundaryV1 {
    providerRegionId: number;
    type: EditorialEditBoundaryTypeV1;
    sample: number;
    evidence: EditorialSpeechRegionEvidenceV1;
    energyConfirmed: boolean;
}

export interface UnidentifiedEditorialSpeakerV1 {
    label: string;
    segments: EditorialSpeakerSegmentV1[];
}

export interface EditorialTranscriptBodyInputV1 {
    sourceFingerprint: string;
    sampleCount: number;
    canonicalModel: string;
    language: string | null;
    speakerMode: EditorialSpeakerMode;
    noAudioStream: boolean;
    words: UnidentifiedEditorialWordV1[];
    speechRegions: UnidentifiedEditorialSpeechRegionV1[];
    editBoundaries: UnidentifiedEditorialBoundaryV1[];
    speakers: UnidentifiedEditorialSpeakerV1[];
}

export interface CanonicalEditorialTranscriptRecordV1 {
    body: EditorialTranscriptRecordBodyV1;
    canonicalJson: string;
    canonicalBytes: Uint8Array;
    recordId: Sha256Digest;
}

type BodyWithoutStableIds = Omit<EditorialTranscriptRecordBodyV1,
    'contentNamespace' | 'words' | 'speechRegions' | 'editBoundaries' | 'speakers'> & {
    words: UnidentifiedEditorialWordV1[];
    speechRegions: UnidentifiedEditorialSpeechRegionV1[];
    editBoundaries: UnidentifiedEditorialBoundaryV1[];
    speakers: UnidentifiedEditorialSpeakerV1[];
};

export async function createCanonicalEditorialTranscriptRecord(
    input: EditorialTranscriptBodyInputV1,
): Promise<CanonicalEditorialTranscriptRecordV1> {
    assertTranscriptBodyInput(input);
    const withoutIds = createBodyWithoutStableIds(input);
    const contentNamespace = await sha256CanonicalJson(withoutIds);
    const speakerIdsByLabel = new Map<string, string>();
    const speakers: EditorialSpeakerV1[] = [];
    for (let ordinal = 0; ordinal < input.speakers.length; ordinal += 1) {
        const speaker = input.speakers[ordinal];
        const firstSample = speaker.segments[0]?.startSample ?? 0;
        const lastSample = speaker.segments.at(-1)?.endSample ?? 0;
        const id = await deriveEntityId(contentNamespace, 'speaker', ordinal, firstSample, lastSample);
        speakerIdsByLabel.set(speaker.label, id);
        speakers.push({ id, label: speaker.label, segments: speaker.segments.map(segment => ({ ...segment })) });
    }

    const words: EditorialWordV1[] = [];
    for (let ordinal = 0; ordinal < input.words.length; ordinal += 1) {
        const word = input.words[ordinal];
        words.push({
            id: await deriveEntityId(
                contentNamespace,
                'word',
                ordinal,
                word.alignedStartSample,
                word.alignedEndSample,
            ),
            text: word.text,
            alignedStartSample: word.alignedStartSample,
            alignedEndSample: word.alignedEndSample,
            editableStartSample: word.editableStartSample,
            editableEndSample: word.editableEndSample,
            probability: word.probability,
            speakerId: word.speakerLabel === null
                ? null
                : speakerIdsByLabel.get(word.speakerLabel) ?? null,
        });
    }

    const regionIdsByProviderId = new Map<number, string>();
    const speechRegions: EditorialSpeechRegionV1[] = [];
    for (let ordinal = 0; ordinal < input.speechRegions.length; ordinal += 1) {
        const region = input.speechRegions[ordinal];
        const id = await deriveEntityId(
            contentNamespace,
            'region',
            ordinal,
            region.startSample,
            region.endSample,
        );
        regionIdsByProviderId.set(region.providerRegionId, id);
        speechRegions.push({ id, ...region });
    }

    const editBoundaries: EditorialEditBoundaryV1[] = [];
    for (let ordinal = 0; ordinal < input.editBoundaries.length; ordinal += 1) {
        const boundary = input.editBoundaries[ordinal];
        const regionId = regionIdsByProviderId.get(boundary.providerRegionId);
        if (!regionId) {
            throw new Error('Editorial boundary references an unknown provider region.');
        }
        editBoundaries.push({
            id: await deriveEntityId(
                contentNamespace,
                'boundary',
                ordinal,
                boundary.sample,
                boundary.sample,
            ),
            regionId,
            type: boundary.type,
            sample: boundary.sample,
            evidence: boundary.evidence,
            energyConfirmed: boundary.energyConfirmed,
        });
    }

    const body: EditorialTranscriptRecordBodyV1 = {
        version: EDITORIAL_TRANSCRIPT_RECORD_BODY_VERSION,
        canonicalJsonVersion: EDITORIAL_CANONICAL_JSON_VERSION,
        contentNamespace,
        sourceFingerprint: input.sourceFingerprint,
        pcmAlgorithmVersion: EDITORIAL_TRANSCRIPT_PCM_ALGORITHM_VERSION,
        sampleRateHz: EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ,
        sampleCount: input.sampleCount,
        timeOrigin: 'decoded_audio_start',
        requestedModel: EDITORIAL_TRANSCRIPT_REQUESTED_MODEL,
        canonicalModel: input.canonicalModel,
        profile: EDITORIAL_TRANSCRIPT_RESPONSE_SCHEMA,
        language: input.language,
        speakerMode: input.speakerMode,
        noAudioStream: input.noAudioStream,
        words,
        speechRegions,
        editBoundaries,
        speakers,
    };
    assertEditorialTranscriptRecordBodyShape(body);
    const canonicalJson = canonicalizeJson(body);
    const canonicalBytes = canonicalizeJsonBytes(body);
    const recordId = await sha256Bytes(canonicalBytes);
    return { body, canonicalJson, canonicalBytes, recordId };
}

/**
 * Verifies both layers of the immutable body identity. The preliminary namespace is rebuilt from
 * the payload without stable entity IDs, then every ID is derived again before the final record
 * hash is checked. This prevents a valid outer SHA from blessing dangling or attacker-selected
 * entity IDs in an imported sidecar or manually edited IndexedDB record.
 */
export async function verifyCanonicalEditorialTranscriptRecord(
    value: unknown,
    expectedRecordId?: Sha256Digest,
): Promise<CanonicalEditorialTranscriptRecordV1> {
    assertEditorialTranscriptRecordBodyShape(value);
    const body = value;
    const input = bodyToUnidentifiedInput(body);
    const rebuilt = await createCanonicalEditorialTranscriptRecord(input);
    if (canonicalizeJson(rebuilt.body) !== canonicalizeJson(body)) {
        throw new Error('Editorial transcript stable entity IDs or content namespace are invalid.');
    }
    if (expectedRecordId && rebuilt.recordId !== expectedRecordId) {
        throw new Error('Editorial transcript record hash does not match its record ID.');
    }
    return rebuilt;
}

export async function createLocalNoAudioTranscriptRecord(input: {
    sourceFingerprint: string;
    sampleCount: number;
    language: string | null;
    speakerMode: EditorialSpeakerMode;
}): Promise<CanonicalEditorialTranscriptRecordV1> {
    return createCanonicalEditorialTranscriptRecord({
        sourceFingerprint: input.sourceFingerprint,
        sampleCount: input.sampleCount,
        canonicalModel: 'local-no-audio',
        language: input.language,
        speakerMode: input.speakerMode,
        noAudioStream: true,
        words: [],
        speechRegions: [],
        editBoundaries: [],
        speakers: [],
    });
}

async function deriveEntityId(
    contentNamespace: Sha256Digest,
    kind: 'word' | 'region' | 'boundary' | 'speaker',
    ordinal: number,
    startSample: number,
    endSample: number,
): Promise<string> {
    return sha256CanonicalJson([
        contentNamespace,
        kind,
        ordinal,
        startSample,
        endSample,
    ]);
}

function createBodyWithoutStableIds(input: EditorialTranscriptBodyInputV1): BodyWithoutStableIds {
    return {
        version: EDITORIAL_TRANSCRIPT_RECORD_BODY_VERSION,
        canonicalJsonVersion: EDITORIAL_CANONICAL_JSON_VERSION,
        sourceFingerprint: input.sourceFingerprint,
        pcmAlgorithmVersion: EDITORIAL_TRANSCRIPT_PCM_ALGORITHM_VERSION,
        sampleRateHz: EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ,
        sampleCount: input.sampleCount,
        timeOrigin: 'decoded_audio_start',
        requestedModel: EDITORIAL_TRANSCRIPT_REQUESTED_MODEL,
        canonicalModel: input.canonicalModel,
        profile: EDITORIAL_TRANSCRIPT_RESPONSE_SCHEMA,
        language: input.language,
        speakerMode: input.speakerMode,
        noAudioStream: input.noAudioStream,
        words: input.words.map(word => ({ ...word })),
        speechRegions: input.speechRegions.map(region => ({ ...region })),
        editBoundaries: input.editBoundaries.map(boundary => ({ ...boundary })),
        speakers: input.speakers.map(speaker => ({
            label: speaker.label,
            segments: speaker.segments.map(segment => ({ ...segment })),
        })),
    };
}

function bodyToUnidentifiedInput(body: EditorialTranscriptRecordBodyV1): EditorialTranscriptBodyInputV1 {
    const speakersById = new Map(body.speakers.map(speaker => [speaker.id, speaker]));
    const regionsById = new Map(body.speechRegions.map(region => [region.id, region]));
    return {
        sourceFingerprint: body.sourceFingerprint,
        sampleCount: body.sampleCount,
        canonicalModel: body.canonicalModel,
        language: body.language,
        speakerMode: body.speakerMode,
        noAudioStream: body.noAudioStream,
        words: body.words.map(word => ({
            text: word.text,
            alignedStartSample: word.alignedStartSample,
            alignedEndSample: word.alignedEndSample,
            editableStartSample: word.editableStartSample,
            editableEndSample: word.editableEndSample,
            probability: word.probability,
            speakerLabel: word.speakerId === null
                ? null
                : speakersById.get(word.speakerId)?.label ?? null,
        })),
        speechRegions: body.speechRegions.map(region => ({
            providerRegionId: region.providerRegionId,
            startSample: region.startSample,
            endSample: region.endSample,
            evidence: region.evidence,
            wordStartIndex: region.wordStartIndex,
            wordEndIndex: region.wordEndIndex,
            vadPeakProbability: region.vadPeakProbability,
            vadMeanProbability: region.vadMeanProbability,
            startEnergyConfirmed: region.startEnergyConfirmed,
            endEnergyConfirmed: region.endEnergyConfirmed,
        })),
        editBoundaries: body.editBoundaries.map(boundary => ({
            providerRegionId: regionsById.get(boundary.regionId)?.providerRegionId ?? -1,
            type: boundary.type,
            sample: boundary.sample,
            evidence: boundary.evidence,
            energyConfirmed: boundary.energyConfirmed,
        })),
        speakers: body.speakers.map(speaker => ({
            label: speaker.label,
            segments: speaker.segments.map(segment => ({ ...segment })),
        })),
    };
}

function assertTranscriptBodyInput(input: EditorialTranscriptBodyInputV1): void {
    if (!input.sourceFingerprint.trim()) throw new Error('Editorial source fingerprint is required.');
    if (!isBound(input.sampleCount) || input.sampleCount < 0) {
        throw new Error('Editorial sample count must be a non-negative safe integer.');
    }
    if (!input.canonicalModel.trim()) throw new Error('Editorial canonical model is required.');
    if (input.speakerMode === 'none' && input.speakers.length > 0) {
        throw new Error('Non-diarized editorial records cannot contain a speaker catalog.');
    }
    const labels = new Set(input.speakers.map(speaker => speaker.label));
    if (labels.size !== input.speakers.length || Array.from(labels).some(label => !label.trim())) {
        throw new Error('Editorial speaker labels must be non-empty and unique.');
    }
    if (input.speakerMode === 'diarized' && input.words.some(word => (
        word.speakerLabel === null || !labels.has(word.speakerLabel)
    ))) {
        throw new Error('Every diarized editorial word must reference a known speaker.');
    }
    if (input.noAudioStream && (
        input.words.length > 0
        || input.speechRegions.length > 0
        || input.editBoundaries.length > 0
        || input.speakers.length > 0
    )) {
        throw new Error('A no-audio editorial record cannot contain transcript evidence.');
    }
}

export function assertEditorialTranscriptRecordBodyShape(
    value: unknown,
): asserts value is EditorialTranscriptRecordBodyV1 {
    if (!isRecord(value)) throw new Error('Editorial transcript body must be an object.');
    if (
        value.version !== 1
        || value.canonicalJsonVersion !== 1
        || !isSha256Digest(value.contentNamespace)
        || typeof value.sourceFingerprint !== 'string'
        || !value.sourceFingerprint.trim()
        || value.pcmAlgorithmVersion !== 1
        || value.sampleRateHz !== 16_000
        || !isBound(value.sampleCount)
        || value.timeOrigin !== 'decoded_audio_start'
        || value.requestedModel !== 'qwen-1.7b-edit-max'
        || typeof value.canonicalModel !== 'string'
        || !value.canonicalModel.trim()
        || value.profile !== 'edit-max-v1'
        || (value.language !== null && typeof value.language !== 'string')
        || (value.speakerMode !== 'none' && value.speakerMode !== 'diarized')
        || typeof value.noAudioStream !== 'boolean'
        || !Array.isArray(value.words)
        || !Array.isArray(value.speechRegions)
        || !Array.isArray(value.editBoundaries)
        || !Array.isArray(value.speakers)
    ) {
        throw new Error('Editorial transcript body metadata is invalid.');
    }

    const speakerIds = new Set<string>();
    for (const speaker of value.speakers) {
        if (!isRecord(speaker) || typeof speaker.id !== 'string' || !speaker.id.trim()
            || typeof speaker.label !== 'string' || !speaker.label.trim()
            || !Array.isArray(speaker.segments) || speakerIds.has(speaker.id)) {
            throw new Error('Editorial speaker catalog is invalid.');
        }
        speakerIds.add(speaker.id);
        let priorEnd = 0;
        for (const segment of speaker.segments) {
            if (!isRecord(segment) || !isInterval(segment.startSample, segment.endSample, value.sampleCount)
                || (segment.startSample as number) < priorEnd) {
                throw new Error('Editorial speaker segment is invalid.');
            }
            priorEnd = segment.endSample as number;
        }
    }
    if (value.speakerMode === 'none' && value.speakers.length !== 0) {
        throw new Error('Non-diarized editorial body contains speakers.');
    }

    let priorWordStart = -1;
    let priorEditableEnd = 0;
    const wordIds = new Set<string>();
    for (const word of value.words) {
        if (!isRecord(word) || typeof word.id !== 'string' || !word.id.trim() || wordIds.has(word.id)
            || typeof word.text !== 'string' || !word.text.trim()
            || !isInterval(word.alignedStartSample, word.alignedEndSample, value.sampleCount)
            || !isInterval(word.editableStartSample, word.editableEndSample, value.sampleCount)
            || (word.editableStartSample as number) < (word.alignedStartSample as number)
            || (word.editableEndSample as number) > (word.alignedEndSample as number)
            || (word.editableStartSample as number) < priorEditableEnd
            || (word.probability !== null && !isFiniteNumber(word.probability))
            || (word.speakerId !== null && (typeof word.speakerId !== 'string' || !speakerIds.has(word.speakerId)))
            || (word.alignedStartSample as number) < priorWordStart) {
            throw new Error('Editorial word is invalid.');
        }
        if (value.speakerMode === 'diarized' && word.speakerId === null) {
            throw new Error('Diarized editorial word is missing a speaker.');
        }
        wordIds.add(word.id);
        priorWordStart = word.alignedStartSample as number;
        priorEditableEnd = word.editableEndSample as number;
    }

    const regionIds = new Set<string>();
    const providerRegionIds = new Set<number>();
    let priorRegionEnd = 0;
    for (const region of value.speechRegions) {
        if (!isRecord(region) || typeof region.id !== 'string' || !region.id.trim() || regionIds.has(region.id)
            || !isBound(region.providerRegionId) || providerRegionIds.has(region.providerRegionId)
            || !isInterval(region.startSample, region.endSample, value.sampleCount)
            || (region.startSample as number) < priorRegionEnd
            || !isEvidence(region.evidence)
            || !isNullableWordIndexRange(region.wordStartIndex, region.wordEndIndex, value.words.length)
            || !isNullableFinite(region.vadPeakProbability)
            || !isNullableFinite(region.vadMeanProbability)
            || typeof region.startEnergyConfirmed !== 'boolean'
            || typeof region.endEnergyConfirmed !== 'boolean') {
            throw new Error('Editorial speech region is invalid.');
        }
        regionIds.add(region.id);
        providerRegionIds.add(region.providerRegionId);
        priorRegionEnd = region.endSample as number;
    }

    const boundaryIds = new Set<string>();
    const regionEdges = new Set<string>();
    let priorBoundarySample = -1;
    for (const boundary of value.editBoundaries) {
        if (!isRecord(boundary) || typeof boundary.id !== 'string' || !boundary.id.trim()
            || boundaryIds.has(boundary.id) || typeof boundary.regionId !== 'string'
            || !regionIds.has(boundary.regionId)
            || (boundary.type !== 'speech_start' && boundary.type !== 'speech_end')
            || !isBound(boundary.sample) || boundary.sample > value.sampleCount
            || boundary.sample < priorBoundarySample || !isEvidence(boundary.evidence)
            || typeof boundary.energyConfirmed !== 'boolean') {
            throw new Error('Editorial edit boundary is invalid.');
        }
        boundaryIds.add(boundary.id);
        priorBoundarySample = boundary.sample;
        const region = value.speechRegions.find(candidate => candidate.id === boundary.regionId);
        const expectedSample = boundary.type === 'speech_start' ? region?.startSample : region?.endSample;
        const expectedEnergy = boundary.type === 'speech_start'
            ? region?.startEnergyConfirmed
            : region?.endEnergyConfirmed;
        if (expectedSample !== boundary.sample
            || region?.evidence !== boundary.evidence
            || expectedEnergy !== boundary.energyConfirmed) {
            throw new Error('Editorial edit boundary does not match its speech region.');
        }
        const edge = `${boundary.regionId}:${boundary.type}`;
        if (regionEdges.has(edge)) {
            throw new Error('Editorial edit boundary duplicates a speech-region edge.');
        }
        regionEdges.add(edge);
    }
    for (const region of value.speechRegions) {
        if (!regionEdges.has(`${region.id}:speech_start`)
            || !regionEdges.has(`${region.id}:speech_end`)) {
            throw new Error('Editorial speech region is missing a required edit boundary.');
        }
    }
    if (value.noAudioStream && (
        value.words.length > 0
        || value.speechRegions.length > 0
        || value.editBoundaries.length > 0
        || value.speakers.length > 0
    )) {
        throw new Error('No-audio editorial body contains transcript evidence.');
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBound(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFinite(value: unknown): value is number | null {
    return value === null || isFiniteNumber(value);
}

function isInterval(start: unknown, end: unknown, sampleCount: number): boolean {
    return isBound(start) && isBound(end) && start < end && end <= sampleCount;
}

function isEvidence(value: unknown): value is EditorialSpeechRegionEvidenceV1 {
    return value === 'alignment_acoustic' || value === 'alignment_only' || value === 'acoustic_only';
}

function isNullableWordIndexRange(start: unknown, end: unknown, wordCount: number): boolean {
    if (start === null || end === null) return start === null && end === null;
    return isBound(start) && isBound(end) && start < end && end <= wordCount;
}
