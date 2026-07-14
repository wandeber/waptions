import { describe, expect, it } from 'vitest';
import { parseNumericDraft } from './numeric-input-draft';

describe('parseNumericDraft', () => {
  it('accepts complete decimal drafts without requiring the UI to normalize their text', () => {
    expect(parseNumericDraft('6')).toBe(6);
    expect(parseNumericDraft('6.')).toBe(6);
    expect(parseNumericDraft('6.5')).toBe(6.5);
    expect(parseNumericDraft('-.5')).toBe(-0.5);
  });

  it('rejects incomplete values and numeric prefixes followed by invalid text', () => {
    expect(parseNumericDraft('')).toBeNull();
    expect(parseNumericDraft('-')).toBeNull();
    expect(parseNumericDraft('.')).toBeNull();
    expect(parseNumericDraft('6px')).toBeNull();
  });
});
