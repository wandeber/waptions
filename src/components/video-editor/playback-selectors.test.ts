import { describe, expect, it } from 'vitest';
import { shallow } from 'zustand/shallow';
import { usePlaybackStore } from '@/stores/playback-store';
import {
  selectTimelinePlaybackStatus,
  selectTimelinePlaybackStructure,
} from './playback-selectors';

describe('editor playback selectors', () => {
  it('keeps the structural timeline selection equal across clock-only updates', () => {
    const initial = usePlaybackStore.getState();
    const next = { ...initial, currentTime: initial.currentTime + 1 / 30 };

    expect(shallow(
      selectTimelinePlaybackStructure(initial),
      selectTimelinePlaybackStructure(next),
    )).toBe(true);
    expect(shallow(
      selectTimelinePlaybackStatus(initial),
      selectTimelinePlaybackStatus(next),
    )).toBe(false);
  });

  it('keeps transport-only volume updates out of the structural timeline selection', () => {
    const initial = usePlaybackStore.getState();
    const next = { ...initial, volume: 0.5, muted: false };

    expect(shallow(
      selectTimelinePlaybackStructure(initial),
      selectTimelinePlaybackStructure(next),
    )).toBe(true);
    expect(shallow(
      selectTimelinePlaybackStatus(initial),
      selectTimelinePlaybackStatus(next),
    )).toBe(false);
  });
});
