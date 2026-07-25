export const EDITORIAL_PCM_OUTPUT_SAMPLE_RATE_HZ = 16_000;
export const EDITORIAL_PCM_MIX_CHUNK_FRAMES = 16_384;

export interface RationalDuration {
    numerator: number;
    denominator: number;
}

export interface NativeChunkWindow {
    gapFrames: number;
    sourceFrameOffset: number;
    frameCount: number;
    destinationStartFrame: number;
    destinationEndFrame: number;
}

export function normalizeRationalDuration(duration: RationalDuration): RationalDuration {
    if (!Number.isSafeInteger(duration.numerator) || duration.numerator < 0
        || !Number.isSafeInteger(duration.denominator) || duration.denominator <= 0) {
        throw new Error('Editorial source duration must be a non-negative safe rational.');
    }
    const divisor = greatestCommonDivisor(duration.numerator, duration.denominator);
    return {
        numerator: duration.numerator / divisor,
        denominator: duration.denominator / divisor,
    };
}

export function ceilRationalSampleCount(
    duration: RationalDuration,
    sampleRateHz: number,
): number {
    const normalized = normalizeRationalDuration(duration);
    if (!Number.isSafeInteger(sampleRateHz) || sampleRateHz <= 0) {
        throw new Error('Editorial sample rate must be a positive safe integer.');
    }
    const numerator = BigInt(normalized.numerator) * BigInt(sampleRateHz);
    const denominator = BigInt(normalized.denominator);
    const result = (numerator + denominator - BigInt(1)) / denominator;
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Editorial source sample count exceeds the safe integer range.');
    }
    return Number(result);
}

/**
 * Maps Mediabunny's integer microsecond timestamp to a native sample using rational arithmetic.
 * Exact half-sample ties move toward the later sample, including for negative priming timestamps.
 */
export function timestampMicrosecondsToNativeSample(
    timestampMicroseconds: number,
    sampleRateHz: number,
): number {
    if (!Number.isSafeInteger(timestampMicroseconds)) {
        throw new Error('Editorial decoded timestamp must be an integer microsecond value.');
    }
    const numerator = BigInt(timestampMicroseconds) * BigInt(sampleRateHz);
    const denominator = BigInt(1_000_000);
    let floor = numerator / denominator;
    if (numerator < BigInt(0) && numerator % denominator !== BigInt(0)) floor -= BigInt(1);
    const remainder = numerator - floor * denominator;
    const rounded = remainder * BigInt(2) >= denominator ? floor + BigInt(1) : floor;
    if (rounded < BigInt(Number.MIN_SAFE_INTEGER) || rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Editorial decoded timestamp exceeds the safe sample range.');
    }
    return Number(rounded);
}

/**
 * Resolves one decoded chunk against the source-zero cursor. Positive gaps are explicit zero
 * frames, while an overlapping prefix is discarded. The result is also clamped to the declared
 * native duration so decoder overrun cannot lengthen the canonical source.
 */
export function planNativeChunkWindow(input: {
    timestampMicroseconds: number;
    sampleRateHz: number;
    numberOfFrames: number;
    nextNativeSample: number;
    declaredNativeSampleCount: number;
}): NativeChunkWindow | null {
    if (!Number.isSafeInteger(input.numberOfFrames) || input.numberOfFrames < 0
        || !Number.isSafeInteger(input.nextNativeSample) || input.nextNativeSample < 0
        || !Number.isSafeInteger(input.declaredNativeSampleCount)
        || input.declaredNativeSampleCount < 0) {
        throw new Error('Editorial decoded chunk counts must be non-negative safe integers.');
    }
    const timestampSample = timestampMicrosecondsToNativeSample(
        input.timestampMicroseconds,
        input.sampleRateHz,
    );
    const preZeroFrames = Math.min(input.numberOfFrames, Math.max(0, -timestampSample));
    const nonNegativeStart = Math.max(0, timestampSample + preZeroFrames);
    const overlapFrames = Math.max(0, input.nextNativeSample - nonNegativeStart);
    const sourceFrameOffset = Math.min(input.numberOfFrames, preZeroFrames + overlapFrames);
    const destinationStartFrame = Math.max(input.nextNativeSample, nonNegativeStart);
    const availableFrames = Math.max(0, input.numberOfFrames - sourceFrameOffset);
    const frameCount = Math.min(
        availableFrames,
        Math.max(0, input.declaredNativeSampleCount - destinationStartFrame),
    );
    if (frameCount <= 0) return null;
    return {
        gapFrames: Math.max(0, destinationStartFrame - input.nextNativeSample),
        sourceFrameOffset,
        frameCount,
        destinationStartFrame,
        destinationEndFrame: destinationStartFrame + frameCount,
    };
}

export function downmixEditorialChannelsToMono(
    numberOfChannels: number,
    frameCount: number,
    readChannel: (channelIndex: number) => ArrayLike<number>,
): Float64Array {
    if (!Number.isSafeInteger(numberOfChannels) || numberOfChannels <= 0
        || !Number.isSafeInteger(frameCount) || frameCount < 0) {
        throw new Error('Editorial downmix shape is invalid.');
    }
    const mono = new Float64Array(frameCount);
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
        const plane = readChannel(channel);
        if (plane.length !== frameCount) throw new Error('Editorial decoded channel length changed.');
        for (let frame = 0; frame < frameCount; frame += 1) {
            const value = plane[frame];
            mono[frame] += Number.isFinite(value) ? value : 0;
        }
    }
    // Divide once after the stable channel-order sum so "arithmetic mean" has one frozen
    // Float64 evaluation order instead of accumulating independently rounded quotients.
    for (let frame = 0; frame < frameCount; frame += 1) {
        mono[frame] /= numberOfChannels;
    }
    return mono;
}

/** Quantizes one normalized sample exactly once, without dither. */
export function quantizeEditorialPcm16(value: number): number {
    const sanitized = Number.isFinite(value) ? value : 0;
    const clamped = Math.max(-1, Math.min(1, sanitized));
    if (clamped < 0) {
        return Math.max(-32_768, -Math.round(-clamped * 32_768));
    }
    return Math.min(32_767, Math.round(clamped * 32_767));
}

function greatestCommonDivisor(left: number, right: number): number {
    let a = left;
    let b = right;
    while (b !== 0) [a, b] = [b, a % b];
    return a || 1;
}
