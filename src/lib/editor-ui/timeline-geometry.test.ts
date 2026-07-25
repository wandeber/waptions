import { describe, expect, it } from 'vitest';
import {
  clampEditorUiClipTrimTime,
  type EditorUiClip,
} from './index';

const clip = {
  id: 'clip',
  trackId: 'video',
  sourceId: 'source',
  kind: 'video',
  label: 'Clip',
  startSeconds: 10,
  durationSeconds: 5,
  sourceOffsetSeconds: 2,
  sourceDurationSeconds: 20,
  linkedTargetIds: [],
} satisfies EditorUiClip;

describe('managed timeline trim bounds', () => {
  it('clamps start recovery to source zero and keeps a positive clip range', () => {
    expect(clampEditorUiClipTrimTime(clip, 'start', 0)).toBe(8);
    expect(clampEditorUiClipTrimTime(clip, 'start', 20)).toBe(14.99);
  });

  it('clamps end recovery to source duration and keeps a positive clip range', () => {
    expect(clampEditorUiClipTrimTime(clip, 'end', 0)).toBe(10.01);
    expect(clampEditorUiClipTrimTime(clip, 'end', 40)).toBe(28);
  });
});
