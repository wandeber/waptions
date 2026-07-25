import type {
    AudioTranscriptionSourceJob,
} from '@/lib/audio-transcription-plan';
import { getSourceRangeSeconds } from '@/lib/audio-transcription-plan';
import {
    ceilRationalSampleCount,
    type RationalDuration,
} from '@/lib/editorial-transcription/pcm';
import { createMediabunnyEditorialPcmWindowDecoder } from '@/lib/editorial-transcription/pcm-window-decoder';
import {
    planIncrementalTranscriptionCoverage,
    type IncrementalCoveragePlan,
} from '@/lib/editorial-transcription/range-coverage';
import { createPcm16WavBlob } from '@/lib/editorial-transcription/wav';
import { EditorialPcmWindowRepository } from '@/lib/storage/editorial-pcm-window-cache';
import type { HalfOpenSampleRange, TranscriptionAcquisitionWindowV2 } from '@/types/editorial';
import type { AudioMediaAsset } from '@/lib/media-asset-ref';

const TRANSCRIPTION_SAMPLE_RATE = 16_000;
const DEFAULT_CONTEXT_SAMPLES = 2 * TRANSCRIPTION_SAMPLE_RATE;
const MAX_WORDS_PER_WINDOW = 100_000;
const MAX_WORD_CHARACTERS = 4_096;
const WINDOW_PROFILE_DIGEST = `sha256:${'0'.repeat(64)}` as const;

export interface BoundedSourceTranscriptionWindow {
    window: TranscriptionAcquisitionWindowV2;
    pcm: Int16Array;
    wav: Blob;
}

export interface SourceTimedWord {
    word: string;
    start: number;
    end: number;
}

/** Pure range planner shared by all per-source subtitle acquisition routes. */
export async function createBoundedSourceTranscriptionPlan(input: {
    job: AudioTranscriptionSourceJob;
    sourceFingerprint: string;
    sourceDurationSeconds: number;
    contextSamples?: number;
}): Promise<IncrementalCoveragePlan> {
    const sourceSampleCount = ceilRationalSampleCount(
        secondsAsRationalDuration(input.sourceDurationSeconds),
        TRANSCRIPTION_SAMPLE_RATE,
    );
    return planIncrementalTranscriptionCoverage({
        profile: {
            sourceFingerprint: input.sourceFingerprint,
            sourceSampleRate: TRANSCRIPTION_SAMPLE_RATE,
            sourceSampleCount,
            coreCoverage: sourceCoverageAt16k(input.job, sourceSampleCount),
            contextSamples: input.contextSamples ?? DEFAULT_CONTEXT_SAMPLES,
            language: null,
            speakerMode: 'none',
            endpointIdentityDigest: WINDOW_PROFILE_DIGEST,
            requestedModel: 'bounded-source-subtitles',
            responseSchema: 'verbose-json-words',
            pcmAlgorithmVersion: 1,
            providerProfileVersion: 1,
        },
    });
}

/**
 * Decodes only audible source-time coverage and yields at most one 30-second PCM/WAV window.
 *
 * The async generator retains no prior window. Consumers must finish the request for one yielded
 * value before advancing, preserving a constant media-memory ceiling independently of source size.
 */
export async function* decodeBoundedSourceTranscriptionWindows(input: {
    job: AudioTranscriptionSourceJob;
    media: AudioMediaAsset;
    signal: AbortSignal;
    contextSamples?: number;
    repository?: EditorialPcmWindowRepository;
}): AsyncGenerator<BoundedSourceTranscriptionWindow> {
    const declaredDuration = secondsAsRationalDuration(input.media.asset.duration);
    const plan = await createBoundedSourceTranscriptionPlan({
        job: input.job,
        sourceFingerprint: input.media.asset.fingerprint,
        sourceDurationSeconds: input.media.asset.duration,
        contextSamples: input.contextSamples,
    });
    const decoder = createMediabunnyEditorialPcmWindowDecoder({
        resolveSource: fingerprint => fingerprint === input.media.asset.fingerprint
            ? { file: input.media.asset.file, declaredDuration }
            : null,
    });
    const repository = input.repository ?? new EditorialPcmWindowRepository();
    for (const window of plan.acquisitionWindows) {
        throwIfAborted(input.signal);
        const pcm = await repository.getOrDecode({
            sourceFingerprint: input.media.asset.fingerprint,
            pcmAlgorithmVersion: 1,
            startSample: window.decoded.startSample,
            endSample: window.decoded.endSample,
        }, decoder, { signal: input.signal });
        throwIfAborted(input.signal);
        yield {
            window,
            pcm,
            wav: createPcm16WavBlob([pcm], pcm.length),
        };
    }
}

/** Converts one provider-local word list to immutable source-zero seconds owned by its core. */
export function projectWindowWordsToSource(
    words: readonly SourceTimedWord[],
    window: TranscriptionAcquisitionWindowV2,
): SourceTimedWord[] {
    if (!Array.isArray(words) || words.length > MAX_WORDS_PER_WINDOW) {
        throw new Error('Transcription window returned too many words.');
    }
    return words.flatMap((word) => {
        if (!word || typeof word !== 'object'
            || typeof word.word !== 'string'
            || !word.word.trim()
            || word.word.length > MAX_WORD_CHARACTERS
            || !Number.isFinite(word.start)
            || !Number.isFinite(word.end)
            || word.start < 0
            || word.end <= word.start) return [];
        const startSample = window.decoded.startSample
            + Math.floor(word.start * TRANSCRIPTION_SAMPLE_RATE);
        const endSample = window.decoded.startSample
            + Math.ceil(word.end * TRANSCRIPTION_SAMPLE_RATE);
        const midpoint = startSample + (endSample - startSample) / 2;
        if (midpoint < window.core.startSample || midpoint >= window.core.endSample) return [];
        return [{
            word: word.word.trim(),
            start: Math.max(0, startSample) / TRANSCRIPTION_SAMPLE_RATE,
            end: Math.min(window.decoded.endSample, endSample) / TRANSCRIPTION_SAMPLE_RATE,
        }];
    });
}

export function int16PcmToFloat32(pcm: Int16Array): Float32Array {
    const samples = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index += 1) {
        samples[index] = pcm[index] < 0 ? pcm[index] / 0x8000 : pcm[index] / 0x7fff;
    }
    return samples;
}

function sourceCoverageAt16k(
    job: AudioTranscriptionSourceJob,
    sourceSampleCount: number,
): HalfOpenSampleRange[] {
    return job.placements.map((placement) => {
        const range = getSourceRangeSeconds(placement.sourceRange);
        const startSample = Math.max(
            0,
            Math.min(sourceSampleCount, Math.floor(range.startTime * TRANSCRIPTION_SAMPLE_RATE)),
        );
        const endSample = Math.max(
            0,
            Math.min(sourceSampleCount, Math.ceil(range.endTime * TRANSCRIPTION_SAMPLE_RATE)),
        );
        if (endSample <= startSample) {
            throw new Error('Audible transcription coverage does not retain one source sample.');
        }
        return { startSample, endSample };
    });
}

function secondsAsRationalDuration(seconds: number): RationalDuration {
    if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error('Audio source duration must be finite and non-negative.');
    }
    const denominator = 1_000_000;
    const numerator = Math.round(seconds * denominator);
    if (!Number.isSafeInteger(numerator)) {
        throw new Error('Audio source duration exceeds the supported sample domain.');
    }
    return { numerator, denominator };
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new DOMException('Transcription cancelled.', 'AbortError');
    }
}
