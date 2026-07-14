import { describe, expect, it } from 'vitest';
import { isCompleteHexColor } from './hex-color-draft';

describe('isCompleteHexColor', () => {
  it('accepts complete six-digit colors in either letter case', () => {
    expect(isCompleteHexColor('#123456')).toBe(true);
    expect(isCompleteHexColor('#aBcDeF')).toBe(true);
  });

  it('rejects incomplete and malformed drafts', () => {
    expect(isCompleteHexColor('#')).toBe(false);
    expect(isCompleteHexColor('#123')).toBe(false);
    expect(isCompleteHexColor('#12345')).toBe(false);
    expect(isCompleteHexColor('#12345g')).toBe(false);
    expect(isCompleteHexColor('123456')).toBe(false);
  });
});
