import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const taps = 64;
const phases = 1024;
const beta = 8.6;
const outputRateHz = 16_000;
const inputRates = [44_100, 48_000];
const target = fileURLToPath(new URL('../resampler-coefficients.generated.ts', import.meta.url));

function besselI0(value) {
    const scaled = value * value / 4;
    let sum = 1;
    let term = 1;
    for (let index = 1; index < 40; index += 1) {
        term *= scaled / (index * index);
        sum += term;
        if (term <= sum * Number.EPSILON) break;
    }
    return sum;
}

function sinc(value) {
    return value === 0 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value);
}

function createTable(inputRateHz) {
    const table = new Float64Array(taps * phases);
    const cutoff = 0.94 * Math.min(inputRateHz, outputRateHz) / inputRateHz;
    const i0Beta = besselI0(beta);
    for (let phase = 0; phase < phases; phase += 1) {
        const fraction = phase / phases;
        let sum = 0;
        for (let tap = 0; tap < taps; tap += 1) {
            const windowPosition = 2 * tap / (taps - 1) - 1;
            const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - windowPosition ** 2))) / i0Beta;
            const distance = tap - (taps / 2 - 1) - fraction;
            const coefficient = cutoff * sinc(cutoff * distance) * window;
            table[phase * taps + tap] = coefficient;
            sum += coefficient;
        }
        for (let tap = 0; tap < taps; tap += 1) {
            table[phase * taps + tap] /= sum;
        }
    }
    const bytes = Buffer.alloc(table.length * Float64Array.BYTES_PER_ELEMENT);
    for (let index = 0; index < table.length; index += 1) {
        bytes.writeDoubleLE(table[index], index * Float64Array.BYTES_PER_ELEMENT);
    }
    return bytes.toString('base64');
}

function wrapBase64(value) {
    return value.match(/.{1,120}/g).map(chunk => `        '${chunk}',`).join('\n');
}

const entries = inputRates.map(inputRateHz => `    ${inputRateHz}: [\n${
    wrapBase64(createTable(inputRateHz))
    }\n    ].join(''),`).join('\n');
const source = `/**
 * Generated immutable coefficient bytes for sinc64-kaiser8.6-p1024-v1.
 *
 * Regenerate only when pcmAlgorithmVersion changes, then verify the checked-in SHA-256 fixture.
 * Byte encoding is phase-major Float64 little-endian.
 */
export const PRECOMPUTED_EDITORIAL_RESAMPLER_COEFFICIENTS_BASE64: Readonly<Record<number, string>> = {
${entries}
};
`;

await writeFile(target, source, 'utf8');
