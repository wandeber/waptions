import type { Subtitle } from '@/types/timeline';
import type { EditorDocumentV3, RationalFrameRate } from '@/types/video';
import { buildAudioMixPlan, type AudioMixContributorSourceRange } from './audio-mix-plan';
import { outputSampleToCoveringFrame } from './audio-timebase';
import {
    getAudioMediaCacheKey,
    type AudioMediaCacheKey,
    type AudioMediaReference,
} from './media-asset-ref';

export interface AudibleAudioPlacement {
    /** The contributor ID is stable for one durable clip instance and never uses a bare source ID. */
    id: string;
    source: AudioMediaReference;
    sourceKey: AudioMediaCacheKey;
    contributorKind: 'embedded-video' | 'independent-audio';
    trackId: string | null;
    projectStartFrame: number;
    projectEndFrame: number;
    projectStartSample: number;
    projectEndSample: number;
    sourceRange: AudioMixContributorSourceRange;
}

export interface AudioTranscriptionSourceJob {
    source: AudioMediaReference;
    sourceKey: AudioMediaCacheKey;
    placements: readonly AudibleAudioPlacement[];
}

export interface AudioTranscriptionPlan {
    sampleRate: 48_000;
    frameRate: RationalFrameRate;
    /** A stable, store-independent signature callers may retain beside their store-owned guard. */
    signature: string;
    sourceKeys: readonly AudioMediaCacheKey[];
    placements: readonly AudibleAudioPlacement[];
    sourceJobs: readonly AudioTranscriptionSourceJob[];
}

export interface AudioTranscriptionWordIdContext {
    namespace: string;
    sourceKey: AudioMediaCacheKey;
    placementId: string;
    sourceWordId: string;
    sourceWordIndex: number;
}

export type AudioTranscriptionWordIdFactory = (context: AudioTranscriptionWordIdContext) => string;

export interface MapAudioTranscriptionWordsOptions {
    idFactory?: AudioTranscriptionWordIdFactory;
    namespace?: string;
}

/**
 * Derives transcription work from the exact immutable graph used by preview and export.
 *
 * This is intentionally downstream of `buildAudioMixPlan`: linked video audio, detached audio,
 * imported clips, mute state, and effective solo filtering must never be reimplemented by the
 * transcription feature. Gain and fades stay out of this plan because they shape samples without
 * changing which source words are eligible for the edited timeline.
 */
export function buildAudioTranscriptionPlan(document: EditorDocumentV3): AudioTranscriptionPlan {
    const mixPlan = buildAudioMixPlan(document);
    const placements = mixPlan.contributors.map<AudibleAudioPlacement>((contributor) => {
        const sourceKey = getAudioMediaCacheKey(contributor.source);
        return {
            id: contributor.id,
            source: contributor.source,
            sourceKey,
            contributorKind: contributor.kind,
            trackId: contributor.trackId,
            // Contributor sample boundaries are canonical. Imported audio can end between output
            // frames, so the covering frame keeps that final partial frame visible to the caller.
            projectStartFrame: outputSampleToCoveringFrame(
                contributor.outputStartSample,
                document.renderProfile.fps,
                mixPlan.sampleRate,
            ),
            projectEndFrame: outputSampleToCoveringFrame(
                contributor.outputEndSample,
                document.renderProfile.fps,
                mixPlan.sampleRate,
            ),
            projectStartSample: contributor.outputStartSample,
            projectEndSample: contributor.outputEndSample,
            sourceRange: contributor.sourceRange,
        };
    });

    // A source is submitted to the provider once even when it is cropped, reused, overlapped, or
    // represented by both linked and detached placements. Typed keys keep the independent video
    // and audio catalogs isolated when they happen to allocate the same source ID.
    const jobsByKey = new Map<AudioMediaCacheKey, {
        source: AudioMediaReference;
        placements: AudibleAudioPlacement[];
    }>();
    placements.forEach((placement) => {
        const existing = jobsByKey.get(placement.sourceKey);
        if (existing) {
            existing.placements.push(placement);
        } else {
            jobsByKey.set(placement.sourceKey, {
                source: placement.source,
                placements: [placement],
            });
        }
    });
    const sourceJobs = Array.from(jobsByKey.entries()).map<AudioTranscriptionSourceJob>(([sourceKey, job]) => ({
        source: job.source,
        sourceKey,
        placements: job.placements,
    }));
    const sourceKeys = sourceJobs.map((job) => job.sourceKey);
    const signaturePayload = {
        sampleRate: mixPlan.sampleRate,
        frameRate: document.renderProfile.fps,
        placements: placements.map((placement) => ({
            id: placement.id,
            sourceKey: placement.sourceKey,
            contributorKind: placement.contributorKind,
            trackId: placement.trackId,
            projectStartSample: placement.projectStartSample,
            projectEndSample: placement.projectEndSample,
            sourceRange: placement.sourceRange,
        })),
    };

    return {
        sampleRate: mixPlan.sampleRate,
        frameRate: { ...document.renderProfile.fps },
        signature: `audio-transcription-v1:${hashStablePayload(JSON.stringify(signaturePayload))}`,
        sourceKeys,
        placements,
        sourceJobs,
    };
}

/**
 * Maps provider words from each typed source through every audible crop and placement.
 *
 * Source timestamps stay in seconds because transcription providers operate in media time. Native
 * sample crops are converted by their declared sample rate, while project placement uses the exact
 * canonical 48 kHz boundaries from the mix graph. Reused and overlapping clips deliberately emit
 * distinct words with IDs derived from placement ownership rather than copying provider IDs.
 */
export function mapAudioTranscriptionWords(
    plan: AudioTranscriptionPlan,
    wordsBySourceKey: ReadonlyMap<AudioMediaCacheKey, readonly Subtitle[]>,
    options: MapAudioTranscriptionWordsOptions = {},
): Subtitle[] {
    const idFactory = options.idFactory ?? createDeterministicAudioTranscriptionWordId;
    // The plan signature makes IDs fresh after a real audible-graph edit while preserving fully
    // deterministic output when the same immutable plan and provider response are mapped again.
    const namespace = options.namespace ?? `standard:${plan.signature}`;
    return plan.placements.flatMap((placement) => mapWordsToAudiblePlacement(
        wordsBySourceKey.get(placement.sourceKey) ?? [],
        placement,
        plan.sampleRate,
        { idFactory, namespace },
    )).sort(compareMappedWords);
}

/**
 * Shared placement mapper used by both standard and premium transcription paths.
 * Keeping this function public lets premium grouping preserve provider containers without owning a
 * second crop/placement implementation that could drift from the standard path.
 */
export function mapWordsToAudiblePlacement(
    words: readonly Subtitle[],
    placement: AudibleAudioPlacement,
    projectSampleRate: number,
    options: Required<MapAudioTranscriptionWordsOptions>,
): Subtitle[] {
    const sourceBounds = getSourceRangeSeconds(placement.sourceRange);
    const projectStart = placement.projectStartSample / projectSampleRate;
    const projectEnd = placement.projectEndSample / projectSampleRate;

    return words.flatMap((word, sourceWordIndex) => {
        if (!Number.isFinite(word.startTime)
            || !Number.isFinite(word.endTime)
            || word.endTime <= word.startTime
        ) {
            return [];
        }
        const retainedStart = Math.max(word.startTime, sourceBounds.startTime);
        const retainedEnd = Math.min(word.endTime, sourceBounds.endTime);
        if (retainedEnd <= retainedStart) return [];

        // Clamp after translating source time as well. The output sample span may differ from the
        // ideal native duration by one resampling sample, and no subtitle may escape that canonical
        // half-open project placement because of the boundary rounding.
        const startTime = Math.max(
            projectStart,
            Math.min(projectEnd, projectStart + retainedStart - sourceBounds.startTime),
        );
        const endTime = Math.max(
            projectStart,
            Math.min(projectEnd, projectStart + retainedEnd - sourceBounds.startTime),
        );
        if (endTime <= startTime) return [];

        return [{
            ...word,
            id: options.idFactory({
                namespace: options.namespace,
                sourceKey: placement.sourceKey,
                placementId: placement.id,
                sourceWordId: word.id,
                sourceWordIndex,
            }),
            startTime,
            endTime,
        }];
    }).sort(compareMappedWords);
}

export function getSourceRangeSeconds(range: AudioMixContributorSourceRange): {
    startTime: number;
    endTime: number;
} {
    if (range.domain === 'seconds') {
        return { startTime: range.startSeconds, endTime: range.endSeconds };
    }
    return {
        startTime: range.startSample / range.sampleRate,
        endTime: range.endSample / range.sampleRate,
    };
}

export function createDeterministicAudioTranscriptionWordId(
    context: AudioTranscriptionWordIdContext,
): string {
    const identity = [
        context.namespace,
        context.sourceKey,
        context.placementId,
        context.sourceWordId,
        String(context.sourceWordIndex),
    ].join('\u0000');
    return `transcription-${hashStablePayload(identity)}`;
}

function compareMappedWords(left: Subtitle, right: Subtitle): number {
    return left.startTime - right.startTime
        || left.endTime - right.endTime
        || left.id.localeCompare(right.id);
}

function hashStablePayload(payload: string): string {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < payload.length; index += 1) {
        const code = payload.charCodeAt(index);
        first ^= code;
        first = Math.imul(first, 0x01000193) >>> 0;
        second ^= code + index;
        second = Math.imul(second, 0x85ebca6b) >>> 0;
    }
    return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}
