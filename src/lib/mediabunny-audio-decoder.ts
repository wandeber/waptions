import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';
import type { AudioMixContributor } from './audio-mix-plan';
import {
    downmixFrameToStereo,
    resolveContributorSourceSpan,
    type DecodeAudioContributorRequest,
    type DecodedAudioContributor,
} from './audio-dsp';
import {
    buildSanitizedAudioWindowPlan,
    materializeSanitizedAudioWindowRange,
    type AudioSampleWindowData,
} from './audio-sample-window';
import type { DeepReadonly } from '@/types/timeline-audio-engine';
import type { EditorDocumentV3 } from '@/types/video';

const OUTPUT_SAMPLE_RATE = 48_000;

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

/**
 * Bounded Mediabunny adapter shared by preview scheduling and the export mix renderer.
 *
 * A typed media key plus immutable source fingerprint caches one Input/track/sink session for the
 * active document generation. Individual requests still decode and materialize only their small
 * source interval, but adjacent 4096-sample blocks no longer reopen the container and codec. A
 * generation change disposes every session once, which also aborts active sink iterators before a
 * stale result can reach the AudioWorklet queue.
 */
export class MediabunnyAudioDecoder {
    private document: DeepReadonly<EditorDocumentV3> | null = null;
    private generation = 0;
    private sessionEpoch = 0;
    private disposed = false;
    private readonly sessionPromises = new Map<string, Promise<MediabunnyAudioSession | null>>();
    private readonly openSessions = new Set<MediabunnyAudioSession>();
    private readonly disposedSessions = new WeakSet<MediabunnyAudioSession>();

    constructor(
        private readonly openSession: OpenMediabunnyAudioSession = openMediabunnyAudioSession,
    ) {}

    setDocument(document: DeepReadonly<EditorDocumentV3>, generation: number): void {
        if (this.disposed) throw new Error('The audio decoder has been disposed.');
        // Disposing per generation is intentionally conservative. Seeks and graph edits are much
        // rarer than scheduler blocks, and Input.dispose() safely interrupts any active iterator.
        this.sessionEpoch += 1;
        this.disposeAllSessions();
        this.sessionPromises.clear();
        this.document = document;
        this.generation = generation;
    }

    async decode(
        contributor: AudioMixContributor,
        request: DecodeAudioContributorRequest,
    ): Promise<DecodedAudioContributor> {
        const generation = request.generation ?? this.generation;
        this.throwIfCancelled(generation, request.signal);
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
        const session = await this.getSession(asset, generation, this.sessionEpoch);
        this.throwIfCancelled(generation, request.signal);
        if (!session) return createSilentWindow(startSample, endSample);

        const windows: AudioSampleWindowData[] = [];
        try {
            for await (const sample of session.samples(
                startSample / OUTPUT_SAMPLE_RATE,
                endSample / OUTPUT_SAMPLE_RATE,
            )) {
                try {
                    this.throwIfCancelled(generation, request.signal);
                    windows.push(copySampleToStereoWindow(sample, request.signal));
                } finally {
                    // AudioSampleSink transfers ownership to the iterator consumer. Closing in an
                    // inner finally covers successful copies, aborts, and decoder/copy exceptions.
                    sample.close();
                }
            }
            this.throwIfCancelled(generation, request.signal);
            const plan = buildSanitizedAudioWindowPlan(windows, {
                nativeSampleRate: OUTPUT_SAMPLE_RATE,
                declaredSampleCount: durationSampleCount,
            });
            const channels = materializeSanitizedAudioWindowRange(windows, plan, {
                startSample,
                endSample,
                channelCount: 2,
            });
            this.throwIfCancelled(generation, request.signal);
            return { sampleRate: OUTPUT_SAMPLE_RATE, startSample, channels };
        } catch (error) {
            // A superseding generation already disposed the session. A request-local abort can
            // retain it safely; a real sink/decoder error invalidates the cached session so the
            // next bounded request deterministically opens a clean Input.
            if (generation !== this.generation || this.disposed) throw createAbortError();
            if (!isAbortError(error)) this.invalidateSession(asset.cacheKey, session);
            throw error;
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.sessionEpoch += 1;
        this.disposeAllSessions();
        this.sessionPromises.clear();
        this.document = null;
        this.generation += 1;
    }

    private getSession(
        asset: ResolvedContributorAsset,
        generation: number,
        sessionEpoch: number,
    ): Promise<MediabunnyAudioSession | null> {
        const cached = this.sessionPromises.get(asset.cacheKey);
        if (cached) return cached;

        const promise = this.openSession(asset.file).then((session) => {
            if (!session) return null;
            if (this.disposed || generation !== this.generation
                || sessionEpoch !== this.sessionEpoch) {
                this.disposeSession(session);
                throw createAbortError();
            }
            this.openSessions.add(session);
            return session;
        }).catch((error) => {
            if (generation === this.generation && sessionEpoch === this.sessionEpoch) {
                this.sessionPromises.delete(asset.cacheKey);
            }
            throw error;
        });
        this.sessionPromises.set(asset.cacheKey, promise);
        return promise;
    }

    private invalidateSession(cacheKey: string, session: MediabunnyAudioSession): void {
        this.sessionPromises.delete(cacheKey);
        this.openSessions.delete(session);
        this.disposeSession(session);
    }

    private disposeAllSessions(): void {
        this.openSessions.forEach((session) => this.disposeSession(session));
        this.openSessions.clear();
    }

    private disposeSession(session: MediabunnyAudioSession): void {
        if (this.disposedSessions.has(session)) return;
        this.disposedSessions.add(session);
        session.dispose();
    }

    private throwIfCancelled(generation: number, signal?: AbortSignal): void {
        if (this.disposed || generation !== this.generation || signal?.aborted) {
            throw createAbortError();
        }
    }
}

function resolveContributorAsset(
    document: DeepReadonly<EditorDocumentV3>,
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
    for (let index = 0; index < sample.numberOfFrames; index += 1) {
        if ((index & 2_047) === 0 && signal?.aborted) throw createAbortError();
        for (let channel = 0; channel < sourcePlanes.length; channel += 1) {
            frame[channel] = sourcePlanes[channel][index];
        }
        [left[index], right[index]] = downmixFrameToStereo(frame);
    }
    return {
        timestampSeconds: sample.timestamp,
        sampleRate: sample.sampleRate,
        frameCount: sample.numberOfFrames,
        channels: [left, right],
    };
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
