import { describe, expect, it } from 'vitest';
import {
  beginContinuousEdit,
  previewContinuousEdit,
  terminateContinuousEdit,
} from '@/lib/continuous-edit-session';
import { getSubtitleHistoryShortcut } from './subtitle-edit-session';

describe('subtitle edit sessions', () => {
  it('commits a focus draft once and cancels back to its text baseline', () => {
    const draft = previewContinuousEdit(beginContinuousEdit('Before'), 'After');
    const committed = terminateContinuousEdit(draft, 'commit');
    const repeatedBlur = terminateContinuousEdit(committed.session, 'commit');
    const cancelled = terminateContinuousEdit(draft, 'cancel');

    expect(committed).toMatchObject({ value: 'After', shouldCommit: true });
    expect(repeatedBlur.shouldCommit).toBe(false);
    expect(cancelled).toMatchObject({ value: 'Before', shouldCommit: false });
  });

  it('routes focused app undo/redo but leaves IME composition to the browser', () => {
    expect(getSubtitleHistoryShortcut({
      key: 'z', metaKey: true, ctrlKey: false, shiftKey: false, isComposing: false,
    })).toBe('undo');
    expect(getSubtitleHistoryShortcut({
      key: 'Z', metaKey: false, ctrlKey: true, shiftKey: true, isComposing: false,
    })).toBe('redo');
    expect(getSubtitleHistoryShortcut({
      key: 'y', metaKey: false, ctrlKey: true, shiftKey: false, isComposing: false,
    })).toBe('redo');
    expect(getSubtitleHistoryShortcut({
      key: 'z', metaKey: true, ctrlKey: false, shiftKey: false, isComposing: true,
    })).toBeNull();
  });
});
