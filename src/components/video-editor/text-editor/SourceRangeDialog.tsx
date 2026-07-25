'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArchiveRestore, Plus, X } from 'lucide-react';
import { Button } from '@/components/design-system/Button';
import { Select } from '@/components/design-system/Select';
import { secondsToFrames } from '@/lib/render-profile';
import { usePlaybackStore } from '@/stores/playback-store';
import { timelineEditorialRuntime } from '@/stores/timeline-editorial-runtime';
import { useTimelineStore } from '@/stores/timeline-store';
import type { useTextEditorCommands } from './useTextEditorCommands';

interface SourceRangeDialogProps {
    action: 'insert' | 'recover';
    pending: boolean;
    runNarrative: ReturnType<typeof useTextEditorCommands>['runNarrative'];
    onClose: () => void;
}

interface SourceOption {
    key: string;
    recordId: string;
    sourceId: string;
    label: string;
    sampleCount: number;
}

/** Exact full-source browser for insertion/recovery; equal ranges intentionally remain reusable. */
export function SourceRangeDialog({
    action,
    pending,
    runNarrative,
    onClose,
}: SourceRangeDialogProps) {
    const narrative = useTimelineStore((state) => state.narrative);
    const descriptors = useTimelineStore((state) => state.editorialTranscriptDescriptors);
    const videoSources = useTimelineStore((state) => state.videoSources);
    const videoClips = useTimelineStore((state) => state.videoClips);
    const videoTracks = useTimelineStore((state) => state.videoTracks);
    const mode = useTimelineStore((state) => state.globalEditingMode);
    const renderProfile = useTimelineStore((state) => state.renderProfile);
    const currentTime = usePlaybackStore((state) => state.currentTime);
    const currentFrame = secondsToFrames(currentTime, renderProfile.fps, 'nearest');
    const bodies = timelineEditorialRuntime.getResolvedBodies();
    const options = useMemo<SourceOption[]>(() => {
        const retained = new Set(narrative?.sourceRecordIds ?? []);
        return descriptors.filter((descriptor) => retained.has(descriptor.recordId)).map((descriptor) => {
            const source = videoSources.find((candidate) => candidate.id === descriptor.sourceId);
            return {
                key: JSON.stringify([descriptor.recordId, descriptor.sourceId]),
                recordId: descriptor.recordId,
                sourceId: descriptor.sourceId,
                label: source?.originalName ?? `Source ${descriptor.sourceId}`,
                sampleCount: descriptor.sampleCount,
            };
        });
    }, [descriptors, narrative?.sourceRecordIds, videoSources]);
    const [sourceKey, setSourceKey] = useState(options[0]?.key ?? '');
    const selected = options.find((option) => option.key === sourceKey) ?? options[0];
    const body = selected ? bodies[selected.recordId as keyof typeof bodies] : undefined;
    const [startSample, setStartSample] = useState(0);
    const [endSample, setEndSample] = useState(selected?.sampleCount ?? 0);
    const [destinationTrackId, setDestinationTrackId] = useState(
        narrative?.controlledTrackIds[0] ?? '',
    );
    const [targetIndex, setTargetIndex] = useState(narrative?.blockIds.length ?? 0);
    const [timelineStartFrame, setTimelineStartFrame] = useState(currentFrame);

    useEffect(() => {
        if (!selected) return;
        const first = body?.words[0];
        const last = body?.words.at(-1);
        setStartSample(first?.editableStartSample ?? 0);
        setEndSample(last?.editableEndSample ?? selected.sampleCount);
    }, [body, selected]);

    if (!narrative) return null;
    const controlledTracks = videoTracks.filter((track) => narrative.controlledTrackIds.includes(track.id));
    const canSubmit = selected && body
        && Number.isSafeInteger(startSample)
        && Number.isSafeInteger(endSample)
        && startSample >= 0
        && endSample > startSample
        && endSample <= selected.sampleCount
        && controlledTracks.some((track) => track.id === destinationTrackId);

    const submit = async () => {
        if (!selected || !canSubmit) return;
        const sourceClip = videoClips.find((clip) => clip.sourceId === selected.sourceId);
        const result = await runNarrative({
            type: action === 'recover' ? 'recover-source-range' : 'insert-source-range',
            recordId: selected.recordId as `sha256:${string}`,
            sourceId: selected.sourceId,
            sourceRange: { start: startSample, end: endSample },
            destinationTrackId,
            ...(mode === 'ripple' ? { targetIndex } : { timelineStartFrame }),
            clipAudio: sourceClip?.audio ? { ...sourceClip.audio } : null,
        }, {
            structural: true,
            successMessage: action === 'recover'
                ? 'Deleted source material recovered as a new occurrence.'
                : 'Source material inserted as a new occurrence.',
        });
        if (result.kind === 'success') onClose();
    };

    return (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
            <section
                role="dialog"
                aria-modal="true"
                aria-labelledby="source-range-title"
                className="grid max-h-full w-full max-w-2xl gap-3 overflow-auto rounded-lg border border-slate-700 bg-slate-900 p-4 shadow-2xl"
            >
                <div className="flex items-center gap-2">
                    {action === 'recover'
                        ? <ArchiveRestore className="h-4 w-4 text-emerald-300" />
                        : <Plus className="h-4 w-4 text-sky-300" />}
                    <h2 id="source-range-title" className="text-sm font-semibold text-white">
                        {action === 'recover' ? 'Recover source range' : 'Insert source range'}
                    </h2>
                    <button type="button" className="ml-auto rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-white" onClick={onClose} aria-label="Close source range dialog">
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <p className="text-xs leading-relaxed text-slate-400">
                    Choose an exact immutable full-source range. Reusing a range creates a distinct occurrence; it never deduplicates existing media.
                </p>
                <label className="grid gap-1 text-[11px] text-slate-400">
                    Transcript source
                    <Select value={selected?.key ?? ''} onChange={(event) => setSourceKey(event.target.value)} tone="modal" controlSize="xs">
                        {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                    </Select>
                </label>
                {body ? (
                    <div className="max-h-28 overflow-y-auto rounded border border-slate-800 bg-slate-950/70 p-2 text-xs leading-6 text-slate-300 scrollbar-thin scrollbar-thumb-slate-700">
                        {body.words.length > 0
                            ? body.words.map((word) => (
                                <button
                                    key={word.id}
                                    type="button"
                                    className="mr-1 rounded px-1 hover:bg-slate-700 hover:text-white"
                                    title={`Use ${word.editableStartSample}–${word.editableEndSample} samples`}
                                    onClick={() => {
                                        setStartSample(word.editableStartSample);
                                        setEndSample(word.editableEndSample);
                                    }}
                                >
                                    {word.text}
                                </button>
                            ))
                            : 'This immutable source record contains no aligned words. Use an exact sample range below.'}
                    </div>
                ) : (
                    <p className="rounded border border-red-500/30 bg-red-500/10 px-2 py-2 text-xs text-red-200">
                        The verified source transcript is not hydrated, so insertion is unavailable.
                    </p>
                )}
                <div className="grid grid-cols-2 gap-3">
                    <label className="grid gap-1 text-[11px] text-slate-400">
                        Start sample
                        <input type="number" min={0} max={selected?.sampleCount ?? 0} value={startSample} onChange={(event) => setStartSample(Number(event.target.value))} className="h-8 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-white outline-none focus:border-sky-400" />
                    </label>
                    <label className="grid gap-1 text-[11px] text-slate-400">
                        End sample (exclusive)
                        <input type="number" min={1} max={selected?.sampleCount ?? 0} value={endSample} onChange={(event) => setEndSample(Number(event.target.value))} className="h-8 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-white outline-none focus:border-sky-400" />
                    </label>
                    <label className="grid gap-1 text-[11px] text-slate-400">
                        Controlled destination track
                        <Select value={destinationTrackId} onChange={(event) => setDestinationTrackId(event.target.value)} tone="modal" controlSize="xs">
                            {controlledTracks.map((track) => <option key={track.id} value={track.id}>V{videoTracks.indexOf(track) + 1} · {track.name}</option>)}
                        </Select>
                    </label>
                    {mode === 'ripple' ? (
                        <label className="grid gap-1 text-[11px] text-slate-400">
                            Insert before narrative position
                            <Select value={targetIndex} onChange={(event) => setTargetIndex(Number(event.target.value))} tone="modal" controlSize="xs">
                                {narrative.blockIds.map((blockId, index) => <option key={blockId} value={index}>Position {index + 1}</option>)}
                                <option value={narrative.blockIds.length}>End of narrative</option>
                            </Select>
                        </label>
                    ) : (
                        <label className="grid gap-1 text-[11px] text-slate-400">
                            Project start frame
                            <input type="number" min={0} value={timelineStartFrame} onChange={(event) => setTimelineStartFrame(Number(event.target.value))} className="h-8 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-white outline-none focus:border-sky-400" />
                        </label>
                    )}
                </div>
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" className="px-3 text-xs" onClick={onClose}>Cancel</Button>
                    <Button variant="primary" size="sm" className="px-3 text-xs" disabled={!canSubmit || pending} onClick={() => void submit()}>
                        {action === 'recover' ? 'Recover range' : 'Insert range'}
                    </Button>
                </div>
            </section>
        </div>
    );
}
