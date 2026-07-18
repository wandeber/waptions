import {
    getEditorAudioGraphSignature,
    getStableValueSignature,
    getSubtitleTrackSignature,
} from '@/lib/audio-graph-signature';
import type { EditorDocumentV3, TrackTranscriptionProvenanceV3 } from '@/types/video';

export const DIARIZATION_PROVENANCE_EXTENSION_KEY = 'waptions.transcription.diarization';

export interface DiarizationProvenanceExtensionV1 {
    version: 1;
    setId: string;
    targetTrackId: string;
    speakerOrdinal: number;
    sourceSpeakerLabel: string;
    audioScope: 'audible-project-mix';
}

export interface DiarizationTargetSetMemberGuard {
    trackId: string;
    trackSignature: string;
    provenanceSignature: string | null;
    extensionMetadataSignature: string | null;
}

export interface DiarizationJobGuard {
    audioGraphRevision: number;
    audioGraphSignature: string;
    /** Active subtitle track captured at job start; it must still be active at publication time. */
    targetTrackId: string;
    setIdentity: { setId: string; targetTrackId: string } | null;
    memberTrackIdsByOrdinal: string[];
    memberTrackIdsInRelativeDocumentOrder: string[];
    members: DiarizationTargetSetMemberGuard[];
}

export class DiarizationProvenanceCompatibilityError extends Error {
    constructor() {
        super('This subtitle track uses an unsupported diarization provenance version. Update Waptions before replacing it.');
        this.name = 'DiarizationProvenanceCompatibilityError';
    }
}

export type DiarizationExtensionInspection =
    | { kind: 'absent' }
    | { kind: 'v1'; value: DiarizationProvenanceExtensionV1 }
    | { kind: 'unsupported' };

/**
 * Parses only the exact extension version understood by this editor build.
 *
 * The caller must distinguish an absent value from an unrecognized one. Treating both as null
 * would let a rerun overwrite future metadata that an older Waptions version cannot preserve
 * semantically, even though the surrounding JSON object itself is still structurally valid.
 */
export function inspectDiarizationProvenance(
    provenance: TrackTranscriptionProvenanceV3 | null | undefined,
): DiarizationExtensionInspection {
    const extensions = provenance?.extensions;
    if (!extensions || !Object.prototype.hasOwnProperty.call(extensions, DIARIZATION_PROVENANCE_EXTENSION_KEY)) {
        return { kind: 'absent' };
    }

    const value = extensions[DIARIZATION_PROVENANCE_EXTENSION_KEY];
    if (!isPlainObject(value)
        || value.version !== 1
        || !isNonEmptyString(value.setId)
        || !isNonEmptyString(value.targetTrackId)
        || !Number.isSafeInteger(value.speakerOrdinal)
        || (value.speakerOrdinal as number) < 0
        || !isNonEmptyString(value.sourceSpeakerLabel)
        || value.audioScope !== 'audible-project-mix') {
        return { kind: 'unsupported' };
    }

    return {
        kind: 'v1',
        value: {
            version: 1,
            setId: value.setId,
            targetTrackId: value.targetTrackId,
            speakerOrdinal: value.speakerOrdinal as number,
            sourceSpeakerLabel: value.sourceSpeakerLabel,
            audioScope: 'audible-project-mix',
        },
    };
}

/** Returns the recognized v1 metadata without collapsing unsupported values into adoptable state. */
export function getDiarizationProvenanceV1(
    provenance: TrackTranscriptionProvenanceV3 | null | undefined,
): DiarizationProvenanceExtensionV1 | null {
    const inspected = inspectDiarizationProvenance(provenance);
    return inspected.kind === 'v1' ? inspected.value : null;
}

/** Creates one complete v1 value; raw provider labels remain descriptive and are never identity. */
export function createDiarizationProvenanceV1(input: {
    setId: string;
    targetTrackId: string;
    speakerOrdinal: number;
    sourceSpeakerLabel: string;
}): DiarizationProvenanceExtensionV1 {
    if (!isNonEmptyString(input.setId)
        || !isNonEmptyString(input.targetTrackId)
        || !Number.isSafeInteger(input.speakerOrdinal)
        || input.speakerOrdinal < 0
        || !isNonEmptyString(input.sourceSpeakerLabel)) {
        throw new Error('Diarization provenance requires non-empty identities, a speaker label, and a non-negative ordinal.');
    }
    return {
        version: 1,
        setId: input.setId,
        targetTrackId: input.targetTrackId,
        speakerOrdinal: input.speakerOrdinal,
        sourceSpeakerLabel: input.sourceSpeakerLabel,
        audioScope: 'audible-project-mix',
    };
}

/**
 * Captures only the audio graph and selected generated set involved in one asynchronous job.
 * Absolute track indices and the global document revision are deliberately excluded so unrelated
 * subtitle commands can complete while the expensive transcription request is in flight.
 */
export function createDiarizationJobGuard(
    document: EditorDocumentV3,
    targetTrackId: string,
): DiarizationJobGuard | null {
    // A caller may only start a diarization job for the user's active subtitle lane. This makes
    // `targetTrackId` both the generated-set anchor candidate and the explicit active-track guard.
    if (document.activeSubtitleTrackId !== targetTrackId) return null;
    const targetTrack = document.subtitleTracks.find((track) => track.id === targetTrackId);
    if (!targetTrack) return null;

    const targetInspection = inspectDiarizationProvenance(document.transcriptionByTrackId[targetTrackId]);
    if (targetInspection.kind === 'unsupported') {
        throw new DiarizationProvenanceCompatibilityError();
    }

    const setIdentity = targetInspection.kind === 'v1'
        ? { setId: targetInspection.value.setId, targetTrackId: targetInspection.value.targetTrackId }
        : null;
    const relativeTrackIndex = new Map(document.subtitleTracks.map((track, index) => [track.id, index]));
    const memberTrackIdsInRelativeDocumentOrder = setIdentity
        ? document.subtitleTracks
            .filter((track) => extensionMatchesSet(
                getDiarizationProvenanceV1(document.transcriptionByTrackId[track.id]),
                setIdentity,
            ))
            .map((track) => track.id)
        : [targetTrackId];

    // A corrupt historical set can omit the selected member from its own anchored identity. Keep
    // the selected target guarded anyway; application will normalize the retained set atomically.
    if (!memberTrackIdsInRelativeDocumentOrder.includes(targetTrackId)) {
        memberTrackIdsInRelativeDocumentOrder.push(targetTrackId);
    }

    const memberTrackIdsByOrdinal = [...memberTrackIdsInRelativeDocumentOrder].sort((leftId, rightId) => {
        const left = getDiarizationProvenanceV1(document.transcriptionByTrackId[leftId]);
        const right = getDiarizationProvenanceV1(document.transcriptionByTrackId[rightId]);
        const ordinalDifference = (left?.speakerOrdinal ?? Number.MAX_SAFE_INTEGER)
            - (right?.speakerOrdinal ?? Number.MAX_SAFE_INTEGER);
        return ordinalDifference || (relativeTrackIndex.get(leftId) ?? 0) - (relativeTrackIndex.get(rightId) ?? 0);
    });

    return {
        audioGraphRevision: document.audioGraphRevision,
        audioGraphSignature: getEditorAudioGraphSignature(document),
        targetTrackId,
        setIdentity,
        memberTrackIdsByOrdinal,
        memberTrackIdsInRelativeDocumentOrder,
        members: memberTrackIdsByOrdinal.map((trackId) => {
            const track = document.subtitleTracks.find((candidate) => candidate.id === trackId)!;
            const provenance = document.transcriptionByTrackId[trackId] ?? null;
            const extension = getDiarizationProvenanceV1(provenance);
            return {
                trackId,
                trackSignature: getSubtitleTrackSignature(track),
                provenanceSignature: provenance ? getStableValueSignature(provenance) : null,
                extensionMetadataSignature: extension ? getStableValueSignature(extension) : null,
            };
        }),
    };
}

/** Rebuilds the narrow projection and compares it exactly, ignoring every unrelated durable root. */
export function isDiarizationJobGuardCurrent(
    guard: DiarizationJobGuard,
    document: EditorDocumentV3,
): boolean {
    let current: DiarizationJobGuard | null;
    try {
        current = createDiarizationJobGuard(document, guard.targetTrackId);
    } catch (error) {
        if (error instanceof DiarizationProvenanceCompatibilityError) return false;
        throw error;
    }
    return current !== null && getStableValueSignature(current) === getStableValueSignature(guard);
}

function extensionMatchesSet(
    extension: DiarizationProvenanceExtensionV1 | null,
    identity: { setId: string; targetTrackId: string },
): boolean {
    return extension?.setId === identity.setId && extension.targetTrackId === identity.targetTrackId;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}
