'use client';

import { useMemo, useRef, useState } from 'react';
import { Link2Off, Volume2, VolumeX } from 'lucide-react';
import type { ClipPlacement, VideoSourceAsset } from '@/types/video';
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

interface TimelineVideoTrackProps {
    peaksByMediaKey: ReadonlyMap<AudioMediaCacheKey, WaveformPeaks>;
}

interface ClipBlockProps {
    placement: ClipPlacement;
    clip: TimelineVideoClip;
    source: VideoSourceAsset;
    peaks?: WaveformPeaks;
    pixelsPerSecond: number;
    selected: boolean;
}

interface TrimDraft {
    sourceStart: number;
    sourceEnd: number;
}

function areTrimDraftsEqual(left: TrimDraft, right: TrimDraft) {
    return left.sourceStart === right.sourceStart && left.sourceEnd === right.sourceEnd;
}

function ClipBlock({ placement, clip, source, peaks, pixelsPerSecond, selected }: ClipBlockProps) {
    const transactionCoordinator = useEditorTransactionCoordinator();
    const { projectFps, selectClip, trimVideoClip, detachVideoClipAudio } = useTimelineStore(useShallow((state) => ({
        projectFps: state.projectFps,
        selectClip: state.selectClip,
        trimVideoClip: state.trimVideoClip,
        detachVideoClipAudio: state.detachVideoClipAudio,
    })));
    const clipRef = useRef<HTMLDivElement>(null);
    const [trimPreview, setTrimPreview] = useState<TrimDraft | null>(null);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const previewStart = trimPreview?.sourceStart ?? clip.sourceStart;
    const previewEnd = trimPreview?.sourceEnd ?? clip.sourceEnd;
    const previewDuration = previewEnd - previewStart;
    const visibleDuration = trimPreview ? previewDuration : placement.duration;
    const canSeparateAudio = source.hasAudio && clip.audio?.linkState === 'linked';

    const openContextMenu = (x: number, y: number) => {
        selectClip(clip.id);
        setMenu({ x, y });
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
                className={`absolute top-1 bottom-1 rounded border overflow-hidden cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-blue-200 ${selected
                    ? 'bg-blue-500/35 border-blue-300 ring-1 ring-blue-300/50 z-20'
                    : 'bg-blue-500/15 border-blue-400/30 hover:bg-blue-500/25 z-10'
                    }`}
                style={{
                    left: placement.projectStart * pixelsPerSecond,
                    // Persisted geometry uses the canonical frame-domain placement. Raw seconds
                    // are used only while previewing an uncommitted pointer trim.
                    width: Math.max(2, visibleDuration * pixelsPerSecond),
                }}
                onClick={(event) => {
                    event.stopPropagation();
                    selectClip(clip.id);
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openContextMenu(event.clientX, event.clientY);
                }}
                onKeyDown={(event) => {
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openContextMenu(rect.left + Math.min(rect.width, 24), rect.top + Math.min(rect.height, 24));
                }}
                aria-label={`${source.originalName}, video clip from ${previewStart.toFixed(2)} to ${previewEnd.toFixed(2)} seconds`}
                title={`${source.originalName} · ${previewStart.toFixed(2)}s–${previewEnd.toFixed(2)}s`}
            >
                {canSeparateAudio && (
                    <div className="absolute inset-x-0 bottom-0 h-1/2 overflow-hidden border-t border-blue-200/15 bg-blue-950/35">
                        <TimelineWaveform
                            peaks={peaks}
                            sourceStart={previewStart}
                            sourceEnd={previewEnd}
                            className="opacity-90"
                            testId="linked-video-waveform"
                        />
                    </div>
                )}
                <div
                    className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-blue-200/20 hover:bg-blue-200/60 z-30"
                    onPointerDown={(event) => beginTrim('start', event)}
                    aria-hidden="true"
                />
                <div className="absolute inset-0 flex items-start gap-1.5 px-3 pt-1 pointer-events-none min-w-0 bg-gradient-to-b from-gray-950/65 via-transparent to-transparent">
                    {source.hasAudio
                        ? <Volume2 className="w-3 h-3 text-blue-100 flex-none" />
                        : <VolumeX className="w-3 h-3 text-gray-500 flex-none" />}
                    <span className="text-[10px] font-semibold text-blue-50 truncate drop-shadow">{source.originalName}</span>
                </div>
                {clip.audio?.linkState === 'detached' && (
                    <div className="absolute bottom-1 left-3 flex items-center gap-1 rounded bg-gray-950/75 px-1.5 py-0.5 text-[9px] text-gray-300 pointer-events-none">
                        <Link2Off className="h-2.5 w-2.5" />
                        Audio separated
                    </div>
                )}
                <div
                    className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-blue-200/20 hover:bg-blue-200/60 z-30"
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
                    onClose={() => setMenu(null)}
                    restoreFocusTo={clipRef.current}
                />
            )}
        </>
    );
}

export function TimelineVideoTrack({ peaksByMediaKey }: TimelineVideoTrackProps) {
    const {
        pixelsPerSecond,
        zoomLevel,
        videoSources,
        videoClips,
        renderProfile,
        selectedClipId,
        selectClip,
    } = useTimelineStore(useShallow((state) => ({
        pixelsPerSecond: state.pixelsPerSecond,
        zoomLevel: state.zoomLevel,
        videoSources: state.videoSources,
        videoClips: state.videoClips,
        renderProfile: state.renderProfile,
        selectedClipId: state.selectedClipId,
        selectClip: state.selectClip,
    })));
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
        <div className="absolute inset-0" onClick={() => selectClip(null)}>
            {videoClips.length === 0 && (
                <div className="flex h-full items-center px-3 text-xs text-gray-500">
                    No video clips. Audio playback is still available.
                </div>
            )}
            {placements.map((placement) => {
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
                        peaks={peaks}
                        pixelsPerSecond={scaledPixelsPerSecond}
                        selected={selectedClipId === clip.id}
                    />
                );
            })}
        </div>
    );
}
