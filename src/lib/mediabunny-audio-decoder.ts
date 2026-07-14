import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';
import type { AudioMixContributor } from './audio-mix-plan';
import {
    downmixFrameToStereoInto,
    resolveContributorSourceSpan,
    type DecodeAudioContributorRequest,
    type DecodedAudioContributor,
} from './audio-dsp';
import {
    buildSanitizedAudioWindowPlan,
    materializeSanitizedAudioWindowRange,
    type AudioSampleWindowData,
} from './audio-sample-window';
import { runtimeDiagnostics } from './runtime-diagnostics';
import type { TimelineAudioRuntimeDocument } from '@/types/timeline-audio-engine';

const OUTPUT_SAMPLE_RATE = 48_000;
export const MAX_RETAINED_AUDIO_SESSIONS = 6;
export const MAX_RETAINED_AUDIO_PCM_SAMPLES = 96_000;
const MAX_SEQUENTIAL_READER_GAP_SAMPLES = 48_000;

export interface MediabunnyDecodedSample {
    timestamp: number;
    duration: number;
    sampleRate: number;
    numberOfFrames: number;
    numberOfChannels: number;
    copyTo(destination: Float32Array, options: {
        planeIndex: number;
        format: 'f32-planar';
    }): void;
    close(): void;
}

/** One reusable Input + primary track + AudioSampleSink for an immutable media source. */
export interface MediabunnyAudioSession {
    sampleRate: number;
    channelCount: number;
    codec: string | null;
    samples(startSeconds: number, endSeconds: number): AsyncIterable<MediabunnyDecodedSample>;
    dispose(): void;
}

/** Injectable seam that opens a source session, not a one-shot decoded range. */
export type OpenMediabunnyAudioSession = (
    file: File,
) => Promise<MediabunnyAudioSession | null>;

async function openMediabunnyAudioSession(file: File): Promise<MediabunnyAudioSession | null> {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
        const track = await input.getPrimaryAudioTrack();
        if (!track) {
            input.dispose();
            return null;
        }
        const sink = new AudioSampleSink(track);
        return {
            // Runtime track inspection is authoritative. In particular, video descriptors expose
            // only `hasAudio` and never duplicate native audio metadata that can become stale.
            sampleRate: track.sampleRate,
            channelCount: track.numberOfChannels,
            codec: track.codec,
            samples: (startSeconds, endSeconds) => sink.samples(startSeconds, endSeconds),
            // Input owns the demuxer, primary track, sink decoder, and any active iterator. One
            // dispose therefore aborts in-flight reads and releases the complete source session.
            dispose: () => input.dispose(),
        };
    } catch (error) {
        input.dispose();
        throw error;
    }
}

interface ResolvedContributorAsset {
    cacheKey: string;
    file: File;
    duration: number;
}

interface ActiveSampleIterator {
    iterator: AsyncIterator<MediabunnyDecodedSample>;
    closed: boolean;
}

/**
 * Keeps one Mediabunny codec iterator alive across adjacent bounded mix requests.
 *
 * AudioSampleSink creates and flushes a WebCodecs decoder for every `samples()` iterator. This
 * reader therefore serializes same-source requests and advances one iterator while retaining at
 * most two seconds of copied stereo PCM. A backward seek outside that window, or a forward jump
 * over one second, closes the iterator once and starts a new bounded decode near the requested
 * source position instead of decoding the skipped portion or the complete file.
 */
export class SequentialMediabunnyAudioReader {
    private activeIterator: ActiveSampleIterator | null = null;
    private windows: AudioSampleWindowData[] = [];
    private retainedRangeStartSample = 0;
    private decodedThroughSample = 0;
    private reachedSourceEnd = false;
    private disposed = false;
    private operationTail: Promise<void> = Promise.resolve();

    constructor(private readonly session: MediabunnyAudioSession) {}

    read(
        startSample: number,
        endSample: number,
        signal?: AbortSignal,
    ): Promise<readonly AudioSampleWindowData[]> {
        const operation = this.operationTail.catch(() => undefined).then(() => (
            this.readExclusive(startSample, endSample, signal)
        ));
        this.operationTail = operation.then(() => undefined, () => undefined);
        return operation;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        void this.closeActiveIterator();
        this.windows = [];
    }

    private async readExclusive(
        startSample: number,
        endSample: number,
        signal?: AbortSignal,
    ): Promise<readonly AudioSampleWindowData[]> {
        if (this.disposed || signal?.aborted) {
            // A pre-aborted request still owns termination of a retained iterator. Discarding its
            // copied PCM keeps the cursor and windows in one coherent state for any later session
            // reuse instead of restarting from an earlier cursor over retained samples.
            await this.restartAt(startSample);
            throw createAbortError();
        }
        if (startSample < this.retainedRangeStartSample
            || startSample > this.decodedThroughSample + MAX_SEQUENTIAL_READER_GAP_SAMPLES) {
            await this.restartAt(startSample);
        }
        if (!this.activeIterator && !this.reachedSourceEnd
            && endSample > this.decodedThroughSample) {
            await this.startIterator(startSample);
        }

        try {
            while (!this.reachedSourceEnd && this.decodedThroughSample < endSample) {
                if (this.disposed || signal?.aborted) throw createAbortError();
                const active = this.activeIterator;
                if (!active) break;
                let abortClose: Promise<void> | null = null;
                const closeOnAbort = (): void => {
                    abortClose = this.closeIterator(active);
                };
                signal?.addEventListener('abort', closeOnAbort, { once: true });
                let result: IteratorResult<MediabunnyDecodedSample>;
                try {
                    result = await active.iterator.next();
                } catch (error) {
                    await this.closeIterator(active);
                    if (signal?.aborted || this.disposed) throw createAbortError();
                    throw error;
                } finally {
                    signal?.removeEventListener('abort', closeOnAbort);
                }
                if (signal?.aborted || this.disposed) {
                    if (!result!.done) result!.value.close();
                    await abortClose;
                    throw createAbortError();
                }
                if (result.done) {
                    active.closed = true;
                    if (this.activeIterator === active) this.activeIterator = null;
                    this.reachedSourceEnd = true;
                    break;
                }
                const sample = result.value;
                try {
                    const window = copySampleToStereoWindow(sample, signal);
                    this.windows.push(window);
                    this.decodedThroughSample = Math.max(
                        this.decodedThroughSample,
                        getAudioWindowEndSample(window),
                    );
                } finally {
                    // The iterator transfers AudioSample ownership to this reader. Copied PCM
                    // survives only while the cursor that produced it remains valid.
                    sample.close();
                }
            }

            this.trimPcmWindow(startSample);
            if (this.disposed || signal?.aborted) throw createAbortError();
            return this.windows.filter((window) => (
                getAudioWindowEndSample(window) > startSample
                    && getAudioWindowStartSample(window) < endSample
            ));
        } catch (error) {
            if (this.disposed || signal?.aborted || isAbortError(error)) {
                // Closing an iterator means it cannot resume at decodedThroughSample. Its copied
                // windows must therefore be released with the cursor; otherwise startIterator()
                // restarts from the next request and appends overlapping packets indefinitely.
                await this.restartAt(startSample);
                throw createAbortError();
            }
            throw error;
        }
    }

    private async restartAt(startSample: number): Promise<void> {
        await this.closeActiveIterator();
        this.windows = [];
        this.retainedRangeStartSample = startSample;
        this.decodedThroughSample = startSample;
        this.reachedSourceEnd = false;
    }

    private async startIterator(startSample: number): Promise<void> {
        if (this.disposed) throw createAbortError();
        const iterable = this.session.samples(startSample / OUTPUT_SAMPLE_RATE, Infinity);
        this.activeIterator = { iterator: iterable[Symbol.asyncIterator](), closed: false };
        this.retainedRangeStartSample = startSample;
        this.decodedThroughSample = startSample;
        this.reachedSourceEnd = false;
        runtimeDiagnostics.increment('audio', 'sessionRebuilds');
    }

    private trimPcmWindow(currentRequestStartSample: number): void {
        const boundedStart = Math.max(
            this.retainedRangeStartSample,
            Math.min(
                currentRequestStartSample,
                this.decodedThroughSample - MAX_RETAINED_AUDIO_PCM_SAMPLES,
            ),
        );
        if (boundedStart <= this.retainedRangeStartSample) return;
        this.retainedRangeStartSample = boundedStart;
        this.windows = this.windows.filter((window) => (
            getAudioWindowEndSample(window) > boundedStart
        ));
    }

    private closeActiveIterator(): Promise<void> {
        const active = this.activeIterator;
        return active ? this.closeIterator(active) : Promise.resolve();
    }

    private async closeIterator(active: ActiveSampleIterator): Promise<void> {
        if (active.closed) return;
        active.closed = true;
        if (this.activeIterator === active) this.activeIterator = null;
        try {
            await active.iterator.return?.();
        } catch {
            // Input disposal or a decoder error can make iterator.return reject. The iterator is
            // already terminal and the original read/dispose path owns the meaningful error.
        }
    }
}

/**
 * Bounded Mediabunny adapter shared by preview scheduling and the export mix renderer.
 *
 * A typed media key plus immutable source fingerprint caches one Input/track/sink session.
 * Individual requests still decode and materialize only their small source interval, but adjacent
 * 4096-sample blocks and ordinary seeks no longer reopen the container and codec. Applying a new
 * document reconciles by type + id + fingerprint, so only removed or replaced assets are disposed.
 * Request-local AbortSignals own render staleness independently from this longer session lifetime.
 */
export class MediabunnyAudioDecoder {
    private document: TimelineAudioRuntimeDocument | null = null;
    private disposed = false;
    private readonly sessionPromises = new Map<string, Promise<MediabunnyAudioSession | null>>();
    private readonly openSessions = new Map<string, MediabunnyAudioSession>();
    private readonly readers = new Map<string, SequentialMediabunnyAudioReader>();
    private readonly sessionUseCounts = new Map<string, number>();
    /** Insertion order is refreshed on use and provides an explicit dormant-session LRU. */
    private readonly sessionLru = new Map<string, true>();
    /** Source reconciliation retires active Inputs only after their final bounded read returns. */
    private readonly pendingDocumentInvalidations = new Set<string>();
    private readonly disposedSessions = new WeakSet<MediabunnyAudioSession>();

    constructor(
        private readonly openSession: OpenMediabunnyAudioSession = openMediabunnyAudioSession,
    ) {}

    setDocument(document: TimelineAudioRuntimeDocument, _generation?: number): void {
        if (this.disposed) throw new Error('The audio decoder has been disposed.');
        void _generation;
        const validCacheKeys = collectDocumentAudioCacheKeys(document);
        let invalidatedSessionCount = 0;
        this.pendingDocumentInvalidations.forEach((cacheKey) => {
            // Reapplying the exact immutable source before its old read drains makes the retained
            // session valid again. Its fingerprint key proves that no source bytes changed.
            if (validCacheKeys.has(cacheKey)) this.pendingDocumentInvalidations.delete(cacheKey);
        });
        this.sessionPromises.forEach((pendingSession, cacheKey) => {
            if (validCacheKeys.has(cacheKey)) return;
            invalidatedSessionCount += 1;
            if ((this.sessionUseCounts.get(cacheKey) ?? 0) > 0) {
                // Applying a snapshot is synchronous, while an AudioSample iterator may still own
                // WebCodecs output. Mark it retired now and let releaseSessionUse close it after
                // the render generation has observed its AbortSignal and unwound.
                this.pendingDocumentInvalidations.add(cacheKey);
            } else {
                this.disposeSessionKey(cacheKey, pendingSession);
            }
        });
        if (invalidatedSessionCount > 0) {
            runtimeDiagnostics.increment('audio', 'sessionRebuilds', invalidatedSessionCount);
        }
        this.document = document;
    }

    async decode(
        contributor: AudioMixContributor,
        request: DecodeAudioContributorRequest,
    ): Promise<DecodedAudioContributor> {
        this.throwIfCancelled(request.signal);
        const document = this.document;
        if (!document) throw new Error('An editor document must be set before decoding audio.');
        const asset = resolveContributorAsset(document, contributor);
        if (!asset) throw new Error(`Audio source for contributor ${contributor.id} is unavailable.`);

        const contributorOutputLength = contributor.outputEndSample - contributor.outputStartSample;
        const [sourceStart, sourceEnd] = resolveContributorSourceSpan(contributor, OUTPUT_SAMPLE_RATE);
        const requestStartRatio = (request.outputStartSample - contributor.outputStartSample)
            / contributorOutputLength;
        const requestEndRatio = (request.outputEndSample - contributor.outputStartSample)
            / contributorOutputLength;
        const durationSampleCount = Math.max(0, Math.round(asset.duration * OUTPUT_SAMPLE_RATE));
        // One 48 kHz sample of padding on either side is sufficient for deterministic linear
        // interpolation without expanding a bounded request into a whole-file decode.
        const startSample = clamp(
            Math.floor(sourceStart + (sourceEnd - sourceStart) * requestStartRatio) - 1,
            0,
            durationSampleCount,
        );
        const endSample = clamp(
            Math.ceil(sourceStart + (sourceEnd - sourceStart) * requestEndRatio) + 1,
            startSample,
            durationSampleCount,
        );
        const decodeStartedAt = getMonotonicNow();
        this.retainSessionUse(asset.cacheKey);
        try {
            const session = await this.getSession(asset);
            this.throwIfCancelled(request.signal);
            if (!session) return createSilentWindow(startSample, endSample);
            let reader = this.readers.get(asset.cacheKey);
            if (!reader) {
                reader = new SequentialMediabunnyAudioReader(session);
                this.readers.set(asset.cacheKey, reader);
            }
            const windows = await reader.read(startSample, endSample, request.signal);
            this.throwIfCancelled(request.signal);
            const plan = buildSanitizedAudioWindowPlan(windows, {
                nativeSampleRate: OUTPUT_SAMPLE_RATE,
                declaredSampleCount: durationSampleCount,
            });
            const channels = materializeSanitizedAudioWindowRange(windows, plan, {
                startSample,
                endSample,
                channelCount: 2,
            });
            this.throwIfCancelled(request.signal);
            return { sampleRate: OUTPUT_SAMPLE_RATE, startSample, channels };
        } catch (error) {
            // A superseding generation already disposed the session. A request-local abort can
            // retain it safely; a real sink/decoder error invalidates the cached session so the
            // next bounded request deterministically opens a clean Input.
            if (this.disposed || request.signal?.aborted) throw createAbortError();
            if (!isAbortError(error)) this.invalidateSession(asset.cacheKey);
            throw error;
        } finally {
            this.releaseSessionUse(asset.cacheKey);
            runtimeDiagnostics.observeTiming(
                'audio',
                'decode',
                Math.max(0, getMonotonicNow() - decodeStartedAt),
            );
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.disposeAllSessions();
        this.sessionPromises.clear();
        this.sessionLru.clear();
        this.sessionUseCounts.clear();
        this.pendingDocumentInvalidations.clear();
        this.document = null;
    }

    private getSession(asset: ResolvedContributorAsset): Promise<MediabunnyAudioSession | null> {
        this.touchSession(asset.cacheKey);
        const cached = this.sessionPromises.get(asset.cacheKey);
        if (cached) return cached;

        const promise = this.openSession(asset.file).then((session) => {
            if (!session) return null;
            // Comparing the promise itself makes source replacement safe even when the new source
            // reuses an id while an old asynchronous Input is still being constructed.
            if (this.disposed || this.sessionPromises.get(asset.cacheKey) !== promise) {
                this.disposeSession(session);
                throw createAbortError();
            }
            this.openSessions.set(asset.cacheKey, session);
            runtimeDiagnostics.increment('audio', 'sessionOpens');
            this.evictDormantSessions(asset.cacheKey);
            return session;
        }).catch((error) => {
            if (this.sessionPromises.get(asset.cacheKey) === promise) {
                this.sessionPromises.delete(asset.cacheKey);
            }
            throw error;
        });
        this.sessionPromises.set(asset.cacheKey, promise);
        this.evictDormantSessions(asset.cacheKey);
        return promise;
    }

    private invalidateSession(cacheKey: string): void {
        const pending = this.sessionPromises.get(cacheKey);
        if (pending) this.disposeSessionKey(cacheKey, pending);
    }

    private disposeAllSessions(): void {
        this.readers.forEach((reader) => reader.dispose());
        this.readers.clear();
        this.openSessions.forEach((session) => this.disposeSession(session));
        this.openSessions.clear();
    }

    private disposeSession(session: MediabunnyAudioSession): void {
        if (this.disposedSessions.has(session)) return;
        this.disposedSessions.add(session);
        session.dispose();
        runtimeDiagnostics.increment('audio', 'sessionDisposals');
    }

    private retainSessionUse(cacheKey: string): void {
        this.sessionUseCounts.set(cacheKey, (this.sessionUseCounts.get(cacheKey) ?? 0) + 1);
        this.touchSession(cacheKey);
    }

    private releaseSessionUse(cacheKey: string): void {
        const remaining = Math.max(0, (this.sessionUseCounts.get(cacheKey) ?? 1) - 1);
        if (remaining === 0) {
            this.sessionUseCounts.delete(cacheKey);
            if (this.pendingDocumentInvalidations.delete(cacheKey)) {
                const pendingSession = this.sessionPromises.get(cacheKey);
                if (pendingSession) this.disposeSessionKey(cacheKey, pendingSession);
            }
        } else {
            this.sessionUseCounts.set(cacheKey, remaining);
        }
        this.evictDormantSessions();
    }

    private touchSession(cacheKey: string): void {
        this.sessionLru.delete(cacheKey);
        this.sessionLru.set(cacheKey, true);
    }

    private evictDormantSessions(excludedCacheKey?: string): void {
        while (this.sessionPromises.size > MAX_RETAINED_AUDIO_SESSIONS) {
            const evictionKey = Array.from(this.sessionLru.keys()).find((cacheKey) => (
                cacheKey !== excludedCacheKey && (this.sessionUseCounts.get(cacheKey) ?? 0) === 0
            ));
            if (!evictionKey) return;
            const pending = this.sessionPromises.get(evictionKey);
            if (!pending) {
                this.sessionLru.delete(evictionKey);
                continue;
            }
            this.disposeSessionKey(evictionKey, pending);
        }
    }

    private disposeSessionKey(
        cacheKey: string,
        pendingSession: Promise<MediabunnyAudioSession | null>,
    ): void {
        this.sessionPromises.delete(cacheKey);
        this.sessionLru.delete(cacheKey);
        this.pendingDocumentInvalidations.delete(cacheKey);
        const reader = this.readers.get(cacheKey);
        if (reader) {
            this.readers.delete(cacheKey);
            reader.dispose();
        }
        const openSession = this.openSessions.get(cacheKey);
        if (openSession) {
            this.openSessions.delete(cacheKey);
            this.disposeSession(openSession);
        }
        // An Input may still be opening when a source is replaced or evicted. Promise identity in
        // getSession rejects it too; this continuation closes ownership as soon as it arrives.
        void pendingSession.then((session) => {
            if (session) this.disposeSession(session);
        }).catch(() => undefined);
    }

    private throwIfCancelled(signal?: AbortSignal): void {
        if (this.disposed || signal?.aborted) {
            throw createAbortError();
        }
    }
}

function resolveContributorAsset(
    document: TimelineAudioRuntimeDocument,
    contributor: AudioMixContributor,
): ResolvedContributorAsset | null {
    const sourceReference = contributor.source;
    if (sourceReference.kind === 'video-source-audio') {
        const source = document.videoSources.find((item) => (
            item.id === sourceReference.videoSourceId && item.hasAudio
        ));
        return source ? {
            cacheKey: `video-source-audio:${source.id}:${source.fingerprint}`,
            file: source.file,
            duration: source.duration,
        } : null;
    }
    const source = document.audioSources.find((item) => item.id === sourceReference.audioSourceId);
    return source ? {
        cacheKey: `audio-source:${source.id}:${source.fingerprint}`,
        file: source.file,
        duration: source.duration,
    } : null;
}

function collectDocumentAudioCacheKeys(
    document: TimelineAudioRuntimeDocument,
): ReadonlySet<string> {
    return new Set([
        ...document.videoSources
            .filter((source) => source.hasAudio)
            .map((source) => `video-source-audio:${source.id}:${source.fingerprint}`),
        ...document.audioSources
            .map((source) => `audio-source:${source.id}:${source.fingerprint}`),
    ]);
}

function createSilentWindow(startSample: number, endSample: number): DecodedAudioContributor {
    return {
        sampleRate: OUTPUT_SAMPLE_RATE,
        startSample,
        channels: [
            new Float32Array(endSample - startSample),
            new Float32Array(endSample - startSample),
        ],
    };
}

function copySampleToStereoWindow(
    sample: MediabunnyDecodedSample,
    signal?: AbortSignal,
): AudioSampleWindowData {
    const sourcePlanes = Array.from({ length: sample.numberOfChannels }, (_, channelIndex) => {
        const plane = new Float32Array(sample.numberOfFrames);
        sample.copyTo(plane, { planeIndex: channelIndex, format: 'f32-planar' });
        return plane;
    });
    const left = new Float32Array(sample.numberOfFrames);
    const right = new Float32Array(sample.numberOfFrames);
    const frame = new Array<number>(sample.numberOfChannels);
    const stereoFrame: [number, number] = [0, 0];
    for (let index = 0; index < sample.numberOfFrames; index += 1) {
        if ((index & 2_047) === 0 && signal?.aborted) throw createAbortError();
        for (let channel = 0; channel < sourcePlanes.length; channel += 1) {
            frame[channel] = sourcePlanes[channel][index];
        }
        downmixFrameToStereoInto(frame, stereoFrame);
        left[index] = stereoFrame[0];
        right[index] = stereoFrame[1];
    }
    return {
        timestampSeconds: sample.timestamp,
        sampleRate: sample.sampleRate,
        frameCount: sample.numberOfFrames,
        channels: [left, right],
    };
}

function getAudioWindowStartSample(window: AudioSampleWindowData): number {
    return Math.round(window.timestampSeconds * OUTPUT_SAMPLE_RATE);
}

function getAudioWindowEndSample(window: AudioSampleWindowData): number {
    return Math.round((
        window.timestampSeconds + window.frameCount / window.sampleRate
    ) * OUTPUT_SAMPLE_RATE);
}

function createAbortError(): Error {
    if (typeof DOMException !== 'undefined') {
        return new DOMException('Audio decoding was superseded.', 'AbortError');
    }
    const error = new Error('Audio decoding was superseded.');
    error.name = 'AbortError';
    return error;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}

function getMonotonicNow(): number {
    return typeof performance === 'undefined' ? Date.now() : performance.now();
}
