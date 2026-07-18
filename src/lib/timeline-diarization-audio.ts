import {
    AudioSampleSource,
    BufferTarget,
    Mp4OutputFormat,
    Output,
    WebMOutputFormat,
    getFirstEncodableAudioCodec,
    type AudioCodec,
    type AudioSample,
} from 'mediabunny';
import type { EditorDocumentV3 } from '@/types/video';
import {
    buildAudioMixPlan,
    type AudioMixPlan,
} from './audio-mix-plan';
import { createExportDocumentSnapshot } from './export-job';
import {
    TimelineAudioRenderer,
    type TimelineAudioRenderOptions,
} from './timeline-audio-renderer';

const DIARIZATION_AUDIO_BITRATE = 128_000;

declare const timelineDiarizationAudioSnapshotBrand: unique symbol;

/**
 * Opaque snapshot shared by the async job guard and the audio encoder.
 *
 * The compile-time brand prevents accidental use of a live editor document, while the private
 * WeakSet below prevents an unsafe TypeScript cast from bypassing the runtime snapshot boundary.
 */
export type TimelineDiarizationAudioSnapshot = EditorDocumentV3 & {
    readonly [timelineDiarizationAudioSnapshotBrand]: true;
};

const ownedTimelineDiarizationSnapshots = new WeakSet<object>();

export type TimelineDiarizationAudioStage = 'rendering-project-mix' | 'encoding-project-mix';

export interface TimelineDiarizationAudioOptions {
    signal: AbortSignal;
    onProgress?: (progress: number) => void;
    onStage?: (stage: TimelineDiarizationAudioStage) => void;
}

export interface EncodedTimelineDiarizationAudio {
    blob: Blob;
    filename: string;
    durationSeconds: number;
    outputEndSample: number;
}

/** Typed empty-mix result so orchestration can skip the network request without parsing text. */
export class TimelineDiarizationNoAudioError extends Error {
    readonly code = 'NO_AUDIBLE_AUDIO';

    constructor() {
        super('The project has no audible audio to diarize.');
        this.name = 'TimelineDiarizationNoAudioError';
    }
}

export type TimelineDiarizationAudioErrorStage = 'snapshot' | 'rendering' | 'encoding';

/** Concise phase information lets the modal report a useful failure without leaking media data. */
export class TimelineDiarizationAudioError extends Error {
    constructor(
        readonly stage: TimelineDiarizationAudioErrorStage,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'TimelineDiarizationAudioError';
    }
}

type OwnedAudioSampleSource = Pick<AudioSampleSource, 'add' | 'close'>;
type DiarizationOutput = Pick<Output, 'state' | 'addAudioTrack' | 'start' | 'finalize' | 'cancel'>;

interface SelectedAudioEncoding {
    codec: AudioCodec;
    container: 'mp4' | 'webm';
    mimeType: 'audio/mp4' | 'audio/webm';
    filename: 'timeline-diarization.m4a' | 'timeline-diarization.webm';
}

/**
 * Construction seam for the resource-owning encoder.
 *
 * Production uses the concrete Mediabunny objects below. Unit tests inject stateful fakes so
 * cleanup and codec fallback remain deterministic without depending on browser WebCodecs.
 */
export interface TimelineDiarizationAudioDependencies {
    buildPlan(document: EditorDocumentV3): AudioMixPlan;
    selectCodec(codecs: AudioCodec[]): Promise<AudioCodec | null>;
    createTarget(): BufferTarget;
    createOutput(target: BufferTarget, container: SelectedAudioEncoding['container']): DiarizationOutput;
    createSource(codec: AudioCodec): OwnedAudioSampleSource;
    render(
        document: EditorDocumentV3,
        source: Pick<AudioSampleSource, 'add'>,
        plan: AudioMixPlan,
        options: TimelineAudioRenderOptions,
    ): Promise<void>;
}

const defaultDependencies: TimelineDiarizationAudioDependencies = {
    buildPlan: buildAudioMixPlan,
    selectCodec: (codecs) => getFirstEncodableAudioCodec(codecs),
    createTarget: () => new BufferTarget(),
    createOutput: (target, container) => new Output({
        // The target is already memory-backed. Avoid in-memory fast-start, which would retain a
        // second set of MP4 chunks while constructing the final upload Blob.
        format: container === 'mp4'
            ? new Mp4OutputFormat({ fastStart: false })
            : new WebMOutputFormat(),
        target,
    }),
    createSource: (codec) => new AudioSampleSource({
        codec,
        bitrate: DIARIZATION_AUDIO_BITRATE,
    }),
    render: async (document, source, plan, options) => {
        // Reuse the exact plan whose audible boundary was selected by this job. The renderer must
        // not project a later mutable document, even if the editor changes during encoding.
        const renderer = new TimelineAudioRenderer(document, source, {
            buildPlan: () => plan,
        });
        await renderer.render(options);
    },
};

/**
 * Captures the single immutable document shared by diarization guard construction and encoding.
 *
 * This factory is synchronous by design, so callers can create the snapshot before starting any
 * asynchronous job phase. Only snapshots returned by this function are trusted by the encoder.
 */
export function createTimelineDiarizationAudioSnapshot(
    document: EditorDocumentV3,
): TimelineDiarizationAudioSnapshot {
    const snapshot = createExportDocumentSnapshot(document) as TimelineDiarizationAudioSnapshot;
    ownedTimelineDiarizationSnapshots.add(snapshot);
    return snapshot;
}

/**
 * Captures and encodes the canonical audible project mix for one diarization request.
 *
 * This function is the sole owner of the Mediabunny target, output, and AudioSampleSource. The
 * renderer owns every decoded sample and decoder session. No partial buffer is published before
 * Output.finalize() succeeds and the caller's AbortSignal is checked one final time.
 */
export async function encodeTimelineAudioForDiarization(
    document: EditorDocumentV3 | TimelineDiarizationAudioSnapshot,
    options: TimelineDiarizationAudioOptions,
    dependencies: TimelineDiarizationAudioDependencies = defaultDependencies,
): Promise<EncodedTimelineDiarizationAudio> {
    let snapshot: EditorDocumentV3;
    try {
        // A job owner may capture once, build its stale-result guard from that exact identity, and
        // pass it here. Every other value is snapshotted defensively before the first await. Runtime
        // registration, rather than the exported TypeScript brand alone, prevents cast-based skips.
        snapshot = ownedTimelineDiarizationSnapshots.has(document)
            ? document
            : createTimelineDiarizationAudioSnapshot(document);
    } catch (error) {
        throw createStageError('snapshot', 'Could not capture the project audio for diarization.', error);
    }

    throwIfAborted(options.signal);

    let plan: AudioMixPlan;
    try {
        plan = dependencies.buildPlan(snapshot);
    } catch (error) {
        throw createStageError('rendering', 'Could not prepare the project audio mix for diarization.', error);
    }

    if (plan.contributors.length === 0) throw new TimelineDiarizationNoAudioError();

    // The upload ends at the last contributor that survives canonical mute/solo filtering. Using
    // totalSampleCount here would include silent video or muted independent-audio tails. Starting
    // the renderer at zero still preserves leading and internal project silence exactly.
    const outputEndSample = plan.contributors.reduce(
        (latest, contributor) => Math.max(latest, contributor.outputEndSample),
        0,
    );
    if (!Number.isSafeInteger(outputEndSample) || outputEndSample <= 0) {
        throw createStageError(
            'rendering',
            'The audible project mix has an invalid duration.',
            new RangeError('The audible output boundary must be a positive safe integer.'),
        );
    }

    let output: DiarizationOutput | null = null;
    let source: OwnedAudioSampleSource | null = null;
    let sourceClosed = false;
    let sourceAttachedToOutput = false;
    let finalizePromise: Promise<void> | null = null;
    let cancelPromise: Promise<void> | null = null;
    let terminalError: unknown = null;

    const closeSource = (): void => {
        if (!source || sourceClosed) return;
        // Mark first because Mediabunny close methods are terminal and not guaranteed idempotent.
        // A thrown close must not cause a second close attempt during the outer cleanup.
        sourceClosed = true;
        source.close();
    };
    const requestOutputCancel = (): Promise<void> | null => {
        if (!output || output.state === 'finalized' || output.state === 'finalizing') return null;
        if (cancelPromise) return cancelPromise;
        if (output.state === 'canceled') return null;
        try {
            cancelPromise = output.cancel();
        } catch (error) {
            cancelPromise = Promise.reject(error);
        }
        // Abort listeners cannot await. Observe the promise immediately, then await the original
        // promise in `finally` so a failed forced cleanup cannot become an unhandled rejection.
        void cancelPromise.catch(() => undefined);
        return cancelPromise;
    };
    const handleOutputAbort = (): void => { void requestOutputCancel(); };
    let outputAbortListenerInstalled = false;

    try {
        const encoding = await selectAudioEncoding(dependencies, options.signal);
        throwIfAborted(options.signal);

        const target = dependencies.createTarget();
        output = dependencies.createOutput(target, encoding.container);
        source = dependencies.createSource(encoding.codec);
        output.addAudioTrack(source as AudioSampleSource);
        sourceAttachedToOutput = true;
        // Output.cancel(), not source.close(), is the only operation that can force an in-flight
        // WebCodecs add to settle while also releasing its encoder, muxer, and target.
        options.signal.addEventListener('abort', handleOutputAbort, { once: true });
        outputAbortListenerInstalled = true;
        await awaitAbortable(output.start(), options.signal);
        throwIfAborted(options.signal);

        options.onStage?.('rendering-project-mix');
        let announcedEncoding = false;
        const encodingSource: Pick<AudioSampleSource, 'add'> = {
            add: async (sample: AudioSample) => {
                if (!announcedEncoding) {
                    announcedEncoding = true;
                    options.onStage?.('encoding-project-mix');
                }
                throwIfAborted(options.signal);
                try {
                    // The renderer owns `sample` until this exact promise settles. Do not race the
                    // add against AbortSignal: doing so would make the renderer close a sample that
                    // WebCodecs may still be reading. The abort listener above starts Output.cancel,
                    // whose forced source close makes this backpressure boundary settle safely.
                    await source!.add(sample);
                } catch (error) {
                    if (options.signal.aborted || isAbortError(error)) {
                        throwIfAborted(options.signal);
                        throw error;
                    }
                    throw createStageError(
                        'encoding',
                        'Could not encode the project audio for diarization.',
                        error,
                    );
                }
                throwIfAborted(options.signal);
            },
        };

        try {
            await dependencies.render(snapshot, encodingSource, plan, {
                outputEndSample,
                signal: options.signal,
                onProgress: options.onProgress,
            });
        } catch (error) {
            if (isAbortError(error) || error instanceof TimelineDiarizationAudioError) throw error;
            throw createStageError(
                'rendering',
                'Could not render the project audio mix for diarization.',
                error,
            );
        }

        closeSource();
        throwIfAborted(options.signal);
        finalizePromise = output.finalize();
        await awaitAbortable(finalizePromise, options.signal);
        throwIfAborted(options.signal);

        if (!target.buffer) {
            throw createStageError(
                'encoding',
                'Audio encoding completed without an output buffer.',
            );
        }

        let blob: Blob;
        try {
            blob = new Blob([target.buffer], { type: encoding.mimeType });
        } catch (error) {
            throw createStageError(
                'encoding',
                'Could not assemble the encoded project audio.',
                error,
            );
        }

        return {
            blob,
            filename: encoding.filename,
            durationSeconds: outputEndSample / plan.sampleRate,
            outputEndSample,
        };
    } catch (error) {
        terminalError = normalizeTerminalError(error);
        throw terminalError;
    } finally {
        if (outputAbortListenerInstalled) {
            options.signal.removeEventListener('abort', handleOutputAbort);
        }
        let cleanupError: unknown = null;

        // Mediabunny forbids cancel() once finalization begins. Observe the original finalization
        // promise instead, ensuring no muxer rejection or work survives this job after abort.
        if (finalizePromise && output?.state === 'finalizing') {
            try {
                await finalizePromise;
            } catch (error) {
                cleanupError ??= error;
            }
        }

        if (output && output.state !== 'finalized' && output.state !== 'finalizing') {
            try {
                // For an attached source this must precede any explicit source close: forced output
                // cancellation owns in-flight add settlement plus encoder/muxer/target teardown.
                await requestOutputCancel();
            } catch (error) {
                cleanupError ??= error;
            }
        }

        if (!sourceAttachedToOutput) {
            try {
                // If addAudioTrack failed, Output never acquired the source and cannot close it.
                closeSource();
            } catch (error) {
                cleanupError ??= error;
            }
        }

        // Preserve the primary render/encode/abort failure. On an otherwise successful path, a
        // terminal cleanup failure is itself an encoding failure and must reach orchestration.
        if (terminalError === null && cleanupError) {
            throw createStageError(
                'encoding',
                'Could not release project audio encoding resources.',
                cleanupError,
            );
        }
    }
}

async function selectAudioEncoding(
    dependencies: TimelineDiarizationAudioDependencies,
    signal: AbortSignal,
): Promise<SelectedAudioEncoding> {
    let aac: AudioCodec | null = null;
    try {
        aac = await awaitAbortable(dependencies.selectCodec(['aac']), signal);
    } catch (error) {
        if (isAbortError(error)) throw error;
        // A codec-specific WebCodecs probe can reject on partially implemented browsers. Opus is
        // still worth probing because it uses a different encoder and container.
    }
    if (aac === 'aac') {
        return {
            codec: aac,
            container: 'mp4',
            mimeType: 'audio/mp4',
            filename: 'timeline-diarization.m4a',
        };
    }

    let opus: AudioCodec | null = null;
    try {
        opus = await awaitAbortable(dependencies.selectCodec(['opus']), signal);
    } catch (error) {
        if (isAbortError(error)) throw error;
    }
    if (opus === 'opus') {
        return {
            codec: opus,
            container: 'webm',
            mimeType: 'audio/webm',
            filename: 'timeline-diarization.webm',
        };
    }

    throw createStageError(
        'encoding',
        'AAC and Opus audio encoding are unavailable in this browser.',
    );
}

function normalizeTerminalError(error: unknown): unknown {
    if (isAbortError(error)) return error;
    if (error instanceof TimelineDiarizationAudioError) return error;
    return createStageError('encoding', 'Could not encode the project audio for diarization.', error);
}

function createStageError(
    stage: TimelineDiarizationAudioErrorStage,
    message: string,
    cause?: unknown,
): TimelineDiarizationAudioError {
    return new TimelineDiarizationAudioError(stage, message, cause === undefined ? undefined : { cause });
}

function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    if (typeof DOMException !== 'undefined') {
        throw new DOMException('Project audio encoding was cancelled.', 'AbortError');
    }
    const error = new Error('Project audio encoding was cancelled.');
    error.name = 'AbortError';
    throw error;
}

function isAbortError(error: unknown): error is Error {
    return error instanceof Error && error.name === 'AbortError';
}

/**
 * Rejects promptly on abort while continuing to observe an API without AbortSignal support.
 * Output.cancel() in the caller remains the terminal operation that releases the actual encoder.
 */
async function awaitAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const settle = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', abort);
            callback();
        };
        const abort = (): void => settle(() => {
            try {
                throwIfAborted(signal);
            } catch (error) {
                reject(error);
            }
        });
        signal.addEventListener('abort', abort, { once: true });
        operation.then(
            (value) => settle(() => resolve(value)),
            (error: unknown) => settle(() => reject(error)),
        );
    });
}
