'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link2Off, Volume2, VolumeX } from 'lucide-react';
import type { ClipPlacement, VideoSourceAsset, VideoTrack } from '@/types/video';
import type { TimelineVideoClip } from '@/stores/timeline-store';
import type { AudioMediaCacheKey } from '@/lib/media-asset-ref';
import type { WaveformPeaks } from '@/lib/video-waveform';
import { getAudioMediaCacheKey } from '@/lib/media-asset-ref';
import { useTimelineStore } from '@/stores/timeline-store';
import { buildClipPlacements } from '@/lib/video-timeline';
import {
    beginTimelineGesture,
    cancelTimelineGesture,
    finishTimelineGesture,
    updateTimelineGesture,
    type TimelineGestureState,
} from '@/lib/timeline-gesture';
import { TimelineContextMenu } from './TimelineContextMenu';
import { TimelineWaveform } from './TimelineWaveform';
import { useShallow } from 'zustand/react/shallow';
import { useEditorTransactionCoordinator } from './EditorTransactionContext';
import {
    parseVideoTrackDropTarget,
    type VideoTrackDropTarget,
} from '@/lib/video-track-drop-target';
import type { VideoCutDetectionRequest } from '@/lib/video-cut/targets';

export interface VideoTrackDragPreview {
    clipId: string;
    target: VideoTrackDropTarget | null;
}

interface TimelineVideoTrackProps {
    track: VideoTrack;
    peaksByMediaKey: ReadonlyMap<AudioMediaCacheKey, WaveformPeaks>;
    selectedClipIds: readonly string[];
    onClipSelectionChange: (clipId: string, additive: boolean) => void;
    onClearClipSelection: () => void;
    onOpenCutDetection: (request: VideoCutDetectionRequest) => void;
    onDragPreviewChange: (preview: VideoTrackDragPreview | null) => void;
}

interface ClipBlockProps {
    placement: ClipPlacement;
    clip: TimelineVideoClip;
    source: VideoSourceAsset;
    trackId: string;
    peaks?: WaveformPeaks;
    pixelsPerSecond: number;
    selected: boolean;
    selectedClipIds: readonly string[];
    onClipSelectionChange: (clipId: string, additive: boolean) => void;
    onOpenCutDetection: (request: VideoCutDetectionRequest) => void;
    onDragPreviewChange: (preview: VideoTrackDragPreview | null) => void;
}

interface TrimDraft {
    sourceStart: number;
    sourceEnd: number;
}

function areTrimDraftsEqual(left: TrimDraft, right: TrimDraft) {
    return left.sourceStart === right.sourceStart && left.sourceEnd === right.sourceEnd;
}

function ClipBlock({
    placement,
    clip,
    source,
    trackId,
    peaks,
    pixelsPerSecond,
    selected,
    selectedClipIds,
    onClipSelectionChange,
    onOpenCutDetection,
    onDragPreviewChange,
}: ClipBlockProps) {
    const transactionCoordinator = useEditorTransactionCoordinator();
    const {
        projectFps,
        trimVideoClip,
        detachVideoClipAudio,
        moveVideoClipToTrack,
        moveVideoClipToNewTrack,
    } = useTimelineStore(useShallow((state) => ({
        projectFps: state.projectFps,
        trimVideoClip: state.trimVideoClip,
        detachVideoClipAudio: state.detachVideoClipAudio,
        moveVideoClipToTrack: state.moveVideoClipToTrack,
        moveVideoClipToNewTrack: state.moveVideoClipToNewTrack,
    })));
    const clipRef = useRef<HTMLDivElement>(null);
    const [trimPreview, setTrimPreview] = useState<TrimDraft | null>(null);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const [isLaneDragging, setIsLaneDragging] = useState(false);
    const activeLaneDragCancellationRef = useRef<(() => void) | null>(null);
    const suppressClickRef = useRef(false);
    const previewStart = trimPreview?.sourceStart ?? clip.sourceStart;
    const previewEnd = trimPreview?.sourceEnd ?? clip.sourceEnd;
    const previewDuration = previewEnd - previewStart;
    const visibleDuration = trimPreview ? previewDuration : placement.duration;
    const canSeparateAudio = source.hasAudio && clip.audio?.linkState === 'linked';

    const openContextMenu = (x: number, y: number) => {
        // Context-clicking one member of a multi-selection must preserve the group so the modal
        // can offer a meaningful "selected clips" scope. An unselected clip becomes the context.
        if (!selectedClipIds.includes(clip.id)) onClipSelectionChange(clip.id, false);
        setMenu({ x, y });
    };

    useEffect(() => () => activeLaneDragCancellationRef.current?.(), []);

    const beginLaneDrag = (event: React.PointerEvent<HTMLDivElement>) => {
        // A secondary touch contact also reports button 0. Only the primary pointer may own the
        // shared lane preview and terminal commit; otherwise concurrent contacts could overwrite
        // each other's target and publish more than one clip move.
        if (event.button !== 0 || !event.isPrimary) return;
        const pointerId = event.pointerId;
        const origin = { x: event.clientX, y: event.clientY };
        const pointerOwner = event.currentTarget;
        let active = false;
        let terminal = false;
        let target: VideoTrackDropTarget | null = null;
        let unregisterCancellation: () => void = () => undefined;

        // Modifier clicks toggle on the later click event. Publishing here as well would toggle
        // twice; ordinary pointer-down still selects immediately so drag feedback has an owner.
        if (!event.metaKey && !event.ctrlKey) onClipSelectionChange(clip.id, false);
        pointerOwner.setPointerCapture(pointerId);

        const cleanup = () => {
            unregisterCancellation();
            activeLaneDragCancellationRef.current = null;
            window.removeEventListener('pointermove', handleMove);
            window.removeEventListener('pointerup', handleUp);
            window.removeEventListener('pointercancel', handleCancel);
            window.removeEventListener('keydown', handleKeyDown);
            pointerOwner.removeEventListener('lostpointercapture', handleLostPointerCapture);
            if (pointerOwner.hasPointerCapture(pointerId)) pointerOwner.releasePointerCapture(pointerId);
            onDragPreviewChange(null);
            setIsLaneDragging(false);
        };
        const handleMove = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== pointerId) return;
            if (!active && Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < 5) return;
            if (!active) {
                active = true;
                suppressClickRef.current = true;
                setIsLaneDragging(true);
            }
            target = parseVideoTrackDropTarget(document.elementFromPoint(moveEvent.clientX, moveEvent.clientY));
            onDragPreviewChange({ clipId: clip.id, target });
        };
        const finish = (commit: boolean) => {
            if (terminal) return;
            terminal = true;
            const finalTarget = active ? target : null;
            cleanup();
            if (active) window.setTimeout(() => { suppressClickRef.current = false; }, 0);
            if (!commit || !finalTarget) return;
            if (finalTarget.kind === 'track') {
                moveVideoClipToTrack(clip.id, finalTarget.trackId);
            } else {
                moveVideoClipToNewTrack(clip.id, finalTarget.insertionIndex);
            }
        };
        const handleUp = (upEvent: PointerEvent) => {
            if (upEvent.pointerId === pointerId) finish(true);
        };
        const handleCancel = (cancelEvent?: PointerEvent) => {
            if (cancelEvent && cancelEvent.pointerId !== pointerId) return;
            finish(false);
        };
        const handleLostPointerCapture = () => finish(false);
        const handleKeyDown = (keyEvent: KeyboardEvent) => {
            if (keyEvent.key !== 'Escape') return;
            keyEvent.preventDefault();
            finish(false);
            pointerOwner.focus({ preventScroll: true });
        };

        unregisterCancellation = transactionCoordinator.register(() => finish(false));
        activeLaneDragCancellationRef.current = () => finish(false);
        window.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', handleUp);
        window.addEventListener('pointercancel', handleCancel);
        window.addEventListener('keydown', handleKeyDown);
        pointerOwner.addEventListener('lostpointercapture', handleLostPointerCapture);
    };

    const beginTrim = (side: 'start' | 'end', event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const startClientX = event.clientX;
        const initial: TrimDraft = { sourceStart: clip.sourceStart, sourceEnd: clip.sourceEnd };
        const minimumDuration = 1 / projectFps;
        let gesture: TimelineGestureState<TrimDraft> = beginTimelineGesture(initial);
        let terminal = false;
        let unregisterCancellation: () => void = () => undefined;

        const cleanup = () => {
            unregisterCancellation();
            window.removeEventListener('pointermove', handleMove);
            window.removeEventListener('pointerup', handleUp);
            window.removeEventListener('pointercancel', handleCancel);
            window.removeEventListener('keydown', handleKeyDown);
        };
        const handleMove = (moveEvent: PointerEvent) => {
            const delta = (moveEvent.clientX - startClientX) / pixelsPerSecond;
            const draft = side === 'start'
                ? {
                    sourceStart: Math.max(0, Math.min(initial.sourceEnd - minimumDuration, initial.sourceStart + delta)),
                    sourceEnd: initial.sourceEnd,
                }
                : {
                    sourceStart: initial.sourceStart,
                    sourceEnd: Math.max(initial.sourceStart + minimumDuration, Math.min(source.duration, initial.sourceEnd + delta)),
                };
            gesture = updateTimelineGesture(gesture, draft);
            setTrimPreview(draft);
        };
        const handleUp = () => {
            if (terminal) return;
            terminal = true;
            cleanup();
            setTrimPreview(null);
            const finished = finishTimelineGesture(gesture, areTrimDraftsEqual);
            if (finished.commit) trimVideoClip(clip.id, finished.commit.sourceStart, finished.commit.sourceEnd);
        };
        const handleCancel = () => {
            if (terminal) return;
            terminal = true;
            cleanup();
            cancelTimelineGesture<TrimDraft>();
            setTrimPreview(null);
        };
        const handleKeyDown = (keyEvent: KeyboardEvent) => {
            if (keyEvent.key !== 'Escape') return;
            keyEvent.preventDefault();
            handleCancel();
            clipRef.current?.focus();
        };

        unregisterCancellation = transactionCoordinator.register(handleCancel);

        window.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', handleUp, { once: true });
        window.addEventListener('pointercancel', handleCancel, { once: true });
        window.addEventListener('keydown', handleKeyDown);
    };

    return (
        <>
            <div
                ref={clipRef}
                tabIndex={0}
                role="button"
                data-testid="timeline-video-clip"
                className={`absolute bottom-1 top-1 cursor-pointer touch-none overflow-hidden rounded border transition-colors focus:outline-none focus:ring-2 focus:ring-sky-200 ${isLaneDragging ? 'cursor-grabbing opacity-70' : ''} ${selected
                    ? 'z-20 border-sky-200 bg-sky-500/30 ring-1 ring-sky-200/60'
                    : 'z-10 border-sky-400/35 bg-sky-500/15 hover:border-sky-300/60 hover:bg-sky-500/20'
                    }`}
                style={{
                    left: placement.projectStart * pixelsPerSecond,
                    // Persisted geometry uses the canonical frame-domain placement. Raw seconds
                    // are used only while previewing an uncommitted pointer trim.
                    width: Math.max(2, visibleDuration * pixelsPerSecond),
                }}
                onClick={(event) => {
                    event.stopPropagation();
                    if (suppressClickRef.current) {
                        suppressClickRef.current = false;
                        return;
                    }
                    onClipSelectionChange(clip.id, event.metaKey || event.ctrlKey);
                }}
                onPointerDown={beginLaneDrag}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openContextMenu(event.clientX, event.clientY);
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        // This clip cannot be a native button because its trim handles are
                        // interactive descendants. Mirror native activation so keyboard users
                        // can expose the same inspector controls without triggering editor-wide
                        // Enter/Space shortcuts after the event reaches window.
                        event.preventDefault();
                        event.stopPropagation();
                        onClipSelectionChange(clip.id, event.metaKey || event.ctrlKey);
                        return;
                    }
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openContextMenu(rect.left + Math.min(rect.width, 24), rect.top + Math.min(rect.height, 24));
                }}
                aria-label={`${source.originalName}, video clip from ${previewStart.toFixed(2)} to ${previewEnd.toFixed(2)} seconds`}
                title={`${source.originalName} · ${previewStart.toFixed(2)}s–${previewEnd.toFixed(2)}s`}
            >
                {canSeparateAudio && (
                    <div className="absolute inset-x-0 bottom-0 h-1/2 overflow-hidden border-t border-sky-200/15 bg-sky-950/45">
                        <TimelineWaveform
                            peaks={peaks}
                            sourceStart={previewStart}
                            sourceEnd={previewEnd}
                            className="opacity-95"
                            testId="linked-video-waveform"
                        />
                    </div>
                )}
                <div
                    className="absolute inset-y-0 left-0 z-30 w-2 cursor-ew-resize border-l-2 border-transparent bg-sky-100/10 hover:border-sky-100 hover:bg-sky-100/35"
                    onPointerDown={(event) => beginTrim('start', event)}
                    aria-hidden="true"
                />
                <div className="pointer-events-none absolute inset-x-0 top-0 flex h-5 min-w-0 items-center gap-1.5 bg-slate-950/70 px-3">
                    {source.hasAudio
                        ? <Volume2 className="w-3 h-3 text-blue-100 flex-none" />
                        : <VolumeX className="w-3 h-3 text-gray-500 flex-none" />}
                    <span className="truncate text-[10px] font-semibold text-sky-50">{source.originalName}</span>
                </div>
                {clip.audio?.linkState === 'detached' && (
                    <div className="absolute bottom-1 left-3 flex items-center gap-1 rounded bg-gray-950/75 px-1.5 py-0.5 text-[9px] text-gray-300 pointer-events-none">
                        <Link2Off className="h-2.5 w-2.5" />
                        Audio separated
                    </div>
                )}
                <div
                    className="absolute inset-y-0 right-0 z-30 w-2 cursor-ew-resize border-r-2 border-transparent bg-sky-100/10 hover:border-sky-100 hover:bg-sky-100/35"
                    onPointerDown={(event) => beginTrim('end', event)}
                    aria-hidden="true"
                />
            </div>
            {menu && (
                <TimelineContextMenu
                    x={menu.x}
                    y={menu.y}
                    canSeparateAudio={canSeparateAudio}
                    onSeparateAudio={() => detachVideoClipAudio(clip.id)}
                    onDetectSceneCuts={() => onOpenCutDetection({
                        trackId,
                        clickedClipId: clip.id,
                        selectedClipIds: selectedClipIds.includes(clip.id)
                            ? [...selectedClipIds]
                            : [clip.id],
                        restoreFocusTo: clipRef.current,
                    })}
                    onClose={() => setMenu(null)}
                    restoreFocusTo={clipRef.current}
                />
            )}
        </>
    );
}

export function TimelineVideoTrack({
    track,
    peaksByMediaKey,
    selectedClipIds,
    onClipSelectionChange,
    onClearClipSelection,
    onOpenCutDetection,
    onDragPreviewChange,
}: TimelineVideoTrackProps) {
    const {
        pixelsPerSecond,
        zoomLevel,
        videoSources,
        videoClips,
        renderProfile,
    } = useTimelineStore(useShallow((state) => ({
        pixelsPerSecond: state.pixelsPerSecond,
        zoomLevel: state.zoomLevel,
        videoSources: state.videoSources,
        videoClips: state.videoClips,
        renderProfile: state.renderProfile,
    })));
    const trackRef = useRef<HTMLDivElement>(null);
    const [trackMenu, setTrackMenu] = useState<{ x: number; y: number } | null>(null);
    const placements = useMemo(
        () => buildClipPlacements(videoClips, renderProfile.fps),
        [renderProfile.fps, videoClips],
    );
    const sourcesById = useMemo(
        () => new Map(videoSources.map((source) => [source.id, source])),
        [videoSources],
    );
    const clipsById = useMemo(() => new Map(videoClips.map((clip) => [clip.id, clip])), [videoClips]);
    const scaledPixelsPerSecond = pixelsPerSecond * zoomLevel;

    return (
        <div
            ref={trackRef}
            tabIndex={-1}
            className="absolute inset-0"
            onClick={onClearClipSelection}
            onContextMenu={(event) => {
                if ((event.target as Element).closest('[data-testid="timeline-video-clip"]')) return;
                event.preventDefault();
                event.stopPropagation();
                setTrackMenu({ x: event.clientX, y: event.clientY });
            }}
        >
            {track.clipIds.length === 0 && (
                <div className="flex h-full items-center px-3 text-xs text-gray-500">
                    Empty video track
                </div>
            )}
            {placements.filter((placement) => track.clipIds.includes(placement.clip.id)).map((placement) => {
                const clip = clipsById.get(placement.clip.id);
                const source = clip ? sourcesById.get(clip.sourceId) : undefined;
                if (!clip || !source) return null;
                const peaks = peaksByMediaKey.get(getAudioMediaCacheKey({
                    kind: 'video-source-audio',
                    videoSourceId: source.id,
                }));
                return (
                    <ClipBlock
                        key={clip.id}
                        placement={placement}
                        clip={clip}
                        source={source}
                        trackId={track.id}
                        peaks={peaks}
                        pixelsPerSecond={scaledPixelsPerSecond}
                        selected={selectedClipIds.includes(clip.id)}
                        selectedClipIds={selectedClipIds}
                        onClipSelectionChange={onClipSelectionChange}
                        onOpenCutDetection={onOpenCutDetection}
                        onDragPreviewChange={onDragPreviewChange}
                    />
                );
            })}
            {trackMenu && (
                <TimelineContextMenu
                    x={trackMenu.x}
                    y={trackMenu.y}
                    onDetectSceneCuts={() => onOpenCutDetection({
                        trackId: track.id,
                        clickedClipId: null,
                        selectedClipIds: [...selectedClipIds],
                        restoreFocusTo: trackRef.current,
                    })}
                    onClose={() => setTrackMenu(null)}
                    restoreFocusTo={trackRef.current}
                    ariaLabel={`${track.name} video track actions`}
                />
            )}
        </div>
    );
}
