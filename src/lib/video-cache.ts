import {
    Input,
    ALL_FORMATS,
    BlobSource,
    CanvasSink,
    WrappedCanvas,
} from 'mediabunny';

interface VideoSinkData {
    sink: CanvasSink;
    iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
    currentFrame: WrappedCanvas | null;
    lastTime: number;
    fileSignature: string;
}

const getFileSignature = (file: File) => `${file.name}-${file.size}-${file.lastModified}`;

/**
 * VideoCache manages efficient video frame decoding using mediabunny's WebCodecs API.
 * Maintains a pool of canvas sinks for each loaded video and handles seeking/iteration.
 */
export class VideoCache {
    private sinks = new Map<string, VideoSinkData>();
    private initPromises = new Map<string, Promise<void>>();

    /**
     * Get a frame at a specific time from a video file.
     * Uses caching and intelligent seeking to minimize decoding work.
     */
    async getFrameAt(
        mediaId: string,
        file: File,
        time: number
    ): Promise<WrappedCanvas | null> {
        await this.ensureSink(mediaId, file);

        const sinkData = this.sinks.get(mediaId);
        if (!sinkData) return null;

        // Check if current frame is still valid for this time
        if (sinkData.currentFrame && this.isFrameValid(sinkData.currentFrame, time)) {
            return sinkData.currentFrame;
        }

        // If we have an iterator and we're moving forward (within 2 seconds), iterate
        if (
            sinkData.iterator
            && sinkData.currentFrame
            && time >= sinkData.lastTime
            && time < sinkData.lastTime + 2.0
        ) {
            const frame = await this.iterateToTime(sinkData, time);
            if (frame) return frame;
        }

        // Otherwise, seek to the target time
        return await this.seekToTime(sinkData, time);
    }

    private isFrameValid(frame: WrappedCanvas, time: number): boolean {
        return time >= frame.timestamp && time < frame.timestamp + frame.duration;
    }

    private async iterateToTime(
        sinkData: VideoSinkData,
        targetTime: number
    ): Promise<WrappedCanvas | null> {
        if (!sinkData.iterator) return null;

        try {
            while (true) {
                const { value: frame, done } = await sinkData.iterator.next();

                if (done || !frame) break;

                sinkData.currentFrame = frame;
                sinkData.lastTime = frame.timestamp;

                if (this.isFrameValid(frame, targetTime)) {
                    return frame;
                }

                // If we've gone too far past the target, stop iterating
                if (frame.timestamp > targetTime + 1.0) break;
            }
        } catch (error) {
            console.warn('Iterator failed, will restart:', error);
            sinkData.iterator = null;
        }

        return null;
    }

    private async seekToTime(
        sinkData: VideoSinkData,
        time: number
    ): Promise<WrappedCanvas | null> {
        try {
            // Close existing iterator
            if (sinkData.iterator) {
                await sinkData.iterator.return();
                sinkData.iterator = null;
            }

            // Start a new iterator from the target time
            sinkData.iterator = sinkData.sink.canvases(time);
            sinkData.lastTime = time;

            const { value: frame } = await sinkData.iterator.next();

            if (frame) {
                sinkData.currentFrame = frame;
                return frame;
            }
        } catch (error) {
            console.warn('Failed to seek video:', error);
        }

        return null;
    }

    private async ensureSink(mediaId: string, file: File): Promise<void> {
        const signature = getFileSignature(file);
        const existing = this.sinks.get(mediaId);

        if (existing) {
            if (existing.fileSignature === signature) return;
            // File changed, clear old sink
            this.clearVideo(mediaId);
        }

        if (this.initPromises.has(mediaId)) {
            // If already initializing, wait for it
            await this.initPromises.get(mediaId);
            // After waiting, re-check constraint (in case the initializing one was also wrong, though unlikely in single-thread flow)
            // Recursively ensure to double check
            return this.ensureSink(mediaId, file);
        }

        const initPromise = this.initializeSink(mediaId, file);
        this.initPromises.set(mediaId, initPromise);

        try {
            await initPromise;
        } finally {
            this.initPromises.delete(mediaId);
        }
    }

    private async initializeSink(mediaId: string, file: File): Promise<void> {
        try {
            const input = new Input({
                source: new BlobSource(file),
                formats: ALL_FORMATS,
            });

            const videoTrack = await input.getPrimaryVideoTrack();
            if (!videoTrack) {
                throw new Error('No video track found');
            }

            const canDecode = await videoTrack.canDecode();
            if (!canDecode) {
                throw new Error('Video codec not supported for decoding');
            }

            const sink = new CanvasSink(videoTrack, {
                poolSize: 5,
                fit: 'contain',
            });

            this.sinks.set(mediaId, {
                sink,
                iterator: null,
                currentFrame: null,
                lastTime: -1,
                fileSignature: getFileSignature(file),
            });
        } catch (error) {
            console.error(`Failed to initialize video sink for ${mediaId}:`, error);
            throw error;
        }
    }

    clearVideo(mediaId: string): void {
        const sinkData = this.sinks.get(mediaId);
        if (sinkData) {
            if (sinkData.iterator) {
                sinkData.iterator.return();
            }
            this.sinks.delete(mediaId);
        }
        this.initPromises.delete(mediaId);
    }

    clearAll(): void {
        const mediaIds = Array.from(this.sinks.keys());
        for (const mediaId of mediaIds) {
            this.clearVideo(mediaId);
        }
    }

    getStats() {
        return {
            totalSinks: this.sinks.size,
            activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator).length,
            cachedFrames: Array.from(this.sinks.values()).filter((s) => s.currentFrame).length,
        };
    }
}

// Singleton instance
export const videoCache = new VideoCache();
