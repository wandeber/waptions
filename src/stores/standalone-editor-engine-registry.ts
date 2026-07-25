import type {
    EditorEngineSnapshot,
} from '@/lib/editor-engine/editor-engine-types';
import type { EditorSemanticOperation } from '@/lib/editor-engine/editor-command';
import type { TransientMediaSelectionV4 } from '@/types/video';
import type { TimelineV4CommandResult } from './timeline-v4-command-types';

export interface StandaloneEditorDispatchOptions {
    history: {
        label: string;
        category: string;
    };
    selectionBefore: TransientMediaSelectionV4;
    selectionAfter: TransientMediaSelectionV4;
    compatibilityResult: TimelineV4CommandResult;
}

export interface StandaloneEditorEngineBridge {
    getSnapshot(): EditorEngineSnapshot;
    enqueueOperations(
        operations: readonly EditorSemanticOperation[],
        options: StandaloneEditorDispatchOptions,
    ): TimelineV4CommandResult;
    dispatchOperations(
        operations: readonly EditorSemanticOperation[],
        options: StandaloneEditorDispatchOptions,
    ): Promise<TimelineV4CommandResult>;
    reportUnsupported(result: Extract<TimelineV4CommandResult, { kind: 'error' }>): void;
    flush(): Promise<void>;
    retryLastFailure(): Promise<boolean>;
    undo(): Promise<void>;
    redo(): Promise<void>;
    jumpToHistory(entryId: string | null, position: 'before' | 'after'): Promise<void>;
    close(): Promise<void>;
}

export class StandaloneEditorUnsupportedError extends Error {
    override readonly name = 'StandaloneEditorUnsupportedError';
}

let activeBridge: StandaloneEditorEngineBridge | null = null;

export function getStandaloneEditorEngineBridge(): StandaloneEditorEngineBridge | null {
    return activeBridge;
}

export function setStandaloneEditorEngineBridge(
    bridge: StandaloneEditorEngineBridge | null,
): void {
    activeBridge = bridge;
}
