import { runtimeDiagnostics } from './runtime-diagnostics';
import { frameDuration, frameIndexToTime, normalizeFps, timeToFrameIndex } from './frame-utils';
import type {
    MediaBudgetLease,
    MediaBudgetManager,
    MediaBudgetReservation,
    MediaBudgetSnapshot,
} from './media-byte-source/budget-manager';
import { mediaRuntimeBudgets } from './media-byte-source/budgets';

const MEBIBYTE = 1024 * 1024;

export interface CachedFrame {
    bitmap: ImageBitmap;
    timestamp: number;
    duration: number;
    frameIndex: number;
    lastUsed: number;
    sizeBytes: number;
}

interface OwnedCachedFrame extends CachedFrame {
    leaseCount: number;
    resident: boolean;
    cached: boolean;
    retentionPriority: number;
    pixelLease: MediaBudgetLease;
}

export interface ImageBitmapLease {
    readonly bitmap: ImageBitmap;
    readonly timestamp: number;
    readonly duration: number;
    readonly frameIndex: number;
    release(): void;
}

export interface FrameCacheStats {
    frameCount: number;
    memoryBytes: number;
    maxMemoryBytes: number;
    leasedFrameCount: number;
    globalPixelBudget: MediaBudgetSnapshot;
}

export interface FrameCacheAdmission {
    readonly videoId: string;
    readonly frameIndex: number;
    readonly width: number;
    readonly height: number;
    readonly sizeBytes: number;
    readonly retentionPriority: number;
    readonly released: boolean;
    release(): void;
}

export function getAdaptiveFrameCacheBudgetBytes(deviceMemory?: number): number {
    if (typeof deviceMemory === 'number' && Number.isFinite(deviceMemory)) {
        if (deviceMemory <= 2) return 64 * MEBIBYTE;
        if (deviceMemory >= 8) return 256 * MEBIBYTE;
    }
    return 128 * MEBIBYTE;
}

export function getBrowserDeviceMemory(): number | undefined {
    if (typeof navigator === 'undefined') return undefined;
    return (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
}

/**
 * A strict, priority-aware GPU-memory LRU for preview ImageBitmaps.
 *
 * Eviction removes a frame from lookup immediately, but a bitmap acquired by a renderer stays
 * alive until its final lease is released. Deferred bitmaps remain in the resident-byte budget,
 * so adding a new frame can never make owned GPU memory exceed the configured hard cap. Retention
 * priority controls admission under pressure; ordinary recency remains the tie-breaker.
 */
export class FrameCache {
    private readonly frames = new Map<string, OwnedCachedFrame>();
    private readonly maxMemoryBytes: number;
    private residentMemoryBytes = 0;
    private accessSequence = 0;
    private readonly residentFrames = new Set<OwnedCachedFrame>();
    private readonly ownedBitmaps = new WeakSet<ImageBitmap>();
    private readonly closedBitmaps = new WeakSet<ImageBitmap>();
    private readonly admissionReservations = new WeakMap<
        FrameCacheAdmission,
        () => MediaBudgetReservation | null
    >();

    /** @param maxMemoryMB Hard resident-memory limit in MiB. */
    constructor(
        maxMemoryMB = 128,
        private readonly decodedPixelBudget: MediaBudgetManager = mediaRuntimeBudgets.decodedPixels,
    ) {
        this.maxMemoryBytes = Math.max(0, maxMemoryMB) * MEBIBYTE;
    }

    /**
     * Reserves both the local cache allowance and the shared decoded-pixel budget before a bitmap
     * is created. Callers must either transfer this admission to addFrameAtIndex or release it.
     */
    async reserveFrameAtIndex(
        videoId: string,
        frameIndex: number,
        width: number,
        height: number,
        options: {
            retentionPriority?: number;
            signal?: AbortSignal;
            /** Conservative global reservation for backend alignment beyond requested output size. */
            globalReservationBytes?: number;
        } = {},
    ): Promise<FrameCacheAdmission | null> {
        const safeFrameIndex = Math.max(0, Math.round(frameIndex));
        const safeWidth = Math.max(0, Math.round(width));
        const safeHeight = Math.max(0, Math.round(height));
        const localSizeBytes = safeWidth * safeHeight * 4;
        const sizeBytes = Math.max(localSizeBytes, options.globalReservationBytes ?? localSizeBytes);
        const retentionPriority = this.normalizeRetentionPriority(options.retentionPriority);
        if (
            !Number.isSafeInteger(sizeBytes)
            || localSizeBytes > this.maxMemoryBytes
            || sizeBytes > this.decodedPixelBudget.snapshot().maxBytes
        ) {
            runtimeDiagnostics.increment('video', 'oversizedRejects');
            return null;
        }

        const key = this.getKey(videoId, safeFrameIndex);
        this.detachFrame(key, false);
        this.evictUntilFits(localSizeBytes, retentionPriority);
        if (this.residentMemoryBytes + localSizeBytes > this.maxMemoryBytes) {
            runtimeDiagnostics.increment('video', 'oversizedRejects');
            return null;
        }

        let reservation = this.decodedPixelBudget.tryReserve(
            sizeBytes,
            `preview-frame:${videoId}:${safeFrameIndex}`,
        );
        while (!reservation && this.evictOneForGlobalBudget(retentionPriority)) {
            reservation = this.decodedPixelBudget.tryReserve(
                sizeBytes,
                `preview-frame:${videoId}:${safeFrameIndex}`,
            );
        }
        reservation ??= await this.decodedPixelBudget.reserve(sizeBytes, {
            label: `preview-frame:${videoId}:${safeFrameIndex}`,
            signal: options.signal,
        });
        return this.createAdmission(
            videoId,
            safeFrameIndex,
            safeWidth,
            safeHeight,
            sizeBytes,
            retentionPriority,
            reservation,
        );
    }

    addFrame(videoId: string, timestamp: number, bitmap: ImageBitmap, fps = 30): boolean {
        return this.addFrameAtIndex(videoId, timeToFrameIndex(timestamp, fps), bitmap, fps, {
            timestamp,
            duration: frameDuration(fps),
        });
    }

    /**
     * Transfers bitmap ownership to the cache. Rejected and replaced bitmaps are always closed
     * exactly once by this owner, including when an oversized frame cannot fit in an empty cache.
     */
    addFrameAtIndex(
        videoId: string,
        frameIndex: number,
        bitmap: ImageBitmap,
        fps = 30,
        options?: {
            timestamp?: number;
            duration?: number;
            /** Higher values survive before lower-value speculative entries under pressure. */
            retentionPriority?: number;
            /** Reservation created before bitmap allocation. */
            admission?: FrameCacheAdmission;
        },
    ): boolean {
        const normalizedFps = normalizeFps(fps);
        const safeFrameIndex = Math.max(0, Math.round(frameIndex));
        const key = this.getKey(videoId, safeFrameIndex);
        const sizeBytes = Math.max(0, bitmap.width) * Math.max(0, bitmap.height) * 4;
        const retentionPriority = this.normalizeRetentionPriority(options?.retentionPriority);
        const admission = options?.admission;

        if (this.ownedBitmaps.has(bitmap) || this.closedBitmaps.has(bitmap)) {
            admission?.release();
            return false;
        }
        if (
            admission
            && (
                admission.released
                || admission.videoId !== videoId
                || admission.frameIndex !== safeFrameIndex
                || sizeBytes > admission.sizeBytes
            )
        ) {
            admission.release();
            this.closeBitmapOnce(bitmap);
            return false;
        }

        this.detachFrame(key, false);
        this.evictUntilFits(sizeBytes, retentionPriority);

        if (sizeBytes > this.maxMemoryBytes || this.residentMemoryBytes + sizeBytes > this.maxMemoryBytes) {
            admission?.release();
            this.closeBitmapOnce(bitmap);
            runtimeDiagnostics.increment('video', 'oversizedRejects');
            this.publishGauges();
            return false;
        }
        const reservation = admission
            ? this.consumeAdmission(admission)
            : this.decodedPixelBudget.tryReserve(sizeBytes, `preview-frame:${videoId}:${safeFrameIndex}`);
        if (!reservation) {
            this.closeBitmapOnce(bitmap);
            runtimeDiagnostics.increment('video', 'oversizedRejects');
            this.publishGauges();
            return false;
        }
        const pixelLease = reservation.commit(sizeBytes);

        const frame: OwnedCachedFrame = {
            bitmap,
            timestamp: options?.timestamp ?? frameIndexToTime(safeFrameIndex, normalizedFps),
            duration: options?.duration ?? frameDuration(normalizedFps),
            frameIndex: safeFrameIndex,
            lastUsed: ++this.accessSequence,
            sizeBytes,
            leaseCount: 0,
            resident: true,
            cached: true,
            retentionPriority,
            pixelLease,
        };
        this.ownedBitmaps.add(bitmap);
        this.frames.set(key, frame);
        this.residentFrames.add(frame);
        this.residentMemoryBytes += sizeBytes;
        this.publishGauges();
        return true;
    }

    acquireFrame(videoId: string, timestamp: number, fps = 30): ImageBitmapLease | null {
        return this.acquireFrameAtIndex(videoId, timeToFrameIndex(timestamp, fps));
    }

    acquireFrameAtIndex(
        videoId: string,
        frameIndex: number,
        retentionPriority?: number,
    ): ImageBitmapLease | null {
        const frame = this.findFrame(videoId, frameIndex);
        if (!frame) return null;

        frame.retentionPriority = Math.max(
            frame.retentionPriority,
            this.normalizeRetentionPriority(retentionPriority),
        );
        frame.leaseCount += 1;
        let released = false;
        return {
            bitmap: frame.bitmap,
            timestamp: frame.timestamp,
            duration: frame.duration,
            frameIndex: frame.frameIndex,
            release: () => {
                if (released) return;
                released = true;
                frame.leaseCount = Math.max(0, frame.leaseCount - 1);
                if (!frame.cached && frame.leaseCount === 0) {
                    this.closeResidentFrame(frame);
                }
            },
        };
    }

    hasFrame(videoId: string, timestamp: number, fps = 30): boolean {
        return this.hasFrameAtIndex(videoId, timeToFrameIndex(timestamp, fps));
    }

    hasFrameAtIndex(videoId: string, frameIndex: number): boolean {
        return this.frames.has(this.getKey(videoId, Math.max(0, Math.round(frameIndex))));
    }

    clear(videoId?: string): void {
        if (videoId) {
            for (const key of Array.from(this.frames.keys())) {
                if (key.startsWith(`${videoId}:`)) this.detachFrame(key, false);
            }
        } else {
            for (const key of Array.from(this.frames.keys())) this.detachFrame(key, false);
        }
        this.publishGauges();
    }

    getStats(): FrameCacheStats {
        let leasedFrameCount = 0;
        for (const frame of Array.from(this.residentFrames)) {
            if (frame.leaseCount > 0) leasedFrameCount += 1;
        }
        return {
            frameCount: this.frames.size,
            memoryBytes: this.residentMemoryBytes,
            maxMemoryBytes: this.maxMemoryBytes,
            leasedFrameCount,
            globalPixelBudget: this.decodedPixelBudget.snapshot(),
        };
    }

    getCachedTimestamps(videoId: string): number[] {
        const timestamps: number[] = [];
        const prefix = `${videoId}:`;
        this.frames.forEach((frame, key) => {
            if (key.startsWith(prefix)) timestamps.push(frame.timestamp);
        });
        return timestamps.sort((a, b) => a - b);
    }

    private findFrame(videoId: string, frameIndex: number): OwnedCachedFrame | null {
        const key = this.getKey(videoId, Math.max(0, Math.round(frameIndex)));
        const frame = this.frames.get(key) ?? null;
        if (frame) frame.lastUsed = ++this.accessSequence;
        return frame;
    }

    private getKey(videoId: string, frameIndex: number): string {
        return `${videoId}:${frameIndex}`;
    }

    private evictUntilFits(requiredBytes: number, incomingPriority: number): void {
        while (this.residentMemoryBytes + requiredBytes > this.maxMemoryBytes && this.frames.size > 0) {
            let oldestKey: string | null = null;
            let oldestAccess = Number.POSITIVE_INFINITY;
            let lowestPriority = Number.POSITIVE_INFINITY;
            for (const [key, frame] of Array.from(this.frames.entries())) {
                if (frame.retentionPriority < lowestPriority
                    || (frame.retentionPriority === lowestPriority && frame.lastUsed < oldestAccess)) {
                    lowestPriority = frame.retentionPriority;
                    oldestAccess = frame.lastUsed;
                    oldestKey = key;
                }
            }
            if (!oldestKey) break;
            // A low-value prefetch must not evict a frame already identified as more useful. The
            // caller retains ownership transfer semantics: addFrameAtIndex closes the rejected
            // incoming bitmap below, while the higher-priority resident frame remains untouched.
            if (lowestPriority > incomingPriority) break;
            this.detachFrame(oldestKey, true);
        }
    }

    private evictOneForGlobalBudget(incomingPriority: number): boolean {
        let candidateKey: string | null = null;
        let oldestAccess = Number.POSITIVE_INFINITY;
        let lowestPriority = Number.POSITIVE_INFINITY;
        for (const [key, frame] of Array.from(this.frames.entries())) {
            if (frame.leaseCount > 0) continue;
            if (
                frame.retentionPriority < lowestPriority
                || (frame.retentionPriority === lowestPriority && frame.lastUsed < oldestAccess)
            ) {
                lowestPriority = frame.retentionPriority;
                oldestAccess = frame.lastUsed;
                candidateKey = key;
            }
        }
        if (!candidateKey || lowestPriority > incomingPriority) return false;
        this.detachFrame(candidateKey, true);
        return true;
    }

    private normalizeRetentionPriority(priority?: number): number {
        return typeof priority === 'number' && !Number.isNaN(priority) ? priority : 0;
    }

    private detachFrame(key: string, isCapacityEviction: boolean): void {
        const frame = this.frames.get(key);
        if (!frame) return;
        this.frames.delete(key);
        frame.cached = false;
        if (isCapacityEviction) runtimeDiagnostics.increment('video', 'evictions');
        if (frame.leaseCount === 0) this.closeResidentFrame(frame);
    }

    private closeResidentFrame(frame: OwnedCachedFrame): void {
        if (!frame.resident) return;
        frame.resident = false;
        this.ownedBitmaps.delete(frame.bitmap);
        this.closeBitmapOnce(frame.bitmap);
        frame.pixelLease.release();
        this.residentFrames.delete(frame);
        this.residentMemoryBytes = Math.max(0, this.residentMemoryBytes - frame.sizeBytes);
        this.publishGauges();
    }

    private createAdmission(
        videoId: string,
        frameIndex: number,
        width: number,
        height: number,
        sizeBytes: number,
        retentionPriority: number,
        reservation: MediaBudgetReservation,
    ): FrameCacheAdmission {
        let released = false;
        let consumed = false;
        const admission: FrameCacheAdmission = {
            videoId,
            frameIndex,
            width,
            height,
            sizeBytes,
            retentionPriority,
            get released() {
                return released;
            },
            release() {
                if (released || consumed) return;
                released = true;
                reservation.release();
            },
        };
        this.admissionReservations.set(admission, () => {
            if (released || consumed) return null;
            consumed = true;
            released = true;
            return reservation;
        });
        return admission;
    }

    private consumeAdmission(admission: FrameCacheAdmission): MediaBudgetReservation | null {
        const consume = this.admissionReservations.get(admission);
        this.admissionReservations.delete(admission);
        return consume?.() ?? null;
    }

    private closeBitmapOnce(bitmap: ImageBitmap): void {
        if (this.closedBitmaps.has(bitmap)) return;
        this.closedBitmaps.add(bitmap);
        bitmap.close();
    }

    private publishGauges(): void {
        runtimeDiagnostics.setGauge('video', 'cacheBytes', this.residentMemoryBytes);
        runtimeDiagnostics.setGauge('video', 'cacheEntries', this.frames.size);
    }
}
