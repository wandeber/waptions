import type { SubtitleTrack } from '@/types/timeline';
import type {
    EditorDocumentV3,
    EditorDocumentV4,
    TrackTranscriptionProvenanceV3,
    TranscriptionJobGuard,
} from '@/types/video';
import { getEditorAudioGraphSignature } from './editor-document-v3';
import { getEditorAudioGraphSignatureV4 } from './editor-document-v4';

export { getEditorAudioGraphSignature } from './editor-document-v3';
export { getEditorAudioGraphSignatureV4 } from './editor-document-v4';

export type AudioGraphMutationImpact = 'invalidate-transcription' | 'preserve-transcription';

type AudioGraphDocument =
    | Pick<
        EditorDocumentV3,
        | 'version'
        | 'renderProfile'
        | 'videoSources'
        | 'videoClips'
        | 'audioSources'
        | 'audioTracks'
        | 'audioGraphRevision'
        | 'transcriptionByTrackId'
    >
    | Pick<
        EditorDocumentV4,
        | 'version'
        | 'renderProfile'
        | 'videoSources'
        | 'videoClips'
        | 'audioSources'
        | 'audioTracks'
        | 'audioGraphRevision'
        | 'transcriptionByTrackId'
    >;

type AudioGraphGuardDocument =
    | Pick<
        EditorDocumentV3,
        'version' | 'revision' | 'audioGraphRevision' | 'renderProfile' | 'videoSources' | 'videoClips' | 'audioSources' | 'audioTracks'
    >
    | Pick<
        EditorDocumentV4,
        'version' | 'revision' | 'audioGraphRevision' | 'renderProfile' | 'videoSources' | 'videoClips' | 'audioSources' | 'audioTracks'
    >;

export interface FinalizedAudioGraphMutation {
    audioGraphRevision: number;
    transcriptionByTrackId: Record<string, TrackTranscriptionProvenanceV3>;
}

/**
 * Finalizes provenance after a real durable media mutation.
 *
 * The editor-document module owns the one canonical audible-graph serialization. This helper
 * deliberately delegates both old and candidate serialization to it. The impact argument remains
 * useful as history metadata, but it cannot force or suppress invalidation: only a canonical
 * signature change advances the graph revision and marks generated transcription stale.
 */
export function finalizeAudioGraphMutation(
    previousDocument: AudioGraphDocument,
    nextDocument: AudioGraphDocument,
    impact: AudioGraphMutationImpact,
): FinalizedAudioGraphMutation {
    void impact;
    const previousSignature = getCanonicalEditorAudioGraphSignature(previousDocument);
    const nextSignature = getCanonicalEditorAudioGraphSignature(nextDocument);
    if (previousSignature !== nextSignature) {
        return {
            audioGraphRevision: previousDocument.audioGraphRevision + 1,
            transcriptionByTrackId: mapProvenance(nextDocument.transcriptionByTrackId, (state) => ({
                ...state,
                stale: true,
            })),
        };
    }

    return {
        audioGraphRevision: nextDocument.audioGraphRevision,
        transcriptionByTrackId: mapProvenance(nextDocument.transcriptionByTrackId, (state) => (
            state.stale
                ? state
                : { ...state, sourceAudioGraphSignature: nextSignature }
        )),
    };
}

/** Captures all guards required before an asynchronous transcription result may replace a lane. */
export function createTranscriptionJobGuard(
    document: AudioGraphGuardDocument,
    targetTrack: SubtitleTrack,
): TranscriptionJobGuard {
    return {
        documentRevision: document.revision,
        audioGraphRevision: document.audioGraphRevision,
        audioGraphSignature: getCanonicalEditorAudioGraphSignature(document),
        targetTrackSignature: getSubtitleTrackSignature(targetTrack),
    };
}

/** A completed job is accepted only while both its media graph and target lane remain unchanged. */
export function isTranscriptionJobGuardCurrent(
    guard: TranscriptionJobGuard,
    document: AudioGraphGuardDocument,
    targetTrack: SubtitleTrack,
): boolean {
    return guard.audioGraphRevision === document.audioGraphRevision
        && guard.audioGraphSignature === getCanonicalEditorAudioGraphSignature(document)
        && guard.targetTrackSignature === getSubtitleTrackSignature(targetTrack);
}

/** Selects the only signature authority valid for the document's persisted graph version. */
export function getCanonicalEditorAudioGraphSignature(
    document: AudioGraphDocument | AudioGraphGuardDocument,
): string {
    return document.version === 4
        ? getEditorAudioGraphSignatureV4(document)
        : getEditorAudioGraphSignature(document);
}

/** The target signature is separate from the canonical audio graph and includes lane subtitles. */
export function getSubtitleTrackSignature(track: SubtitleTrack): string {
    return getStableValueSignature(track);
}

/**
 * Canonical signature for JSON-compatible editor metadata.
 *
 * Object keys are sorted recursively so extension insertion order cannot make an asynchronous
 * guard stale. Arrays deliberately retain order because subtitle, track, and container ordering
 * is semantic throughout the editor document.
 */
export function getStableValueSignature(value: unknown): string {
    return hashStablePayload(stableSerialize(value));
}

function mapProvenance(
    provenance: Record<string, TrackTranscriptionProvenanceV3>,
    transform: (state: TrackTranscriptionProvenanceV3) => TrackTranscriptionProvenanceV3,
): Record<string, TrackTranscriptionProvenanceV3> {
    return Object.fromEntries(Object.entries(provenance).map(([trackId, state]) => [trackId, transform(state)]));
}

function hashStablePayload(payload: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < payload.length; index += 1) {
        hash ^= payload.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

function stableSerialize(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const properties = Object.keys(record)
            .filter((key) => record[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
        return `{${properties.join(',')}}`;
    }
    // JSON persistence drops unsupported object fields and represents unsupported array values as
    // null. At the signature boundary a stable explicit marker avoids throwing on partial legacy
    // metadata while still making a type change observable.
    return JSON.stringify(`[${typeof value}]`);
}
