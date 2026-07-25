import type { Subtitle, SubtitleTrack } from '@/types/timeline';
import type {
    AudioSourceDescriptor,
    AudioTrack,
    ClipPlacement,
    EditorDocumentV2,
    EditorDocumentV4,
    MediaEditResult,
    RationalFrameRate,
    RenderProfile,
    RetainedIntervalMapping,
    SplitClipResult,
    TimelineDurations,
    TimelineIdFactory,
    VideoClip,
    VideoDocumentValidationIssue,
    VideoDocumentValidationResult,
    VideoSourceAsset,
    VideoSourceDescriptor,
    VideoTrack,
    VideoTrackV4,
} from '@/types/video';
import { frameToOutputSample, nativeBoundaryToOutputSample, outputSampleToCoveringFrame } from './audio-timebase';
import { framesToSeconds, secondsToFrames } from './render-profile';
import { getVideoContentEndFrameV4 as getExplicitVideoContentEndFrameV4 } from './video-placement-v4';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NUMERICAL_GUARD = 1e-9;
const VIEW_TAIL_SECONDS = 60;

export interface VideoFingerprintInput {
    name: string;
    type: string;
    size: number;
    lastModified: number;
}

export interface LegacySourceFingerprintScope {
    projectId: string;
    kind: 'video-source' | 'audio-source';
    sourceId: string;
}

export interface SourceFramePosition {
    index: number;
    time: number;
}

export interface TransformedTimeline {
    tracks: SubtitleTrack[];
    selectedSubtitleIds: string[];
}

export function isSafeVideoId(id: string): boolean {
    return SAFE_ID_PATTERN.test(id);
}

/**
 * Creates the deterministic v1 metadata fingerprint retained for legacy projects and validation.
 * New imports wrap this checksum with a persisted random identity below, because metadata alone
 * cannot safely identify byte content. Length prefixes keep the compatibility hash unambiguous.
 */
export function createVideoSourceFingerprint(input: VideoFingerprintInput): string {
    const parts = [input.name, input.type, String(input.size), String(input.lastModified)];
    const value = parts.map((part) => `${part.length}:${part}`).join('|');

    const hash = (seed: number, text: string): number => {
        let result = seed >>> 0;
        for (let index = 0; index < text.length; index += 1) {
            result ^= text.charCodeAt(index);
            result = Math.imul(result, 0x01000193) >>> 0;
        }
        return result;
    };

    const first = hash(0x811c9dc5, value);
    const second = hash(0x9e3779b9, value.split('').reverse().join(''));
    return `v1_${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

const IMMUTABLE_SOURCE_IDENTITY_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Creates the collision-safe identity persisted for a newly imported media source.
 *
 * The v1 prefix remains a metadata compatibility checksum. A separate random import identity
 * makes two different byte streams with identical name, type, size, and mtime distinct without
 * reading a multi-gigabyte File into memory. This deliberately gives up cross-import content
 * deduplication: correctness is preferable to reusing derived frames or peaks for the wrong file.
 */
export function createImmutableVideoSourceFingerprint(
    input: VideoFingerprintInput,
    importIdentity = crypto.randomUUID(),
): string {
    if (!IMMUTABLE_SOURCE_IDENTITY_PATTERN.test(importIdentity)) {
        throw new Error('Media source import identity must contain only safe ID characters.');
    }
    return `v2_${createVideoSourceFingerprint(input).slice(3)}_${importIdentity}`;
}

/**
 * Upgrades a metadata-only legacy fingerprint to a durable identity without reading the File.
 *
 * The length-prefixed scope is encoded losslessly instead of hashed. That makes the upgrade
 * deterministic across reloads while keeping two legacy blobs in different project/source slots
 * isolated even when every piece of File metadata is identical. New imports must continue using
 * a random identity: this project-scoped form exists only for records that predate import IDs.
 */
export function createLegacySourceUpgradeFingerprint(
    input: VideoFingerprintInput,
    scope: LegacySourceFingerprintScope,
): string {
    const scopeParts = [scope.projectId, scope.kind, scope.sourceId];
    const scopeValue = scopeParts.map((part) => `${part.length}:${part}`).join('|');
    let encodedScope = '';
    // Encoding every UTF-16 code unit avoids TextEncoder's replacement of lone surrogates, so
    // even unusual imported project IDs retain a one-to-one mapping to the cache identity.
    for (let index = 0; index < scopeValue.length; index += 1) {
        encodedScope += scopeValue.charCodeAt(index).toString(16).padStart(4, '0');
    }
    return createImmutableVideoSourceFingerprint(input, `legacy_${encodedScope}`);
}

/** Returns true for the durable v2 identity format used by new imports and legacy migrations. */
export function isImmutableVideoSourceFingerprint(fingerprint: string): boolean {
    const match = /^v2_([0-9a-f]{16})_([A-Za-z0-9_-]+)$/.exec(fingerprint);
    return Boolean(match);
}

/**
 * Validates both deterministic v1 fingerprints and durable v2 fingerprints against File
 * metadata. Keeping v1 readable preserves V1/V2/V3 projects and bundles created before the
 * immutable import identity was introduced.
 */
export function doesVideoSourceFingerprintMatch(
    fingerprint: string,
    input: VideoFingerprintInput,
): boolean {
    const legacyFingerprint = createVideoSourceFingerprint(input);
    if (fingerprint === legacyFingerprint) return true;
    if (!isImmutableVideoSourceFingerprint(fingerprint)) return false;
    return fingerprint.startsWith(`v2_${legacyFingerprint.slice(3)}_`);
}

export function validateEditorDocument(document: EditorDocumentV2): VideoDocumentValidationResult {
    const issues: VideoDocumentValidationIssue[] = [];
    const addIssue = (
        code: VideoDocumentValidationIssue['code'],
        path: string,
        message: string,
    ): void => {
        issues.push({ code, path, message });
    };

    if (!Number.isInteger(document.revision) || document.revision <= 0) {
        addIssue('invalid-revision', 'revision', 'Revision must be a positive integer.');
    }
    if (!isPositiveFinite(document.projectFps)) {
        addIssue('invalid-project-fps', 'projectFps', 'Project FPS must be positive and finite.');
    }

    validateUniqueIds(
        document.videoSources,
        'videoSources',
        issues,
        (source) => source.id,
    );
    const clipIds = validateUniqueIds(document.videoClips, 'videoClips', issues, (clip) => clip.id);
    const trackIds = validateUniqueIds(document.tracks, 'tracks', issues, (track) => track.id);
    const subtitleIds = new Set<string>();

    document.videoSources.forEach((source, index) => {
        const path = `videoSources[${index}]`;
        if (!isSafeVideoId(source.id)) {
            addIssue('invalid-id', `${path}.id`, 'Video source ID must use only safe ID characters.');
        }
        validateSourceMetadata(source, path, addIssue);
        validateSourceFile(source, path, addIssue);
    });

    document.tracks.forEach((track, trackIndex) => {
        const trackPath = `tracks[${trackIndex}]`;
        if (!isSafeVideoId(track.id)) {
            addIssue('invalid-id', `${trackPath}.id`, 'Track ID must use only safe ID characters.');
        }
        track.subtitles.forEach((subtitle, subtitleIndex) => {
            const subtitlePath = `${trackPath}.subtitles[${subtitleIndex}]`;
            if (subtitleIds.has(subtitle.id)) {
                addIssue('duplicate-id', `${subtitlePath}.id`, `Duplicate subtitle ID "${subtitle.id}".`);
            }
            subtitleIds.add(subtitle.id);
            validateSubtitle(subtitle, subtitlePath, addIssue);
        });
    });

    const sourcesById = new Map(document.videoSources.map((source) => [source.id, source]));
    document.videoClips.forEach((clip, index) => {
        const path = `videoClips[${index}]`;
        if (!isSafeVideoId(clip.id)) {
            addIssue('invalid-id', `${path}.id`, 'Video clip ID must use only safe ID characters.');
        }
        const source = sourcesById.get(clip.sourceId);
        if (!source) {
            addIssue('missing-source', `${path}.sourceId`, `Unknown source ID "${clip.sourceId}".`);
            return;
        }
        if (!isValidClipBounds(clip, source, document.projectFps)) {
            addIssue(
                'invalid-clip-bounds',
                path,
                'Clip bounds must be within the source and span at least one project frame.',
            );
        }
    });

    if (document.activeTrackId !== null && !trackIds.has(document.activeTrackId)) {
        addIssue('missing-track', 'activeTrackId', `Unknown active track ID "${document.activeTrackId}".`);
    }
    if (document.selectedClipId !== null && !clipIds.has(document.selectedClipId)) {
        addIssue('missing-clip', 'selectedClipId', `Unknown selected clip ID "${document.selectedClipId}".`);
    }
    document.selectedSubtitleIds.forEach((id, index) => {
        if (!subtitleIds.has(id)) {
            addIssue('missing-subtitle', `selectedSubtitleIds[${index}]`, `Unknown subtitle ID "${id}".`);
        }
    });

    Object.entries(document.transcriptionByTrackId).forEach(([trackId, state]) => {
        const path = `transcriptionByTrackId.${trackId}`;
        if (!isSafeVideoId(trackId)) {
            addIssue('invalid-id', path, 'Transcription track ID must use only safe ID characters.');
        }
        const track = document.tracks.find((candidate) => candidate.id === trackId);
        if (!track) {
            addIssue('missing-track', path, `Transcription provenance references unknown track "${trackId}".`);
            return;
        }

        const rawIds = new Set<string>();
        state.raw.forEach((subtitle, index) => {
            const subtitlePath = `${path}.raw[${index}]`;
            if (rawIds.has(subtitle.id)) {
                addIssue(
                    'invalid-transcription-provenance',
                    `${subtitlePath}.id`,
                    `Duplicate raw transcription ID "${subtitle.id}".`,
                );
            }
            rawIds.add(subtitle.id);
            validateSubtitle(subtitle, subtitlePath, addIssue);
        });

        const containerIds = new Set(state.containerIds);
        if (containerIds.size !== state.containerIds.length) {
            addIssue(
                'invalid-transcription-provenance',
                `${path}.containerIds`,
                'Transcription container IDs must be unique.',
            );
        }
        state.containerIds.forEach((containerId, index) => {
            if (!isSafeVideoId(containerId)) {
                addIssue(
                    'invalid-id',
                    `${path}.containerIds[${index}]`,
                    'Transcription container ID must use only safe ID characters.',
                );
            }
            if (!(containerId in state.groups)) {
                addIssue(
                    'invalid-transcription-provenance',
                    `${path}.containerIds[${index}]`,
                    `Transcription container "${containerId}" has no group.`,
                );
            }
        });
        Object.entries(state.groups).forEach(([containerId, group]) => {
            if (!isSafeVideoId(containerId)) {
                addIssue(
                    'invalid-id',
                    `${path}.groups.${containerId}`,
                    'Transcription group ID must use only safe ID characters.',
                );
            }
            if (!containerIds.has(containerId)) {
                addIssue(
                    'invalid-transcription-provenance',
                    `${path}.groups.${containerId}`,
                    `Transcription group "${containerId}" is not listed as a container.`,
                );
            }
            const groupIds = new Set<string>();
            group.forEach((subtitle, index) => {
                const subtitlePath = `${path}.groups.${containerId}[${index}]`;
                if (groupIds.has(subtitle.id)) {
                    addIssue(
                        'invalid-transcription-provenance',
                        `${subtitlePath}.id`,
                        `Duplicate grouped transcription ID "${subtitle.id}".`,
                    );
                }
                groupIds.add(subtitle.id);
                if (!rawIds.has(subtitle.id)) {
                    addIssue(
                        'invalid-transcription-provenance',
                        subtitlePath,
                        `Grouped subtitle "${subtitle.id}" is not present in raw transcription.`,
                    );
                }
                validateSubtitle(subtitle, subtitlePath, addIssue);
            });
        });
    });

    return { valid: issues.length === 0, issues };
}

export function snapProjectTime(time: number, projectFps: number, maximum = Number.POSITIVE_INFINITY): number {
    assertPositiveFinite(projectFps, 'projectFps');
    const safeTime = Number.isFinite(time) ? Math.max(0, time) : 0;
    const snapped = Math.round(safeTime * projectFps) / projectFps;
    return Math.min(snapped, Math.max(0, maximum));
}

/**
 * Picks the last complete project-grid boundary that does not exceed the decoded source.
 * A proportional guard compensates for binary floating-point values such as 1 / 30 without
 * ever authorizing a boundary past the real duration.
 */
export function getImportedSourceEnd(duration: number, projectFps: number): number {
    assertNonNegativeFinite(duration, 'duration');
    assertPositiveFinite(projectFps, 'projectFps');
    const projectFrameDuration = 1 / projectFps;
    if (duration < projectFrameDuration - NUMERICAL_GUARD) {
        return duration;
    }
    const guard = projectFrameDuration * 1e-7;
    const gridEnd = Math.floor((duration + guard) / projectFrameDuration) * projectFrameDuration;
    return Math.min(duration, Math.max(0, gridEnd));
}

/**
 * Resolves the source frame grid used by preview and export. CFR media is frame-accurate;
 * VFR sources use the inspected average packet rate as a documented best-effort seek grid,
 * while Mediabunny still returns the real decoded frame at or around that source timestamp.
 */
export function getSourceFrameAtOrBefore(
    sourceTime: number,
    sourceFps: number,
    sourceDuration: number,
): SourceFramePosition {
    assertPositiveFinite(sourceFps, 'sourceFps');
    assertNonNegativeFinite(sourceDuration, 'sourceDuration');
    if (sourceDuration === 0) {
        return { index: 0, time: 0 };
    }

    const safeSourceTime = Number.isFinite(sourceTime) ? Math.max(0, sourceTime) : 0;
    const requestedIndex = Math.floor(safeSourceTime * sourceFps + NUMERICAL_GUARD);
    // ceil(duration * fps) counts a final partial CFR frame. Subtracting the guard ensures an
    // exact duration such as 1s at 24fps still ends at index 23 rather than inventing frame 24.
    const frameCount = Math.max(1, Math.ceil(sourceDuration * sourceFps - NUMERICAL_GUARD));
    const index = Math.min(requestedIndex, frameCount - 1);
    return { index, time: index / sourceFps };
}

export function sourceFrameIndexAtOrBefore(
    sourceTime: number,
    sourceFps: number,
    sourceDuration: number,
): number {
    return getSourceFrameAtOrBefore(sourceTime, sourceFps, sourceDuration).index;
}

export function sourceFrameTimeAtOrBefore(
    sourceTime: number,
    sourceFps: number,
    sourceDuration: number,
): number {
    return getSourceFrameAtOrBefore(sourceTime, sourceFps, sourceDuration).time;
}

export function buildClipPlacements(
    videoClips: readonly VideoClip[],
    frameRate?: RationalFrameRate | number,
): ClipPlacement[] {
    let projectStartFrame = 0;
    return videoClips.map((clip, index) => {
        const rawDuration = Math.max(0, clip.sourceEnd - clip.sourceStart);
        const durationFrames = frameRate ? durationToNearestFrames(rawDuration, frameRate) : 0;
        const projectStart = frameRate ? frameBoundaryToSeconds(projectStartFrame, frameRate) : projectStartFrame;
        const duration = frameRate ? frameBoundaryToSeconds(durationFrames, frameRate) : rawDuration;
        const placement: ClipPlacement = {
            clip,
            index,
            projectStart,
            projectEnd: projectStart + duration,
            duration,
        };
        projectStartFrame = frameRate ? projectStartFrame + durationFrames : placement.projectEnd;
        return placement;
    });
}

export function getMediaDuration(
    videoClips: readonly VideoClip[],
    frameRate?: RationalFrameRate | number,
): number {
    if (!frameRate) {
        return videoClips.reduce((duration, clip) => duration + Math.max(0, clip.sourceEnd - clip.sourceStart), 0);
    }
    const totalFrames = videoClips.reduce(
        (frames, clip) => frames + durationToNearestFrames(Math.max(0, clip.sourceEnd - clip.sourceStart), frameRate),
        0,
    );
    return frameBoundaryToSeconds(totalFrames, frameRate);
}

export interface TimelineDurationAudioContext {
    audioTracks: readonly AudioTrack[];
    videoSources: readonly VideoSourceDescriptor[];
    audioSources: readonly AudioSourceDescriptor[];
    renderProfile: RenderProfile;
}

export function getTimelineDurations(
    videoClips: readonly VideoClip[],
    tracks: readonly SubtitleTrack[],
    audioContext?: TimelineDurationAudioContext,
): TimelineDurations {
    const mediaDuration = getMediaDuration(videoClips, audioContext?.renderProfile.fps);
    const maximumSubtitleEnd = tracks.reduce(
        (trackMaximum, track) => track.subtitles.reduce(
            (subtitleMaximum, subtitle) => Math.max(subtitleMaximum, subtitle.endTime),
            trackMaximum,
        ),
        0,
    );
    const contentDuration = audioContext
        ? framesToSeconds(
            getTimelineContentEndFrame(videoClips, tracks, audioContext),
            audioContext.renderProfile.fps,
        )
        : Math.max(mediaDuration, maximumSubtitleEnd);
    return {
        mediaDuration,
        contentDuration,
        viewDuration: contentDuration + VIEW_TAIL_SECONDS,
    };
}

/** Returns the exact frame-domain content boundary used by duration, playback, and export. */
export function getTimelineContentEndFrame(
    videoClips: readonly VideoClip[],
    tracks: readonly SubtitleTrack[],
    context: TimelineDurationAudioContext,
): number {
    const videoEndFrame = videoClips.reduce(
        (frames, clip) => frames + secondsToFrames(
            Math.max(0, clip.sourceEnd - clip.sourceStart),
            context.renderProfile.fps,
            'nearest',
        ),
        0,
    );
    const subtitleEndFrame = tracks.reduce(
        (maximum, track) => track.subtitles.reduce(
            (trackMaximum, subtitle) => Math.max(
                trackMaximum,
                secondsToFrames(Math.max(0, subtitle.endTime), context.renderProfile.fps, 'ceil'),
            ),
            maximum,
        ),
        0,
    );
    return Math.max(videoEndFrame, subtitleEndFrame, getIndependentAudioEndFrame(context));
}

export type TimelineDurationDocumentV4 = Pick<
    EditorDocumentV4,
    | 'renderProfile'
    | 'videoSources'
    | 'videoClips'
    | 'videoTracks'
    | 'audioSources'
    | 'audioTracks'
    | 'subtitleTracks'
>;

export interface TimelineRuntimeDurationDocument {
    renderProfile: RenderProfile;
    videoSources: readonly VideoSourceDescriptor[];
    videoClips: readonly VideoClip[];
    videoTracks: readonly (VideoTrack | VideoTrackV4)[];
    audioSources: readonly AudioSourceDescriptor[];
    audioTracks: readonly AudioTrack[];
    subtitleTracks: readonly SubtitleTrack[];
}

/** Returns the maximum V4 tail across explicit video, independent audio, and subtitles. */
export function getTimelineContentEndFrameV4(document: TimelineDurationDocumentV4): number {
    const videoEndFrame = getExplicitVideoContentEndFrameV4(document);
    const subtitleEndFrame = document.subtitleTracks.reduce(
        (maximum, track) => track.subtitles.reduce(
            (trackMaximum, subtitle) => Math.max(
                trackMaximum,
                secondsToFrames(Math.max(0, subtitle.endTime), document.renderProfile.fps, 'ceil'),
            ),
            maximum,
        ),
        0,
    );
    return Math.max(videoEndFrame, subtitleEndFrame, getIndependentAudioEndFrame({
        audioTracks: document.audioTracks,
        videoSources: document.videoSources,
        audioSources: document.audioSources,
        renderProfile: document.renderProfile,
    }));
}

/** V4 duration projection where explicit gaps count and array order never does. */
export function getTimelineDurationsV4(document: TimelineDurationDocumentV4): TimelineDurations {
    const mediaDuration = framesToSeconds(
        getExplicitVideoContentEndFrameV4(document),
        document.renderProfile.fps,
    );
    const contentDuration = framesToSeconds(
        getTimelineContentEndFrameV4(document),
        document.renderProfile.fps,
    );
    return {
        mediaDuration,
        contentDuration,
        viewDuration: contentDuration + VIEW_TAIL_SECONDS,
    };
}

/**
 * Version-adaptive boundary used by incremental store/audio integration.
 *
 * The explicit V4 shape is selected from durable track fields even for an empty clip catalog, so
 * an empty V4 timeline with an audio/subtitle tail never falls through a cumulative video helper.
 */
export function getTimelineContentEndFrameForRuntime(
    document: TimelineRuntimeDurationDocument,
): number {
    const firstTrack = document.videoTracks[0];
    if (firstTrack && 'visible' in firstTrack && 'locked' in firstTrack) {
        return getTimelineContentEndFrameV4(document as TimelineDurationDocumentV4);
    }
    return getTimelineContentEndFrame(
        document.videoClips,
        document.subtitleTracks,
        {
            audioTracks: document.audioTracks,
            videoSources: document.videoSources,
            audioSources: document.audioSources,
            renderProfile: document.renderProfile,
        },
    );
}

export function resolveClipAtProjectTime(
    placements: readonly ClipPlacement[],
    projectTime: number,
): ClipPlacement | null {
    if (!Number.isFinite(projectTime) || projectTime < 0 || placements.length === 0) {
        return null;
    }
    const mediaDuration = placements[placements.length - 1].projectEnd;
    if (projectTime >= mediaDuration) {
        return null;
    }

    let low = 0;
    let high = placements.length - 1;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const placement = placements[middle];
        if (projectTime < placement.projectStart) {
            high = middle - 1;
        } else if (projectTime >= placement.projectEnd) {
            low = middle + 1;
        } else {
            return placement;
        }
    }
    return null;
}

export function projectTimeToSourceTime(placement: ClipPlacement, projectTime: number): number {
    return placement.clip.sourceStart + (projectTime - placement.projectStart);
}

export function appendVideoClips(
    videoClips: readonly VideoClip[],
    appendedClips: readonly VideoClip[],
    oldContentDuration: number,
    frameRate?: RationalFrameRate | number,
): MediaEditResult {
    const oldMediaDuration = getMediaDuration(videoClips, frameRate);
    const nextClips = [...videoClips, ...appendedClips];
    const newMediaDuration = getMediaDuration(nextClips, frameRate);
    const retainedIntervals: RetainedIntervalMapping[] = [];
    if (oldMediaDuration > 0) {
        retainedIntervals.push(createMapping(0, oldMediaDuration, 0, 'media'));
    }
    retainedIntervals.push(createBlackTailMapping(oldMediaDuration, oldContentDuration, newMediaDuration));
    return createEditResult([...nextClips], retainedIntervals, oldMediaDuration, newMediaDuration, oldContentDuration);
}

/**
 * Split is deliberately the only edit that does not expose caption mappings. The project time
 * and all media content stay identical, so transforming subtitles would merely fragment a
 * caption crossing the new clip boundary.
 */
export function splitVideoClip(
    videoClips: readonly VideoClip[],
    clipId: string,
    projectTime: number,
    rightClipId: string,
    projectFps: number,
): SplitClipResult {
    assertPositiveFinite(projectFps, 'projectFps');
    if (!isSafeVideoId(rightClipId) || videoClips.some((clip) => clip.id === rightClipId)) {
        throw new Error('The right clip ID must be safe and unique.');
    }
    const placements = buildClipPlacements(videoClips, projectFps);
    const placement = placements.find((candidate) => candidate.clip.id === clipId);
    if (!placement) {
        throw new Error(`Unknown clip ID "${clipId}".`);
    }

    const snappedProjectTime = snapProjectTime(projectTime, projectFps, placement.projectEnd);
    const splitSourceTime = placement.clip.sourceStart + (snappedProjectTime - placement.projectStart);
    const minimumDuration = 1 / projectFps;
    if (
        splitSourceTime - placement.clip.sourceStart < minimumDuration - NUMERICAL_GUARD
        || placement.clip.sourceEnd - splitSourceTime < minimumDuration - NUMERICAL_GUARD
    ) {
        throw new Error('Both split clips must span at least one project frame.');
    }

    const leftClip: VideoClip = { ...placement.clip, sourceEnd: splitSourceTime };
    const rightClip: VideoClip = {
        ...placement.clip,
        id: rightClipId,
        sourceStart: splitSourceTime,
    };
    const nextClips = videoClips.flatMap((clip) => clip.id === clipId ? [leftClip, rightClip] : [clip]);
    return { videoClips: nextClips, leftClip, rightClip };
}

export function trimVideoClip(
    videoClips: readonly VideoClip[],
    clipId: string,
    sourceStart: number,
    sourceEnd: number,
    videoSources: readonly VideoSourceDescriptor[],
    projectFps: number,
    oldContentDuration: number,
): MediaEditResult {
    const target = videoClips.find((clip) => clip.id === clipId);
    if (!target) {
        throw new Error(`Unknown clip ID "${clipId}".`);
    }
    const source = videoSources.find((candidate) => candidate.id === target.sourceId);
    if (!source) {
        throw new Error(`Unknown source ID "${target.sourceId}".`);
    }
    if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd)) {
        throw new Error('Trim bounds must be finite.');
    }

    const deterministicSourceEnd = getImportedSourceEnd(source.duration, projectFps);
    // Trim handles are expressed on the project grid even when the source uses a different
    // frame rate. Clamp after nearest-frame snapping so rounding can never expose a fractional
    // source tail beyond the same deterministic bound used by initial import.
    const snappedSourceStart = snapProjectTime(sourceStart, projectFps, deterministicSourceEnd);
    const snappedSourceEnd = snapProjectTime(sourceEnd, projectFps, deterministicSourceEnd);
    const trimmedClip = {
        ...target,
        sourceStart: snappedSourceStart,
        sourceEnd: snappedSourceEnd,
    };
    if (!isValidClipBounds(trimmedClip, source, projectFps)) {
        throw new Error('Trim bounds must stay within the source and span at least one project frame.');
    }

    const oldPlacements = buildClipPlacements(videoClips, projectFps);
    const nextClips = videoClips.map((clip) => clip.id === clipId ? trimmedClip : clip);
    const newPlacements = buildClipPlacements(nextClips, projectFps);
    const retainedIntervals: RetainedIntervalMapping[] = [];

    oldPlacements.forEach((oldPlacement) => {
        const newPlacement = newPlacements.find((candidate) => candidate.clip.id === oldPlacement.clip.id);
        if (!newPlacement) {
            return;
        }
        const retainedSourceStart = Math.max(oldPlacement.clip.sourceStart, newPlacement.clip.sourceStart);
        const retainedSourceEnd = Math.min(oldPlacement.clip.sourceEnd, newPlacement.clip.sourceEnd);
        if (retainedSourceEnd <= retainedSourceStart + NUMERICAL_GUARD) {
            return;
        }
        const oldStart = oldPlacement.projectStart + retainedSourceStart - oldPlacement.clip.sourceStart;
        const newStart = newPlacement.projectStart + retainedSourceStart - newPlacement.clip.sourceStart;
        pushCoalescedMapping(
            retainedIntervals,
            createMapping(oldStart, oldStart + retainedSourceEnd - retainedSourceStart, newStart, 'media'),
        );
    });

    const oldMediaDuration = getMediaDuration(videoClips, projectFps);
    const newMediaDuration = getMediaDuration(nextClips, projectFps);
    retainedIntervals.push(createBlackTailMapping(oldMediaDuration, oldContentDuration, newMediaDuration));
    return createEditResult([...nextClips], retainedIntervals, oldMediaDuration, newMediaDuration, oldContentDuration);
}

export function deleteVideoClip(
    videoClips: readonly VideoClip[],
    clipId: string,
    oldContentDuration: number,
    frameRate?: RationalFrameRate | number,
): MediaEditResult {
    if (!videoClips.some((clip) => clip.id === clipId)) {
        throw new Error(`Unknown clip ID "${clipId}".`);
    }
    const nextClips = videoClips.filter((clip) => clip.id !== clipId);
    return buildPlacementEditResult(videoClips, nextClips, oldContentDuration, frameRate);
}

export function reorderVideoClips(
    videoClips: readonly VideoClip[],
    orderedClipIds: readonly string[],
    oldContentDuration: number,
    frameRate?: RationalFrameRate | number,
): MediaEditResult {
    if (orderedClipIds.length !== videoClips.length || new Set(orderedClipIds).size !== videoClips.length) {
        throw new Error('Reordered clip IDs must be a complete unique permutation.');
    }
    const clipsById = new Map(videoClips.map((clip) => [clip.id, clip]));
    const nextClips = orderedClipIds.map((id) => {
        const clip = clipsById.get(id);
        if (!clip) {
            throw new Error(`Unknown clip ID "${id}".`);
        }
        return clip;
    });
    return buildPlacementEditResult(videoClips, nextClips, oldContentDuration, frameRate);
}

export function transformSubtitleTracks(
    tracks: readonly SubtitleTrack[],
    retainedIntervals: readonly RetainedIntervalMapping[],
    idFactory: TimelineIdFactory,
): SubtitleTrack[] {
    const usableMappings = retainedIntervals.filter(
        (mapping) => mapping.oldEnd > mapping.oldStart && mapping.newEnd > mapping.newStart,
    );

    return tracks.map((track) => {
        const subtitles = track.subtitles.flatMap((subtitle) => {
            const fragments = usableMappings.flatMap((mapping) => {
                const oldStart = Math.max(subtitle.startTime, mapping.oldStart);
                const oldEnd = Math.min(subtitle.endTime, mapping.oldEnd);
                if (oldEnd <= oldStart + NUMERICAL_GUARD) {
                    return [];
                }
                const startTime = mapping.newStart + oldStart - mapping.oldStart;
                return [{ oldStart, oldEnd, startTime, endTime: startTime + oldEnd - oldStart }];
            });

            const preservesCompleteSubtitle = fragments.length === 1
                && nearlyEqual(fragments[0].oldStart, subtitle.startTime)
                && nearlyEqual(fragments[0].oldEnd, subtitle.endTime);
            return fragments.map((fragment) => ({
                ...subtitle,
                id: preservesCompleteSubtitle ? subtitle.id : idFactory(),
                startTime: fragment.startTime,
                endTime: fragment.endTime,
            }));
        });

        return {
            ...track,
            subtitles: subtitles.sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime),
        };
    });
}

export function cleanSubtitleSelection(
    selectedSubtitleIds: readonly string[],
    tracks: readonly SubtitleTrack[],
): string[] {
    const retainedIds = new Set(tracks.flatMap((track) => track.subtitles.map((subtitle) => subtitle.id)));
    return selectedSubtitleIds.filter((id) => retainedIds.has(id));
}

export function applyMediaEditToTimeline(
    tracks: readonly SubtitleTrack[],
    selectedSubtitleIds: readonly string[],
    edit: MediaEditResult,
    idFactory: TimelineIdFactory,
): TransformedTimeline {
    const transformedTracks = transformSubtitleTracks(tracks, edit.retainedIntervals, idFactory);
    return {
        tracks: transformedTracks,
        selectedSubtitleIds: cleanSubtitleSelection(selectedSubtitleIds, transformedTracks),
    };
}

function validateUniqueIds<T>(
    values: readonly T[],
    path: string,
    issues: VideoDocumentValidationIssue[],
    getId: (value: T) => string,
): Set<string> {
    const ids = new Set<string>();
    values.forEach((value, index) => {
        const id = getId(value);
        if (ids.has(id)) {
            issues.push({ code: 'duplicate-id', path: `${path}[${index}].id`, message: `Duplicate ID "${id}".` });
        }
        ids.add(id);
    });
    return ids;
}

function validateSourceMetadata(
    source: VideoSourceDescriptor,
    path: string,
    addIssue: (code: VideoDocumentValidationIssue['code'], path: string, message: string) => void,
): void {
    const fingerprintInput = {
        name: source.originalName,
        type: source.mimeType,
        size: source.size,
        lastModified: source.lastModified,
    };
    if (
        !isPositiveFinite(source.duration)
        || !isPositiveFinite(source.fps)
        || !Number.isInteger(source.width)
        || source.width <= 0
        || !Number.isInteger(source.height)
        || source.height <= 0
        || !Number.isInteger(source.size)
        || source.size < 0
        || !Number.isFinite(source.lastModified)
        || (source.bitrate !== null && (!Number.isFinite(source.bitrate) || source.bitrate < 0))
        || !doesVideoSourceFingerprintMatch(source.fingerprint, fingerprintInput)
    ) {
        addIssue('invalid-source', path, 'Video source metadata contains invalid numeric values.');
    }
}

function validateSourceFile(
    source: VideoSourceAsset,
    path: string,
    addIssue: (code: VideoDocumentValidationIssue['code'], path: string, message: string) => void,
): void {
    if (!source.file) {
        addIssue('file-mismatch', `${path}.file`, 'Source File is missing.');
        return;
    }
    const fingerprintMatches = doesVideoSourceFingerprintMatch(source.fingerprint, {
        name: source.file.name,
        type: source.file.type,
        size: source.file.size,
        lastModified: source.file.lastModified,
    });
    if (
        source.file.name !== source.originalName
        || source.file.type !== source.mimeType
        || source.file.size !== source.size
        || source.file.lastModified !== source.lastModified
        || !fingerprintMatches
    ) {
        addIssue('file-mismatch', `${path}.file`, 'Source File metadata does not match its descriptor.');
    }
}

function validateSubtitle(
    subtitle: Subtitle,
    path: string,
    addIssue: (code: VideoDocumentValidationIssue['code'], path: string, message: string) => void,
): void {
    if (!isSafeVideoId(subtitle.id)) {
        addIssue('invalid-id', `${path}.id`, 'Subtitle ID must use only safe ID characters.');
    }
    if (
        !Number.isFinite(subtitle.startTime)
        || !Number.isFinite(subtitle.endTime)
        || subtitle.startTime < 0
        || subtitle.endTime <= subtitle.startTime
    ) {
        addIssue(
            'invalid-subtitle-interval',
            path,
            'Subtitle intervals must be finite, non-negative, and have a positive duration.',
        );
    }
}

function isValidClipBounds(
    clip: VideoClip,
    source: VideoSourceDescriptor,
    projectFps: number,
): boolean {
    if (
        !isPositiveFinite(projectFps)
        || !Number.isFinite(clip.sourceStart)
        || !Number.isFinite(clip.sourceEnd)
        || clip.sourceStart < 0
        || clip.sourceEnd > source.duration
        || clip.sourceEnd <= clip.sourceStart + NUMERICAL_GUARD
    ) {
        return false;
    }
    const projectFrameDuration = 1 / projectFps;
    const isWholeShortSource = source.duration < projectFrameDuration - NUMERICAL_GUARD
        && nearlyEqual(clip.sourceStart, 0)
        && nearlyEqual(clip.sourceEnd, source.duration);
    if (isWholeShortSource) {
        return true;
    }

    const clipDuration = clip.sourceEnd - clip.sourceStart;
    return clipDuration >= projectFrameDuration - NUMERICAL_GUARD
        && isOnProjectGrid(clip.sourceStart, projectFps)
        && isOnProjectGrid(clip.sourceEnd, projectFps);
}

function buildPlacementEditResult(
    oldClips: readonly VideoClip[],
    nextClips: readonly VideoClip[],
    oldContentDuration: number,
    frameRate?: RationalFrameRate | number,
): MediaEditResult {
    const oldPlacements = buildClipPlacements(oldClips, frameRate);
    const newPlacementsById = new Map(buildClipPlacements(nextClips, frameRate).map((placement) => [placement.clip.id, placement]));
    const retainedIntervals: RetainedIntervalMapping[] = [];
    oldPlacements.forEach((oldPlacement) => {
        const newPlacement = newPlacementsById.get(oldPlacement.clip.id);
        if (newPlacement) {
            pushCoalescedMapping(
                retainedIntervals,
                createMapping(
                    oldPlacement.projectStart,
                    oldPlacement.projectEnd,
                    newPlacement.projectStart,
                    'media',
                ),
            );
        }
    });
    const oldMediaDuration = getMediaDuration(oldClips, frameRate);
    const newMediaDuration = getMediaDuration(nextClips, frameRate);
    retainedIntervals.push(createBlackTailMapping(oldMediaDuration, oldContentDuration, newMediaDuration));
    return createEditResult(Array.from(nextClips), retainedIntervals, oldMediaDuration, newMediaDuration, oldContentDuration);
}

function createMapping(
    oldStart: number,
    oldEnd: number,
    newStart: number,
    kind: RetainedIntervalMapping['kind'],
): RetainedIntervalMapping {
    return { oldStart, oldEnd, newStart, newEnd: newStart + oldEnd - oldStart, kind };
}

function createBlackTailMapping(
    oldMediaDuration: number,
    oldContentDuration: number,
    newMediaDuration: number,
): RetainedIntervalMapping {
    const safeOldContentDuration = Math.max(oldMediaDuration, oldContentDuration);
    return createMapping(oldMediaDuration, safeOldContentDuration, newMediaDuration, 'black-tail');
}

function pushCoalescedMapping(
    mappings: RetainedIntervalMapping[],
    mapping: RetainedIntervalMapping,
): void {
    const previous = mappings[mappings.length - 1];
    if (
        previous
        && previous.kind === mapping.kind
        && nearlyEqual(previous.oldEnd, mapping.oldStart)
        && nearlyEqual(previous.newEnd, mapping.newStart)
    ) {
        previous.oldEnd = mapping.oldEnd;
        previous.newEnd = mapping.newEnd;
        return;
    }
    mappings.push(mapping);
}

function createEditResult(
    videoClips: VideoClip[],
    retainedIntervals: RetainedIntervalMapping[],
    oldMediaDuration: number,
    newMediaDuration: number,
    oldContentDuration: number,
): MediaEditResult {
    return {
        videoClips,
        retainedIntervals,
        oldMediaDuration,
        newMediaDuration,
        oldContentDuration: Math.max(oldMediaDuration, oldContentDuration),
    };
}

function nearlyEqual(left: number, right: number): boolean {
    return Math.abs(left - right) <= NUMERICAL_GUARD;
}

function isOnProjectGrid(time: number, projectFps: number): boolean {
    const frameIndex = Math.round(time * projectFps);
    return nearlyEqual(time, frameIndex / projectFps);
}

function isPositiveFinite(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function getIndependentAudioEndFrame(context: TimelineDurationAudioContext): number {
    const audioSourcesById = new Map(context.audioSources.map((source) => [source.id, source]));
    const videoSourcesById = new Map(context.videoSources.map((source) => [source.id, source]));
    return context.audioTracks.reduce((trackMaximum, track) => track.clips.reduce((clipMaximum, clip) => {
        if ('sourceStart' in clip) {
            const source = videoSourcesById.get(clip.source.videoSourceId);
            if (!source?.hasAudio) return clipMaximum;
            return Math.max(
                clipMaximum,
                clip.timelineStartFrame + secondsToFrames(
                    Math.max(0, clip.sourceEnd - clip.sourceStart),
                    context.renderProfile.fps,
                    'nearest',
                ),
            );
        }

        const source = audioSourcesById.get(clip.source.audioSourceId);
        if (!source) return clipMaximum;
        const durationOutputSamples = clip.timelineDurationSamples ?? (
            nativeBoundaryToOutputSample(
                clip.sourceEndSample,
                source.nativeSampleRate,
            ) - nativeBoundaryToOutputSample(clip.sourceStartSample, source.nativeSampleRate)
        );
        const endOutputSample = frameToOutputSample(clip.timelineStartFrame, context.renderProfile.fps)
            + durationOutputSamples;
        return Math.max(
            clipMaximum,
            outputSampleToCoveringFrame(endOutputSample, context.renderProfile.fps),
        );
    }, trackMaximum), 0);
}

function durationToNearestFrames(duration: number, frameRate: RationalFrameRate | number): number {
    return typeof frameRate === 'number'
        ? Math.max(0, Math.round(duration * frameRate))
        : secondsToFrames(duration, frameRate, 'nearest');
}

function frameBoundaryToSeconds(frame: number, frameRate: RationalFrameRate | number): number {
    return typeof frameRate === 'number' ? frame / frameRate : framesToSeconds(frame, frameRate);
}

function assertPositiveFinite(value: number, name: string): void {
    if (!isPositiveFinite(value)) {
        throw new Error(`${name} must be positive and finite.`);
    }
}

function assertNonNegativeFinite(value: number, name: string): void {
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be non-negative and finite.`);
    }
}
