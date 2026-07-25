import type { AudioGraphMutationImpact } from '@/lib/audio-graph-signature';
import { frameRateToNumber } from '@/lib/render-profile';
import type { TimelineStore } from './timeline-store-types';
import {
    finalizeDurableTimelinePatch,
} from './timeline-store-snapshot';
import { recordTimelineHistory } from './timeline-history';
import { selectTimelineHistoryProjection } from './timeline-history-projection';
import type { TimelineHistoryMetadata } from './timeline-store-types';

export interface DurableTimelineMutationOptions {
    impact?: AudioGraphMutationImpact;
    recordHistory?: boolean;
    /** Marks temporal/structural edits that can invalidate the cached terminal content frame. */
    recalculateContentBoundary?: boolean;
    /** Required semantic identity for every command that records undo history. */
    history?: TimelineHistoryMetadata;
}

/**
 * Produces the complete Zustand patch for one durable editor command.
 *
 * The equality check inspects only durable fields supplied by the command. This lets pointer noise
 * and normalized values terminate without consuming history or persistence work, and avoids a
 * whole-project serialization for edits that touch a single lane or render setting.
 */
export function prepareDurableTimelineMutation(
    state: TimelineStore,
    patch: Partial<TimelineStore>,
    options: DurableTimelineMutationOptions = {},
): Partial<TimelineStore> | null {
    const canonicalPatch = Object.prototype.hasOwnProperty.call(patch, 'renderProfile')
        && patch.renderProfile
        ? { ...patch, projectFps: frameRateToNumber(patch.renderProfile.fps) }
        : patch;
    if (durableTimelinePatchIsNoOp(state, canonicalPatch)) return null;

    const impact = options.impact ?? 'preserve-transcription';
    const recalculatesContentBoundary = options.recalculateContentBoundary === true;
    const finalized = finalizeDurableTimelinePatch(
        state,
        canonicalPatch,
        impact,
        recalculatesContentBoundary,
    );
    if (options.recordHistory === false) return finalized;

    if (!options.history?.label.trim()) {
        throw new Error('Durable timeline mutations must provide a semantic history label.');
    }

    const after = { ...state, ...finalized } as TimelineStore;
    const boundedHistory = recordTimelineHistory(
        state,
        selectTimelineHistoryProjection(state),
        selectTimelineHistoryProjection(after),
        {
            metadata: options.history,
            impact,
            recalculatesContentBoundary,
        },
    );
    // A structurally cloned command can pass the cheap identity guard while still producing no
    // material patch. Do not publish its finalized revision or enqueue persistence in that case.
    if (boundedHistory === state) return null;
    return {
        ...finalized,
        ...boundedHistory,
    };
}

export function durableTimelinePatchIsNoOp(
    state: TimelineStore,
    patch: Partial<TimelineStore>,
): boolean {
    return DURABLE_STATE_KEYS.every((key) => {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) return true;
        const currentValue = state[key];
        const nextValue = patch[key];
        if (Object.is(currentValue, nextValue)) return true;
        if (key === 'renderProfile') {
            return renderProfilesEqual(
                state.renderProfile,
                patch.renderProfile ?? state.renderProfile,
            );
        }
        return false;
    });
}

// This list mirrors EditorManifestV4. Selection, drag state, the derived runtime FPS mirror,
// scroll, clipboard, and legacy transcription mirrors never create a persistence transaction by
// themselves. Comparing only fields present in the patch avoids serializing the whole project for
// every pointer update while retaining normalized-value no-op detection.
const DURABLE_STATE_KEYS = [
    'tracks',
    'renderProfile',
    'renderBackgroundColor',
    'videoSources',
    'videoClips',
    'videoTracks',
    'audioSources',
    'audioTracks',
    'activeTrackId',
    'transcriptionByTrackId',
    'globalEditingMode',
    'editorialTranscriptDescriptors',
    'narrative',
    'dependentLinks',
] as const satisfies readonly (keyof TimelineStore)[];

const renderProfilesEqual = (
    left: TimelineStore['renderProfile'],
    right: TimelineStore['renderProfile'],
): boolean => left.width === right.width
    && left.height === right.height
    && left.audioSampleRate === right.audioSampleRate
    && left.isFrameRateLocked === right.isFrameRateLocked
    && left.isCanvasSizeLocked === right.isCanvasSizeLocked
    && left.fps.numerator === right.fps.numerator
    && left.fps.denominator === right.fps.denominator;
