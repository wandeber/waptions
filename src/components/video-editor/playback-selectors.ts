import type { usePlaybackStore } from '@/stores/playback-store';

type PlaybackState = ReturnType<typeof usePlaybackStore.getState>;

/** Structural timeline inputs deliberately exclude the frame clock. */
export const selectTimelinePlaybackStructure = (state: PlaybackState) => ({
  duration: state.duration,
  fps: state.fps,
  onTimeUpdate: state.seek,
  onPlayPause: state.toggle,
});

/** Only this small toolbar fragment needs a reactive clock subscription. */
export const selectTimelinePlaybackStatus = (state: PlaybackState) => ({
  currentTime: state.currentTime,
  contentDuration: state.contentDuration,
  isPlaying: state.isPlaying,
  toggle: state.toggle,
});
