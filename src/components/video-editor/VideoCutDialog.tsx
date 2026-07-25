'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, RefreshCw, ScanSearch, Trash2, X } from 'lucide-react';
import { Button } from '../design-system/Button';
import { DraggableNumberInput } from '../design-system/DraggableNumberInput';
import { useTimelineStore } from '@/stores/timeline-store';
import {
    CutDetectionPipeline,
    HistogramHsvDetector,
    WebCodecsFrameSource,
    type Cut,
} from '@/lib/video-cut';
import { buildVideoTrackPlacementsV4 } from '@/lib/video-placement-v4';
import {
    getDefaultVideoCutDetectionScope,
    resolveVideoCutDetectionClipIds,
    type VideoCutDetectionRequest,
    type VideoCutDetectionScope,
} from '@/lib/video-cut/targets';
import { secondsToFrames } from '@/lib/render-profile';
import { useShallow } from 'zustand/react/shallow';

interface VideoCutDialogProps {
    request: VideoCutDetectionRequest | null;
    onClose: () => void;
}

/** Context-owned scene detection dialog for one clip, a multi-selection, or a video lane. */
export function VideoCutDialog({ request, onClose }: VideoCutDialogProps) {
    const titleId = useId();
    const dialogRef = useRef<HTMLDivElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const previouslyFocusedRef = useRef<HTMLElement | null>(null);
    const [scope, setScope] = useState<VideoCutDetectionScope>('clip');
    const [minScore, setMinScore] = useState(0.35);
    const [error, setError] = useState<string | null>(null);
    const [lastResultCount, setLastResultCount] = useState<number | null>(null);

    const {
        cuts,
        setCuts,
        clearCuts,
        isDetecting,
        setIsDetecting,
        detectionProgress,
        setDetectionProgress,
        videoSources,
        videoClips,
        videoTracks,
        renderProfile,
    } = useTimelineStore(useShallow((state) => ({
        cuts: state.cuts,
        setCuts: state.setCuts,
        clearCuts: state.clearCuts,
        isDetecting: state.isDetecting,
        setIsDetecting: state.setIsDetecting,
        detectionProgress: state.detectionProgress,
        setDetectionProgress: state.setDetectionProgress,
        videoSources: state.videoSources,
        videoClips: state.videoClips,
        videoTracks: state.videoTracks,
        renderProfile: state.renderProfile,
    })));

    useEffect(() => {
        if (!request) return;
        setScope(getDefaultVideoCutDetectionScope(request));
        setError(null);
        setLastResultCount(null);
        previouslyFocusedRef.current = request.restoreFocusTo
            ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        const focusFrame = requestAnimationFrame(() => closeButtonRef.current?.focus());
        return () => {
            cancelAnimationFrame(focusFrame);
            requestAnimationFrame(() => previouslyFocusedRef.current?.focus());
        };
    }, [request]);

    useEffect(() => {
        if (!request) return;
        const focusFrame = requestAnimationFrame(() => {
            if (isDetecting) {
                // Detection disables every actionable control. The dialog itself becomes the
                // focus anchor so keyboard focus cannot fall through to the editor underneath.
                dialogRef.current?.focus({ preventScroll: true });
            } else if (document.activeElement === dialogRef.current) {
                closeButtonRef.current?.focus({ preventScroll: true });
            }
        });
        return () => cancelAnimationFrame(focusFrame);
    }, [isDetecting, request]);

    const targetClipIds = useMemo(() => request
        ? resolveVideoCutDetectionClipIds(request, scope, videoTracks, videoClips)
        : [], [request, scope, videoClips, videoTracks]);
    const targetClips = useMemo(() => {
        const ids = new Set(targetClipIds);
        return videoClips.filter((clip) => ids.has(clip.id));
    }, [targetClipIds, videoClips]);
    const targetTrack = request
        ? videoTracks.find((track) => track.id === request.trackId) ?? null
        : null;

    if (!request) return null;

    const handleDetect = async () => {
        if (isDetecting || targetClips.length === 0) return;
        const documentV4 = useTimelineStore.getState().buildEditorDocumentV4();
        const placements = new Map(buildVideoTrackPlacementsV4(documentV4)
            .flatMap((videoTrack) => videoTrack.placements)
            .map((placement) => [placement.clip.id, placement]));
        const clipsBySource = new Map<string, typeof targetClips>();
        targetClips.forEach((clip) => {
            const group = clipsBySource.get(clip.sourceId) ?? [];
            group.push(clip);
            clipsBySource.set(clip.sourceId, group);
        });
        const sourceGroups = Array.from(clipsBySource.entries());
        const detectedTimelineCuts: Cut[] = [];

        try {
            setError(null);
            setLastResultCount(null);
            setIsDetecting(true);
            setDetectionProgress(0);

            for (let sourceIndex = 0; sourceIndex < sourceGroups.length; sourceIndex += 1) {
                const [sourceId, clipsForSource] = sourceGroups[sourceIndex];
                const sourceAsset = videoSources.find((source) => source.id === sourceId);
                if (!sourceAsset) continue;
                const source = new WebCodecsFrameSource(sourceAsset.file);
                try {
                    await source.init();
                    const pipeline = new CutDetectionPipeline(source, new HistogramHsvDetector(), {
                        minScore,
                        localMaxWindowFrames: 2,
                        cooldownFrames: 4,
                    });
                    const sourceCuts = await pipeline.run((progress) => {
                        setDetectionProgress((sourceIndex + progress) / sourceGroups.length);
                    });
                    clipsForSource.forEach((clip) => {
                        const placement = placements.get(clip.id);
                        if (!placement) return;
                        sourceCuts.forEach((cut) => {
                            if (cut.timeSec < clip.sourceStart || cut.timeSec >= clip.sourceEnd) return;
                            const timeSec = placement.startSeconds + cut.timeSec - clip.sourceStart;
                            detectedTimelineCuts.push({
                                ...cut,
                                timeSec,
                                frameIndex: secondsToFrames(timeSec, renderProfile.fps, 'nearest'),
                            });
                        });
                    });
                } finally {
                    await source.close();
                }
                setDetectionProgress((sourceIndex + 1) / sourceGroups.length);
            }

            // Different trimmed instances can map the same source boundary onto one output frame.
            // Collapse those duplicates so the ruler and snap engine receive one canonical marker.
            const uniqueByFrame = new Map<number, Cut>();
            detectedTimelineCuts
                .sort((left, right) => left.frameIndex - right.frameIndex || right.score - left.score)
                .forEach((cut) => {
                    if (!uniqueByFrame.has(cut.frameIndex)) uniqueByFrame.set(cut.frameIndex, cut);
                });
            const nextCuts = Array.from(uniqueByFrame.values());
            setCuts(nextCuts);
            setLastResultCount(nextCuts.length);
        } catch (detectionError) {
            console.error('[VideoCut] Detection failed:', detectionError);
            setError('Scene detection failed for this media. Try another threshold or clip.');
        } finally {
            setIsDetecting(false);
            setDetectionProgress(0);
        }
    };

    const scopeOptions: Array<{
        value: VideoCutDetectionScope;
        label: string;
        detail: string;
        disabled?: boolean;
    }> = [
        {
            value: 'clip',
            label: 'This clip',
            detail: request.clickedClipId ? 'Analyze only the clip that opened this menu.' : 'Open the menu on a clip to use this scope.',
            disabled: !request.clickedClipId,
        },
        {
            value: 'selection',
            label: `Selected clips (${request.selectedClipIds.length})`,
            detail: 'Analyze the current modifier-key clip selection across video tracks.',
            disabled: request.selectedClipIds.length < 2,
        },
        {
            value: 'track',
            label: 'Entire track',
            detail: `Analyze every clip in ${targetTrack?.name ?? 'this video track'}.`,
            disabled: !targetTrack || targetTrack.clipIds.length === 0,
        },
        {
            value: 'all-tracks',
            label: 'All video tracks',
            detail: `Analyze every clip across ${videoTracks.length} ${videoTracks.length === 1 ? 'video track' : 'video tracks'}.`,
            disabled: videoTracks.every((track) => track.clipIds.length === 0),
        },
    ];

    return createPortal(
        <div
            className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
            onPointerDown={(event) => {
                if (event.target === event.currentTarget && !isDetecting) onClose();
            }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-busy={isDetecting}
                aria-labelledby={titleId}
                tabIndex={-1}
                data-testid="video-cut-dialog"
                className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl ring-1 ring-white/10"
                onKeyDown={(event) => {
                    // The modal owns keyboard input. Prevent editor-wide shortcuts from mutating
                    // clips while detection is working from its captured placements and targets.
                    event.stopPropagation();
                    if (event.key === 'Escape' && !isDetecting) {
                        event.preventDefault();
                        onClose();
                        return;
                    }
                    if (event.key !== 'Tab') return;
                    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
                        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
                    ));
                    if (focusable.length === 0) {
                        event.preventDefault();
                        event.currentTarget.focus({ preventScroll: true });
                        return;
                    }
                    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
                    const nextIndex = event.shiftKey
                        ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
                        : (currentIndex >= focusable.length - 1 ? 0 : currentIndex + 1);
                    event.preventDefault();
                    focusable[nextIndex].focus();
                }}
            >
                <header className="flex items-start gap-4 border-b border-slate-800 px-5 py-4">
                    <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-sky-500/15 text-sky-200">
                        <ScanSearch className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h2 id={titleId} className="text-base font-semibold text-slate-100">Detect scene cuts</h2>
                        <p className="mt-1 text-xs leading-relaxed text-slate-400">
                            Choose what to analyze. Existing scene markers will be replaced by this result.
                        </p>
                    </div>
                    <button
                        ref={closeButtonRef}
                        type="button"
                        disabled={isDetecting}
                        className="rounded p-1.5 text-slate-500 hover:bg-slate-800 hover:text-white disabled:opacity-40"
                        onClick={onClose}
                        aria-label="Close scene cut detection"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </header>

                <div className="grid gap-5 px-5 py-5">
                    <fieldset className="grid gap-2">
                        <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Scope</legend>
                        {scopeOptions.map((option) => (
                            <label
                                key={option.value}
                                className={`flex gap-3 rounded-lg border px-3 py-2.5 transition-colors ${option.disabled
                                    ? 'cursor-not-allowed border-slate-800 text-slate-600 opacity-60'
                                    : scope === option.value
                                        ? 'cursor-pointer border-sky-400/60 bg-sky-500/10'
                                        : 'cursor-pointer border-slate-700 bg-slate-950/45 hover:border-slate-600'}`}
                            >
                                <input
                                    type="radio"
                                    name="video-cut-scope"
                                    value={option.value}
                                    checked={scope === option.value}
                                    disabled={option.disabled || isDetecting}
                                    onChange={() => setScope(option.value)}
                                    className="mt-0.5 accent-sky-500"
                                />
                                <span className="min-w-0">
                                    <span className="block text-xs font-medium text-slate-200">{option.label}</span>
                                    <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">{option.detail}</span>
                                </span>
                            </label>
                        ))}
                    </fieldset>

                    <div className="grid gap-2 border-t border-slate-800 pt-4">
                        <DraggableNumberInput
                            value={minScore}
                            min={0.1}
                            max={0.9}
                            step={0.05}
                            decimalPlaces={2}
                            label="Sensitivity threshold"
                            defaultValue={0.35}
                            layout="horizontal"
                            labelWidth={148}
                            disabled={isDetecting}
                            onPreview={setMinScore}
                            onCommit={setMinScore}
                            onCancel={setMinScore}
                        />
                        <p className="text-[11px] text-slate-500">
                            Lower thresholds find more boundaries and can include visual noise.
                        </p>
                    </div>

                    {isDetecting && (
                        <div className="grid gap-2" role="status" aria-live="polite">
                            <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                                <div
                                    className="h-full bg-sky-500 transition-[width] duration-200"
                                    style={{ width: `${detectionProgress * 100}%` }}
                                />
                            </div>
                            <p className="text-center text-[11px] text-slate-400">
                                Analyzing {targetClips.length} {targetClips.length === 1 ? 'clip' : 'clips'} · {(detectionProgress * 100).toFixed(0)}%
                            </p>
                        </div>
                    )}
                    {error && <p className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">{error}</p>}
                    {lastResultCount !== null && !error && (
                        <p className="rounded border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200" role="status">
                            Found {lastResultCount} scene {lastResultCount === 1 ? 'boundary' : 'boundaries'}.
                        </p>
                    )}
                </div>

                <footer className="flex items-center justify-between gap-3 border-t border-slate-800 bg-slate-950/35 px-5 py-4">
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={isDetecting || cuts.length === 0}
                        className="text-slate-400 hover:bg-red-500/10 hover:text-red-200"
                        onClick={() => {
                            clearCuts();
                            setLastResultCount(0);
                        }}
                    >
                        <Trash2 className="h-4 w-4" />
                        Clear markers
                    </Button>
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" disabled={isDetecting} onClick={onClose}>Cancel</Button>
                        <Button
                            variant="primary"
                            size="sm"
                            disabled={isDetecting || targetClips.length === 0}
                            onClick={() => void handleDetect()}
                        >
                            {isDetecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                            {lastResultCount === null ? 'Detect cuts' : 'Run again'}
                        </Button>
                    </div>
                </footer>
            </div>
        </div>,
        document.body,
    );
}
