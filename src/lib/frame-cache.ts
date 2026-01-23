/**
 * FrameCache manages an LRU (Least Recently Used) cache of ImageBitmap objects.
 * ImageBitmaps are stored in GPU memory, making them extremely efficient for canvas rendering.
 */
export interface CachedFrame {
    bitmap: ImageBitmap;
    timestamp: number;
    lastUsed: number;
    sizeBytes: number;
}

export class FrameCache {
    private frames = new Map<string, CachedFrame>();
    private maxMemoryBytes: number;
    private currentMemoryBytes = 0;
    private lastAccessedKey: string | null = null; // Protection against immediate eviction

    /**
     * @param maxMemoryMB Maximum memory to use in MB. Defaults to 512MB.
     */
    constructor(maxMemoryMB = 512) {
        this.maxMemoryBytes = maxMemoryMB * 1024 * 1024;
    }

    /**
     * Adds a bitmap to the cache. If memory limit is reached, oldest frames are evicted.
     */
    addFrame(videoId: string, timestamp: number, bitmap: ImageBitmap, fps = 30) {
        const frameIndex = Math.round(timestamp * fps);
        const key = this.getKey(videoId, frameIndex);

        // Approximate size: width * height * 4 (RGBA)
        const sizeBytes = bitmap.width * bitmap.height * 4;

        // If a frame for this key already exists, remove it first
        this.removeFrame(key);

        // Evict until we have enough space
        this.ensureSpace(sizeBytes);

        this.frames.set(key, {
            bitmap,
            timestamp,
            lastUsed: Date.now(),
            sizeBytes,
        });

        this.currentMemoryBytes += sizeBytes;
    }

    /**
     * Retrieves a frame from the cache. Updates its LRU status.
     */
    getFrame(videoId: string, timestamp: number, fps = 30): ImageBitmap | null {
        const frameIndex = Math.round(timestamp * fps);
        const key = this.getKey(videoId, frameIndex);
        const cached = this.frames.get(key);

        if (cached) {
            cached.lastUsed = Date.now();
            this.lastAccessedKey = key;
            return cached.bitmap;
        }

        return null;
    }

    /**
     * Checks if a frame exists in cache without updating LRU status.
     */
    hasFrame(videoId: string, timestamp: number, fps = 30): boolean {
        const frameIndex = Math.round(timestamp * fps);
        return this.frames.has(this.getKey(videoId, frameIndex));
    }

    /**
     * Clears all frames for a specific video or all videos.
     */
    clear(videoId?: string) {
        if (videoId) {
            for (const key of Array.from(this.frames.keys())) {
                if (key.startsWith(`${videoId}:`)) {
                    this.removeFrame(key);
                }
            }
        } else {
            for (const key of Array.from(this.frames.keys())) {
                this.removeFrame(key);
            }
        }
    }

    private getKey(videoId: string, frameIndex: number): string {
        return `${videoId}:${frameIndex}`;
    }

    private removeFrame(key: string) {
        const cached = this.frames.get(key);
        if (cached) {
            this.currentMemoryBytes -= cached.sizeBytes;
            cached.bitmap.close(); // Crucial to release GPU memory
            this.frames.delete(key);
        }
    }

    private ensureSpace(requiredBytes: number) {
        if (requiredBytes > this.maxMemoryBytes) {
            // This frame is bigger than the entire cache!
            return;
        }

        while (this.currentMemoryBytes + requiredBytes > this.maxMemoryBytes && this.frames.size > 0) {
            // Evict least recently used
            let oldestKey: string | null = null;
            let oldestTime = Infinity;

            this.frames.forEach((frame, key) => {
                if (key === this.lastAccessedKey) return;

                if (frame.lastUsed < oldestTime) {
                    oldestTime = frame.lastUsed;
                    oldestKey = key;
                }
            });

            if (oldestKey) {
                this.removeFrame(oldestKey);
            } else {
                // If we couldn't find an oldest key (maybe everything is protected), break loop
                break;
            }
        }
    }

    getStats() {
        return {
            frameCount: this.frames.size,
            memoryBytes: this.currentMemoryBytes,
            maxMemoryBytes: this.maxMemoryBytes,
        };
    }

    /**
     * Returns a list of timestamps currently cached for a specific video.
     * Useful for the timeline indicator.
     */
    getCachedTimestamps(videoId: string): number[] {
        const timestamps: number[] = [];
        const prefix = `${videoId}:`;
        this.frames.forEach((frame, key) => {
            if (key.startsWith(prefix)) {
                timestamps.push(frame.timestamp);
            }
        });
        return timestamps.sort((a, b) => a - b);
    }
}

export const frameCache = new FrameCache(512); // Default 512MB
