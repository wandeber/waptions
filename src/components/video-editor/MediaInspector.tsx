'use client';

import { useEffect, useRef, useState } from 'react';
import { Headphones, Lock, Unlock, Volume2, VolumeX } from 'lucide-react';
import { secondsToFrames } from '@/lib/render-profile';
import { useTimelineStore } from '@/stores/timeline-store';

interface CommittedRangeProps {
    label: string;
    value: number;
    minimum: number;
    maximum: number;
    step?: number;
    disabled?: boolean;
    suffix?: string;
    onCommit: (value: number) => void;
}

/** Range input whose high-frequency pointer input stays local until its terminal event. */
function CommittedRange({
    label,
    value,
    minimum,
    maximum,
    step = 1,
    disabled,
    suffix = '',
    onCommit,
}: CommittedRangeProps) {
    const [draft, setDraft] = useState(value);
    const draftRef = useRef(value);
    const pointerActiveRef = useRef(false);
    const lastCommitRef = useRef(value);

    useEffect(() => {
        setDraft(value);
        draftRef.current = value;
        lastCommitRef.current = value;
    }, [value]);

    const commit = (next: number) => {
        if (next === lastCommitRef.current) return;
        lastCommitRef.current = next;
        onCommit(next);
    };
    const cancel = () => {
        pointerActiveRef.current = false;
        draftRef.current = value;
        setDraft(value);
    };

    return (
        <label className="grid gap-1 text-[11px] text-gray-400">
            <span className="flex items-center justify-between gap-2">
                {label}
                <output className="font-mono text-gray-200">{draft}{suffix}</output>
            </span>
            <input
                type="range"
                min={minimum}
                max={Math.max(minimum, maximum)}
                step={step}
                value={draft}
                disabled={disabled}
                className="w-full accent-blue-500 disabled:opacity-40"
                aria-label={label}
                onPointerDown={() => { pointerActiveRef.current = true; }}
                onPointerUp={() => {
                    pointerActiveRef.current = false;
                    commit(draftRef.current);
                }}
                onPointerCancel={cancel}
                onChange={(event) => {
                    const next = Number(event.target.value);
                    draftRef.current = next;
                    setDraft(next);
                    // Keyboard range changes are terminal commands; each key produces one action.
                    if (!pointerActiveRef.current) commit(next);
                }}
                onKeyDown={(event) => {
                    if (event.key !== 'Escape') return;
                    event.preventDefault();
                    cancel();
                }}
                onBlur={() => {
                    if (!pointerActiveRef.current) commit(draftRef.current);
                }}
            />
        </label>
    );
}

function ToggleButton({
    active,
    disabled,
    label,
    onClick,
}: {
    active: boolean;
    disabled?: boolean;
    label: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs disabled:opacity-40 ${active
                ? 'border-blue-400/50 bg-blue-500/20 text-blue-100'
                : 'border-gray-700 bg-gray-900 text-gray-300 hover:bg-gray-800'}`}
            onClick={onClick}
        >
            {active ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            {label}
        </button>
    );
}

/** Selection-aware media controls intended for the editor's collapsible inspector panel. */
export function MediaInspector() {
    const {
        transientSelection,
        videoClips,
        videoSources,
        audioTracks,
        audioSources,
        renderProfile,
        updateVideoClipAudio,
        updateAudioClipMix,
        updateAudioTrackMix,
        setAudioTrackLocked,
    } = useTimelineStore();

    const videoClip = transientSelection.kind === 'video-clip'
        ? videoClips.find((clip) => clip.id === transientSelection.clipId)
        : undefined;
    const videoSource = videoClip
        ? videoSources.find((source) => source.id === videoClip.sourceId)
        : undefined;
    const selectedAudioTrack = transientSelection.kind === 'audio-clip'
        ? audioTracks.find((track) => track.id === transientSelection.trackId)
        : undefined;
    const audioClip = transientSelection.kind === 'audio-clip'
        ? selectedAudioTrack?.clips.find((clip) => clip.id === transientSelection.clipId)
        : undefined;

    if (videoClip && videoSource) {
        const settings = videoClip.audio;
        const durationFrames = Math.max(
            1,
            secondsToFrames(videoClip.sourceEnd - videoClip.sourceStart, renderProfile.fps, 'nearest'),
        );
        const detached = settings?.linkState === 'detached';
        return (
            <section data-testid="media-inspector" className="grid gap-4 p-4">
                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Video clip</p>
                    <p className="mt-1 truncate text-sm font-medium text-gray-100">{videoSource.originalName}</p>
                </div>
                {!settings ? (
                    <p className="text-xs text-gray-500">This source has no audio stream.</p>
                ) : (
                    <>
                        <div className="rounded border border-gray-800 bg-gray-900/60 p-2 text-xs text-gray-300">
                            Embedded audio: {detached ? 'Separated' : 'Linked'}
                        </div>
                        <ToggleButton
                            active={settings.muted}
                            disabled={detached}
                            label={settings.muted ? 'Unmute embedded audio' : 'Mute embedded audio'}
                            onClick={() => updateVideoClipAudio(videoClip.id, { muted: !settings.muted })}
                        />
                        <CommittedRange
                            label="Embedded audio gain"
                            value={settings.gainDb}
                            minimum={-60}
                            maximum={12}
                            suffix=" dB"
                            disabled={detached}
                            onCommit={(gainDb) => updateVideoClipAudio(videoClip.id, { gainDb })}
                        />
                        <CommittedRange
                            label="Fade in"
                            value={settings.fadeInFrames}
                            minimum={0}
                            maximum={durationFrames}
                            suffix=" fr"
                            disabled={detached}
                            onCommit={(fadeInFrames) => updateVideoClipAudio(videoClip.id, { fadeInFrames })}
                        />
                        <CommittedRange
                            label="Fade out"
                            value={settings.fadeOutFrames}
                            minimum={0}
                            maximum={durationFrames}
                            suffix=" fr"
                            disabled={detached}
                            onCommit={(fadeOutFrames) => updateVideoClipAudio(videoClip.id, { fadeOutFrames })}
                        />
                    </>
                )}
            </section>
        );
    }

    if (audioClip && selectedAudioTrack) {
        const importedSource = 'sourceStartSample' in audioClip
            ? audioSources.find((source) => source.id === audioClip.source.audioSourceId)
            : undefined;
        const embeddedSource = 'sourceStart' in audioClip
            ? videoSources.find((source) => source.id === audioClip.source.videoSourceId)
            : undefined;
        const sourceName = importedSource?.originalName ?? embeddedSource?.originalName ?? 'Audio clip';
        const fadeIn = 'fadeInSamples' in audioClip ? audioClip.fadeInSamples : audioClip.fadeInFrames;
        const fadeOut = 'fadeOutSamples' in audioClip ? audioClip.fadeOutSamples : audioClip.fadeOutFrames;
        const maximumFade = 'sourceStartSample' in audioClip
            ? audioClip.sourceEndSample - audioClip.sourceStartSample
            : Math.max(1, secondsToFrames(audioClip.sourceEnd - audioClip.sourceStart, renderProfile.fps, 'nearest'));
        const locked = selectedAudioTrack.locked;

        return (
            <section data-testid="media-inspector" className="grid gap-4 p-4">
                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Audio clip</p>
                    <p className="mt-1 truncate text-sm font-medium text-gray-100">{sourceName}</p>
                    <p className="truncate text-xs text-gray-500">{selectedAudioTrack.name}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs ${locked ? 'border-amber-500/40 text-amber-300' : 'border-gray-700 text-gray-300'}`}
                        onClick={() => setAudioTrackLocked(selectedAudioTrack.id, !locked)}
                    >
                        {locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                        {locked ? 'Unlock track' : 'Lock track'}
                    </button>
                    <button
                        type="button"
                        disabled={locked}
                        className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs disabled:opacity-40 ${selectedAudioTrack.solo ? 'border-emerald-400/50 text-emerald-200' : 'border-gray-700 text-gray-300'}`}
                        onClick={() => updateAudioTrackMix(selectedAudioTrack.id, { solo: !selectedAudioTrack.solo })}
                    >
                        <Headphones className="h-3.5 w-3.5" />
                        {selectedAudioTrack.solo ? 'Unsolo track' : 'Solo track'}
                    </button>
                    <button
                        type="button"
                        disabled={locked}
                        className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs disabled:opacity-40 ${selectedAudioTrack.muted ? 'border-red-400/50 text-red-200' : 'border-gray-700 text-gray-300'}`}
                        onClick={() => updateAudioTrackMix(selectedAudioTrack.id, { muted: !selectedAudioTrack.muted })}
                    >
                        {selectedAudioTrack.muted
                            ? <VolumeX className="h-3.5 w-3.5" />
                            : <Volume2 className="h-3.5 w-3.5" />}
                        {selectedAudioTrack.muted ? 'Unmute track' : 'Mute track'}
                    </button>
                </div>
                <CommittedRange
                    label="Track gain"
                    value={selectedAudioTrack.gainDb}
                    minimum={-60}
                    maximum={12}
                    suffix=" dB"
                    disabled={locked}
                    onCommit={(gainDb) => updateAudioTrackMix(selectedAudioTrack.id, { gainDb })}
                />
                <ToggleButton
                    active={audioClip.muted}
                    disabled={locked}
                    label={audioClip.muted ? 'Unmute clip' : 'Mute clip'}
                    onClick={() => updateAudioClipMix(audioClip.id, { muted: !audioClip.muted })}
                />
                <CommittedRange
                    label="Clip gain"
                    value={audioClip.gainDb}
                    minimum={-60}
                    maximum={12}
                    suffix=" dB"
                    disabled={locked}
                    onCommit={(gainDb) => updateAudioClipMix(audioClip.id, { gainDb })}
                />
                <CommittedRange
                    label="Fade in"
                    value={fadeIn}
                    minimum={0}
                    maximum={maximumFade}
                    suffix={'sourceStartSample' in audioClip ? ' smp' : ' fr'}
                    disabled={locked}
                    onCommit={(next) => updateAudioClipMix(audioClip.id, 'fadeInSamples' in audioClip
                        ? { fadeInSamples: next }
                        : { fadeInFrames: next })}
                />
                <CommittedRange
                    label="Fade out"
                    value={fadeOut}
                    minimum={0}
                    maximum={maximumFade}
                    suffix={'sourceStartSample' in audioClip ? ' smp' : ' fr'}
                    disabled={locked}
                    onCommit={(next) => updateAudioClipMix(audioClip.id, 'fadeOutSamples' in audioClip
                        ? { fadeOutSamples: next }
                        : { fadeOutFrames: next })}
                />
            </section>
        );
    }

    return (
        <section data-testid="media-inspector" className="p-4 text-xs text-gray-500">
            Select a video or audio clip to edit its media settings.
        </section>
    );
}
