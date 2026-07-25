import { getEditorialTargetKey } from '@/lib/editorial-links';
import { getVideoClipDurationFramesV4 } from '@/lib/video-placement-v4';
import { framesToSeconds } from '@/lib/render-profile';
import type {
    EditorialDependentLinkV1,
    NarrativeBlockV1,
    NarrativeDocumentV1,
    ResolvedEditorialTranscriptMapV1,
    ResolvedEditorialTranscriptRecordBodyV1,
} from '@/types/editorial';
import type { RenderProfile, VideoClipV4, VideoTrackV4 } from '@/types/video';

export const NARRATIVE_BLOCK_ROW_HEIGHT = 136;
export const NARRATIVE_GAP_ROW_HEIGHT = 34;
export const NARRATIVE_VIRTUAL_OVERSCAN_PX = NARRATIVE_BLOCK_ROW_HEIGHT * 3;

export interface NarrativeWordView {
    id: string;
    immutableText: string;
    displayText: string;
    corrected: boolean;
    editableStartSample: number;
    editableEndSample: number;
    speakerId: string | null;
    speakerLabel: string | null;
}

export interface NarrativeLinkCounts {
    video: number;
    audio: number;
    subtitle: number;
    exactBound: number;
    overlapLinked: number;
    following: number;
}

export interface NarrativeBlockRow {
    kind: 'block';
    id: string;
    top: number;
    height: number;
    block: NarrativeBlockV1;
    trackLabel: string;
    trackIndex: number;
    projectEndFrame: number;
    durationFrames: number;
    hydration: 'hydrated' | 'missing';
    words: NarrativeWordView[];
    silenceLabel: 'Silence' | 'No audio' | 'Untranscribed audio' | null;
    linkCounts: NarrativeLinkCounts;
}

export interface NarrativeGapRow {
    kind: 'gap';
    id: string;
    top: number;
    height: number;
    startFrame: number;
    endFrame: number;
}

export type NarrativeListRow = NarrativeBlockRow | NarrativeGapRow;

export interface NarrativeListProjection {
    rows: NarrativeListRow[];
    totalHeight: number;
    blockRowById: ReadonlyMap<string, NarrativeBlockRow>;
}

interface BuildNarrativeListProjectionInput {
    narrative: NarrativeDocumentV1;
    bodies: ResolvedEditorialTranscriptMapV1;
    videoClips: readonly VideoClipV4[];
    videoTracks: readonly VideoTrackV4[];
    dependentLinks: readonly EditorialDependentLinkV1[];
    renderProfile: RenderProfile;
}

/**
 * Joins the descriptor-only narrative with verified runtime bodies for presentation.
 *
 * The returned rows contain only immutable references and derived display values. They are rebuilt
 * from the canonical store/runtime authorities and must never be written back as another transcript
 * document. Explicit project gaps become lightweight rows; they are not labelled as source silence.
 */
export function buildNarrativeListProjection(
    input: BuildNarrativeListProjectionInput,
): NarrativeListProjection {
    const clipsById = new Map(input.videoClips.map((clip) => [clip.id, clip]));
    const trackIndexById = new Map(input.videoTracks.map((track, index) => [track.id, index]));
    const linksByAnchor = new Map<string, EditorialDependentLinkV1[]>();
    input.dependentLinks.forEach((link) => {
        const current = linksByAnchor.get(link.anchorBlockId) ?? [];
        current.push(link);
        linksByAnchor.set(link.anchorBlockId, current);
    });

    const rows: NarrativeListRow[] = [];
    const blockRowById = new Map<string, NarrativeBlockRow>();
    let top = 0;
    let previousEndFrame = 0;

    input.narrative.blockIds.forEach((blockId, blockIndex) => {
        const block = input.narrative.blocks[blockId];
        const clip = clipsById.get(block.clipId);
        if (!clip) return;
        const durationFrames = getVideoClipDurationFramesV4(clip, input.renderProfile);
        const projectEndFrame = block.timelineStartFrame + durationFrames;
        if (block.timelineStartFrame > previousEndFrame) {
            const gap: NarrativeGapRow = {
                kind: 'gap',
                id: `timeline-gap:${previousEndFrame}:${block.timelineStartFrame}:${blockIndex}`,
                top,
                height: NARRATIVE_GAP_ROW_HEIGHT,
                startFrame: previousEndFrame,
                endFrame: block.timelineStartFrame,
            };
            rows.push(gap);
            top += gap.height;
        }

        const body = input.bodies[block.transcriptRecordId];
        const row: NarrativeBlockRow = {
            kind: 'block',
            id: block.id,
            top,
            height: NARRATIVE_BLOCK_ROW_HEIGHT,
            block,
            trackLabel: input.videoTracks.find((track) => track.id === block.trackId)?.name
                ?? 'Missing video track',
            trackIndex: trackIndexById.get(block.trackId) ?? -1,
            projectEndFrame,
            durationFrames,
            hydration: body ? 'hydrated' : 'missing',
            words: body && block.kind === 'speech' ? buildWordViews(block, body) : [],
            silenceLabel: getNarrativeSilenceLabel(block),
            linkCounts: countNarrativeLinks(linksByAnchor.get(block.id) ?? []),
        };
        rows.push(row);
        blockRowById.set(block.id, row);
        top += row.height;
        previousEndFrame = Math.max(previousEndFrame, projectEndFrame);
    });

    return { rows, totalHeight: top, blockRowById };
}

export function getVisibleNarrativeRows(
    projection: NarrativeListProjection,
    scrollTop: number,
    viewportHeight: number,
    overscanPx = NARRATIVE_VIRTUAL_OVERSCAN_PX,
): NarrativeListRow[] {
    const visibleStart = Math.max(0, scrollTop - overscanPx);
    const visibleEnd = Math.max(visibleStart, scrollTop + viewportHeight + overscanPx);
    return projection.rows.filter((row) => (
        row.top + row.height >= visibleStart && row.top <= visibleEnd
    ));
}

export function chooseDefaultEditorialTrackIds(
    tracks: readonly Pick<VideoTrackV4, 'id' | 'locked'>[],
    clips: readonly Pick<VideoClipV4, 'trackId' | 'audio'>[],
): string[] {
    const firstAudible = tracks.find((track) => !track.locked && clips.some((clip) => (
        clip.trackId === track.id
        && clip.audio !== null
        && clip.audio.linkState === 'linked'
        && !clip.audio.muted
    )));
    const fallback = tracks.find((track) => !track.locked);
    return firstAudible || fallback ? [(firstAudible ?? fallback)!.id] : [];
}

export function getNarrativeSilenceLabel(
    block: NarrativeBlockV1,
): NarrativeBlockRow['silenceLabel'] {
    if (block.kind !== 'silence') return null;
    if (block.evidence === 'quiet') return 'Silence';
    if (block.evidence === 'no-audio') return 'No audio';
    return 'Untranscribed audio';
}

export interface SilenceDeletionSummary {
    count: number;
    durationFrames: number;
}

export function summarizeSilenceDeletion(input: {
    narrative: NarrativeDocumentV1;
    videoClips: readonly VideoClipV4[];
    renderProfile: RenderProfile;
    trackId?: string;
}): SilenceDeletionSummary {
    const clipsById = new Map(input.videoClips.map((clip) => [clip.id, clip]));
    return input.narrative.blockIds.reduce<SilenceDeletionSummary>((summary, blockId) => {
        const block = input.narrative.blocks[blockId];
        if (block.kind !== 'silence' || (input.trackId && block.trackId !== input.trackId)) {
            return summary;
        }
        const clip = clipsById.get(block.clipId);
        if (!clip) return summary;
        return {
            count: summary.count + 1,
            durationFrames: summary.durationFrames
                + getVideoClipDurationFramesV4(clip, input.renderProfile),
        };
    }, { count: 0, durationFrames: 0 });
}

export function getSelectedWordBounds(
    row: NarrativeBlockRow,
    selectedWordIds: readonly string[],
): { firstWordId: string; lastWordId: string; startSample: number; endSample: number } | null {
    if (selectedWordIds.length === 0) return null;
    const selected = new Set(selectedWordIds);
    const words = row.words.filter((word) => selected.has(word.id));
    if (words.length === 0) return null;
    return {
        firstWordId: words[0].id,
        lastWordId: words[words.length - 1].id,
        startSample: words[0].editableStartSample,
        endSample: words[words.length - 1].editableEndSample,
    };
}

export function getBlockSplitSample(
    row: NarrativeBlockRow,
    selectedWordIds: readonly string[],
): number | null {
    const selectedBounds = getSelectedWordBounds(row, selectedWordIds);
    const requested = selectedBounds?.startSample
        ?? Math.round((row.block.coreStartSample + row.block.coreEndSample) / 2);
    return requested > row.block.coreStartSample && requested < row.block.coreEndSample
        ? requested
        : null;
}

/**
 * Resolves a Timeline playhead gesture to a valid source-domain split boundary.
 *
 * Speech uses the nearest retained word edge so the Timeline cannot bypass the narrative word
 * invariant. Source-backed silence has no word identity and therefore uses the nearest contained
 * 16 kHz sample. The chosen value is always strictly inside the selected occurrence.
 */
export function getTimelineNarrativeSplitSample(input: {
    row: NarrativeBlockRow;
    body: ResolvedEditorialTranscriptRecordBodyV1 | undefined;
    sourceFps: number;
    playheadFrame: number;
    renderProfile: RenderProfile;
}): number | null {
    const { block } = input.row;
    if (block.coreEndSample - block.coreStartSample <= 1) return null;
    const relativeFrame = Math.max(
        0,
        Math.min(input.row.durationFrames - 1, input.playheadFrame - block.timelineStartFrame),
    );
    const sourceFrame = block.materialization.sourceStartFrame
        + Math.round(framesToSeconds(relativeFrame, input.renderProfile.fps) * input.sourceFps);
    const approximateSample = Math.round(sourceFrame * 16_000 / input.sourceFps);
    const containedSample = Math.max(
        block.coreStartSample + 1,
        Math.min(block.coreEndSample - 1, approximateSample),
    );
    if (block.kind === 'silence') return containedSample;
    const retainedWords = new Set(block.sourceWordIds);
    const candidates = (input.body?.words ?? [])
        .filter((word) => retainedWords.has(word.id))
        .flatMap((word) => [word.editableStartSample, word.editableEndSample])
        .filter((sample) => sample > block.coreStartSample && sample < block.coreEndSample);
    if (candidates.length === 0) return null;
    return candidates.reduce((closest, sample) => (
        Math.abs(sample - containedSample) < Math.abs(closest - containedSample) ? sample : closest
    ));
}

export function getTargetStatusLabel(
    targetKey: string,
    links: readonly EditorialDependentLinkV1[],
    ownedTargetKeys: ReadonlySet<string>,
): 'Controlled' | 'Exact bound' | 'Overlap linked' | 'Unlinked' {
    if (ownedTargetKeys.has(targetKey)) return 'Controlled';
    const link = links.find((candidate) => getEditorialTargetKey(candidate.target) === targetKey);
    if (!link) return 'Unlinked';
    return link.association.kind === 'transcript-bound' ? 'Exact bound' : 'Overlap linked';
}

function buildWordViews(
    block: Extract<NarrativeBlockV1, { kind: 'speech' }>,
    body: ResolvedEditorialTranscriptRecordBodyV1,
): NarrativeWordView[] {
    const wordById = new Map(body.words.map((word) => [word.id, word]));
    const speakerById = new Map(body.speakers.map((speaker) => [speaker.id, speaker]));
    return block.sourceWordIds.flatMap((wordId) => {
        const word = wordById.get(wordId);
        if (!word) return [];
        const speakerId = block.speakerOverrides[word.id] ?? word.speakerId;
        return [{
            id: word.id,
            immutableText: word.text,
            displayText: block.wordTextOverrides[word.id] ?? word.text,
            corrected: Object.prototype.hasOwnProperty.call(block.wordTextOverrides, word.id),
            editableStartSample: word.editableStartSample,
            editableEndSample: word.editableEndSample,
            speakerId,
            speakerLabel: speakerId ? speakerById.get(speakerId)?.label ?? 'Unknown speaker' : null,
        }];
    });
}

function countNarrativeLinks(links: readonly EditorialDependentLinkV1[]): NarrativeLinkCounts {
    return links.reduce<NarrativeLinkCounts>((counts, link) => ({
        video: counts.video + (link.target.kind === 'video-clip' ? 1 : 0),
        audio: counts.audio + (link.target.kind === 'audio-clip' ? 1 : 0),
        subtitle: counts.subtitle + (link.target.kind === 'subtitle' ? 1 : 0),
        exactBound: counts.exactBound + (link.association.kind === 'transcript-bound' ? 1 : 0),
        overlapLinked: counts.overlapLinked + (link.association.kind === 'overlap' ? 1 : 0),
        following: counts.following + (link.followPolicy === 'follow' ? 1 : 0),
    }), {
        video: 0,
        audio: 0,
        subtitle: 0,
        exactBound: 0,
        overlapLinked: 0,
        following: 0,
    });
}
