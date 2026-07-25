import type {
    EditorialDirectTargetTransform,
    EditorialLinkError,
    EditorialLinkPlanNoop,
} from '@/lib/editorial-links';
import type {
    NarrativeActivationReport,
    NarrativeCommandError,
    NarrativeCommandNoop,
    NarrativePlayheadRecommendation,
    planChangeBlockMargin,
    planChangeGlobalMargins,
    planDeleteAllSilences,
    planDeleteNarrativeRange,
    planDeleteNarrativeWords,
    planExtendNarrativeBlock,
    planInsertSourceRange,
    planMergeNarrativeBlocks,
    planRecoverSourceRange,
    planRefineNarrativeBoundary,
    planReorderNarrativeBlocks,
    planSetNarrativeSpeakerVisibility,
    planSetNarrativeWordSpeaker,
    planSetNarrativeWordText,
    planSplitNarrativeBlock,
    planTrimNarrativeBlock,
} from '@/lib/narrative/commands';
import type {
    EditorialTranscriptionProgress,
} from '@/lib/editorial-transcription/orchestrator';
import type { RationalDuration } from '@/lib/editorial-transcription/pcm';
import type { EditorialTranscriptionPreferencesV1 } from '@/lib/editorial-transcription/preferences';
import type {
    EditorialDependentTargetV1,
    GlobalEditingMode,
} from '@/types/editorial';

type PlannerInput<T> = T extends (input: infer Input) => unknown ? Input : never;
type NarrativePayload<T> = Omit<
    PlannerInput<T>,
    'document' | 'guard' | 'bodies' | 'idFactory' | 'nowIso'
>;

/**
 * Store-owned terminal activation stage emitted after verified body hydration and before the pure
 * narrative materializer runs. It is aggregate work, so it deliberately carries no fabricated
 * source index, cache-hit value, or percentage.
 */
export interface TimelineNarrativeBuildProgress {
    stage: 'building-text-edit';
    sourceCount: number;
}

export type TimelineNarrativeActivationProgress =
    | EditorialTranscriptionProgress
    | TimelineNarrativeBuildProgress;

/** Inputs needed before the pure activation planner can publish narrative ownership. */
export interface ActivateNarrativeRequest {
    selectedTrackIds: string[];
    preferences: EditorialTranscriptionPreferencesV1;
    /** Session-only credential. It is passed directly to acquisition and never enters Zustand. */
    apiKey?: string;
    signal?: AbortSignal;
    regenerate?: boolean;
    splitOnSpeakerChange?: boolean;
    /** Prefer exact demuxer/container duration rationals when a caller has them. */
    declaredDurationBySourceId?: Readonly<Record<string, RationalDuration>>;
    expectedDocumentRevision?: number;
    expectedMode?: GlobalEditingMode;
    expectedNarrativeRevision?: number;
    onProgress?: (progress: TimelineNarrativeActivationProgress) => void;
}

/** Every pure WP4 command exposed through the single Timeline-store transaction boundary. */
export type TimelineNarrativeCommand =
    | ({ type: 'split-block' } & NarrativePayload<typeof planSplitNarrativeBlock>)
    | ({ type: 'merge-blocks' } & NarrativePayload<typeof planMergeNarrativeBlocks>)
    | ({ type: 'delete-words' } & NarrativePayload<typeof planDeleteNarrativeWords>)
    | ({ type: 'delete-range' } & NarrativePayload<typeof planDeleteNarrativeRange>)
    | ({ type: 'trim-block' } & NarrativePayload<typeof planTrimNarrativeBlock>)
    | ({ type: 'reorder-blocks' } & NarrativePayload<typeof planReorderNarrativeBlocks>)
    | ({ type: 'insert-source-range' } & NarrativePayload<typeof planInsertSourceRange>)
    | ({ type: 'recover-source-range' } & NarrativePayload<typeof planRecoverSourceRange>)
    | ({ type: 'extend-block' } & NarrativePayload<typeof planExtendNarrativeBlock>)
    | ({ type: 'set-word-text' } & NarrativePayload<typeof planSetNarrativeWordText>)
    | ({ type: 'set-word-speaker' } & NarrativePayload<typeof planSetNarrativeWordSpeaker>)
    | ({ type: 'set-speaker-visibility' } & NarrativePayload<typeof planSetNarrativeSpeakerVisibility>)
    | ({ type: 'change-block-margin' } & NarrativePayload<typeof planChangeBlockMargin>)
    | ({ type: 'change-global-margins' } & NarrativePayload<typeof planChangeGlobalMargins>)
    | ({ type: 'refine-boundary' } & NarrativePayload<typeof planRefineNarrativeBoundary>)
    | ({ type: 'delete-all-silences' } & NarrativePayload<typeof planDeleteAllSilences>);

export type TimelineEditorialLinkCommand =
    | { type: 'discover-overlaps' }
    | {
        type: 'create-overlap-link';
        target: EditorialDependentTargetV1;
        anchorBlockId: string;
        followPolicy?: 'none' | 'follow';
    }
    | {
        type: 'bind-target';
        target: EditorialDependentTargetV1;
        anchorBlockId: string;
        activeStartSample: number;
        activeEndSample: number;
        followPolicy?: 'none' | 'follow';
    }
    | { type: 'unlink-target'; target: EditorialDependentTargetV1 }
    | { type: 'unbind-target'; target: EditorialDependentTargetV1 }
    | {
        type: 'reanchor-link';
        target: EditorialDependentTargetV1;
        anchorBlockId: string;
    }
    | {
        type: 'set-follow-policy';
        target: EditorialDependentTargetV1;
        followPolicy: 'none' | 'follow';
    };

/**
 * Project-time units follow each durable target contract: video uses output frames, while audio
 * and subtitle targets use fixed 48 kHz output samples. This keeps imported-audio trim duration
 * exact even when its visible start must be projected to the nearest covering output frame.
 */
export interface TimelineOrdinaryCommand {
    target: EditorialDependentTargetV1;
    action:
        | { kind: 'delete' }
        | { kind: 'resize'; start: number; end: number }
        | { kind: 'move'; targetTrackId: string; targetStart: number }
        | { kind: 'split'; at: number; childId: string };
}

export interface TimelineCommandError {
    code: string;
    message: string;
    ids: string[];
}

export type TimelineV4CommandResult =
    | {
        kind: 'success';
        command: string;
        playhead: NarrativePlayheadRecommendation;
        activationReport?: NarrativeActivationReport;
        silenceDeletionReport?: {
            scope: 'document' | { trackId: string };
            count: number;
            durationFrames: number;
            consequence: GlobalEditingMode;
        };
        targetTransforms?: EditorialDirectTargetTransform[];
    }
    | NarrativeCommandNoop
    | EditorialLinkPlanNoop
    | { kind: 'error'; error: TimelineCommandError | NarrativeCommandError | EditorialLinkError };
