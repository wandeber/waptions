import type { ResolvedEditorialTranscriptMapV1 } from '@/types/editorial';
import type { AudioSourceDescriptor, EditorManifestV4, VideoSourceDescriptorV3 } from '@/types/video';
import type { VerifiedMediaHandleV1 } from '@/types/waptions-agent-protocol';
import type { EditorMutationToolName } from './editor-command';
import type { EditorCommandResult, EditorEngineSnapshot, EditorHistoryState } from './editor-engine-types';
import type { EditorEngineEvent } from './editor-events';

export interface EditorClock {
    now(): {
        iso: string;
        epochMs: number;
    };
}

export interface EditorIdGenerator {
    /**
     * The same scope must always produce the same ID. This lets plan/apply resolve aliases
     * identically without consuming a process-global counter.
     */
    generate(kind: string, scope: string): string;
}

export interface EditorAssetHydration {
    videoSources: Array<VideoSourceDescriptorV3 & {
        handle: VerifiedMediaHandleV1;
        fileMetadata: {
            name: string;
            type: string;
            size: number;
            lastModified: number;
        };
    }>;
    audioSources: Array<AudioSourceDescriptor & {
        handle: VerifiedMediaHandleV1;
        fileMetadata: {
            name: string;
            type: string;
            size: number;
            lastModified: number;
        };
    }>;
}

export interface EditorAssetRepositoryPort {
    hydrate(input: {
        manifest: EditorManifestV4;
        videoSourceIds: readonly string[];
        audioSourceIds: readonly string[];
    }): Promise<EditorAssetHydration>;
    close?(): Promise<void>;
}

export interface EditorTranscriptReference {
    recordId: string;
    descriptorVersion: number;
    sourceId: string;
    /** Version-neutral descriptor data; repositories may route V1/V2 without engine casts. */
    descriptor: Readonly<Record<string, unknown>>;
}

export interface EditorialTranscriptRepositoryPort<
    TBodies = ResolvedEditorialTranscriptMapV1,
> {
    hydrate(input: {
        references: readonly EditorTranscriptReference[];
    }): Promise<TBodies>;
    close?(): Promise<void>;
}

export interface EditorIdempotencyReceipt {
    toolName: EditorMutationToolName;
    idempotencyKey: string;
    requestHash: string;
    result: Omit<Extract<EditorCommandResult, { ok: true }>, 'snapshot' | 'replayed'>;
}

export interface EditorPersistenceCommit {
    schemaVersion: 1;
    projectId: string;
    toolName: EditorMutationToolName;
    commandId: string;
    transaction: {
        walTransactionId: string;
        preparedAt: string;
        operationIds: string[];
        fromDocumentRevision: number;
        toDocumentRevision: number;
    };
    sessionState: {
        sessionEpoch: string;
        sessionRevision: number;
        eventSequence: number;
        projectName: string;
        documentRevision: number;
        audioGraphRevision: number;
        narrativeRevision?: number;
    };
    previous: EditorEngineSnapshot;
    next: EditorEngineSnapshot;
    history: EditorHistoryState;
    transcriptPins: {
        durableRecordIds: string[];
        historyRecordIds: string[];
        redoRecordIds: string[];
    };
    event: EditorEngineEvent | null;
    receipt: {
        toolName: EditorMutationToolName;
        key: string;
        value: EditorIdempotencyReceipt;
    };
}

/**
 * The single commit method is the engine's atomic durability boundary. Implementations must
 * publish snapshot, history, transcript pins, event, and receipt as one recoverable transaction.
 */
export interface EditorPersistencePort {
    getReceipt(
        projectId: string,
        toolName: EditorMutationToolName,
        idempotencyKey: string,
    ): Promise<EditorIdempotencyReceipt | null>;
    commit(input: EditorPersistenceCommit): Promise<void>;
    close?(): Promise<void>;
}

export interface EditorEventSink {
    emit(event: EditorEngineEvent): void | Promise<void>;
    close?(): Promise<void>;
}

export interface EditorPlaybackPort {
    onCommitted?(snapshot: EditorEngineSnapshot, event: EditorEngineEvent): void | Promise<void>;
    close?(): Promise<void>;
}

export interface EditorDiagnosticsPort {
    record?(entry: {
        kind: 'commit' | 'noop' | 'failure' | 'close';
        projectId: string;
        commandId?: string;
        message?: string;
    }): void;
    close?(): Promise<void>;
}

export interface EditorEnginePorts {
    persistence: EditorPersistencePort;
    assets: EditorAssetRepositoryPort;
    transcripts: EditorialTranscriptRepositoryPort<ResolvedEditorialTranscriptMapV1>;
    clock: EditorClock;
    ids: EditorIdGenerator;
    events: EditorEventSink;
    playback?: EditorPlaybackPort;
    diagnostics?: EditorDiagnosticsPort;
}

export class DeterministicEditorIdGenerator implements EditorIdGenerator {
    private readonly values = new Map<string, string>();
    private sequence = 0;

    constructor(private readonly prefix = 'test') {}

    generate(kind: string, scope: string): string {
        const key = `${kind}\u0000${scope}`;
        const existing = this.values.get(key);
        if (existing) return existing;
        this.sequence += 1;
        const value = `${this.prefix}-${kind}-${this.sequence}`;
        this.values.set(key, value);
        return value;
    }
}

export class FixedEditorClock implements EditorClock {
    constructor(private value: { iso: string; epochMs: number }) {}

    now(): { iso: string; epochMs: number } {
        return { ...this.value };
    }

    set(value: { iso: string; epochMs: number }): void {
        this.value = value;
    }
}
