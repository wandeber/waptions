import type {
    ClipPlacement,
    EditorDocumentV4,
    RationalFrameRate,
    VideoClip,
    VideoClipV3,
} from '@/types/video';
import { frameToOutputSample } from './audio-timebase';
import { secondsToFrames } from './render-profile';
import { buildClipPlacements } from './video-timeline';
import { buildVideoTrackPlacementsV4 } from './video-placement-v4';

export const DEFAULT_OUTPUT_SAMPLE_RATE = 48_000;

export interface AudioSampleRange {
    startSample: number;
    endSample: number;
    sampleCount: number;
}

export interface AudioSilenceRange extends AudioSampleRange {
    reason: 'timeline-gap' | 'missing-source-audio';
}

export interface AudioOutputSegment extends AudioSampleRange {
    clipId: string;
    sourceId: string;
    sourceStart: number;
    sourceEnd: number;
}

export interface AudioSourceBufferWindow {
    startTime: number;
    sampleRate: number;
    frameCount: number;
}

export interface AudioSegmentCrop {
    sourceFrameStart: number;
    sourceFrameEnd: number;
    sourceFrameCount: number;
    outputRange: AudioSampleRange | null;
    silenceRanges: AudioSilenceRange[];
}

export interface AudioWindowCrop {
    bufferIndex: number;
    sourceFrameStart: number;
    sourceFrameEnd: number;
    sourceFrameCount: number;
    outputRange: AudioSampleRange;
}

export interface AudioSegmentAssembly {
    crops: AudioWindowCrop[];
    silenceRanges: AudioSilenceRange[];
}

export function getCumulativeSampleBoundaries(
    durations: readonly number[],
    sampleRate = DEFAULT_OUTPUT_SAMPLE_RATE,
): number[] {
    assertSampleRate(sampleRate);
    let cumulativeDuration = 0;
    const boundaries = [0];
    durations.forEach((duration) => {
        if (!Number.isFinite(duration) || duration < 0) {
            throw new Error('Audio segment durations must be non-negative and finite.');
        }
        cumulativeDuration += duration;
        // Rounding the cumulative time, instead of rounding each duration and adding it, lets
        // neighboring clips share the exact same boundary and prevents one-sample drift from
        // accumulating over a long edit.
        boundaries.push(Math.round(cumulativeDuration * sampleRate));
    });
    return boundaries;
}

export function buildAudioOutputSegments(
    clipsOrPlacements: readonly VideoClip[] | readonly ClipPlacement[],
    sampleRate = DEFAULT_OUTPUT_SAMPLE_RATE,
): AudioOutputSegment[] {
    assertSampleRate(sampleRate);
    const placements = isClipPlacementArray(clipsOrPlacements)
        ? clipsOrPlacements
        : buildClipPlacements(clipsOrPlacements);
    const boundaries = getCumulativeSampleBoundaries(
        placements.map((placement) => placement.duration),
        sampleRate,
    );

    return placements.map((placement, index) => ({
        clipId: placement.clip.id,
        sourceId: placement.clip.sourceId,
        sourceStart: placement.clip.sourceStart,
        sourceEnd: placement.clip.sourceEnd,
        startSample: boundaries[index],
        endSample: boundaries[index + 1],
        sampleCount: boundaries[index + 1] - boundaries[index],
    }));
}

/**
 * Builds v3 video-audio segments from canonical integer frame placements.
 *
 * V2 placement accumulation is second based and remains above for legacy readers. V3 rounds each
 * source crop to an output-frame count once, advances a frame cursor, and only then maps absolute
 * frame boundaries to samples. This is the same placement rule used by the mix plan, so preview
 * window assembly cannot disagree with editing or export at fractional broadcast frame rates.
 */
export function buildV3VideoAudioOutputSegments(
    clips: readonly VideoClipV3[],
    frameRate: RationalFrameRate,
): AudioOutputSegment[] {
    let frameCursor = 0;
    return clips.map((clip) => {
        const durationFrames = Math.max(
            1,
            secondsToFrames(clip.sourceEnd - clip.sourceStart, frameRate, 'nearest'),
        );
        const startFrame = frameCursor;
        const endFrame = startFrame + durationFrames;
        frameCursor = endFrame;
        const startSample = frameToOutputSample(startFrame, frameRate);
        const endSample = frameToOutputSample(endFrame, frameRate);
        return {
            clipId: clip.id,
            sourceId: clip.sourceId,
            sourceStart: clip.sourceStart,
            sourceEnd: clip.sourceEnd,
            startSample,
            endSample,
            sampleCount: endSample - startSample,
        };
    });
}

/**
 * Builds linked-video source segments from explicit V4 project placements.
 *
 * Segments may overlap because clips on different video tracks mix normally. Visual visibility is
 * intentionally irrelevant to this projection; clip/link mute controls are applied by the mix
 * planner rather than by source-segment geometry.
 */
export function buildV4VideoAudioOutputSegments(
    document: Pick<EditorDocumentV4, 'renderProfile' | 'videoTracks' | 'videoClips'>,
): AudioOutputSegment[] {
    const placementsByClipId = new Map(buildVideoTrackPlacementsV4(document).flatMap(
        (track) => track.placements.map((placement) => [placement.clip.id, placement] as const),
    ));
    return document.videoClips.map((clip) => {
        const placement = placementsByClipId.get(clip.id);
        if (!placement) throw new Error(`Missing explicit audio placement for video clip "${clip.id}".`);
        const startSample = frameToOutputSample(placement.startFrame, document.renderProfile.fps);
        const endSample = frameToOutputSample(placement.endFrame, document.renderProfile.fps);
        return {
            clipId: clip.id,
            sourceId: clip.sourceId,
            sourceStart: clip.sourceStart,
            sourceEnd: clip.sourceEnd,
            startSample,
            endSample,
            sampleCount: endSample - startSample,
        };
    });
}

/**
 * Intersects a clip with one standalone decoded window. Its silence ranges describe everything
 * this one window does not cover, so callers assembling streamed windows must use
 * assembleAudioSegmentCrops instead of merging several single-window results.
 */
export function calculateAudioSegmentCrop(
    segment: AudioOutputSegment,
    buffer: AudioSourceBufferWindow,
    outputSampleRate = DEFAULT_OUTPUT_SAMPLE_RATE,
): AudioSegmentCrop {
    assertSampleRate(outputSampleRate);
    validateAudioBufferWindow(buffer);

    const bufferEnd = buffer.startTime + buffer.frameCount / buffer.sampleRate;
    const intersectionStart = Math.max(segment.sourceStart, buffer.startTime);
    const intersectionEnd = Math.min(segment.sourceEnd, bufferEnd);
    if (intersectionEnd <= intersectionStart) {
        return {
            sourceFrameStart: 0,
            sourceFrameEnd: 0,
            sourceFrameCount: 0,
            outputRange: null,
            silenceRanges: [createSilenceRange(segment.startSample, segment.endSample, 'missing-source-audio')],
        };
    }

    const crop = createWindowCrop(segment, buffer, 0, intersectionStart, intersectionEnd, outputSampleRate);
    const silenceRanges: AudioSilenceRange[] = [];
    if (crop.outputRange.startSample > segment.startSample) {
        silenceRanges.push(createSilenceRange(
            segment.startSample,
            crop.outputRange.startSample,
            'missing-source-audio',
        ));
    }
    if (crop.outputRange.endSample < segment.endSample) {
        silenceRanges.push(createSilenceRange(
            crop.outputRange.endSample,
            segment.endSample,
            'missing-source-audio',
        ));
    }

    return {
        sourceFrameStart: crop.sourceFrameStart,
        sourceFrameEnd: crop.sourceFrameEnd,
        sourceFrameCount: crop.sourceFrameCount,
        outputRange: crop.outputRange,
        silenceRanges,
    };
}

/**
 * Builds one non-overlapping crop plan across all decoded windows for a clip. Windows are sorted
 * by source timestamp, while the original index is retained for the caller's buffer lookup.
 * Earlier coverage wins overlaps; later windows begin at the first uncovered timestamp. Silence
 * is emitted once from the global coverage cursor, so adjacent or overlapping streamed chunks
 * cannot manufacture contradictory segment-wide gaps.
 */
export function assembleAudioSegmentCrops(
    segment: AudioOutputSegment,
    buffers: readonly AudioSourceBufferWindow[],
    outputSampleRate = DEFAULT_OUTPUT_SAMPLE_RATE,
): AudioSegmentAssembly {
    assertSampleRate(outputSampleRate);
    const orderedBuffers = buffers.map((buffer, bufferIndex) => {
        validateAudioBufferWindow(buffer);
        return {
            buffer,
            bufferIndex,
            endTime: buffer.startTime + buffer.frameCount / buffer.sampleRate,
        };
    }).sort((left, right) => (
        left.buffer.startTime - right.buffer.startTime
        || right.endTime - left.endTime
        || left.bufferIndex - right.bufferIndex
    ));

    const crops: AudioWindowCrop[] = [];
    const silenceRanges: AudioSilenceRange[] = [];
    let sourceCursor = segment.sourceStart;

    orderedBuffers.forEach(({ buffer, bufferIndex, endTime }) => {
        if (sourceCursor >= segment.sourceEnd || endTime <= sourceCursor || buffer.startTime >= segment.sourceEnd) {
            return;
        }

        if (buffer.startTime > sourceCursor) {
            const gapEnd = Math.min(buffer.startTime, segment.sourceEnd);
            pushSourceSilenceRange(silenceRanges, segment, sourceCursor, gapEnd, outputSampleRate);
            sourceCursor = gapEnd;
        }

        const intersectionStart = Math.max(sourceCursor, segment.sourceStart, buffer.startTime);
        const intersectionEnd = Math.min(segment.sourceEnd, endTime);
        if (intersectionEnd <= intersectionStart) {
            return;
        }

        crops.push(createWindowCrop(
            segment,
            buffer,
            bufferIndex,
            intersectionStart,
            intersectionEnd,
            outputSampleRate,
        ));
        sourceCursor = intersectionEnd;
    });

    if (sourceCursor < segment.sourceEnd) {
        pushSourceSilenceRange(
            silenceRanges,
            segment,
            sourceCursor,
            segment.sourceEnd,
            outputSampleRate,
        );
    }

    return { crops, silenceRanges };
}

export function findAudioTimelineSilenceRanges(
    populatedRanges: readonly AudioSampleRange[],
    totalSampleCount: number,
): AudioSilenceRange[] {
    if (!Number.isInteger(totalSampleCount) || totalSampleCount < 0) {
        throw new Error('Total audio sample count must be a non-negative integer.');
    }
    const ordered = populatedRanges
        .map((range) => ({
            startSample: clamp(range.startSample, 0, totalSampleCount),
            endSample: clamp(range.endSample, 0, totalSampleCount),
        }))
        .filter((range) => range.endSample > range.startSample)
        .sort((left, right) => left.startSample - right.startSample || left.endSample - right.endSample);

    const silenceRanges: AudioSilenceRange[] = [];
    let cursor = 0;
    ordered.forEach((range) => {
        if (range.startSample > cursor) {
            silenceRanges.push(createSilenceRange(cursor, range.startSample, 'timeline-gap'));
        }
        cursor = Math.max(cursor, range.endSample);
    });
    if (cursor < totalSampleCount) {
        silenceRanges.push(createSilenceRange(cursor, totalSampleCount, 'timeline-gap'));
    }
    return silenceRanges;
}

function isClipPlacementArray(
    values: readonly VideoClip[] | readonly ClipPlacement[],
): values is readonly ClipPlacement[] {
    return values.length > 0 && 'clip' in values[0];
}

function createSampleRange(startSample: number, endSample: number): AudioSampleRange {
    return { startSample, endSample, sampleCount: endSample - startSample };
}

function createWindowCrop(
    segment: AudioOutputSegment,
    buffer: AudioSourceBufferWindow,
    bufferIndex: number,
    intersectionStart: number,
    intersectionEnd: number,
    outputSampleRate: number,
): AudioWindowCrop {
    // Round both crop boundaries from the same origins. Deriving an end from a separately
    // rounded duration would create one-frame overlaps or gaps at streamed chunk boundaries.
    const sourceFrameStart = clamp(
        Math.round((intersectionStart - buffer.startTime) * buffer.sampleRate),
        0,
        buffer.frameCount,
    );
    const sourceFrameEnd = clamp(
        Math.round((intersectionEnd - buffer.startTime) * buffer.sampleRate),
        sourceFrameStart,
        buffer.frameCount,
    );
    const outputStart = sourceTimeToOutputSample(segment, intersectionStart, outputSampleRate);
    const outputEnd = clamp(
        sourceTimeToOutputSample(segment, intersectionEnd, outputSampleRate),
        outputStart,
        segment.endSample,
    );
    return {
        bufferIndex,
        sourceFrameStart,
        sourceFrameEnd,
        sourceFrameCount: sourceFrameEnd - sourceFrameStart,
        outputRange: createSampleRange(outputStart, outputEnd),
    };
}

function pushSourceSilenceRange(
    silenceRanges: AudioSilenceRange[],
    segment: AudioOutputSegment,
    sourceStart: number,
    sourceEnd: number,
    outputSampleRate: number,
): void {
    const outputStart = sourceTimeToOutputSample(segment, sourceStart, outputSampleRate);
    const outputEnd = sourceTimeToOutputSample(segment, sourceEnd, outputSampleRate);
    // Sub-sample timestamp holes have no representable output sample and therefore require no
    // explicit silence range. All representable gaps remain half-open and non-overlapping.
    if (outputEnd > outputStart) {
        silenceRanges.push(createSilenceRange(outputStart, outputEnd, 'missing-source-audio'));
    }
}

function sourceTimeToOutputSample(
    segment: AudioOutputSegment,
    sourceTime: number,
    outputSampleRate: number,
): number {
    return clamp(
        segment.startSample + Math.round((sourceTime - segment.sourceStart) * outputSampleRate),
        segment.startSample,
        segment.endSample,
    );
}

function createSilenceRange(
    startSample: number,
    endSample: number,
    reason: AudioSilenceRange['reason'],
): AudioSilenceRange {
    return { ...createSampleRange(startSample, endSample), reason };
}

function assertSampleRate(sampleRate: number): void {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
        throw new Error('Audio sample rate must be positive and finite.');
    }
}

function validateAudioBufferWindow(buffer: AudioSourceBufferWindow): void {
    assertSampleRate(buffer.sampleRate);
    if (!Number.isInteger(buffer.frameCount) || buffer.frameCount < 0 || !Number.isFinite(buffer.startTime)) {
        throw new Error('Audio source buffer window is invalid.');
    }
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}
