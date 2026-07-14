import type { AudioMixPlan } from './audio-mix-plan';
import {
    renderAudioMixWindow,
    type AudioContributorDecoder,
} from './audio-dsp';
import { MediabunnyAudioDecoder } from './mediabunny-audio-decoder';
import {
    clampTimelinePlaybackRate,
    getTimelineAudioWorkletUrl,
    TIMELINE_AUDIO_WORKLET_PROCESSOR,
    TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
    type TimelineAudioWorkletEvent,
    type TimelineAudioWorkletMessage,
} from './timeline-audio-worklet';
import type {
    TimelineAudioEngineCallbacks,
    TimelineAudioEnginePort,
    TimelineAudioEngineSnapshot,
    TimelineAudioTransientOverride,
} from '@/types/timeline-audio-engine';

const SCHEDULE_BLOCK_SAMPLES = 4_096;
const LOW_WATER_SAMPLES = 12_000;
const HIGH_WATER_SAMPLES = 48_000;
const MAX_CACHE_BLOCKS = 12;

interface MessagePortLike {
    onmessage: ((event: MessageEvent<TimelineAudioWorkletEvent>) => void) | null;
    postMessage(message: TimelineAudioWorkletMessage, transfer?: Transferable[]): void;
}

interface ConnectableAudioNodeLike {
    connect(destination: unknown): unknown;
    disconnect(): void;
}

interface AudioWorkletNodeLike extends ConnectableAudioNodeLike {
    port: MessagePortLike;
}

interface GainNodeLike extends ConnectableAudioNodeLike {
    gain: { value: number };
}

interface AudioContextLike {
    state: string;
    destination: unknown;
    audioWorklet: { addModule(url: string): Promise<void> };
    createGain(): GainNodeLike;
    resume(): Promise<void>;
    close(): Promise<void>;
}

export interface TimelineAudioDecoderPort {
    setDocument(document: TimelineAudioEngineSnapshot['document'], generation: number): void;
    decode: AudioContributorDecoder;
    dispose(): void;
}

export interface TimelineAudioEngineDependencies {
    createAudioContext?: () => AudioContextLike;
    createWorkletNode?: (context: AudioContextLike) => AudioWorkletNodeLike;
    createDecoder?: () => TimelineAudioDecoderPort;
    origin?: () => string;
}

interface CachedMixBlock {
    key: string;
    left: Float32Array;
    right: Float32Array;
}

type WorkletMessageWithoutEnvelope = TimelineAudioWorkletMessage extends infer Message
    ? Message extends TimelineAudioWorkletMessage
        ? Omit<Message, 'version' | 'generation'>
        : never
    : never;

/**
 * Owns the browser's single canonical timeline-audio path.
 *
 * No HTMLMediaElement participates in audio playback. Every durable edit, transient override, or
 * seek increments a generation, aborts old decoder work, resets the AudioWorklet to one absolute
 * 48 kHz sample, and rebuilds a bounded low/high-water queue from the immutable mix snapshot.
 */
export class BrowserTimelineAudioEngine implements TimelineAudioEnginePort {
    private readonly callbacks: TimelineAudioEngineCallbacks;
    private readonly dependencies: Required<TimelineAudioEngineDependencies>;
    private readonly decoder: TimelineAudioDecoderPort;
    private snapshot: TimelineAudioEngineSnapshot | null = null;
    private transientOverride: TimelineAudioTransientOverride | null = null;
    private context: AudioContextLike | null = null;
    private node: AudioWorkletNodeLike | null = null;
    private gainNode: GainNodeLike | null = null;
    private generation = 0;
    private outputSample = 0;
    private queuedUntilSample = 0;
    private playbackRate = 1;
    private masterGain = 1;
    private playing = false;
    private destroyed = false;
    private transportRequestGeneration = 0;
    private abortController = new AbortController();
    private scheduling: Promise<void> | null = null;
    private audioGraphSetup: Promise<void> | null = null;
    private readonly cache = new Map<string, CachedMixBlock>();

    constructor(
        callbacks: TimelineAudioEngineCallbacks,
        dependencies: TimelineAudioEngineDependencies = {},
    ) {
        this.callbacks = callbacks;
        this.dependencies = {
            createAudioContext: dependencies.createAudioContext ?? createBrowserAudioContext,
            createWorkletNode: dependencies.createWorkletNode ?? createBrowserWorkletNode,
            createDecoder: dependencies.createDecoder ?? (() => new MediabunnyAudioDecoder()),
            origin: dependencies.origin ?? (() => window.location.origin),
        };
        this.decoder = this.dependencies.createDecoder();
    }

    setSnapshot(snapshot: TimelineAudioEngineSnapshot): void {
        this.assertAlive();
        this.snapshot = snapshot;
        this.outputSample = Math.min(this.outputSample, snapshot.contentEndSample);
        this.invalidate(this.outputSample);
    }

    async play(): Promise<void> {
        this.assertAlive();
        if (!this.snapshot) throw new Error('An audio snapshot must be set before playback.');
        const requestGeneration = ++this.transportRequestGeneration;
        this.playing = true;
        try {
            await this.ensureAudioGraph();
            if (!this.isCurrentPlayRequest(requestGeneration)) return;
            if (this.context?.state !== 'running') await this.context?.resume();
            if (!this.isCurrentPlayRequest(requestGeneration)) return;

            // Prime at least the low-water interval before telling the real-time thread to advance.
            // AudioContext construction and resume happen first so this method remains in the
            // user's gesture call chain and satisfies browser autoplay policies. A generation
            // guard follows every await because pause may be requested while module setup, resume,
            // or decoding is pending; stale continuations must never restart the worklet.
            await this.primeForPlay(requestGeneration);
            if (this.isCurrentPlayRequest(requestGeneration)) this.post({ type: 'play' });
        } catch (error) {
            // A failed graph setup or scheduler cannot leave the engine claiming it is playing.
            // The store can then expose the failure while the next explicit play gesture retries.
            if (this.isCurrentPlayRequest(requestGeneration)) {
                this.playing = false;
                this.transportRequestGeneration += 1;
                this.post({ type: 'pause' });
            }
            throw error;
        }
    }

    pause(): void {
        if (this.destroyed) return;
        this.transportRequestGeneration += 1;
        this.playing = false;
        this.post({ type: 'pause' });
    }

    seek(outputSample: number): void {
        this.assertAlive();
        if (!Number.isSafeInteger(outputSample) || outputSample < 0) {
            throw new RangeError('Audio seek positions must be non-negative safe integers.');
        }
        const end = this.snapshot?.contentEndSample ?? outputSample;
        this.outputSample = Math.min(outputSample, end);
        this.invalidate(this.outputSample);
    }

    setPlaybackRate(playbackRate: number): void {
        this.assertAlive();
        this.playbackRate = clampTimelinePlaybackRate(playbackRate);
        this.post({ type: 'set-rate', playbackRate: this.playbackRate });
    }

    setMasterGain(gainLinear: number): void {
        this.assertAlive();
        if (!Number.isFinite(gainLinear) || gainLinear < 0 || gainLinear > 1) {
            throw new RangeError('Master gain must be in the interval [0, 1].');
        }
        this.masterGain = gainLinear;
        if (this.gainNode) this.gainNode.gain.value = gainLinear;
    }

    setTransientOverride(override: TimelineAudioTransientOverride | null): void {
        this.assertAlive();
        if (this.transientOverride === override) return;
        this.transientOverride = override;
        this.invalidate(this.outputSample);
    }

    hasAudibleContributors(): boolean {
        const plan = this.getActivePlan();
        return Boolean(plan?.contributors.some((contributor) => contributor.gainLinear > 0));
    }

    async destroy(): Promise<void> {
        if (this.destroyed) return;
        this.destroyed = true;
        this.transportRequestGeneration += 1;
        this.playing = false;
        this.abortController.abort();
        this.post({ type: 'pause' });
        this.decoder.dispose();
        try {
            await this.scheduling;
        } catch (error) {
            if (!isAbortError(error)) this.callbacks.onError(toError(error));
        }
        this.node?.disconnect();
        this.gainNode?.disconnect();
        this.node = null;
        this.gainNode = null;
        if (this.context && this.context.state !== 'closed') await this.context.close();
        this.context = null;
        this.cache.clear();
    }

    private ensureAudioGraph(): Promise<void> {
        if (this.context && this.node && this.gainNode) return Promise.resolve();
        if (this.audioGraphSetup) return this.audioGraphSetup;
        const setup = this.createAudioGraph();
        const trackedSetup = setup.finally(() => {
            if (this.audioGraphSetup === trackedSetup) this.audioGraphSetup = null;
        });
        this.audioGraphSetup = trackedSetup;
        return trackedSetup;
    }

    private async createAudioGraph(): Promise<void> {
        const context = this.dependencies.createAudioContext();
        let node: AudioWorkletNodeLike | null = null;
        let gainNode: GainNodeLike | null = null;
        try {
            await context.audioWorklet.addModule(
                getTimelineAudioWorkletUrl(this.dependencies.origin()).href,
            );
            if (this.destroyed) {
                await context.close();
                return;
            }
            node = this.dependencies.createWorkletNode(context);
            gainNode = context.createGain();
            gainNode.gain.value = this.masterGain;
            node.connect(gainNode);
            gainNode.connect(context.destination);
            node.port.onmessage = (event) => this.handleWorkletEvent(event.data);
            this.context = context;
            this.node = node;
            this.gainNode = gainNode;
            this.post({ type: 'reset', outputSample: this.outputSample });
            this.post({ type: 'set-rate', playbackRate: this.playbackRate });
        } catch (error) {
            // Until all three graph members are published above, this method owns every browser
            // audio resource it created. Release partial nodes and the context here so a failed
            // module download or connection cannot leak an AudioContext between explicit retries.
            try { node?.disconnect(); } catch { /* Preserve the graph-construction error. */ }
            try { gainNode?.disconnect(); } catch { /* Preserve the graph-construction error. */ }
            try {
                if (context.state !== 'closed') await context.close();
            } catch {
                // Cleanup failures are secondary to the setup failure that explains why playback
                // did not start, so the original error remains the one exposed to the caller.
            }
            throw error;
        }
    }

    private invalidate(outputSample: number): void {
        const resumeAfterReset = this.playing;
        const transportRequestGeneration = this.transportRequestGeneration;
        this.generation += 1;
        this.abortController.abort();
        this.abortController = new AbortController();
        this.outputSample = outputSample;
        this.queuedUntilSample = outputSample;
        this.scheduling = null;
        this.cache.clear();
        if (this.snapshot) this.decoder.setDocument(this.snapshot.document, this.generation);
        this.post({ type: 'reset', outputSample });
        this.post({ type: 'set-rate', playbackRate: this.playbackRate });
        if (resumeAfterReset) {
            void this.primeForPlay(transportRequestGeneration).then(() => {
                if (this.isCurrentPlayRequest(transportRequestGeneration)) {
                    this.post({ type: 'play' });
                }
            }).catch((error) => {
                this.failCurrentTransport(error, transportRequestGeneration, true);
            });
        }
    }

    /**
     * Primes the current graph, retrying only when a document/seek invalidation superseded the
     * scheduler without changing the user's transport intent. A pause changes the transport
     * generation, so it exits immediately instead of turning an obsolete decode into late audio.
     */
    private async primeForPlay(requestGeneration: number): Promise<void> {
        while (this.isCurrentPlayRequest(requestGeneration)) {
            try {
                await this.schedule(HIGH_WATER_SAMPLES);
                return;
            } catch (error) {
                if (!isAbortError(error) || !this.isCurrentPlayRequest(requestGeneration)) {
                    throw error;
                }
            }
        }
    }

    private isCurrentPlayRequest(requestGeneration: number): boolean {
        return !this.destroyed
            && this.playing
            && requestGeneration === this.transportRequestGeneration;
    }

    private schedule(targetBufferedSamples = HIGH_WATER_SAMPLES): Promise<void> {
        if (this.scheduling) return this.scheduling;
        const generation = this.generation;
        const signal = this.abortController.signal;
        const run = async () => {
            const snapshot = this.snapshot;
            const activePlan = this.getActivePlan();
            if (!snapshot || !activePlan) return;
            // The editor clock may intentionally extend past the last audible contributor (for
            // example, an absolute subtitle tail). Extend only the renderer's zero-filled domain;
            // contributor geometry remains the immutable graph supplied by the state layer.
            const plan = activePlan.totalSampleCount < snapshot.contentEndSample
                ? { ...activePlan, totalSampleCount: snapshot.contentEndSample }
                : activePlan;
            const target = Math.min(
                snapshot.contentEndSample,
                Math.max(this.queuedUntilSample, this.outputSample + targetBufferedSamples),
            );
            while (this.queuedUntilSample < target) {
                if (signal.aborted || generation !== this.generation) throw createAbortError();
                const startSample = this.queuedUntilSample;
                const endSample = Math.min(target, startSample + SCHEDULE_BLOCK_SAMPLES);
                const block = await this.renderBlock(plan, startSample, endSample, generation, signal);
                if (signal.aborted || generation !== this.generation) throw createAbortError();
                this.queueBlock(startSample, block.left, block.right);
                this.queuedUntilSample = endSample;
            }
        };
        this.scheduling = run().finally(() => {
            if (generation === this.generation) this.scheduling = null;
        });
        return this.scheduling;
    }

    private async renderBlock(
        plan: AudioMixPlan,
        startSample: number,
        endSample: number,
        generation: number,
        signal: AbortSignal,
    ): Promise<{ left: Float32Array; right: Float32Array }> {
        const key = `${generation}:${startSample}:${endSample}`;
        const cached = this.cache.get(key);
        if (cached) return { left: cached.left.slice(), right: cached.right.slice() };
        const rendered = await renderAudioMixWindow(
            plan,
            (contributor, request) => this.decoder.decode(contributor, request),
            {
            startSample,
            endSample,
            generation,
            signal,
            },
        );
        const block = { key, left: rendered.channels[0], right: rendered.channels[1] };
        this.cache.set(key, block);
        while (this.cache.size > MAX_CACHE_BLOCKS) {
            const oldestKey = this.cache.keys().next().value as string | undefined;
            if (oldestKey === undefined) break;
            this.cache.delete(oldestKey);
        }
        return { left: block.left.slice(), right: block.right.slice() };
    }

    private queueBlock(startSample: number, left: Float32Array, right: Float32Array): void {
        this.node?.port.postMessage({
            version: TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
            type: 'queue',
            generation: this.generation,
            startSample,
            left,
            right,
        }, [left.buffer, right.buffer]);
    }

    private handleWorkletEvent(event: TimelineAudioWorkletEvent): void {
        if (!event || event.version !== TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION
            || event.generation !== this.generation || this.destroyed) return;
        this.outputSample = event.outputSample;
        if (event.type === 'clock') {
            this.callbacks.onClock({
                generation: event.generation,
                outputSample: event.outputSample,
                timeSeconds: event.timeSeconds,
                playing: event.playing,
                playbackRate: event.playbackRate,
            });
            if (this.snapshot && event.outputSample >= this.snapshot.contentEndSample) this.pause();
            return;
        }
        if (event.type === 'underrun') {
            this.callbacks.onUnderrun({
                generation: event.generation,
                outputSample: event.outputSample,
                missingSampleCount: Math.max(0, event.missingEndSample - event.missingStartSample),
            });
            this.queuedUntilSample = Math.min(this.queuedUntilSample, event.outputSample);
        } else {
            this.queuedUntilSample = Math.min(this.queuedUntilSample, event.queuedUntilSample);
        }
        const transportRequestGeneration = this.transportRequestGeneration;
        void this.schedule(HIGH_WATER_SAMPLES).catch((error) => {
            // Refill failures are transport failures too: otherwise the worklet remains marked as
            // playing while frozen on underrun. Only the request that still owns playback may
            // change transport state; stale generations are deliberately ignored.
            this.failCurrentTransport(error, transportRequestGeneration, true);
        });
    }

    private getActivePlan(): AudioMixPlan | null {
        const plan = this.transientOverride?.mixPlan ?? this.snapshot?.mixPlan;
        // The DSP never mutates a plan. This narrows the immutable port type for the read-only
        // renderer without copying thousands of contributor records on each low-water callback.
        return (plan as AudioMixPlan | undefined) ?? null;
    }

    private post(message: WorkletMessageWithoutEnvelope): void {
        if (!this.node) return;
        this.node.port.postMessage({
            ...message,
            version: TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
            generation: this.generation,
        } as TimelineAudioWorkletMessage);
    }

    private reportAsyncError(error: unknown): void {
        if (!isAbortError(error) && !this.destroyed) this.callbacks.onError(toError(error));
    }

    private failCurrentTransport(
        error: unknown,
        requestGeneration: number,
        reportError: boolean,
    ): void {
        if (isAbortError(error) || !this.isCurrentPlayRequest(requestGeneration)) return;
        this.playing = false;
        this.transportRequestGeneration += 1;
        this.post({ type: 'pause' });
        if (reportError) this.reportAsyncError(error);
    }

    private assertAlive(): void {
        if (this.destroyed) throw new Error('The timeline audio engine has been destroyed.');
    }
}

export function createTimelineAudioEngine(
    callbacks: TimelineAudioEngineCallbacks,
    dependencies?: TimelineAudioEngineDependencies,
): TimelineAudioEnginePort {
    return new BrowserTimelineAudioEngine(callbacks, dependencies);
}

function createBrowserAudioContext(): AudioContextLike {
    const Context = window.AudioContext;
    if (!Context) throw new Error('Web Audio is not available in this browser.');
    return new Context({ latencyHint: 'interactive' }) as unknown as AudioContextLike;
}

function createBrowserWorkletNode(context: AudioContextLike): AudioWorkletNodeLike {
    return new AudioWorkletNode(
        context as unknown as BaseAudioContext,
        TIMELINE_AUDIO_WORKLET_PROCESSOR,
        { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] },
    ) as unknown as AudioWorkletNodeLike;
}

function createAbortError(): Error {
    if (typeof DOMException !== 'undefined') {
        return new DOMException('Audio scheduling was superseded.', 'AbortError');
    }
    const error = new Error('Audio scheduling was superseded.');
    error.name = 'AbortError';
    return error;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export const TIMELINE_AUDIO_ENGINE_LOW_WATER_SAMPLES = LOW_WATER_SAMPLES;
