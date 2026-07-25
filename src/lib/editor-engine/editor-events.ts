import type { EditorEngineRevisions } from './editor-engine-types';

export type EditorEngineEvent =
    | {
        id: string;
        sequence: number;
        type: 'project.mutated';
        projectId: string;
        occurredAt: string;
        commandId: string;
        operationIds: string[];
        historyEntryId: string;
        revisions: EditorEngineRevisions;
    }
    | {
        id: string;
        sequence: number;
        type: 'history.changed';
        projectId: string;
        occurredAt: string;
        commandId: string;
        action: 'undo' | 'redo' | 'jump';
        historyEntryId: string | null;
        revisions: EditorEngineRevisions;
    };

export type EditorEngineListener = (
    snapshot: import('./editor-engine-types').EditorEngineSnapshot,
    event: EditorEngineEvent,
) => void;
