import {
    Input,
    ALL_FORMATS,
    BlobSource,
    CanvasSink,
    WrappedCanvas,
} from 'mediabunny';

interface CachedFrame {
    bitmap: ImageBitmap;
    timestamp: number;
    duration: number;
}

interface VideoSinkData {
    sink: CanvasSink;
    iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
    currentFrame: WrappedCanvas | null;
    frameCache: Map<number, CachedFrame>; // Timestamp -> Frame
    cacheOrder: number[]; // For LRU
    lastTime: number;
    fileSignature: string;
}

const MAX_CACHE_SIZE = 60;

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

        // 1. Check if current frame is still valid
        if (sinkData.currentFrame && this.isFrameValid(sinkData.currentFrame, time)) {
            return sinkData.currentFrame;
        }

        // 2. Check LRU cache for this specific time
        const cached = Array.from(sinkData.frameCache.values()).find(f => this.isFrameValid({ timestamp: f.timestamp, duration: f.duration } as WrappedCanvas, time));
        if (cached) {
            // Move to end of LRU
            this.updateLRU(sinkData, cached.timestamp);
            const wrapped: WrappedCanvas = {
                canvas: cached.bitmap as unknown as HTMLCanvasElement,
                timestamp: cached.timestamp,
                duration: cached.duration
            };
            sinkData.currentFrame = wrapped;
            sinkData.lastTime = cached.timestamp;
            return wrapped;
        }

        // 3. If we have an iterator and we're moving forward (within 2 seconds), iterate
        let frame: WrappedCanvas | null = null;
        if (
            sinkData.iterator
            && sinkData.currentFrame
            && time >= sinkData.lastTime
            && time < sinkData.lastTime + 2.0
        ) {
            frame = await this.iterateToTime(sinkData, time);
        }

        // 4. Otherwise, seek to the target time
        if (!frame) {
            frame = await this.seekToTime(sinkData, time);
        }

        // 5. Add to cache if we got a frame
        if (frame) {
            this.addToCache(sinkData, frame);
        }

        return frame;
    }

    private updateLRU(sinkData: VideoSinkData, timestamp: number) {
        const index = sinkData.cacheOrder.indexOf(timestamp);
        if (index > -1) {
            sinkData.cacheOrder.splice(index, 1);
        }
        sinkData.cacheOrder.push(timestamp);
    }

    private async addToCache(sinkData: VideoSinkData, frame: WrappedCanvas) {
        if (sinkData.frameCache.has(frame.timestamp)) {
            this.updateLRU(sinkData, frame.timestamp);
            return;
        }

        // Evict if full
        if (sinkData.frameCache.size >= MAX_CACHE_SIZE) {
            const oldestTimestamp = sinkData.cacheOrder.shift();
            if (oldestTimestamp !== undefined) {
                const oldestCached = sinkData.frameCache.get(oldestTimestamp);
                if (oldestCached) {
                    oldestCached.bitmap.close(); // Correctly close ImageBitmap
                }
                sinkData.frameCache.delete(oldestTimestamp);
            }
        }

        try {
            const bitmap = await createImageBitmap(frame.canvas);
            sinkData.frameCache.set(frame.timestamp, {
                bitmap,
                timestamp: frame.timestamp,
                duration: frame.duration
            });
            sinkData.cacheOrder.push(frame.timestamp);
        } catch (e) {
            console.warn('Failed to create ImageBitmap for cache', e);
        }
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
                poolSize: 15, // Increased for smoother playback buffer
                fit: 'contain',
            });

            this.sinks.set(mediaId, {
                sink,
                iterator: null,
                currentFrame: null,
                frameCache: new Map(),
                cacheOrder: [],
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
            // Close all cached bitmaps
            sinkData.frameCache.forEach(f => f.bitmap.close());
            sinkData.frameCache.clear();
            sinkData.cacheOrder = [];
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
