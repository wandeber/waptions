import type { AudioMixPlan } from './audio-mix-plan';
import { buildTimelineAudioMixSemanticKey } from './audio-runtime-projection';
import { renderAudioMixWindow, type AudioContributorDecoder } from './audio-dsp';
import { MediabunnyAudioDecoder } from './mediabunny-audio-decoder';
import { runtimeDiagnostics } from './runtime-diagnostics';
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
const MAX_CACHE_BLOCKS = 16;

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
    suspend(): Promise<void>;
    close(): Promise<void>;
}

export interface TimelineAudioDecoderPort {
    /** Reconciles source sessions by typed id and fingerprint; it does not own render generations. */
    setDocument(document: TimelineAudioEngineSnapshot['document']): void;
    decode: AudioContributorDecoder;
    dispose(): void;
}

export interface TimelineAudioEngineDependencies {
    createAudioContext?: () => AudioContextLike;
    createWorkletNode?: (context: AudioContextLike) => AudioWorkletNodeLike;
    createDecoder?: () => TimelineAudioDecoderPort;
    origin?: () => string;
    now?: () => number;
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
 * Owns the browser's one canonical real-time audio path.
 *
 * Editor state is split into source-catalog, audible-mix, and content-boundary domains. Only an
 * audible mix replacement or an explicit seek aborts render work and resets the worklet queue;
 * compatible Mediabunny sessions outlive both. This separation is the central performance
 * contract: subtitle edits, selection changes, and seeks cannot repeatedly reopen media decoders.
 */
export class BrowserTimelineAudioEngine implements TimelineAudioEnginePort {
    private readonly callbacks: TimelineAudioEngineCallbacks;
    private readonly dependencies: Required<TimelineAudioEngineDependencies>;
    private readonly decoder: TimelineAudioDecoderPort;
    private snapshot: TimelineAudioEngineSnapshot | null = null;
    private transientOverride: TimelineAudioTransientOverride | null = null;
    private transientMixKey: string | null = null;
    private context: AudioContextLike | null = null;
    private node: AudioWorkletNodeLike | null = null;
    private gainNode: GainNodeLike | null = null;
    /** Generation belongs to queued render results, never to decoder session ownership. */
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
    /** All render generations share one tail so an aborted decoder owner unwinds before the next. */
    private renderTail: Promise<void> = Promise.resolve();
    private audioGraphSetup: Promise<void> | null = null;
    /** Serializes suspend/resume so a late pause cannot win after a newer explicit play gesture. */
    private contextTransitions: Promise<void> = Promise.resolve();
    private readonly cache = new Map<string, CachedMixBlock>();
    private readonly diagnostics = runtimeDiagnostics.createBatch();
    private clocksSinceDiagnosticsFlush = 0;

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
            now: dependencies.now ?? (() => performance.now()),
        };
        this.decoder = this.dependencies.createDecoder();
    }

    applySnapshot(snapshot: TimelineAudioEngineSnapshot, playheadSample: number): void {
        this.assertAlive();
        assertOutputSample(playheadSample);
        const previous = this.snapshot;
        const sourceCatalogChanged = previous?.sourceCatalogKey !== snapshot.sourceCatalogKey;
        const audibleMixChanged = previous?.audibleMixKey !== snapshot.audibleMixKey;
        const contentEndChanged = previous?.contentEndSample !== snapshot.contentEndSample;
        this.snapshot = snapshot;

        if (audibleMixChanged) {
            this.transientOverride = null;
            this.transientMixKey = null;
            // Abort the old render generation before source reconciliation can dispose an Input
            // it still owns. The shared render tail then lets the aborted generation unwind before
            // a render using the new source catalog starts decoding.
            this.resetRenderQueue(Math.min(playheadSample, snapshot.contentEndSample));
            if (sourceCatalogChanged) this.decoder.setDocument(snapshot.document);
            return;
        }

        if (sourceCatalogChanged) this.decoder.setDocument(snapshot.document);

        if (!contentEndChanged) return;
        this.outputSample = Math.min(this.outputSample, snapshot.contentEndSample);
        this.queuedUntilSample = Math.min(this.queuedUntilSample, snapshot.contentEndSample);
        this.post({ type: 'set-content-end', contentEndSample: snapshot.contentEndSample });
        if (this.playing) this.requestRefill(this.transportRequestGeneration);
    }

    async play(): Promise<void> {
        this.assertAlive();
        if (!this.snapshot) throw new Error('An audio snapshot must be applied before playback.');
        const requestGeneration = ++this.transportRequestGeneration;
        this.playing = true;
        const primeStartedAt = this.dependencies.now();
        try {
            await this.ensureAudioGraph();
            if (!this.isCurrentPlayRequest(requestGeneration)) return;
            await this.resumeContext(requestGeneration);
            if (!this.isCurrentPlayRequest(requestGeneration)) return;

            // Context construction/resume remains in the user gesture call chain for autoplay
            // policy. Every await is guarded because pause may win during module setup or decode.
            await this.primeForPlay(requestGeneration);
            if (this.isCurrentPlayRequest(requestGeneration)) {
                this.post({ type: 'play' });
                // Start after the 250 ms low-water runway, then fill toward one second in the
                // background. Waiting for the complete high-water window made every play gesture
                // pay four times as much decode latency before the first audible sample.
                this.requestRefill(requestGeneration);
            }
            this.diagnostics.observeTiming(
                'audio',
                'prime',
                Math.max(0, this.dependencies.now() - primeStartedAt),
            );
            this.diagnostics.flush();
        } catch (error) {
            if (this.isCurrentPlayRequest(requestGeneration)) {
                this.playing = false;
                this.transportRequestGeneration += 1;
                this.post({ type: 'pause', requestId: this.transportRequestGeneration });
            }
            this.diagnostics.flush();
            throw error;
        }
    }

    pause(): void {
        if (this.destroyed) return;
        this.transportRequestGeneration += 1;
        this.playing = false;
        // The worklet acknowledges this message before the context is suspended. That ordering
        // guarantees no paused clock stream while still allowing the acknowledgement to arrive.
        this.post({ type: 'pause', requestId: this.transportRequestGeneration });
    }

    seek(outputSample: number): void {
        this.assertAlive();
        assertOutputSample(outputSample);
        const end = this.snapshot?.contentEndSample ?? outputSample;
        this.resetRenderQueue(Math.min(outputSample, end));
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
        this.transientMixKey = override && this.snapshot
            ? buildTimelineAudioMixSemanticKey(
                override.mixPlan as AudioMixPlan,
                this.snapshot.audibleMixKey,
            )
            : null;
        this.resetRenderQueue(this.outputSample);
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
        this.post({ type: 'pause', requestId: this.transportRequestGeneration });
        this.decoder.dispose();
        try {
            await this.scheduling;
        } catch (error) {
            if (!isAbortError(error)) this.callbacks.onError(toError(error));
        }
        await this.renderTail;
        // createAudioGraph owns a context until it publishes all graph members. Awaiting setup is
        // what makes destroy-during-addModule deterministic instead of returning before it closes.
        try {
            await this.audioGraphSetup;
        } catch {
            // The initiating play call owns and reports setup failure; destroy only drains cleanup.
        }
        try {
            await this.contextTransitions;
        } catch {
            // A failed transition cannot prevent final context close below.
        }
        this.node?.disconnect();
        this.gainNode?.disconnect();
        this.node = null;
        this.gainNode = null;
        if (this.context && this.context.state !== 'closed') await this.context.close();
        this.context = null;
        this.cache.clear();
        this.diagnostics.setGauge('audio', 'queuedBlocks', 0);
        this.diagnostics.flush();
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
            this.post({
                type: 'reset',
                outputSample: this.outputSample,
                contentEndSample: this.snapshot?.contentEndSample ?? this.outputSample,
            });
            this.post({ type: 'set-rate', playbackRate: this.playbackRate });
            if (!this.playing) {
                // A pause can win while addModule owns the only awaited setup step, before a port
                // exists to receive it. Publishing the graph must therefore re-read transport
                // ownership and replay the current pause request. Its acknowledgement drives the
                // normal serialized suspend path even when the browser created a running context.
                this.post({ type: 'pause', requestId: this.transportRequestGeneration });
            }
        } catch (error) {
            // Until all graph members are published, this method owns every browser audio
            // resource. Release partial construction so an explicit retry starts from a clean graph.
            try { node?.disconnect(); } catch { /* Preserve the construction error. */ }
            try { gainNode?.disconnect(); } catch { /* Preserve the construction error. */ }
            try {
                if (context.state !== 'closed') await context.close();
            } catch {
                // Cleanup failure is secondary to the setup error exposed to the play caller.
            }
            throw error;
        }
    }

    private resetRenderQueue(outputSample: number): void {
        const resumeAfterReset = this.playing;
        const transportGeneration = this.transportRequestGeneration;
        this.generation += 1;
        this.abortController.abort();
        this.abortController = new AbortController();
        this.outputSample = outputSample;
        this.queuedUntilSample = outputSample;
        this.scheduling = null;
        this.post({
            type: 'reset',
            outputSample,
            contentEndSample: this.snapshot?.contentEndSample ?? outputSample,
        });
        this.post({ type: 'set-rate', playbackRate: this.playbackRate });
        this.diagnostics.increment('audio', 'queueResets');
        this.diagnostics.setGauge('audio', 'queuedBlocks', 0);
        this.diagnostics.flush();
        if (resumeAfterReset) this.requestRefill(transportGeneration, true);
    }

    private async primeForPlay(requestGeneration: number): Promise<void> {
        while (this.isCurrentPlayRequest(requestGeneration)) {
            try {
                await this.schedule(LOW_WATER_SAMPLES);
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
            // Subtitle tails can extend beyond audio. Only the render boundary is enlarged; source
            // contributor geometry remains the exact immutable graph shared with export.
            const plan = activePlan.totalSampleCount < snapshot.contentEndSample
                ? { ...activePlan, totalSampleCount: snapshot.contentEndSample }
                : activePlan;
            const target = Math.min(
                snapshot.contentEndSample,
                Math.max(this.queuedUntilSample, this.outputSample + targetBufferedSamples),
            );
            while (this.queuedUntilSample < target) {
                if (signal.aborted || generation !== this.generation) throw createAbortError();
                const liveContentEnd = this.snapshot?.contentEndSample ?? target;
                if (this.queuedUntilSample >= liveContentEnd) break;
                const startSample = this.queuedUntilSample;
                const endSample = Math.min(
                    target,
                    liveContentEnd,
                    startSample + SCHEDULE_BLOCK_SAMPLES,
                );
                const block = await this.renderBlock(plan, startSample, endSample, signal);
                if (signal.aborted || generation !== this.generation) {
                    this.diagnostics.increment('audio', 'staleBlocks');
                    this.diagnostics.flush();
                    throw createAbortError();
                }
                const resolvedContentEnd = this.snapshot?.contentEndSample ?? 0;
                if (this.queuedUntilSample !== startSample) {
                    // A shrink can move the required queue boundary behind an in-flight block.
                    // Even if the timeline is extended again before decode resolves, accepting
                    // that old block would leave a permanent hole between the retained prefix and
                    // its original start. Retry from the live boundary instead.
                    this.diagnostics.increment('audio', 'staleBlocks');
                    continue;
                }
                if (startSample >= resolvedContentEnd) break;
                const resolvedEndSample = Math.min(endSample, resolvedContentEnd);
                const resolvedLength = resolvedEndSample - startSample;
                // Content-only shrink does not advance render generation, so clamp the result at
                // resolve time before its buffers cross into the worklet realm.
                this.queueBlock(
                    startSample,
                    block.left.subarray(0, resolvedLength),
                    block.right.subarray(0, resolvedLength),
                );
                this.queuedUntilSample = resolvedEndSample;
                this.diagnostics.setGauge(
                    'audio',
                    'queuedBlocks',
                    Math.min(
                        MAX_CACHE_BLOCKS,
                        Math.ceil((this.queuedUntilSample - this.outputSample) / SCHEDULE_BLOCK_SAMPLES),
                    ),
                );
                this.diagnostics.flush();
            }
        };
        const queuedRun = this.renderTail.catch(() => undefined).then(run);
        const trackedRun = queuedRun.finally(() => {
            if (this.scheduling === trackedRun) this.scheduling = null;
        });
        // The handled tail serializes ownership without hiding failures from the caller awaiting
        // trackedRun. Reset may publish a newer trackedRun while the previous generation unwinds.
        this.renderTail = trackedRun.catch(() => undefined);
        this.scheduling = trackedRun;
        return trackedRun;
    }

    private async renderBlock(
        plan: AudioMixPlan,
        startSample: number,
        endSample: number,
        signal: AbortSignal,
    ): Promise<{ left: Float32Array; right: Float32Array }> {
        const key = `${this.getActiveMixKey()}:${startSample}:${endSample}`;
        const cached = this.cache.get(key);
        if (cached) {
            // Refresh insertion order so bounded eviction behaves as a true LRU across seeks.
            this.cache.delete(key);
            this.cache.set(key, cached);
            this.diagnostics.increment('audio', 'cacheHits');
            return { left: cached.left.slice(), right: cached.right.slice() };
        }
        this.diagnostics.increment('audio', 'cacheMisses');
        const startedAt = this.dependencies.now();
        const rendered = await renderAudioMixWindow(
            plan,
            (contributor, request) => this.decoder.decode(contributor, request),
            {
                startSample,
                endSample,
                generation: this.generation,
                signal,
            },
        );
        this.diagnostics.observeTiming(
            'audio',
            'mix',
            Math.max(0, this.dependencies.now() - startedAt),
        );
        this.diagnostics.increment('audio', 'decodedBlocks');
        const block = { key, left: rendered.channels[0], right: rendered.channels[1] };
        this.cache.set(key, block);
        while (this.cache.size > MAX_CACHE_BLOCKS) {
            const oldestKey = this.cache.keys().next().value as string | undefined;
            if (oldestKey === undefined) break;
            this.cache.delete(oldestKey);
        }
        // Transfer copies while retaining the cached originals; transferred buffers detach and
        // therefore cannot themselves serve a later seek hit.
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
            || this.destroyed) return;
        if (event.type === 'paused') {
            // Render generations may advance between pause and acknowledgement (for example, an
            // immediate seek). The echoed transport request remains stable across that reset, but
            // a newer play increments it and therefore makes this acknowledgement harmless.
            if (!this.playing && event.requestId === this.transportRequestGeneration) {
                this.outputSample = event.outputSample;
                this.diagnostics.flush();
                this.requestContextSuspend(event.requestId);
            }
            return;
        }
        if (event.generation !== this.generation) return;
        this.outputSample = event.outputSample;
        if (event.type === 'clock') {
            this.diagnostics.increment('audio', 'clockEvents');
            this.clocksSinceDiagnosticsFlush += 1;
            if (this.clocksSinceDiagnosticsFlush >= 60) {
                this.clocksSinceDiagnosticsFlush = 0;
                this.diagnostics.flush();
            }
            this.callbacks.onClock({
                generation: event.generation,
                outputSample: event.outputSample,
                timeSeconds: event.timeSeconds,
                playing: event.playing,
                playbackRate: event.playbackRate,
            });
            return;
        }
        if (event.type === 'ended') {
            this.diagnostics.increment('audio', 'endedEvents');
            this.diagnostics.flush();
            this.playing = false;
            this.transportRequestGeneration += 1;
            // Publish the exact terminal sample through the existing clock callback. The playback
            // store then owns UI transport finalization and clamps to its frame-domain boundary.
            this.callbacks.onClock({
                generation: event.generation,
                outputSample: event.outputSample,
                timeSeconds: event.timeSeconds,
                playing: true,
                playbackRate: this.playbackRate,
            });
            this.requestContextSuspend(this.transportRequestGeneration);
            return;
        }
        if (event.type === 'underrun') {
            this.diagnostics.increment('audio', 'underruns');
            this.callbacks.onUnderrun({
                generation: event.generation,
                outputSample: event.outputSample,
                missingSampleCount: Math.max(0, event.missingEndSample - event.missingStartSample),
            });
            this.queuedUntilSample = Math.min(this.queuedUntilSample, event.outputSample);
        } else {
            this.queuedUntilSample = Math.min(this.queuedUntilSample, event.queuedUntilSample);
        }
        this.diagnostics.setGauge(
            'audio',
            'queuedBlocks',
            Math.max(0, Math.ceil(
                (this.queuedUntilSample - this.outputSample) / SCHEDULE_BLOCK_SAMPLES,
            )),
        );
        this.diagnostics.flush();
        this.requestRefill(this.transportRequestGeneration);
    }

    private requestRefill(requestGeneration: number, replayAfterPrime = false): void {
        void this.schedule(HIGH_WATER_SAMPLES).then(() => {
            // A content-end extension can arrive while an old-boundary scheduler is in flight.
            // One second pass observes the live snapshot and fills the newly available tail.
            if (this.isCurrentPlayRequest(requestGeneration)
                && this.snapshot
                && this.queuedUntilSample < Math.min(
                    this.snapshot.contentEndSample,
                    this.outputSample + HIGH_WATER_SAMPLES,
                )) {
                return this.schedule(HIGH_WATER_SAMPLES);
            }
            return undefined;
        }).then(() => {
            if (replayAfterPrime && this.isCurrentPlayRequest(requestGeneration)) {
                this.post({ type: 'play' });
            }
        }).catch((error) => {
            this.failCurrentTransport(error, requestGeneration, true);
        });
    }

    private getActivePlan(): AudioMixPlan | null {
        const plan = this.transientOverride?.mixPlan ?? this.snapshot?.mixPlan;
        // The DSP never mutates a plan. Narrowing avoids copying contributor records for refills.
        return (plan as AudioMixPlan | undefined) ?? null;
    }

    private getActiveMixKey(): string {
        return this.transientMixKey ?? this.snapshot?.audibleMixKey ?? 'no-mix';
    }

    private post(message: WorkletMessageWithoutEnvelope): void {
        if (!this.node) return;
        this.node.port.postMessage({
            ...message,
            version: TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
            generation: this.generation,
        } as TimelineAudioWorkletMessage);
    }

    private resumeContext(requestGeneration: number): Promise<void> {
        return this.runContextTransition(async () => {
            if (!this.isCurrentPlayRequest(requestGeneration)) return;
            if (this.context && this.context.state !== 'running') await this.context.resume();
        });
    }

    private requestContextSuspend(requestGeneration: number): void {
        void this.runContextTransition(async () => {
            if (this.destroyed || this.playing
                || requestGeneration !== this.transportRequestGeneration) return;
            if (this.context?.state === 'running') {
                await this.context.suspend();
                this.diagnostics.increment('audio', 'contextSuspends');
                this.diagnostics.flush();
            }
        }).catch((error) => this.reportAsyncError(error));
    }

    private runContextTransition(operation: () => Promise<void>): Promise<void> {
        const result = this.contextTransitions.catch(() => undefined).then(operation);
        // Store a handled tail to keep later transitions usable, while returning the original
        // promise so the active play call still observes a resume failure.
        this.contextTransitions = result.catch(() => undefined);
        return result;
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
        this.post({ type: 'pause', requestId: this.transportRequestGeneration });
        this.diagnostics.flush();
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

function assertOutputSample(outputSample: number): void {
    if (!Number.isSafeInteger(outputSample) || outputSample < 0) {
        throw new RangeError('Audio positions must be non-negative safe integers.');
    }
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
