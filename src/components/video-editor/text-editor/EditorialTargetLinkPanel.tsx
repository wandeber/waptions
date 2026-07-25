'use client';

import { useEffect, useMemo, useState } from 'react';
import { Link2, Link2Off, ScanSearch } from 'lucide-react';
import { Button } from '@/components/design-system/Button';
import { Select } from '@/components/design-system/Select';
import {
    classifyEditorialTargets,
    discoverEditorialOverlapCandidates,
    getEditorialTargetKey,
    type EditorialOverlapDiscoveryEntry,
} from '@/lib/editorial-links';
import { useTimelineStore } from '@/stores/timeline-store';
import type { EditorialDependentTargetV1 } from '@/types/editorial';
import { useTextEditorCommands } from './useTextEditorCommands';

interface EditorialTargetLinkPanelProps {
    target: EditorialDependentTargetV1;
    targetLabel: string;
    locked: boolean;
}

/**
 * Exact identity controls shared by video, audio, and subtitle inspectors.
 *
 * The component projects the current V4 graph on every durable revision and sends every mutation
 * through the store's link adapter. Local state contains only the user's pending anchor/range form;
 * it never mirrors a link or transcript body.
 */
export function EditorialTargetLinkPanel({
    target,
    targetLabel,
    locked,
}: EditorialTargetLinkPanelProps) {
    const revision = useTimelineStore((state) => state.revision);
    const document = useMemo(
        () => {
            if (!Number.isSafeInteger(revision)) throw new Error('Timeline revision must be a safe integer.');
            return useTimelineStore.getState().buildEditorDocumentV4();
        },
        [revision],
    );
    const { feedback, runLink } = useTextEditorCommands();
    const targetKey = getEditorialTargetKey(target);
    const classificationResult = useMemo(() => classifyEditorialTargets(document), [document]);
    const classification = classificationResult.kind === 'success'
        ? classificationResult.classifications.find((entry) => entry.targetKey === targetKey)
        : undefined;
    const discoveryResult = useMemo(
        () => document.narrative ? discoverEditorialOverlapCandidates(document) : null,
        [document],
    );
    const discovery = discoveryResult?.kind === 'success'
        ? discoveryResult.entries.find((entry) => entry.targetKey === targetKey)
        : undefined;
    const blocks = useMemo(
        () => document.narrative?.blockIds.map((blockId) => document.narrative!.blocks[blockId]) ?? [],
        [document.narrative],
    );
    const currentLink = classification?.kind === 'transcript-bound'
        || classification?.kind === 'overlap-linked'
        ? classification.link
        : null;
    const initialAnchorId = currentLink?.anchorBlockId
        ?? discovery?.anchorBlockId
        ?? blocks[0]?.id
        ?? '';
    const [anchorBlockId, setAnchorBlockId] = useState(initialAnchorId);
    const anchor = document.narrative?.blocks[anchorBlockId];
    const [activeStartSample, setActiveStartSample] = useState(anchor?.coreStartSample ?? 0);
    const [activeEndSample, setActiveEndSample] = useState(anchor?.coreEndSample ?? 0);

    useEffect(() => {
        const nextAnchorId = currentLink?.anchorBlockId
            ?? discovery?.anchorBlockId
            ?? blocks[0]?.id
            ?? '';
        if (!document.narrative?.blocks[anchorBlockId]) setAnchorBlockId(nextAnchorId);
    }, [anchorBlockId, blocks, currentLink?.anchorBlockId, discovery?.anchorBlockId, document.narrative]);

    useEffect(() => {
        if (!anchor) return;
        const binding = currentLink?.association.kind === 'transcript-bound'
            && currentLink.anchorBlockId === anchor.id
            ? currentLink.association.binding
            : null;
        setActiveStartSample(binding?.activeStartSample ?? anchor.coreStartSample);
        setActiveEndSample(binding?.activeEndSample ?? anchor.coreEndSample);
    }, [anchor, currentLink]);

    if (!document.narrative) return null;
    if (classificationResult.kind === 'error') {
        return (
            <section className="rounded border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-200" role="alert">
                Link status unavailable: {classificationResult.error.message}
            </section>
        );
    }
    if (!classification) return null;

    const status = classification.kind === 'owned'
        ? 'Controlled'
        : classification.kind === 'transcript-bound'
            ? 'Exact bound'
            : classification.kind === 'overlap-linked'
                ? 'Overlap linked'
                : 'Unlinked';
    const canBind = classification.kind === 'unbound'
        && anchor
        && Number.isSafeInteger(activeStartSample)
        && Number.isSafeInteger(activeEndSample)
        && activeStartSample >= anchor.coreStartSample
        && activeEndSample <= anchor.coreEndSample
        && activeEndSample > activeStartSample;

    return (
        <section data-testid="editorial-target-link-panel" className="grid gap-2 rounded border border-slate-800 bg-slate-950/55 p-2.5">
            <div className="flex items-center gap-2">
                <Link2 className="h-3.5 w-3.5 text-violet-300" />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-medium text-slate-200">{targetLabel}</p>
                    <p className="text-[9px] font-mono text-slate-600">{target.kind} · {targetKey}</p>
                </div>
                <TargetStatus status={status} />
            </div>

            {classification.kind === 'owned' ? (
                <p className="text-[10px] leading-relaxed text-slate-500">
                    This video occurrence is controlled by the Text narrative. Select its block to
                    change media boundaries or release its source track.
                </p>
            ) : (
                <>
                    <label className="grid gap-1 text-[10px] text-slate-500">
                        Narrative anchor
                        <Select
                            value={anchorBlockId}
                            tone="modal"
                            controlSize="xs"
                            onChange={(event) => setAnchorBlockId(event.target.value)}
                        >
                            {blocks.map((block, index) => (
                                <option key={block.id} value={block.id}>
                                    {index + 1}. {block.kind === 'speech' ? 'Speech' : 'Source-backed silence'} · {block.trackId}
                                </option>
                            ))}
                        </Select>
                    </label>

                    {classification.kind === 'unbound' && (
                        <>
                            <div className="grid grid-cols-2 gap-2">
                                <label className="grid gap-1 text-[10px] text-slate-500">
                                    Exact start sample
                                    <input
                                        type="number"
                                        value={activeStartSample}
                                        min={anchor?.coreStartSample ?? 0}
                                        max={(anchor?.coreEndSample ?? 1) - 1}
                                        onChange={(event) => setActiveStartSample(Number(event.target.value))}
                                        className="h-7 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-white outline-none focus:border-sky-400"
                                    />
                                </label>
                                <label className="grid gap-1 text-[10px] text-slate-500">
                                    Exact end sample
                                    <input
                                        type="number"
                                        value={activeEndSample}
                                        min={(anchor?.coreStartSample ?? 0) + 1}
                                        max={anchor?.coreEndSample ?? 1}
                                        onChange={(event) => setActiveEndSample(Number(event.target.value))}
                                        className="h-7 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-white outline-none focus:border-sky-400"
                                    />
                                </label>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    className="h-7 text-[10px]"
                                    disabled={!canBind}
                                    title="Persist this exact source-backed fragment and occurrence lineage"
                                    onClick={() => void runLink({
                                        type: 'bind-target',
                                        target,
                                        anchorBlockId,
                                        activeStartSample,
                                        activeEndSample,
                                    })}
                                >
                                    Bind exact fragment
                                </Button>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    className="h-7 text-[10px]"
                                    disabled={!anchor}
                                    title="Create an explicit overlap relationship without moving the target"
                                    onClick={() => void runLink({
                                        type: 'create-overlap-link',
                                        target,
                                        anchorBlockId,
                                    })}
                                >
                                    Link to anchor
                                </Button>
                            </div>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-[10px] text-slate-400"
                                onClick={() => void runLink({ type: 'discover-overlaps' }, {
                                    successMessage: 'Every uniquely greatest overlap was linked.',
                                    noopMessage: 'No unbound target has one unique greatest overlap.',
                                })}
                                title="Auto-link only unique greatest positive overlaps; ties stay unlinked"
                            >
                                <ScanSearch className="h-3 w-3" /> Discover project overlaps
                            </Button>
                            <DiscoveryEvidence discovery={discovery} />
                        </>
                    )}

                    {currentLink && (
                        <>
                            <div className="rounded border border-slate-800 bg-slate-900/55 px-2 py-1.5 text-[10px] text-slate-400">
                                <p>{currentLink.association.kind === 'transcript-bound'
                                    ? `Exact samples [${currentLink.association.binding.activeStartSample}, ${currentLink.association.binding.activeEndSample})`
                                    : `${currentLink.association.origin} overlap association`}</p>
                                <p className="mt-0.5 font-mono text-slate-600">
                                    offsets [{currentLink.relativeStartOutputSample}, {currentLink.relativeEndOutputSample}) @ 48 kHz
                                </p>
                            </div>
                            <label className="flex items-center justify-between gap-3 text-[10px] text-slate-400">
                                Follow anchor structural edits
                                <input
                                    type="checkbox"
                                    checked={currentLink.followPolicy === 'follow'}
                                    disabled={locked && currentLink.followPolicy !== 'follow'}
                                    title={locked ? 'Unlock the target track before enabling follow' : undefined}
                                    onChange={(event) => void runLink({
                                        type: 'set-follow-policy',
                                        target,
                                        followPolicy: event.target.checked ? 'follow' : 'none',
                                    })}
                                    className="accent-teal-400"
                                />
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    className="h-7 text-[10px]"
                                    disabled={anchorBlockId === currentLink.anchorBlockId}
                                    onClick={() => void runLink({
                                        type: 'reanchor-link',
                                        target,
                                        anchorBlockId,
                                    })}
                                >
                                    {currentLink.association.kind === 'transcript-bound' ? 'Retarget binding' : 'Re-anchor link'}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-[10px] text-red-300"
                                    onClick={() => void runLink({
                                        type: currentLink.association.kind === 'transcript-bound'
                                            ? 'unbind-target'
                                            : 'unlink-target',
                                        target,
                                    })}
                                >
                                    <Link2Off className="h-3 w-3" />
                                    {currentLink.association.kind === 'transcript-bound' ? 'Unbind' : 'Unlink'}
                                </Button>
                            </div>
                        </>
                    )}
                </>
            )}

            {feedback.message && (
                <p
                    role={feedback.tone === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                    className={`text-[10px] ${feedback.tone === 'error'
                        ? 'text-red-300'
                        : feedback.tone === 'success'
                            ? 'text-emerald-300'
                            : 'text-slate-500'}`}
                >
                    {feedback.message}
                </p>
            )}
        </section>
    );
}

function DiscoveryEvidence({
    discovery,
}: {
    discovery: EditorialOverlapDiscoveryEntry | undefined;
}) {
    if (!discovery) return null;
    if (discovery.outcome === 'linked') {
        return <p className="text-[10px] text-teal-300">Unique greatest overlap: {discovery.anchorBlockId}</p>;
    }
    if (discovery.outcome === 'ambiguous') {
        return (
            <p className="rounded border border-amber-500/25 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-200">
                Ambiguous equal overlap: {discovery.tiedBlockIds?.join(', ')}. Choose an anchor explicitly.
            </p>
        );
    }
    return <p className="text-[10px] text-slate-500">No positive project overlap. Manual linking is still available.</p>;
}

function TargetStatus({ status }: { status: 'Controlled' | 'Exact bound' | 'Overlap linked' | 'Unlinked' }) {
    const tone = status === 'Controlled'
        ? 'border-sky-500/30 bg-sky-500/10 text-sky-200'
        : status === 'Exact bound'
            ? 'border-violet-500/30 bg-violet-500/10 text-violet-200'
            : status === 'Overlap linked'
                ? 'border-teal-500/30 bg-teal-500/10 text-teal-200'
                : 'border-slate-700 bg-slate-900 text-slate-400';
    return <span className={`rounded border px-1.5 py-0.5 text-[9px] ${tone}`}>{status}</span>;
}
