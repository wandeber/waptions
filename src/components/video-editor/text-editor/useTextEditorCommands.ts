'use client';

import { useCallback, useState } from 'react';
import { useEditorTransactionCoordinator } from '@/components/video-editor/EditorTransactionContext';
import { framesToSeconds } from '@/lib/render-profile';
import { usePlaybackStore } from '@/stores/playback-store';
import { useTimelineStore } from '@/stores/timeline-store';
import type {
    TimelineEditorialLinkCommand,
    TimelineNarrativeCommand,
    TimelineV4CommandResult,
} from '@/stores/timeline-v4-command-types';
import type { GlobalEditingMode } from '@/types/editorial';

export interface TextEditorFeedback {
    tone: 'neutral' | 'success' | 'error';
    message: string;
}

export interface RunCommandOptions {
    structural?: boolean;
    successMessage?: string;
    noopMessage?: string;
}

/**
 * Shared UI adapter for every canonical WP6 command surface.
 *
 * Structural gestures first close any editor draft and pause playback. The store remains the sole
 * mutation/history authority; this adapter only announces its typed result and applies the returned
 * playhead recommendation after a successful commit.
 */
export function useTextEditorCommands() {
    const transactionCoordinator = useEditorTransactionCoordinator();
    const [feedback, setFeedback] = useState<TextEditorFeedback>({
        tone: 'neutral',
        message: '',
    });
    const [pending, setPending] = useState(false);

    const prepare = useCallback((structural: boolean) => {
        transactionCoordinator.prepareHistoryNavigation();
        if (structural) usePlaybackStore.getState().pause();
    }, [transactionCoordinator]);

    const finish = useCallback((
        result: TimelineV4CommandResult,
        options: RunCommandOptions,
    ): TimelineV4CommandResult => {
        if (result.kind === 'error') {
            setFeedback({ tone: 'error', message: result.error.message });
            return result;
        }
        if (result.kind === 'noop') {
            const message = options.noopMessage
                ?? (result.code === 'no-eligible-silence'
                    ? 'No source-backed silence is eligible in this scope.'
                    : result.code === 'no-linkable-overlap'
                        ? 'No target has one unambiguous greatest overlap.'
                        : 'The requested edit would not change the project.');
            setFeedback({ tone: 'neutral', message });
            return result;
        }

        if (result.playhead.kind === 'seek' && result.playhead.frame !== undefined) {
            const fps = useTimelineStore.getState().renderProfile.fps;
            usePlaybackStore.getState().seek(framesToSeconds(result.playhead.frame, fps));
        }
        setFeedback({
            tone: 'success',
            message: options.successMessage ?? describeSuccess(result),
        });
        return result;
    }, []);

    const runNarrative = useCallback(async (
        command: TimelineNarrativeCommand,
        options: RunCommandOptions = {},
    ) => {
        prepare(options.structural ?? true);
        setPending(true);
        try {
            const result = await useTimelineStore.getState().executeNarrativeCommand(command);
            return finish(result, options);
        } finally {
            setPending(false);
        }
    }, [finish, prepare]);

    const runLink = useCallback((
        command: TimelineEditorialLinkCommand,
        options: RunCommandOptions = {},
    ) => {
        prepare(options.structural ?? false);
        return finish(
            useTimelineStore.getState().executeEditorialLinkCommand(command),
            options,
        );
    }, [finish, prepare]);

    const runMode = useCallback((mode: GlobalEditingMode) => {
        prepare(false);
        return finish(useTimelineStore.getState().setGlobalEditingMode(mode), {
            structural: false,
            successMessage: mode === 'ripple'
                ? 'Ripple editing is active. Future structural edits close or open narrative time.'
                : 'Absolute editing is active. Future structural edits preserve unrelated starts.',
        });
    }, [finish, prepare]);

    const runRelease = useCallback(async (trackIds: string[]) => {
        prepare(true);
        setPending(true);
        try {
            const result = await useTimelineStore.getState().releaseNarrativeTracks(trackIds);
            return finish(result, {
                structural: true,
                successMessage: trackIds.length === 1
                    ? 'Track control released. Its current media remains in place.'
                    : 'Track control released. Current media remains in place.',
            });
        } finally {
            setPending(false);
        }
    }, [finish, prepare]);

    return {
        feedback,
        setFeedback,
        pending,
        runNarrative,
        runLink,
        runMode,
        runRelease,
    };
}

function describeSuccess(result: Extract<TimelineV4CommandResult, { kind: 'success' }>): string {
    if (result.silenceDeletionReport) {
        const { count, consequence } = result.silenceDeletionReport;
        return `${count} source-backed silence ${count === 1 ? 'block' : 'blocks'} deleted in ${consequence} mode.`;
    }
    const labels: Record<string, string> = {
        'split-text-block': 'Text block split without changing total montage duration.',
        'merge-text-blocks': 'Compatible adjacent blocks merged.',
        'delete-text-selection': 'Selected source-backed media deleted.',
        'trim-text-block': 'Text block trimmed.',
        'reorder-narrative': 'Narrative order updated.',
        'insert-source-range': 'Source range inserted as a new occurrence.',
        'recover-source-range': 'Deleted source range recovered as a new occurrence.',
        'extend-source-range': 'Source range extended.',
        'correct-word-text': 'Transcript correction saved without changing media timing.',
        'assign-word-speaker': 'Speaker presentation override saved.',
        'change-block-margins': 'Block margins updated.',
        'change-global-text-margins': 'Global text margins updated.',
        'refine-text-boundary': 'Boundary refinement saved.',
        'link-dependent': 'Dependent target linked.',
        'bind-target-to-transcript': 'Target bound to the exact transcript fragment.',
        'retarget-transcript-binding': 'Transcript binding retargeted.',
        'unbind-target-from-transcript': 'Transcript binding removed; target placement was preserved.',
        'unlink-dependent': 'Dependent link removed; target placement was preserved.',
        'toggle-dependent-follow': 'Dependent follow policy updated.',
    };
    return labels[result.command] ?? 'Edit applied.';
}
