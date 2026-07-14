import { AudioSample, type AudioSampleSource } from 'mediabunny';
import type { EditorDocumentV3 } from '@/types/video';
import {
    buildAudioMixPlan,
    type AudioMixContributor,
} from './audio-mix-plan';
import {
    renderAudioMixWindow,
    type DecodeAudioContributorRequest,
    type DecodedAudioContributor,
    type RenderedAudioMix,
} from './audio-dsp';
import { MediabunnyAudioDecoder } from './mediabunny-audio-decoder';

export const DEFAULT_EXPORT_AUDIO_WINDOW_SAMPLES = 16_384;

export interface TimelineAudioDecoder {
    setDocument(document: EditorDocumentV3, generation: number): void;
    decode(
        contributor: AudioMixContributor,
        request: DecodeAudioContributorRequest,
    ): Promise<DecodedAudioContributor>;
    dispose(): void;
}

export interface TimelineAudioRendererDependencies {
    createDecoder?: () => TimelineAudioDecoder;
    renderWindow?: typeof renderAudioMixWindow;
    createSample?: (init: ConstructorParameters<typeof AudioSample>[0]) => AudioSample;
}

export interface TimelineAudioRenderOptions {
    /** Exact exclusive output boundary. A longer content tail is encoded as explicit silence. */
    outputEndSample: number;
    windowSampleCount?: number;
    generation?: number;
    signal?: AbortSignal;
    shouldCancel?: () => boolean;
    onProgress?: (progress: number) => void;
}

/**
 * Streams the canonical timeline mix to a Mediabunny audio source in bounded stereo windows.
 *
 * The renderer is intentionally one-shot. Its decoder owns reusable Mediabunny Input sessions for
 * the duration of one export, then disposes every session in `finally`. AudioSample ownership is
 * similarly explicit: the encoder may retain a sample until `add` resolves, after which the sample
 * is always closed before the next window is allocated.
 */
export class TimelineAudioRenderer {
    private readonly decoder: TimelineAudioDecoder;
    private readonly renderWindow: typeof renderAudioMixWindow;
    private readonly createSample: NonNullable<TimelineAudioRendererDependencies['createSample']>;
    private readonly abortController = new AbortController();
    private disposed = false;

    constructor(
        private readonly document: EditorDocumentV3,
        private readonly source: Pick<AudioSampleSource, 'add'>,
        dependencies: TimelineAudioRendererDependencies = {},
    ) {
        this.decoder = dependencies.createDecoder?.() ?? new MediabunnyAudioDecoder();
        this.renderWindow = dependencies.renderWindow ?? renderAudioMixWindow;
        this.createSample = dependencies.createSample ?? ((init) => new AudioSample(init));
    }

    async render(options: TimelineAudioRenderOptions): Promise<void> {
        if (this.disposed) throw new Error('The timeline audio renderer has been disposed.');
        assertNonNegativeSafeInteger(options.outputEndSample, 'outputEndSample');
        const windowSampleCount = options.windowSampleCount ?? DEFAULT_EXPORT_AUDIO_WINDOW_SAMPLES;
        assertPositiveSafeInteger(windowSampleCount, 'windowSampleCount');

        const generation = options.generation ?? 1;
        const externalAbort = (): void => this.cancel();
        options.signal?.addEventListener('abort', externalAbort, { once: true });
        const plan = buildAudioMixPlan(this.document);
        // Subtitle tails and the covering frame of a partial audio tail can extend beyond the mix
        // graph's own duration. Extending only the plan boundary lets the shared DSP emit exact
        // zero-filled remainder samples without inventing a synthetic contributor.
        const renderPlan = plan.totalSampleCount < options.outputEndSample
            ? { ...plan, totalSampleCount: options.outputEndSample }
            : plan;

        try {
            this.throwIfCancelled(options);
            this.decoder.setDocument(this.document, generation);
            for (let startSample = 0; startSample < options.outputEndSample; startSample += windowSampleCount) {
                this.throwIfCancelled(options);
                const endSample = Math.min(options.outputEndSample, startSample + windowSampleCount);
                const rendered = await this.renderWindow(
                    renderPlan,
                    (contributor, request) => this.decoder.decode(contributor, request),
                    {
                        startSample,
                        endSample,
                        // A single DSP chunk per streamed window avoids building a second complete
                        // output buffer while retaining deterministic preview/export calculations.
                        chunkSize: endSample - startSample,
                        signal: this.abortController.signal,
                        generation,
                    },
                );
                // A graph replacement or user cancellation may arrive while a bounded decoder
                // request is resolving. Check again before giving the result to the encoder so no
                // stale window can be emitted after cancellation has been observed.
                this.throwIfCancelled(options);
                await this.addRenderedWindow(rendered);
                options.onProgress?.(endSample / Math.max(1, options.outputEndSample));
            }
            if (options.outputEndSample === 0) options.onProgress?.(1);
        } finally {
            options.signal?.removeEventListener('abort', externalAbort);
            this.dispose();
        }
    }

    /** Aborts active decoder iterators immediately and makes every pending result stale. */
    cancel(): void {
        if (this.disposed) return;
        this.abortController.abort();
        this.decoder.dispose();
        this.disposed = true;
    }

    dispose(): void {
        if (this.disposed) return;
        this.decoder.dispose();
        this.disposed = true;
    }

    private async addRenderedWindow(rendered: RenderedAudioMix): Promise<void> {
        const frameCount = rendered.endSample - rendered.startSample;
        const planar = new Float32Array(frameCount * 2);
        planar.set(rendered.channels[0], 0);
        planar.set(rendered.channels[1], frameCount);
        const sample = this.createSample({
            format: 'f32-planar',
            sampleRate: rendered.sampleRate,
            numberOfFrames: frameCount,
            numberOfChannels: 2,
            timestamp: rendered.startSample / rendered.sampleRate,
            data: planar,
        });
        try {
            await this.source.add(sample);
        } finally {
            sample.close();
        }
    }

    private throwIfCancelled(options: TimelineAudioRenderOptions): void {
        if (options.signal?.aborted || options.shouldCancel?.()) this.cancel();
        if (this.disposed || this.abortController.signal.aborted) throw createAbortError();
    }
}

/** Convenience wrapper used by exports that do not need to retain a renderer handle. */
export async function renderTimelineAudio(
    document: EditorDocumentV3,
    source: Pick<AudioSampleSource, 'add'>,
    options: TimelineAudioRenderOptions,
    dependencies: TimelineAudioRendererDependencies = {},
): Promise<void> {
    const renderer = new TimelineAudioRenderer(document, source, dependencies);
    await renderer.render(options);
}

function createAbortError(): Error {
    if (typeof DOMException !== 'undefined') {
        return new DOMException('Timeline audio rendering was cancelled.', 'AbortError');
    }
    const error = new Error('Timeline audio rendering was cancelled.');
    error.name = 'AbortError';
    return error;
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
