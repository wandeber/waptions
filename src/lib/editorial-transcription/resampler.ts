import { PRECOMPUTED_EDITORIAL_RESAMPLER_COEFFICIENTS_BASE64 } from './resampler-coefficients.generated';

export const EDITORIAL_RESAMPLER_ID = 'sinc64-kaiser8.6-p1024-v1';
export const EDITORIAL_RESAMPLER_TAPS = 64;
export const EDITORIAL_RESAMPLER_PHASES = 1024;
export const EDITORIAL_RESAMPLER_KAISER_BETA = 8.6;
export const EDITORIAL_RESAMPLER_CUTOFF_SCALE = 0.94;

const coefficientCache = new Map<string, Float64Array>();

/** Native rates whose immutable V1 coefficient bytes ship with the application. */
export const SUPPORTED_EDITORIAL_PCM_NATIVE_SAMPLE_RATES = Object.freeze(
    Object.keys(PRECOMPUTED_EDITORIAL_RESAMPLER_COEFFICIENTS_BASE64)
        .map(Number)
        .sort((left, right) => left - right),
);

export function isSupportedEditorialPcmNativeSampleRate(sampleRateHz: number): boolean {
    return Object.prototype.hasOwnProperty.call(
        PRECOMPUTED_EDITORIAL_RESAMPLER_COEFFICIENTS_BASE64,
        sampleRateHz,
    );
}

/**
 * Builds the V1 polyphase coefficient table for one stable native sample rate.
 *
 * Coefficients are normalized independently per phase to unity DC. Production accepts only the
 * native rates with checked-in bytes and verified digests. Adding another rate is therefore a
 * reviewed PCM-algorithm fixture change rather than a browser-dependent runtime calculation.
 */
export function createEditorialResamplerCoefficientTable(
    inputRateHz: number,
    outputRateHz = 16_000,
): Float64Array {
    assertSampleRate(inputRateHz, 'input');
    assertSampleRate(outputRateHz, 'output');
    const cacheKey = `${inputRateHz}:${outputRateHz}`;
    const cached = coefficientCache.get(cacheKey);
    if (cached) return cached.slice();

    const precomputed = outputRateHz === 16_000
        ? PRECOMPUTED_EDITORIAL_RESAMPLER_COEFFICIENTS_BASE64[inputRateHz]
        : undefined;
    if (precomputed) {
        const table = decodePrecomputedCoefficientTable(precomputed);
        coefficientCache.set(cacheKey, table);
        return table.slice();
    }
    throw new Error(
        `Editorial PCM v1 does not include an immutable ${inputRateHz} Hz to ${outputRateHz} Hz coefficient table.`,
    );
}

function decodePrecomputedCoefficientTable(encoded: string): Float64Array {
    const binary = atob(encoded);
    const expectedBytes = EDITORIAL_RESAMPLER_TAPS
        * EDITORIAL_RESAMPLER_PHASES
        * Float64Array.BYTES_PER_ELEMENT;
    if (binary.length !== expectedBytes) {
        throw new Error('Checked-in editorial resampler coefficient table is corrupt.');
    }
    const view = new DataView(new ArrayBuffer(expectedBytes));
    for (let index = 0; index < binary.length; index += 1) {
        view.setUint8(index, binary.charCodeAt(index));
    }
    const table = new Float64Array(EDITORIAL_RESAMPLER_TAPS * EDITORIAL_RESAMPLER_PHASES);
    for (let index = 0; index < table.length; index += 1) {
        table[index] = view.getFloat64(index * Float64Array.BYTES_PER_ELEMENT, true);
    }
    return table;
}

export function serializeEditorialResamplerCoefficients(table: Float64Array): Uint8Array {
    const bytes = new Uint8Array(table.length * Float64Array.BYTES_PER_ELEMENT);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < table.length; index += 1) {
        // Explicit little-endian serialization makes digest fixtures independent of host byte
        // order even though all supported browsers currently use little-endian typed arrays.
        view.setFloat64(index * Float64Array.BYTES_PER_ELEMENT, table[index], true);
    }
    return bytes;
}

export interface StreamingEditorialResamplerOptions {
    inputRateHz: number;
    outputRateHz?: number;
    targetSampleCount: number;
    coefficientTable?: Float64Array;
}

/**
 * Bounded streaming polyphase resampler.
 *
 * The integer source cursor and remainder are the complete phase authority; append boundaries
 * never reset either value. Only the 64-tap support plus the latest caller chunk remains live.
 * finish() supplies zero support beyond the declared native interval and emits exactly the
 * caller-provided target count.
 */
export class StreamingEditorialResampler {
    private readonly inputRateHz: number;
    private readonly outputRateHz: number;
    private readonly targetSampleCount: number;
    private readonly coefficients: Float64Array;
    private buffer: number[] = [];
    private bufferOffset = 0;
    private bufferStartSample = 0;
    private receivedSampleCount = 0;
    private sourceSampleIndex = 0;
    private phaseRemainder = 0;
    private outputSampleCount = 0;
    private finished = false;

    constructor(options: StreamingEditorialResamplerOptions) {
        assertSampleRate(options.inputRateHz, 'input');
        this.inputRateHz = options.inputRateHz;
        this.outputRateHz = options.outputRateHz ?? 16_000;
        assertSampleRate(this.outputRateHz, 'output');
        if (!Number.isSafeInteger(options.targetSampleCount) || options.targetSampleCount < 0) {
            throw new Error('Editorial resampler target count must be a non-negative safe integer.');
        }
        this.targetSampleCount = options.targetSampleCount;
        this.coefficients = options.coefficientTable
            ? options.coefficientTable.slice()
            : createEditorialResamplerCoefficientTable(this.inputRateHz, this.outputRateHz);
        if (this.coefficients.length !== EDITORIAL_RESAMPLER_TAPS * EDITORIAL_RESAMPLER_PHASES) {
            throw new Error('Editorial resampler coefficient table has the wrong length.');
        }
    }

    append(samples: ArrayLike<number>): Float64Array {
        if (this.finished) throw new Error('Editorial resampler is already finished.');
        for (let index = 0; index < samples.length; index += 1) {
            const sample = samples[index];
            this.buffer.push(Number.isFinite(sample) ? sample : 0);
        }
        this.receivedSampleCount += samples.length;
        return this.drain(false);
    }

    appendZeros(
        sampleCount: number,
        consume: (output: Float64Array) => void,
        chunkSize = 16_384,
    ): void {
        if (!Number.isSafeInteger(sampleCount) || sampleCount < 0) {
            throw new Error('Editorial zero-fill count must be a non-negative safe integer.');
        }
        const zeroChunk = new Float64Array(Math.max(1, Math.min(chunkSize, sampleCount || 1)));
        for (let remaining = sampleCount; remaining > 0;) {
            const count = Math.min(remaining, zeroChunk.length);
            const output = this.append(
                count === zeroChunk.length ? zeroChunk : zeroChunk.subarray(0, count),
            );
            // Consume each bounded resampler result immediately. Returning an array of chunks
            // would accidentally retain an entire multi-hour leading/trailing gap in memory.
            if (output.length > 0) consume(output);
            remaining -= count;
        }
    }

    finish(): Float64Array {
        if (this.finished) throw new Error('Editorial resampler is already finished.');
        this.finished = true;
        const output = this.drain(true);
        this.buffer = [];
        this.bufferOffset = 0;
        return output;
    }

    dispose(): void {
        this.finished = true;
        this.buffer = [];
        this.bufferOffset = 0;
    }

    private drain(allowFutureZero: boolean): Float64Array {
        const output: number[] = [];
        while (this.outputSampleCount < this.targetSampleCount) {
            const baseSample = this.sourceSampleIndex - (EDITORIAL_RESAMPLER_TAPS / 2 - 1);
            const maximumRequiredSample = baseSample + EDITORIAL_RESAMPLER_TAPS - 1;
            if (!allowFutureZero && maximumRequiredSample >= this.receivedSampleCount) break;
            const phase = Math.floor(
                this.phaseRemainder * EDITORIAL_RESAMPLER_PHASES / this.outputRateHz,
            );
            let value = 0;
            const coefficientOffset = phase * EDITORIAL_RESAMPLER_TAPS;
            for (let tap = 0; tap < EDITORIAL_RESAMPLER_TAPS; tap += 1) {
                value += this.readSample(baseSample + tap, allowFutureZero)
                    * this.coefficients[coefficientOffset + tap];
            }
            output.push(value);
            this.outputSampleCount += 1;
            this.phaseRemainder += this.inputRateHz;
            this.sourceSampleIndex += Math.floor(this.phaseRemainder / this.outputRateHz);
            this.phaseRemainder %= this.outputRateHz;
            this.releaseConsumedPrefix();
        }
        return Float64Array.from(output);
    }

    private readSample(sampleIndex: number, allowFutureZero: boolean): number {
        if (sampleIndex < 0) return 0;
        if (sampleIndex >= this.receivedSampleCount) {
            if (allowFutureZero) return 0;
            throw new Error('Editorial resampler attempted to read future input.');
        }
        const index = this.bufferOffset + sampleIndex - this.bufferStartSample;
        return this.buffer[index] ?? 0;
    }

    private releaseConsumedPrefix(): void {
        const minimumNeeded = Math.max(
            0,
            this.sourceSampleIndex - (EDITORIAL_RESAMPLER_TAPS / 2 - 1),
        );
        const releasable = Math.max(0, minimumNeeded - this.bufferStartSample);
        this.bufferStartSample += releasable;
        this.bufferOffset += releasable;
        if (this.bufferOffset >= 32_768 && this.bufferOffset * 2 >= this.buffer.length) {
            this.buffer = this.buffer.slice(this.bufferOffset);
            this.bufferOffset = 0;
        }
    }
}

function assertSampleRate(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Editorial resampler ${name} rate must be a positive safe integer.`);
    }
}
