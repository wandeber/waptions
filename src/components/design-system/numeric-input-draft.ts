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

interface NumericValueNormalizationOptions {
  min: number;
  max: number;
  decimalPlaces?: number;
  normalizeValue?: (value: number) => number;
}

function getSafeDecimalPlaces(decimalPlaces?: number): number | undefined {
  if (decimalPlaces === undefined || !Number.isFinite(decimalPlaces)) return undefined;
  // JavaScript's decimal formatting is reliable within this range and editor controls do not
  // need sub-picounit precision. Truncating also makes a runtime value such as 2.5 predictable.
  return Math.min(12, Math.max(0, Math.trunc(decimalPlaces)));
}

/** Clamps and canonicalizes a numeric field value before it enters an edit session. */
export function normalizeNumericValue(
  value: number,
  { min, max, decimalPlaces, normalizeValue }: NumericValueNormalizationOptions,
): number {
  const clamp = (candidate: number) => Math.min(max, Math.max(min, candidate));
  const clamped = clamp(value);
  const domainNormalized = normalizeValue?.(clamped) ?? clamped;
  const finiteNormalized = Number.isFinite(domainNormalized) ? domainNormalized : clamped;
  const safeDecimalPlaces = getSafeDecimalPlaces(decimalPlaces);
  if (safeDecimalPlaces === undefined) {
    const result = clamp(finiteNormalized);
    return Object.is(result, -0) ? 0 : result;
  }

  const scale = 10 ** safeDecimalPlaces;
  // Quantize the magnitude so positive and negative midpoint values use the same rule. Native
  // Math.round would send negative halves toward zero, producing surprising gain behavior around
  // silence and potentially leaking `-0` into the continuous-edit equality check.
  const roundedMagnitude = Math.round((Math.abs(finiteNormalized) + Number.EPSILON) * scale) / scale;
  const signedRounded = finiteNormalized < 0 ? -roundedMagnitude : roundedMagnitude;
  const result = clamp(signedRounded);
  return Object.is(result, -0) ? 0 : result;
}

/** Formats up to the configured precision without filling the field with trailing zeroes. */
export function formatNumericValue(value: number, decimalPlaces?: number): string {
  const safeDecimalPlaces = getSafeDecimalPlaces(decimalPlaces);
  if (safeDecimalPlaces === undefined) return value.toString();
  if (safeDecimalPlaces === 0) return value.toFixed(0);
  return value
    .toFixed(safeDecimalPlaces)
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '');
}
