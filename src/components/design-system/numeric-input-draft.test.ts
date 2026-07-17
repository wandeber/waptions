import { describe, expect, it } from 'vitest';
import {
  formatNumericValue,
  normalizeNumericValue,
  parseNumericDraft,
} from './numeric-input-draft';

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

describe('numeric field normalization', () => {
  it('supports configurable integer and decimal precision', () => {
    expect(normalizeNumericValue(3.6, { min: 0, max: 10, decimalPlaces: 0 })).toBe(4);
    expect(normalizeNumericValue(3.141, { min: 0, max: 10, decimalPlaces: 2 })).toBe(3.14);
    expect(formatNumericValue(3, 2)).toBe('3');
    expect(formatNumericValue(3.1, 2)).toBe('3.1');
  });

  it('rounds positive and negative midpoints symmetrically without retaining negative zero', () => {
    const options = { min: -12, max: 12, decimalPlaces: 1 };

    expect(normalizeNumericValue(0.05, options)).toBe(0.1);
    expect(normalizeNumericValue(-0.05, options)).toBe(-0.1);
    expect(normalizeNumericValue(1.25, options)).toBe(1.3);
    expect(normalizeNumericValue(-1.25, options)).toBe(-1.3);
    expect(Object.is(normalizeNumericValue(-0.001, options), -0)).toBe(false);
  });

  it('applies domain normalization before display precision and final clamping', () => {
    const sampleRate = 44_100;
    const normalizeMilliseconds = (milliseconds: number) => (
      Math.round(milliseconds * sampleRate / 1000) * 1000 / sampleRate
    );

    expect(normalizeNumericValue(0.024, {
      min: 0,
      max: 1000,
      decimalPlaces: 3,
      normalizeValue: normalizeMilliseconds,
    })).toBe(0.023);
    expect(normalizeNumericValue(20, {
      min: 0,
      max: 10,
      decimalPlaces: 3,
      normalizeValue: normalizeMilliseconds,
    })).toBe(10);
  });
});
