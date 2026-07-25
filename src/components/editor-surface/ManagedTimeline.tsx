'use client';

import {
  Captions,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Film,
  Link2Off,
  Lock,
  Music2,
  Plus,
  Scissors,
  Trash2,
  Unlock,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type {
  EditorUiClip,
  EditorUiAudioSourceRange,
  EditorUiController,
  EditorUiDurableCommand,
  EditorUiSnapshot,
  EditorUiTrack,
  EditorUiTrackKind,
} from '@/lib/editor-ui';
import {
  secondsToOutputSample,
  secondsToProjectFrame,
  clampEditorUiClipTrimTime,
} from '@/lib/editor-ui';
import { useEditorSurfaceHost, useEditorUiSnapshot } from './EditorSurfaceProvider';

const TRACK_HEADER_WIDTH = 176;
const MIN_TRACK_HEIGHT = 52;
const MAX_TRACK_HEIGHT = 220;

const trackIcon = (kind: EditorUiTrackKind) => {
  if (kind === 'video') return Film;
  if (kind === 'audio') return Music2;
  return Captions;
};

const optimisticMove = (
  snapshot: EditorUiSnapshot,
  clipIds: string[],
  trackId: string,
  startSeconds: number,
): EditorUiSnapshot => {
  const moving = snapshot.project.tracks.flatMap((track) => (
    track.clips.filter((clip) => clipIds.includes(clip.id))
  ));
  const earliest = Math.min(...moving.map((clip) => clip.startSeconds));
  const movedById = new Map(moving.map((clip) => [
    clip.id,
    { ...clip, trackId, startSeconds: Math.max(0, startSeconds + clip.startSeconds - earliest) },
  ]));
  return {
    ...snapshot,
    project: {
      ...snapshot.project,
      tracks: snapshot.project.tracks.map((track) => ({
        ...track,
        clips: [
          ...track.clips.filter((clip) => !movedById.has(clip.id)),
          ...(track.id === trackId ? Array.from(movedById.values()) : []),
        ].sort((left, right) => left.startSeconds - right.startSeconds),
      })),
    },
  };
};

const optimisticTrim = (
  snapshot: EditorUiSnapshot,
  clipId: string,
  edge: 'start' | 'end',
  timeSeconds: number,
): EditorUiSnapshot => ({
  ...snapshot,
  project: {
    ...snapshot.project,
    tracks: snapshot.project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        if (clip.id !== clipId) return clip;
        const end = clip.startSeconds + clip.durationSeconds;
        const clampedTime = clampEditorUiClipTrimTime(clip, edge, timeSeconds);
        if (edge === 'start') {
          return {
            ...clip,
            startSeconds: clampedTime,
            sourceOffsetSeconds: clip.sourceOffsetSeconds + clampedTime - clip.startSeconds,
            durationSeconds: end - clampedTime,
          };
        }
        return {
          ...clip,
          durationSeconds: clampedTime - clip.startSeconds,
        };
      }),
    })),
  },
});

export function ManagedTimeline() {
  const snapshot = useEditorUiSnapshot();
  const { controller } = useEditorSurfaceHost();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const viewSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleViewSync = (patch: Extract<
    Parameters<EditorUiController['dispatch']>[0],
    { type: 'view.update' }
  >['patch']) => {
    if (viewSyncTimer.current) clearTimeout(viewSyncTimer.current);
    viewSyncTimer.current = setTimeout(() => {
      viewSyncTimer.current = null;
      void controller.dispatch({ type: 'view.update', patch });
    }, 120);
  };
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller && Math.abs(scroller.scrollLeft - snapshot.view.scrollLeft) > 0.5) {
      scroller.scrollLeft = snapshot.view.scrollLeft;
    }
  }, [snapshot.view.scrollLeft]);
  useEffect(() => () => {
    if (viewSyncTimer.current) clearTimeout(viewSyncTimer.current);
  }, []);
  const pixelsPerSecond = Math.max(24, 72 * snapshot.view.zoom);
  const timelineWidth = Math.max(
    720,
    Math.ceil((snapshot.project.durationSeconds + 10) * pixelsPerSecond),
  );
  const selected = useMemo(
    () => new Set(snapshot.view.selectedIds),
    [snapshot.view.selectedIds],
  );
  const selectedClips = useMemo(() => snapshot.project.tracks.flatMap((track) => (
    track.clips.filter((clip) => selected.has(clip.id))
  )), [selected, snapshot.project.tracks]);
  const firstAudioTrackId = snapshot.project.tracks.find((track) => track.kind === 'audio')?.id;

  const addTrack = (kind: EditorUiTrackKind) => {
    void controller.dispatch({ type: 'track.add', kind });
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>, track: EditorUiTrack) => {
    event.preventDefault();
    let clipIds: string[] = [];
    try {
      const transferValue = JSON.parse(
        event.dataTransfer.getData('application/x-waptions-clips') || '[]',
      ) as unknown;
      if (Array.isArray(transferValue)) {
        clipIds = transferValue.filter((id): id is string => typeof id === 'string');
      }
    } catch {
      return;
    }
    if (clipIds.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const startSeconds = Math.max(
      0,
      (
        event.clientX
        - rect.left
        - TRACK_HEADER_WIDTH
        + (scrollerRef.current?.scrollLeft ?? 0)
      ) / pixelsPerSecond,
    );
    const movingClips = snapshot.project.tracks.flatMap((candidate) => candidate.clips)
      .filter((clip) => clipIds.includes(clip.id) && clip.kind === track.kind);
    if (movingClips.length === 0) return;
    const earliestStart = Math.min(...movingClips.map((clip) => clip.startSeconds));
    const movingIds = movingClips.map((clip) => clip.id);
    const commands: EditorUiDurableCommand[] = movingClips.flatMap(
      (clip): EditorUiDurableCommand[] => {
        const clipId = clip.id;
        const targetSeconds = Math.max(
          0,
          startSeconds + clip.startSeconds - earliestStart,
        );
        if (clip.kind === 'video') {
          const timelineFrame = secondsToProjectFrame(targetSeconds, snapshot.project.fps);
          return [{ type: 'video-clip.move', clipId, trackId: track.id, timelineFrame }];
        } else if (clip.kind === 'audio') {
          return [{
            type: 'audio-clip.move',
            clipId,
            trackId: track.id,
            timelineFrame: secondsToProjectFrame(targetSeconds, snapshot.project.fps),
          }];
        } else if (clip.kind === 'subtitle') {
          return [{
            type: 'subtitle.move',
            trackId: clip.trackId,
            targetTrackId: track.id,
            subtitleId: clip.id,
            startOutputSample: secondsToOutputSample(targetSeconds),
            endOutputSample: secondsToOutputSample(targetSeconds + clip.durationSeconds),
            text: clip.text ?? clip.label,
          }];
        }
        return [];
      },
    );
    if (commands.length === 0) return;
    void controller.dispatch({
      type: 'edit.batch',
      commands,
      history: {
        label: movingClips.length === 1 ? 'Move clip' : `Move ${movingClips.length} clips`,
        category: 'timeline.move',
      },
    }, {
      optimistic: (current) => optimisticMove(current, movingIds, track.id, startSeconds),
    });
  };
  const resizeTrack = (event: PointerEvent<HTMLDivElement>, track: EditorUiTrack) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = snapshot.view.trackHeights[track.id] ?? track.height;
    let finalHeight = startHeight;
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      finalHeight = Math.min(
        MAX_TRACK_HEIGHT,
        Math.max(MIN_TRACK_HEIGHT, startHeight + moveEvent.clientY - startY),
      );
      controller.updateView({
        focusedTrackId: track.id,
        trackHeights: {
          ...controller.getSnapshot().view.trackHeights,
          [track.id]: finalHeight,
        },
      });
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', commitResize);
      window.removeEventListener('pointercancel', cancelResize);
      if (commit) {
        void controller.dispatch({
          type: 'view.set-track-height',
          trackId: track.id,
          height: finalHeight,
        });
      } else {
        controller.updateView({
          trackHeights: {
            ...controller.getSnapshot().view.trackHeights,
            [track.id]: startHeight,
          },
        });
      }
    };
    const commitResize = () => finish(true);
    const cancelResize = () => finish(false);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', commitResize, { once: true });
    window.addEventListener('pointercancel', cancelResize, { once: true });
  };

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-950"
      aria-label="Timeline editor"
      data-testid="managed-editor-timeline"
    >
      <div className="flex h-9 flex-none items-center gap-1 border-b border-slate-800 px-2">
        <div className="flex items-center gap-1" role="group" aria-label="Add track">
          <TrackAction icon={Film} label="Add video track" onClick={() => addTrack('video')} />
          <TrackAction icon={Music2} label="Add audio track" onClick={() => addTrack('audio')} />
          <TrackAction icon={Captions} label="Add subtitle track" onClick={() => addTrack('subtitle')} />
        </div>
        <div className="mx-1 h-4 w-px bg-slate-800" />
        <TrackAction
          icon={Scissors}
          label="Split selected clips at playhead"
          disabled={selectedClips.length === 0}
          onClick={() => {
            const commands: EditorUiDurableCommand[] = selectedClips.flatMap(
              (clip): EditorUiDurableCommand[] => {
              if (snapshot.view.playheadSeconds > clip.startSeconds
                && snapshot.view.playheadSeconds < clip.startSeconds + clip.durationSeconds) {
                const timelineFrame = secondsToProjectFrame(
                  snapshot.view.playheadSeconds,
                  snapshot.project.fps,
                );
                if (clip.kind === 'video') {
                  return [{ type: 'video-clip.split', clipId: clip.id, timelineFrame }];
                } else if (clip.kind === 'audio') {
                  return [{
                    type: 'audio-clip.split',
                    clipId: clip.id,
                    timelineOutputSample: secondsToOutputSample(snapshot.view.playheadSeconds),
                  }];
                } else if (clip.kind === 'subtitle') {
                  return [{
                    type: 'subtitle.split',
                    trackId: clip.trackId,
                    subtitleId: clip.id,
                    outputSample: secondsToOutputSample(snapshot.view.playheadSeconds),
                  }];
                }
              }
              return [];
              },
            );
            if (commands.length > 0) {
              void controller.dispatch({
                type: 'edit.batch',
                commands,
                history: {
                  label: commands.length === 1 ? 'Split clip' : `Split ${commands.length} clips`,
                  category: 'timeline.split',
                },
              });
            }
          }}
        />
        <TrackAction
          icon={Link2Off}
          label="Detach audio from selected video"
          disabled={!firstAudioTrackId
            || !selectedClips.some((clip) => clip.kind === 'video' && clip.hasLinkedAudio)}
          onClick={() => {
            if (!firstAudioTrackId) return;
            const commands: EditorUiDurableCommand[] = selectedClips.flatMap(
              (clip): EditorUiDurableCommand[] => (
              clip.kind === 'video' && clip.hasLinkedAudio
                ? [{
                  type: 'video-clip.detach-audio',
                  clipId: clip.id,
                  audioTrackId: firstAudioTrackId,
                }]
                : []
              ),
            );
            if (commands.length > 0) {
              void controller.dispatch({
                type: 'edit.batch',
                commands,
                history: {
                  label: commands.length === 1
                    ? 'Detach clip audio'
                    : `Detach audio from ${commands.length} clips`,
                  category: 'audio.detach',
                },
              });
            }
          }}
        />
        <TrackAction
          icon={Trash2}
          label="Delete selected clips"
          disabled={selectedClips.length === 0}
          onClick={() => void deleteClips(controller, selectedClips)}
        />
        <div className="ml-auto flex items-center gap-2 text-[11px] text-slate-400">
          <span>{Math.round(snapshot.view.zoom * 100)}%</span>
          <input
            type="range"
            min={0.25}
            max={4}
            step={0.25}
            value={snapshot.view.zoom}
            onChange={(event) => {
              const zoom = Number(event.currentTarget.value);
              controller.updateView({ zoom });
              scheduleViewSync({ zoom });
            }}
            className="w-24 accent-sky-400"
            aria-label="Timeline zoom"
          />
        </div>
      </div>

      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-auto"
        onScroll={(event) => {
          const scrollLeft = event.currentTarget.scrollLeft;
          controller.updateView({ scrollLeft });
          scheduleViewSync({ scrollLeft });
        }}
      >
        <div className="sticky top-0 z-30 flex h-7 min-w-max border-b border-slate-800 bg-slate-950">
          <div
            className="sticky left-0 z-40 flex-none border-r border-slate-800 bg-slate-950 px-2 py-1 text-[10px] uppercase tracking-wider text-slate-500"
            style={{ width: TRACK_HEADER_WIDTH }}
          >
            Tracks
          </div>
          <TimelineRuler width={timelineWidth} pixelsPerSecond={pixelsPerSecond} />
        </div>
        {snapshot.project.tracks.map((track) => (
          <div
            key={track.id}
            className="relative flex min-w-max border-b border-slate-800/80"
            style={{ height: snapshot.view.trackHeights[track.id] ?? track.height }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => handleDrop(event, track)}
          >
            <TrackHeader track={track} />
            <div
              className="relative overflow-hidden bg-slate-900/40"
              style={{ width: timelineWidth }}
              onDoubleClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const startSeconds = (event.clientX - rect.left) / pixelsPerSecond;
                if (track.kind === 'subtitle') {
                  void controller.dispatch({
                    type: 'subtitle.insert',
                    trackId: track.id,
                    subtitleId: crypto.randomUUID(),
                    startOutputSample: secondsToOutputSample(startSeconds),
                    endOutputSample: secondsToOutputSample(startSeconds + 2),
                    text: 'New subtitle',
                  });
                }
              }}
            >
              {track.clips.map((clip) => (
                <TimelineClip
                  key={clip.id}
                  clip={clip}
                  track={track}
                  pixelsPerSecond={pixelsPerSecond}
                  selected={selected.has(clip.id)}
                />
              ))}
              <div
                className="pointer-events-none absolute inset-y-0 z-20 w-px bg-rose-400"
                style={{ left: snapshot.view.playheadSeconds * pixelsPerSecond }}
                aria-hidden="true"
              />
            </div>
            <div
              role="separator"
              aria-label={`Resize ${track.name}`}
              aria-orientation="horizontal"
              aria-valuemin={MIN_TRACK_HEIGHT}
              aria-valuemax={MAX_TRACK_HEIGHT}
              aria-valuenow={Math.round(snapshot.view.trackHeights[track.id] ?? track.height)}
              tabIndex={0}
              className="absolute inset-x-0 bottom-0 z-30 h-px cursor-row-resize bg-transparent hover:bg-sky-400 focus-visible:bg-sky-400 focus-visible:outline-none"
              onPointerDown={(event) => resizeTrack(event, track)}
              onKeyDown={(event) => {
                const current = snapshot.view.trackHeights[track.id] ?? track.height;
                const next = event.key === 'Home'
                  ? MIN_TRACK_HEIGHT
                  : event.key === 'End'
                    ? MAX_TRACK_HEIGHT
                    : event.key === 'ArrowUp'
                      ? Math.max(MIN_TRACK_HEIGHT, current - 8)
                      : event.key === 'ArrowDown'
                        ? Math.min(MAX_TRACK_HEIGHT, current + 8)
                        : null;
                if (next === null) return;
                event.preventDefault();
                controller.updateView({
                  focusedTrackId: track.id,
                  trackHeights: {
                    ...controller.getSnapshot().view.trackHeights,
                    [track.id]: next,
                  },
                });
                void controller.dispatch({
                  type: 'view.set-track-height',
                  trackId: track.id,
                  height: next,
                });
              }}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

async function deleteClips(
  controller: EditorUiController,
  clips: readonly EditorUiClip[],
): Promise<void> {
  const commands: EditorUiDurableCommand[] = clips.flatMap(
    (clip): EditorUiDurableCommand[] => {
    if (clip.kind === 'video') {
      return [{ type: 'video-clip.delete', clipId: clip.id }];
    } else if (clip.kind === 'audio') {
      return [{ type: 'audio-clip.delete', clipId: clip.id }];
    } else if (clip.kind === 'subtitle') {
      return [{
        type: 'subtitle.delete',
        trackId: clip.trackId,
        subtitleId: clip.id,
      }];
    }
    return [];
    },
  );
  if (commands.length > 0) {
    await controller.dispatch({
      type: 'edit.batch',
      commands,
      history: {
        label: commands.length === 1 ? 'Delete clip' : `Delete ${commands.length} clips`,
        category: 'timeline.delete',
      },
    });
  }
}

function TimelineRuler({ width, pixelsPerSecond }: { width: number; pixelsPerSecond: number }) {
  const seconds = Math.ceil(width / pixelsPerSecond);
  const interval = pixelsPerSecond < 40 ? 5 : pixelsPerSecond < 100 ? 2 : 1;
  return (
    <div className="relative flex-none" style={{ width }}>
      {Array.from({ length: Math.ceil(seconds / interval) + 1 }, (_, index) => {
        const second = index * interval;
        return (
          <span
            key={second}
            className="absolute bottom-0 top-0 border-l border-slate-700 pl-1 pt-1 font-mono text-[9px] text-slate-500"
            style={{ left: second * pixelsPerSecond }}
          >
            {second}s
          </span>
        );
      })}
    </div>
  );
}

function TrackHeader({ track }: { track: EditorUiTrack }) {
  const snapshot = useEditorUiSnapshot();
  const { controller, services } = useEditorSurfaceHost();
  const Icon = trackIcon(track.kind);
  const sameKindTracks = snapshot.project.tracks.filter((candidate) => (
    candidate.kind === track.kind
  ));
  const kindIndex = sameKindTracks.findIndex((candidate) => candidate.id === track.id);
  const rehome = sameKindTracks.find((candidate) => candidate.id !== track.id);
  const canRemove = !(track.kind === 'video' && sameKindTracks.length === 1)
    && (track.clips.length === 0 || Boolean(rehome));
  return (
    <div
      className="sticky left-0 z-20 flex flex-none items-center gap-1 border-r border-slate-800 bg-slate-950 px-2"
      style={{ width: TRACK_HEADER_WIDTH }}
    >
      <Icon className="h-3.5 w-3.5 flex-none text-slate-500" />
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-[11px] font-medium text-slate-300"
        title="Rename track"
        onDoubleClick={async () => {
          const name = await services.requestText({
            title: 'Rename track',
            label: 'Track name',
            initialValue: track.name,
          });
          if (name?.trim()) {
            void controller.dispatch({
              type: 'track.rename',
              trackKind: track.kind,
              trackId: track.id,
              name: name.trim(),
            });
          }
        }}
      >
        {track.name}
      </button>
      <button
        type="button"
        className="rounded p-0.5 text-slate-600 hover:bg-slate-800 hover:text-white disabled:opacity-20"
        disabled={kindIndex === 0}
        onClick={() => void controller.dispatch({
          type: 'track.reorder',
          trackKind: track.kind,
          trackId: track.id,
          beforeTrackId: sameKindTracks[kindIndex - 1].id,
        })}
        aria-label={`Move ${track.name} up`}
      >
        <ChevronUp className="h-3 w-3" />
      </button>
      <button
        type="button"
        className="rounded p-0.5 text-slate-600 hover:bg-slate-800 hover:text-white disabled:opacity-20"
        disabled={kindIndex === sameKindTracks.length - 1}
        onClick={() => void controller.dispatch({
          type: 'track.reorder',
          trackKind: track.kind,
          trackId: track.id,
          afterTrackId: sameKindTracks[kindIndex + 1].id,
        })}
        aria-label={`Move ${track.name} down`}
      >
        <ChevronDown className="h-3 w-3" />
      </button>
      {(track.kind === 'video' || track.kind === 'subtitle') && (
        <button
          type="button"
          className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-white"
          onClick={() => void controller.dispatch({
            type: 'track.set-state',
            trackKind: track.kind,
            trackId: track.id,
            visible: !track.visible,
          })}
          aria-label={`${track.visible ? 'Hide' : 'Show'} ${track.name}`}
        >
          {track.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
      )}
      {(track.kind === 'audio' || track.kind === 'video') && (
        <button
          type="button"
          className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-white"
          onClick={() => void controller.dispatch({
            type: 'track.set-state',
            trackKind: track.kind,
            trackId: track.id,
            muted: !track.muted,
          })}
          aria-label={`${track.muted ? 'Unmute' : 'Mute'} ${track.name}`}
        >
          {track.muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
        </button>
      )}
      {track.kind === 'audio' && (
        <button
          type="button"
          className={`rounded px-1 py-0.5 text-[9px] font-bold ${track.solo
            ? 'bg-amber-500/20 text-amber-300'
            : 'text-slate-600 hover:bg-slate-800 hover:text-white'}`}
          onClick={() => void controller.dispatch({
            type: 'track.set-state',
            trackKind: track.kind,
            trackId: track.id,
            solo: !track.solo,
          })}
          aria-label={`${track.solo ? 'Disable' : 'Enable'} solo for ${track.name}`}
        >
          S
        </button>
      )}
      <button
        type="button"
        className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-white"
        onClick={() => void controller.dispatch({
          type: 'track.set-state',
          trackKind: track.kind,
          trackId: track.id,
          locked: !track.locked,
        })}
        aria-label={`${track.locked ? 'Unlock' : 'Lock'} ${track.name}`}
      >
        {track.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        className="rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-20"
        disabled={!canRemove}
        onClick={() => {
          void controller.dispatch({
            type: 'track.delete',
            trackKind: track.kind,
            trackId: track.id,
            policy: track.clips.length > 0 && rehome ? 'rehome' : 'require-empty',
            ...(track.clips.length > 0 && rehome ? { rehomeTrackId: rehome.id } : {}),
          });
        }}
        aria-label={`Remove ${track.name}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function TimelineClip({
  clip,
  track,
  pixelsPerSecond,
  selected,
}: {
  clip: EditorUiClip;
  track: EditorUiTrack;
  pixelsPerSecond: number;
  selected: boolean;
}) {
  const { controller } = useEditorSurfaceHost();
  const selectClip = (addToSelection: boolean) => {
    const ids = addToSelection
      ? Array.from(new Set([...controller.getSnapshot().view.selectedIds, clip.id]))
      : [clip.id];
    controller.updateView({ selectedIds: ids, focusedTrackId: track.id });
    void controller.dispatch({ type: 'view.select', ids });
  };
  const commitTrimAt = (edge: 'start' | 'end', timeSeconds: number) => {
    const clampedTime = clampEditorUiClipTrimTime(clip, edge, timeSeconds);
    const optimistic = { optimistic: (current: EditorUiSnapshot) => (
      optimisticTrim(current, clip.id, edge, clampedTime)
    ) };
    if (clip.kind === 'video') {
      const sourceStartSeconds = edge === 'start'
        ? clip.sourceOffsetSeconds + clampedTime - clip.startSeconds
        : clip.sourceOffsetSeconds;
      const sourceEndSeconds = edge === 'end'
        ? clip.sourceOffsetSeconds + clampedTime - clip.startSeconds
        : clip.sourceOffsetSeconds + clip.durationSeconds;
      void controller.dispatch({
        type: 'video-clip.trim',
        clipId: clip.id,
        sourceStartSeconds,
        sourceEndSeconds,
        ...(edge === 'start'
          ? {
              timelineStartFrame: secondsToProjectFrame(
                clampedTime,
                controller.getSnapshot().project.fps,
              ),
            }
          : {}),
      }, optimistic);
    } else if (clip.kind === 'audio') {
      const sourceRange = trimmedAudioSourceRange(clip, edge, clampedTime);
      if (!sourceRange) return;
      void controller.dispatch({
        type: 'audio-clip.trim',
        clipId: clip.id,
        sourceRange,
      }, optimistic);
    } else if (clip.kind === 'subtitle') {
      void controller.dispatch({
        type: 'subtitle.trim',
        trackId: clip.trackId,
        subtitleId: clip.id,
        startOutputSample: secondsToOutputSample(
          edge === 'start' ? clampedTime : clip.startSeconds,
        ),
        endOutputSample: secondsToOutputSample(
          edge === 'end' ? clampedTime : clip.startSeconds + clip.durationSeconds,
        ),
      }, optimistic);
    }
  };
  const beginTrim = (event: PointerEvent<HTMLElement>, edge: 'start' | 'end') => {
    if (event.button !== 0 || track.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const originalTime = edge === 'start'
      ? clip.startSeconds
      : clip.startSeconds + clip.durationSeconds;
    let finalTime = originalTime;
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      finalTime = Math.max(0, originalTime + (moveEvent.clientX - startX) / pixelsPerSecond);
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', commitTrim);
      window.removeEventListener('pointercancel', cancelTrim);
      if (!commit) return;
      commitTrimAt(edge, finalTime);
    };
    const commitTrim = () => finish(true);
    const cancelTrim = () => finish(false);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', commitTrim, { once: true });
    window.addEventListener('pointercancel', cancelTrim, { once: true });
  };
  const color = clip.kind === 'video'
    ? 'border-sky-400/60 bg-sky-600/40'
    : clip.kind === 'audio'
      ? 'border-emerald-400/60 bg-emerald-600/35'
      : 'border-violet-400/60 bg-violet-600/35';
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={!track.locked}
      aria-label={`${clip.kind} clip ${clip.label}`}
      aria-pressed={selected}
      data-clip-id={clip.id}
      className={`group absolute inset-y-2 overflow-hidden rounded border text-left outline-none ${color} ${selected
        ? 'ring-2 ring-white ring-offset-1 ring-offset-slate-950'
        : 'hover:brightness-125 focus-visible:ring-2 focus-visible:ring-sky-300'}`}
      style={{
        left: clip.startSeconds * pixelsPerSecond,
        width: Math.max(18, clip.durationSeconds * pixelsPerSecond),
      }}
      onClick={(event) => {
        selectClip(event.shiftKey);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          void deleteClips(controller, [clip]);
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectClip(event.shiftKey);
        }
      }}
      onDragStart={(event) => {
        const selectedIds = controller.getSnapshot().view.selectedIds;
        const clipIds = selectedIds.includes(clip.id) ? selectedIds : [clip.id];
        event.dataTransfer.setData('application/x-waptions-clips', JSON.stringify(clipIds));
        event.dataTransfer.effectAllowed = 'move';
      }}
    >
      <button
        type="button"
        className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize bg-white/15 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white"
        onPointerDown={(event) => beginTrim(event, 'start')}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const frames = event.shiftKey ? 10 : 1;
          const direction = event.key === 'ArrowLeft' ? -1 : 1;
          commitTrimAt(
            'start',
            clip.startSeconds + direction * frames / controller.getSnapshot().project.fps,
          );
        }}
        aria-label={`Trim start of ${clip.label}`}
      />
      <div className="truncate px-2 pt-1 text-[10px] font-medium text-white">{clip.label}</div>
      {clip.kind === 'video' && clip.hasLinkedAudio && (
        <div className="absolute inset-x-0 bottom-0 h-1/2 border-t border-sky-200/20 bg-sky-950/35">
          <div className="h-full opacity-60 [background:linear-gradient(135deg,transparent_40%,rgba(125,211,252,.5)_41%,rgba(125,211,252,.5)_45%,transparent_46%)_0_0/9px_100%]" />
        </div>
      )}
      {clip.kind === 'audio' && (
        <div className="absolute inset-x-0 bottom-0 h-2/3 opacity-50 [background:linear-gradient(135deg,transparent_40%,rgba(167,243,208,.7)_41%,rgba(167,243,208,.7)_45%,transparent_46%)_0_0/8px_100%]" />
      )}
      <button
        type="button"
        className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize bg-white/15 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white"
        onPointerDown={(event) => beginTrim(event, 'end')}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const frames = event.shiftKey ? 10 : 1;
          const direction = event.key === 'ArrowLeft' ? -1 : 1;
          commitTrimAt(
            'end',
            clip.startSeconds
              + clip.durationSeconds
              + direction * frames / controller.getSnapshot().project.fps,
          );
        }}
        aria-label={`Trim end of ${clip.label}`}
      />
    </div>
  );
}

function trimmedAudioSourceRange(
  clip: EditorUiClip,
  edge: 'start' | 'end',
  timelineSeconds: number,
): EditorUiAudioSourceRange | null {
  const range = clip.audioSourceRange;
  if (!range) return null;
  const startDeltaSeconds = timelineSeconds - clip.startSeconds;
  const retainedDurationSeconds = Math.max(0.01, timelineSeconds - clip.startSeconds);
  if (range.domain === 'audio-source-native-samples') {
    const sourceEndLimit = clip.sourceDurationSeconds === undefined
      ? range.endNativeSample
      : Math.round(clip.sourceDurationSeconds * range.nativeSampleRateHz);
    return {
      ...range,
      startNativeSample: edge === 'start'
        ? Math.max(
            0,
            Math.min(
            range.endNativeSample - 1,
            range.startNativeSample + Math.round(startDeltaSeconds * range.nativeSampleRateHz),
            ),
          )
        : range.startNativeSample,
      endNativeSample: edge === 'end'
        ? Math.min(
            sourceEndLimit,
            Math.max(
              range.startNativeSample + 1,
              range.startNativeSample
                + Math.round(retainedDurationSeconds * range.nativeSampleRateHz),
            ),
          )
        : range.endNativeSample,
    };
  }
  const sourceEndLimit = clip.sourceDurationSeconds ?? range.endSeconds;
  return {
    ...range,
    startSeconds: edge === 'start'
      ? Math.max(
          0,
          Math.min(range.endSeconds - 0.001, range.startSeconds + startDeltaSeconds),
        )
      : range.startSeconds,
    endSeconds: edge === 'end'
      ? Math.min(
          sourceEndLimit,
          Math.max(range.startSeconds + 0.001, range.startSeconds + retainedDurationSeconds),
        )
      : range.endSeconds,
  };
}

function TrackAction({
  icon: Icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: typeof Plus;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
