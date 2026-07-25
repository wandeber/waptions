import {
    EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ,
    type MarginBoundaryPolicyV1,
    type MaterializedBoundaryPolicyV1,
    type NarrativeBlockV1,
    type NarrativeBlockCommonV1,
    type NarrativeDocumentV1,
    type NarrativeMaterializationV1,
    type NarrativeSilenceEvidenceV1,
    type ResolvedEditorialTranscriptRecordBodyV1,
} from '@/types/editorial';
import type {
    RationalFrameRate,
    VideoClipAudioSettings,
    VideoClipV4,
    VideoSourceDescriptorV3,
} from '@/types/video';
import { secondsToFrames } from '../render-profile';
import { getVideoClipDurationFramesV4 } from '../video-placement-v4';
import {
    classifyNoWordEvidence,
    deriveSourceAtoms,
    type SourceAtom,
} from './source-atoms';
import type { HalfOpenInterval } from './interval-algebra';

const NUMERICAL_GUARD = 1e-9;

export interface MaterializedActivationFragment {
    atom: SourceAtom;
    sourceStartFrame: number;
    sourceEndFrame: number;
    timelineStartFrame: number;
    timelineEndFrame: number;
    preBoundary: MaterializedBoundaryPolicyV1;
    postBoundary: MaterializedBoundaryPolicyV1;
}

export interface SplitNarrativeOccurrenceResult {
    leftBlock: NarrativeBlockV1;
    rightBlock: NarrativeBlockV1;
    leftClip: VideoClipV4;
    rightClip: VideoClipV4;
    seamId: string;
}

export interface MergeNarrativeOccurrenceResult {
    block: NarrativeBlockV1;
    clip: VideoClipV4;
    removedBlockId: string;
    removedClipId: string;
}

export interface SliceNarrativeOccurrenceResult {
    block: NarrativeBlockV1;
    clip: VideoClipV4;
}

export type MaterializerResult<T> =
    | { kind: 'success'; value: T }
    | {
        kind: 'error';
        code: 'source-bounds' | 'minimum-duration' | 'word-boundary' | 'incompatible-merge';
        message: string;
    };

export type SourceFrameRounding = 'floor' | 'nearest' | 'ceil';

/**
 * Canonical 16 kHz source-sample to native video-frame boundary conversion.
 *
 * The numerical guard exactly mirrors V4 margin validation. Source descriptors still expose a
 * scalar native FPS, so using the same guarded expression is more important than introducing a
 * second rationalization that the validator would subsequently disagree with.
 */
export function sourceSampleToVideoFrame(
    sample: number,
    sourceFps: number,
    rounding: SourceFrameRounding,
): number {
    assertSourceSample(sample);
    assertPositiveFinite(sourceFps, 'sourceFps');
    const exact = sample * sourceFps / EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ;
    const frame = rounding === 'floor'
        ? Math.floor(exact + NUMERICAL_GUARD)
        : rounding === 'ceil'
            ? Math.ceil(exact - NUMERICAL_GUARD)
            : Math.floor(exact + 0.5 + NUMERICAL_GUARD);
    if (!Number.isSafeInteger(frame) || frame < 0) {
        throw new RangeError('Source frame must fit in a non-negative safe integer.');
    }
    return frame;
}

export function getDeterministicSourceEndFrame(
    source: Pick<VideoSourceDescriptorV3, 'duration' | 'fps'>,
): number {
    assertPositiveFinite(source.duration, 'source.duration');
    assertPositiveFinite(source.fps, 'source.fps');
    const frame = Math.max(1, Math.ceil(source.duration * source.fps - NUMERICAL_GUARD));
    if (!Number.isSafeInteger(frame)) throw new RangeError('Source tail exceeds the safe frame domain.');
    return frame;
}

/**
 * Inverts exact native-frame crop boundaries into a contained 16 kHz semantic range.
 *
 * Starts use the first sample whose floor mapping returns the crop start; ends use the last
 * boundary whose ceil mapping returns the crop end. This avoids nearest-sample drift that would
 * make a zero-margin activation fail the V4 materialization validator at fractional boundaries.
 */
export function sourceFrameRangeToTranscriptSamples(
    startFrame: number,
    endFrame: number,
    sourceFps: number,
    sampleCount: number,
): HalfOpenInterval {
    assertFrameRange(startFrame, endFrame);
    assertPositiveFinite(sourceFps, 'sourceFps');
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
        throw new RangeError('Transcript sample count must be a positive safe integer.');
    }
    const start = Math.max(0, Math.ceil(
        (startFrame - NUMERICAL_GUARD) * EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ / sourceFps,
    ));
    const end = Math.min(sampleCount, Math.floor(
        (endFrame + NUMERICAL_GUARD) * EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ / sourceFps,
    ));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
        throw new RangeError('Source crop does not retain one transcript sample.');
    }
    return { start, end };
}

/**
 * Converts a source-frame span through the same nearest-duration rule as V4 placement.
 *
 * `sourceDuration` is required when a span may touch the deterministic ceil tail: the final
 * native frame can be partial, while V4 clips clamp that frame boundary to the exact media
 * duration in seconds. Omitting it retains the ordinary whole-frame conversion.
 */
export function sourceFrameSpanToProjectFrames(
    startFrame: number,
    endFrame: number,
    sourceFps: number,
    projectFps: RationalFrameRate,
    sourceDuration?: number,
): number {
    assertFrameRange(startFrame, endFrame);
    assertPositiveFinite(sourceFps, 'sourceFps');
    const startSeconds = startFrame / sourceFps;
    let endSeconds = endFrame / sourceFps;
    if (sourceDuration !== undefined) {
        assertPositiveFinite(sourceDuration, 'sourceDuration');
        endSeconds = Math.min(sourceDuration, endSeconds);
    }
    if (endSeconds <= startSeconds) {
        throw new RangeError('Materialized source frames must retain positive source time.');
    }
    return Math.max(1, secondsToFrames(endSeconds - startSeconds, projectFps, 'nearest'));
}

/** Returns a clip crop that exactly matches authoritative materialized source frames. */
export function materializationToSourceCrop(
    materialization: Pick<NarrativeMaterializationV1, 'sourceStartFrame' | 'sourceEndFrame'>,
    source: Pick<VideoSourceDescriptorV3, 'duration' | 'fps'>,
): Pick<VideoClipV4, 'sourceStart' | 'sourceEnd'> {
    assertFrameRange(materialization.sourceStartFrame, materialization.sourceEndFrame);
    return {
        sourceStart: materialization.sourceStartFrame / source.fps,
        sourceEnd: Math.min(source.duration, materialization.sourceEndFrame / source.fps),
    };
}

/** Preserves the mix envelope and proportionally fits its fades inside a shorter occurrence. */
export function clampVideoClipAudioSettings(
    audio: VideoClipAudioSettings | null,
    durationFrames: number,
): VideoClipAudioSettings | null {
    if (!audio) return null;
    if (!Number.isSafeInteger(durationFrames) || durationFrames <= 0) {
        throw new RangeError('Video audio duration must contain at least one output frame.');
    }
    let fadeInFrames = Math.min(durationFrames, Math.max(0, Math.round(audio.fadeInFrames)));
    let fadeOutFrames = Math.min(durationFrames, Math.max(0, Math.round(audio.fadeOutFrames)));
    if (fadeInFrames + fadeOutFrames > durationFrames) {
        const ratio = durationFrames / (fadeInFrames + fadeOutFrames);
        fadeInFrames = Math.floor(fadeInFrames * ratio);
        fadeOutFrames = durationFrames - fadeInFrames;
    }
    return { ...audio, fadeInFrames, fadeOutFrames };
}

/**
 * Partitions an accepted clip into exact source/project-frame occurrences.
 *
 * Sub-frame atoms are folded into a neighbor, and adjacent folds continue until the sum of child
 * V4 durations equals the old clip duration exactly. This is necessary because nearest rounding
 * is not additive at differing source/project frame rates. Falling back to one fragment always
 * preserves the original clip and is preferable to publishing a zero-frame occurrence.
 */
export function materializeActivationRange(input: {
    body: ResolvedEditorialTranscriptRecordBodyV1;
    coreRange: HalfOpenInterval;
    sourceStartFrame: number;
    sourceEndFrame: number;
    timelineStartFrame: number;
    sourceFps: number;
    sourceDuration: number;
    projectFps: RationalFrameRate;
    createSeamId: () => string;
    splitOnSpeakerChange?: boolean;
    outerPreBoundary?: MarginBoundaryPolicyV1;
    outerPostBoundary?: MarginBoundaryPolicyV1;
}): MaterializerResult<MaterializedActivationFragment[]> {
    try {
        assertFrameRange(input.sourceStartFrame, input.sourceEndFrame);
        const atoms = deriveSourceAtoms(input.body, input.coreRange, {
            splitOnSpeakerChange: input.splitOnSpeakerChange,
        });
        const mapped = mapAtomsToSourceFrames(
            atoms,
            input.sourceStartFrame,
            input.sourceEndFrame,
            input.sourceFps,
        );
        const totalDuration = sourceFrameSpanToProjectFrames(
            input.sourceStartFrame,
            input.sourceEndFrame,
            input.sourceFps,
            input.projectFps,
            input.sourceDuration,
        );
        const representable = coalesceForExactProjectCoverage(
            mapped,
            totalDuration,
            input.sourceFps,
            input.sourceDuration,
            input.projectFps,
        );
        const seams = Array.from(
            { length: Math.max(0, representable.length - 1) },
            () => input.createSeamId(),
        );
        const outerPreBoundary: MarginBoundaryPolicyV1 = input.outerPreBoundary
            ?? { kind: 'margin', mode: 'inherit-global', requestedSamples: null };
        const outerPostBoundary: MarginBoundaryPolicyV1 = input.outerPostBoundary
            ?? { kind: 'margin', mode: 'inherit-global', requestedSamples: null };
        let projectCursor = input.timelineStartFrame;
        const fragments = representable.map((fragment, index): MaterializedActivationFragment => {
            const duration = sourceFrameSpanToProjectFrames(
                fragment.sourceStartFrame,
                fragment.sourceEndFrame,
                input.sourceFps,
                input.projectFps,
                input.sourceDuration,
            );
            const timelineStartFrame = projectCursor;
            projectCursor += duration;
            return {
                ...fragment,
                timelineStartFrame,
                timelineEndFrame: projectCursor,
                preBoundary: index === 0
                    ? cloneBoundary(outerPreBoundary)
                    : { kind: 'partition-seam', seamId: seams[index - 1] },
                postBoundary: index === representable.length - 1
                    ? cloneBoundary(outerPostBoundary)
                    : { kind: 'partition-seam', seamId: seams[index] },
            };
        });
        if (projectCursor !== input.timelineStartFrame + totalDuration) {
            return error('minimum-duration', 'Activation fragments cannot preserve exact output duration.');
        }
        return { kind: 'success', value: fragments };
    } catch (caught) {
        return error('source-bounds', safeMessage(caught));
    }
}

/** Recomputes only margin sides; partition seams remain exact frame authorities. */
export function rematerializeNarrativeBlock(input: {
    block: NarrativeBlockV1;
    settings: NarrativeDocumentV1['settings'];
    source: Pick<VideoSourceDescriptorV3, 'duration' | 'fps'>;
    sampleCount: number;
}): MaterializerResult<NarrativeMaterializationV1> {
    try {
        const sourceEndFrame = getDeterministicSourceEndFrame(input.source);
        const pre = resolveMaterializedBoundary({
            side: 'pre',
            policy: input.block.materialization.preBoundary,
            currentFrame: input.block.materialization.sourceStartFrame,
            coreSample: input.block.coreStartSample,
            globalMargin: input.settings.globalPreMarginSamples,
            sampleCount: input.sampleCount,
            sourceFps: input.source.fps,
            sourceEndFrame,
        });
        const post = resolveMaterializedBoundary({
            side: 'post',
            policy: input.block.materialization.postBoundary,
            currentFrame: input.block.materialization.sourceEndFrame,
            coreSample: input.block.coreEndSample,
            globalMargin: input.settings.globalPostMarginSamples,
            sampleCount: input.sampleCount,
            sourceFps: input.source.fps,
            sourceEndFrame,
        });
        if (post <= pre) return error('minimum-duration', 'Materialized block must retain one source frame.');
        return {
            kind: 'success',
            value: {
                sourceStartFrame: pre,
                sourceEndFrame: post,
                preBoundary: cloneBoundary(input.block.materialization.preBoundary),
                postBoundary: cloneBoundary(input.block.materialization.postBoundary),
            },
        };
    } catch (caught) {
        return error('source-bounds', safeMessage(caught));
    }
}

/**
 * Splits one existing occurrence without reapplying either outer margin.
 *
 * The new internal sides share one seam ID and the child clip durations must add to the exact old
 * duration under V4 placement rounding. If the snapped seam cannot represent that partition, the
 * split is disabled instead of losing or inventing a project frame.
 */
export function splitNarrativeOccurrence(input: {
    block: NarrativeBlockV1;
    clip: VideoClipV4;
    body: ResolvedEditorialTranscriptRecordBodyV1;
    source: Pick<VideoSourceDescriptorV3, 'duration' | 'fps'>;
    projectFps: RationalFrameRate;
    splitSample: number;
    revision: number;
    ids: {
        seamId: string;
        leftInstanceId: string;
        rightInstanceId: string;
        leftSourceIntervalId: string;
        rightSourceIntervalId: string;
        rightBlockId: string;
        rightClipId: string;
    };
}): MaterializerResult<SplitNarrativeOccurrenceResult> {
    const { block, clip, splitSample } = input;
    if (!Number.isSafeInteger(splitSample)
        || splitSample <= block.coreStartSample
        || splitSample >= block.coreEndSample) {
        return error('source-bounds', 'Split sample must be inside the semantic core.');
    }
    const seamFrame = sourceSampleToVideoFrame(splitSample, input.source.fps, 'nearest');
    const startFrame = block.materialization.sourceStartFrame;
    const endFrame = block.materialization.sourceEndFrame;
    if (seamFrame <= startFrame || seamFrame >= endFrame) {
        return error('minimum-duration', 'Split boundary does not leave one source frame per child.');
    }
    const oldDuration = getVideoClipDurationFramesV4(input.clip, { fps: input.projectFps });
    const leftDuration = sourceFrameSpanToProjectFrames(
        startFrame,
        seamFrame,
        input.source.fps,
        input.projectFps,
        input.source.duration,
    );
    const rightDuration = sourceFrameSpanToProjectFrames(
        seamFrame,
        endFrame,
        input.source.fps,
        input.projectFps,
        input.source.duration,
    );
    if (leftDuration + rightDuration !== oldDuration) {
        return error('minimum-duration', 'Split boundary is not exactly representable in project frames.');
    }

    const partitionedWords = partitionWordsAtSample(block, input.body, splitSample);
    if (!partitionedWords) {
        return error('word-boundary', 'Split cannot cut through or orphan a retained source word.');
    }
    const seam: MaterializedBoundaryPolicyV1 = { kind: 'partition-seam', seamId: input.ids.seamId };
    const commonParent = [block.instanceId];
    const leftMaterialization: NarrativeMaterializationV1 = {
        sourceStartFrame: startFrame,
        sourceEndFrame: seamFrame,
        preBoundary: cloneBoundary(block.materialization.preBoundary),
        postBoundary: seam,
    };
    const rightMaterialization: NarrativeMaterializationV1 = {
        sourceStartFrame: seamFrame,
        sourceEndFrame: endFrame,
        preBoundary: seam,
        postBoundary: cloneBoundary(block.materialization.postBoundary),
    };
    const leftBlock = createPartitionChild({
        original: block,
        id: block.id,
        instanceId: input.ids.leftInstanceId,
        sourceIntervalId: input.ids.leftSourceIntervalId,
        clipId: clip.id,
        coreStartSample: block.coreStartSample,
        coreEndSample: splitSample,
        materialization: leftMaterialization,
        timelineStartFrame: block.timelineStartFrame,
        sourceWordIds: partitionedWords.left,
        parentInstanceIds: commonParent,
        revision: input.revision,
    });
    const rightBlock = createPartitionChild({
        original: block,
        id: input.ids.rightBlockId,
        instanceId: input.ids.rightInstanceId,
        sourceIntervalId: input.ids.rightSourceIntervalId,
        clipId: input.ids.rightClipId,
        coreStartSample: splitSample,
        coreEndSample: block.coreEndSample,
        materialization: rightMaterialization,
        timelineStartFrame: block.timelineStartFrame + leftDuration,
        sourceWordIds: partitionedWords.right,
        parentInstanceIds: commonParent,
        revision: input.revision,
    });
    if (!leftBlock || !rightBlock) {
        return error('word-boundary', 'Speech split must retain at least one complete word per child.');
    }
    const leftCrop = materializationToSourceCrop(leftMaterialization, input.source);
    const rightCrop = materializationToSourceCrop(rightMaterialization, input.source);
    return {
        kind: 'success',
        value: {
            leftBlock,
            rightBlock,
            leftClip: {
                ...clip,
                ...leftCrop,
                audio: clampVideoClipAudioSettings(partitionClipAudio(clip.audio, 'left'), leftDuration),
            },
            rightClip: {
                ...clip,
                id: input.ids.rightClipId,
                timelineStartFrame: rightBlock.timelineStartFrame,
                ...rightCrop,
                audio: clampVideoClipAudioSettings(partitionClipAudio(clip.audio, 'right'), rightDuration),
            },
            seamId: input.ids.seamId,
        },
    };
}

/** Merges only an exactly representable adjacent concatenation and never unions word IDs. */
export function mergeNarrativeOccurrences(input: {
    leftBlock: NarrativeBlockV1;
    rightBlock: NarrativeBlockV1;
    leftClip: VideoClipV4;
    rightClip: VideoClipV4;
    source: Pick<VideoSourceDescriptorV3, 'duration' | 'fps'>;
    projectFps: RationalFrameRate;
    revision: number;
    mergedInstanceId: string;
    mergedSourceIntervalId: string;
}): MaterializerResult<MergeNarrativeOccurrenceResult> {
    const { leftBlock: left, rightBlock: right } = input;
    const leftEnd = left.timelineStartFrame
        + getVideoClipDurationFramesV4(input.leftClip, { fps: input.projectFps });
    const compatibleIdentity = left.trackId === right.trackId
        && left.sourceId === right.sourceId
        && left.transcriptRecordId === right.transcriptRecordId
        && left.lineageRootId === right.lineageRootId
        && left.coreEndSample === right.coreStartSample
        && left.materialization.sourceEndFrame === right.materialization.sourceStartFrame
        && leftEnd === right.timelineStartFrame
        && boundariesFormCompatibleSeam(
            left.materialization.postBoundary,
            right.materialization.preBoundary,
        );
    if (!compatibleIdentity) {
        return error('incompatible-merge', 'Occurrences do not form one compatible adjacent mapping.');
    }
    const words = [...left.sourceWordIds, ...right.sourceWordIds];
    // V1 block representation stores source IDs, not per-word occurrence IDs. A duplicate cannot
    // be represented without losing occurrence multiplicity, so the correct behavior is rejection.
    if (new Set(words).size !== words.length) {
        return error('incompatible-merge', 'Repeated word occurrences cannot be represented by one V1 block.');
    }
    const mergedDuration = sourceFrameSpanToProjectFrames(
        left.materialization.sourceStartFrame,
        right.materialization.sourceEndFrame,
        input.source.fps,
        input.projectFps,
        input.source.duration,
    );
    const concatenatedDuration = getVideoClipDurationFramesV4(input.leftClip, { fps: input.projectFps })
        + getVideoClipDurationFramesV4(input.rightClip, { fps: input.projectFps });
    if (mergedDuration !== concatenatedDuration) {
        return error('incompatible-merge', 'One continuous mapping cannot preserve the concatenated output frames.');
    }
    const mergedAudio = mergePartitionedClipAudio(input.leftClip.audio, input.rightClip.audio);
    if (mergedAudio === undefined) {
        return error('incompatible-merge', 'Clip audio settings do not form one exact partition.');
    }
    const materialization: NarrativeMaterializationV1 = {
        sourceStartFrame: left.materialization.sourceStartFrame,
        sourceEndFrame: right.materialization.sourceEndFrame,
        preBoundary: cloneBoundary(left.materialization.preBoundary),
        postBoundary: cloneBoundary(right.materialization.postBoundary),
    };
    const common: NarrativeBlockCommonV1 = {
        ...copyBlockCommon(left),
        instanceId: input.mergedInstanceId,
        sourceIntervalId: input.mergedSourceIntervalId,
        parentInstanceIds: [left.instanceId, right.instanceId],
        coreEndSample: right.coreEndSample,
        materialization,
        endBoundaryRefinement: right.endBoundaryRefinement
            ? { ...right.endBoundaryRefinement }
            : null,
        revision: input.revision,
    };
    const block: NarrativeBlockV1 = words.length > 0
        ? {
            ...common,
            kind: 'speech',
            sourceWordIds: words,
            wordTextOverrides: {
                ...(left.kind === 'speech' ? left.wordTextOverrides : {}),
                ...(right.kind === 'speech' ? right.wordTextOverrides : {}),
            },
            speakerOverrides: {
                ...(left.kind === 'speech' ? left.speakerOverrides : {}),
                ...(right.kind === 'speech' ? right.speakerOverrides : {}),
            },
        }
        : {
            ...common,
            kind: 'silence',
            sourceWordIds: [],
            evidence: combineSilenceEvidence(
                left.kind === 'silence' ? left.evidence : 'unknown',
                right.kind === 'silence' ? right.evidence : 'unknown',
            ),
        };
    const crop = materializationToSourceCrop(materialization, input.source);
    return {
        kind: 'success',
        value: {
            block,
            clip: { ...input.leftClip, ...crop, audio: mergedAudio },
            removedBlockId: right.id,
            removedClipId: input.rightClip.id,
        },
    };
}

/**
 * Creates one independently addressable retained/recovered occurrence from an immutable body.
 * Callers always provide fresh instance/source-interval identities, including for equal ranges.
 */
export function sliceNarrativeOccurrence(input: {
    original: NarrativeBlockV1;
    clip: VideoClipV4;
    body: ResolvedEditorialTranscriptRecordBodyV1;
    source: Pick<VideoSourceDescriptorV3, 'duration' | 'fps'>;
    projectFps: RationalFrameRate;
    coreRange: HalfOpenInterval;
    timelineStartFrame: number;
    revision: number;
    ids: { blockId: string; clipId: string; instanceId: string; sourceIntervalId: string };
    /** Partition removes fades from new internal edges; trim preserves and clamps the envelope. */
    audioBoundaryMode?: 'trim' | 'partition';
}): MaterializerResult<SliceNarrativeOccurrenceResult> {
    if (!Number.isSafeInteger(input.coreRange.start)
        || !Number.isSafeInteger(input.coreRange.end)
        || input.coreRange.start < 0
        || input.coreRange.end <= input.coreRange.start
        || input.coreRange.end > input.body.sampleCount) {
        return error('source-bounds', 'Slice core must remain inside the immutable source body.');
    }
    const retainsStart = input.coreRange.start === input.original.coreStartSample;
    const retainsEnd = input.coreRange.end === input.original.coreEndSample;
    const materialization: NarrativeMaterializationV1 = {
        sourceStartFrame: retainsStart
            ? input.original.materialization.sourceStartFrame
            : sourceSampleToVideoFrame(input.coreRange.start, input.source.fps, 'floor'),
        sourceEndFrame: retainsEnd
            ? input.original.materialization.sourceEndFrame
            : Math.min(
                getDeterministicSourceEndFrame(input.source),
                sourceSampleToVideoFrame(input.coreRange.end, input.source.fps, 'ceil'),
            ),
        preBoundary: retainsStart
            ? cloneBoundary(input.original.materialization.preBoundary)
            : { kind: 'margin', mode: 'explicit', requestedSamples: 0 },
        postBoundary: retainsEnd
            ? cloneBoundary(input.original.materialization.postBoundary)
            : { kind: 'margin', mode: 'explicit', requestedSamples: 0 },
    };
    if (materialization.sourceEndFrame <= materialization.sourceStartFrame) {
        return error('minimum-duration', 'Slice must retain at least one materialized source frame.');
    }
    const retainedWords = input.body.words
        .filter(word => word.editableStartSample >= input.coreRange.start
            && word.editableEndSample <= input.coreRange.end)
        .map(word => word.id);
    const common: NarrativeBlockCommonV1 = {
        ...copyBlockCommon(input.original),
        id: input.ids.blockId,
        clipId: input.ids.clipId,
        instanceId: input.ids.instanceId,
        sourceIntervalId: input.ids.sourceIntervalId,
        parentInstanceIds: [input.original.instanceId],
        coreStartSample: input.coreRange.start,
        coreEndSample: input.coreRange.end,
        materialization,
        timelineStartFrame: input.timelineStartFrame,
        startBoundaryRefinement: retainsStart && input.original.startBoundaryRefinement
            ? { ...input.original.startBoundaryRefinement }
            : null,
        endBoundaryRefinement: retainsEnd && input.original.endBoundaryRefinement
            ? { ...input.original.endBoundaryRefinement }
            : null,
        revision: input.revision,
    };
    const block: NarrativeBlockV1 = retainedWords.length > 0
        ? {
            ...common,
            kind: 'speech',
            sourceWordIds: retainedWords,
            wordTextOverrides: filterOverrides(input.original, retainedWords, 'text'),
            speakerOverrides: filterOverrides(input.original, retainedWords, 'speaker'),
        }
        : {
            ...common,
            kind: 'silence',
            sourceWordIds: [],
            evidence: classifyNoWordEvidence(input.body, input.coreRange),
        };
    const crop = materializationToSourceCrop(materialization, input.source);
    const unclampedClip: VideoClipV4 = {
        ...input.clip,
        id: input.ids.clipId,
        timelineStartFrame: input.timelineStartFrame,
        ...crop,
        audio: input.audioBoundaryMode === 'partition' && input.clip.audio
            ? {
                ...input.clip.audio,
                fadeInFrames: retainsStart ? input.clip.audio.fadeInFrames : 0,
                fadeOutFrames: retainsEnd ? input.clip.audio.fadeOutFrames : 0,
            }
            : input.clip.audio ? { ...input.clip.audio } : null,
    };
    const duration = getVideoClipDurationFramesV4(unclampedClip, { fps: input.projectFps });
    const clip = {
        ...unclampedClip,
        audio: clampVideoClipAudioSettings(unclampedClip.audio, duration),
    };
    return { kind: 'success', value: { block, clip } };
}

function mapAtomsToSourceFrames(
    atoms: readonly SourceAtom[],
    sourceStartFrame: number,
    sourceEndFrame: number,
    sourceFps: number,
): Array<{ atom: SourceAtom; sourceStartFrame: number; sourceEndFrame: number }> {
    const mapped = atoms.map((atom, index) => ({
        atom: cloneAtom(atom),
        sourceStartFrame: index === 0
            ? sourceStartFrame
            : clampFrame(sourceSampleToVideoFrame(atom.start, sourceFps, 'nearest'), sourceStartFrame, sourceEndFrame),
        sourceEndFrame: index === atoms.length - 1
            ? sourceEndFrame
            : clampFrame(sourceSampleToVideoFrame(atom.end, sourceFps, 'nearest'), sourceStartFrame, sourceEndFrame),
    }));
    const result: typeof mapped = [];
    let leading: SourceAtom[] = [];
    for (const entry of mapped) {
        if (entry.sourceEndFrame <= entry.sourceStartFrame) {
            if (result.length > 0) {
                const previous = result[result.length - 1];
                previous.atom = combineAtoms(previous.atom, entry.atom);
            } else leading.push(entry.atom);
            continue;
        }
        if (leading.length > 0) {
            const leadingAtom = leading.slice(1).reduce(
                (combined, atom) => combineAtoms(combined, atom),
                leading[0],
            );
            entry.atom = combineAtoms(leadingAtom, entry.atom);
            leading = [];
        }
        result.push(entry);
    }
    if (result.length === 0) {
        return [{
            atom: atoms.reduce((combined, atom) => combineAtoms(combined, atom)),
            sourceStartFrame,
            sourceEndFrame,
        }];
    }
    if (leading.length > 0) {
        const last = result[result.length - 1];
        last.atom = leading.reduce((combined, atom) => combineAtoms(combined, atom), last.atom);
    }
    return result;
}

function coalesceForExactProjectCoverage(
    input: Array<{ atom: SourceAtom; sourceStartFrame: number; sourceEndFrame: number }>,
    totalDuration: number,
    sourceFps: number,
    sourceDuration: number,
    projectFps: RationalFrameRate,
): typeof input {
    const fragments = input.map(fragment => ({ ...fragment, atom: cloneAtom(fragment.atom) }));
    const duration = (fragment: typeof fragments[number]): number => sourceFrameSpanToProjectFrames(
        fragment.sourceStartFrame,
        fragment.sourceEndFrame,
        sourceFps,
        projectFps,
        sourceDuration,
    );
    while (fragments.length > 1) {
        const currentTotal = fragments.reduce((sum, fragment) => sum + duration(fragment), 0);
        if (currentTotal === totalDuration) return fragments;
        const desiredDirection = Math.sign(totalDuration - currentTotal);
        let mergeIndex = -1;
        for (let index = 0; index < fragments.length - 1; index += 1) {
            const merged = mergeMappedFragments(fragments[index], fragments[index + 1]);
            const delta = duration(merged) - duration(fragments[index]) - duration(fragments[index + 1]);
            if (Math.sign(delta) === desiredDirection) {
                mergeIndex = index;
                break;
            }
        }
        // If no local pair corrects the rounding difference, a single continuous occurrence is
        // the universally representable fallback and still preserves all source atoms/words.
        if (mergeIndex < 0) {
            return [fragments.slice(1).reduce(
                (combined, fragment) => mergeMappedFragments(combined, fragment),
                fragments[0],
            )];
        }
        fragments.splice(
            mergeIndex,
            2,
            mergeMappedFragments(fragments[mergeIndex], fragments[mergeIndex + 1]),
        );
    }
    return fragments;
}

function mergeMappedFragments<T extends { atom: SourceAtom; sourceStartFrame: number; sourceEndFrame: number }>(
    left: T,
    right: T,
): T {
    return {
        ...left,
        atom: combineAtoms(left.atom, right.atom),
        sourceEndFrame: right.sourceEndFrame,
    };
}

function combineAtoms(left: SourceAtom, right: SourceAtom): SourceAtom {
    const start = Math.min(left.start, right.start);
    const end = Math.max(left.end, right.end);
    const words = [
        ...(left.kind === 'speech' ? left.sourceWordIds : []),
        ...(right.kind === 'speech' ? right.sourceWordIds : []),
    ];
    if (words.length > 0) {
        const leftSpeaker = left.kind === 'speech' ? left.speakerId : null;
        const rightSpeaker = right.kind === 'speech' ? right.speakerId : null;
        return {
            kind: 'speech',
            start,
            end,
            sourceWordIds: words,
            speakerId: leftSpeaker === rightSpeaker ? leftSpeaker : null,
        };
    }
    return {
        kind: 'silence',
        start,
        end,
        evidence: combineSilenceEvidence(
            left.kind === 'silence' ? left.evidence : 'unknown',
            right.kind === 'silence' ? right.evidence : 'unknown',
        ),
    };
}

function combineSilenceEvidence(
    left: NarrativeSilenceEvidenceV1,
    right: NarrativeSilenceEvidenceV1,
): NarrativeSilenceEvidenceV1 {
    const rank: Record<NarrativeSilenceEvidenceV1, number> = {
        quiet: 0,
        unknown: 1,
        'acoustic-only': 2,
        'no-audio': 3,
    };
    return rank[left] >= rank[right] ? left : right;
}

function partitionWordsAtSample(
    block: NarrativeBlockV1,
    body: ResolvedEditorialTranscriptRecordBodyV1,
    splitSample: number,
): { left: string[]; right: string[] } | null {
    if (block.kind === 'silence') return { left: [], right: [] };
    const wordsById = new Map(body.words.map(word => [word.id, word]));
    const left: string[] = [];
    const right: string[] = [];
    for (const wordId of block.sourceWordIds) {
        const word = wordsById.get(wordId);
        if (!word) return null;
        if (word.editableEndSample <= splitSample) left.push(wordId);
        else if (word.editableStartSample >= splitSample) right.push(wordId);
        else return null;
    }
    return left.length > 0 && right.length > 0 ? { left, right } : null;
}

function createPartitionChild(input: {
    original: NarrativeBlockV1;
    id: string;
    instanceId: string;
    sourceIntervalId: string;
    clipId: string;
    coreStartSample: number;
    coreEndSample: number;
    materialization: NarrativeMaterializationV1;
    timelineStartFrame: number;
    sourceWordIds: string[];
    parentInstanceIds: string[];
    revision: number;
}): NarrativeBlockV1 | null {
    const common: NarrativeBlockCommonV1 = {
        ...copyBlockCommon(input.original),
        id: input.id,
        instanceId: input.instanceId,
        sourceIntervalId: input.sourceIntervalId,
        clipId: input.clipId,
        parentInstanceIds: [...input.parentInstanceIds],
        coreStartSample: input.coreStartSample,
        coreEndSample: input.coreEndSample,
        materialization: input.materialization,
        timelineStartFrame: input.timelineStartFrame,
        startBoundaryRefinement: input.coreStartSample === input.original.coreStartSample
            && input.original.startBoundaryRefinement
            ? { ...input.original.startBoundaryRefinement }
            : null,
        endBoundaryRefinement: input.coreEndSample === input.original.coreEndSample
            && input.original.endBoundaryRefinement
            ? { ...input.original.endBoundaryRefinement }
            : null,
        revision: input.revision,
    };
    if (input.original.kind === 'silence') {
        return { ...common, kind: 'silence', sourceWordIds: [], evidence: input.original.evidence };
    }
    if (input.sourceWordIds.length === 0) return null;
    return {
        ...common,
        kind: 'speech',
        sourceWordIds: [...input.sourceWordIds],
        wordTextOverrides: filterOverrides(input.original, input.sourceWordIds, 'text'),
        speakerOverrides: filterOverrides(input.original, input.sourceWordIds, 'speaker'),
    };
}

/** Copies only the discriminant-independent block contract so speech metadata cannot leak into silence. */
function copyBlockCommon(block: NarrativeBlockV1): NarrativeBlockCommonV1 {
    return {
        id: block.id,
        instanceId: block.instanceId,
        lineageRootId: block.lineageRootId,
        parentInstanceIds: [...block.parentInstanceIds],
        clipId: block.clipId,
        trackId: block.trackId,
        sourceId: block.sourceId,
        transcriptRecordId: block.transcriptRecordId,
        sourceIntervalId: block.sourceIntervalId,
        coreStartSample: block.coreStartSample,
        coreEndSample: block.coreEndSample,
        materialization: {
            ...block.materialization,
            preBoundary: cloneBoundary(block.materialization.preBoundary),
            postBoundary: cloneBoundary(block.materialization.postBoundary),
        },
        timelineStartFrame: block.timelineStartFrame,
        startBoundaryRefinement: block.startBoundaryRefinement
            ? { ...block.startBoundaryRefinement }
            : null,
        endBoundaryRefinement: block.endBoundaryRefinement
            ? { ...block.endBoundaryRefinement }
            : null,
        revision: block.revision,
    };
}

/** Internal partition edges must not replay the original occurrence's outer audio fades. */
function partitionClipAudio(
    audio: VideoClipAudioSettings | null,
    side: 'left' | 'right',
): VideoClipAudioSettings | null {
    if (!audio) return null;
    return {
        ...audio,
        fadeInFrames: side === 'left' ? audio.fadeInFrames : 0,
        fadeOutFrames: side === 'right' ? audio.fadeOutFrames : 0,
    };
}

/** Returns undefined when merging would lose gain/mute/link state or an internal fade. */
function mergePartitionedClipAudio(
    left: VideoClipAudioSettings | null,
    right: VideoClipAudioSettings | null,
): VideoClipAudioSettings | null | undefined {
    if (left === null || right === null) return left === right ? null : undefined;
    if (left.linkState !== right.linkState
        || left.muted !== right.muted
        || left.gainDb !== right.gainDb
        || left.fadeOutFrames !== 0
        || right.fadeInFrames !== 0) return undefined;
    return {
        ...left,
        fadeOutFrames: right.fadeOutFrames,
    };
}

function filterOverrides(
    block: NarrativeBlockV1,
    wordIds: readonly string[],
    kind: 'text' | 'speaker',
): Record<string, string> {
    if (block.kind !== 'speech') return {};
    const source = kind === 'text' ? block.wordTextOverrides : block.speakerOverrides;
    return Object.fromEntries(wordIds
        .filter(wordId => Object.prototype.hasOwnProperty.call(source, wordId))
        .map(wordId => [wordId, source[wordId]]));
}

function resolveMaterializedBoundary(input: {
    side: 'pre' | 'post';
    policy: MaterializedBoundaryPolicyV1;
    currentFrame: number;
    coreSample: number;
    globalMargin: number;
    sampleCount: number;
    sourceFps: number;
    sourceEndFrame: number;
}): number {
    if (input.policy.kind === 'partition-seam') return input.currentFrame;
    const margin = input.policy.mode === 'inherit-global'
        ? input.globalMargin
        : input.policy.requestedSamples;
    if (margin === null || !Number.isSafeInteger(margin) || margin < 0) {
        throw new RangeError('Margin must be a safe sample count.');
    }
    const requestedSample = input.side === 'pre'
        ? Math.max(0, input.coreSample - margin)
        : Math.min(input.sampleCount, input.coreSample + margin);
    const frame = sourceSampleToVideoFrame(
        requestedSample,
        input.sourceFps,
        input.side === 'pre' ? 'floor' : 'ceil',
    );
    return input.side === 'pre' ? Math.max(0, frame) : Math.min(input.sourceEndFrame, frame);
}

function boundariesFormCompatibleSeam(
    left: MaterializedBoundaryPolicyV1,
    right: MaterializedBoundaryPolicyV1,
): boolean {
    if (left.kind === 'partition-seam' || right.kind === 'partition-seam') {
        return left.kind === 'partition-seam'
            && right.kind === 'partition-seam'
            && left.seamId === right.seamId;
    }
    // Two zero-width explicit/inherited-zero margin sides may also be representation-compatible;
    // frame and core adjacency checks above prove that they add no hidden context.
    const leftSamples = left.mode === 'explicit' ? left.requestedSamples : null;
    const rightSamples = right.mode === 'explicit' ? right.requestedSamples : null;
    return leftSamples === 0 && rightSamples === 0;
}

function cloneBoundary(boundary: MaterializedBoundaryPolicyV1): MaterializedBoundaryPolicyV1 {
    return boundary.kind === 'partition-seam'
        ? { kind: 'partition-seam', seamId: boundary.seamId }
        : { kind: 'margin', mode: boundary.mode, requestedSamples: boundary.requestedSamples };
}

function cloneAtom(atom: SourceAtom): SourceAtom {
    return atom.kind === 'speech'
        ? { ...atom, sourceWordIds: [...atom.sourceWordIds] }
        : { ...atom };
}

function clampFrame(frame: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, frame));
}

function assertSourceSample(sample: number): void {
    if (!Number.isSafeInteger(sample) || sample < 0) {
        throw new RangeError('Source sample must be a non-negative safe integer.');
    }
}

function assertFrameRange(startFrame: number, endFrame: number): void {
    if (!Number.isSafeInteger(startFrame)
        || startFrame < 0
        || !Number.isSafeInteger(endFrame)
        || endFrame <= startFrame) {
        throw new RangeError('Source frames must form a safe non-empty half-open interval.');
    }
}

function assertPositiveFinite(value: number, name: string): void {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite.`);
}

function error<T>(
    code: Extract<MaterializerResult<T>, { kind: 'error' }>['code'],
    message: string,
): MaterializerResult<T> {
    return { kind: 'error', code, message };
}

function safeMessage(value: unknown): string {
    return value instanceof Error ? value.message : 'Narrative materialization failed.';
}
