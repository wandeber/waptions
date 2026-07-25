import {
    applySerializablePatches,
    createSerializablePatches,
    validateSerializablePatches,
    type SerializablePatch,
} from '@/lib/serializable-patch';
import type { EditorManifestV4 } from '@/types/video';
import { EditorCommandError } from './editor-command-errors';
import type {
    EditorHistoryEntry,
    EditorProjectMetadata,
    EditorHistoryState,
    EditorHistorySummary,
} from './editor-engine-types';

export const EDITOR_HISTORY_MAX_ENTRIES = 500;
export const EDITOR_HISTORY_MAX_BYTES = 32 * 1024 * 1024;

export const EDITOR_HISTORY_ROOTS: ReadonlySet<string> = new Set([
    'renderProfile',
    'renderBackgroundColor',
    'subtitleTracks',
    'videoSourceDescriptors',
    'videoClips',
    'videoTracks',
    'audioSourceDescriptors',
    'audioTracks',
    'activeSubtitleTrackId',
    'transcriptionByTrackId',
    'globalEditingMode',
    'editorialTranscriptDescriptors',
    'narrative',
    'dependentLinks',
]);

export function createEditorHistoryEntry(input: {
    before: EditorManifestV4;
    after: EditorManifestV4;
    beforeProject: EditorProjectMetadata;
    afterProject: EditorProjectMetadata;
    summary: EditorHistorySummary;
}): EditorHistoryEntry {
    const beforeProjection = structuredClone(input.before);
    const afterProjection = structuredClone(input.after);
    // Revisions are monotonic transaction metadata, not semantic state to rewind.
    afterProjection.revision = beforeProjection.revision;
    afterProjection.audioGraphRevision = beforeProjection.audioGraphRevision;
    const pair = createSerializablePatches(
        beforeProjection,
        afterProjection,
        EDITOR_HISTORY_ROOTS,
    );
    const byteSize = encodedBytes(pair.patches) + encodedBytes(pair.inversePatches)
        + encodedBytes(input.summary)
        + encodedBytes(input.beforeProject)
        + encodedBytes(input.afterProject);
    return {
        summary: structuredClone(input.summary),
        patches: pair.patches,
        inversePatches: pair.inversePatches,
        byteSize,
        transcriptRecordIds: collectTranscriptRecordIds(input.before, input.after),
        projectMetadata: input.beforeProject.name === input.afterProject.name
            ? null
            : {
                before: structuredClone(input.beforeProject),
                after: structuredClone(input.afterProject),
            },
    };
}

export function appendEditorHistory(
    state: EditorHistoryState,
    entry: EditorHistoryEntry,
): EditorHistoryState {
    const past = [...state.past, cloneEntry(entry)];
    while (past.length > EDITOR_HISTORY_MAX_ENTRIES || historyBytes(past) > EDITOR_HISTORY_MAX_BYTES) {
        past.shift();
    }
    return { past, future: [] };
}

export function validateEditorHistoryState(state: EditorHistoryState): void {
    if (!state || !Array.isArray(state.past) || !Array.isArray(state.future)) {
        throw invalidHistory('Recovered editor history must contain past and future arrays.');
    }
    const entries = [...state.past, ...state.future];
    if (entries.length > EDITOR_HISTORY_MAX_ENTRIES) {
        throw invalidHistory('Recovered editor history exceeds the entry budget.');
    }
    const seenIds = new Set<string>();
    let retainedBytes = 0;
    entries.forEach((entry) => {
        if (!entry || !entry.summary || !Array.isArray(entry.patches)
            || !Array.isArray(entry.inversePatches)
            || !Array.isArray(entry.transcriptRecordIds)) {
            throw invalidHistory('Recovered editor history contains an invalid entry.');
        }
        try {
            validateSerializablePatches(entry.patches, EDITOR_HISTORY_ROOTS);
            validateSerializablePatches(entry.inversePatches, EDITOR_HISTORY_ROOTS);
        } catch (error) {
            throw new EditorCommandError(
                'INVALID_DOCUMENT',
                'Recovered editor history contains an unsafe patch.',
                { cause: error },
            );
        }
        validateHistorySummary(entry.summary);
        if (seenIds.has(entry.summary.id)) {
            throw invalidHistory('Recovered editor history contains a duplicate entry ID.');
        }
        seenIds.add(entry.summary.id);
        if (!entry.transcriptRecordIds.every((recordId) => typeof recordId === 'string'
            && recordId.length > 0 && recordId.length <= 256)) {
            throw invalidHistory('Recovered editor history contains an invalid transcript reference.');
        }
        if (entry.projectMetadata) {
            validateProjectMetadata(entry.projectMetadata.before);
            validateProjectMetadata(entry.projectMetadata.after);
        }
        const minimumBytes = encodedBytes(entry.patches)
            + encodedBytes(entry.inversePatches)
            + encodedBytes(entry.summary)
            + (entry.projectMetadata
                ? encodedBytes(entry.projectMetadata.before) + encodedBytes(entry.projectMetadata.after)
                : 0);
        if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0
            || entry.byteSize < minimumBytes) {
            throw invalidHistory('Recovered editor history contains an invalid byte-size record.');
        }
        retainedBytes += entry.byteSize;
    });
    if (retainedBytes > EDITOR_HISTORY_MAX_BYTES) {
        throw invalidHistory('Recovered editor history exceeds the retained-byte budget.');
    }
}

export function moveEditorHistory(input: {
    manifest: EditorManifestV4;
    projectMetadata: EditorProjectMetadata;
    state: EditorHistoryState;
    direction: 'undo' | 'redo';
    steps: number;
}): {
    manifest: EditorManifestV4;
    projectMetadata: EditorProjectMetadata;
    state: EditorHistoryState;
    entryId: string | null;
    changed: boolean;
} {
    const past = input.state.past.map(cloneEntry);
    const future = input.state.future.map(cloneEntry);
    let manifest = structuredClone(input.manifest);
    let projectMetadata = structuredClone(input.projectMetadata);
    let entryId: string | null = null;
    let changed = false;
    for (let step = 0; step < input.steps; step += 1) {
        const entry = input.direction === 'undo' ? past.pop() : future.pop();
        if (!entry) break;
        manifest = applySerializablePatches(
            manifest,
            input.direction === 'undo' ? entry.inversePatches : entry.patches,
            EDITOR_HISTORY_ROOTS,
        );
        if (entry.projectMetadata) {
            projectMetadata = structuredClone(
                input.direction === 'undo'
                    ? entry.projectMetadata.before
                    : entry.projectMetadata.after,
            );
        }
        if (input.direction === 'undo') future.push(entry);
        else past.push(entry);
        entryId = entry.summary.id;
        changed = true;
    }
    return { manifest, projectMetadata, state: { past, future }, entryId, changed };
}

export function jumpEditorHistory(input: {
    manifest: EditorManifestV4;
    projectMetadata: EditorProjectMetadata;
    state: EditorHistoryState;
    entryId: string;
    position: 'before' | 'after';
}): {
    manifest: EditorManifestV4;
    projectMetadata: EditorProjectMetadata;
    state: EditorHistoryState;
    entryId: string | null;
    changed: boolean;
} {
    const ordered = [
        ...input.state.past,
        ...[...input.state.future].reverse(),
    ];
    const index = ordered.findIndex((entry) => entry.summary.id === input.entryId);
    if (index < 0) {
        throw new EditorCommandError('NOT_FOUND', 'The requested history entry does not exist.', {
            details: { ids: [input.entryId] },
        });
    }
    const targetPastCount = index + (input.position === 'after' ? 1 : 0);
    const delta = targetPastCount - input.state.past.length;
    if (delta === 0) {
        return {
            manifest: structuredClone(input.manifest),
            projectMetadata: structuredClone(input.projectMetadata),
            state: cloneHistoryState(input.state),
            entryId: input.entryId,
            changed: false,
        };
    }
    return moveEditorHistory({
        manifest: input.manifest,
        projectMetadata: input.projectMetadata,
        state: input.state,
        direction: delta < 0 ? 'undo' : 'redo',
        steps: Math.abs(delta),
    });
}

export function cloneHistoryState(state: EditorHistoryState): EditorHistoryState {
    return {
        past: state.past.map(cloneEntry),
        future: state.future.map(cloneEntry),
    };
}

export function collectHistoryPins(state: EditorHistoryState): {
    historyRecordIds: string[];
    redoRecordIds: string[];
} {
    return {
        historyRecordIds: unique(state.past.flatMap((entry) => entry.transcriptRecordIds)),
        redoRecordIds: unique(state.future.flatMap((entry) => entry.transcriptRecordIds)),
    };
}

export function collectManifestTranscriptRecordIds(manifest: EditorManifestV4): string[] {
    return unique([
        ...manifest.editorialTranscriptDescriptors.map((descriptor) => descriptor.recordId),
        ...(manifest.narrative?.sourceRecordIds ?? []),
    ]);
}

function cloneEntry(entry: EditorHistoryEntry): EditorHistoryEntry {
    return {
        summary: structuredClone(entry.summary),
        patches: structuredClone(entry.patches) as SerializablePatch[],
        inversePatches: structuredClone(entry.inversePatches) as SerializablePatch[],
        byteSize: entry.byteSize,
        transcriptRecordIds: [...entry.transcriptRecordIds],
        projectMetadata: entry.projectMetadata ? structuredClone(entry.projectMetadata) : null,
    };
}

function collectTranscriptRecordIds(
    before: EditorManifestV4,
    after: EditorManifestV4,
): string[] {
    return unique([
        ...collectManifestTranscriptRecordIds(before),
        ...collectManifestTranscriptRecordIds(after),
    ]);
}

function unique(values: readonly string[]): string[] {
    return Array.from(new Set(values)).sort();
}

function encodedBytes(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function historyBytes(entries: readonly EditorHistoryEntry[]): number {
    return entries.reduce((total, entry) => total + entry.byteSize, 0);
}

function validateHistorySummary(summary: EditorHistorySummary): void {
    if (typeof summary.id !== 'string' || summary.id.length === 0 || summary.id.length > 256
        || typeof summary.label !== 'string' || summary.label.length === 0 || summary.label.length > 256
        || typeof summary.category !== 'string' || summary.category.length === 0
        || summary.category.length > 256
        || typeof summary.occurredAt !== 'string' || !Number.isFinite(Date.parse(summary.occurredAt))
        || !Array.isArray(summary.operationIds)
        || !summary.operationIds.every((operationId) => typeof operationId === 'string'
            && operationId.length > 0 && operationId.length <= 256)) {
        throw invalidHistory('Recovered editor history contains invalid summary metadata.');
    }
    [summary.from, summary.to].forEach((revisions) => {
        const values = [
            revisions.sessionRevision,
            revisions.documentRevision,
            revisions.audioGraphRevision,
            ...(revisions.narrativeRevision === undefined ? [] : [revisions.narrativeRevision]),
        ];
        if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) {
            throw invalidHistory('Recovered editor history contains invalid revision metadata.');
        }
    });
}

function validateProjectMetadata(metadata: EditorProjectMetadata): void {
    if (!metadata || typeof metadata.name !== 'string' || !metadata.name.trim()
        || metadata.name.length > 256) {
        throw invalidHistory('Recovered editor history contains invalid project metadata.');
    }
}

function invalidHistory(message: string): EditorCommandError {
    return new EditorCommandError('INVALID_DOCUMENT', message);
}
