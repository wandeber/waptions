import {
    findAudioClip,
    moveAudioClipInTracks,
    splitAudioClipInTracks,
    trimAudioClipInTracks,
} from './audio-timeline';
import { secondsToFrames } from './render-profile';
import {
    applyMediaEditToTimeline,
    cleanSubtitleSelection,
    splitVideoClip as splitClipInTimeline,
} from './video-timeline';
import type { Subtitle, SubtitleTrack } from '@/types/timeline';
import type {
    AudioSourceAsset,
    AudioTrack,
    RenderProfile,
    VideoClip,
    VideoClipAudioSettings,
    VideoClipV3,
    VideoSourceAsset,
} from '@/types/video';

export interface AudioCommandState {
    audioTracks: AudioTrack[];
    videoSources: VideoSourceAsset[];
    audioSources: AudioSourceAsset[];
    renderProfile: RenderProfile;
}

export function updateSubtitleCommand(
    tracks: readonly SubtitleTrack[],
    trackId: string,
    subtitleId: string,
    updates: Partial<Subtitle>,
): SubtitleTrack[] | null {
    const track = tracks.find((item) => item.id === trackId);
    const subtitle = track?.subtitles.find((item) => item.id === subtitleId);
    if (!subtitle) return null;
    const candidate = { ...subtitle, ...updates };
    // Subtitle typing is a hot path. Compare its fixed scalar contract directly so a no-op does
    // not allocate serialized copies of the subtitle (or become sensitive to property order).
    if (candidate.id === subtitle.id
        && candidate.startTime === subtitle.startTime
        && candidate.endTime === subtitle.endTime
        && candidate.text === subtitle.text) return null;
    return tracks.map((item) => item.id === trackId
        ? {
            ...item,
            subtitles: item.subtitles.map((entry) => entry.id === subtitleId ? candidate : entry),
        }
        : item);
}

export function moveAudioClipCommand(
    state: AudioCommandState,
    clipId: string,
    targetTrackId: string,
    timelineStartFrame: number,
): AudioTrack[] | null {
    return moveAudioClipInTracks(
        state.audioTracks,
        selectAudioSources(state),
        state.renderProfile,
        clipId,
        targetTrackId,
        timelineStartFrame,
    );
}

export function trimAudioClipCommand(
    state: AudioCommandState,
    clipId: string,
    side: 'left' | 'right',
    timelineFrame: number,
): AudioTrack[] | null {
    return trimAudioClipInTracks(
        state.audioTracks,
        selectAudioSources(state),
        state.renderProfile,
        clipId,
        side,
        timelineFrame,
    );
}

export function splitAudioClipCommand(
    state: AudioCommandState,
    clipId: string,
    timelineFrame: number,
    rightClipId: string,
): { audioTracks: AudioTrack[]; trackId: string } | null {
    const audioTracks = splitAudioClipInTracks(
        state.audioTracks,
        selectAudioSources(state),
        state.renderProfile,
        clipId,
        timelineFrame,
        rightClipId,
    );
    if (!audioTracks) return null;
    const located = findAudioClip(audioTracks, selectAudioSources(state), rightClipId);
    return located ? { audioTracks, trackId: located.track.id } : null;
}

export function deleteAudioClipCommand(
    state: AudioCommandState,
    clipId: string,
): AudioTrack[] | null {
    const located = findAudioClip(state.audioTracks, selectAudioSources(state), clipId);
    if (!located || located.track.locked) return null;
    return state.audioTracks.map((track) => track.id === located.track.id
        ? { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }
        : track);
}

export function splitVideoClipCommand(
    clips: readonly VideoClipV3[],
    clipId: string,
    projectTime: number,
    rightClipId: string,
    renderProfile: RenderProfile,
): VideoClipV3[] | null {
    const originalClip = clips.find((clip) => clip.id === clipId);
    if (!originalClip) return null;
    let result: ReturnType<typeof splitClipInTimeline>;
    try {
        result = splitClipInTimeline(
            clips,
            clipId,
            projectTime,
            rightClipId,
            renderProfile.fps.numerator / renderProfile.fps.denominator,
        );
    } catch {
        return null;
    }

    return cloneVideoClips(result.videoClips).map((clip): VideoClipV3 => {
        if (!originalClip.audio || !clip.audio) return clip;
        const durationFrames = getCanonicalVideoClipDurationFrames(clip, renderProfile);
        if (clip.id === clipId) {
            // The split seam is not a real media boundary, so the left side cannot inherit the
            // outer fade-out. The same rule is used for linked and detached embedded audio.
            return {
                ...clip,
                audio: clampVideoClipAudioFades({ ...originalClip.audio, fadeOutFrames: 0 }, durationFrames),
            };
        }
        if (clip.id === rightClipId) {
            return {
                ...clip,
                audio: clampVideoClipAudioFades({ ...originalClip.audio, fadeInFrames: 0 }, durationFrames),
            };
        }
        return clip;
    });
}

export function applyVideoEditToSubtitleDomains(
    tracks: SubtitleTrack[],
    selectedSubtitleIds: string[],
    edit: Parameters<typeof applyMediaEditToTimeline>[2],
): { tracks: SubtitleTrack[]; selectedSubtitleIds: string[] } {
    const rippleTracks = tracks.filter((track) => getTrackTimingDomain(track) === 'video-ripple');
    const absoluteTracks = tracks.filter((track) => getTrackTimingDomain(track) === 'absolute');
    const rippleSubtitleIds = new Set(
        rippleTracks.flatMap((track) => track.subtitles.map((subtitle) => subtitle.id)),
    );
    const transformed = applyMediaEditToTimeline(
        rippleTracks,
        selectedSubtitleIds.filter((id) => rippleSubtitleIds.has(id)),
        edit,
        () => crypto.randomUUID(),
    );
    const transformedById = new Map(transformed.tracks.map((track) => [track.id, track]));
    const absoluteById = new Map(absoluteTracks.map((track) => [track.id, track]));
    const nextTracks = tracks.map((track) => (
        transformedById.get(track.id) ?? absoluteById.get(track.id) ?? track
    ));
    const absoluteSelection = selectedSubtitleIds.filter((id) => !rippleSubtitleIds.has(id));
    return {
        tracks: nextTracks,
        selectedSubtitleIds: cleanSubtitleSelection(
            [...absoluteSelection, ...transformed.selectedSubtitleIds],
            nextTracks,
        ),
    };
}

const getTrackTimingDomain = (track: SubtitleTrack): 'video-ripple' | 'absolute' => (
    'timingDomain' in track && track.timingDomain === 'absolute' ? 'absolute' : 'video-ripple'
);

export function haveEqualClipPlacements(
    currentClips: readonly VideoClip[],
    resultingClips: readonly VideoClip[],
): boolean {
    return currentClips.length === resultingClips.length && currentClips.every((clip, index) => {
        const resultingClip = resultingClips[index];
        return resultingClip !== undefined
            && clip.id === resultingClip.id
            && clip.sourceId === resultingClip.sourceId
            && clip.sourceStart === resultingClip.sourceStart
            && clip.sourceEnd === resultingClip.sourceEnd;
    });
}

export function clampVideoClipAudioFades(
    audio: VideoClipAudioSettings,
    durationFrames: number,
): VideoClipAudioSettings {
    const safeDurationFrames = Math.max(1, Math.floor(durationFrames));
    // Scale the pair before clamping either side so two oversized fades retain their ratio.
    let fadeInFrames = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(audio.fadeInFrames)));
    let fadeOutFrames = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(audio.fadeOutFrames)));
    const combinedFrames = fadeInFrames + fadeOutFrames;
    if (combinedFrames > safeDurationFrames) {
        const ratio = safeDurationFrames / combinedFrames;
        fadeInFrames = Math.floor(fadeInFrames * ratio);
        fadeOutFrames = safeDurationFrames - fadeInFrames;
    }
    return { ...audio, fadeInFrames, fadeOutFrames };
}

export function getCanonicalVideoClipDurationFrames(
    clip: Pick<VideoClip, 'sourceStart' | 'sourceEnd'>,
    renderProfile: RenderProfile,
): number {
    return Math.max(1, secondsToFrames(
        clip.sourceEnd - clip.sourceStart,
        renderProfile.fps,
        'nearest',
    ));
}

const selectAudioSources = (state: AudioCommandState) => ({
    videoSources: state.videoSources,
    audioSources: state.audioSources,
});

const cloneVideoClips = (clips: readonly (VideoClip | VideoClipV3)[]): VideoClipV3[] => (
    clips.map((clip) => {
        const extended = clip as VideoClip & { audio?: VideoClipAudioSettings | null };
        return {
            ...extended,
            audio: extended.audio === null
                ? null
                : { ...(extended.audio ?? DEFAULT_VIDEO_CLIP_AUDIO) },
        };
    })
);

const DEFAULT_VIDEO_CLIP_AUDIO: VideoClipAudioSettings = {
    linkState: 'linked',
    muted: false,
    gainDb: 0,
    fadeInFrames: 0,
    fadeOutFrames: 0,
};
