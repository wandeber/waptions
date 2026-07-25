import type { RationalFrameRate, RenderProfile } from '@/types/video';

export const OUTPUT_AUDIO_SAMPLE_RATE = 48_000 as const;
export const DEFAULT_RENDER_BACKGROUND_COLOR = '#000000' as const;

const RENDER_BACKGROUND_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const DEFAULT_RENDER_PROFILE: Readonly<RenderProfile> = Object.freeze({
    fps: Object.freeze({ numerator: 30, denominator: 1 }),
    width: 1920,
    height: 1080,
    audioSampleRate: OUTPUT_AUDIO_SAMPLE_RATE,
    isFrameRateLocked: false,
    isCanvasSizeLocked: false,
});

export function isRenderBackgroundColor(value: unknown): value is string {
    return typeof value === 'string' && RENDER_BACKGROUND_COLOR_PATTERN.test(value);
}

/**
 * Canonicalizes the durable project background at command/import boundaries.
 *
 * Validation accepts either CSS hex case so existing external bundles remain interoperable, while
 * every newly projected manifest uses one lowercase representation for deterministic history.
 */
export function normalizeRenderBackgroundColor(value: unknown): string {
    if (!isRenderBackgroundColor(value)) {
        throw new Error('Render background color must use the #RRGGBB CSS hex format.');
    }
    return value.toLowerCase();
}

export type FrameRoundingMode = 'floor' | 'nearest' | 'ceil';

/** Reduces an exact positive frame rate while preserving rates such as 24000/1001. */
export function normalizeFrameRate(rate: RationalFrameRate): RationalFrameRate {
    assertPositiveSafeInteger(rate.numerator, 'fps.numerator');
    assertPositiveSafeInteger(rate.denominator, 'fps.denominator');
    const divisor = greatestCommonDivisor(rate.numerator, rate.denominator);
    return {
        numerator: rate.numerator / divisor,
        denominator: rate.denominator / divisor,
    };
}

export function isSafeFrameRate(rate: RationalFrameRate): boolean {
    return Number.isSafeInteger(rate.numerator)
        && rate.numerator > 0
        && Number.isSafeInteger(rate.denominator)
        && rate.denominator > 0;
}

/** Converts the canonical rational frame rate to the runtime scalar used by legacy UI helpers. */
export function frameRateToNumber(rate: RationalFrameRate): number {
    const normalized = normalizeFrameRate(rate);
    return normalized.numerator / normalized.denominator;
}

export function createDefaultRenderProfile(
    overrides: Partial<Omit<RenderProfile, 'audioSampleRate'>> = {},
): RenderProfile {
    return {
        fps: normalizeFrameRate(overrides.fps ?? DEFAULT_RENDER_PROFILE.fps),
        width: overrides.width ?? DEFAULT_RENDER_PROFILE.width,
        height: overrides.height ?? DEFAULT_RENDER_PROFILE.height,
        audioSampleRate: OUTPUT_AUDIO_SAMPLE_RATE,
        isFrameRateLocked: overrides.isFrameRateLocked ?? DEFAULT_RENDER_PROFILE.isFrameRateLocked,
        isCanvasSizeLocked: overrides.isCanvasSizeLocked ?? DEFAULT_RENDER_PROFILE.isCanvasSizeLocked,
    };
}

/** Converts an output-frame count or boundary to seconds without decimal FPS approximation. */
export function framesToSeconds(frames: number, rate: RationalFrameRate): number {
    assertNonNegativeSafeInteger(frames, 'frames');
    const normalized = normalizeFrameRate(rate);
    return frames * normalized.denominator / normalized.numerator;
}

/** Converts seconds to an integer output-frame count using the caller's boundary policy. */
export function secondsToFrames(
    seconds: number,
    rate: RationalFrameRate,
    rounding: FrameRoundingMode = 'nearest',
): number {
    assertNonNegativeFinite(seconds, 'seconds');
    const normalized = normalizeFrameRate(rate);
    const exactFrames = seconds * normalized.numerator / normalized.denominator;
    return roundSafeInteger(exactFrames, rounding, 'frames');
}

/**
 * Maps an output-frame boundary to the nearest 48 kHz sample boundary. Rounding the absolute
 * boundary, rather than individual durations, guarantees adjacent ranges share the same sample.
 */
export function outputFramesToSamples(
    frames: number,
    rate: RationalFrameRate,
    rounding: FrameRoundingMode = 'nearest',
): number {
    assertNonNegativeSafeInteger(frames, 'frames');
    const normalized = normalizeFrameRate(rate);
    const exactSamples = frames
        * OUTPUT_AUDIO_SAMPLE_RATE
        * normalized.denominator
        / normalized.numerator;
    return roundSafeInteger(exactSamples, rounding, 'samples');
}

/** Converts a 48 kHz sample boundary back to the nearest output-frame boundary. */
export function samplesToOutputFrames(
    samples: number,
    rate: RationalFrameRate,
    rounding: FrameRoundingMode = 'nearest',
): number {
    assertNonNegativeSafeInteger(samples, 'samples');
    const normalized = normalizeFrameRate(rate);
    const exactFrames = samples
        * normalized.numerator
        / (OUTPUT_AUDIO_SAMPLE_RATE * normalized.denominator);
    return roundSafeInteger(exactFrames, rounding, 'frames');
}

function greatestCommonDivisor(left: number, right: number): number {
    let a = left;
    let b = right;
    while (b !== 0) {
        const remainder = a % b;
        a = b;
        b = remainder;
    }
    return a;
}

function roundSafeInteger(value: number, mode: FrameRoundingMode, name: string): number {
    const rounded = mode === 'floor' ? Math.floor(value) : mode === 'ceil' ? Math.ceil(value) : Math.round(value);
    if (!Number.isSafeInteger(rounded) || rounded < 0) {
        throw new RangeError(`${name} must fit in a non-negative safe integer.`);
    }
    return rounded;
}

function assertPositiveSafeInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer.`);
    }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer.`);
    }
}

function assertNonNegativeFinite(value: number, name: string): void {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be non-negative and finite.`);
    }
}
