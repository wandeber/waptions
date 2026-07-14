import type { Subtitle } from '@/types/timeline';
import type { TrackTranscriptionState, VideoClip, VideoSourceAsset } from '@/types/video';
import {
    createDeterministicAudioTranscriptionWordId,
    mapAudioTranscriptionWords,
    mapWordsToAudiblePlacement,
    type AudioTranscriptionPlan,
    type AudioTranscriptionWordIdFactory,
} from './audio-transcription-plan';
import type { AudioMediaCacheKey } from './media-asset-ref';
import { buildClipPlacements } from './video-timeline';

export interface OrderedTranscriptionGroup {
    id: string;
    words: readonly Subtitle[];
}

export interface SourcePremiumTranscription {
    raw: readonly Subtitle[];
    groups: readonly OrderedTranscriptionGroup[];
}

export interface MappedPremiumTranscription extends TrackTranscriptionState {
    timelineSubtitles: Subtitle[];
}

/**
 * Canonical standard-model mapping for the v3 audible graph.
 *
 * Callers submit one provider result per typed source job from `AudioTranscriptionPlan`. The plan
 * then expands those words through every audible occurrence; this keeps provider deduplication and
 * project placement mapping independent from store revision ownership.
 */
export function mapAudioTranscriptionPlanToProject(
    plan: AudioTranscriptionPlan,
    wordsBySourceKey: ReadonlyMap<AudioMediaCacheKey, readonly Subtitle[]>,
    idFactory?: AudioTranscriptionWordIdFactory,
): Subtitle[] {
    return mapAudioTranscriptionWords(plan, wordsBySourceKey, { idFactory });
}

/**
 * Canonical premium-model mapping for the v3 audible graph.
 *
 * Premium containers retain corrected provider grouping, but every group is mapped by the exact
 * same placement function as standard words. The store remains responsible for checking its
 * transcription job guard before applying this pure result to a subtitle lane.
 */
export function mapPremiumAudioTranscriptionPlanToProject(
    plan: AudioTranscriptionPlan,
    transcriptionBySourceKey: ReadonlyMap<AudioMediaCacheKey, SourcePremiumTranscription>,
    idFactory?: AudioTranscriptionWordIdFactory,
): MappedPremiumTranscription {
    const mappedGroupCandidates: Array<{
        sourceKey: AudioMediaCacheKey;
        placementId: string;
        groupId: string;
        groupIndex: number;
        words: Subtitle[];
    }> = [];

    plan.placements.forEach((placement) => {
        const sourceTranscription = transcriptionBySourceKey.get(placement.sourceKey);
        if (!sourceTranscription) return;
        // Corrected groups are the premium source of truth. Raw remains a defensive fallback when
        // a provider returns a valid word list but unexpectedly omits its grouping metadata.
        const orderedGroups = sourceTranscription.groups.length > 0
            ? sourceTranscription.groups
            : sourceTranscription.raw.length > 0
                ? [{ id: 'fallback', words: sourceTranscription.raw }]
                : [];
        orderedGroups.forEach((group, groupIndex) => {
            const namespace = `premium:${plan.signature}:${group.id}:${groupIndex}`;
            const words = mapWordsToAudiblePlacement(
                group.words,
                placement,
                plan.sampleRate,
                {
                    idFactory: idFactory ?? createDeterministicAudioTranscriptionWordId,
                    namespace,
                },
            );
            if (words.length === 0) return;
            mappedGroupCandidates.push({
                sourceKey: placement.sourceKey,
                placementId: placement.id,
                groupId: group.id,
                groupIndex,
                words,
            });
        });
    });

    // Track order is not timeline order when independent audio overlaps. Sorting completed group
    // placements before assigning containers keeps raw/group/timeline provenance deterministic.
    mappedGroupCandidates.sort((left, right) => (
        left.words[0].startTime - right.words[0].startTime
        || left.words[left.words.length - 1].endTime - right.words[right.words.length - 1].endTime
        || left.placementId.localeCompare(right.placementId)
        || left.groupIndex - right.groupIndex
    ));

    const raw: Subtitle[] = [];
    const groups: Record<string, Subtitle[]> = {};
    const containerIds: string[] = [];
    const timelineSubtitles: Subtitle[] = [];
    mappedGroupCandidates.forEach((candidate) => {
        const identityBase = {
            namespace: `premium-container:${plan.signature}:${candidate.groupId}:${candidate.groupIndex}`,
            sourceKey: candidate.sourceKey,
            placementId: candidate.placementId,
            sourceWordId: candidate.words.map((word) => word.id).join('|'),
            sourceWordIndex: 0,
        };
        const stableFactory = idFactory ?? createDeterministicAudioTranscriptionWordId;
        const containerId = `container-${stableFactory(identityBase)}`;
        const timelineSubtitleId = stableFactory({
            ...identityBase,
            namespace: `premium-timeline:${plan.signature}:${candidate.groupId}:${candidate.groupIndex}`,
        });
        groups[containerId] = candidate.words;
        containerIds.push(containerId);
        raw.push(...candidate.words);
        timelineSubtitles.push({
            id: timelineSubtitleId,
            startTime: candidate.words[0].startTime,
            endTime: candidate.words[candidate.words.length - 1].endTime,
            text: candidate.words.map((word) => word.text).join(' '),
        });
    });

    return { raw, groups, containerIds, timelineSubtitles };
}

/** Returns each audible source used by a clip once, preserving first-use order. */
export function getUsedAudibleSources(
    videoSources: readonly VideoSourceAsset[],
    videoClips: readonly VideoClip[],
): VideoSourceAsset[] {
    const sourcesById = new Map(videoSources.map((source) => [source.id, source]));
    const seen = new Set<string>();
    return videoClips.flatMap((clip) => {
        if (seen.has(clip.sourceId)) return [];
        seen.add(clip.sourceId);
        const source = sourcesById.get(clip.sourceId);
        return source?.hasAudio ? [source] : [];
    });
}

/**
 * Filters source-time words through every clip instance and remaps the retained intersections
 * onto the gapless project timeline. Reused source ranges intentionally receive fresh IDs so
 * every visible word remains independently editable.
 */
export function mapSourceWordsToProject(
    wordsBySourceId: ReadonlyMap<string, readonly Subtitle[]>,
    videoClips: readonly VideoClip[],
    idFactory: () => string = () => crypto.randomUUID(),
): Subtitle[] {
    const mapped = buildClipPlacements(videoClips).flatMap((placement) => {
        const words = wordsBySourceId.get(placement.clip.sourceId) ?? [];
        return words.flatMap((word) => {
            const retainedStart = Math.max(word.startTime, placement.clip.sourceStart);
            const retainedEnd = Math.min(word.endTime, placement.clip.sourceEnd);
            if (retainedEnd <= retainedStart) return [];

            return [{
                ...word,
                id: idFactory(),
                startTime: placement.projectStart + retainedStart - placement.clip.sourceStart,
                endTime: placement.projectStart + retainedEnd - placement.clip.sourceStart,
            }];
        });
    });

    return mapped.sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
}

/**
 * Maps premium corrected groups through every active clip occurrence.
 *
 * Group words, rather than the provider's stale raw words, are the canonical corrected output.
 * Each retained group/clip intersection receives fresh word, container, and timeline subtitle IDs,
 * so split ranges and reused source intervals remain independently editable and validation-safe.
 */
export function mapPremiumTranscriptionToProject(
    transcriptionBySourceId: ReadonlyMap<string, SourcePremiumTranscription>,
    videoClips: readonly VideoClip[],
    projectFps: number,
    idFactory: () => string = () => crypto.randomUUID(),
): MappedPremiumTranscription {
    if (!Number.isFinite(projectFps) || projectFps <= 0) {
        throw new Error('Project FPS must be positive and finite.');
    }
    const frameDuration = 1 / projectFps;
    const snapTime = (time: number) => Math.round(time / frameDuration) * frameDuration;
    const raw: Subtitle[] = [];
    const groups: Record<string, Subtitle[]> = {};
    const containerIds: string[] = [];
    const timelineSubtitles: Subtitle[] = [];

    buildClipPlacements(videoClips).forEach((placement) => {
        const sourceTranscription = transcriptionBySourceId.get(placement.clip.sourceId);
        if (!sourceTranscription) return;

        // Premium providers should return corrected groups. Falling back to raw preserves output
        // when a provider unexpectedly omits groups without changing standard-model behavior.
        const orderedGroups = sourceTranscription.groups.length > 0
            ? sourceTranscription.groups
            : sourceTranscription.raw.length > 0
                ? [{ id: 'fallback', words: sourceTranscription.raw }]
                : [];

        orderedGroups.forEach((group) => {
            const mappedWords = group.words.flatMap((word) => {
                const retainedStart = Math.max(word.startTime, placement.clip.sourceStart);
                const retainedEnd = Math.min(word.endTime, placement.clip.sourceEnd);
                if (retainedEnd <= retainedStart) return [];

                const startTime = snapTime(
                    placement.projectStart + retainedStart - placement.clip.sourceStart,
                );
                const endTime = snapTime(
                    placement.projectStart + retainedEnd - placement.clip.sourceStart,
                );
                // Premium uses the same sticky project grid as standard transcription. Filtering
                // here ensures raw, groups, and final subtitles can never disagree about words
                // whose provider interval collapses to zero after frame snapping.
                if (endTime <= startTime) return [];

                return [{
                    ...word,
                    id: idFactory(),
                    startTime,
                    endTime,
                }];
            });
            if (mappedWords.length === 0) return;

            const containerId = `container-${idFactory()}`;
            groups[containerId] = mappedWords;
            containerIds.push(containerId);
            raw.push(...mappedWords);
            timelineSubtitles.push({
                id: idFactory(),
                startTime: mappedWords[0].startTime,
                endTime: mappedWords[mappedWords.length - 1].endTime,
                text: mappedWords.map((word) => word.text).join(' '),
            });
        });
    });

    return { raw, groups, containerIds, timelineSubtitles };
}
