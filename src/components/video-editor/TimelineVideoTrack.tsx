'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Link2Off, Volume2, VolumeX } from 'lucide-react';
import type { VideoSourceAsset } from '@/types/video';
import type { TimelineVideoClip } from '@/stores/timeline-store';
import type { TimelineVideoTrack } from '@/stores/timeline-v4-compat';
import type { AudioMediaCacheKey } from '@/lib/media-asset-ref';
import type { WaveformPeaks } from '@/lib/video-waveform';
import { getAudioMediaCacheKey } from '@/lib/media-asset-ref';
import { useTimelineStore } from '@/stores/timeline-store';
import {
    buildVideoTrackPlacementsV4,
    type VideoClipPlacementV4,
} from '@/lib/video-placement-v4';
import {
    beginTimelineGesture,
    cancelTimelineGesture,
    finishTimelineGesture,
    updateTimelineGesture,
    type TimelineGestureState,
} from '@/lib/timeline-gesture';
import {
    getTimelineSnapThresholdFrames,
    snapTimelineSpan,
    type TimelineSnapPoint,
} from '@/lib/timeline-snap';
import { TimelineContextMenu } from './TimelineContextMenu';
import { TimelineWaveform } from './TimelineWaveform';
import { useShallow } from 'zustand/react/shallow';
import { useEditorTransactionCoordinator } from './EditorTransactionContext';
import {
    parseVideoTrackDropTarget,
    type VideoTrackDropTarget,
} from '@/lib/video-track-drop-target';
import type { VideoCutDetectionRequest } from '@/lib/video-cut/targets';
import { framesToSeconds, secondsToFrames } from '@/lib/render-profile';
import { timelineEditorialRuntime } from '@/stores/timeline-editorial-runtime';
import { useTextEditorCommands } from './text-editor/useTextEditorCommands';
import { usePlaybackStore } from '@/stores/playback-store';

export interface VideoTrackDragPreview {
    clipId: string;
    target: VideoTrackDropTarget | null;
    startFrame: number;
    invalid: boolean;
}

interface TimelineVideoTrackProps {
    track: TimelineVideoTrack;
    peaksByMediaKey: ReadonlyMap<AudioMediaCacheKey, WaveformPeaks>;
    selectedClipIds: readonly string[];
    onClipSelectionChange: (clipId: string, additive: boolean) => void;
    onClearClipSelection: () => void;
    onOpenCutDetection: (request: VideoCutDetectionRequest) => void;
    onDragPreviewChange: (preview: VideoTrackDragPreview | null) => void;
    snapPoints: readonly TimelineSnapPoint[];
}

interface ClipBlockProps {
    placement: VideoClipPlacementV4;
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
    snapPoints: readonly TimelineSnapPoint[];
    validatePlacement: (
        target: VideoTrackDropTarget,
        startFrame: number,
        durationFrames: number,
    ) => boolean;
}

interface TrimDraft {
    sourceStart: number;
    sourceEnd: number;
}

interface MoveDraft {
    target: VideoTrackDropTarget | null;
    startFrame: number;
    invalid: boolean;
}

function areTrimDraftsEqual(left: TrimDraft, right: TrimDraft) {
    return left.sourceStart === right.sourceStart && left.sourceEnd === right.sourceEnd;
}

function areMoveTargetsEqual(left: VideoTrackDropTarget | null, right: VideoTrackDropTarget | null) {
    if (left === null || right === null) return left === right;
    if (left.kind !== right.kind) return false;
    return left.kind === 'track'
        ? left.trackId === (right as Extract<VideoTrackDropTarget, { kind: 'track' }>).trackId
        : left.insertionIndex === (right as Extract<VideoTrackDropTarget, { kind: 'insertion' }>).insertionIndex;
}

function areMoveDraftsEqual(left: MoveDraft, right: MoveDraft) {
    return left.startFrame === right.startFrame && areMoveTargetsEqual(left.target, right.target);
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
    snapPoints,
    validatePlacement,
}: ClipBlockProps) {
    const transactionCoordinator = useEditorTransactionCoordinator();
    const { runNarrative } = useTextEditorCommands();
    const {
        projectFps,
        renderProfile,
        trimVideoClip,
        detachVideoClipAudio,
        moveVideoClip,
        moveVideoClipToNewTrackAtFrame,
        narrative,
        dependentLinks,
        videoTracks,
        standalonePendingCommandCount,
    } = useTimelineStore(useShallow((state) => ({
        projectFps: state.projectFps,
        renderProfile: state.renderProfile,
        trimVideoClip: state.trimVideoClip,
        detachVideoClipAudio: state.detachVideoClipAudio,
        moveVideoClip: state.moveVideoClip,
        moveVideoClipToNewTrackAtFrame: state.moveVideoClipToNewTrackAtFrame,
        narrative: state.narrative,
        dependentLinks: state.dependentLinks,
        videoTracks: state.videoTracks,
        standalonePendingCommandCount: state.standalonePendingCommandCount,
    })));
    const clipRef = useRef<HTMLDivElement>(null);
    const [trimPreview, setTrimPreview] = useState<TrimDraft | null>(null);
    const [movePreview, setMovePreview] = useState<MoveDraft | null>(null);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const activeLaneDragCancellationRef = useRef<(() => void) | null>(null);
    const suppressClickRef = useRef(false);
    const previewStart = trimPreview?.sourceStart ?? clip.sourceStart;
    const previewEnd = trimPreview?.sourceEnd ?? clip.sourceEnd;
    const previewDuration = previewEnd - previewStart;
    const visibleDuration = trimPreview
        ? previewDuration
        : framesToSeconds(placement.durationFrames, renderProfile.fps);
    const previewTimelineStartFrame = movePreview?.startFrame ?? placement.startFrame;
    const ownedBlock = Object.values(narrative?.blocks ?? {}).find((block) => block.clipId === clip.id);
    const canSeparateAudio = !ownedBlock && source.hasAudio && clip.audio?.linkState === 'linked';
    const dependentLink = dependentLinks.find((link) => (
        link.target.kind === 'video-clip' && link.target.clipId === clip.id
    ));
    const trackLocked = videoTracks.find((track) => track.id === trackId)?.locked ?? false;

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
        if (ownedBlock || trackLocked) {
            // Controlled occurrences retain their source-track identity and are reordered through
            // narrative commands. A locked ordinary lane likewise cannot publish a direct move.
            if (!event.metaKey && !event.ctrlKey) onClipSelectionChange(clip.id, false);
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const pointerId = event.pointerId;
        const origin = { x: event.clientX, y: event.clientY };
        const pointerOwner = event.currentTarget;
        const timeline = useTimelineStore.getState();
        const fps = renderProfile.fps.numerator / renderProfile.fps.denominator;
        const initial: MoveDraft = {
            target: { kind: 'track', trackId },
            startFrame: placement.startFrame,
            invalid: false,
        };
        const gestureSnapPoints = timeline.snapEnabled
            ? [
                ...snapPoints,
                {
                    frame: secondsToFrames(
                        usePlaybackStore.getState().currentTime,
                        renderProfile.fps,
                        'nearest',
                    ),
                    ownerKey: 'playhead',
                },
            ]
            : [];
        const snapThresholdFrames = getTimelineSnapThresholdFrames(
            pixelsPerSecond,
            renderProfile.fps,
        );
        const clipOwnerKey = `video:${clip.id}`;
        let gesture: TimelineGestureState<MoveDraft> = beginTimelineGesture(initial);
        let active = false;
        let terminal = false;
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
            timeline.setActiveSnapTime(null);
            onDragPreviewChange(null);
            setMovePreview(null);
        };
        const handleMove = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== pointerId) return;
            if (!active && Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < 5) return;
            if (!active) {
                active = true;
                suppressClickRef.current = true;
            }
            const deltaFrames = Math.round((moveEvent.clientX - origin.x) / pixelsPerSecond * fps);
            const rawStartFrame = Math.max(0, initial.startFrame + deltaFrames);
            const snapped = snapTimelineSpan(
                rawStartFrame,
                placement.durationFrames,
                gestureSnapPoints,
                snapThresholdFrames,
                clipOwnerKey,
            );
            const target = parseVideoTrackDropTarget(
                document.elementFromPoint(moveEvent.clientX, moveEvent.clientY),
            );
            const draft: MoveDraft = {
                target,
                startFrame: snapped.frame,
                invalid: target === null
                    || !validatePlacement(target, snapped.frame, placement.durationFrames),
            };
            gesture = updateTimelineGesture(gesture, draft);
            setMovePreview(draft);
            timeline.setActiveSnapTime(
                target && snapped.snappedFrame !== null
                    ? framesToSeconds(snapped.snappedFrame, renderProfile.fps)
                    : null,
            );
            onDragPreviewChange({
                clipId: clip.id,
                target,
                startFrame: draft.startFrame,
                invalid: draft.invalid,
            });
        };
        const finish = (commit: boolean) => {
            if (terminal) return;
            terminal = true;
            // Cancellation must discard the gesture instead of asking the shared gesture helper
            // to derive a commit that the caller later ignores. This keeps Escape, pointercancel,
            // lost capture, and editor-wide transaction cancellation on one rollback-only path.
            const finished = commit && active
                ? finishTimelineGesture(gesture, areMoveDraftsEqual)
                : { commit: null };
            cleanup();
            if (active) window.setTimeout(() => { suppressClickRef.current = false; }, 0);
            if (!commit || !finished.commit || finished.commit.invalid || !finished.commit.target) return;
            if (finished.commit.target.kind === 'track') {
                moveVideoClip(
                    clip.id,
                    finished.commit.target.trackId,
                    finished.commit.startFrame,
                );
            } else {
                moveVideoClipToNewTrackAtFrame(
                    clip.id,
                    finished.commit.target.insertionIndex,
                    finished.commit.startFrame,
                );
            }
        };
        const handleUp = (upEvent: PointerEvent) => {
            if (upEvent.pointerId === pointerId) finish(true);
        };
        const handleCancel = (cancelEvent?: PointerEvent) => {
            if (cancelEvent && cancelEvent.pointerId !== pointerId) return;
            cancelTimelineGesture<MoveDraft>();
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
        if (event.button !== 0 || trackLocked) return;
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
            if (!finished.commit) return;
            if (!ownedBlock) {
                trimVideoClip(clip.id, finished.commit.sourceStart, finished.commit.sourceEnd);
                return;
            }
            const requestedSample = Math.round(
                (side === 'start' ? finished.commit.sourceStart : finished.commit.sourceEnd) * 16_000,
            );
            const body = timelineEditorialRuntime.getResolvedBodies()[ownedBlock.transcriptRecordId];
            const retainedWordIds = new Set(ownedBlock.sourceWordIds);
            const wordBoundaries = ownedBlock.kind === 'speech'
                ? (body?.words ?? [])
                    .filter((word) => retainedWordIds.has(word.id))
                    .map((word) => side === 'start' ? word.editableStartSample : word.editableEndSample)
                    .filter((sample) => side === 'start'
                        ? sample >= ownedBlock.coreStartSample && sample < ownedBlock.coreEndSample
                        : sample > ownedBlock.coreStartSample && sample <= ownedBlock.coreEndSample)
                : [];
            const containedSample = Math.max(
                side === 'start' ? 0 : ownedBlock.coreStartSample + 1,
                Math.min(
                    body?.sampleCount ?? ownedBlock.coreEndSample,
                    side === 'start'
                        ? Math.min(requestedSample, ownedBlock.coreEndSample - 1)
                        : Math.max(requestedSample, ownedBlock.coreStartSample + 1),
                ),
            );
            const chosenSample = wordBoundaries.length > 0
                ? wordBoundaries.reduce((closest, sample) => (
                    Math.abs(sample - containedSample) < Math.abs(closest - containedSample)
                        ? sample
                        : closest
                ))
                : containedSample;
            void runNarrative({
                type: 'trim-block',
                blockId: ownedBlock.id,
                side,
                sample: chosenSample,
            }, { structural: true });
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
                data-dragging={movePreview || standalonePendingCommandCount > 0 ? 'true' : 'false'}
                data-drag-invalid={movePreview?.invalid ? 'true' : 'false'}
                data-preview-start-frame={previewTimelineStartFrame}
                className={`absolute bottom-1 top-1 touch-none select-none overflow-hidden rounded border transition-colors focus:outline-none focus:ring-2 focus:ring-sky-200 ${movePreview ? 'cursor-grabbing opacity-80' : 'cursor-grab'} ${movePreview?.invalid
                    ? 'z-30 border-red-300 bg-red-500/30 ring-1 ring-red-300/60'
                    : selected
                        ? 'z-20 border-sky-200 bg-sky-500/30 ring-1 ring-sky-200/60'
                        : 'z-10 border-sky-400/35 bg-sky-500/15 hover:border-sky-300/60 hover:bg-sky-500/20'
                    }`}
                style={{
                    left: framesToSeconds(previewTimelineStartFrame, renderProfile.fps) * pixelsPerSecond,
                    // Pointer movement stays as a local frame-domain draft until one terminal
                    // store command accepts the target lane and start frame together.
                    width: Math.max(2, visibleDuration * pixelsPerSecond),
                    willChange: movePreview ? 'left' : undefined,
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
                title={`${source.originalName} · ${previewStart.toFixed(2)}s–${previewEnd.toFixed(2)}s${ownedBlock ? ' · Controlled by Text' : dependentLink?.association.kind === 'transcript-bound' ? ' · Exact bound' : dependentLink ? ' · Overlap linked' : ''}${movePreview?.invalid ? ' · Invalid drop' : ''}`}
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
                    {ownedBlock && (
                        <span className="rounded bg-sky-500/25 px-1 text-[8px] text-sky-100">Controlled</span>
                    )}
                    {dependentLink?.association.kind === 'transcript-bound' && (
                        <span className="rounded bg-violet-500/25 px-1 text-[8px] text-violet-100"><Link2 className="inline h-2 w-2" /> Exact</span>
                    )}
                    {dependentLink?.association.kind === 'overlap' && (
                        <span className="rounded bg-teal-500/25 px-1 text-[8px] text-teal-100"><Link2 className="inline h-2 w-2" /> Overlap</span>
                    )}
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
    snapPoints,
}: TimelineVideoTrackProps) {
    const {
        pixelsPerSecond,
        zoomLevel,
        videoSources,
        revision,
    } = useTimelineStore(useShallow((state) => ({
        pixelsPerSecond: state.pixelsPerSecond,
        zoomLevel: state.zoomLevel,
        videoSources: state.videoSources,
        revision: state.revision,
    })));
    const trackRef = useRef<HTMLDivElement>(null);
    const [trackMenu, setTrackMenu] = useState<{ x: number; y: number } | null>(null);
    const document = useMemo(
        () => {
            if (!Number.isSafeInteger(revision)) throw new Error('Timeline revision must be a safe integer.');
            return useTimelineStore.getState().buildEditorDocumentV4();
        },
        [revision],
    );
    const placementTracks = useMemo(() => buildVideoTrackPlacementsV4(document), [document]);
    const placements = placementTracks.find((entry) => entry.track.id === track.id)?.placements ?? [];
    const sourcesById = useMemo(
        () => new Map(videoSources.map((source) => [source.id, source])),
        [videoSources],
    );
    const scaledPixelsPerSecond = pixelsPerSecond * zoomLevel;
    const validatePlacement = (
        movingClipId: string,
        target: VideoTrackDropTarget,
        startFrame: number,
        durationFrames: number,
    ) => {
        if (!Number.isSafeInteger(startFrame) || startFrame < 0) return false;
        if (target.kind === 'insertion') {
            return target.insertionIndex >= 0 && target.insertionIndex <= document.videoTracks.length;
        }
        const targetTrack = document.videoTracks.find((candidate) => candidate.id === target.trackId);
        if (!targetTrack || targetTrack.locked) return false;
        const endFrame = startFrame + durationFrames;
        if (!Number.isSafeInteger(durationFrames) || durationFrames <= 0 || !Number.isSafeInteger(endFrame)) {
            return false;
        }
        return placementTracks
            .find((entry) => entry.track.id === target.trackId)
            ?.placements.every((candidate) => (
                candidate.clip.id === movingClipId
                || endFrame <= candidate.startFrame
                || startFrame >= candidate.endFrame
            )) ?? true;
    };

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
            {placements.map((placement) => {
                const clip = placement.clip;
                const source = sourcesById.get(clip.sourceId);
                if (!source) return null;
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
                        snapPoints={snapPoints}
                        validatePlacement={(target, startFrame, durationFrames) => (
                            validatePlacement(clip.id, target, startFrame, durationFrames)
                        )}
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
