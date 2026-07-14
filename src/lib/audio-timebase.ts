import type { RationalFrameRate } from '@/types/video';

export const AUDIO_OUTPUT_SAMPLE_RATE = 48_000 as const;

/**
 * Rounds a non-negative rational value to its nearest integer, with exact halves rounded up.
 *
 * BigInt is required here even though the public API accepts safe JavaScript integers. A safe
 * frame boundary multiplied by 48 kHz and a broadcast-rate denominator can exceed the exact
 * integer range long before the final quotient does. Performing the products as numbers would
 * therefore let apparently valid long projects drift by one sample.
 */
export function roundNonNegativeRatioHalfUp(numerator: bigint, denominator: bigint): bigint {
    if (numerator < BigInt(0)) throw new RangeError('Ratio numerator must be non-negative.');
    if (denominator <= BigInt(0)) throw new RangeError('Ratio denominator must be positive.');
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    return quotient + (remainder * BigInt(2) >= denominator ? BigInt(1) : BigInt(0));
}

/** Maps an integer output-frame boundary to the canonical 48 kHz sample boundary. */
export function frameToOutputSample(
    frame: number,
    frameRate: RationalFrameRate,
    outputSampleRate = AUDIO_OUTPUT_SAMPLE_RATE,
): number {
    assertNonNegativeSafeInteger(frame, 'frame');
    assertPositiveSafeInteger(frameRate.numerator, 'frameRate.numerator');
    assertPositiveSafeInteger(frameRate.denominator, 'frameRate.denominator');
    assertPositiveSafeInteger(outputSampleRate, 'outputSampleRate');
    return ratioToSafeNumber(
        BigInt(frame) * BigInt(frameRate.denominator) * BigInt(outputSampleRate),
        BigInt(frameRate.numerator),
        'output sample',
    );
}

/**
 * Maps a half-open frame span by subtracting its two absolute boundary mappings.
 *
 * Never map a frame count in isolation: at fractional frame rates two equally sized spans can
 * legitimately differ by one sample depending on their absolute start. End-map minus start-map
 * is what guarantees adjacent spans are additive and share exactly one boundary.
 */
export function frameSpanToOutputSamples(
    startFrame: number,
    endFrame: number,
    frameRate: RationalFrameRate,
    outputSampleRate = AUDIO_OUTPUT_SAMPLE_RATE,
): number {
    assertOrderedBoundaries(startFrame, endFrame, 'frame');
    return frameToOutputSample(endFrame, frameRate, outputSampleRate)
        - frameToOutputSample(startFrame, frameRate, outputSampleRate);
}

/** Maps a native decoded-sample boundary to the canonical output sample boundary. */
export function nativeBoundaryToOutputSample(
    nativeBoundary: number,
    nativeSampleRate: number,
    outputSampleRate = AUDIO_OUTPUT_SAMPLE_RATE,
): number {
    assertNonNegativeSafeInteger(nativeBoundary, 'nativeBoundary');
    assertPositiveSafeInteger(nativeSampleRate, 'nativeSampleRate');
    assertPositiveSafeInteger(outputSampleRate, 'outputSampleRate');
    return ratioToSafeNumber(
        BigInt(nativeBoundary) * BigInt(outputSampleRate),
        BigInt(nativeSampleRate),
        'output sample',
    );
}

/** Maps a native half-open span from its absolute source boundaries. */
export function nativeSpanToOutputSamples(
    startNativeBoundary: number,
    endNativeBoundary: number,
    nativeSampleRate: number,
    outputSampleRate = AUDIO_OUTPUT_SAMPLE_RATE,
): number {
    assertOrderedBoundaries(startNativeBoundary, endNativeBoundary, 'native sample');
    return nativeBoundaryToOutputSample(endNativeBoundary, nativeSampleRate, outputSampleRate)
        - nativeBoundaryToOutputSample(startNativeBoundary, nativeSampleRate, outputSampleRate);
}

/**
 * Finds the smallest output-frame boundary whose mapped sample is at or after the request.
 *
 * This ceiling conversion is used for clip ends: when audio finishes between two frame
 * boundaries, the later boundary keeps the final partial frame visible and editable. Exact
 * boundaries remain exact, including the zero origin.
 */
export function outputSampleToCoveringFrame(
    outputSample: number,
    frameRate: RationalFrameRate,
    outputSampleRate = AUDIO_OUTPUT_SAMPLE_RATE,
): number {
    assertNonNegativeSafeInteger(outputSample, 'outputSample');
    if (outputSample === 0) return 0;
    let lowerFrame = 0;
    let upperFrame = 1;

    while (frameToOutputSample(upperFrame, frameRate, outputSampleRate) < outputSample) {
        if (upperFrame > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
            throw new RangeError('Covering frame does not fit in a safe integer.');
        }
        upperFrame *= 2;
    }

    while (lowerFrame + 1 < upperFrame) {
        const candidate = lowerFrame + Math.floor((upperFrame - lowerFrame) / 2);
        if (frameToOutputSample(candidate, frameRate, outputSampleRate) >= outputSample) {
            upperFrame = candidate;
        } else {
            lowerFrame = candidate;
        }
    }
    return upperFrame;
}

/**
 * Chooses the native boundary whose forward mapping is closest to an output boundary.
 *
 * A rounded forward map is not one-to-one when resampling. We inspect the integer ideal and its
 * immediate neighbors, then prefer the higher native boundary on equal output distance. That
 * deterministic tie rule prevents left and right trim handles from choosing different source
 * boundaries for the same visible output boundary.
 */
export function outputSampleToNearestNativeBoundary(
    outputSample: number,
    nativeSampleRate: number,
    outputSampleRate = AUDIO_OUTPUT_SAMPLE_RATE,
): number {
    assertNonNegativeSafeInteger(outputSample, 'outputSample');
    assertPositiveSafeInteger(nativeSampleRate, 'nativeSampleRate');
    assertPositiveSafeInteger(outputSampleRate, 'outputSampleRate');

    const ideal = BigInt(outputSample) * BigInt(nativeSampleRate) / BigInt(outputSampleRate);
    const candidates = [
        ideal > BigInt(0) ? ideal - BigInt(1) : BigInt(0),
        ideal,
        ideal + BigInt(1),
    ];
    let bestBoundary = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    candidates.forEach((candidate) => {
        const boundary = bigintToSafeNumber(candidate, 'native boundary');
        const mapped = nativeBoundaryToOutputSample(boundary, nativeSampleRate, outputSampleRate);
        const distance = Math.abs(mapped - outputSample);
        if (distance < bestDistance || (distance === bestDistance && boundary > bestBoundary)) {
            bestBoundary = boundary;
            bestDistance = distance;
        }
    });
    return bestBoundary;
}

function ratioToSafeNumber(numerator: bigint, denominator: bigint, name: string): number {
    return bigintToSafeNumber(roundNonNegativeRatioHalfUp(numerator, denominator), name);
}

function bigintToSafeNumber(value: bigint, name: string): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`${name} must fit in a non-negative safe integer.`);
    }
    return Number(value);
}

function assertOrderedBoundaries(start: number, end: number, name: string): void {
    assertNonNegativeSafeInteger(start, `${name} start`);
    assertNonNegativeSafeInteger(end, `${name} end`);
    if (end < start) throw new RangeError(`${name} end must not precede its start.`);
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer.`);
    }
}

function assertPositiveSafeInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer.`);
    }
}
