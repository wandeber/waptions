'use client';

import { Headphones, Lock, Plus, Unlock, Volume2, VolumeX } from 'lucide-react';
import { DraggableNumberInput } from '@/components/design-system/DraggableNumberInput';
import { secondsToFrames } from '@/lib/render-profile';
import { useTimelineStore } from '@/stores/timeline-store';
import { useShallow } from 'zustand/react/shallow';
import { EditorialTargetLinkPanel } from './text-editor/EditorialTargetLinkPanel';

interface DraggableSettingProps {
    label: string;
    value: number;
    minimum: number;
    maximum: number;
    step?: number;
    disabled?: boolean;
    unit?: string;
    defaultValue?: number;
    decimalPlaces?: number;
    normalizeValue?: (value: number) => number;
    onCommit: (value: number) => void;
}

/** Media inspector adapter for the editor's existing drag-or-type numeric form field. */
function DraggableSetting({
    label,
    value,
    minimum,
    maximum,
    step = 1,
    disabled,
    unit = '',
    defaultValue = 0,
    decimalPlaces,
    normalizeValue,
    onCommit,
}: DraggableSettingProps) {
    return (
        <DraggableNumberInput
            value={value}
            min={minimum}
            max={maximum}
            step={step}
            label={label}
            unit={unit}
            defaultValue={defaultValue}
            layout="horizontal"
            labelWidth={84}
            disabled={disabled}
            decimalPlaces={decimalPlaces}
            normalizeValue={normalizeValue}
            onPreview={() => undefined}
            onCommit={onCommit}
            onCancel={() => undefined}
        />
    );
}

function samplesToMilliseconds(samples: number, sampleRate: number): number {
    return samples * 1000 / sampleRate;
}

function millisecondsToSamples(milliseconds: number, sampleRate: number): number {
    return Math.round(milliseconds * sampleRate / 1000);
}

/** Keeps a readable millisecond draft aligned with the source's discrete native sample domain. */
function normalizeSampleMilliseconds(milliseconds: number, sampleRate: number): number {
    return samplesToMilliseconds(millisecondsToSamples(milliseconds, sampleRate), sampleRate);
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
                ? 'border-sky-400/50 bg-sky-500/15 text-sky-100'
                : 'border-slate-700 bg-slate-950/60 text-slate-300 hover:bg-slate-800'}`}
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
        videoTracks,
        audioTracks,
        audioSources,
        renderProfile,
        updateVideoClipAudio,
        updateAudioClipMix,
        updateAudioTrackMix,
        setAudioTrackLocked,
        moveVideoClipToTrack,
        moveVideoClipToNewTrack,
    } = useTimelineStore(useShallow((state) => ({
        transientSelection: state.transientSelection,
        videoClips: state.videoClips,
        videoSources: state.videoSources,
        videoTracks: state.videoTracks,
        audioTracks: state.audioTracks,
        audioSources: state.audioSources,
        renderProfile: state.renderProfile,
        updateVideoClipAudio: state.updateVideoClipAudio,
        updateAudioClipMix: state.updateAudioClipMix,
        updateAudioTrackMix: state.updateAudioTrackMix,
        setAudioTrackLocked: state.setAudioTrackLocked,
        moveVideoClipToTrack: state.moveVideoClipToTrack,
        moveVideoClipToNewTrack: state.moveVideoClipToNewTrack,
    })));

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
        const selectedVideoTrack = videoTracks.find((track) => (
            track.id === videoClip.trackId || track.clipIds.includes(videoClip.id)
        ));
        return (
            <section data-testid="media-inspector" className="grid gap-4 p-4">
                <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Video clip</p>
                    <p className="mt-1 truncate text-sm font-medium text-slate-100">{videoSource.originalName}</p>
                </div>
                <div className="grid gap-2">
                    <label className="grid gap-1 text-[11px] text-slate-400">
                        Video track
                        <select
                            aria-label="Video track"
                            className="h-8 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                            value={selectedVideoTrack?.id ?? ''}
                            onChange={(event) => moveVideoClipToTrack(videoClip.id, event.target.value)}
                        >
                            {videoTracks.map((track, index) => (
                                <option key={track.id} value={track.id}>V{index + 1} · {track.name}</option>
                            ))}
                        </select>
                    </label>
                    <button
                        type="button"
                        className="flex h-8 items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-950/60 px-2 text-xs text-slate-300 transition-colors hover:bg-slate-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                        onClick={() => moveVideoClipToNewTrack(videoClip.id, videoTracks.length)}
                    >
                        <Plus className="h-3.5 w-3.5" />
                        New video track
                    </button>
                </div>
                {!settings ? (
                    <p className="text-xs text-slate-500">This source has no audio stream.</p>
                ) : (
                    <>
                        <div className="rounded border border-slate-700 bg-slate-950/60 p-2 text-xs text-slate-300">
                            Embedded audio: {detached ? 'Separated' : 'Linked'}
                        </div>
                        <ToggleButton
                            active={settings.muted}
                            disabled={detached}
                            label={settings.muted ? 'Unmute embedded audio' : 'Mute embedded audio'}
                            onClick={() => updateVideoClipAudio(videoClip.id, { muted: !settings.muted })}
                        />
                        <DraggableSetting
                            label="Embedded audio gain"
                            value={settings.gainDb}
                            minimum={-60}
                            maximum={12}
                            step={0.1}
                            decimalPlaces={1}
                            unit="dB"
                            disabled={detached}
                            onCommit={(gainDb) => updateVideoClipAudio(videoClip.id, { gainDb })}
                        />
                        <DraggableSetting
                            label="Fade in"
                            value={settings.fadeInFrames}
                            minimum={0}
                            maximum={durationFrames}
                            decimalPlaces={0}
                            unit="fr"
                            disabled={detached}
                            onCommit={(fadeInFrames) => updateVideoClipAudio(videoClip.id, { fadeInFrames })}
                        />
                        <DraggableSetting
                            label="Fade out"
                            value={settings.fadeOutFrames}
                            minimum={0}
                            maximum={durationFrames}
                            decimalPlaces={0}
                            unit="fr"
                            disabled={detached}
                            onCommit={(fadeOutFrames) => updateVideoClipAudio(videoClip.id, { fadeOutFrames })}
                        />
                    </>
                )}
                <EditorialTargetLinkPanel
                    target={{ kind: 'video-clip', clipId: videoClip.id }}
                    targetLabel={`Video · ${videoSource.originalName}`}
                    locked={selectedVideoTrack?.locked ?? false}
                />
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
        const usesNativeSamples = 'sourceStartSample' in audioClip;
        const sampleRate = importedSource?.nativeSampleRate ?? null;
        // Imported audio keeps sample-accurate persistence, but milliseconds are substantially
        // easier to scan and edit than raw sample counts. Missing legacy source metadata falls
        // back to the exact integer-sample presentation rather than guessing a sample rate.
        const showSampleFadesAsMilliseconds = usesNativeSamples && sampleRate !== null;
        const fadeIn = usesNativeSamples
            ? showSampleFadesAsMilliseconds
                ? samplesToMilliseconds(audioClip.fadeInSamples, sampleRate)
                : audioClip.fadeInSamples
            : audioClip.fadeInFrames;
        const fadeOut = usesNativeSamples
            ? showSampleFadesAsMilliseconds
                ? samplesToMilliseconds(audioClip.fadeOutSamples, sampleRate)
                : audioClip.fadeOutSamples
            : audioClip.fadeOutFrames;
        const maximumFade = usesNativeSamples
            ? showSampleFadesAsMilliseconds
                ? samplesToMilliseconds(audioClip.sourceEndSample - audioClip.sourceStartSample, sampleRate)
                : audioClip.sourceEndSample - audioClip.sourceStartSample
            : Math.max(1, secondsToFrames(audioClip.sourceEnd - audioClip.sourceStart, renderProfile.fps, 'nearest'));
        const fadeUnit = showSampleFadesAsMilliseconds ? 'ms' : usesNativeSamples ? 'smp' : 'fr';
        const fadePrecision = showSampleFadesAsMilliseconds ? 3 : 0;
        const normalizeFade = showSampleFadesAsMilliseconds
            ? (milliseconds: number) => normalizeSampleMilliseconds(milliseconds, sampleRate)
            : undefined;
        const persistFade = (next: number): number => showSampleFadesAsMilliseconds
            ? millisecondsToSamples(next, sampleRate)
            : next;
        const locked = selectedAudioTrack.locked;

        return (
            <section data-testid="media-inspector" className="grid gap-4 p-4">
                <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Audio clip</p>
                    <p className="mt-1 truncate text-sm font-medium text-slate-100">{sourceName}</p>
                    <p className="truncate text-xs text-slate-500">{selectedAudioTrack.name}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs ${locked ? 'border-amber-500/40 text-amber-300' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}
                        onClick={() => setAudioTrackLocked(selectedAudioTrack.id, !locked)}
                    >
                        {locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                        {locked ? 'Unlock track' : 'Lock track'}
                    </button>
                    <button
                        type="button"
                        disabled={locked}
                        className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs disabled:opacity-40 ${selectedAudioTrack.solo ? 'border-teal-400/50 text-teal-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}
                        onClick={() => updateAudioTrackMix(selectedAudioTrack.id, { solo: !selectedAudioTrack.solo })}
                    >
                        <Headphones className="h-3.5 w-3.5" />
                        {selectedAudioTrack.solo ? 'Unsolo track' : 'Solo track'}
                    </button>
                    <button
                        type="button"
                        disabled={locked}
                        className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs disabled:opacity-40 ${selectedAudioTrack.muted ? 'border-red-400/50 text-red-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}
                        onClick={() => updateAudioTrackMix(selectedAudioTrack.id, { muted: !selectedAudioTrack.muted })}
                    >
                        {selectedAudioTrack.muted
                            ? <VolumeX className="h-3.5 w-3.5" />
                            : <Volume2 className="h-3.5 w-3.5" />}
                        {selectedAudioTrack.muted ? 'Unmute track' : 'Mute track'}
                    </button>
                </div>
                <DraggableSetting
                    label="Track gain"
                    value={selectedAudioTrack.gainDb}
                    minimum={-60}
                    maximum={12}
                    step={0.1}
                    decimalPlaces={1}
                    unit="dB"
                    disabled={locked}
                    onCommit={(gainDb) => updateAudioTrackMix(selectedAudioTrack.id, { gainDb })}
                />
                <ToggleButton
                    active={audioClip.muted}
                    disabled={locked}
                    label={audioClip.muted ? 'Unmute clip' : 'Mute clip'}
                    onClick={() => updateAudioClipMix(audioClip.id, { muted: !audioClip.muted })}
                />
                <DraggableSetting
                    label="Clip gain"
                    value={audioClip.gainDb}
                    minimum={-60}
                    maximum={12}
                    step={0.1}
                    decimalPlaces={1}
                    unit="dB"
                    disabled={locked}
                    onCommit={(gainDb) => updateAudioClipMix(audioClip.id, { gainDb })}
                />
                <DraggableSetting
                    label="Fade in"
                    value={fadeIn}
                    minimum={0}
                    maximum={maximumFade}
                    step={1}
                    decimalPlaces={fadePrecision}
                    normalizeValue={normalizeFade}
                    unit={fadeUnit}
                    disabled={locked}
                    onCommit={(next) => updateAudioClipMix(audioClip.id, 'fadeInSamples' in audioClip
                        ? { fadeInSamples: persistFade(next) }
                        : { fadeInFrames: next })}
                />
                <DraggableSetting
                    label="Fade out"
                    value={fadeOut}
                    minimum={0}
                    maximum={maximumFade}
                    step={1}
                    decimalPlaces={fadePrecision}
                    normalizeValue={normalizeFade}
                    unit={fadeUnit}
                    disabled={locked}
                    onCommit={(next) => updateAudioClipMix(audioClip.id, 'fadeOutSamples' in audioClip
                        ? { fadeOutSamples: persistFade(next) }
                        : { fadeOutFrames: next })}
                />
                <EditorialTargetLinkPanel
                    target={{
                        kind: 'audio-clip',
                        trackId: selectedAudioTrack.id,
                        clipId: audioClip.id,
                    }}
                    targetLabel={`Audio · ${sourceName}`}
                    locked={locked}
                />
            </section>
        );
    }

    return (
        <section data-testid="media-inspector" className="p-4 text-xs text-slate-500">
            Select a video or audio clip to edit its media settings.
        </section>
    );
}
