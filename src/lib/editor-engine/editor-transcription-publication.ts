import {
    createDiarizationProvenanceV1,
    DIARIZATION_PROVENANCE_EXTENSION_KEY,
    getDiarizationProvenanceV1,
    inspectDiarizationProvenance,
} from '@/lib/diarization-provenance';
import {
    getCanonicalEditorAudioGraphSignature,
    getStableValueSignature,
} from '@/lib/audio-graph-signature';
import { validateEditorManifestV4 } from '@/lib/editor-document-v4';
import { canonicalizeJson } from '@/lib/editorial-transcription/canonical-json';
import {
    assertEditorialDescriptorMatchesBody,
} from '@/lib/editorial-transcription/identity';
import {
    createAcquisitionProfileDigest,
    verifyTranscriptionCoverageRecordV2,
} from '@/lib/editorial-transcription/range-coverage';
import {
    verifyCanonicalEditorialTranscriptRecord,
} from '@/lib/editorial-transcription/transcript-body';
import {
    isSha256Digest,
    type EditorialTranscriptDescriptorV2,
    type EditorialTranscriptRecordBodyV1,
    type Sha256Digest,
    type TranscriptionCoverageRecordV2,
} from '@/types/editorial';
import type { Subtitle, SubtitleTrackV4 } from '@/types/timeline';
import type {
    EditorManifestV4,
    TrackTranscriptionProvenanceV3,
    TrackTranscriptionState,
} from '@/types/video';
import {
    EDITOR_ENGINE_API_VERSION,
    EDITOR_ENGINE_MAX_REQUEST_BYTES,
    EDITORIAL_TRANSCRIPTION_PUBLICATION_TOOL_NAME,
    SUBTITLE_TRANSCRIPTION_PUBLICATION_TOOL_NAME,
    type EditorExpectedRevisions,
} from './editor-command';
import {
    createDescriptorAssetHydration,
    manifestToPlanningDocument,
} from './editor-command-planner';
import { EditorCommandError } from './editor-command-errors';
import type { EditorIdGenerator } from './editor-ports';

const MAX_EDITORIAL_RECORDS = 64;
const MAX_TRANSCRIPT_BODY_BYTES = 32 * 1024 * 1024;
const MAX_COVERAGE_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_WORDS = 250_000;
const MAX_TRANSCRIPT_SPEAKERS = 1_024;
const MAX_COVERAGE_RANGES = 4_096;
const MAX_COVERAGE_WINDOWS = 4_096;
const MAX_COVERAGE_RECORD_REFS = 8_192;
const MAX_SUBTITLE_PUBLICATIONS = 64;
const MAX_DIARIZED_SPEAKERS = 128;
const MAX_SUBTITLE_CUES = 20_000;
const MAX_SUBTITLE_TEXT_BYTES = 384 * 1024;
const MAX_CUE_TEXT_BYTES = 16 * 1024;

export interface EditorTranscriptionSourceAnchor {
    audioGraphSignature: string;
    activeSubtitleTrackId: string | null;
}

export interface EditorialTranscriptionPublicationRequest {
    apiVersion: typeof EDITOR_ENGINE_API_VERSION;
    toolName: typeof EDITORIAL_TRANSCRIPTION_PUBLICATION_TOOL_NAME;
    sessionEpoch: string;
    expected: EditorExpectedRevisions;
    idempotencyKey: string;
    publications: Array<{
        descriptor: EditorialTranscriptDescriptorV2;
        expectedCoverageRecordIds: Sha256Digest[];
    }>;
}

export interface EditorialTranscriptionPublicationHydration {
    records: Array<{
        recordId: Sha256Digest;
        body: EditorialTranscriptRecordBodyV1;
        coverageRecord: TranscriptionCoverageRecordV2;
        currentCoverageRecordIds: Sha256Digest[];
        availableChunkRecordIds: Sha256Digest[];
    }>;
}

export interface SubtitlePublicationTargetAnchor {
    trackId: string;
    trackSignature: string;
    provenanceSignature: string | null;
}

export interface SubtitleTranscriptionPayload {
    subtitles: Subtitle[];
    transcription: TrackTranscriptionState;
}

export interface SubtitleTranscriptionMetadata {
    provider: string;
    model?: string;
    generatedAt: string;
}

export type SubtitleTrackTranscriptionPublication =
    | {
        kind: 'single-track';
        targetTrackId: string;
        targetAnchors: SubtitlePublicationTargetAnchor[];
        payload: SubtitleTranscriptionPayload;
        metadata: SubtitleTranscriptionMetadata;
    }
    | {
        kind: 'diarized';
        targetTrackId: string;
        targetAnchors: SubtitlePublicationTargetAnchor[];
        speakers: Array<SubtitleTranscriptionPayload & {
            speakerOrdinal: number;
            sourceSpeakerLabel: string;
        }>;
        metadata: SubtitleTranscriptionMetadata;
    };

export interface SubtitleTranscriptionPublicationRequest {
    apiVersion: typeof EDITOR_ENGINE_API_VERSION;
    toolName: typeof SUBTITLE_TRANSCRIPTION_PUBLICATION_TOOL_NAME;
    sessionEpoch: string;
    expected: EditorExpectedRevisions;
    idempotencyKey: string;
    sourceAnchor: EditorTranscriptionSourceAnchor;
    publications: SubtitleTrackTranscriptionPublication[];
}

export interface EditorTranscriptRecordPromotionV1 {
    recordId: Sha256Digest;
    body: EditorialTranscriptRecordBodyV1;
    coverageRecord: TranscriptionCoverageRecordV2;
    expectedCoverageRecordIds: Sha256Digest[];
    requiredChunkRecordIds: Sha256Digest[];
}

/**
 * The persistence adapter receives only this transcription-specific terminal intent. It may
 * promote verified immutable records and CAS their coverage families, but cannot perform
 * arbitrary external writes through the editor transaction.
 */
export type EditorTranscriptionPublicationCommitV1 =
    | {
        schemaVersion: 1;
        kind: 'editorial';
        records: EditorTranscriptRecordPromotionV1[];
    }
    | {
        schemaVersion: 1;
        kind: 'subtitle';
        records: [];
    };

export interface PreparedEditorialTranscriptionPublication {
    manifest: EditorManifestV4;
    changed: boolean;
    recordIds: Sha256Digest[];
    coverageRecordIds: Sha256Digest[];
    commit: Extract<EditorTranscriptionPublicationCommitV1, { kind: 'editorial' }>;
    bodies: Record<Sha256Digest, EditorialTranscriptRecordBodyV1>;
}

export interface PreparedSubtitleTranscriptionPublication {
    manifest: EditorManifestV4;
    changed: boolean;
    trackIds: string[];
    commit: Extract<EditorTranscriptionPublicationCommitV1, { kind: 'subtitle' }>;
}

/** Managed persistence adapters use this when the terminal coverage CAS loses its race. */
export class StaleTranscriptionPublicationError extends EditorCommandError {
    constructor(message: string, ids?: string[]) {
        super(
            'STALE_TRANSCRIPTION_PUBLICATION',
            message,
            {
                retryable: true,
                ...(ids ? { details: { ids } } : {}),
            },
        );
        this.name = 'StaleTranscriptionPublicationError';
    }
}

export function parseEditorialTranscriptionPublicationRequest(
    raw: unknown,
): EditorialTranscriptionPublicationRequest {
    assertBoundedRequest(raw, 'Editorial transcription publication');
    const request = requireRecord(raw, 'Editorial transcription publication');
    rejectUnknownKeys(request, new Set([
        'apiVersion',
        'toolName',
        'sessionEpoch',
        'expected',
        'idempotencyKey',
        'publications',
    ]), 'Editorial transcription publication');
    assertPublicationEnvelope(
        request,
        EDITORIAL_TRANSCRIPTION_PUBLICATION_TOOL_NAME,
        'Editorial transcription publication',
    );
    if (!Array.isArray(request.publications)
        || request.publications.length === 0
        || request.publications.length > MAX_EDITORIAL_RECORDS) {
        throw invalidRequest(
            `Editorial transcription publication requires between 1 and ${MAX_EDITORIAL_RECORDS} records.`,
        );
    }
    request.publications.forEach((value, index) => {
        const publication = requireRecord(value, `Editorial publication ${index + 1}`);
        rejectUnknownKeys(
            publication,
            new Set(['descriptor', 'expectedCoverageRecordIds']),
            `Editorial publication ${index + 1}`,
        );
        if (!isRecord(publication.descriptor)
            || publication.descriptor.version !== 2
            || !Array.isArray(publication.expectedCoverageRecordIds)
            || publication.expectedCoverageRecordIds.some((recordId) => !isSha256Digest(recordId))) {
            throw invalidRequest(`Editorial publication ${index + 1} is malformed.`);
        }
        normalizeUniqueDigests(
            publication.expectedCoverageRecordIds as Sha256Digest[],
            `Editorial publication ${index + 1} expected coverage`,
        );
    });
    return structuredClone(request) as unknown as EditorialTranscriptionPublicationRequest;
}

export function parseSubtitleTranscriptionPublicationRequest(
    raw: unknown,
): SubtitleTranscriptionPublicationRequest {
    assertBoundedRequest(raw, 'Subtitle transcription publication');
    const request = requireRecord(raw, 'Subtitle transcription publication');
    rejectUnknownKeys(request, new Set([
        'apiVersion',
        'toolName',
        'sessionEpoch',
        'expected',
        'idempotencyKey',
        'sourceAnchor',
        'publications',
    ]), 'Subtitle transcription publication');
    assertPublicationEnvelope(
        request,
        SUBTITLE_TRANSCRIPTION_PUBLICATION_TOOL_NAME,
        'Subtitle transcription publication',
    );
    const sourceAnchor = requireRecord(request.sourceAnchor, 'Subtitle source anchor');
    rejectUnknownKeys(
        sourceAnchor,
        new Set(['audioGraphSignature', 'activeSubtitleTrackId']),
        'Subtitle source anchor',
    );
    if (!isBoundedString(sourceAnchor.audioGraphSignature)
        || (sourceAnchor.activeSubtitleTrackId !== null
            && !isBoundedString(sourceAnchor.activeSubtitleTrackId))) {
        throw invalidRequest('Subtitle source anchor is invalid.');
    }
    if (!Array.isArray(request.publications)
        || request.publications.length === 0
        || request.publications.length > MAX_SUBTITLE_PUBLICATIONS) {
        throw invalidRequest(
            `Subtitle transcription publication requires between 1 and ${MAX_SUBTITLE_PUBLICATIONS} targets.`,
        );
    }
    let cueCount = 0;
    let textBytes = 0;
    request.publications.forEach((value, index) => {
        const publication = requireRecord(value, `Subtitle publication ${index + 1}`);
        if (publication.kind === 'single-track') {
            rejectUnknownKeys(
                publication,
                new Set(['kind', 'targetTrackId', 'targetAnchors', 'payload', 'metadata']),
                `Subtitle publication ${index + 1}`,
            );
            validateTargetIdentity(publication, index);
            const counted = validateSubtitlePayload(publication.payload, `Subtitle publication ${index + 1}`);
            cueCount += counted.cueCount;
            textBytes += counted.textBytes;
            validateMetadata(publication.metadata, `Subtitle publication ${index + 1}`);
            return;
        }
        if (publication.kind !== 'diarized') {
            throw invalidRequest(`Subtitle publication ${index + 1} has an unsupported kind.`);
        }
        rejectUnknownKeys(
            publication,
            new Set(['kind', 'targetTrackId', 'targetAnchors', 'speakers', 'metadata']),
            `Subtitle publication ${index + 1}`,
        );
        validateTargetIdentity(publication, index);
        if (!Array.isArray(publication.speakers)
            || publication.speakers.length === 0
            || publication.speakers.length > MAX_DIARIZED_SPEAKERS) {
            throw invalidRequest(
                `Diarized publication ${index + 1} requires between 1 and ${MAX_DIARIZED_SPEAKERS} speakers.`,
            );
        }
        const speakers = publication.speakers as unknown[];
        const ordinals = new Set<number>();
        speakers.forEach((value, speakerIndex) => {
            const speaker = requireRecord(
                value,
                `Diarized publication ${index + 1} speaker ${speakerIndex + 1}`,
            );
            rejectUnknownKeys(
                speaker,
                new Set([
                    'speakerOrdinal',
                    'sourceSpeakerLabel',
                    'subtitles',
                    'transcription',
                ]),
                `Diarized publication ${index + 1} speaker ${speakerIndex + 1}`,
            );
            if (!Number.isSafeInteger(speaker.speakerOrdinal)
                || Number(speaker.speakerOrdinal) < 0
                || !isBoundedString(speaker.sourceSpeakerLabel)) {
                throw invalidRequest(`Diarized publication ${index + 1} speaker metadata is invalid.`);
            }
            ordinals.add(Number(speaker.speakerOrdinal));
            const counted = validateSubtitlePayload(
                {
                    subtitles: speaker.subtitles,
                    transcription: speaker.transcription,
                },
                `Diarized publication ${index + 1} speaker ${speakerIndex + 1}`,
            );
            cueCount += counted.cueCount;
            textBytes += counted.textBytes;
        });
        if (ordinals.size !== speakers.length
            || Array.from(ordinals).some((ordinal) => ordinal >= speakers.length)) {
            throw invalidRequest(
                `Diarized publication ${index + 1} speaker ordinals must be contiguous and unique.`,
            );
        }
        validateMetadata(publication.metadata, `Diarized publication ${index + 1}`);
    });
    if (cueCount > MAX_SUBTITLE_CUES || textBytes > MAX_SUBTITLE_TEXT_BYTES) {
        throw new EditorCommandError(
            'PAYLOAD_TOO_LARGE',
            'Subtitle transcription publication exceeds its cue or text budget.',
        );
    }
    return structuredClone(request) as unknown as SubtitleTranscriptionPublicationRequest;
}

export async function prepareEditorialTranscriptionPublication(input: {
    current: EditorManifestV4;
    request: EditorialTranscriptionPublicationRequest;
    hydration: EditorialTranscriptionPublicationHydration;
}): Promise<PreparedEditorialTranscriptionPublication> {
    if (!input.hydration || !Array.isArray(input.hydration.records)) {
        throw invalidRequest('Editorial publication requires verified transcript hydration.');
    }
    if (input.hydration.records.length !== input.request.publications.length) {
        throw invalidRequest('Editorial transcript hydration must match the complete publication set.');
    }
    const hydrationByRecordId = new Map(input.hydration.records.map((record) => [
        record.recordId,
        record,
    ]));
    if (hydrationByRecordId.size !== input.hydration.records.length) {
        throw invalidRequest('Editorial transcript hydration contains duplicate record identities.');
    }
    const sourceById = new Map(input.current.videoSourceDescriptors.map((source) => [
        source.id,
        source,
    ]));
    const familyKeys = new Set<string>();
    const recordIds = new Set<Sha256Digest>();
    const coverageRecordIds = new Set<Sha256Digest>();
    const bodies: Record<Sha256Digest, EditorialTranscriptRecordBodyV1> = {} as Record<
        Sha256Digest,
        EditorialTranscriptRecordBodyV1
    >;
    const promotions: EditorTranscriptRecordPromotionV1[] = [];
    let aggregateBodyBytes = 0;
    let aggregateCoverageBytes = 0;
    let aggregateWords = 0;
    let aggregateSpeakers = 0;
    let aggregateCoverageRefs = 0;

    for (const publication of input.request.publications) {
        const descriptor = publication.descriptor;
        if (recordIds.has(descriptor.recordId)
            || coverageRecordIds.has(descriptor.coverageRecordId)) {
            throw invalidRequest('Editorial publication record identities must be unique.');
        }
        recordIds.add(descriptor.recordId);
        coverageRecordIds.add(descriptor.coverageRecordId);
        const familyKey = `${descriptor.sourceFingerprint}\u0000${descriptor.acquisitionProfileDigest}`;
        if (familyKeys.has(familyKey)) {
            throw invalidRequest('Editorial publication contains more than one record for a coverage family.');
        }
        familyKeys.add(familyKey);

        const source = sourceById.get(descriptor.sourceId);
        if (!source
            || source.fingerprint !== descriptor.sourceFingerprint
            || (source.hasAudio ? 'provider' : 'local-no-audio') !== descriptor.acquisition) {
            throw stalePublication(
                'The editorial transcription source changed before publication.',
                [descriptor.sourceId],
            );
        }
        const hydrated = hydrationByRecordId.get(descriptor.recordId);
        if (!hydrated
            || hydrated.coverageRecord.recordId !== descriptor.coverageRecordId
            || hydrated.coverageRecord.mergedTranscriptRecordId !== descriptor.recordId
            || hydrated.coverageRecord.sourceFingerprint !== descriptor.sourceFingerprint
            || hydrated.coverageRecord.acquisitionProfileDigest
                !== descriptor.acquisitionProfileDigest) {
            throw new EditorCommandError(
                'SOURCE_CHANGED',
                'Editorial transcript hydration does not match its immutable descriptor identities.',
                { details: { ids: [descriptor.recordId, descriptor.coverageRecordId] } },
            );
        }
        if (!isRecord(hydrated.body)
            || !Array.isArray(hydrated.body.words)
            || !Array.isArray(hydrated.body.speakers)
            || !Array.isArray(hydrated.coverageRecord.coreCoverage)
            || !Array.isArray(hydrated.coverageRecord.acquisitionWindows)) {
            throw new EditorCommandError(
                'SOURCE_CHANGED',
                'Editorial transcript hydration has a malformed body or coverage record.',
                { details: { ids: [descriptor.recordId, descriptor.coverageRecordId] } },
            );
        }
        aggregateBodyBytes += encodedBytes(hydrated.body);
        aggregateCoverageBytes += encodedBytes(hydrated.coverageRecord);
        aggregateWords += hydrated.body.words.length;
        aggregateSpeakers += hydrated.body.speakers.length;
        if (aggregateBodyBytes > MAX_TRANSCRIPT_BODY_BYTES
            || aggregateCoverageBytes > MAX_COVERAGE_BYTES
            || aggregateWords > MAX_TRANSCRIPT_WORDS
            || aggregateSpeakers > MAX_TRANSCRIPT_SPEAKERS
            || hydrated.coverageRecord.coreCoverage.length > MAX_COVERAGE_RANGES
            || hydrated.coverageRecord.acquisitionWindows.length > MAX_COVERAGE_WINDOWS) {
            throw new EditorCommandError(
                'PAYLOAD_TOO_LARGE',
                'Editorial transcript publication exceeds its body, range, or speaker budget.',
            );
        }
        const expectedCoverage = normalizeUniqueDigests(
            publication.expectedCoverageRecordIds,
            'Editorial expected coverage',
        );
        const currentCoverage = normalizeUniqueDigests(
            hydrated.currentCoverageRecordIds,
            'Editorial current coverage',
        );
        if (canonicalizeJson(expectedCoverage) !== canonicalizeJson(currentCoverage)) {
            throw stalePublication(
                'The editorial transcription coverage head changed before publication.',
                [descriptor.sourceId],
            );
        }

        let verified;
        try {
            verified = await verifyCanonicalEditorialTranscriptRecord(
                hydrated.body,
                descriptor.recordId,
            );
            await verifyTranscriptionCoverageRecordV2(hydrated.coverageRecord);
            assertEditorialDescriptorMatchesBody(descriptor, verified.body);
            await assertCoverageMatchesDescriptor(
                hydrated.coverageRecord,
                descriptor,
                verified.body,
            );
        } catch (error) {
            throw new EditorCommandError(
                'SOURCE_CHANGED',
                'Editorial transcript body or coverage identity verification failed.',
                {
                    details: { ids: [descriptor.recordId, descriptor.coverageRecordId] },
                    cause: error,
                },
            );
        }
        const requiredChunkRecordIds = normalizeUniqueDigests(
            hydrated.coverageRecord.acquisitionWindows.flatMap((window) => window.chunkRecordIds),
            'Editorial coverage chunks',
        );
        const availableChunkRecordIds = new Set(normalizeUniqueDigests(
            hydrated.availableChunkRecordIds,
            'Editorial available chunks',
        ));
        if (requiredChunkRecordIds.some((recordId) => !availableChunkRecordIds.has(recordId))) {
            throw new EditorCommandError(
                'SOURCE_CHANGED',
                'Editorial coverage references a chunk that was not verified for publication.',
                { details: { ids: [descriptor.coverageRecordId] } },
            );
        }
        aggregateCoverageRefs += hydrated.coverageRecord.coreCoverage.length
            + hydrated.coverageRecord.acquisitionWindows.length
            + requiredChunkRecordIds.length
            + currentCoverage.length;
        bodies[descriptor.recordId] = structuredClone(verified.body);
        promotions.push({
            recordId: descriptor.recordId,
            body: structuredClone(verified.body),
            coverageRecord: structuredClone(hydrated.coverageRecord),
            expectedCoverageRecordIds: expectedCoverage,
            requiredChunkRecordIds,
        });
    }
    if (aggregateCoverageRefs > MAX_COVERAGE_RECORD_REFS) {
        throw new EditorCommandError(
            'PAYLOAD_TOO_LARGE',
            'Editorial transcript publication exceeds its body or record-reference budget.',
        );
    }

    const candidate = structuredClone(input.current);
    for (const publication of input.request.publications) {
        const descriptor = publication.descriptor;
        candidate.editorialTranscriptDescriptors = candidate.editorialTranscriptDescriptors.filter(
            (existing) => !(existing.version === 2
                && existing.sourceId === descriptor.sourceId
                && existing.acquisitionProfileDigest === descriptor.acquisitionProfileDigest),
        );
        candidate.editorialTranscriptDescriptors.push(structuredClone(descriptor));
    }
    candidate.editorialTranscriptDescriptors.sort(compareEditorialDescriptors);
    const changed = !sameManifestSemantics(candidate, input.current);
    if (changed) candidate.revision = input.current.revision + 1;
    assertValidCandidate(candidate);
    return {
        manifest: candidate,
        changed,
        recordIds: Array.from(recordIds).sort(),
        coverageRecordIds: Array.from(coverageRecordIds).sort(),
        commit: {
            schemaVersion: 1,
            kind: 'editorial',
            records: promotions.sort((left, right) => left.recordId.localeCompare(right.recordId)),
        },
        bodies,
    };
}

export function prepareSubtitleTranscriptionPublication(input: {
    current: EditorManifestV4;
    request: SubtitleTranscriptionPublicationRequest;
    commandScope: string;
    ids: EditorIdGenerator;
}): PreparedSubtitleTranscriptionPublication {
    const currentAudioGraphSignature = getCanonicalEditorAudioGraphSignature(
        manifestToPlanningDocument(
            input.current,
            createDescriptorAssetHydration(input.current),
        ),
    );
    if (input.request.sourceAnchor.audioGraphSignature !== currentAudioGraphSignature
        || input.request.sourceAnchor.activeSubtitleTrackId
            !== input.current.activeSubtitleTrackId) {
        throw stalePublication('The subtitle transcription source anchor changed.');
    }

    const contexts = preflightSubtitlePublications(input.current, input.request.publications);
    const candidate = structuredClone(input.current);
    const publishedTrackIds: string[] = [];
    const provisionalRevision = input.current.revision;
    contexts.forEach((context, publicationIndex) => {
        if (context.publication.kind === 'single-track') {
            const publication = context.publication;
            const track = candidate.subtitleTracks.find((value) => value.id === publication.targetTrackId)!;
            track.subtitles = structuredClone(publication.payload.subtitles);
            candidate.transcriptionByTrackId[track.id] = createTrackProvenance({
                current: candidate.transcriptionByTrackId[track.id],
                payload: publication.payload.transcription,
                metadata: publication.metadata,
                documentRevision: provisionalRevision,
                audioGraphRevision: candidate.audioGraphRevision,
                audioGraphSignature: currentAudioGraphSignature,
            });
            publishedTrackIds.push(track.id);
            return;
        }

        const publication = context.publication;
        const speakers = [...publication.speakers].sort(
            (left, right) => left.speakerOrdinal - right.speakerOrdinal,
        );
        const existingMembers = [...context.memberTracks].sort((left, right) => {
            const leftOrdinal = getDiarizationProvenanceV1(
                candidate.transcriptionByTrackId[left.id],
            )?.speakerOrdinal ?? (left.id === publication.targetTrackId ? 0 : Number.MAX_SAFE_INTEGER);
            const rightOrdinal = getDiarizationProvenanceV1(
                candidate.transcriptionByTrackId[right.id],
            )?.speakerOrdinal ?? (right.id === publication.targetTrackId ? 0 : Number.MAX_SAFE_INTEGER);
            return leftOrdinal - rightOrdinal
                || candidate.subtitleTracks.findIndex((track) => track.id === left.id)
                    - candidate.subtitleTracks.findIndex((track) => track.id === right.id);
        });
        const target = existingMembers.find((track) => track.id === publication.targetTrackId)!;
        const reusableSiblings = existingMembers
            .filter((track) => track.id !== publication.targetTrackId)
            .slice(0, Math.max(0, speakers.length - 1));
        const surplusSiblings = existingMembers
            .filter((track) => track.id !== publication.targetTrackId)
            .slice(Math.max(0, speakers.length - 1));
        const memberTracks: SubtitleTrackV4[] = [target, ...reusableSiblings];
        while (memberTracks.length < speakers.length) {
            const ordinal = memberTracks.length;
            const id = input.ids.generate(
                'track',
                `${input.commandScope}:subtitle-publication:${publicationIndex}:speaker:${ordinal}`,
            );
            if (candidate.subtitleTracks.some((track) => track.id === id)) {
                throw new EditorCommandError(
                    'INVALID_OPERATION',
                    'Deterministic diarization track identity collided with an existing track.',
                    { details: { ids: [id] } },
                );
            }
            memberTracks.push({
                ...structuredClone(target),
                id,
                name: `Speaker ${ordinal + 1}`,
                subtitles: [],
                isLocked: false,
            });
        }
        const existingSet = getDiarizationProvenanceV1(
            candidate.transcriptionByTrackId[publication.targetTrackId],
        );
        const setId = existingSet?.setId ?? input.ids.generate(
            'diarization-set',
            `${input.commandScope}:subtitle-publication:${publicationIndex}:set`,
        );
        const previousMemberIds = new Set(existingMembers.map((track) => track.id));
        const unrelated = candidate.subtitleTracks.filter((track) => !previousMemberIds.has(track.id));
        const targetIndex = candidate.subtitleTracks.findIndex(
            (track) => track.id === publication.targetTrackId,
        );
        const insertionIndex = candidate.subtitleTracks
            .slice(0, targetIndex)
            .filter((track) => !previousMemberIds.has(track.id))
            .length;
        const regenerated = memberTracks.map((track, ordinal) => ({
            ...track,
            subtitles: structuredClone(speakers[ordinal].subtitles),
        }));
        candidate.subtitleTracks = [
            ...unrelated.slice(0, insertionIndex),
            ...regenerated,
            ...unrelated.slice(insertionIndex),
        ];
        surplusSiblings.forEach((track) => delete candidate.transcriptionByTrackId[track.id]);
        regenerated.forEach((track, ordinal) => {
            const existing = candidate.transcriptionByTrackId[track.id];
            candidate.transcriptionByTrackId[track.id] = createTrackProvenance({
                current: existing,
                payload: speakers[ordinal].transcription,
                metadata: publication.metadata,
                documentRevision: provisionalRevision,
                audioGraphRevision: candidate.audioGraphRevision,
                audioGraphSignature: currentAudioGraphSignature,
                diarization: {
                    setId,
                    targetTrackId: publication.targetTrackId,
                    speakerOrdinal: ordinal,
                    sourceSpeakerLabel: speakers[ordinal].sourceSpeakerLabel,
                },
            });
            publishedTrackIds.push(track.id);
        });
    });

    const changed = !sameManifestSemantics(candidate, input.current);
    if (changed) {
        candidate.revision = input.current.revision + 1;
        for (const trackId of publishedTrackIds) {
            candidate.transcriptionByTrackId[trackId].sourceDocumentRevision = candidate.revision;
        }
    }
    assertValidCandidate(candidate);
    return {
        manifest: candidate,
        changed,
        trackIds: Array.from(new Set(publishedTrackIds)),
        commit: {
            schemaVersion: 1,
            kind: 'subtitle',
            records: [],
        },
    };
}

function preflightSubtitlePublications(
    current: EditorManifestV4,
    publications: readonly SubtitleTrackTranscriptionPublication[],
): Array<{
    publication: SubtitleTrackTranscriptionPublication;
    memberTracks: SubtitleTrackV4[];
}> {
    const claimedTrackIds = new Set<string>();
    return publications.map((publication) => {
        const target = current.subtitleTracks.find((track) => track.id === publication.targetTrackId);
        if (!target) {
            throw stalePublication(
                'A subtitle publication target no longer exists.',
                [publication.targetTrackId],
            );
        }
        const inspection = inspectDiarizationProvenance(
            current.transcriptionByTrackId[publication.targetTrackId],
        );
        if (inspection.kind === 'unsupported') {
            throw new EditorCommandError(
                'INVALID_OPERATION',
                'The subtitle target uses unsupported diarization provenance.',
                { details: { ids: [publication.targetTrackId] } },
            );
        }
        if (publication.kind === 'single-track' && inspection.kind === 'v1') {
            throw new EditorCommandError(
                'INVALID_OPERATION',
                'A diarized subtitle set must be replaced through a diarized publication.',
                { details: { ids: [publication.targetTrackId] } },
            );
        }
        const memberTracks = publication.kind === 'diarized' && inspection.kind === 'v1'
            ? current.subtitleTracks.filter((track) => {
                const extension = getDiarizationProvenanceV1(
                    current.transcriptionByTrackId[track.id],
                );
                return extension?.setId === inspection.value.setId
                    && extension.targetTrackId === inspection.value.targetTrackId;
            })
            : [target];
        if (!memberTracks.some((track) => track.id === target.id)) memberTracks.push(target);
        assertExactTargetAnchors(current, memberTracks, publication.targetAnchors);
        memberTracks.forEach((track) => {
            if (claimedTrackIds.has(track.id)) {
                throw invalidRequest('Subtitle publication targets overlap within one atomic request.');
            }
            claimedTrackIds.add(track.id);
            if (track.isLocked) {
                throw new EditorCommandError(
                    'LOCKED_TARGET',
                    'A subtitle publication target is locked.',
                    { details: { ids: [track.id] } },
                );
            }
        });
        return { publication, memberTracks };
    });
}

function assertExactTargetAnchors(
    current: EditorManifestV4,
    tracks: readonly SubtitleTrackV4[],
    anchors: readonly SubtitlePublicationTargetAnchor[],
): void {
    const expected = [...anchors].sort((left, right) => left.trackId.localeCompare(right.trackId));
    const actual = tracks.map((track) => {
        const provenance = current.transcriptionByTrackId[track.id];
        return {
            trackId: track.id,
            trackSignature: getStableValueSignature(track),
            provenanceSignature: provenance ? getStableValueSignature(provenance) : null,
        };
    }).sort((left, right) => left.trackId.localeCompare(right.trackId));
    if (canonicalizeJson(expected) !== canonicalizeJson(actual)) {
        throw stalePublication(
            'A subtitle publication target changed before publication.',
            tracks.map((track) => track.id),
        );
    }
}

function createTrackProvenance(input: {
    current: TrackTranscriptionProvenanceV3 | undefined;
    payload: TrackTranscriptionState;
    metadata: SubtitleTranscriptionMetadata;
    documentRevision: number;
    audioGraphRevision: number;
    audioGraphSignature: string;
    diarization?: {
        setId: string;
        targetTrackId: string;
        speakerOrdinal: number;
        sourceSpeakerLabel: string;
    };
}): TrackTranscriptionProvenanceV3 {
    const extensions = {
        ...(input.current?.extensions ?? {}),
        ...(input.diarization
            ? {
                [DIARIZATION_PROVENANCE_EXTENSION_KEY]: createDiarizationProvenanceV1(
                    input.diarization,
                ),
            }
            : {}),
    };
    return {
        raw: structuredClone(input.payload.raw),
        groups: structuredClone(input.payload.groups),
        containerIds: [...input.payload.containerIds],
        provider: input.metadata.provider,
        ...(input.metadata.model === undefined ? {} : { model: input.metadata.model }),
        generatedAt: input.metadata.generatedAt,
        sourceDocumentRevision: input.documentRevision,
        sourceAudioGraphRevision: input.audioGraphRevision,
        sourceAudioGraphSignature: input.audioGraphSignature,
        stale: false,
        ...(Object.keys(extensions).length === 0 ? {} : { extensions }),
    };
}

function validateTargetIdentity(
    publication: Record<string, unknown>,
    index: number,
): void {
    if (!isBoundedString(publication.targetTrackId)
        || !Array.isArray(publication.targetAnchors)
        || publication.targetAnchors.length === 0
        || publication.targetAnchors.length > MAX_DIARIZED_SPEAKERS) {
        throw invalidRequest(`Subtitle publication ${index + 1} target identity is invalid.`);
    }
    const trackIds = new Set<string>();
    publication.targetAnchors.forEach((value, anchorIndex) => {
        const anchor = requireRecord(
            value,
            `Subtitle publication ${index + 1} target anchor ${anchorIndex + 1}`,
        );
        rejectUnknownKeys(
            anchor,
            new Set(['trackId', 'trackSignature', 'provenanceSignature']),
            `Subtitle publication ${index + 1} target anchor ${anchorIndex + 1}`,
        );
        if (!isBoundedString(anchor.trackId)
            || !isBoundedString(anchor.trackSignature)
            || (anchor.provenanceSignature !== null
                && !isBoundedString(anchor.provenanceSignature))) {
            throw invalidRequest(`Subtitle publication ${index + 1} target anchor is invalid.`);
        }
        trackIds.add(anchor.trackId);
    });
    if (trackIds.size !== publication.targetAnchors.length
        || !trackIds.has(publication.targetTrackId as string)) {
        throw invalidRequest(`Subtitle publication ${index + 1} target anchors are incomplete.`);
    }
}

function validateSubtitlePayload(
    value: unknown,
    label: string,
): { cueCount: number; textBytes: number } {
    const payload = requireRecord(value, label);
    rejectUnknownKeys(payload, new Set(['subtitles', 'transcription']), label);
    if (!Array.isArray(payload.subtitles)) {
        throw invalidRequest(`${label} subtitles are invalid.`);
    }
    const transcription = requireRecord(payload.transcription, `${label} transcription`);
    rejectUnknownKeys(
        transcription,
        new Set(['raw', 'groups', 'containerIds']),
        `${label} transcription`,
    );
    if (!Array.isArray(transcription.raw)
        || !isRecord(transcription.groups)
        || !Array.isArray(transcription.containerIds)
        || transcription.containerIds.some((id) => !isBoundedString(id))
        || new Set(transcription.containerIds).size !== transcription.containerIds.length) {
        throw invalidRequest(`${label} transcription provenance is invalid.`);
    }
    let cueCount = 0;
    let textBytes = 0;
    const countCues = (cues: unknown[], cueLabel: string): void => {
        const ids = new Set<string>();
        cues.forEach((cue, index) => {
            const measured = validateSubtitle(cue, `${cueLabel} cue ${index + 1}`);
            if (ids.has(measured.id)) throw invalidRequest(`${cueLabel} cue IDs must be unique.`);
            ids.add(measured.id);
            cueCount += 1;
            textBytes += measured.textBytes;
        });
    };
    countCues(payload.subtitles, `${label} subtitles`);
    countCues(transcription.raw, `${label} raw transcription`);
    const groupKeys = Object.keys(transcription.groups);
    if (groupKeys.length > MAX_SUBTITLE_CUES
        || groupKeys.some((key) => !isBoundedString(key))) {
        throw invalidRequest(`${label} transcription groups are invalid.`);
    }
    const groups = transcription.groups as Record<string, unknown>;
    groupKeys.forEach((key) => {
        const cues = groups[key];
        if (!Array.isArray(cues)) throw invalidRequest(`${label} transcription group is invalid.`);
        countCues(cues, `${label} group ${key}`);
    });
    return { cueCount, textBytes };
}

function validateSubtitle(
    value: unknown,
    label: string,
): { id: string; textBytes: number } {
    const subtitle = requireRecord(value, label);
    rejectUnknownKeys(subtitle, new Set(['id', 'startTime', 'endTime', 'text']), label);
    const textBytes = typeof subtitle.text === 'string' ? encodedBytes(subtitle.text) : -1;
    if (!isBoundedString(subtitle.id)
        || typeof subtitle.startTime !== 'number'
        || !Number.isFinite(subtitle.startTime)
        || subtitle.startTime < 0
        || typeof subtitle.endTime !== 'number'
        || !Number.isFinite(subtitle.endTime)
        || subtitle.endTime <= subtitle.startTime
        || typeof subtitle.text !== 'string'
        || !subtitle.text.trim()
        || textBytes > MAX_CUE_TEXT_BYTES) {
        throw invalidRequest(`${label} is invalid.`);
    }
    return { id: subtitle.id, textBytes };
}

function validateMetadata(value: unknown, label: string): void {
    const metadata = requireRecord(value, `${label} metadata`);
    rejectUnknownKeys(metadata, new Set(['provider', 'model', 'generatedAt']), `${label} metadata`);
    if (!isBoundedString(metadata.provider)
        || (metadata.model !== undefined && !isBoundedString(metadata.model))
        || !isBoundedString(metadata.generatedAt)
        || Number.isNaN(Date.parse(metadata.generatedAt as string))) {
        throw invalidRequest(`${label} metadata is invalid.`);
    }
}

function assertPublicationEnvelope(
    request: Record<string, unknown>,
    toolName: string,
    label: string,
): void {
    if (request.apiVersion !== EDITOR_ENGINE_API_VERSION) {
        throw new EditorCommandError('UNSUPPORTED_API_VERSION', 'Unsupported editor engine API version.');
    }
    if (request.toolName !== toolName
        || !isBoundedString(request.sessionEpoch)
        || !isBoundedString(request.idempotencyKey)) {
        throw invalidRequest(`${label} envelope is invalid.`);
    }
    const expected = requireRecord(request.expected, `${label} expected revisions`);
    rejectUnknownKeys(
        expected,
        new Set([
            'sessionRevision',
            'documentRevision',
            'audioGraphRevision',
            'narrativeRevision',
        ]),
        `${label} expected revisions`,
    );
    if (!isRevision(expected.sessionRevision)
        || !isRevision(expected.documentRevision)
        || !isRevision(expected.audioGraphRevision)
        || (expected.narrativeRevision !== undefined && !isRevision(expected.narrativeRevision))) {
        throw invalidRequest(`${label} revision guards are invalid.`);
    }
}

function assertBoundedRequest(value: unknown, label: string): void {
    let bytes: number;
    try {
        bytes = encodedBytes(value);
    } catch (error) {
        throw new EditorCommandError('INVALID_REQUEST', `${label} is not serializable.`, { cause: error });
    }
    if (bytes > EDITOR_ENGINE_MAX_REQUEST_BYTES) {
        throw new EditorCommandError('PAYLOAD_TOO_LARGE', `${label} exceeds 512 KiB.`);
    }
}

function assertValidCandidate(candidate: EditorManifestV4): void {
    const validation = validateEditorManifestV4(candidate);
    if (!validation.valid) {
        throw new EditorCommandError(
            'INVALID_DOCUMENT',
            'Transcription publication produced an invalid V4 manifest.',
            { details: { issues: validation.issues.slice(0, 50) } },
        );
    }
}

function sameManifestSemantics(left: EditorManifestV4, right: EditorManifestV4): boolean {
    const normalizedLeft = structuredClone(left);
    const normalizedRight = structuredClone(right);
    normalizedLeft.revision = normalizedRight.revision;
    normalizedLeft.audioGraphRevision = normalizedRight.audioGraphRevision;
    if (normalizedLeft.narrative && normalizedRight.narrative) {
        normalizedLeft.narrative.revision = normalizedRight.narrative.revision;
    }
    return canonicalizeJson(normalizedLeft) === canonicalizeJson(normalizedRight);
}

function compareEditorialDescriptors(
    left: EditorManifestV4['editorialTranscriptDescriptors'][number],
    right: EditorManifestV4['editorialTranscriptDescriptors'][number],
): number {
    return left.sourceId.localeCompare(right.sourceId)
        || left.requestKey.localeCompare(right.requestKey)
        || left.recordId.localeCompare(right.recordId);
}

async function assertCoverageMatchesDescriptor(
    coverage: TranscriptionCoverageRecordV2,
    descriptor: EditorialTranscriptDescriptorV2,
    body: EditorialTranscriptRecordBodyV1,
): Promise<void> {
    const acquisitionProfileDigest = await createAcquisitionProfileDigest({
        sourceFingerprint: coverage.sourceFingerprint,
        sourceSampleRate: coverage.sourceSampleRate,
        sourceSampleCount: coverage.sourceSampleCount,
        coreCoverage: coverage.coreCoverage,
        contextSamples: coverage.contextSamples,
        language: coverage.language,
        speakerMode: coverage.speakerMode,
        endpointIdentityDigest: coverage.endpointIdentityDigest,
        requestedModel: coverage.requestedModel,
        responseSchema: coverage.responseSchema,
        pcmAlgorithmVersion: coverage.pcmAlgorithmVersion,
        providerProfileVersion: coverage.providerProfileVersion,
        mergeAlgorithmVersion: coverage.mergeAlgorithmVersion,
    });
    if (coverage.mergedTranscriptRecordId !== descriptor.recordId
        || coverage.sourceFingerprint !== descriptor.sourceFingerprint
        || coverage.sourceSampleRate !== descriptor.sampleRateHz
        || coverage.sourceSampleCount !== descriptor.sampleCount
        || coverage.acquisitionProfileDigest !== acquisitionProfileDigest
        || coverage.acquisitionProfileDigest !== descriptor.acquisitionProfileDigest
        || coverage.endpointIdentityDigest !== descriptor.endpointIdentityDigest
        || coverage.requestedModel !== descriptor.requestedModel
        || coverage.responseSchema !== descriptor.responseSchema
        || coverage.pcmAlgorithmVersion !== descriptor.pcmAlgorithmVersion
        || coverage.language !== (descriptor.language ?? 'auto')
        || coverage.speakerMode !== descriptor.speakerMode
        || coverage.mergeAlgorithmVersion !== descriptor.mergeAlgorithmVersion
        || coverage.sourceSampleRate !== body.sampleRateHz
        || coverage.sourceSampleCount !== body.sampleCount
        || coverage.language !== (body.language ?? 'auto')
        || coverage.speakerMode !== body.speakerMode) {
        throw new Error(
            'Editorial transcript coverage does not match its descriptor and immutable body.',
        );
    }
}

function normalizeUniqueDigests(
    values: readonly Sha256Digest[],
    label: string,
): Sha256Digest[] {
    if (!Array.isArray(values)
        || values.length > MAX_COVERAGE_RECORD_REFS
        || values.some((value) => !isSha256Digest(value))) {
        throw invalidRequest(`${label} record identities are invalid.`);
    }
    const normalized = [...values].sort();
    if (new Set(normalized).size !== normalized.length) {
        throw invalidRequest(`${label} record identities must be unique.`);
    }
    return normalized;
}

function stalePublication(message: string, ids?: string[]): EditorCommandError {
    return new StaleTranscriptionPublicationError(message, ids);
}

function invalidRequest(message: string): EditorCommandError {
    return new EditorCommandError('INVALID_REQUEST', message);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!isRecord(value)) throw invalidRequest(`${label} must be an object.`);
    return value;
}

function rejectUnknownKeys(
    value: Record<string, unknown>,
    allowed: ReadonlySet<string>,
    label: string,
): void {
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown) throw invalidRequest(`${label} contains unsupported field "${unknown}".`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

function isRevision(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

function encodedBytes(value: unknown): number {
    return new TextEncoder().encode(
        typeof value === 'string' ? value : JSON.stringify(value),
    ).byteLength;
}
