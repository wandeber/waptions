import type { EditorUiClip } from './contracts';

/** Clamp a visual trim before converting it into a source-domain Core operation. */
export const clampEditorUiClipTrimTime = (
  clip: EditorUiClip,
  edge: 'start' | 'end',
  timeSeconds: number,
): number => {
  const end = clip.startSeconds + clip.durationSeconds;
  if (edge === 'start') {
    const earliestRecoverableStart = Math.max(
      0,
      clip.startSeconds - clip.sourceOffsetSeconds,
    );
    return Math.min(Math.max(earliestRecoverableStart, timeSeconds), end - 0.01);
  }
  const latestRecoverableEnd = clip.sourceDurationSeconds === undefined
    ? Number.POSITIVE_INFINITY
    : clip.startSeconds + clip.sourceDurationSeconds - clip.sourceOffsetSeconds;
  return Math.max(clip.startSeconds + 0.01, Math.min(timeSeconds, latestRecoverableEnd));
};
