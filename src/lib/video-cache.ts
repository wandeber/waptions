import {
    Input,
    ALL_FORMATS,
    BlobSource,
    CanvasSink,
    type InputVideoTrack,
    type WrappedCanvas,
} from 'mediabunny';
import { frameCache } from './frame-cache';
import { frameDuration, frameIndexToTime, normalizeFps, timeToFrameIndex } from './frame-utils';

type VideoFrameRequestMode = 'visible' | 'warmup' | 'export';

export interface VideoFrameRequestOptions {
    mode?: VideoFrameRequestMode;
    fps?: number;
}

interface VideoSinkData {
    videoTrack: InputVideoTrack;
    sink: CanvasSink;
    sinkResolutionKey: string;
    iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
    currentFrame: WrappedCanvas | null;
    nextFrame: WrappedCanvas | null;
    lastTime: number;
    fileSignature: string;
    priorityRequests: number;
    prefetching: boolean;
    prefetchPromise: Promise<void> | null;
    fps: number;
    targetWidth?: number;
    targetHeight?: number;
}

interface VideoCacheCounters {
    cacheHits: number;
    cacheMisses: number;
    seeks: number;
    sequentialReads: number;
    warmupFrames: number;
    cancelledWarmups: number;
}

interface TargetResolution {
    width: number;
    height: number;
}

const MAX_CACHE_RESOLUTION = 1280; // Cap preview cache to a 1280px long edge.
const PREVIEW_RESOLUTION_BUCKET = 32;
const getFileSignature = (file: File) => `${file.name}-${file.size}-${file.lastModified}`;

/**
 * VideoCache owns the Mediabunny CanvasSink instances and the shared preview
 * ImageBitmap cache. Requests are serialized per mediaId because a CanvasSink
 * iterator cannot be safely advanced by visible rendering and warmup at once.
 */
export class VideoCache {
    private sinks = new Map<string, VideoSinkData>();
    private initPromises = new Map<string, Promise<void>>();
    private frameChains = new Map<string, Promise<unknown>>();
    private requestGenerations = new Map<string, number>();
    private pendingResolutions = new Map<string, { width: number; height: number }>();
    private counters: VideoCacheCounters = {
        cacheHits: 0,
        cacheMisses: 0,
        seeks: 0,
        sequentialReads: 0,
        warmupFrames: 0,
        cancelledWarmups: 0,
    };

    /**
     * Get a frame at a specific media time. The requested time is normalized to
     * a frame index before any cache lookup, so playback does not create
     * duplicate work for multiple RAF ticks that land inside the same frame.
     */
    async getFrameAt(
        mediaId: string,
        file: File,
        time: number,
        options: VideoFrameRequestOptions = {}
    ): Promise<WrappedCanvas | null> {
        await this.ensureSink(mediaId, file);

        const sinkData = this.sinks.get(mediaId);
        if (!sinkData) return null;

        const mode = options.mode ?? 'visible';
        const isPriority = mode !== 'warmup';
        const requestFps = normalizeFps(options.fps ?? sinkData.fps);
        const frameIndex = timeToFrameIndex(time, requestFps);
        const frameTime = frameIndexToTime(frameIndex, requestFps);

        // Warmup is useful only while it stays out of the visible/export path.
        // Dropping stale warmup is cheaper than making the user-facing request
        // wait for frames that may never be seen.
        if (!isPriority && sinkData.priorityRequests > 0) {
            this.counters.cancelledWarmups += 1;
            return null;
        }

        const generation = isPriority
            ? this.bumpRequestGeneration(mediaId)
            : this.requestGenerations.get(mediaId) ?? 0;

        if (isPriority) {
            sinkData.priorityRequests += 1;
        }

        const previous = this.frameChains.get(mediaId) ?? Promise.resolve();
        const current = previous
            .then(async () => {
                if (isPriority && this.requestGenerations.get(mediaId) !== generation) {
                    return sinkData.currentFrame ?? null;
                }

                const frame = await this.resolveFrame(
                    mediaId,
                    sinkData,
                    frameIndex,
                    frameTime,
                    requestFps
                );

                if (frame && mode === 'warmup') {
                    this.counters.warmupFrames += 1;
                }

                return frame;
            })
            .finally(() => {
                if (isPriority) {
                    sinkData.priorityRequests = Math.max(0, sinkData.priorityRequests - 1);
                }
            });

        this.frameChains.set(mediaId, current.catch(() => null));
        return current;
    }

    private bumpRequestGeneration(mediaId: string): number {
        const nextGeneration = (this.requestGenerations.get(mediaId) ?? 0) + 1;
        this.requestGenerations.set(mediaId, nextGeneration);
        return nextGeneration;
    }

    private async resolveFrame(
        mediaId: string,
        sinkData: VideoSinkData,
        frameIndex: number,
        frameTime: number,
        fps: number
    ): Promise<WrappedCanvas | null> {
        const cachedBitmap = frameCache.getFrameAtIndex(mediaId, frameIndex);
        if (cachedBitmap) {
            this.counters.cacheHits += 1;
            return {
                canvas: cachedBitmap as unknown as OffscreenCanvas,
                timestamp: frameTime,
                duration: frameDuration(fps),
            } as WrappedCanvas;
        }

        this.counters.cacheMisses += 1;

        if (sinkData.nextFrame && sinkData.nextFrame.timestamp <= frameTime) {
            sinkData.currentFrame = sinkData.nextFrame;
            sinkData.nextFrame = null;
            this.startPrefetch(mediaId, sinkData, fps);
        }

        if (sinkData.currentFrame && this.isFrameValid(sinkData.currentFrame, frameTime)) {
            if (!sinkData.nextFrame && !sinkData.prefetching) {
                this.startPrefetch(mediaId, sinkData, fps);
            }
            this.cacheFrame(mediaId, sinkData.currentFrame, fps, frameIndex);
            return sinkData.currentFrame;
        }

        if (
            sinkData.iterator
            && sinkData.currentFrame
            && frameTime >= sinkData.lastTime
            && frameTime < sinkData.lastTime + 2.0
        ) {
            const frame = await this.iterateToTime(mediaId, sinkData, frameTime, fps, frameIndex);
            if (frame) {
                if (!sinkData.nextFrame && !sinkData.prefetching) {
                    this.startPrefetch(mediaId, sinkData, fps);
                }
                return frame;
            }
        }

        const frame = await this.seekToTime(mediaId, sinkData, frameTime, fps, frameIndex);
        if (frame && !sinkData.nextFrame && !sinkData.prefetching) {
            this.startPrefetch(mediaId, sinkData, fps);
        }
        return frame;
    }

    private isFrameValid(frame: WrappedCanvas, time: number): boolean {
        return time >= frame.timestamp && time < frame.timestamp + frame.duration;
    }

    private async iterateToTime(
        mediaId: string,
        sinkData: VideoSinkData,
        targetTime: number,
        fps: number,
        targetFrameIndex: number
    ): Promise<WrappedCanvas | null> {
        if (!sinkData.iterator) return null;

        try {
            while (true) {
                if (sinkData.prefetching && sinkData.prefetchPromise) {
                    await sinkData.prefetchPromise;
                }

                let frame: WrappedCanvas | null = null;

                if (sinkData.nextFrame && sinkData.nextFrame.timestamp <= targetTime + 0.05) {
                    frame = sinkData.nextFrame;
                    sinkData.nextFrame = null;
                } else {
                    const next = await sinkData.iterator.next();
                    if (next.done || !next.value) break;
                    frame = next.value;
                    this.counters.sequentialReads += 1;
                }

                if (!frame) break;

                sinkData.currentFrame = frame;
                sinkData.lastTime = frame.timestamp;

                if (this.isFrameValid(frame, targetTime)) {
                    this.cacheFrame(mediaId, frame, fps, targetFrameIndex);
                    this.startPrefetch(mediaId, sinkData, fps);
                    return frame;
                }

                this.cacheFrame(mediaId, frame, fps);

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
        time: number,
        fps: number,
        frameIndex: number
    ): Promise<WrappedCanvas | null> {
        try {
            if (sinkData.prefetching && sinkData.prefetchPromise) {
                await sinkData.prefetchPromise;
            }

            if (sinkData.iterator) {
                await sinkData.iterator.return();
                sinkData.iterator = null;
            }

            sinkData.nextFrame = null;
            sinkData.iterator = sinkData.sink.canvases(time);
            sinkData.lastTime = time;
            this.counters.seeks += 1;

            const { value: frame } = await sinkData.iterator.next();

            if (frame) {
                sinkData.currentFrame = frame;
                this.cacheFrame(mediaId, frame, fps, frameIndex);
                this.startPrefetch(mediaId, sinkData, fps);
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
            this.clearVideo(mediaId);
        }

        if (this.initPromises.has(mediaId)) {
            await this.initPromises.get(mediaId);
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

            const packetStats = await videoTrack.computePacketStats(100);
            const fps = normalizeFps(packetStats.averagePacketRate);
            const target = this.pendingResolutions.get(mediaId)
                ?? (mediaId === 'preview' ? { width: this.targetWidth, height: this.targetHeight } : undefined);

            this.sinks.set(mediaId, {
                videoTrack,
                sink: this.createSink(videoTrack, mediaId, target),
                sinkResolutionKey: this.getResolutionKey(target),
                iterator: null,
                currentFrame: null,
                nextFrame: null,
                lastTime: -1,
                fileSignature: getFileSignature(file),
                priorityRequests: 0,
                prefetching: false,
                prefetchPromise: null,
                fps,
                targetWidth: target?.width,
                targetHeight: target?.height,
            });

            if (target) {
                this.pendingResolutions.delete(mediaId);
            }
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
        frameCache.clear(mediaId);
        this.initPromises.delete(mediaId);
        this.frameChains.delete(mediaId);
        this.requestGenerations.delete(mediaId);
        this.pendingResolutions.delete(mediaId);
    }

    clearAll(): void {
        const mediaIds = Array.from(this.sinks.keys());
        for (const mediaId of mediaIds) {
            this.clearVideo(mediaId);
        }
        frameCache.clear();
    }

    private startPrefetch(mediaId: string, sinkData: VideoSinkData, fps: number): void {
        if (sinkData.prefetching || !sinkData.iterator || sinkData.nextFrame) return;

        sinkData.prefetching = true;
        sinkData.prefetchPromise = this.prefetchNextFrame(mediaId, sinkData, fps);
    }

    private async prefetchNextFrame(
        mediaId: string,
        sinkData: VideoSinkData,
        fps: number
    ): Promise<void> {
        if (!sinkData.iterator) {
            sinkData.prefetching = false;
            sinkData.prefetchPromise = null;
            return;
        }

        try {
            const { value: frame, done } = await sinkData.iterator.next();

            if (!done && frame) {
                sinkData.nextFrame = frame;
                this.cacheFrame(mediaId, frame, fps);
            }
        } catch (error) {
            console.warn('Prefetch failed, will restart iterator:', error);
            sinkData.iterator = null;
            sinkData.nextFrame = null;
        } finally {
            sinkData.prefetching = false;
            sinkData.prefetchPromise = null;
        }
    }

    private targetWidth = MAX_CACHE_RESOLUTION;
    private targetHeight = MAX_CACHE_RESOLUTION;

    setTargetResolution(width: number, height: number, mediaId?: string) {
        const target = this.normalizeTargetResolution(width, height, mediaId);

        if (mediaId) {
            const sinkData = this.sinks.get(mediaId);
            if (sinkData) {
                sinkData.targetWidth = target.width;
                sinkData.targetHeight = target.height;
                this.recreateSinkIfResolutionChanged(mediaId, sinkData, target);
            } else {
                this.pendingResolutions.set(mediaId, target);
            }
            return;
        }

        this.targetWidth = target.width;
        this.targetHeight = target.height;
    }

    private recreateSinkIfResolutionChanged(
        mediaId: string,
        sinkData: VideoSinkData,
        target: TargetResolution
    ) {
        const nextKey = this.getResolutionKey(target);
        if (sinkData.sinkResolutionKey === nextKey) return;

        // A CanvasSink bakes scaling into the yielded canvases. When the preview
        // viewport moves to a new resolution bucket, restart the iterator and
        // clear cached bitmaps so playback does not mix sizes from old buckets.
        if (sinkData.iterator) {
            sinkData.iterator.return();
        }
        sinkData.sink = this.createSink(sinkData.videoTrack, mediaId, target);
        sinkData.sinkResolutionKey = nextKey;
        sinkData.iterator = null;
        sinkData.currentFrame = null;
        sinkData.nextFrame = null;
        sinkData.lastTime = -1;
        frameCache.clear(mediaId);
        this.frameChains.delete(mediaId);
        this.requestGenerations.delete(mediaId);
    }

    private createSink(videoTrack: InputVideoTrack, mediaId: string, target?: TargetResolution) {
        if (!target) {
            return new CanvasSink(videoTrack, { poolSize: 5, fit: 'contain' });
        }

        // Preview sinks preserve source aspect ratio by specifying only the long
        // edge. Export sinks use their exact canvas dimensions.
        if (mediaId === 'preview') {
            return new CanvasSink(videoTrack, {
                poolSize: 5,
                ...(target.width >= target.height ? { width: target.width } : { height: target.height }),
            });
        }

        return new CanvasSink(videoTrack, {
            width: target.width,
            height: target.height,
            fit: 'contain',
            poolSize: 5,
        });
    }

    private getResolutionKey(target?: TargetResolution) {
        return target ? `${target.width}x${target.height}` : 'native';
    }

    private normalizeTargetResolution(width: number, height: number, mediaId?: string): TargetResolution {
        const safeWidth = Math.max(1, Math.round(width));
        const safeHeight = Math.max(1, Math.round(height));
        const shouldCap = !mediaId || mediaId === 'preview';
        const longEdge = Math.max(safeWidth, safeHeight);
        const scale = shouldCap && longEdge > MAX_CACHE_RESOLUTION
            ? MAX_CACHE_RESOLUTION / longEdge
            : 1;
        const scaledWidth = Math.max(1, Math.round(safeWidth * scale));
        const scaledHeight = Math.max(1, Math.round(safeHeight * scale));

        if (mediaId === 'preview' || !mediaId) {
            return {
                width: Math.max(1, Math.round(scaledWidth / PREVIEW_RESOLUTION_BUCKET) * PREVIEW_RESOLUTION_BUCKET),
                height: Math.max(1, Math.round(scaledHeight / PREVIEW_RESOLUTION_BUCKET) * PREVIEW_RESOLUTION_BUCKET),
            };
        }

        return { width: scaledWidth, height: scaledHeight };
    }

    private async cacheFrame(
        mediaId: string,
        frame: WrappedCanvas,
        fps = 30,
        frameIndex?: number
    ) {
        try {
            const sinkData = this.sinks.get(mediaId);
            const originalWidth = frame.canvas.width;
            const originalHeight = frame.canvas.height;

            let tw = sinkData?.targetWidth ?? this.targetWidth;
            let th = sinkData?.targetHeight ?? this.targetHeight;

            const ratio = originalWidth / originalHeight;
            if (ratio > 1) {
                th = Math.round(tw / ratio);
            } else {
                tw = Math.round(th * ratio);
            }

            if (tw > originalWidth) {
                tw = originalWidth;
                th = originalHeight;
            }

            const bitmap = await createImageBitmap(frame.canvas, {
                resizeWidth: tw,
                resizeHeight: th,
                resizeQuality: 'high'
            });

            const cacheFrameIndex = frameIndex ?? timeToFrameIndex(frame.timestamp, fps);
            frameCache.addFrameAtIndex(mediaId, cacheFrameIndex, bitmap, fps);
        } catch (e) {
            console.warn('Failed to cache frame to ImageBitmap:', e);
        }
    }

    getStats() {
        const frameStats = frameCache.getStats();
        const totalRequests = this.counters.cacheHits + this.counters.cacheMisses;

        return {
            totalSinks: this.sinks.size,
            activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator).length,
            cachedFrames: frameStats.frameCount,
            estimatedMemoryBytes: frameStats.memoryBytes,
            maxMemoryBytes: frameStats.maxMemoryBytes,
            cacheHits: this.counters.cacheHits,
            cacheMisses: this.counters.cacheMisses,
            cacheHitRate: totalRequests > 0 ? this.counters.cacheHits / totalRequests : 0,
            seeks: this.counters.seeks,
            sequentialReads: this.counters.sequentialReads,
            warmupFrames: this.counters.warmupFrames,
            cancelledWarmups: this.counters.cancelledWarmups,
        };
    }
}

export const videoCache = new VideoCache();
