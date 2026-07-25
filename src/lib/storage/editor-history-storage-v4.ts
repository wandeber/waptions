import { finalizeAudioGraphMutation } from '@/lib/audio-graph-signature';
import { cloneAudioTracks } from '@/lib/audio-timeline';
import { validateEditorDocumentV4 } from '@/lib/editor-document-v4';
import {
    applySerializablePatches,
    createSerializablePatches,
    validateSerializablePatches,
} from '@/lib/serializable-patch';
import { normalizeTimelineHistory } from '@/stores/timeline-history';
import {
    projectTimelineHistory,
    TIMELINE_HISTORY_ROOTS,
} from '@/stores/timeline-history-projection';
import type {
    TimelineHistoryEntry,
    TimelineHistoryProjection,
    TimelineStore,
} from '@/stores/timeline-store-types';
import {
    buildTimelineVideoTrackMirrors,
    projectVideoClipsV4,
    projectVideoTracksV4,
} from '@/stores/timeline-v4-compat';
import type { EditorDocumentV4, EditorManifestV4 } from '@/types/video';
import type { EditorDocumentV3 } from '@/types/video';
import type {
    LoadedEditorRuntimeState,
    PersistedHistoryIndex,
    PersistedRecoveryEntry,
    PersistedRecoveryIndex,
} from './editor-history-storage';
import { getManifestSourceSignature } from './editor-history-storage';
import {
    materializeEditorDocumentV3HistoryProjection,
    projectEditorDocumentHistory,
} from './editor-history-storage';
import { migrateEditorDocumentV3ToV4 } from '@/lib/editor-document-v4-migration';
import type { TimelineHistoryRuntimeState } from '@/stores/timeline-store-types';

/**
 * Restores descriptor-only V4 history and WAL without ever resolving transcript bodies.
 *
 * CAS hydration is deliberately a later publication guard owned by Timeline/Project stores. This
 * function only proves that untrusted serialized patches form a complete, semantically valid V4
 * graph chain. Any auxiliary corruption falls back to the durable manifest and empty history.
 */
export function restoreEditorRuntimeStateV4(
    document: EditorDocumentV4,
    persistedManifest: EditorManifestV4,
    historyIndexValue: unknown,
    historyEntriesById: ReadonlyMap<string, unknown>,
    recoveryIndexValue: unknown,
    recoveryEntriesByKey: ReadonlyMap<string, unknown>,
): LoadedEditorRuntimeState {
    const sourceSignature = getManifestSourceSignature(persistedManifest);
    const empty = normalizeTimelineHistory([], []);
    const historyIndex = parseHistoryIndexV3(historyIndexValue);
    const loaded = historyIndex
        && historyIndex.documentRevision === document.revision
        && historyIndex.sourceSignature === sourceSignature
        ? readCompleteHistory(historyIndex, historyEntriesById)
        : null;
    const candidate = loaded ? normalizeTimelineHistory(loaded.history, loaded.redoStack) : empty;
    const durableHistory = loaded && isHistoryApplicableV4(document, candidate) ? candidate : empty;
    const observedRecoveryKeys = readObservedRecoveryKeys(recoveryIndexValue);
    const fallback = (): LoadedEditorRuntimeState => ({
        document,
        durableHistory,
        history: durableHistory,
        recovered: false,
        recoveryEntryKeys: observedRecoveryKeys,
    });

    const recoveryIndex = parseRecoveryIndexV3(recoveryIndexValue);
    if (!recoveryIndex
        || recoveryIndex.documentRevision !== document.revision
        || recoveryIndex.sourceSignature !== sourceSignature
        || recoveryIndex.entryKeys.length === 0) return fallback();

    let projection = projectEditorDocumentHistoryV4(document);
    let revision = document.revision;
    let audioGraphRevision = document.audioGraphRevision;
    let recoveredHistory = durableHistory;
    const entries = new Map(historyEntriesById);
    for (const key of recoveryIndex.entryKeys) {
        const recovery = parseRecoveryEntryV3(recoveryEntriesByKey.get(key));
        if (!recovery
            || recovery.fromRevision !== revision
            || recovery.toRevision <= revision
            || recovery.fromAudioGraphRevision !== audioGraphRevision
            || recovery.toAudioGraphRevision < audioGraphRevision
            || recovery.historyIndex.documentRevision !== recovery.toRevision
            || recovery.historyIndex.sourceSignature !== sourceSignature) return fallback();
        try {
            validateSerializablePatches(recovery.patches, TIMELINE_HISTORY_ROOTS as ReadonlySet<string>);
            projection = applySerializablePatches(
                projection,
                recovery.patches,
                TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
            );
        } catch {
            return fallback();
        }
        if (recovery.historyEntries.some((entry) => !isHistoryEntry(entry))) return fallback();
        recovery.historyEntries.forEach((entry) => entries.set(entry.id, entry));
        const complete = readCompleteHistory(recovery.historyIndex, entries);
        if (!complete) return fallback();
        const nextHistory = normalizeTimelineHistory(complete.history, complete.redoStack);
        const nextDocument = documentFromProjectionV4(
            document,
            projection,
            recovery.toRevision,
            recovery.toAudioGraphRevision,
        );
        if (!validateEditorDocumentV4(nextDocument).valid || !isHistoryApplicableV4(nextDocument, nextHistory)) {
            return fallback();
        }
        revision = recovery.toRevision;
        audioGraphRevision = recovery.toAudioGraphRevision;
        recoveredHistory = nextHistory;
    }
    const recoveredDocument = documentFromProjectionV4(
        document,
        projection,
        revision,
        audioGraphRevision,
    );
    if (!validateEditorDocumentV4(recoveredDocument).valid) return fallback();
    return {
        document: recoveredDocument,
        durableHistory,
        history: recoveredHistory,
        recovered: true,
        recoveryEntryKeys: observedRecoveryKeys,
    };
}

/** Builds the exact descriptor-only history projection for a hydrated V4 runtime document. */
export function projectEditorDocumentHistoryV4(document: EditorDocumentV4): TimelineHistoryProjection {
    const videoTracks = buildTimelineVideoTrackMirrors(document.videoTracks, document.videoClips);
    return projectTimelineHistory({
        ...document,
        tracks: document.subtitleTracks,
        videoTracks,
        activeTrackId: document.activeSubtitleTrackId,
        selectedSubtitleIds: document.transientSelection.kind === 'subtitles'
            ? document.transientSelection.subtitleIds
            : [],
        selectedClipId: document.transientSelection.kind === 'video-clip'
            ? document.transientSelection.clipId
            : null,
        lastSelectedId: null,
        isVideoSelected: document.transientSelection.kind === 'video-clip',
        rawTranscription: null,
        transcriptionGroups: null,
        transcriptionContainerIds: null,
    } as unknown as TimelineStore);
}

/**
 * Replays validated storage-v2 patches in their original V3 domain, migrates every adjacent graph
 * to explicit V4 placement, then re-diffs those graphs under storage-v3 roots. This avoids trying
 * to reinterpret a V3 `clipIds` or cumulative-placement patch as if it already contained V4
 * ownership. IDs, labels, timestamps, merge keys, and impact metadata remain stable.
 */
export function migrateTimelineHistoryV3ToV4(
    currentV3: EditorDocumentV3,
    currentV4: EditorDocumentV4,
    runtime: TimelineHistoryRuntimeState,
): TimelineHistoryRuntimeState {
    const migratedEntries = new Map<string, TimelineHistoryEntry>();
    const migrateProjection = (projection: TimelineHistoryProjection): TimelineHistoryProjection => {
        const document = migrateEditorDocumentV3ToV4(
            materializeEditorDocumentV3HistoryProjection(currentV3, projection),
        );
        const migrated = projectEditorDocumentHistoryV4(document);
        return {
            ...migrated,
            // These compatibility mirrors are runtime context, not part of EditorDocumentV3/4.
            // Preserve their exact historical values while durable graph roots are migrated.
            selectedSubtitleIds: [...projection.selectedSubtitleIds],
            lastSelectedId: projection.lastSelectedId,
            selectedClipId: projection.selectedClipId,
            isVideoSelected: projection.isVideoSelected,
            rawTranscription: structuredClone(projection.rawTranscription),
            transcriptionGroups: structuredClone(projection.transcriptionGroups),
            transcriptionContainerIds: structuredClone(projection.transcriptionContainerIds),
        };
    };
    const migrateEntry = (
        entry: TimelineHistoryEntry,
        before: TimelineHistoryProjection,
        after: TimelineHistoryProjection,
    ): void => {
        const pair = createSerializablePatches(
            migrateProjection(before),
            migrateProjection(after),
            TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
        );
        migratedEntries.set(entry.id, {
            ...entry,
            patches: pair.patches,
            inversePatches: pair.inversePatches,
            // normalizeTimelineHistory recomputes both fields from the migrated descriptor-only
            // payload and reapplies the existing global entry/byte bounds.
            byteSize: 0,
            oversized: false,
        });
    };

    let past = projectEditorDocumentHistory(currentV3);
    [...runtime.history].reverse().forEach((entry) => {
        const after = past;
        const before = applySerializablePatches(
            after,
            entry.inversePatches,
            TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
        );
        migrateEntry(entry, before, after);
        past = before;
    });

    let future = projectEditorDocumentHistory(currentV3);
    [...runtime.redoStack].reverse().forEach((entry) => {
        const before = future;
        const after = applySerializablePatches(
            before,
            entry.patches,
            TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
        );
        migrateEntry(entry, before, after);
        future = after;
    });

    const normalized = normalizeTimelineHistory(
        runtime.history.map((entry) => migratedEntries.get(entry.id) ?? entry),
        runtime.redoStack.map((entry) => migratedEntries.get(entry.id) ?? entry),
    );
    const currentProjection = migrateProjection(projectEditorDocumentHistory(currentV3));
    // Use the caller's exact current V4 graph as the authority and retain only context fields from
    // the replayed V3 projection. This also catches accidental migration drift during validation.
    const authoritativeCurrent = projectEditorDocumentHistoryV4(currentV4);
    return {
        history: normalized.history,
        redoStack: normalized.redoStack,
        projection: {
            ...authoritativeCurrent,
            selectedSubtitleIds: currentProjection.selectedSubtitleIds,
            lastSelectedId: currentProjection.lastSelectedId,
            selectedClipId: currentProjection.selectedClipId,
            isVideoSelected: currentProjection.isVideoSelected,
            rawTranscription: currentProjection.rawTranscription,
            transcriptionGroups: currentProjection.transcriptionGroups,
            transcriptionContainerIds: currentProjection.transcriptionContainerIds,
        },
    };
}

function isHistoryApplicableV4(
    currentDocument: EditorDocumentV4,
    runtime: ReturnType<typeof normalizeTimelineHistory>,
): boolean {
    try {
        const current = projectEditorDocumentHistoryV4(currentDocument);
        let baselineProjection = current;
        let baselineDocument = currentDocument;
        [...runtime.history].reverse().forEach((entry) => {
            baselineProjection = applySerializablePatches(
                baselineProjection,
                entry.inversePatches,
                TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
            );
            baselineDocument = finalizeProjectionV4(baselineDocument, baselineProjection, entry);
            baselineProjection = projectEditorDocumentHistoryV4(baselineDocument);
        });
        let replayedProjection = baselineProjection;
        let replayedDocument = baselineDocument;
        runtime.history.forEach((entry) => {
            replayedProjection = applySerializablePatches(
                replayedProjection,
                entry.patches,
                TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
            );
            replayedDocument = finalizeProjectionV4(replayedDocument, replayedProjection, entry);
            replayedProjection = projectEditorDocumentHistoryV4(replayedDocument);
        });
        if (JSON.stringify(projectDurableRoots(current)) !== JSON.stringify(projectDurableRoots(replayedProjection))) {
            return false;
        }

        let futureProjection = current;
        let futureDocument = currentDocument;
        const futureEntries = [...runtime.redoStack].reverse();
        futureEntries.forEach((entry) => {
            futureProjection = applySerializablePatches(
                futureProjection,
                entry.patches,
                TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
            );
            futureDocument = finalizeProjectionV4(futureDocument, futureProjection, entry);
            futureProjection = projectEditorDocumentHistoryV4(futureDocument);
        });
        [...futureEntries].reverse().forEach((entry) => {
            futureProjection = applySerializablePatches(
                futureProjection,
                entry.inversePatches,
                TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
            );
            futureDocument = finalizeProjectionV4(futureDocument, futureProjection, entry);
            futureProjection = projectEditorDocumentHistoryV4(futureDocument);
        });
        return JSON.stringify(projectDurableRoots(current)) === JSON.stringify(projectDurableRoots(futureProjection));
    } catch {
        return false;
    }
}

function finalizeProjectionV4(
    previous: EditorDocumentV4,
    projection: TimelineHistoryProjection,
    entry: TimelineHistoryEntry,
): EditorDocumentV4 {
    const proposed = documentFromProjectionV4(
        previous,
        projection,
        previous.revision + 1,
        previous.audioGraphRevision,
    );
    const audio = finalizeAudioGraphMutation(previous, proposed, entry.audioGraphMutationImpact);
    const candidate = {
        ...proposed,
        audioGraphRevision: audio.audioGraphRevision,
        transcriptionByTrackId: audio.transcriptionByTrackId,
    };
    if (!validateEditorDocumentV4(candidate).valid) {
        throw new Error(`History entry ${entry.id} produces an invalid V4 editor document.`);
    }
    return candidate;
}

function documentFromProjectionV4(
    baseline: EditorDocumentV4,
    projection: TimelineHistoryProjection,
    revision: number,
    audioGraphRevision: number,
): EditorDocumentV4 {
    const trackMirrors = projection.videoTracks.map((track) => ({
        ...track,
        visible: track.visible ?? true,
        locked: track.locked ?? false,
        clipIds: [...(track.clipIds ?? [])],
    }));
    const videoClips = projectVideoClipsV4(
        projection.videoClips,
        trackMirrors,
        projection.renderProfile,
    );
    const activeSubtitleTrackId = projection.activeTrackId
        && projection.tracks.some((track) => track.id === projection.activeTrackId)
        ? projection.activeTrackId
        : projection.tracks[0]?.id ?? null;
    return {
        ...baseline,
        revision,
        audioGraphRevision,
        renderProfile: structuredClone(projection.renderProfile),
        subtitleTracks: projection.tracks.map((track) => {
            const { timingDomain: _legacyTimingDomain, ...v4Track } = structuredClone(track);
            void _legacyTimingDomain;
            return {
                ...v4Track,
                unlinkedVideoEditResponse: track.unlinkedVideoEditResponse ?? 'follow-project-ripple',
            };
        }),
        videoClips,
        videoTracks: projectVideoTracksV4(trackMirrors),
        audioTracks: cloneAudioTracks(projection.audioTracks),
        activeSubtitleTrackId,
        transientSelection: structuredClone(projection.transientSelection),
        transcriptionByTrackId: structuredClone(projection.transcriptionByTrackId),
        globalEditingMode: projection.globalEditingMode ?? baseline.globalEditingMode,
        editorialTranscriptDescriptors: structuredClone(
            projection.editorialTranscriptDescriptors ?? baseline.editorialTranscriptDescriptors,
        ),
        narrative: structuredClone(projection.narrative ?? baseline.narrative),
        dependentLinks: structuredClone(projection.dependentLinks ?? baseline.dependentLinks),
    };
}

function projectDurableRoots(projection: TimelineHistoryProjection): unknown {
    return {
        tracks: projection.tracks,
        videoClips: projection.videoClips,
        videoTracks: projection.videoTracks,
        renderProfile: projection.renderProfile,
        audioTracks: projection.audioTracks,
        activeTrackId: projection.activeTrackId,
        transcriptionByTrackId: projection.transcriptionByTrackId,
        globalEditingMode: projection.globalEditingMode ?? 'ripple',
        editorialTranscriptDescriptors: projection.editorialTranscriptDescriptors ?? [],
        narrative: projection.narrative ?? null,
        dependentLinks: projection.dependentLinks ?? [],
    };
}

function parseHistoryIndexV3(value: unknown): PersistedHistoryIndex | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<PersistedHistoryIndex>;
    return candidate.version === 3
        && Number.isSafeInteger(candidate.documentRevision)
        && typeof candidate.sourceSignature === 'string'
        && isStringArray(candidate.historyEntryIds)
        && isStringArray(candidate.redoEntryIds)
        && new Set([...candidate.historyEntryIds, ...candidate.redoEntryIds]).size
            === candidate.historyEntryIds.length + candidate.redoEntryIds.length
        ? candidate as PersistedHistoryIndex
        : null;
}

function parseRecoveryIndexV3(value: unknown): PersistedRecoveryIndex | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<PersistedRecoveryIndex>;
    return candidate.version === 3
        && Number.isSafeInteger(candidate.documentRevision)
        && typeof candidate.sourceSignature === 'string'
        && isStringArray(candidate.entryKeys)
        && candidate.entryKeys.every(isRecoveryKey)
        && new Set(candidate.entryKeys).size === candidate.entryKeys.length
        ? candidate as PersistedRecoveryIndex
        : null;
}

function parseRecoveryEntryV3(value: unknown): PersistedRecoveryEntry | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<PersistedRecoveryEntry>;
    return candidate.version === 3
        && Number.isSafeInteger(candidate.fromRevision)
        && Number.isSafeInteger(candidate.toRevision)
        && Number.isSafeInteger(candidate.fromAudioGraphRevision)
        && Number.isSafeInteger(candidate.toAudioGraphRevision)
        && Array.isArray(candidate.patches)
        && parseHistoryIndexV3(candidate.historyIndex) !== null
        && Array.isArray(candidate.historyEntries)
        ? candidate as PersistedRecoveryEntry
        : null;
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
    return { history: history as TimelineHistoryEntry[], redoStack: redoStack as TimelineHistoryEntry[] };
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

function readObservedRecoveryKeys(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    const values = (value as Partial<PersistedRecoveryIndex>).entryKeys;
    return Array.isArray(values) ? Array.from(new Set(values.filter(isRecoveryKey))) : [];
}

function isRecoveryKey(value: unknown): value is string {
    if (typeof value !== 'string' || !value.startsWith('editor-recovery:entry:')) return false;
    const suffix = value.slice('editor-recovery:entry:'.length);
    return /^(0|[1-9]\d*)$/.test(suffix) && Number.isSafeInteger(Number(suffix));
}

const isStringArray = (value: unknown): value is string[] => (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
);
