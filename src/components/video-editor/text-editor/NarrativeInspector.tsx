'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArchiveRestore, Link2, RotateCcw, Scissors, WandSparkles } from 'lucide-react';
import { Button } from '@/components/design-system/Button';
import { DraggableNumberInput } from '@/components/design-system/DraggableNumberInput';
import { Select } from '@/components/design-system/Select';
import { framesToSeconds } from '@/lib/render-profile';
import { getVideoClipDurationFramesV4 } from '@/lib/video-placement-v4';
import {
    EditorialPcmWindowRepository,
    findQuietEditorialBoundary,
} from '@/lib/storage/editorial-pcm-window-cache';
import { timelineEditorialRuntime } from '@/stores/timeline-editorial-runtime';
import { useTimelineStore } from '@/stores/timeline-store';
import type { MarginBoundaryPolicyV1, MaterializedBoundaryPolicyV1 } from '@/types/editorial';
import type { useTextEditorCommands } from './useTextEditorCommands';

interface NarrativeInspectorProps {
    pending: boolean;
    runNarrative: ReturnType<typeof useTextEditorCommands>['runNarrative'];
    onOpenSourceRange: (action: 'insert' | 'recover') => void;
}

const EDITORIAL_SAMPLE_RATE = 16_000;
const inspectorPcmWindowRepository = new EditorialPcmWindowRepository();

export function NarrativeInspector({
    pending,
    runNarrative,
    onOpenSourceRange,
}: NarrativeInspectorProps) {
    const selection = useTimelineStore((state) => state.transientSelection);
    const narrative = useTimelineStore((state) => state.narrative);
    const videoClips = useTimelineStore((state) => state.videoClips);
    const videoSources = useTimelineStore((state) => state.videoSources);
    const videoTracks = useTimelineStore((state) => state.videoTracks);
    const dependentLinks = useTimelineStore((state) => state.dependentLinks);
    const renderProfile = useTimelineStore((state) => state.renderProfile);
    const mode = useTimelineStore((state) => state.globalEditingMode);
    const block = selection.kind === 'narrative' ? narrative?.blocks[selection.blockId] : undefined;
    const clip = block ? videoClips.find((candidate) => candidate.id === block.clipId) : undefined;
    const source = block ? videoSources.find((candidate) => candidate.id === block.sourceId) : undefined;
    const track = block ? videoTracks.find((candidate) => candidate.id === block.trackId) : undefined;
    const body = block ? timelineEditorialRuntime.getResolvedBodies()[block.transcriptRecordId] : undefined;
    const links = useMemo(
        () => block ? dependentLinks.filter((link) => link.anchorBlockId === block.id) : [],
        [block, dependentLinks],
    );
    const selectedWordId = selection.kind === 'narrative' && selection.sourceWordIds.length === 1
        ? selection.sourceWordIds[0]
        : null;
    const sourceWord = selectedWordId ? body?.words.find((word) => word.id === selectedWordId) : undefined;
    const selectedSpeakerId = block?.kind === 'speech' && sourceWord
        ? block.speakerOverrides[sourceWord.id] ?? sourceWord.speakerId
        : null;
    const [wordDraft, setWordDraft] = useState('');
    const [trimStart, setTrimStart] = useState(0);
    const [trimEnd, setTrimEnd] = useState(0);
    const [absoluteStart, setAbsoluteStart] = useState(0);
    const [manualStart, setManualStart] = useState(0);
    const [manualEnd, setManualEnd] = useState(0);
    const [quietBusy, setQuietBusy] = useState(false);
    const [quietError, setQuietError] = useState('');

    useEffect(() => {
        if (!block) return;
        setTrimStart(block.coreStartSample);
        setTrimEnd(block.coreEndSample);
        setAbsoluteStart(block.timelineStartFrame);
        setManualStart(block.coreStartSample);
        setManualEnd(block.coreEndSample);
        setWordDraft(block.kind === 'speech' && sourceWord
            ? block.wordTextOverrides[sourceWord.id] ?? sourceWord.text
            : '');
    }, [block, sourceWord]);

    if (!block || !clip || !source || !narrative) {
        return (
            <section className="p-4 text-xs text-slate-500">
                Select a controlled text block or word to inspect its exact source and project ranges.
            </section>
        );
    }

    const durationFrames = getVideoClipDurationFramesV4(clip, renderProfile);
    const projectEnd = block.timelineStartFrame + durationFrames;
    const quietAvailable = timelineEditorialRuntime.getStatus().quietAssistedRefinementAvailable;
    const globalPre = samplesToMilliseconds(narrative.settings.globalPreMarginSamples);
    const globalPost = samplesToMilliseconds(narrative.settings.globalPostMarginSamples);

    const changeMargin = async (
        side: 'pre' | 'post',
        policy: MarginBoundaryPolicyV1,
    ) => runNarrative({ type: 'change-block-margin', blockId: block.id, side, policy }, {
        structural: true,
    });

    const refineAtQuietBoundary = async (side: 'start' | 'end') => {
        const decoder = timelineEditorialRuntime.getQuietWindowDecoder();
        if (!decoder || !body) return;
        const originalSample = side === 'start' ? block.coreStartSample : block.coreEndSample;
        const retainedWords = new Set(block.sourceWordIds);
        const words = block.kind === 'speech'
            ? body.words.filter((word) => retainedWords.has(word.id))
            : [];
        const firstWord = words[0];
        const lastWord = words.at(-1);
        const minimumSample = side === 'start'
            ? Math.max(0, originalSample - 1_920)
            : Math.max(block.coreStartSample + 1, lastWord?.editableStartSample ?? 0, originalSample - 1_920);
        const maximumSample = side === 'start'
            ? Math.min(block.coreEndSample - 1, firstWord?.editableEndSample ?? body.sampleCount, originalSample + 1_920)
            : Math.min(body.sampleCount, originalSample + 1_920);
        const windowStartSample = Math.max(0, minimumSample - 80);
        const windowEndSample = Math.min(body.sampleCount, maximumSample + 80);
        setQuietBusy(true);
        setQuietError('');
        try {
            const samples = await inspectorPcmWindowRepository.getOrDecode({
                sourceFingerprint: source.fingerprint,
                pcmAlgorithmVersion: 1,
                startSample: windowStartSample,
                endSample: windowEndSample,
            }, decoder);
            const chosenSample = findQuietEditorialBoundary({
                samples,
                windowStartSample,
                originalSample,
                minimumSample,
                maximumSample,
            });
            await runNarrative({
                type: 'refine-boundary',
                blockId: block.id,
                side,
                chosenSample,
                algorithmVersion: 1,
                origin: 'quiet-assisted',
            }, { structural: true });
        } catch (error) {
            setQuietError(error instanceof DOMException && error.name === 'AbortError'
                ? 'Quiet-boundary decoding was canceled.'
                : 'The bounded audio window could not be decoded. Manual refinement remains available.');
        } finally {
            setQuietBusy(false);
        }
    };

    return (
        <section data-testid="narrative-inspector" className="grid gap-4 overflow-y-auto p-4 text-xs scrollbar-thin scrollbar-thumb-slate-700">
            <div>
                <div className="flex items-center gap-1.5">
                    <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-200">
                        V{videoTracks.findIndex((candidate) => candidate.id === block.trackId) + 1}
                    </span>
                    <p className="min-w-0 truncate font-semibold text-slate-100">{track?.name ?? block.trackId}</p>
                    <span className="ml-auto rounded border border-sky-500/25 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-200">Controlled</span>
                </div>
                <p className="mt-1 truncate text-[10px] text-slate-500">{source.originalName}</p>
            </div>

            <InspectorGroup title="Exact ranges">
                <RangeLine label="Core source" value={`samples [${block.coreStartSample}, ${block.coreEndSample})`} />
                <RangeLine label="Materialized source" value={`frames [${block.materialization.sourceStartFrame}, ${block.materialization.sourceEndFrame})`} />
                <RangeLine label="Project" value={`frames [${block.timelineStartFrame}, ${projectEnd})`} />
                <RangeLine label="Project time" value={`${framesToSeconds(block.timelineStartFrame, renderProfile.fps).toFixed(3)}–${framesToSeconds(projectEnd, renderProfile.fps).toFixed(3)} s`} />
            </InspectorGroup>

            <InspectorGroup title="Boundary policy and margins">
                <BoundaryControl
                    label="Pre boundary"
                    boundary={block.materialization.preBoundary}
                    globalMilliseconds={globalPre}
                    disabled={pending}
                    onInherit={() => void changeMargin('pre', { kind: 'margin', mode: 'inherit-global', requestedSamples: null })}
                    onExplicit={(milliseconds) => void changeMargin('pre', {
                        kind: 'margin',
                        mode: 'explicit',
                        requestedSamples: millisecondsToSamples(milliseconds),
                    })}
                />
                <BoundaryControl
                    label="Post boundary"
                    boundary={block.materialization.postBoundary}
                    globalMilliseconds={globalPost}
                    disabled={pending}
                    onInherit={() => void changeMargin('post', { kind: 'margin', mode: 'inherit-global', requestedSamples: null })}
                    onExplicit={(milliseconds) => void changeMargin('post', {
                        kind: 'margin',
                        mode: 'explicit',
                        requestedSamples: millisecondsToSamples(milliseconds),
                    })}
                />
                <div className="grid grid-cols-2 gap-2 border-t border-slate-800 pt-2">
                    <MarginNumber
                        label="Global pre"
                        value={globalPre}
                        disabled={pending}
                        onCommit={(value) => void runNarrative({
                            type: 'change-global-margins',
                            preSamples: millisecondsToSamples(value),
                            postSamples: narrative.settings.globalPostMarginSamples,
                        }, { structural: true })}
                    />
                    <MarginNumber
                        label="Global post"
                        value={globalPost}
                        disabled={pending}
                        onCommit={(value) => void runNarrative({
                            type: 'change-global-margins',
                            preSamples: narrative.settings.globalPreMarginSamples,
                            postSamples: millisecondsToSamples(value),
                        }, { structural: true })}
                    />
                </div>
            </InspectorGroup>

            <InspectorGroup title="Trim and placement">
                <div className="grid grid-cols-2 gap-2">
                    <label className="grid gap-1 text-[10px] text-slate-500">
                        Core start sample
                        <input type="number" value={trimStart} min={0} max={block.coreEndSample - 1} onChange={(event) => setTrimStart(Number(event.target.value))} className="h-7 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-white outline-none focus:border-sky-400" />
                    </label>
                    <label className="grid gap-1 text-[10px] text-slate-500">
                        Core end sample
                        <input type="number" value={trimEnd} min={block.coreStartSample + 1} max={body?.sampleCount ?? block.coreEndSample} onChange={(event) => setTrimEnd(Number(event.target.value))} className="h-7 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-white outline-none focus:border-sky-400" />
                    </label>
                </div>
                <div className="flex gap-2">
                    <Button variant="secondary" size="sm" className="h-7 flex-1 text-[10px]" disabled={pending || trimStart === block.coreStartSample} onClick={() => void runNarrative({ type: 'trim-block', blockId: block.id, side: 'start', sample: trimStart }, { structural: true })}>Trim start</Button>
                    <Button variant="secondary" size="sm" className="h-7 flex-1 text-[10px]" disabled={pending || trimEnd === block.coreEndSample} onClick={() => void runNarrative({ type: 'trim-block', blockId: block.id, side: 'end', sample: trimEnd }, { structural: true })}>Trim end</Button>
                </div>
                {mode === 'absolute' && (
                    <div className="grid grid-cols-[1fr_auto] gap-2">
                        <label className="grid gap-1 text-[10px] text-slate-500">
                            Absolute project start frame
                            <input type="number" value={absoluteStart} min={0} onChange={(event) => setAbsoluteStart(Number(event.target.value))} className="h-7 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-white outline-none focus:border-sky-400" />
                        </label>
                        <Button variant="secondary" size="sm" className="mt-4 h-7 text-[10px]" disabled={pending || absoluteStart === block.timelineStartFrame} onClick={() => void runNarrative({ type: 'reorder-blocks', blockIds: [block.id], targetStartFrame: absoluteStart }, { structural: true })}>Move</Button>
                    </div>
                )}
            </InspectorGroup>

            <InspectorGroup title="Boundary refinement">
                <p className="text-[10px] leading-relaxed text-slate-500">
                    Manual refinement changes instance-local semantic boundaries. The final video cut remains frame-snapped.
                </p>
                <div className="grid grid-cols-2 gap-2">
                    <label className="grid gap-1 text-[10px] text-slate-500">
                        Start sample
                        <input type="number" value={manualStart} min={0} max={block.coreEndSample - 1} onChange={(event) => setManualStart(Number(event.target.value))} className="h-7 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-white outline-none focus:border-sky-400" />
                    </label>
                    <label className="grid gap-1 text-[10px] text-slate-500">
                        End sample
                        <input type="number" value={manualEnd} min={block.coreStartSample + 1} max={body?.sampleCount ?? block.coreEndSample} onChange={(event) => setManualEnd(Number(event.target.value))} className="h-7 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-white outline-none focus:border-sky-400" />
                    </label>
                </div>
                <div className="flex gap-2">
                    <Button variant="secondary" size="sm" className="h-7 flex-1 text-[10px]" disabled={pending || manualStart === block.coreStartSample} onClick={() => void runNarrative({ type: 'refine-boundary', blockId: block.id, side: 'start', chosenSample: manualStart, algorithmVersion: 1, origin: 'manual' }, { structural: true })}><Scissors className="h-3 w-3" /> Refine start</Button>
                    <Button variant="secondary" size="sm" className="h-7 flex-1 text-[10px]" disabled={pending || manualEnd === block.coreEndSample} onClick={() => void runNarrative({ type: 'refine-boundary', blockId: block.id, side: 'end', chosenSample: manualEnd, algorithmVersion: 1, origin: 'manual' }, { structural: true })}><Scissors className="h-3 w-3" /> Refine end</Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                    {(['start', 'end'] as const).map((side) => (
                        <button
                            key={side}
                            type="button"
                            disabled={!quietAvailable || !body || pending || quietBusy}
                            title={quietAvailable
                                ? `Decode a bounded PCM window and refine the ${side} to its deterministic quiet valley`
                                : 'Quiet-assisted refinement is unavailable because no bounded runtime decoder is installed'}
                            className="flex h-7 items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-950 text-[10px] text-slate-400 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                            onClick={() => void refineAtQuietBoundary(side)}
                        >
                            <WandSparkles className="h-3 w-3" />
                            Quiet {side}{quietAvailable ? '' : ' unavailable'}
                        </button>
                    ))}
                </div>
                {quietError && <p role="alert" className="text-[10px] text-amber-300">{quietError}</p>}
            </InspectorGroup>

            {block.kind === 'speech' && sourceWord && (
                <InspectorGroup title="Selected word">
                    <p className="text-[10px] text-slate-500">Immutable source: <span className="text-slate-300">{sourceWord.text}</span></p>
                    <form
                        className="grid gap-2"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void runNarrative({ type: 'set-word-text', blockId: block.id, wordId: sourceWord.id, text: wordDraft }, { structural: false });
                        }}
                    >
                        <label className="grid gap-1 text-[10px] text-slate-500">
                            Instance correction
                            <input value={wordDraft} onChange={(event) => setWordDraft(event.target.value)} className="h-7 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-white outline-none focus:border-sky-400" />
                        </label>
                        <div className="flex gap-2">
                            <Button variant="secondary" size="sm" className="h-7 flex-1 text-[10px]" disabled={pending || !wordDraft.trim()} type="submit">Save correction</Button>
                            <Button variant="ghost" size="sm" className="h-7 text-[10px]" disabled={pending || !Object.prototype.hasOwnProperty.call(block.wordTextOverrides, sourceWord.id)} type="button" onClick={() => void runNarrative({ type: 'set-word-text', blockId: block.id, wordId: sourceWord.id, text: null }, { structural: false })}><RotateCcw className="h-3 w-3" /> Reset</Button>
                        </div>
                    </form>
                    {body && body.speakers.length > 0 && (
                        <label className="grid gap-1 text-[10px] text-slate-500">
                            Display speaker
                            <Select
                                value={selectedSpeakerId ?? ''}
                                tone="modal"
                                controlSize="xs"
                                disabled={pending}
                                onChange={(event) => void runNarrative({
                                    type: 'set-word-speaker',
                                    blockId: block.id,
                                    wordId: sourceWord.id,
                                    speakerId: event.target.value || null,
                                }, { structural: false })}
                            >
                                <option value="">Source speaker / none</option>
                                {body.speakers.map((speaker) => <option key={speaker.id} value={speaker.id}>{speaker.label}</option>)}
                            </Select>
                        </label>
                    )}
                </InspectorGroup>
            )}

            <InspectorGroup title="Links and recovery">
                <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                    <Link2 className="h-3.5 w-3.5" />
                    {links.length} dependent {links.length === 1 ? 'target' : 'targets'}
                </div>
                {links.map((link) => (
                    <div key={link.id} className="rounded border border-slate-800 bg-slate-950/60 px-2 py-1.5 text-[10px] text-slate-400">
                        <span className="text-slate-200">{link.target.kind}</span> · {link.association.kind === 'transcript-bound' ? 'exact fragment' : `${link.association.origin} overlap`} · {link.followPolicy}
                        {link.association.kind === 'transcript-bound' && (
                            <div className="mt-0.5 font-mono text-slate-600">[{link.association.binding.activeStartSample}, {link.association.binding.activeEndSample}) smp</div>
                        )}
                    </div>
                ))}
                <div className="flex gap-2">
                    <Button variant="secondary" size="sm" className="h-7 flex-1 text-[10px]" onClick={() => onOpenSourceRange('recover')}><ArchiveRestore className="h-3 w-3" /> Recover source</Button>
                    <Button variant="secondary" size="sm" className="h-7 flex-1 text-[10px]" onClick={() => onOpenSourceRange('insert')}>Insert source</Button>
                </div>
            </InspectorGroup>
        </section>
    );
}

function InspectorGroup({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="grid gap-2 rounded border border-slate-800 bg-slate-900/40 p-2.5">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</h3>
            {children}
        </div>
    );
}

function RangeLine({ label, value }: { label: string; value: string }) {
    return <div className="flex items-center justify-between gap-2 text-[10px]"><span className="text-slate-500">{label}</span><span className="font-mono text-slate-300">{value}</span></div>;
}

function BoundaryControl({
    label,
    boundary,
    globalMilliseconds,
    disabled,
    onInherit,
    onExplicit,
}: {
    label: string;
    boundary: MaterializedBoundaryPolicyV1;
    globalMilliseconds: number;
    disabled: boolean;
    onInherit: () => void;
    onExplicit: (milliseconds: number) => void;
}) {
    const explicitValue = boundary.kind === 'margin' && boundary.mode === 'explicit'
        ? samplesToMilliseconds(boundary.requestedSamples ?? 0)
        : boundary.kind === 'partition-seam' ? 0 : globalMilliseconds;
    return (
        <div className="grid gap-1.5">
            <div className="flex items-center gap-2 text-[10px]">
                <span className="text-slate-500">{label}</span>
                <span className={`ml-auto rounded px-1.5 py-0.5 ${boundary.kind === 'partition-seam'
                    ? 'bg-violet-500/15 text-violet-200'
                    : boundary.mode === 'explicit'
                        ? 'bg-amber-500/15 text-amber-200'
                        : 'bg-sky-500/15 text-sky-200'}`}
                >
                    {boundary.kind === 'partition-seam' ? 'Partition seam' : boundary.mode === 'explicit' ? 'Explicit' : 'Inherits global'}
                </span>
            </div>
            {boundary.kind === 'partition-seam' && <p className="font-mono text-[9px] text-slate-600">Seam {boundary.seamId}</p>}
            <div className="grid grid-cols-[1fr_auto] gap-2">
                <MarginNumber
                    label={boundary.kind === 'partition-seam' ? 'Convert to margin' : 'Effective'}
                    value={explicitValue}
                    disabled={disabled}
                    onCommit={onExplicit}
                />
                <button type="button" disabled={disabled || (boundary.kind === 'margin' && boundary.mode === 'inherit-global')} onClick={onInherit} className="mt-4 h-7 rounded border border-slate-700 px-2 text-[10px] text-slate-400 hover:bg-slate-800 disabled:opacity-40" title="Use the current global margin on this side">Use global</button>
            </div>
        </div>
    );
}

function MarginNumber({ label, value, disabled, onCommit }: { label: string; value: number; disabled: boolean; onCommit: (value: number) => void }) {
    return (
        <DraggableNumberInput
            value={value}
            min={0}
            max={30_000}
            step={1}
            decimalPlaces={3}
            label={label}
            unit="ms"
            layout="stacked"
            disabled={disabled}
            onPreview={() => undefined}
            onCommit={onCommit}
            onCancel={() => undefined}
        />
    );
}

function samplesToMilliseconds(samples: number): number {
    return samples * 1000 / EDITORIAL_SAMPLE_RATE;
}

function millisecondsToSamples(milliseconds: number): number {
    return Math.max(0, Math.round(milliseconds * EDITORIAL_SAMPLE_RATE / 1000));
}
