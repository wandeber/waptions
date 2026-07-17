import type { usePlaybackStore } from '@/stores/playback-store';

type PlaybackState = ReturnType<typeof usePlaybackStore.getState>;

/** Structural timeline inputs deliberately exclude the frame clock. */
export const selectTimelinePlaybackStructure = (state: PlaybackState) => ({
  duration: state.duration,
  fps: state.fps,
  onTimeUpdate: state.seek,
});

/** Only the compact transport bar needs frame-clock and volume updates. */
export const selectTimelinePlaybackStatus = (state: PlaybackState) => ({
  currentTime: state.currentTime,
  contentDuration: state.contentDuration,
  isPlaying: state.isPlaying,
  fps: state.fps,
  muted: state.muted,
  volume: state.volume,
  seek: state.seek,
  toggle: state.toggle,
  toggleMute: state.toggleMute,
});
