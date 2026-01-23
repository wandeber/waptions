import {
    Input,
    ALL_FORMATS,
    BlobSource,
    CanvasSink,
    WrappedCanvas,
} from 'mediabunny';
import { frameCache } from './frame-cache';

interface VideoSinkData {
    sink: CanvasSink;
    iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
    currentFrame: WrappedCanvas | null;
    lastTime: number;
    fileSignature: string;
    isBusy?: boolean; // Lock for background tasks
    fps: number;
}

const MAX_CACHE_RESOLUTION = 1280; // Cap at 720p for cache
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
        time: number,
        isPriority = true
    ): Promise<WrappedCanvas | null> {
        await this.ensureSink(mediaId, file);

        const sinkData = this.sinks.get(mediaId);
        if (!sinkData) return null;

        // If background task tries to render while main thread is busy, skip
        if (!isPriority && sinkData.isBusy) return null;

        if (isPriority) sinkData.isBusy = true;

        try {
            // 1. Check persistent FrameCache first
            const cachedBitmap = frameCache.getFrame(mediaId, time, sinkData.fps);
            if (cachedBitmap) {
                return {
                    canvas: cachedBitmap as unknown as OffscreenCanvas,
                    timestamp: time,
                    duration: 0,
                } as WrappedCanvas;
            }

            // 2. Check current active frame (volatile)
            if (sinkData.currentFrame && this.isFrameValid(sinkData.currentFrame, time)) {
                return sinkData.currentFrame;
            }

            // 3. If moving forward (within 2 seconds), iterate
            if (
                sinkData.iterator
                && sinkData.currentFrame
                && time >= sinkData.lastTime
                && time < sinkData.lastTime + 2.0
            ) {
                const frame = await this.iterateToTime(mediaId, sinkData, time);
                if (frame) return frame;
            }

            // 4. Otherwise, seek to the target time
            return await this.seekToTime(mediaId, sinkData, time);
        } finally {
            if (isPriority) sinkData.isBusy = false;
        }
    }

    private isFrameValid(frame: WrappedCanvas, time: number): boolean {
        return time >= frame.timestamp && time < frame.timestamp + frame.duration;
    }

    private async iterateToTime(
        mediaId: string,
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

                // Cache the frame asynchronously
                this.cacheFrame(mediaId, frame, sinkData.fps);

                if (this.isFrameValid(frame, targetTime)) {
                    // Burst pre-fetch: Decode a few more frames in the background to fill the GoP
                    this.startBurst(mediaId, sinkData, sinkData.fps);
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
        mediaId: string,
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
                this.cacheFrame(mediaId, frame, sinkData.fps);
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

            const packetStats = await videoTrack.computePacketStats(100);
            const fps = packetStats.averagePacketRate || 30;

            this.sinks.set(mediaId, {
                sink,
                iterator: null,
                currentFrame: null,
                lastTime: -1,
                fileSignature: getFileSignature(file),
                fps: fps,
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
        frameCache.clear();
    }

    private async startBurst(mediaId: string, sinkData: VideoSinkData, fps: number) {
        if (!sinkData.iterator) return;

        // We only want to burst if we aren't already busy with another high-priority request
        // But since this is called from target found, we can just grab a few frames.
        const BURST_COUNT = 5;
        for (let i = 0; i < BURST_COUNT; i++) {
            const { value: frame, done } = await sinkData.iterator.next();
            if (done || !frame) break;
            this.cacheFrame(mediaId, frame, fps);
        }
    }

    private targetWidth = MAX_CACHE_RESOLUTION;
    private targetHeight = MAX_CACHE_RESOLUTION;

    setTargetResolution(width: number, height: number) {
        // We still cap it at MAX_CACHE_RESOLUTION for safety
        this.targetWidth = Math.min(width, MAX_CACHE_RESOLUTION);
        this.targetHeight = Math.min(height, MAX_CACHE_RESOLUTION);
    }

    private async cacheFrame(mediaId: string, frame: WrappedCanvas, fps = 30) {
        try {
            const originalWidth = frame.canvas.width;
            const originalHeight = frame.canvas.height;

            let tw = this.targetWidth;
            let th = this.targetHeight;

            // Maintain aspect ratio
            const ratio = originalWidth / originalHeight;
            if (ratio > 1) {
                th = Math.round(tw / ratio);
            } else {
                tw = Math.round(th * ratio);
            }

            const bitmap = await createImageBitmap(frame.canvas, {
                resizeWidth: tw,
                resizeHeight: th,
                resizeQuality: 'medium'
            });

            frameCache.addFrame(mediaId, frame.timestamp, bitmap, fps);
        } catch (e) {
            console.warn('Failed to cache frame to ImageBitmap:', e);
        }
    }

    getStats() {
        const frameStats = frameCache.getStats();

        return {
            totalSinks: this.sinks.size,
            activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator).length,
            cachedFrames: frameStats.frameCount,
            estimatedMemoryBytes: frameStats.memoryBytes,
            maxMemoryBytes: frameStats.maxMemoryBytes
        };
    }
}

// Singleton instance
export const videoCache = new VideoCache();
