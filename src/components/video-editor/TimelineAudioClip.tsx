'use client';

import { useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import type { AudioClip, RationalFrameRate } from '@/types/video';
import type { WaveformPeaks } from '@/lib/video-waveform';
import { framesToSeconds, secondsToFrames } from '@/lib/render-profile';
import { useTimelineStore } from '@/stores/timeline-store';
import { usePlaybackStore } from '@/stores/playback-store';
import {
    getTimelineSnapThresholdFrames,
    snapTimelineFrame,
    snapTimelineVariableSpan,
    type TimelineSnapPoint,
} from '@/lib/timeline-snap';
import {
    beginTimelineGesture,
    cancelTimelineGesture,
    commitTimelineKeyboardEdit,
    finishTimelineGesture,
    updateTimelineGesture,
    type TimelineGestureState,
} from '@/lib/timeline-gesture';
import { TimelineWaveform } from './TimelineWaveform';
import { useShallow } from 'zustand/react/shallow';
import { useEditorTransactionCoordinator } from './EditorTransactionContext';

export interface AudioClipDraft {
    trackId: string;
    startFrame: number;
    endFrame: number;
    invalid: boolean;
}

interface TimelineAudioClipProps {
    clip: AudioClip;
    trackId: string;
    trackLocked: boolean;
    durationFrames: number;
    pixelsPerSecond: number;
    frameRate: RationalFrameRate;
    sourceName: string;
    waveformSourceStart: number;
    waveformSourceEnd: number;
    peaks?: WaveformPeaks;
    selected: boolean;
    snapPoints: readonly TimelineSnapPoint[];
    resolveDurationFrames: (candidateStartFrame: number) => number;
    validatePlacement: (clipId: string, trackId: string, startFrame: number, durationFrames: number) => boolean;
}

function areDraftsEqual(left: AudioClipDraft, right: AudioClipDraft) {
    return left.trackId === right.trackId
        && left.startFrame === right.startFrame
        && left.endFrame === right.endFrame;
}

export function TimelineAudioClip({
    clip,
    trackId,
    trackLocked,
    durationFrames,
    pixelsPerSecond,
    frameRate,
    sourceName,
    waveformSourceStart,
    waveformSourceEnd,
    peaks,
    selected,
    snapPoints,
    resolveDurationFrames,
    validatePlacement,
}: TimelineAudioClipProps) {
    const transactionCoordinator = useEditorTransactionCoordinator();
    const { selectAudioClip, moveAudioClip, trimAudioClip } = useTimelineStore(useShallow((state) => ({
        selectAudioClip: state.selectAudioClip,
        moveAudioClip: state.moveAudioClip,
        trimAudioClip: state.trimAudioClip,
    })));
    const clipRef = useRef<HTMLDivElement>(null);
    const [draft, setDraft] = useState<AudioClipDraft | null>(null);
    const fps = frameRate.numerator / frameRate.denominator;
    const previewStartFrame = draft?.startFrame ?? clip.timelineStartFrame;
    const previewEndFrame = draft?.endFrame ?? clip.timelineStartFrame + durationFrames;
    const previewDurationFrames = Math.max(1, previewEndFrame - previewStartFrame);
    const left = framesToSeconds(previewStartFrame, frameRate) * pixelsPerSecond;
    const width = framesToSeconds(previewDurationFrames, frameRate) * pixelsPerSecond;
    const sourceDuration = waveformSourceEnd - waveformSourceStart;
    const previewWaveformStart = waveformSourceStart
        + sourceDuration * Math.max(0, previewStartFrame - clip.timelineStartFrame) / durationFrames;
    const previewWaveformEnd = waveformSourceEnd
        - sourceDuration * Math.max(0, clip.timelineStartFrame + durationFrames - previewEndFrame) / durationFrames;

    const runPointerGesture = (
        event: React.PointerEvent,
        kind: 'move' | 'trim-left' | 'trim-right',
    ) => {
        if (trackLocked || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        selectAudioClip(trackId, clip.id);

        const startClientX = event.clientX;
        const clipOwnerKey = `audio:${clip.id}`;
        const timeline = useTimelineStore.getState();
        const gestureSnapPoints = timeline.snapEnabled
            ? [
                ...snapPoints,
                {
                    frame: secondsToFrames(
                        usePlaybackStore.getState().currentTime,
                        frameRate,
                        'nearest',
                    ),
                    ownerKey: 'playhead',
                },
            ]
            : [];
        const snapThresholdFrames = getTimelineSnapThresholdFrames(pixelsPerSecond, frameRate);
        const publishSnapPreview = (snappedFrame: number | null) => {
            timeline.setActiveSnapTime(snappedFrame === null ? null : framesToSeconds(snappedFrame, frameRate));
        };
        const initial: AudioClipDraft = {
            trackId,
            startFrame: clip.timelineStartFrame,
            endFrame: clip.timelineStartFrame + durationFrames,
            invalid: false,
        };
        let gesture: TimelineGestureState<AudioClipDraft> = beginTimelineGesture(initial);
        let terminal = false;
        let unregisterCancellation: () => void = () => undefined;

        const cleanup = () => {
            unregisterCancellation();
            window.removeEventListener('pointermove', handleMove);
            window.removeEventListener('pointerup', handleUp);
            window.removeEventListener('pointercancel', handleCancel);
            window.removeEventListener('keydown', handleKeyDown);
            publishSnapPreview(null);
        };
        const handleMove = (moveEvent: PointerEvent) => {
            const deltaFrames = Math.round((moveEvent.clientX - startClientX) / pixelsPerSecond * fps);
            let next: AudioClipDraft;
            if (kind === 'trim-left') {
                const rawStart = Math.max(
                    initial.startFrame,
                    Math.min(initial.endFrame - 1, initial.startFrame + deltaFrames),
                );
                const trimPoints = gestureSnapPoints.filter((point) => (
                    point.frame >= initial.startFrame && point.frame < initial.endFrame
                ));
                const snapped = snapTimelineFrame(
                    rawStart,
                    trimPoints,
                    snapThresholdFrames,
                    clipOwnerKey,
                );
                const nextStart = snapped.frame;
                publishSnapPreview(snapped.snappedFrame);
                const nextDuration = initial.endFrame - nextStart;
                next = {
                    ...initial,
                    startFrame: nextStart,
                    invalid: !validatePlacement(clip.id, trackId, nextStart, nextDuration),
                };
            } else if (kind === 'trim-right') {
                const rawEnd = Math.max(
                    initial.startFrame + 1,
                    Math.min(initial.endFrame, initial.endFrame + deltaFrames),
                );
                const trimPoints = gestureSnapPoints.filter((point) => (
                    point.frame > initial.startFrame && point.frame <= initial.endFrame
                ));
                const snapped = snapTimelineFrame(
                    rawEnd,
                    trimPoints,
                    snapThresholdFrames,
                    clipOwnerKey,
                );
                const nextEnd = snapped.frame;
                publishSnapPreview(snapped.snappedFrame);
                const nextDuration = nextEnd - initial.startFrame;
                next = {
                    ...initial,
                    endFrame: nextEnd,
                    invalid: !validatePlacement(clip.id, trackId, initial.startFrame, nextDuration),
                };
            } else {
                const hoveredTrack = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)
                    ?.closest<HTMLElement>('[data-audio-track-id]')?.dataset.audioTrackId;
                const nextTrackId = hoveredTrack ?? initial.trackId;
                const rawStart = Math.max(0, initial.startFrame + deltaFrames);
                const snapped = snapTimelineVariableSpan(
                    rawStart,
                    resolveDurationFrames,
                    gestureSnapPoints,
                    snapThresholdFrames,
                    clipOwnerKey,
                );
                const nextStart = snapped.frame;
                const nextDuration = resolveDurationFrames(nextStart);
                publishSnapPreview(snapped.snappedFrame);
                next = {
                    trackId: nextTrackId,
                    startFrame: nextStart,
                    endFrame: nextStart + nextDuration,
                    invalid: !validatePlacement(clip.id, nextTrackId, nextStart, nextDuration),
                };
            }
            gesture = updateTimelineGesture(gesture, next);
            setDraft(next);
        };
        const handleUp = () => {
            if (terminal) return;
            terminal = true;
            cleanup();
            setDraft(null);
            const finished = finishTimelineGesture(gesture, areDraftsEqual);
            if (!finished.commit || finished.commit.invalid) return;
            if (kind === 'move') {
                moveAudioClip(clip.id, finished.commit.trackId, finished.commit.startFrame);
            } else {
                trimAudioClip(
                    clip.id,
                    kind === 'trim-left' ? 'left' : 'right',
                    kind === 'trim-left' ? finished.commit.startFrame : finished.commit.endFrame,
                );
            }
        };
        const handleCancel = () => {
            if (terminal) return;
            terminal = true;
            cleanup();
            cancelTimelineGesture<AudioClipDraft>();
            setDraft(null);
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
        <div
            ref={clipRef}
            tabIndex={0}
            role="button"
            data-testid="timeline-audio-clip"
            aria-disabled={trackLocked}
            aria-label={`${sourceName}, audio clip`}
            title={`${sourceName} · ${framesToSeconds(previewStartFrame, frameRate).toFixed(2)}s`}
            className={`absolute bottom-1 top-1 overflow-hidden rounded border focus:outline-none focus:ring-2 focus:ring-teal-200 ${
                draft?.invalid
                    ? 'border-red-400 bg-red-500/25'
                    : selected
                        ? 'border-teal-200 bg-teal-500/30 ring-1 ring-teal-200/50'
                        : 'border-teal-400/35 bg-teal-500/15 hover:border-teal-300/60 hover:bg-teal-500/20'
            } ${trackLocked ? 'cursor-not-allowed opacity-65' : 'cursor-grab active:cursor-grabbing'}`}
            style={{ left, width: Math.max(2, width) }}
            onPointerDown={(event) => runPointerGesture(event, 'move')}
            onClick={(event) => {
                event.stopPropagation();
                selectAudioClip(trackId, clip.id);
            }}
            onKeyDown={(event) => {
                if (trackLocked || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
                event.preventDefault();
                event.stopPropagation();
                const delta = event.key === 'ArrowLeft' ? -1 : 1;
                const nextFrame = Math.max(0, clip.timelineStartFrame + delta);
                const terminalFrame = commitTimelineKeyboardEdit(clip.timelineStartFrame, nextFrame);
                const terminalDuration = terminalFrame === null ? null : resolveDurationFrames(terminalFrame);
                if (terminalFrame !== null && terminalDuration !== null
                    && validatePlacement(clip.id, trackId, terminalFrame, terminalDuration)) {
                    moveAudioClip(clip.id, trackId, terminalFrame);
                }
            }}
        >
            <TimelineWaveform
                peaks={peaks}
                sourceStart={previewWaveformStart}
                sourceEnd={previewWaveformEnd}
                color="#5eead4"
                className="opacity-80"
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 flex h-5 items-center gap-1 bg-slate-950/70 px-3">
                {clip.muted
                    ? <VolumeX className="h-3 w-3 flex-none text-gray-400" />
                    : <Volume2 className="h-3 w-3 flex-none text-teal-100" />}
                <span className="truncate text-[10px] font-semibold text-teal-50">{sourceName}</span>
            </div>
            <div
                data-testid="audio-trim-left"
                className="absolute inset-y-0 left-0 z-20 w-2 cursor-ew-resize border-l-2 border-transparent bg-teal-100/10 hover:border-teal-100 hover:bg-teal-100/35"
                onPointerDown={(event) => runPointerGesture(event, 'trim-left')}
                aria-hidden="true"
            />
            <div
                data-testid="audio-trim-right"
                className="absolute inset-y-0 right-0 z-20 w-2 cursor-ew-resize border-r-2 border-transparent bg-teal-100/10 hover:border-teal-100 hover:bg-teal-100/35"
                onPointerDown={(event) => runPointerGesture(event, 'trim-right')}
                aria-hidden="true"
            />
        </div>
    );
}
