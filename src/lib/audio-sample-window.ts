export interface AudioSampleWindowDescriptor {
    /** Timestamp of the first decoded sample centre relative to media time zero. */
    timestampSeconds: number;
    sampleRate: number;
    frameCount: number;
}

export interface AudioSampleWindowData extends AudioSampleWindowDescriptor {
    channels: readonly Float32Array[];
}

export interface SanitizedAudioWindowSpan {
    windowIndex: number;
    sourceStartSample: number;
    sourceEndSample: number;
    /**
     * Fractional positions in the decoded window's native frame domain. Consumers use these
     * positions as half-open boundaries when the decoder rate differs from the source rate.
     */
    windowStartPosition: number;
    windowEndPosition: number;
}

export interface AudioSampleSilenceRange {
    startSample: number;
    endSample: number;
}

export interface SanitizedAudioWindowPlan {
    nativeSampleRate: number;
    totalSampleCount: number;
    spans: SanitizedAudioWindowSpan[];
    silenceRanges: AudioSampleSilenceRange[];
}

export interface AudioSampleWindowPlanOptions {
    nativeSampleRate: number;
    /** A declared sample count is preferred because it does not inherit duration rounding. */
    declaredSampleCount?: number;
    declaredDurationSeconds?: number;
}

export interface MaterializeSanitizedAudioRangeOptions {
    startSample: number;
    endSample: number;
    channelCount: number;
}

/**
 * Converts timestamped decoder windows into a deterministic native-sample coverage plan.
 *
 * Containers can expose negative priming timestamps, timestamp gaps, overlapping packets, and
 * decoder output at a rate different from the metadata rate. All timestamp boundaries are
 * mapped from the common time origin. This is important: adding separately rounded durations
 * would accumulate drift and could manufacture one-sample gaps between otherwise adjacent
 * windows.
 *
 * Windows are ordered by media time and then decode order. Coverage already claimed by an
 * earlier window is never overwritten (first-write-wins), while the declared source duration
 * supplies a final silent tail when decoding stops early.
 */
export function buildSanitizedAudioWindowPlan(
    windows: readonly AudioSampleWindowDescriptor[],
    options: AudioSampleWindowPlanOptions,
): SanitizedAudioWindowPlan {
    assertSampleRate(options.nativeSampleRate, 'nativeSampleRate');
    const declaredSampleCount = resolveDeclaredSampleCount(options);

    const mapped = windows.map((window, windowIndex) => {
        validateWindow(window);
        const exactStartSample = window.timestampSeconds * options.nativeSampleRate;
        const exactEndSample = (
            window.timestampSeconds + window.frameCount / window.sampleRate
        ) * options.nativeSampleRate;
        return {
            window,
            windowIndex,
            startSample: Math.round(exactStartSample),
            endSample: Math.round(exactEndSample),
        };
    }).sort((left, right) => (
        left.startSample - right.startSample
        || left.windowIndex - right.windowIndex
    ));

    const inferredSampleCount = mapped.reduce(
        (maximum, window) => Math.max(maximum, window.endSample),
        0,
    );
    const totalSampleCount = declaredSampleCount ?? inferredSampleCount;
    const spans: SanitizedAudioWindowSpan[] = [];
    let coverageCursor = 0;

    mapped.forEach(({ window, windowIndex, startSample, endSample }) => {
        if (coverageCursor >= totalSampleCount || endSample <= coverageCursor || startSample >= totalSampleCount) {
            return;
        }

        const sourceStartSample = Math.max(0, coverageCursor, startSample);
        const sourceEndSample = Math.min(totalSampleCount, endSample);
        if (sourceEndSample <= sourceStartSample) return;

        // Translate the sanitized native-sample boundaries back through time instead of using a
        // rounded decoded-frame offset. Fractional positions preserve rate-conversion accuracy.
        const windowStartPosition = snapNearInteger((
            sourceStartSample / options.nativeSampleRate - window.timestampSeconds
        ) * window.sampleRate);
        const windowEndPosition = snapNearInteger((
            sourceEndSample / options.nativeSampleRate - window.timestampSeconds
        ) * window.sampleRate);
        spans.push({
            windowIndex,
            sourceStartSample,
            sourceEndSample,
            windowStartPosition: clamp(windowStartPosition, 0, window.frameCount),
            windowEndPosition: clamp(windowEndPosition, 0, window.frameCount),
        });
        coverageCursor = sourceEndSample;
    });

    return {
        nativeSampleRate: options.nativeSampleRate,
        totalSampleCount,
        spans,
        silenceRanges: findCoverageGaps(spans, totalSampleCount),
    };
}

/**
 * Materializes a sanitized plan into zero-initialized native-rate channels. This helper is kept
 * independent of any decoder API so preview and export adapters can feed it synthetic arrays in
 * tests or decoded Mediabunny windows later. Non-covered ranges remain exact zeroes, and the
 * plan's non-overlapping spans guarantee that later overlapping windows cannot overwrite an
 * earlier write.
 */
export function materializeSanitizedAudioWindows(
    windows: readonly AudioSampleWindowData[],
    plan: SanitizedAudioWindowPlan,
    channelCount: number,
): Float32Array[] {
    if (!Number.isSafeInteger(channelCount) || channelCount <= 0) {
        throw new RangeError('channelCount must be a positive safe integer.');
    }
    const output = Array.from(
        { length: channelCount },
        () => new Float32Array(plan.totalSampleCount),
    );

    plan.spans.forEach((span) => {
        const window = windows[span.windowIndex];
        if (!window) throw new RangeError(`Missing decoded audio window ${span.windowIndex}.`);
        validateWindowData(window);
        const outputCount = span.sourceEndSample - span.sourceStartSample;

        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            const source = window.channels[channelIndex];
            if (!source) continue;
            for (let index = 0; index < outputCount; index += 1) {
                const position = span.windowStartPosition
                    + (index + 0.5)
                    * (span.windowEndPosition - span.windowStartPosition)
                    / outputCount
                    - 0.5;
                output[channelIndex][span.sourceStartSample + index] = interpolate(source, position);
            }
        }
    });
    return output;
}

/**
 * Materializes only one absolute native-sample interval from a sanitization plan.
 *
 * Preview requests repeatedly decode small windows from potentially multi-hour files. Allocating
 * `plan.totalSampleCount` for each request would defeat bounded scheduling, so this variant keeps
 * its output proportional to the requested range while preserving the same timestamp-gap and
 * first-write-wins rules as the complete materializer.
 */
export function materializeSanitizedAudioWindowRange(
    windows: readonly AudioSampleWindowData[],
    plan: SanitizedAudioWindowPlan,
    options: MaterializeSanitizedAudioRangeOptions,
): Float32Array[] {
    const { startSample, endSample, channelCount } = options;
    if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSample)
        || startSample < 0 || endSample < startSample || endSample > plan.totalSampleCount) {
        throw new RangeError('Audio materialization range must be inside the sanitized plan.');
    }
    if (!Number.isSafeInteger(channelCount) || channelCount <= 0) {
        throw new RangeError('channelCount must be a positive safe integer.');
    }
    const output = Array.from(
        { length: channelCount },
        () => new Float32Array(endSample - startSample),
    );

    plan.spans.forEach((span) => {
        const intersectionStart = Math.max(startSample, span.sourceStartSample);
        const intersectionEnd = Math.min(endSample, span.sourceEndSample);
        if (intersectionEnd <= intersectionStart) return;
        const window = windows[span.windowIndex];
        if (!window) throw new RangeError(`Missing decoded audio window ${span.windowIndex}.`);
        validateWindowData(window);
        const spanOutputCount = span.sourceEndSample - span.sourceStartSample;

        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            const source = window.channels[channelIndex];
            if (!source) continue;
            for (let absoluteSample = intersectionStart; absoluteSample < intersectionEnd; absoluteSample += 1) {
                const spanIndex = absoluteSample - span.sourceStartSample;
                const position = span.windowStartPosition
                    + (spanIndex + 0.5)
                    * (span.windowEndPosition - span.windowStartPosition)
                    / spanOutputCount
                    - 0.5;
                output[channelIndex][absoluteSample - startSample] = interpolate(source, position);
            }
        }
    });
    return output;
}

function resolveDeclaredSampleCount(options: AudioSampleWindowPlanOptions): number | undefined {
    if (options.declaredSampleCount !== undefined) {
        if (!Number.isSafeInteger(options.declaredSampleCount) || options.declaredSampleCount < 0) {
            throw new RangeError('declaredSampleCount must be a non-negative safe integer.');
        }
        return options.declaredSampleCount;
    }
    if (options.declaredDurationSeconds === undefined) return undefined;
    if (!Number.isFinite(options.declaredDurationSeconds) || options.declaredDurationSeconds < 0) {
        throw new RangeError('declaredDurationSeconds must be non-negative and finite.');
    }
    const sampleCount = Math.round(options.declaredDurationSeconds * options.nativeSampleRate);
    if (!Number.isSafeInteger(sampleCount)) {
        throw new RangeError('The declared audio duration exceeds the safe sample-count range.');
    }
    return sampleCount;
}

function findCoverageGaps(
    spans: readonly SanitizedAudioWindowSpan[],
    totalSampleCount: number,
): AudioSampleSilenceRange[] {
    const gaps: AudioSampleSilenceRange[] = [];
    let cursor = 0;
    spans.forEach((span) => {
        if (span.sourceStartSample > cursor) {
            gaps.push({ startSample: cursor, endSample: span.sourceStartSample });
        }
        cursor = span.sourceEndSample;
    });
    if (cursor < totalSampleCount) gaps.push({ startSample: cursor, endSample: totalSampleCount });
    return gaps;
}

function validateWindow(window: AudioSampleWindowDescriptor): void {
    if (!Number.isFinite(window.timestampSeconds)) {
        throw new RangeError('Audio window timestamps must be finite.');
    }
    assertSampleRate(window.sampleRate, 'window.sampleRate');
    if (!Number.isSafeInteger(window.frameCount) || window.frameCount < 0) {
        throw new RangeError('Audio window frameCount must be a non-negative safe integer.');
    }
}

function validateWindowData(window: AudioSampleWindowData): void {
    validateWindow(window);
    if (window.channels.length === 0 || window.channels.some((channel) => channel.length !== window.frameCount)) {
        throw new RangeError('Decoded window channels must match frameCount and cannot be empty.');
    }
}

function assertSampleRate(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer.`);
    }
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}

function snapNearInteger(value: number): number {
    const integer = Math.round(value);
    return Math.abs(value - integer) <= Number.EPSILON * Math.max(1, Math.abs(value)) * 8
        ? integer
        : value;
}

function interpolate(source: Float32Array, position: number): number {
    if (source.length === 0) return 0;
    const bounded = clamp(position, 0, source.length - 1);
    const leftIndex = Math.floor(bounded);
    const rightIndex = Math.min(source.length - 1, leftIndex + 1);
    const fraction = bounded - leftIndex;
    return source[leftIndex] * (1 - fraction) + source[rightIndex] * fraction;
}
