import type { AudioMixContributor, AudioMixPlan } from './audio-mix-plan';

export const AUDIO_MIX_CHUNK_SIZE = 4_096;
export const AUDIO_LIMITER_THRESHOLD = 0.999;

export interface DecodedAudioContributor {
    sampleRate: number;
    /** Absolute native-sample index represented by channels[*][0]. */
    startSample: number;
    channels: readonly Float32Array[];
}

export interface DecodeAudioContributorRequest {
    /** Half-open project-output interval needed by the mixer. */
    outputStartSample: number;
    outputEndSample: number;
    signal?: AbortSignal;
    generation?: number;
}

/**
 * Decoders receive a bounded output request instead of a request for the complete media file.
 * They may include one native sample of interpolation padding on either side of the requested
 * span; `startSample` tells the mixer where that returned window lives on the source clock.
 */
export type AudioContributorDecoder = (
    contributor: AudioMixContributor,
    request: DecodeAudioContributorRequest,
) => Promise<DecodedAudioContributor> | DecodedAudioContributor;

export interface RenderAudioMixOptions {
    startSample?: number;
    endSample?: number;
    chunkSize?: number;
    limiterThreshold?: number;
    signal?: AbortSignal;
    generation?: number;
}

export interface RenderedAudioMix {
    sampleRate: 48_000;
    startSample: number;
    endSample: number;
    channels: [Float32Array, Float32Array];
}

/** Resamples a half-open source span using sample-centre positions. */
export function resampleLinearSpan(
    source: Float32Array,
    startPosition: number,
    endPosition: number,
    outputSampleCount: number,
): Float64Array {
    assertOutputSampleCount(outputSampleCount);
    const result = new Float64Array(outputSampleCount);
    for (let index = 0; index < outputSampleCount; index += 1) {
        result[index] = interpolateSample(source, getSourceCentrePosition(
            startPosition,
            endPosition,
            outputSampleCount,
            index,
        ));
    }
    return result;
}

/**
 * Applies the explicit channel policy used by preview and export. Centre and surround channels
 * are folded at -3 dB and LFE at -6 dB; a linked limiter is applied after contributors are summed.
 */
export function downmixFrameToStereo(samples: readonly number[]): [number, number] {
    if (samples.length === 0) return [0, 0];
    if (samples.length === 1) return [samples[0], samples[0]];
    if (samples.length === 2) return [samples[0], samples[1]];

    const minus3Db = Math.SQRT1_2;
    const frontLeft = samples[0] ?? 0;
    const frontRight = samples[1] ?? 0;
    const center = samples.length === 4 ? 0 : (samples[2] ?? 0);
    const lfe = samples.length >= 6 ? (samples[3] ?? 0) : 0;
    let surroundLeft = 0;
    let surroundRight = 0;
    if (samples.length === 4) {
        surroundLeft = samples[2] ?? 0;
        surroundRight = samples[3] ?? 0;
    } else if (samples.length === 5) {
        surroundLeft = samples[3] ?? 0;
        surroundRight = samples[4] ?? 0;
    } else if (samples.length === 6) {
        surroundLeft = samples[4] ?? 0;
        surroundRight = samples[5] ?? 0;
    } else if (samples.length > 6) {
        surroundLeft = (samples[4] ?? 0) + (samples[6] ?? 0);
        surroundRight = (samples[5] ?? 0) + (samples[7] ?? 0);
    }
    return [
        frontLeft + center * minus3Db + lfe * 0.5 + surroundLeft * minus3Db,
        frontRight + center * minus3Db + lfe * 0.5 + surroundRight * minus3Db,
    ];
}

/** A hard linked peak limiter preserves stereo balance by applying one gain to both channels. */
export function limitLinkedStereoFrame(
    left: number,
    right: number,
    threshold = AUDIO_LIMITER_THRESHOLD,
): [number, number] {
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
        throw new RangeError('Limiter threshold must be in the interval (0, 1].');
    }
    const peak = Math.max(Math.abs(left), Math.abs(right));
    if (peak <= threshold) return [left, right];
    const gain = threshold / peak;
    return [left * gain, right * gain];
}

/**
 * Renders a deterministic, bounded window of the canonical stereo 48 kHz mix.
 *
 * Decoding is deliberately performed contributor-by-contributor inside each bounded mix chunk.
 * This avoids `Promise.all` over whole files, keeps peak decoder memory predictable, and provides
 * the exact same function to preview and export. Source positions and fades are always derived
 * from the complete contributor, so rendering a slice or changing chunk boundaries cannot alter
 * the samples in their shared interval.
 */
export async function renderAudioMixPlan(
    plan: AudioMixPlan,
    decode: AudioContributorDecoder,
    options: RenderAudioMixOptions = {},
): Promise<RenderedAudioMix> {
    const startSample = options.startSample ?? 0;
    const endSample = options.endSample ?? plan.totalSampleCount;
    validateRenderRange(startSample, endSample, plan.totalSampleCount);
    const chunkSize = options.chunkSize ?? AUDIO_MIX_CHUNK_SIZE;
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
        throw new RangeError('Audio mix chunkSize must be a positive safe integer.');
    }

    const outputLeft = new Float32Array(endSample - startSample);
    const outputRight = new Float32Array(endSample - startSample);
    for (let chunkStart = startSample; chunkStart < endSample; chunkStart += chunkSize) {
        throwIfAborted(options.signal);
        const chunkEnd = Math.min(endSample, chunkStart + chunkSize);
        const mixedLeft = new Float64Array(chunkEnd - chunkStart);
        const mixedRight = new Float64Array(chunkEnd - chunkStart);
        const active = plan.contributors.filter((contributor) => (
            contributor.outputEndSample > chunkStart && contributor.outputStartSample < chunkEnd
        ));

        // Sequential bounded decoding prevents several compressed streams from retaining large
        // WebCodecs sample queues at once. Each adapter closes its samples before resolving.
        for (const contributor of active) {
            throwIfAborted(options.signal);
            const intersectionStart = Math.max(chunkStart, contributor.outputStartSample);
            const intersectionEnd = Math.min(chunkEnd, contributor.outputEndSample);
            const audio = await decode(contributor, {
                outputStartSample: intersectionStart,
                outputEndSample: intersectionEnd,
                signal: options.signal,
                generation: options.generation,
            });
            validateDecodedAudio(audio);
            mixContributorRange(
                contributor,
                audio,
                intersectionStart,
                intersectionEnd,
                chunkStart,
                mixedLeft,
                mixedRight,
            );
        }

        for (let index = 0; index < mixedLeft.length; index += 1) {
            const [left, right] = limitLinkedStereoFrame(
                mixedLeft[index],
                mixedRight[index],
                options.limiterThreshold,
            );
            const outputIndex = chunkStart - startSample + index;
            outputLeft[outputIndex] = left;
            outputRight[outputIndex] = right;
        }
    }
    return {
        sampleRate: plan.sampleRate,
        startSample,
        endSample,
        channels: [outputLeft, outputRight],
    };
}

/** Alias that makes the bounded shared preview/export contract explicit at call sites. */
export const renderAudioMixWindow = renderAudioMixPlan;

function mixContributorRange(
    contributor: AudioMixContributor,
    audio: DecodedAudioContributor,
    outputStart: number,
    outputEnd: number,
    chunkStart: number,
    mixedLeft: Float64Array,
    mixedRight: Float64Array,
): void {
    const contributorOutputCount = contributor.outputEndSample - contributor.outputStartSample;
    const [sourceStart, sourceEnd] = resolveDecodedSourceSpan(contributor, audio.sampleRate);
    const channelValues = new Array<number>(audio.channels.length);
    for (let outputSample = outputStart; outputSample < outputEnd; outputSample += 1) {
        const contributorIndex = outputSample - contributor.outputStartSample;
        const sourcePosition = getSourceCentrePosition(
            sourceStart,
            sourceEnd,
            contributorOutputCount,
            contributorIndex,
        );
        audio.channels.forEach((channel, channelIndex) => {
            channelValues[channelIndex] = interpolateAbsoluteSample(
                channel,
                audio.startSample,
                sourcePosition,
            );
        });
        const [left, right] = downmixFrameToStereo(channelValues);
        const fade = Math.min(
            fadeInGain(contributorIndex + 0.5, contributor.fadeInSamples),
            fadeOutGain(
                contributorOutputCount - contributorIndex - 0.5,
                contributor.fadeOutSamples,
            ),
        );
        const gain = contributor.gainLinear * fade;
        const chunkIndex = outputSample - chunkStart;
        mixedLeft[chunkIndex] += left * gain;
        mixedRight[chunkIndex] += right * gain;
    }
}

export function resolveContributorSourceSpan(
    contributor: AudioMixContributor,
    decodedSampleRate: number,
): [number, number] {
    return resolveDecodedSourceSpan(contributor, decodedSampleRate);
}

function resolveDecodedSourceSpan(
    contributor: AudioMixContributor,
    decodedSampleRate: number,
): [number, number] {
    if (contributor.sourceRange.domain === 'seconds') {
        return [
            contributor.sourceRange.startSeconds * decodedSampleRate,
            contributor.sourceRange.endSeconds * decodedSampleRate,
        ];
    }
    const ratio = decodedSampleRate / contributor.sourceRange.sampleRate;
    return [
        contributor.sourceRange.startSample * ratio,
        contributor.sourceRange.endSample * ratio,
    ];
}

function fadeInGain(position: number, fadeLength: number): number {
    return fadeLength <= 0 ? 1 : clamp(position / fadeLength, 0, 1);
}

function fadeOutGain(remaining: number, fadeLength: number): number {
    return fadeLength <= 0 ? 1 : clamp(remaining / fadeLength, 0, 1);
}

function getSourceCentrePosition(
    startPosition: number,
    endPosition: number,
    outputSampleCount: number,
    outputIndex: number,
): number {
    return startPosition
        + (outputIndex + 0.5) * (endPosition - startPosition) / outputSampleCount
        - 0.5;
}

function interpolateAbsoluteSample(
    source: Float32Array,
    sourceStartSample: number,
    absolutePosition: number,
): number {
    return interpolateSample(source, absolutePosition - sourceStartSample);
}

function interpolateSample(source: Float32Array, position: number): number {
    if (source.length === 0) return 0;
    // Missing decoded coverage is represented by explicit zero-filled windows. Clamping here is
    // only interpolation padding at the physical media boundary, never timestamp-gap filling.
    const bounded = clamp(position, 0, source.length - 1);
    const leftIndex = Math.floor(bounded);
    const rightIndex = Math.min(source.length - 1, leftIndex + 1);
    const fraction = bounded - leftIndex;
    return source[leftIndex] * (1 - fraction) + source[rightIndex] * fraction;
}

function validateDecodedAudio(audio: DecodedAudioContributor): void {
    if (!Number.isSafeInteger(audio.sampleRate) || audio.sampleRate <= 0) {
        throw new RangeError('Decoded audio sampleRate must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(audio.startSample)) {
        throw new RangeError('Decoded audio startSample must be a safe integer.');
    }
    if (audio.channels.length === 0) {
        throw new RangeError('Decoded audio must contain at least one channel.');
    }
    const frameCount = audio.channels[0].length;
    if (audio.channels.some((channel) => channel.length !== frameCount)) {
        throw new RangeError('Decoded audio channels must have identical frame counts.');
    }
}

function validateRenderRange(startSample: number, endSample: number, totalSampleCount: number): void {
    if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSample)
        || startSample < 0 || endSample < startSample || endSample > totalSampleCount) {
        throw new RangeError('Audio render range must be a valid half-open interval inside the mix.');
    }
}

function assertOutputSampleCount(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError('outputSampleCount must be a non-negative safe integer.');
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Audio rendering was aborted.', 'AbortError');
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}
