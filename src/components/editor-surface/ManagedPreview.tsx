'use client';

import {
  Crown,
  Maximize2,
  Minimize2,
  Pause,
  PictureInPicture2,
  Play,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { secondsToProjectFrame } from '@/lib/editor-ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EditorUiClip } from '@/lib/editor-ui';
import { useEditorSurfaceHost, useEditorUiSnapshot } from './EditorSurfaceProvider';

const formatTimecode = (seconds: number, fps: number): string => {
  const safeFps = Math.max(1, Math.round(fps || 30));
  const totalFrames = Math.max(0, Math.round(seconds * safeFps));
  const frames = totalFrames % safeFps;
  const totalSeconds = Math.floor(totalFrames / safeFps);
  const parts = [
    Math.floor(totalSeconds / 3600),
    Math.floor(totalSeconds / 60) % 60,
    totalSeconds % 60,
    frames,
  ];
  return parts.map((part) => part.toString().padStart(2, '0')).join(':');
};

const activeVideoClips = (clips: EditorUiClip[], playhead: number): EditorUiClip[] => (
  clips.filter((clip) => (
    clip.kind === 'video'
    && playhead >= clip.startSeconds
    && playhead < clip.startSeconds + clip.durationSeconds
  ))
);

export function ManagedPreview() {
  const snapshot = useEditorUiSnapshot();
  const { controller } = useEditorSurfaceHost();
  const videoClips = useMemo(() => snapshot.project.tracks.flatMap((track) => track.clips), [
    snapshot.project.tracks,
  ]);
  const visibleVideoClips = activeVideoClips(videoClips, snapshot.view.playheadSeconds);
  const activeSubtitles = videoClips.filter((clip) => (
    clip.kind === 'subtitle'
    && snapshot.view.playheadSeconds >= clip.startSeconds
    && snapshot.view.playheadSeconds < clip.startSeconds + clip.durationSeconds
  ));

  return (
    <section
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black"
      aria-label="Video preview"
      data-testid="managed-editor-preview"
    >
      {visibleVideoClips.length > 0 ? (
        <div className="relative h-full w-full">
          {visibleVideoClips.map((clip, index) => (
            <ManagedVideoLayer
              key={clip.id}
              clip={clip}
              isClockOwner={index === 0}
              layerIndex={index}
            />
          ))}
        </div>
      ) : (
        <div className="flex max-w-sm flex-col items-center gap-2 px-6 text-center text-slate-500">
          <div className="flex h-16 w-24 items-center justify-center rounded border border-slate-800 bg-slate-900">
            <Play className="h-6 w-6" />
          </div>
          <p className="text-xs">
            Move the playhead over a video clip to preview it.
          </p>
        </div>
      )}

      {activeSubtitles.length > 0 && (
        <div
          className="pointer-events-none absolute inset-x-[8%] bottom-[8%] z-30 flex flex-col items-center gap-1"
          aria-live="off"
        >
          {activeSubtitles.map((subtitle) => (
            <span
              key={subtitle.id}
              className="max-w-full rounded bg-black/75 px-2 py-1 text-center text-sm font-medium text-white shadow"
            >
              {subtitle.text ?? subtitle.label}
            </span>
          ))}
        </div>
      )}

      <div className="absolute right-3 top-3 z-40 flex items-center gap-1 rounded bg-slate-950/80 p-1">
        <span className="flex items-center gap-1 px-1.5 text-[10px] text-slate-400">
          <Users className="h-3 w-3" />
          {snapshot.presence.length}
        </span>
        {snapshot.capabilities.canPresentPictureInPicture && (
          <button
            type="button"
            className="rounded p-1.5 text-slate-300 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
            onClick={() => void controller.requestPresentation('picture-in-picture')}
            aria-label="Open picture-in-picture editor"
            title="Picture in picture"
          >
            <PictureInPicture2 className="h-3.5 w-3.5" />
          </button>
        )}
        {snapshot.capabilities.canPresentFullscreen && (
          <button
            type="button"
            className="rounded p-1.5 text-slate-300 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
            onClick={() => void controller.requestPresentation(
              snapshot.view.presentation === 'fullscreen' ? 'inline' : 'fullscreen',
            )}
            aria-label={snapshot.view.presentation === 'fullscreen'
              ? 'Return to inline editor'
              : 'Open fullscreen editor'}
          >
            {snapshot.view.presentation === 'fullscreen'
              ? <Minimize2 className="h-3.5 w-3.5" />
              : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </section>
  );
}

function ManagedVideoLayer({
  clip,
  isClockOwner,
  layerIndex,
}: {
  clip: EditorUiClip;
  isClockOwner: boolean;
  layerIndex: number;
}) {
  const snapshot = useEditorUiSnapshot();
  const { controller, mediaResolver } = useEditorSurfaceHost();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!mediaResolver || !clip.sourceId) {
      setSourceUrl(null);
      return;
    }
    const abort = new AbortController();
    let resolvedUrl: string | null = null;
    void mediaResolver.resolveSourceUrl(clip.sourceId, abort.signal).then((url) => {
      if (abort.signal.aborted) {
        mediaResolver.releaseUrl(url);
        return;
      }
      resolvedUrl = url;
      setSourceUrl(url);
    }).catch(() => setSourceUrl(null));
    return () => {
      abort.abort();
      if (resolvedUrl) mediaResolver.releaseUrl(resolvedUrl);
    };
  }, [clip.sourceId, mediaResolver]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !sourceUrl) return;
    const expected = clip.sourceOffsetSeconds
      + snapshot.view.playheadSeconds
      - clip.startSeconds;
    if (Math.abs(video.currentTime - expected) > 0.08) video.currentTime = Math.max(0, expected);
    // The managed surface renders every visible video layer. Until the host supplies the mixed
    // audio stream, only one layer may own audible linked audio to prevent duplicate playback.
    video.muted = !isClockOwner || snapshot.playback.muted || Boolean(clip.muted);
    video.volume = Math.min(1, Math.max(0, snapshot.playback.volume));
    video.playbackRate = Math.min(4, Math.max(0.25, snapshot.playback.playbackRate));
    if (snapshot.playback.isPlaying) {
      void video.play().catch(() => {
        // Autoplay policy can require a direct gesture; semantic playback remains authoritative.
      });
    } else {
      video.pause();
    }
  }, [
    clip,
    isClockOwner,
    snapshot.playback.isPlaying,
    snapshot.playback.muted,
    snapshot.playback.playbackRate,
    snapshot.playback.volume,
    snapshot.view.playheadSeconds,
    sourceUrl,
  ]);

  if (!sourceUrl) {
    return (
      <div
        className="absolute inset-0 flex items-center justify-center text-xs text-slate-500"
        style={{ zIndex: layerIndex }}
      >
        {clip.label}
      </div>
    );
  }
  return (
    <video
      ref={videoRef}
      src={sourceUrl}
      className="absolute inset-0 h-full w-full object-contain"
      style={{ zIndex: layerIndex }}
      playsInline
      aria-label={clip.label}
      onTimeUpdate={(event) => {
        if (!isClockOwner || snapshot.playback.followingPresenter) return;
        const nextPlayhead = Math.min(
          clip.startSeconds + clip.durationSeconds,
          Math.max(
            clip.startSeconds,
            clip.startSeconds + event.currentTarget.currentTime - clip.sourceOffsetSeconds,
          ),
        );
        if (Math.abs(nextPlayhead - controller.getSnapshot().view.playheadSeconds)
          >= 1 / Math.max(snapshot.project.fps, 1)) {
          controller.updateView({ playheadSeconds: nextPlayhead });
        }
      }}
    />
  );
}

export function ManagedTransport() {
  const snapshot = useEditorUiSnapshot();
  const { controller } = useEditorSurfaceHost();
  const isPlaying = snapshot.playback.isPlaying;
  return (
    <div className="flex h-10 flex-none items-center gap-3 border-t border-slate-800 bg-slate-950 px-3">
      <span className="min-w-0 font-mono text-[11px] tabular-nums text-sky-300">
        {formatTimecode(snapshot.view.playheadSeconds, snapshot.project.fps)}
      </span>
      <button
        type="button"
        className="flex h-7 w-9 items-center justify-center rounded bg-slate-100 text-slate-950 hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
        onClick={() => void controller.dispatch({
          type: isPlaying ? 'playback.pause' : 'playback.play',
        })}
        aria-label={isPlaying ? 'Pause timeline' : 'Play timeline'}
      >
        {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current" />}
      </button>
      <input
        type="range"
        min={0}
        max={Math.max(snapshot.project.durationSeconds, 0.01)}
        step={1 / Math.max(snapshot.project.fps, 1)}
        value={Math.min(snapshot.view.playheadSeconds, snapshot.project.durationSeconds)}
        onChange={(event) => {
          const timeSeconds = Number(event.currentTarget.value);
          controller.updateView({ playheadSeconds: timeSeconds });
          void controller.dispatch({
            type: 'playback.seek',
            timelineFrame: secondsToProjectFrame(timeSeconds, snapshot.project.fps),
          });
        }}
        className="min-w-0 flex-1 accent-sky-400"
        aria-label="Timeline playhead"
      />
      <select
        value={snapshot.playback.playbackRate}
        onChange={(event) => void controller.dispatch({
          type: 'playback.set-rate',
          rate: Number(event.currentTarget.value),
        })}
        className="h-7 rounded border border-slate-800 bg-slate-900 px-1 text-[10px] text-slate-300"
        aria-label="Playback rate"
      >
        {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
          <option key={rate} value={rate}>{rate}×</option>
        ))}
      </select>
      <button
        type="button"
        className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
        onClick={() => void controller.dispatch({
          type: 'playback.set-muted',
          muted: !snapshot.playback.muted,
        })}
        aria-label={snapshot.playback.muted ? 'Unmute preview' : 'Mute preview'}
      >
        {snapshot.playback.muted
          ? <VolumeX className="h-4 w-4" />
          : <Volume2 className="h-4 w-4" />}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={snapshot.playback.volume}
        onChange={(event) => void controller.dispatch({
          type: 'playback.set-volume',
          volume: Number(event.currentTarget.value),
        })}
        className="w-16 accent-sky-400"
        aria-label="Preview volume"
      />
      <button
        type="button"
        className={`rounded p-1.5 ${snapshot.playback.presenterViewId === controller.viewId
          ? 'bg-amber-500/15 text-amber-300'
          : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`}
        onClick={() => void controller.dispatch({
          type: snapshot.playback.presenterViewId === controller.viewId
            ? 'playback.presenter.release'
            : 'playback.presenter.claim',
        })}
        aria-label={snapshot.playback.presenterViewId === controller.viewId
          ? 'Release presenter control'
          : 'Claim presenter control'}
      >
        <Crown className="h-4 w-4" />
      </button>
      {snapshot.playback.presenterViewId
        && snapshot.playback.presenterViewId !== controller.viewId && (
        <button
          type="button"
          className={`rounded px-2 py-1 text-[10px] ${snapshot.playback.followingPresenter
            ? 'bg-sky-500/15 text-sky-300'
            : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`}
          onClick={() => void controller.dispatch(snapshot.playback.followingPresenter
            ? { type: 'playback.unfollow' }
            : {
                type: 'playback.follow',
                presenterViewId: snapshot.playback.presenterViewId!,
              })}
        >
          {snapshot.playback.followingPresenter ? 'Unfollow' : 'Follow'}
        </button>
      )}
      <span className="font-mono text-[10px] tabular-nums text-slate-500">
        {formatTimecode(snapshot.project.durationSeconds, snapshot.project.fps)}
      </span>
    </div>
  );
}
