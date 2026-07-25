'use client';

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type DragEvent,
    type KeyboardEvent,
    type MouseEvent,
    type ReactNode,
} from 'react';
import { AlertTriangle, Link2, Lock, VolumeX } from 'lucide-react';
import { sourceSampleToVideoFrame } from '@/lib/narrative/materializer';
import { framesToSeconds, secondsToFrames } from '@/lib/render-profile';
import { usePlaybackStore } from '@/stores/playback-store';
import type {
    RationalFrameRate,
    TransientMediaSelectionV4,
    VideoSourceAssetV3,
    VideoTrackV4,
} from '@/types/video';
import type { GlobalEditingMode } from '@/types/editorial';
import {
    getVisibleNarrativeRows,
    type NarrativeBlockRow,
    type NarrativeListProjection,
} from './text-editor-model';

interface NarrativeListProps {
    projection: NarrativeListProjection;
    selection: TransientMediaSelectionV4;
    videoSources: readonly VideoSourceAssetV3[];
    videoTracks: readonly VideoTrackV4[];
    projectFps: RationalFrameRate;
    mode: GlobalEditingMode;
    showSpeakers: boolean;
    followPlayhead: boolean;
    onSelect: (blockId: string, sourceWordIds: string[]) => void;
    onReorder: (blockId: string, targetIndex: number) => void;
}

/** Fixed-row virtual window over the one canonical document-wide narrative sequence. */
export function NarrativeList({
    projection,
    selection,
    videoSources,
    videoTracks,
    projectFps,
    mode,
    showSpeakers,
    followPlayhead,
    onSelect,
    onReorder,
}: NarrativeListProps) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const cardRefs = useRef(new Map<string, HTMLElement>());
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const [draggingBlockId, setDraggingBlockId] = useState<string | null>(null);
    const [dropBlockId, setDropBlockId] = useState<string | null>(null);
    const currentTime = usePlaybackStore((state) => state.currentTime);
    const currentFrame = secondsToFrames(currentTime, projectFps, 'nearest');
    const visibleRows = useMemo(
        () => getVisibleNarrativeRows(projection, scrollTop, viewportHeight),
        [projection, scrollTop, viewportHeight],
    );
    const blockRows = useMemo(
        () => projection.rows.filter((row): row is NarrativeBlockRow => row.kind === 'block'),
        [projection.rows],
    );

    useEffect(() => {
        const element = scrollerRef.current;
        if (!element) return;
        const measure = () => setViewportHeight(element.clientHeight);
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (selection.kind !== 'narrative') return;
        const row = projection.blockRowById.get(selection.blockId);
        if (!row) return;
        const scroller = scrollerRef.current;
        if (scroller && (row.top < scroller.scrollTop
            || row.top + row.height > scroller.scrollTop + scroller.clientHeight)) {
            const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            scroller.scrollTo({
                top: Math.max(0, row.top - 8),
                behavior: reducedMotion ? 'auto' : 'smooth',
            });
        }
        requestAnimationFrame(() => cardRefs.current.get(selection.blockId)?.focus({ preventScroll: true }));
    }, [projection.blockRowById, selection]);

    useEffect(() => {
        if (!followPlayhead) return;
        const active = blockRows.find((row) => (
            currentFrame >= row.block.timelineStartFrame && currentFrame < row.projectEndFrame
        ));
        if (!active) return;
        const scroller = scrollerRef.current;
        if (!scroller || (active.top >= scroller.scrollTop
            && active.top + active.height <= scroller.scrollTop + scroller.clientHeight)) return;
        scroller.scrollTo({ top: Math.max(0, active.top - 8), behavior: 'auto' });
    }, [blockRows, currentFrame, followPlayhead]);

    useEffect(() => () => document.body.classList.remove('select-none'), []);

    const selectRow = useCallback((row: NarrativeBlockRow, wordIds: string[]) => {
        onSelect(row.block.id, wordIds);
        const source = videoSources.find((candidate) => candidate.id === row.block.sourceId);
        const firstWord = wordIds.length > 0
            ? row.words.find((word) => word.id === wordIds[0])
            : undefined;
        let frame = row.block.timelineStartFrame;
        if (source && firstWord) {
            const sourceFrame = sourceSampleToVideoFrame(
                firstWord.editableStartSample,
                source.fps,
                'nearest',
            );
            const sourceFrameOffset = Math.max(
                0,
                sourceFrame - row.block.materialization.sourceStartFrame,
            );
            frame += secondsToFrames(sourceFrameOffset / source.fps, projectFps, 'nearest');
            frame = Math.min(row.projectEndFrame - 1, frame);
        }
        usePlaybackStore.getState().seek(framesToSeconds(frame, projectFps));
    }, [onSelect, projectFps, videoSources]);

    const selectWord = (event: MouseEvent, row: NarrativeBlockRow, wordId: string) => {
        event.stopPropagation();
        if (event.shiftKey && selection.kind === 'narrative' && selection.blockId === row.block.id
            && selection.sourceWordIds.length > 0) {
            const anchorIndex = row.words.findIndex((word) => word.id === selection.sourceWordIds[0]);
            const targetIndex = row.words.findIndex((word) => word.id === wordId);
            if (anchorIndex >= 0 && targetIndex >= 0) {
                const [start, end] = anchorIndex <= targetIndex
                    ? [anchorIndex, targetIndex]
                    : [targetIndex, anchorIndex];
                selectRow(row, row.words.slice(start, end + 1).map((word) => word.id));
                return;
            }
        }
        selectRow(row, [wordId]);
    };

    const focusRelativeBlock = (event: KeyboardEvent<HTMLElement>, row: NarrativeBlockRow) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            if (row.words.length === 0) return;
            event.preventDefault();
            event.stopPropagation();
            const selectedIds = selection.kind === 'narrative' && selection.blockId === row.id
                ? selection.sourceWordIds
                : [];
            const activeIndex = selectedIds.length > 0
                ? row.words.findIndex((word) => word.id === selectedIds.at(-1))
                : event.key === 'ArrowRight' ? -1 : row.words.length;
            const targetIndex = Math.max(0, Math.min(
                row.words.length - 1,
                activeIndex + (event.key === 'ArrowRight' ? 1 : -1),
            ));
            const targetWordId = row.words[targetIndex].id;
            if (event.shiftKey && selectedIds.length > 0) {
                const anchorIndex = row.words.findIndex((word) => word.id === selectedIds[0]);
                const [start, end] = anchorIndex <= targetIndex
                    ? [anchorIndex, targetIndex]
                    : [targetIndex, anchorIndex];
                selectRow(row, row.words.slice(start, end + 1).map((word) => word.id));
            } else {
                selectRow(row, [targetWordId]);
            }
            return;
        }
        if (event.key === 'Escape' && selection.kind === 'narrative'
            && selection.blockId === row.id && selection.sourceWordIds.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            selectRow(row, []);
            return;
        }
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const index = blockRows.findIndex((candidate) => candidate.id === row.id);
        const targetIndex = event.key === 'Home'
            ? 0
            : event.key === 'End'
                ? blockRows.length - 1
                : Math.max(0, Math.min(blockRows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
        const target = blockRows[targetIndex];
        if (target) selectRow(target, []);
    };

    const finishDrag = () => {
        document.body.classList.remove('select-none');
        setDraggingBlockId(null);
        setDropBlockId(null);
    };

    const drop = (event: DragEvent<HTMLElement>, targetRow: NarrativeBlockRow) => {
        event.preventDefault();
        const blockId = draggingBlockId ?? event.dataTransfer.getData('text/x-waptions-block-id');
        if (!blockId || blockId === targetRow.id || mode !== 'ripple') {
            finishDrag();
            return;
        }
        const remaining = blockRows.filter((row) => row.id !== blockId);
        const targetIndex = remaining.findIndex((row) => row.id === targetRow.id);
        if (targetIndex >= 0) onReorder(blockId, targetIndex);
        finishDrag();
    };

    return (
        <div
            ref={scrollerRef}
            data-testid="narrative-virtual-list"
            role="listbox"
            aria-label="Unified text edit narrative"
            aria-multiselectable="true"
            className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-slate-950 scrollbar-thin scrollbar-thumb-slate-700"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
            <div className="relative min-w-0" style={{ height: projection.totalHeight }}>
                {visibleRows.map((row) => row.kind === 'gap'
                    ? (
                        <div
                            key={row.id}
                            className="absolute inset-x-0 flex items-center px-4 text-[10px] text-slate-600"
                            style={{ top: row.top, height: row.height }}
                            aria-label={`Timeline gap from frame ${row.startFrame} to ${row.endFrame}`}
                        >
                            <span className="h-px flex-1 bg-slate-800" />
                            <span className="mx-2 rounded border border-slate-800 bg-slate-950 px-2 py-0.5">
                                Timeline gap · {row.endFrame - row.startFrame} frames
                            </span>
                            <span className="h-px flex-1 bg-slate-800" />
                        </div>
                    )
                    : (
                        <NarrativeCard
                            key={row.id}
                            row={row}
                            selected={selection.kind === 'narrative' && selection.blockId === row.id}
                            selectedWordIds={selection.kind === 'narrative' && selection.blockId === row.id
                                ? selection.sourceWordIds
                                : []}
                            atPlayhead={currentFrame >= row.block.timelineStartFrame
                                && currentFrame < row.projectEndFrame}
                            locked={videoTracks.find((track) => track.id === row.block.trackId)?.locked ?? false}
                            showSpeakers={showSpeakers}
                            mode={mode}
                            dragging={draggingBlockId === row.id}
                            dropTarget={dropBlockId === row.id}
                            registerRef={(element) => {
                                if (element) cardRefs.current.set(row.id, element);
                                else cardRefs.current.delete(row.id);
                            }}
                            onSelect={() => selectRow(row, [])}
                            onSelectWord={(event, wordId) => selectWord(event, row, wordId)}
                            onKeyDown={(event) => focusRelativeBlock(event, row)}
                            onDragStart={(event) => {
                                if (mode !== 'ripple') {
                                    event.preventDefault();
                                    return;
                                }
                                event.dataTransfer.effectAllowed = 'move';
                                event.dataTransfer.setData('text/x-waptions-block-id', row.id);
                                document.body.classList.add('select-none');
                                setDraggingBlockId(row.id);
                            }}
                            onDragOver={(event) => {
                                if (mode !== 'ripple' || !draggingBlockId) return;
                                event.preventDefault();
                                event.dataTransfer.dropEffect = 'move';
                                setDropBlockId(row.id);
                            }}
                            onDrop={(event) => drop(event, row)}
                            onDragEnd={finishDrag}
                        />
                    ))}
            </div>
        </div>
    );
}

interface NarrativeCardProps {
    row: NarrativeBlockRow;
    selected: boolean;
    selectedWordIds: readonly string[];
    atPlayhead: boolean;
    locked: boolean;
    showSpeakers: boolean;
    mode: GlobalEditingMode;
    dragging: boolean;
    dropTarget: boolean;
    registerRef: (element: HTMLElement | null) => void;
    onSelect: () => void;
    onSelectWord: (event: MouseEvent, wordId: string) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
}

function NarrativeCard({
    row,
    selected,
    selectedWordIds,
    atPlayhead,
    locked,
    showSpeakers,
    mode,
    dragging,
    dropTarget,
    registerRef,
    onSelect,
    onSelectWord,
    onKeyDown,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
}: NarrativeCardProps) {
    const selectedWords = new Set(selectedWordIds);
    const linkTotal = row.linkCounts.video + row.linkCounts.audio + row.linkCounts.subtitle;
    return (
        <article
            ref={registerRef}
            role="option"
            tabIndex={selected ? 0 : -1}
            aria-selected={selected}
            aria-label={`${row.silenceLabel ?? `${row.words.length} word speech block`}, ${selectedWordIds.length} selected words, source track ${row.trackLabel}, ${row.durationFrames} project frames, ${mode} mode`}
            draggable={mode === 'ripple' && !locked}
            onClick={onSelect}
            onKeyDown={(event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    onSelect();
                    return;
                }
                onKeyDown(event);
            }}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
            className={`absolute left-2 right-2 cursor-default overflow-hidden rounded-md border px-3 py-2 text-left transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 ${dragging
                ? 'opacity-45'
                : ''} ${dropTarget
                ? 'border-sky-300 bg-sky-500/15'
                : selected
                    ? 'border-sky-400/70 bg-sky-500/10'
                    : atPlayhead
                        ? 'border-violet-400/45 bg-violet-500/5'
                        : 'border-slate-800 bg-slate-900/65 hover:border-slate-700'}`}
            style={{ top: row.top + 3, height: row.height - 6 }}
        >
            <div className="flex min-w-0 items-center gap-1.5 text-[10px]">
                <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono font-semibold text-sky-200">
                    V{row.trackIndex + 1}
                </span>
                <span className="min-w-0 truncate font-medium text-slate-300" title={row.trackLabel}>{row.trackLabel}</span>
                <StatusBadge tone="sky">Controlled</StatusBadge>
                {row.hydration === 'missing' && <StatusBadge tone="red">Transcript unavailable</StatusBadge>}
                {row.linkCounts.exactBound > 0 && <StatusBadge tone="violet">{row.linkCounts.exactBound} exact bound</StatusBadge>}
                {row.linkCounts.overlapLinked > 0 && <StatusBadge tone="teal">{row.linkCounts.overlapLinked} overlap linked</StatusBadge>}
                {locked && <Lock className="ml-auto h-3 w-3 text-amber-300" aria-label="Source track locked" />}
                {!locked && (
                    <span className="ml-auto font-mono tabular-nums text-slate-600">
                        {row.block.timelineStartFrame}–{row.projectEndFrame} fr
                    </span>
                )}
            </div>

            {row.hydration === 'missing' ? (
                <div className="mt-3 flex items-center gap-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-2 text-xs text-red-200">
                    <AlertTriangle className="h-4 w-4" />
                    The verified transcript body is not hydrated. Editing actions are unavailable.
                </div>
            ) : row.silenceLabel ? (
                <div className={`mt-3 flex items-center gap-2 rounded border px-3 py-3 ${row.silenceLabel === 'Silence'
                    ? 'border-slate-700 bg-slate-950/70 text-slate-300'
                    : row.silenceLabel === 'No audio'
                        ? 'border-amber-500/25 bg-amber-500/5 text-amber-200'
                        : 'border-violet-500/25 bg-violet-500/5 text-violet-200'}`}
                >
                    <VolumeX className="h-4 w-4" />
                    <div>
                        <p className="text-xs font-semibold">{row.silenceLabel}</p>
                        <p className="text-[10px] opacity-70">Source-backed range · {row.durationFrames} project frames</p>
                    </div>
                </div>
            ) : (
                <div className="mt-2 max-h-[62px] overflow-y-auto pr-1 leading-7 scrollbar-thin scrollbar-thumb-slate-700">
                    {row.words.map((word) => {
                        const selectedWord = selectedWords.has(word.id);
                        return (
                            <span key={word.id} className="mr-1 inline-flex items-center gap-0.5">
                                {showSpeakers && word.speakerLabel && (
                                    <span className="rounded bg-fuchsia-500/15 px-1 py-0.5 text-[9px] text-fuchsia-200">
                                        {word.speakerLabel}
                                    </span>
                                )}
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    aria-pressed={selectedWord}
                                    aria-label={`${word.displayText}, ${word.speakerLabel ?? 'no speaker'}, source track ${row.trackLabel}`}
                                    title={word.corrected ? `Corrected from “${word.immutableText}”` : word.displayText}
                                    onClick={(event) => onSelectWord(event, word.id)}
                                    className={`rounded px-1 text-sm transition-colors motion-reduce:transition-none ${selectedWord
                                        ? 'bg-sky-400 text-slate-950'
                                        : word.corrected
                                            ? 'bg-amber-500/10 text-amber-100 underline decoration-amber-400 decoration-dotted underline-offset-4 hover:bg-amber-500/20'
                                            : 'text-slate-100 hover:bg-slate-700'}`}
                                >
                                    {word.displayText}
                                </button>
                            </span>
                        );
                    })}
                </div>
            )}

            <div className="absolute bottom-1.5 left-3 right-3 flex items-center gap-2 text-[9px] text-slate-600">
                {linkTotal > 0 ? (
                    <>
                        <Link2 className="h-3 w-3" />
                        {row.linkCounts.video} video · {row.linkCounts.audio} audio · {row.linkCounts.subtitle} subtitle
                        {row.linkCounts.following > 0 && <span className="text-teal-300">· {row.linkCounts.following} following</span>}
                    </>
                ) : (
                    <span>No dependent targets</span>
                )}
                {mode === 'absolute' && <span className="ml-auto text-amber-300/70">Absolute placement</span>}
            </div>
        </article>
    );
}

function StatusBadge({ children, tone }: { children: ReactNode; tone: 'sky' | 'violet' | 'teal' | 'red' }) {
    const tones = {
        sky: 'border-sky-500/25 bg-sky-500/10 text-sky-200',
        violet: 'border-violet-500/25 bg-violet-500/10 text-violet-200',
        teal: 'border-teal-500/25 bg-teal-500/10 text-teal-200',
        red: 'border-red-500/25 bg-red-500/10 text-red-200',
    };
    return <span className={`rounded border px-1 py-0.5 ${tones[tone]}`}>{children}</span>;
}
