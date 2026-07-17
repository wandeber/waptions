import { describe, expect, it } from 'vitest';
import { isTextEditingKeyboardTarget } from './keyboard-target';

const createTargetMatching = (expectedSelector: string): EventTarget => ({
  closest: (selectors: string) => (
    selectors.split(',').includes(expectedSelector) ? {} : null
  ),
}) as unknown as EventTarget;

describe('isTextEditingKeyboardTarget', () => {
  it.each([
    'input',
    'select',
    'textarea',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]',
    '[role="searchbox"]',
  ])('recognizes %s as an editing surface', (selector) => {
    expect(isTextEditingKeyboardTarget(createTargetMatching(selector))).toBe(true);
  });

  it('ignores non-editing elements and non-Element event targets', () => {
    expect(isTextEditingKeyboardTarget(createTargetMatching('button'))).toBe(false);
    expect(isTextEditingKeyboardTarget(new EventTarget())).toBe(false);
    expect(isTextEditingKeyboardTarget(null)).toBe(false);
  });
});
