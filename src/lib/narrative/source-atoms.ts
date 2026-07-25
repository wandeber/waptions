import type {
    EditorialEditBoundaryV1,
    EditorialSpeechRegionV1,
    EditorialWordV1,
    NarrativeSilenceEvidenceV1,
    ResolvedEditorialTranscriptMapV1,
    ResolvedEditorialTranscriptRecordBodyV1,
    Sha256Digest,
} from '@/types/editorial';
import {
    intervalsOverlap,
    isValidHalfOpenInterval,
    type HalfOpenInterval,
} from './interval-algebra';

export interface SourceSpeechAtom extends HalfOpenInterval {
    kind: 'speech';
    /** Body order is occurrence order. This array is never sorted or deduplicated. */
    sourceWordIds: string[];
    speakerId: string | null;
}

export interface SourceSilenceAtom extends HalfOpenInterval {
    kind: 'silence';
    evidence: NarrativeSilenceEvidenceV1;
}

export type SourceAtom = SourceSpeechAtom | SourceSilenceAtom;

export interface HydratedSourceRangeLookup {
    range: HalfOpenInterval;
    words: readonly Readonly<EditorialWordV1>[];
    speechRegions: readonly Readonly<EditorialSpeechRegionV1>[];
    editBoundaries: readonly Readonly<EditorialEditBoundaryV1>[];
}

/** Resolves a verified body without ever falling back to acquisition or another record. */
export function requireHydratedTranscriptBody(
    bodies: ResolvedEditorialTranscriptMapV1,
    recordId: Sha256Digest,
): ResolvedEditorialTranscriptRecordBodyV1 {
    const body = bodies[recordId];
    if (!body) throw new Error(`Editorial transcript body "${recordId}" is not hydrated.`);
    return body;
}

/**
 * Looks up source evidence intersecting an exact half-open range.
 *
 * Entity arrays retain immutable body order. The lookup deliberately does not build sets because
 * repeated narrative occurrences are allowed to point at the same source entities independently.
 */
export function lookupHydratedSourceRange(
    body: ResolvedEditorialTranscriptRecordBodyV1,
    range: HalfOpenInterval,
): HydratedSourceRangeLookup {
    assertSourceRange(body, range);
    return {
        range: { ...range },
        words: body.words.filter(word => intervalsOverlap(range, editableWordInterval(word))),
        speechRegions: body.speechRegions.filter(region => intervalsOverlap(range, {
            start: region.startSample,
            end: region.endSample,
        })),
        editBoundaries: body.editBoundaries.filter(boundary => (
            boundary.sample >= range.start && boundary.sample <= range.end
        )),
    };
}

/** Returns only words whose complete editable interval can be represented by the requested core. */
export function lookupContainedSourceWords(
    body: ResolvedEditorialTranscriptRecordBodyV1,
    range: HalfOpenInterval,
): readonly Readonly<EditorialWordV1>[] {
    assertSourceRange(body, range);
    return body.words.filter(word => (
        word.editableStartSample >= range.start && word.editableEndSample <= range.end
    ));
}

export function findSourceWordById(
    body: ResolvedEditorialTranscriptRecordBodyV1,
    wordId: string,
): Readonly<EditorialWordV1> | null {
    return body.words.find(word => word.id === wordId) ?? null;
}

/** Computes the exact editable source range for an ordered inclusive word selection. */
export function getOrderedWordSelectionRange(
    body: ResolvedEditorialTranscriptRecordBodyV1,
    firstWordId: string,
    lastWordId: string,
): HalfOpenInterval | null {
    const firstIndex = body.words.findIndex(word => word.id === firstWordId);
    const lastIndex = body.words.findIndex(word => word.id === lastWordId);
    if (firstIndex < 0 || lastIndex < firstIndex) return null;
    return {
        start: body.words[firstIndex].editableStartSample,
        end: body.words[lastIndex].editableEndSample,
    };
}

/**
 * Partitions a source range into readable speech and explicit source-backed no-word atoms.
 *
 * Partially cropped words are intentionally not retained as speech because a block may reference
 * a word only when its whole editable interval fits inside that block core. Their still-rendered
 * audio remains represented by an untranscribed atom, so activation never drops source coverage.
 */
export function deriveSourceAtoms(
    body: ResolvedEditorialTranscriptRecordBodyV1,
    range: HalfOpenInterval,
    options: { splitOnSpeakerChange?: boolean } = {},
): SourceAtom[] {
    assertSourceRange(body, range);
    const splitOnSpeakerChange = options.splitOnSpeakerChange ?? true;
    const words = lookupContainedSourceWords(body, range);
    const atoms: SourceAtom[] = [];
    let cursor = range.start;
    const appendSilence = (start: number, end: number): void => {
        if (start >= end) return;
        atoms.push({
            kind: 'silence',
            start,
            end,
            evidence: classifyNoWordEvidence(body, { start, end }),
        });
    };

    for (const word of words) {
        if (cursor < word.editableStartSample) appendSilence(cursor, word.editableStartSample);
        const previous = atoms.at(-1);
        const canAppend = previous?.kind === 'speech'
            && previous.end === word.editableStartSample
            && (!splitOnSpeakerChange || previous.speakerId === word.speakerId);
        if (canAppend && previous?.kind === 'speech') {
            previous.end = word.editableEndSample;
            previous.sourceWordIds.push(word.id);
        } else {
            atoms.push({
                kind: 'speech',
                start: word.editableStartSample,
                end: word.editableEndSample,
                sourceWordIds: [word.id],
                speakerId: word.speakerId,
            });
        }
        cursor = word.editableEndSample;
    }
    if (cursor < range.end) appendSilence(cursor, range.end);
    if (atoms.length === 0) appendSilence(range.start, range.end);
    return atoms;
}

/**
 * Classifies source-backed complement without claiming that arbitrary project gaps are silence.
 * Acoustic evidence has priority because any no-word range with confirmed/acoustic provider
 * evidence must be presented as untranscribed audio rather than as quiet.
 */
export function classifyNoWordEvidence(
    body: ResolvedEditorialTranscriptRecordBodyV1,
    range: HalfOpenInterval,
): NarrativeSilenceEvidenceV1 {
    assertSourceRange(body, range);
    if (body.noAudioStream) return 'no-audio';
    const evidence = body.speechRegions
        .filter(region => intervalsOverlap({
            start: region.startSample,
            end: region.endSample,
        }, range))
        .map(region => region.evidence);
    if (evidence.some(value => value === 'alignment_acoustic' || value === 'acoustic_only')) {
        return 'acoustic-only';
    }
    // A cropped word that cannot be retained still proves this range is not known quiet. Keep it
    // as untranscribed/unknown coverage instead of inventing a dangling partial word reference.
    if (body.words.some(word => intervalsOverlap(editableWordInterval(word), range))) return 'unknown';
    if (evidence.includes('alignment_only')) return 'unknown';
    return 'quiet';
}

function editableWordInterval(word: Readonly<EditorialWordV1>): HalfOpenInterval {
    return { start: word.editableStartSample, end: word.editableEndSample };
}

function assertSourceRange(
    body: ResolvedEditorialTranscriptRecordBodyV1,
    range: HalfOpenInterval,
): void {
    if (!isValidHalfOpenInterval(range) || range.end > body.sampleCount) {
        throw new RangeError('Source range must be a non-empty interval within the hydrated body.');
    }
}
