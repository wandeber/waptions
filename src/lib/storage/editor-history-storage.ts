import {
    applySerializablePatches,
    createSerializablePatches,
    validateSerializablePatches,
    type SerializablePatch,
} from '@/lib/serializable-patch';
import { finalizeAudioGraphMutation } from '@/lib/audio-graph-signature';
import { cloneAudioTracks } from '@/lib/audio-timeline';
import { validateEditorDocumentV3 } from '@/lib/editor-document-v3';
import type { EditorDocumentV3, EditorManifestV3 } from '@/types/video';
import { normalizeTimelineHistory } from '@/stores/timeline-history';
import {
    projectTimelineHistory,
    TIMELINE_HISTORY_ROOTS,
} from '@/stores/timeline-history-projection';
import type {
    TimelineHistoryEntry,
    TimelineHistoryProjection,
    TimelineHistoryRuntimeState,
    TimelineStore,
} from '@/stores/timeline-store-types';
import {
    getLegacyTranscriptionForTrack,
    getTrackTimingDomain,
} from '@/stores/timeline-store-selectors';

export const EDITOR_HISTORY_INDEX_KEY = 'editor-history:index';
export const EDITOR_HISTORY_ENTRY_PREFIX = 'editor-history:entry:';
export const EDITOR_RECOVERY_INDEX_KEY = 'editor-recovery:index';
export const EDITOR_RECOVERY_ENTRY_PREFIX = 'editor-recovery:entry:';
export const EDITOR_HISTORY_STORAGE_VERSION = 1;

export interface PersistedHistoryIndex {
    version: 1;
    documentRevision: number;
    sourceSignature: string;
    historyEntryIds: string[];
    redoEntryIds: string[];
}

export interface PersistedRecoveryIndex {
    version: 1;
    documentRevision: number;
    sourceSignature: string;
    entryKeys: string[];
}

export interface PersistedRecoveryEntry {
    version: 1;
    fromRevision: number;
    toRevision: number;
    fromAudioGraphRevision: number;
    toAudioGraphRevision: number;
    patches: SerializablePatch[];
    historyIndex: PersistedHistoryIndex;
    historyEntries: TimelineHistoryEntry[];
}

export interface EditorHistoryCheckpoint {
    index: PersistedHistoryIndex;
    changedEntries: TimelineHistoryEntry[];
    deletedEntryIds: string[];
    recoveryKeysToDelete: string[];
    clearRecoveryIndex: boolean;
}

export interface LoadedEditorRuntimeState {
    document: EditorDocumentV3;
    /** History already materialized under editor-history:entry:* in the durable checkpoint. */
    durableHistory: ReturnType<typeof normalizeTimelineHistory>;
    /** Effective history after applying the complete recovery chain, when one is valid. */
    history: ReturnType<typeof normalizeTimelineHistory>;
    recovered: boolean;
    /** Every recovery payload observed through the index, including a rejected chain. */
    recoveryEntryKeys: string[];
}

export const historyEntryStorageKey = (entryId: string) => `${EDITOR_HISTORY_ENTRY_PREFIX}${entryId}`;
export const recoveryEntryStorageKey = (revision: number) => `${EDITOR_RECOVERY_ENTRY_PREFIX}${revision}`;

/** Source identity is a recovery barrier: patches never introduce or replace File-backed assets. */
export function getManifestSourceSignature(manifest: EditorManifestV3): string {
    return JSON.stringify({
        video: [...manifest.videoSourceDescriptors]
            .map(({ id, fingerprint }) => ({ id, fingerprint }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        audio: [...manifest.audioSourceDescriptors]
            .map(({ id, fingerprint }) => ({ id, fingerprint }))
            .sort((left, right) => left.id.localeCompare(right.id)),
    });
}

export function createHistoryIndex(
    manifest: EditorManifestV3,
    runtime: TimelineHistoryRuntimeState,
): PersistedHistoryIndex {
    return {
        version: EDITOR_HISTORY_STORAGE_VERSION,
        documentRevision: manifest.revision,
        sourceSignature: getManifestSourceSignature(manifest),
        historyEntryIds: runtime.history.map((entry) => entry.id),
        redoEntryIds: runtime.redoStack.map((entry) => entry.id),
    };
}

/**
 * Validates the complete checkpoint and recovery chain before applying anything.
 *
 * Any missing entry, revision gap, hostile path, source mismatch, or stale checkpoint rejects the
 * entire auxiliary state. The durable V3 manifest remains the sole safe fallback; partial recovery
 * prefixes are deliberately never exposed to callers.
 */
export function restoreEditorRuntimeState(
    document: EditorDocumentV3,
    persistedManifest: EditorManifestV3,
    historyIndexValue: unknown,
    historyEntriesById: ReadonlyMap<string, unknown>,
    recoveryIndexValue: unknown,
    recoveryEntriesByKey: ReadonlyMap<string, unknown>,
): LoadedEditorRuntimeState {
    const sourceSignature = getManifestSourceSignature(persistedManifest);
    const historyIndex = parseHistoryIndex(historyIndexValue);
    const historyEntries = historyIndex
        && historyIndex.documentRevision === document.revision
        && historyIndex.sourceSignature === sourceSignature
        ? readCompleteHistory(historyIndex, historyEntriesById)
        : null;
    const emptyHistory = normalizeTimelineHistory([], []);
    const durableCandidate = historyEntries
        ? normalizeTimelineHistory(historyEntries.history, historyEntries.redoStack)
        : emptyHistory;
    const durableHistory = historyEntries && isHistoryApplicable(document, durableCandidate)
        ? durableCandidate
        : emptyHistory;

    const recoveryIndex = parseRecoveryIndex(recoveryIndexValue);
    // Rejected recovery data is still owned storage. Returning the observed keys lets the next
    // successful checkpoint collect every orphan atomically instead of leaking an invalid chain.
    const recoveryEntryKeys = readObservedRecoveryEntryKeys(recoveryIndexValue);
    const fallback = (): LoadedEditorRuntimeState => ({
        document,
        durableHistory,
        history: durableHistory,
        recovered: false,
        recoveryEntryKeys,
    });
    if (!recoveryIndex
        || recoveryIndex.documentRevision !== document.revision
        || recoveryIndex.sourceSignature !== sourceSignature
        || recoveryIndex.entryKeys.length === 0) {
        return fallback();
    }

    let expectedRevision = document.revision;
    let expectedAudioGraphRevision = document.audioGraphRevision;
    let projection = projectEditorDocumentHistory(document);
    let recoveredHistory = durableHistory;
    const recoveryHistoryEntries = new Map(historyEntriesById);
    for (const key of recoveryIndex.entryKeys) {
        const entry = parseRecoveryEntry(recoveryEntriesByKey.get(key));
        if (!entry
            || entry.fromRevision !== expectedRevision
            || entry.toRevision <= expectedRevision
            || entry.fromAudioGraphRevision !== expectedAudioGraphRevision
            || entry.toAudioGraphRevision < expectedAudioGraphRevision
            || entry.historyIndex.documentRevision !== entry.toRevision
            || entry.historyIndex.sourceSignature !== sourceSignature) {
            return fallback();
        }
        try {
            validateSerializablePatches(entry.patches, TIMELINE_HISTORY_ROOTS as ReadonlySet<string>);
            projection = applySerializablePatches(
                projection,
                entry.patches,
                TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
            );
        } catch {
            return fallback();
        }
        if (entry.historyEntries.some((historyEntry) => !isHistoryEntry(historyEntry))) {
            return fallback();
        }
        entry.historyEntries.forEach((historyEntry) => recoveryHistoryEntries.set(historyEntry.id, historyEntry));
        const completeHistory = readCompleteHistory(entry.historyIndex, recoveryHistoryEntries);
        if (!completeHistory) {
            return fallback();
        }
        const recoveredCandidate = normalizeTimelineHistory(
            completeHistory.history,
            completeHistory.redoStack,
        );
        const recoveredDocument = documentFromProjection(
            document,
            projection,
            entry.toRevision,
            entry.toAudioGraphRevision,
        );
        if (!validateEditorDocumentV3(recoveredDocument).valid
            || !isHistoryApplicable(recoveredDocument, recoveredCandidate)) {
            return fallback();
        }
        recoveredHistory = recoveredCandidate;
        expectedRevision = entry.toRevision;
        expectedAudioGraphRevision = entry.toAudioGraphRevision;
    }

    const recoveredDocument = documentFromProjection(
        document,
        projection,
        expectedRevision,
        expectedAudioGraphRevision,
    );
    // Serializable patches protect the storage shape, but only the complete V3 validator can
    // reject semantically impossible graphs such as invalid subtitle timing or dangling clips.
    // Recovery is all-or-nothing: a bad final graph falls back to the durable checkpoint and its
    // separately materialized history without exposing a valid-looking prefix.
    if (!validateEditorDocumentV3(recoveredDocument).valid) {
        return fallback();
    }

    return {
        document: recoveredDocument,
        durableHistory,
        history: recoveredHistory,
        recovered: true,
        recoveryEntryKeys,
    };
}

/**
 * Proves that persisted command paths are applicable to the exact restored projection.
 *
 * Shape validation alone cannot detect a keyed segment whose item no longer exists. Replaying the
 * retained past and future in both directions catches those semantic failures while operating on
 * detached copy-on-write projections, so corrupt auxiliary data never reaches live Undo/Redo.
 */
function isHistoryApplicable(
    currentDocument: EditorDocumentV3,
    runtime: ReturnType<typeof normalizeTimelineHistory>,
): boolean {
    try {
        const current = projectEditorDocumentHistory(currentDocument);
        let baseline = current;
        let baselineDocument = currentDocument;
        [...runtime.history].reverse().forEach((entry) => {
            baseline = applySerializablePatches(
                baseline,
                entry.inversePatches,
                TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
            );
            const validated = validateNavigableHistoryProjection(
                baselineDocument,
                baseline,
                entry,
            );
            baselineDocument = validated.document;
            baseline = validated.projection;
        });
        let replayed = baseline;
        let replayedDocument = baselineDocument;
        runtime.history.forEach((entry) => {
            replayed = applySerializablePatches(
                replayed,
                entry.patches,
                TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
            );
            const validated = validateNavigableHistoryProjection(
                replayedDocument,
                replayed,
                entry,
            );
            replayedDocument = validated.document;
            replayed = validated.projection;
        });
        if (!projectionsEqual(current, replayed)) return false;

        const futureEntries = [...runtime.redoStack].reverse();
        let future = current;
        let futureDocument = currentDocument;
        futureEntries.forEach((entry) => {
            future = applySerializablePatches(
                future,
                entry.patches,
                TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
            );
            const validated = validateNavigableHistoryProjection(
                futureDocument,
                future,
                entry,
            );
            futureDocument = validated.document;
            future = validated.projection;
        });
        [...futureEntries].reverse().forEach((entry) => {
            future = applySerializablePatches(
                future,
                entry.inversePatches,
                TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
            );
            const validated = validateNavigableHistoryProjection(
                futureDocument,
                future,
                entry,
            );
            futureDocument = validated.document;
            future = validated.projection;
        });
        return projectionsEqual(current, future);
    } catch {
        return false;
    }
}

/** Mirrors one Undo/Redo finalization and rejects an invalid state before it can become navigable. */
function validateNavigableHistoryProjection(
    previousDocument: EditorDocumentV3,
    projection: TimelineHistoryProjection,
    entry: TimelineHistoryEntry,
): { document: EditorDocumentV3; projection: TimelineHistoryProjection } {
    if (projection.activeTrackId !== null
        && !projection.tracks.some((track) => track.id === projection.activeTrackId)) {
        // documentFromProjection normally repairs a missing active lane for ordinary hydration.
        // Persisted history is untrusted: silently repairing this patch would make a corrupt Undo
        // command appear applicable and publish a different state from the one it encoded.
        throw new Error(`History entry ${entry.id} references a missing active subtitle track.`);
    }
    const projected = documentFromProjection(
        previousDocument,
        projection,
        previousDocument.revision + 1,
        previousDocument.audioGraphRevision,
    );
    const finalized = finalizeAudioGraphMutation(
        previousDocument,
        projected,
        entry.audioGraphMutationImpact,
    );
    const candidate: EditorDocumentV3 = {
        ...projected,
        audioGraphRevision: finalized.audioGraphRevision,
        transcriptionByTrackId: finalized.transcriptionByTrackId,
    };
    if (!validateEditorDocumentV3(candidate).valid) {
        throw new Error(`History entry ${entry.id} produces an invalid editor document.`);
    }
    const finalizedProjection = projectEditorDocumentHistory(candidate);
    return {
        document: candidate,
        projection: {
            ...finalizedProjection,
            // These runtime selection mirrors are not part of EditorDocumentV3. Preserve the
            // command's exact context while all durable/provenance roots advance from the
            // finalized document that real Undo/Redo would publish.
            selectedSubtitleIds: projection.selectedSubtitleIds,
            lastSelectedId: projection.lastSelectedId,
            selectedClipId: projection.selectedClipId,
            isVideoSelected: projection.isVideoSelected,
        },
    };
}

function projectionsEqual(left: TimelineHistoryProjection, right: TimelineHistoryProjection): boolean {
    const durableRoots = new Set<string>([
        'tracks',
        'videoClips',
        'renderProfile',
        'audioTracks',
        'activeTrackId',
        'transcriptionByTrackId',
    ]);
    const durableProjection = (projection: TimelineHistoryProjection) => ({
        tracks: projection.tracks.map((track) => ({
            ...track,
            // V3 manifests materialize the optional runtime default on checkpoint. Treat an
            // omitted pre-checkpoint value as equivalent when proving the history round-trip.
            timingDomain: getTrackTimingDomain(track),
        })),
        videoClips: projection.videoClips,
        renderProfile: projection.renderProfile,
        audioTracks: projection.audioTracks,
        activeTrackId: projection.activeTrackId,
        transcriptionByTrackId: projection.transcriptionByTrackId,
    });
    return createSerializablePatches(
        durableProjection(left),
        durableProjection(right),
        durableRoots,
    ).patches.length === 0;
}

function readCompleteHistory(
    index: PersistedHistoryIndex,
    values: ReadonlyMap<string, unknown>,
): { history: TimelineHistoryEntry[]; redoStack: TimelineHistoryEntry[] } | null {
    const read = (ids: readonly string[]) => ids.map((id) => {
        const value = values.get(id);
        return isHistoryEntry(value) && value.id === id ? value : null;
    });
    const history = read(index.historyEntryIds);
    const redoStack = read(index.redoEntryIds);
    if (history.some((entry) => entry === null) || redoStack.some((entry) => entry === null)) return null;
    return {
        history: history as TimelineHistoryEntry[],
        redoStack: redoStack as TimelineHistoryEntry[],
    };
}

export function projectEditorDocumentHistory(document: EditorDocumentV3): TimelineHistoryProjection {
    const legacy = getLegacyTranscriptionForTrack(
        document.transcriptionByTrackId,
        document.activeSubtitleTrackId,
    );
    const state = {
        ...document,
        tracks: document.subtitleTracks,
        activeTrackId: document.activeSubtitleTrackId,
        selectedSubtitleIds: document.transientSelection.kind === 'subtitles'
            ? document.transientSelection.subtitleIds
            : [],
        selectedClipId: document.transientSelection.kind === 'video-clip'
            ? document.transientSelection.clipId
            : null,
        lastSelectedId: null,
        isVideoSelected: document.transientSelection.kind === 'video-clip',
        rawTranscription: legacy?.raw ?? null,
        transcriptionGroups: legacy?.groups ?? null,
        transcriptionContainerIds: legacy?.containerIds ?? null,
    } as unknown as TimelineStore;
    return projectTimelineHistory(state);
}

function documentFromProjection(
    baseline: EditorDocumentV3,
    projection: TimelineHistoryProjection,
    revision: number,
    audioGraphRevision: number,
): EditorDocumentV3 {
    const activeSubtitleTrackId = projection.activeTrackId
        && projection.tracks.some((track) => track.id === projection.activeTrackId)
        ? projection.activeTrackId
        : projection.tracks[0]?.id ?? null;
    return {
        ...baseline,
        revision,
        audioGraphRevision,
        renderProfile: projection.renderProfile,
        subtitleTracks: projection.tracks.map((track) => ({
            ...track,
            timingDomain: getTrackTimingDomain(track),
        })),
        videoClips: projection.videoClips,
        audioTracks: cloneAudioTracks(projection.audioTracks),
        activeSubtitleTrackId,
        transientSelection: projection.transientSelection,
        transcriptionByTrackId: projection.transcriptionByTrackId,
    };
}

function parseHistoryIndex(value: unknown): PersistedHistoryIndex | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<PersistedHistoryIndex>;
    const historyIds = candidate.historyEntryIds;
    const redoIds = candidate.redoEntryIds;
    return candidate.version === EDITOR_HISTORY_STORAGE_VERSION
        && Number.isSafeInteger(candidate.documentRevision)
        && typeof candidate.sourceSignature === 'string'
        && isStringArray(historyIds)
        && isStringArray(redoIds)
        && new Set([...historyIds, ...redoIds]).size === historyIds.length + redoIds.length
        ? candidate as PersistedHistoryIndex
        : null;
}

function parseRecoveryIndex(value: unknown): PersistedRecoveryIndex | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<PersistedRecoveryIndex>;
    return candidate.version === EDITOR_HISTORY_STORAGE_VERSION
        && Number.isSafeInteger(candidate.documentRevision)
        && typeof candidate.sourceSignature === 'string'
        && isStringArray(candidate.entryKeys)
        && candidate.entryKeys.every(isRecoveryEntryStorageKey)
        && new Set(candidate.entryKeys).size === candidate.entryKeys.length
        ? candidate as PersistedRecoveryIndex
        : null;
}

/** Extracts only keys inside the recovery namespace, even when the surrounding index is invalid. */
function readObservedRecoveryEntryKeys(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    const entryKeys = (value as Partial<PersistedRecoveryIndex>).entryKeys;
    if (!Array.isArray(entryKeys)) return [];
    return Array.from(new Set(entryKeys.filter(isRecoveryEntryStorageKey)));
}

function isRecoveryEntryStorageKey(value: unknown): value is string {
    if (typeof value !== 'string' || !value.startsWith(EDITOR_RECOVERY_ENTRY_PREFIX)) return false;
    const revision = value.slice(EDITOR_RECOVERY_ENTRY_PREFIX.length);
    return /^(0|[1-9]\d*)$/.test(revision) && Number.isSafeInteger(Number(revision));
}

function parseRecoveryEntry(value: unknown): PersistedRecoveryEntry | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<PersistedRecoveryEntry>;
    return candidate.version === EDITOR_HISTORY_STORAGE_VERSION
        && Number.isSafeInteger(candidate.fromRevision)
        && Number.isSafeInteger(candidate.toRevision)
        && Number.isSafeInteger(candidate.fromAudioGraphRevision)
        && Number.isSafeInteger(candidate.toAudioGraphRevision)
        && Array.isArray(candidate.patches)
        && parseHistoryIndex(candidate.historyIndex) !== null
        && Array.isArray(candidate.historyEntries)
        ? candidate as PersistedRecoveryEntry
        : null;
}

function isHistoryEntry(value: unknown): value is TimelineHistoryEntry {
    if (!value || typeof value !== 'object') return false;
    const entry = value as Partial<TimelineHistoryEntry>;
    if (typeof entry.id !== 'string'
        || !Number.isSafeInteger(entry.sequence)
        || typeof entry.label !== 'string'
        || !(entry.mergeKey === null || typeof entry.mergeKey === 'string')
        || !Number.isFinite(entry.timestamp)
        || !Array.isArray(entry.patches)
        || !Array.isArray(entry.inversePatches)
        || !Number.isFinite(entry.byteSize)
        || (entry.audioGraphMutationImpact !== 'invalidate-transcription'
            && entry.audioGraphMutationImpact !== 'preserve-transcription')
        || typeof entry.recalculatesContentBoundary !== 'boolean'
        || typeof entry.oversized !== 'boolean') return false;
    try {
        validateSerializablePatches(entry.patches, TIMELINE_HISTORY_ROOTS as ReadonlySet<string>);
        validateSerializablePatches(entry.inversePatches, TIMELINE_HISTORY_ROOTS as ReadonlySet<string>);
        return true;
    } catch {
        return false;
    }
}

const isStringArray = (value: unknown): value is string[] => (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
);
