const COMPLETE_HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Returns whether a draft is a complete six-digit CSS hex color. */
export function isCompleteHexColor(rawDraft: string): boolean {
  return COMPLETE_HEX_COLOR_PATTERN.test(rawDraft);
}
