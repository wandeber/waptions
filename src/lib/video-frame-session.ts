import {
    ALL_FORMATS,
    BlobSource,
    CanvasSink,
    Input,
    type InputVideoTrack,
    type WrappedCanvas,
} from 'mediabunny';
import { normalizeFps } from './frame-utils';
import { VideoFrameScheduler } from './video-frame-scheduler';
import type { VideoFrameSessionRequestScope } from './video-runtime-types';

export interface VideoFrameSessionInput {
    getPrimaryVideoTrack(): Promise<VideoFrameSessionTrack | null>;
    dispose(): void;
}

export interface VideoFrameSessionTrack {
    canDecode(): Promise<boolean>;
    computePacketStats(maximumPacketCount?: number): Promise<{ averagePacketRate: number }>;
}

export interface VideoFrameSessionSink {
    canvases(startTimestamp?: number, endTimestamp?: number): AsyncGenerator<WrappedCanvas, void, unknown>;
}

export interface VideoFrameSessionBackend {
    createInput(file: File): VideoFrameSessionInput;
    createSink(track: VideoFrameSessionTrack): VideoFrameSessionSink;
}

const defaultBackend: VideoFrameSessionBackend = {
    createInput: (file) => new Input({
        source: new BlobSource(file),
        formats: ALL_FORMATS,
    }) as unknown as VideoFrameSessionInput,
    // The sink intentionally decodes at the source display aspect. Letterboxing belongs to the
    // shared compositor, not the decoder, and preview downscaling happens once when caching.
    createSink: (track) => new CanvasSink(track as InputVideoTrack, { poolSize: 5 }),
};

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
        fps: number,
        generation: number,
    ) {
        this.fps = normalizeFps(fps);
        this.generation = generation;
        this.videoTrack = videoTrack;
    }

    static async open({
        file,
        generation,
        signal,
        backend = defaultBackend,
    }: {
        file: File;
        generation: number;
        signal: AbortSignal;
        backend?: VideoFrameSessionBackend;
    }): Promise<VideoFrameSession> {
        const input = backend.createInput(file);
        let inputDisposed = false;
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
            const session = new VideoFrameSession(
                input,
                track,
                backend.createSink(track),
                packetStats.averagePacketRate,
                generation,
            );
            session.inputDisposed = inputDisposed;
            return session;
        } catch (error) {
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
        this.disposeInput();
        const iterator = this.iterator;
        this.iterator = null;
        this.currentFrame = null;
        this.disposePromise = (async () => {
            if (iterator) {
                try {
                    await iterator.return();
                } catch {
                    // Input.dispose() deliberately cancels iterator work; cancellation rejection is
                    // expected and must not prevent the remaining ownership state from settling.
                }
            }
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
