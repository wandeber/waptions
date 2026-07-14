const COMPLETE_DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Parses only complete decimal drafts while leaving the caller's raw text untouched.
 *
 * `Number.parseFloat` accepts prefixes such as `6x`, which would make the preview disagree with
 * the visible draft. This stricter parser still accepts a trailing decimal separator (`6.`), so
 * sequential typing can preview useful values without rewriting the input before the user types
 * the fractional digits.
 */
export function parseNumericDraft(rawDraft: string): number | null {
  const candidate = rawDraft.trim();
  if (!COMPLETE_DECIMAL_PATTERN.test(candidate)) return null;

  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}
