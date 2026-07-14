'use client';

import { useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import type { AudioClip, RationalFrameRate } from '@/types/video';
import type { WaveformPeaks } from '@/lib/video-waveform';
import { framesToSeconds } from '@/lib/render-profile';
import { useTimelineStore } from '@/stores/timeline-store';
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
        };
        const handleMove = (moveEvent: PointerEvent) => {
            const deltaFrames = Math.round((moveEvent.clientX - startClientX) / pixelsPerSecond * fps);
            let next: AudioClipDraft;
            if (kind === 'trim-left') {
                const nextStart = Math.max(
                    initial.startFrame,
                    Math.min(initial.endFrame - 1, initial.startFrame + deltaFrames),
                );
                const nextDuration = initial.endFrame - nextStart;
                next = {
                    ...initial,
                    startFrame: nextStart,
                    invalid: !validatePlacement(clip.id, trackId, nextStart, nextDuration),
                };
            } else if (kind === 'trim-right') {
                const nextEnd = Math.max(
                    initial.startFrame + 1,
                    Math.min(initial.endFrame, initial.endFrame + deltaFrames),
                );
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
                const nextStart = Math.max(0, initial.startFrame + deltaFrames);
                next = {
                    trackId: nextTrackId,
                    startFrame: nextStart,
                    endFrame: nextStart + durationFrames,
                    invalid: !validatePlacement(clip.id, nextTrackId, nextStart, durationFrames),
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
            className={`absolute top-1 bottom-1 overflow-hidden rounded border focus:outline-none focus:ring-2 focus:ring-emerald-200 ${
                draft?.invalid
                    ? 'border-red-400 bg-red-500/25'
                    : selected
                        ? 'border-emerald-200 bg-emerald-500/30 ring-1 ring-emerald-200/50'
                        : 'border-emerald-400/35 bg-emerald-500/15 hover:bg-emerald-500/25'
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
                if (terminalFrame !== null && validatePlacement(clip.id, trackId, terminalFrame, durationFrames)) {
                    moveAudioClip(clip.id, trackId, terminalFrame);
                }
            }}
        >
            <TimelineWaveform
                peaks={peaks}
                sourceStart={previewWaveformStart}
                sourceEnd={previewWaveformEnd}
                color="#6ee7b7"
                className="opacity-65"
            />
            <div className="absolute inset-x-0 top-0 flex items-center gap-1 bg-gradient-to-b from-gray-950/80 to-transparent px-3 pt-1 pointer-events-none">
                {clip.muted
                    ? <VolumeX className="h-3 w-3 flex-none text-gray-400" />
                    : <Volume2 className="h-3 w-3 flex-none text-emerald-100" />}
                <span className="truncate text-[10px] font-semibold text-emerald-50 drop-shadow">{sourceName}</span>
            </div>
            <div
                data-testid="audio-trim-left"
                className="absolute inset-y-0 left-0 z-20 w-2 cursor-ew-resize bg-emerald-100/15 hover:bg-emerald-100/60"
                onPointerDown={(event) => runPointerGesture(event, 'trim-left')}
                aria-hidden="true"
            />
            <div
                data-testid="audio-trim-right"
                className="absolute inset-y-0 right-0 z-20 w-2 cursor-ew-resize bg-emerald-100/15 hover:bg-emerald-100/60"
                onPointerDown={(event) => runPointerGesture(event, 'trim-right')}
                aria-hidden="true"
            />
        </div>
    );
}
