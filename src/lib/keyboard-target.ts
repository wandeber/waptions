const TEXT_EDITING_TARGET_SELECTOR = [
  'input',
  'select',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="searchbox"]',
].join(',');

/**
 * Returns whether a global editor shortcut must yield to an editing surface.
 *
 * `closest` deliberately covers events dispatched by descendants of custom textboxes and
 * contenteditable regions. A structural check keeps the helper safe for non-Element EventTargets
 * such as `window` without requiring callers to repeat browser-specific guards.
 */
export function isTextEditingKeyboardTarget(target: EventTarget | null): boolean {
  const closest = (target as Element | null)?.closest;
  if (typeof closest !== 'function') return false;
  return closest.call(target, TEXT_EDITING_TARGET_SELECTOR) !== null;
}
