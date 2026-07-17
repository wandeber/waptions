'use client';

import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { usePlaybackStore } from '@/stores/playback-store';
import { selectTimelinePlaybackStatus } from './playback-selectors';
import { formatShortcutTitle, getShortcutAriaKeys } from '@/config/shortcuts';

const formatTimecode = (seconds: number, fps: number): string => {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const nominalFps = Math.max(1, Math.round(safeFps));
  const totalFrames = Math.max(0, Math.round(seconds * safeFps));
  const frames = totalFrames % nominalFps;
  const totalSeconds = Math.floor(totalFrames / nominalFps);
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, mins, secs, frames]
    .map((value) => value.toString().padStart(2, '0'))
    .join(':');
};

/** Keeps transport updates isolated from the monitor and the comparatively expensive timeline. */
export function EditorTransportBar() {
  const {
    currentTime,
    contentDuration,
    isPlaying,
    fps,
    muted,
    volume,
    seek,
    toggle,
    toggleMute,
  } = usePlaybackStore(useShallow(selectTimelinePlaybackStatus));
  const frameDuration = fps > 0 ? 1 / fps : 1 / 30;

  return (
    <div className="relative flex h-10 flex-none items-center bg-slate-950/95 px-3 text-slate-300">
      <div className="flex min-w-0 items-baseline gap-2 font-mono text-[11px] tabular-nums">
        <span
          className="text-sky-300"
          data-testid="timeline-current-time"
          data-time-seconds={currentTime.toFixed(6)}
        >
          {formatTimecode(currentTime, fps)}
        </span>
        <span className="text-slate-600">/</span>
        <span className="text-slate-500">{formatTimecode(contentDuration, fps)}</span>
      </div>

      <div
        role="group"
        className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1"
        aria-label="Playback controls"
      >
        <button
          type="button"
          className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
          onClick={() => seek(currentTime - frameDuration)}
          aria-label="Previous frame"
          title={formatShortcutTitle('Previous frame', 'PREVIOUS_FRAME')}
          aria-keyshortcuts={getShortcutAriaKeys('PREVIOUS_FRAME')}
        >
          <SkipBack className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="flex h-8 w-10 items-center justify-center rounded bg-slate-100 text-slate-950 transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          onClick={toggle}
          aria-label={isPlaying ? 'Pause timeline' : 'Play timeline'}
          data-testid="timeline-playback-toggle"
          title={formatShortcutTitle(isPlaying ? 'Pause' : 'Play', 'PLAY_PAUSE')}
          aria-keyshortcuts={getShortcutAriaKeys('PLAY_PAUSE')}
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current" />}
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
          onClick={() => seek(currentTime + frameDuration)}
          aria-label="Next frame"
          title={formatShortcutTitle('Next frame', 'NEXT_FRAME')}
          aria-keyshortcuts={getShortcutAriaKeys('NEXT_FRAME')}
        >
          <SkipForward className="h-4 w-4" />
        </button>
      </div>

      <button
        type="button"
        className="ml-auto flex items-center gap-2 rounded px-2 py-1 text-[11px] text-slate-400 transition-colors hover:bg-slate-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
        onClick={toggleMute}
        aria-label={muted ? 'Unmute preview' : 'Mute preview'}
        title={muted ? 'Unmute preview' : 'Mute preview'}
      >
        {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        <span className="font-mono tabular-nums">{Math.round(volume * 100)}%</span>
      </button>
    </div>
  );
}
