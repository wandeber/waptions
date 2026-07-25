import {
    ALL_FORMATS,
    CanvasSink,
    Input,
    type InputVideoTrack,
    type WrappedCanvas,
} from 'mediabunny';
import { normalizeFps } from './frame-utils';
import type { MediaBudgetLease, MediaBudgetManager } from './media-byte-source/budget-manager';
import { mediaRuntimeBudgets } from './media-byte-source/budgets';
import { createAdmittedMediabunnyInput } from './media-byte-source/mediabunny-adapter';
import type { MediaByteSource } from './media-byte-source/types';
import { VideoFrameScheduler } from './video-frame-scheduler';
import type { VideoFrameSessionRequestScope } from './video-runtime-types';

export interface VideoFrameSessionInput {
    getPrimaryVideoTrack(): Promise<VideoFrameSessionTrack | null>;
    dispose(): void;
}

export interface VideoFrameSessionTrack {
    readonly displayWidth?: number;
    readonly displayHeight?: number;
    canDecode(): Promise<boolean>;
    computePacketStats(maximumPacketCount?: number): Promise<{ averagePacketRate: number }>;
}

export interface VideoFrameSessionSink {
    canvases(startTimestamp?: number, endTimestamp?: number): AsyncGenerator<WrappedCanvas, void, unknown>;
}

export interface VideoFrameSessionBackend {
    createInput(
        file: File,
        signal?: AbortSignal,
    ): VideoFrameSessionInput | Promise<VideoFrameSessionInput>;
    createInputFromSource?(
        source: MediaByteSource,
        signal?: AbortSignal,
    ): VideoFrameSessionInput | Promise<VideoFrameSessionInput>;
    createSink(track: VideoFrameSessionTrack, options?: { poolSize: number }): VideoFrameSessionSink;
}

const defaultBackend: VideoFrameSessionBackend = {
    createInput: (file, signal) => createAdmittedMediabunnyInput(file, (admittedSource) => new Input({
        source: admittedSource,
        formats: ALL_FORMATS,
    }) as unknown as VideoFrameSessionInput, { signal }),
    createInputFromSource: (source, signal) => createAdmittedMediabunnyInput(source, (admittedSource) => new Input({
        source: admittedSource,
        formats: ALL_FORMATS,
    }) as unknown as VideoFrameSessionInput, { signal }),
    // The sink intentionally decodes at the source display aspect. Letterboxing belongs to the
    // shared compositor, not the decoder, and preview downscaling happens once when caching.
    createSink: (track, options) => new CanvasSink(
        track as InputVideoTrack,
        { poolSize: options?.poolSize ?? 5 },
    ),
};

const DEFAULT_CANVAS_POOL_SIZE = 5;

function createAbortError(): Error {
    if (typeof DOMException !== 'undefined') {
        return new DOMException('Video frame session initialization was aborted.', 'AbortError');
    }
    const error = new Error('Video frame session initialization was aborted.');
    error.name = 'AbortError';
    return error;
}

/**
 * Owns every Mediabunny object involved in decoding one source. Disposal is idempotent and closes
 * the Input immediately so an in-flight demux/decode is cancelled before awaiting iterator cleanup.
 */
export class VideoFrameSession {
    readonly fps: number;
    readonly generation: number;
    readonly videoTrack: VideoFrameSessionTrack;
    private readonly scheduler = new VideoFrameScheduler();
    private iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
    private currentFrame: WrappedCanvas | null = null;
    private lastTime = -1;
    private disposed = false;
    private inputDisposed = false;
    private disposePromise: Promise<void> | null = null;

    private constructor(
        private readonly input: VideoFrameSessionInput,
        videoTrack: VideoFrameSessionTrack,
        private readonly sink: VideoFrameSessionSink,
        private readonly poolPixelLease: MediaBudgetLease,
        fps: number,
        generation: number,
    ) {
        this.fps = normalizeFps(fps);
        this.generation = generation;
        this.videoTrack = videoTrack;
    }

    static async open({
        file,
        source,
        generation,
        signal,
        backend = defaultBackend,
        decodedPixelBudget = mediaRuntimeBudgets.decodedPixels,
    }: {
        file?: File;
        source?: MediaByteSource;
        generation: number;
        signal: AbortSignal;
        backend?: VideoFrameSessionBackend;
        decodedPixelBudget?: MediaBudgetManager;
    }): Promise<VideoFrameSession> {
        if (!file && !source) throw new TypeError('Video frame session requires a file or byte source.');
        const input = await (source
            ? backend.createInputFromSource?.(source, signal)
            : backend.createInput(file as File, signal));
        if (!input) throw new Error('This video frame backend does not support MediaByteSource.');
        let inputDisposed = false;
        let poolPixelLease: MediaBudgetLease | null = null;
        const disposeInput = () => {
            if (inputDisposed) return;
            inputDisposed = true;
            input.dispose();
        };
        const throwIfAborted = () => {
            if (!signal.aborted) return;
            disposeInput();
            throw createAbortError();
        };
        signal.addEventListener('abort', disposeInput, { once: true });

        try {
            throwIfAborted();
            const track = await input.getPrimaryVideoTrack();
            throwIfAborted();
            if (!track) throw new Error('No video track found');
            if (!await track.canDecode()) throw new Error('Video codec not supported for decoding');
            throwIfAborted();
            const packetStats = await track.computePacketStats(100);
            throwIfAborted();
            const sourceWidth = Math.max(1, Math.round(track.displayWidth ?? 1));
            const sourceHeight = Math.max(1, Math.round(track.displayHeight ?? 1));
            const frameBytes = sourceWidth * sourceHeight * 4;
            if (!Number.isSafeInteger(frameBytes)) {
                throw new RangeError('Video source dimensions exceed the decoded-pixel budget address space.');
            }
            const maxPoolSize = Math.floor(decodedPixelBudget.snapshot().maxBytes / frameBytes);
            if (maxPoolSize < 1) {
                throw new RangeError('A single source-resolution video frame exceeds the decoded-pixel budget.');
            }
            const poolSize = Math.min(DEFAULT_CANVAS_POOL_SIZE, maxPoolSize);
            const poolReservation = await decodedPixelBudget.reserve(frameBytes * poolSize, {
                label: `canvas-sink-pool:${generation}`,
                signal,
            });
            poolPixelLease = poolReservation.commit();
            throwIfAborted();
            let sink: VideoFrameSessionSink;
            try {
                sink = backend.createSink(track, { poolSize });
            } catch (error) {
                poolPixelLease.release();
                poolPixelLease = null;
                throw error;
            }
            throwIfAborted();
            const session = new VideoFrameSession(
                input,
                track,
                sink,
                poolPixelLease,
                packetStats.averagePacketRate,
                generation,
            );
            session.inputDisposed = inputDisposed;
            return session;
        } catch (error) {
            poolPixelLease?.release();
            disposeInput();
            throw error;
        } finally {
            signal.removeEventListener('abort', disposeInput);
        }
    }

    request(
        scope: VideoFrameSessionRequestScope,
        sourceTime: number,
        signal?: AbortSignal,
    ): Promise<WrappedCanvas | null> {
        return this.scheduler.schedule(scope, () => this.decodeAt(sourceTime), signal);
    }

    get isIdle(): boolean {
        return this.scheduler.isIdle;
    }

    whenIdle(): Promise<void> {
        return this.scheduler.whenIdle();
    }

    async dispose(): Promise<void> {
        if (this.disposePromise) return this.disposePromise;
        this.disposed = true;
        this.scheduler.dispose();
        const iterator = this.iterator;
        this.iterator = null;
        this.currentFrame = null;
        this.disposePromise = (async () => {
            let cleanupError: unknown;
            try {
                this.disposeInput();
            } catch (error) {
                cleanupError = error;
            }
            if (iterator) {
                try {
                    await iterator.return();
                } catch (error) {
                    // Input.dispose() deliberately cancels iterator work; cancellation rejection is
                    // expected and must not prevent the remaining ownership state from settling.
                    cleanupError ??= error;
                }
            }
            this.poolPixelLease.release();
            if (cleanupError) throw cleanupError;
        })();
        return this.disposePromise;
    }

    private async decodeAt(sourceTime: number): Promise<WrappedCanvas | null> {
        if (this.disposed) return null;
        const safeTime = Number.isFinite(sourceTime) ? Math.max(0, sourceTime) : 0;
        if (this.currentFrame && this.isFrameValid(this.currentFrame, safeTime)) {
            return this.currentFrame;
        }

        if (this.iterator && safeTime >= this.lastTime && safeTime < this.lastTime + 2) {
            const sequential = await this.iterateToTime(safeTime);
            if (sequential || this.disposed) return sequential;
        }

        await this.closeIterator();
        if (this.disposed) return null;
        this.iterator = this.sink.canvases(safeTime);
        this.lastTime = safeTime;
        return this.iterateToTime(safeTime);
    }

    private async iterateToTime(targetTime: number): Promise<WrappedCanvas | null> {
        const iterator = this.iterator;
        if (!iterator) return null;
        while (!this.disposed) {
            const next = await iterator.next();
            if (this.disposed || next.done || !next.value) return null;
            const frame = next.value;
            this.currentFrame = frame;
            this.lastTime = frame.timestamp;
            if (this.isFrameValid(frame, targetTime)) return frame;
            if (frame.timestamp > targetTime) return frame;
        }
        return null;
    }

    private isFrameValid(frame: WrappedCanvas, time: number): boolean {
        return time >= frame.timestamp && time < frame.timestamp + frame.duration;
    }

    private async closeIterator(): Promise<void> {
        const iterator = this.iterator;
        this.iterator = null;
        if (!iterator) return;
        try {
            await iterator.return();
        } catch {
            // A failed iterator is replaced by a new seek below. The Input remains session-owned.
        }
    }

    private disposeInput(): void {
        if (this.inputDisposed) return;
        this.inputDisposed = true;
        this.input.dispose();
    }
}
