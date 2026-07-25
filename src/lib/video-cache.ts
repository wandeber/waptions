import type { WrappedCanvas } from 'mediabunny';
import {
    FrameCache,
    getAdaptiveFrameCacheBudgetBytes,
    getBrowserDeviceMemory,
    type FrameCacheAdmission,
    type ImageBitmapLease,
} from './frame-cache';
import { normalizeFps, timeToFrameIndex } from './frame-utils';
import type { MediaBudgetManager } from './media-byte-source/budget-manager';
import { mediaRuntimeBudgets } from './media-byte-source/budgets';
import { runtimeDiagnostics } from './runtime-diagnostics';
import { VideoFrameSession } from './video-frame-session';
import {
    type VideoFrameRequest,
    type VideoFrameRequestScope,
    type VideoFrameResult,
    type VideoFrameTargetResolution,
} from './video-runtime-types';

interface VideoCacheCounters {
    cacheHits: number;
    cacheMisses: number;
    seeks: number;
    sequentialReads: number;
    warmupFrames: number;
    cancelledWarmups: number;
}

interface VideoSessionLike {
    readonly fps: number;
    readonly generation: number;
    readonly isIdle?: boolean;
    request(
        scope: VideoFrameRequestScope,
        sourceTime: number,
        signal?: AbortSignal,
    ): Promise<WrappedCanvas | null>;
    whenIdle?(): Promise<void>;
    dispose(): Promise<void>;
}

interface SessionRecord {
    generation: number;
    controller: AbortController;
    opening: Promise<VideoSessionLike>;
    session: VideoSessionLike | null;
    disposed: boolean;
    activeWorkCount: number;
    lastUsed: number;
    idlePruneScheduled: boolean;
}

interface VideoCacheOptions {
    cacheMemoryMB?: number;
    openSession?: (options: {
        file: File;
        generation: number;
        signal: AbortSignal;
    }) => Promise<VideoSessionLike>;
    createBitmap?: (
        source: CanvasImageSource,
        options?: ImageBitmapOptions,
    ) => Promise<ImageBitmap>;
    now?: () => number;
    maxInactiveSessions?: number;
    decodedPixelBudget?: MediaBudgetManager;
}

interface PreviewResolutionState {
    target: VideoFrameTargetResolution;
    generation: number;
    pendingDownshift: {
        target: VideoFrameTargetResolution;
        sourceFingerprint: string;
        timer: ReturnType<typeof setTimeout> | null;
    } | null;
}

interface FrameWorkOutcome {
    cacheId: string;
    frameIndex: number;
    resolutionGeneration: number;
}

interface InFlightFrameWork {
    promise: Promise<FrameWorkOutcome | null>;
    controller: AbortController;
    subscribers: Set<symbol>;
    sourceId: string;
    sourceFingerprint: string;
    resolutionGeneration: number;
    retentionPriority: number;
}

const MAX_CACHE_RESOLUTION = 1280;
const PREVIEW_RESOLUTION_BUCKET = 32;
const RESOLUTION_DOWNSHIFT_STABILITY_MS = 500;
const RESOLUTION_DOWNSHIFT_AREA_RATIO = 0.7;
// Keeping a small recency window makes ordinary A/B clip navigation cheap without allowing every
// source in a large project to retain its Input, decoder state, CanvasSink, and pooled canvases.
const DEFAULT_MAX_INACTIVE_SESSIONS = 1;

/**
 * Bounded video runtime for source-native decoding and leased preview frames.
 *
 * Public callers submit typed scopes and source identity. Cache/session keys are private
 * implementation details derived from that policy, so no caller can accidentally mix domains.
 */
export class VideoCache {
    private readonly cache: FrameCache;
    private readonly openSession: NonNullable<VideoCacheOptions['openSession']>;
    private readonly createBitmap: NonNullable<VideoCacheOptions['createBitmap']>;
    private readonly now: () => number;
    private readonly maxInactiveSessions: number;
    private readonly decodedPixelBudget: MediaBudgetManager;
    private readonly sessions = new Map<string, SessionRecord>();
    private readonly generations = new Map<string, number>();
    private readonly sourceFingerprints = new Map<string, string>();
    private readonly resolutionStates = new Map<string, PreviewResolutionState>();
    private readonly inFlightFrames = new Map<string, InFlightFrameWork>();
    private sessionAccessSequence = 0;
    private activeSessionGauge = 0;
    private readonly defaultTargetResolution: VideoFrameTargetResolution = {
        width: MAX_CACHE_RESOLUTION,
        height: MAX_CACHE_RESOLUTION,
    };
    private counters: VideoCacheCounters = {
        cacheHits: 0,
        cacheMisses: 0,
        seeks: 0,
        sequentialReads: 0,
        warmupFrames: 0,
        cancelledWarmups: 0,
    };

    constructor(options: VideoCacheOptions = {}) {
        const adaptiveMemoryMB = getAdaptiveFrameCacheBudgetBytes(getBrowserDeviceMemory()) / (1024 * 1024);
        this.decodedPixelBudget = options.decodedPixelBudget ?? mediaRuntimeBudgets.decodedPixels;
        // The local preview LRU remains adaptive, but every resident bitmap also leases the shared
        // decoded-pixel budget used by decoder pools and thumbnails.
        this.cache = new FrameCache(options.cacheMemoryMB ?? adaptiveMemoryMB, this.decodedPixelBudget);
        this.openSession = options.openSession ?? ((sessionOptions) => VideoFrameSession.open({
            ...sessionOptions,
            decodedPixelBudget: this.decodedPixelBudget,
        }));
        this.createBitmap = options.createBitmap ?? ((source, bitmapOptions) => (
            createImageBitmap(source, bitmapOptions)
        ));
        this.now = options.now ?? (() => performance.now());
        const configuredSessionCap = options.maxInactiveSessions ?? DEFAULT_MAX_INACTIVE_SESSIONS;
        this.maxInactiveSessions = Number.isFinite(configuredSessionCap)
            ? Math.max(0, Math.floor(configuredSessionCap))
            : DEFAULT_MAX_INACTIVE_SESSIONS;
    }

    async requestFrame(request: VideoFrameRequest): Promise<VideoFrameResult | null> {
        if (request.signal?.aborted) return null;
        const scope = request.scope;
        runtimeDiagnostics.increment(
            'video',
            scope === 'preview' ? 'visibleRequests' : 'warmupRequests',
        );
        this.activateSourceIdentity(request.sourceId, request.sourceFingerprint);
        const resolution = this.resolveResolutionState(request);
        const retentionPriority = this.getRetentionPriority(request);
        const sourceFps = normalizeFps(request.sourceFps);
        const sourceFrameIndex = timeToFrameIndex(request.sourceTime, sourceFps);
        const cacheId = this.getPreviewCacheKey(request.sourceId, request.sourceFingerprint);
        const sessionKey = this.getSessionKey(request);

        const cached = this.cache.acquireFrameAtIndex(
            cacheId,
            sourceFrameIndex,
            retentionPriority,
        );
        if (cached) {
            this.touchSession(sessionKey);
            this.counters.cacheHits += 1;
            runtimeDiagnostics.increment('video', 'cacheHits');
            return this.resultFromLease(cached);
        }
        this.counters.cacheMisses += 1;
        runtimeDiagnostics.increment('video', 'cacheMisses');

        const workKey = JSON.stringify([
            cacheId,
            sourceFrameIndex,
            resolution.generation,
        ]);
        let work = this.inFlightFrames.get(workKey);
        if (work?.controller.signal.aborted) {
            // A newer warmup plan may request the same frame before the cancelled decoder task has
            // unwound. Do not subscribe it to a terminal work item; the session scheduler will
            // serialize the replacement behind the still-bounded underlying decode.
            this.inFlightFrames.delete(workKey);
            work = undefined;
        }
        if (work) {
            // A visible subscriber or a newer warmup plan may join an existing decode. Promotion is
            // monotonic and does not create another decoder task; every subscriber still acquires
            // its own lease after the one shared publication completes.
            work.retentionPriority = Math.max(work.retentionPriority, retentionPriority);
        }
        if (!work) {
            const controller = new AbortController();
            work = {
                controller,
                subscribers: new Set(),
                sourceId: request.sourceId,
                sourceFingerprint: request.sourceFingerprint,
                resolutionGeneration: resolution.generation,
                retentionPriority,
                promise: Promise.resolve(null),
            };
            const ownedWork = work;
            ownedWork.promise = this.produceFrame({
                request,
                sourceFps,
                sourceFrameIndex,
                cacheId,
                sessionKey,
                resolution,
                getRetentionPriority: () => {
                    // PreviewWarmupQueue may promote the mutable plan while decode or bitmap copy is
                    // active. Read it at publication time and merge it with subscriber promotions.
                    ownedWork.retentionPriority = Math.max(
                        ownedWork.retentionPriority,
                        this.getRetentionPriority(request),
                    );
                    return ownedWork.retentionPriority;
                },
                signal: controller.signal,
            }).finally(() => {
                if (this.inFlightFrames.get(workKey) === ownedWork) {
                    this.inFlightFrames.delete(workKey);
                }
            });
            this.inFlightFrames.set(workKey, ownedWork);
        }

        const outcome = await this.subscribeToFrameWork(work, request.signal);
        if (!outcome || request.signal?.aborted) return null;
        if (!this.isCurrentSourceResolution(
            request.sourceId,
            request.sourceFingerprint,
            outcome.resolutionGeneration,
        )) return null;
        const lease = this.cache.acquireFrameAtIndex(
            outcome.cacheId,
            outcome.frameIndex,
            this.getRetentionPriority(request),
        );
        return lease ? this.resultFromLease(lease) : null;
    }

    hasCachedPreviewFrame(
        sourceId: string,
        sourceFingerprint: string,
        sourceFrameIndex: number,
    ): boolean {
        return this.sourceFingerprints.get(sourceId) === sourceFingerprint
            && this.cache.hasFrameAtIndex(
                this.getPreviewCacheKey(sourceId, sourceFingerprint),
                sourceFrameIndex,
            );
    }

    getCachedPreviewTimestamps(sourceId: string, sourceFingerprint: string): number[] {
        if (this.sourceFingerprints.get(sourceId) !== sourceFingerprint) return [];
        return this.cache.getCachedTimestamps(this.getPreviewCacheKey(sourceId, sourceFingerprint));
    }

    clearPreviewSource(sourceId: string): void {
        const fingerprint = this.sourceFingerprints.get(sourceId);
        this.cancelResolutionDownshift(this.resolutionStates.get(sourceId));
        if (fingerprint !== undefined) {
            this.cancelInFlightSource(sourceId, fingerprint);
            void this.disposeSession(this.getPreviewSessionKey(sourceId, fingerprint));
            this.cache.clear(this.getPreviewCacheKey(sourceId, fingerprint));
        }
        this.sourceFingerprints.delete(sourceId);
        this.resolutionStates.delete(sourceId);
    }

    clearAll(): void {
        for (const state of Array.from(this.resolutionStates.values())) {
            this.cancelResolutionDownshift(state);
        }
        for (const work of Array.from(this.inFlightFrames.values())) work.controller.abort();
        for (const sessionKey of Array.from(this.sessions.keys())) void this.disposeSession(sessionKey);
        this.cache.clear();
        this.sourceFingerprints.clear();
        this.resolutionStates.clear();
    }

    getStats() {
        const frameStats = this.cache.getStats();
        const totalRequests = this.counters.cacheHits + this.counters.cacheMisses;
        return {
            totalSinks: this.sessions.size,
            activeSinks: this.activeSessionGauge,
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
            globalPixelBudget: frameStats.globalPixelBudget,
        };
    }

    private async ensureSession(sessionKey: string, file: File): Promise<SessionRecord | null> {
        const existing = this.sessions.get(sessionKey);
        if (existing && !existing.disposed) {
            existing.activeWorkCount += 1;
            this.touchSessionRecord(existing);
            return existing;
        }
        if (existing) await this.disposeSession(sessionKey);

        const generation = (this.generations.get(sessionKey) ?? 0) + 1;
        this.generations.set(sessionKey, generation);
        const controller = new AbortController();
        const record: SessionRecord = {
            generation,
            controller,
            session: null,
            disposed: false,
            activeWorkCount: 1,
            lastUsed: ++this.sessionAccessSequence,
            idlePruneScheduled: false,
            opening: Promise.resolve(null as unknown as VideoSessionLike),
        };
        record.opening = this.openSession({ file, generation, signal: controller.signal })
            .then(async (session) => {
                if (!this.isCurrentSession(sessionKey, record, session)) {
                    await session.dispose();
                    runtimeDiagnostics.increment('video', 'staleFrames');
                    return session;
                }
                record.session = session;
                this.activeSessionGauge += 1;
                runtimeDiagnostics.increment('video', 'sessionOpens');
                runtimeDiagnostics.setGauge('video', 'activeSessions', this.activeSessionGauge);
                return session;
            });
        this.sessions.set(sessionKey, record);
        try {
            await record.opening;
            return this.sessions.get(sessionKey) === record && !record.disposed ? record : null;
        } catch (error) {
            if (this.sessions.get(sessionKey) === record) this.sessions.delete(sessionKey);
            runtimeDiagnostics.setGauge('video', 'activeSessions', this.activeSessionGauge);
            if (controller.signal.aborted) return null;
            throw error;
        }
    }

    private async disposeSession(sessionKey: string): Promise<void> {
        const record = this.sessions.get(sessionKey);
        if (!record || record.disposed) return;
        record.disposed = true;
        record.controller.abort();
        this.sessions.delete(sessionKey);
        const session = record.session;
        if (session) {
            this.activeSessionGauge = Math.max(0, this.activeSessionGauge - 1);
            runtimeDiagnostics.setGauge('video', 'activeSessions', this.activeSessionGauge);
            await session.dispose();
            runtimeDiagnostics.increment('video', 'sessionDisposals');
            return;
        }
        runtimeDiagnostics.setGauge('video', 'activeSessions', this.activeSessionGauge);
    }

    private isCurrentSession(
        sessionKey: string,
        record: SessionRecord,
        session: VideoSessionLike,
    ): boolean {
        return !record.disposed
            && this.sessions.get(sessionKey) === record
            && record.generation === session.generation
            && this.generations.get(sessionKey) === record.generation;
    }

    private async createPreviewBitmap(
        canvas: HTMLCanvasElement | OffscreenCanvas,
        target: VideoFrameTargetResolution,
        admissionOptions: {
            videoId: string;
            frameIndex: number;
            retentionPriority: number;
            signal: AbortSignal;
        },
    ): Promise<{ bitmap: ImageBitmap; admission: FrameCacheAdmission } | null> {
        const sourceWidth = Math.max(1, canvas.width);
        const sourceHeight = Math.max(1, canvas.height);
        const localCacheBytes = this.cache.getStats().maxMemoryBytes;
        if (localCacheBytes < 4) return null;
        const localCacheScale = Math.sqrt(localCacheBytes / (sourceWidth * sourceHeight * 4));
        const scale = Math.min(
            1,
            target.width / sourceWidth,
            target.height / sourceHeight,
            localCacheScale,
        );
        // Floor both dimensions so rounding can never push the requested allocation over the
        // local hard cap used to derive localCacheScale.
        const resizeWidth = Math.max(1, Math.floor(sourceWidth * scale));
        const resizeHeight = Math.max(1, Math.floor(sourceHeight * scale));
        // One alignment bucket of headroom covers implementation-specific output alignment while
        // the cache commits only the actual bitmap bytes.
        const alignedAdmissionWidth = Math.ceil(
            (resizeWidth + PREVIEW_RESOLUTION_BUCKET) / PREVIEW_RESOLUTION_BUCKET,
        )
            * PREVIEW_RESOLUTION_BUCKET;
        const alignedAdmissionHeight = Math.ceil(
            (resizeHeight + PREVIEW_RESOLUTION_BUCKET) / PREVIEW_RESOLUTION_BUCKET,
        )
            * PREVIEW_RESOLUTION_BUCKET;
        const alignedAdmissionBytes = alignedAdmissionWidth * alignedAdmissionHeight * 4;
        const useAlignedAdmission = alignedAdmissionBytes <= localCacheBytes;
        const admission = await this.cache.reserveFrameAtIndex(
            admissionOptions.videoId,
            admissionOptions.frameIndex,
            resizeWidth,
            resizeHeight,
            {
                retentionPriority: admissionOptions.retentionPriority,
                signal: admissionOptions.signal,
                globalReservationBytes: useAlignedAdmission
                    ? alignedAdmissionBytes
                    : resizeWidth * resizeHeight * 4,
            },
        );
        if (!admission) return null;
        try {
            const bitmap = await this.createBitmap(canvas, {
                resizeWidth,
                resizeHeight,
                resizeQuality: 'high',
            });
            return { bitmap, admission };
        } catch (error) {
            admission.release();
            throw error;
        }
    }

    private resultFromLease(lease: ImageBitmapLease): VideoFrameResult {
        return {
            canvas: lease.bitmap,
            timestamp: lease.timestamp,
            duration: lease.duration,
            frameIndex: lease.frameIndex,
            release: lease.release,
        };
    }

    private async produceFrame({
        request,
        sourceFps,
        sourceFrameIndex,
        cacheId,
        sessionKey,
        resolution,
        getRetentionPriority,
        signal,
    }: {
        request: VideoFrameRequest;
        sourceFps: number;
        sourceFrameIndex: number;
        cacheId: string;
        sessionKey: string;
        resolution: PreviewResolutionState;
        getRetentionPriority: () => number;
        signal: AbortSignal;
    }): Promise<FrameWorkOutcome | null> {
        const decodeStartedAt = this.now();
        const record = await this.ensureSession(sessionKey, request.file);
        if (!record) {
            runtimeDiagnostics.increment('video', 'staleFrames');
            return null;
        }
        try {
            const session = record.session ?? await record.opening;
            if (signal.aborted || !this.isCurrentSession(sessionKey, record, session)) {
                runtimeDiagnostics.increment('video', 'staleFrames');
                return null;
            }

            let frame: WrappedCanvas | null;
            try {
                frame = await session.request(request.scope, request.sourceTime, signal);
            } catch (error) {
                if (signal.aborted || !this.isCurrentSession(sessionKey, record, session)) {
                    runtimeDiagnostics.increment('video', 'staleFrames');
                    return null;
                }
                throw error;
            }
            runtimeDiagnostics.observeTiming('video', 'decode', Math.max(0, this.now() - decodeStartedAt));
            if (!frame || signal.aborted) {
                if (request.scope === 'warmup') this.counters.cancelledWarmups += 1;
                return null;
            }
            runtimeDiagnostics.increment('video', 'decodedFrames');
            if (!this.isCurrentFrameWork(request, sessionKey, record, session, resolution.generation)) {
                runtimeDiagnostics.increment('video', 'staleFrames');
                return null;
            }

            const renderStartedAt = this.now();
            let preview: { bitmap: ImageBitmap; admission: FrameCacheAdmission } | null;
            try {
                preview = await this.createPreviewBitmap(frame.canvas, resolution.target, {
                    videoId: cacheId,
                    frameIndex: sourceFrameIndex,
                    retentionPriority: getRetentionPriority(),
                    signal,
                });
            } catch (error) {
                if (!signal.aborted
                    && this.isCurrentFrameWork(request, sessionKey, record, session, resolution.generation)) {
                    console.warn('Failed to create a stable preview bitmap:', error);
                }
                return null;
            }
            if (!preview) return null;
            const { bitmap, admission } = preview;
            runtimeDiagnostics.observeTiming('video', 'render', Math.max(0, this.now() - renderStartedAt));

            // Neither decoder cancellation nor createImageBitmap cancellation is universally
            // available. Publication therefore checks source, session, resolution, and subscriber
            // generations together; a late owned bitmap is closed exactly once on any mismatch.
            if (signal.aborted
                || !this.isCurrentFrameWork(request, sessionKey, record, session, resolution.generation)) {
                bitmap.close();
                admission.release();
                runtimeDiagnostics.increment('video', 'staleFrames');
                return null;
            }

            const added = this.cache.addFrameAtIndex(cacheId, sourceFrameIndex, bitmap, sourceFps, {
                timestamp: frame.timestamp,
                duration: frame.duration,
                retentionPriority: getRetentionPriority(),
                admission,
            });
            if (!added) return null;
            if (request.scope === 'warmup') this.counters.warmupFrames += 1;
            return {
                cacheId,
                frameIndex: sourceFrameIndex,
                resolutionGeneration: resolution.generation,
            };
        } finally {
            // The internal work lease spans decoding and the stable bitmap copy. Releasing it any
            // earlier could dispose the session while createImageBitmap still reads a pooled
            // decoder canvas; every return and error path must therefore pass through this block.
            this.releaseSessionWork(sessionKey, record);
        }
    }

    private touchSession(sessionKey: string): void {
        const record = this.sessions.get(sessionKey);
        if (!record || record.disposed) return;
        this.touchSessionRecord(record);
        this.pruneInactiveSessions();
    }

    private touchSessionRecord(record: SessionRecord): void {
        record.lastUsed = ++this.sessionAccessSequence;
    }

    private releaseSessionWork(sessionKey: string, record: SessionRecord): void {
        if (record.disposed) return;
        record.activeWorkCount = Math.max(0, record.activeWorkCount - 1);
        this.touchSessionRecord(record);
        if (record.activeWorkCount > 0) return;

        const session = record.session;
        if (session?.isIdle === false) {
            // Scheduler cancellation settles the caller immediately, but the underlying codec call
            // may still be unwinding. Wait for physical decoder idleness before making this record
            // an eviction candidate; one waiter per record keeps cancellation storms bounded.
            if (!session.whenIdle || record.idlePruneScheduled) return;
            record.idlePruneScheduled = true;
            void session.whenIdle().then(() => {
                record.idlePruneScheduled = false;
                if (this.sessions.get(sessionKey) !== record
                    || record.disposed
                    || record.activeWorkCount > 0) return;
                this.pruneInactiveSessions();
            }, () => {
                record.idlePruneScheduled = false;
            });
            return;
        }
        this.pruneInactiveSessions();
    }

    private pruneInactiveSessions(): void {
        const inactive = Array.from(this.sessions.entries())
            .filter(([, record]) => (
                !record.disposed
                && record.activeWorkCount === 0
                && record.session !== null
                && record.session.isIdle !== false
            ))
            .sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
        const excess = inactive.length - this.maxInactiveSessions;
        if (excess <= 0) return;

        for (const [sessionKey] of inactive.slice(0, excess)) {
            // disposeSession removes the record synchronously before awaiting owned backend cleanup,
            // so concurrent prune passes cannot select or dispose the same session twice.
            void this.disposeSession(sessionKey);
        }
    }

    private isCurrentFrameWork(
        request: VideoFrameRequest,
        sessionKey: string,
        record: SessionRecord,
        session: VideoSessionLike,
        resolutionGeneration: number,
    ): boolean {
        return this.isCurrentSession(sessionKey, record, session)
            && this.isCurrentSourceResolution(
                request.sourceId,
                request.sourceFingerprint,
                resolutionGeneration,
            );
    }

    private getRetentionPriority(request: VideoFrameRequest): number {
        // Demand-rendered frames always outrank speculative work. A visible cache hit is promoted
        // through acquireFrameAtIndex, so subsequent warmup cannot displace a frame the user saw.
        if (request.scope === 'preview') return Number.POSITIVE_INFINITY;
        const plan = request.warmupPlan;
        if (!plan) return 0;
        // Every newer plan outranks every older plan, while the reciprocal component preserves the
        // usefulness-first request order inside one plan. This separates decode order from LRU
        // survival even when the long-lived queue deliberately reuses its AbortSignal.
        return plan.generation + (1 / (plan.order + 1));
    }

    private subscribeToFrameWork(
        work: InFlightFrameWork,
        signal?: AbortSignal,
    ): Promise<FrameWorkOutcome | null> {
        if (signal?.aborted) {
            if (work.subscribers.size === 0) work.controller.abort();
            return Promise.resolve(null);
        }
        const subscriber = Symbol('video-frame-subscriber');
        work.subscribers.add(subscriber);

        return new Promise<FrameWorkOutcome | null>((resolve, reject) => {
            let settled = false;
            const finish = (outcome: FrameWorkOutcome | null) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', handleAbort);
                work.subscribers.delete(subscriber);
                resolve(outcome);
            };
            const handleAbort = () => {
                finish(null);
                if (work.subscribers.size === 0) work.controller.abort();
            };
            signal?.addEventListener('abort', handleAbort, { once: true });
            work.promise.then(finish, (error) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', handleAbort);
                work.subscribers.delete(subscriber);
                reject(error);
            });
        });
    }

    private resolveResolutionState(request: VideoFrameRequest): PreviewResolutionState {
        const current = this.resolutionStates.get(request.sourceId);
        const requested = request.targetResolution
            ? this.normalizeTargetResolution(
                request.targetResolution.width,
                request.targetResolution.height,
            )
            : null;

        if (!current) {
            const state = {
                // Warmup has no viewport measurement. Starting at the bounded long-edge ceiling
                // makes its frames directly reusable by the first visible request instead of
                // clearing useful work as soon as the viewport reports a smaller target.
                target: requested ?? this.defaultTargetResolution,
                generation: 1,
                pendingDownshift: null,
            };
            this.resolutionStates.set(request.sourceId, state);
            return state;
        }
        if (!requested) return current;
        if (requested.width > current.target.width || requested.height > current.target.height) {
            return this.commitResolutionChange(
                request.sourceId,
                request.sourceFingerprint,
                current,
                {
                    width: Math.max(current.target.width, requested.width),
                    height: Math.max(current.target.height, requested.height),
                },
            );
        }

        const currentArea = current.target.width * current.target.height;
        const requestedArea = requested.width * requested.height;
        if (requestedArea > currentArea * RESOLUTION_DOWNSHIFT_AREA_RATIO) {
            // Small layout oscillations keep the current allocation. They also cancel a pending
            // large downshift, so a transient collapsed panel cannot fire after the viewport has
            // already returned to its previous size.
            this.cancelResolutionDownshift(current);
            return current;
        }

        const pending = current.pendingDownshift;
        if (pending
            && pending.sourceFingerprint === request.sourceFingerprint
            && this.sameResolution(pending.target, requested)) {
            return current;
        }
        this.cancelResolutionDownshift(current);
        const candidate: NonNullable<PreviewResolutionState['pendingDownshift']> = {
            target: requested,
            sourceFingerprint: request.sourceFingerprint,
            timer: null,
        };
        candidate.timer = globalThis.setTimeout(() => {
            // The callback owns no bitmap or decoder resource. It commits only while the exact
            // source/state/candidate is still current; grow, replacement, clear, and superseding
            // shrink paths cancel the timer and make this identity check fail safely.
            if (this.resolutionStates.get(request.sourceId) !== current
                || current.pendingDownshift !== candidate
                || this.sourceFingerprints.get(request.sourceId) !== request.sourceFingerprint) return;
            this.commitResolutionChange(
                request.sourceId,
                request.sourceFingerprint,
                current,
                candidate.target,
            );
        }, RESOLUTION_DOWNSHIFT_STABILITY_MS);
        current.pendingDownshift = candidate;
        return current;
    }

    private commitResolutionChange(
        sourceId: string,
        sourceFingerprint: string,
        current: PreviewResolutionState,
        target: VideoFrameTargetResolution,
    ): PreviewResolutionState {
        this.cancelResolutionDownshift(current);
        const next = {
            target,
            generation: current.generation + 1,
            pendingDownshift: null,
        };
        this.resolutionStates.set(sourceId, next);
        this.cancelInFlightSource(
            sourceId,
            sourceFingerprint,
            current.generation,
        );
        this.cache.clear(this.getPreviewCacheKey(sourceId, sourceFingerprint));
        return next;
    }

    private cancelResolutionDownshift(state?: PreviewResolutionState): void {
        const pending = state?.pendingDownshift;
        if (!pending) return;
        if (pending.timer !== null) globalThis.clearTimeout(pending.timer);
        state.pendingDownshift = null;
    }

    private sameResolution(
        left: VideoFrameTargetResolution,
        right: VideoFrameTargetResolution,
    ): boolean {
        return left.width === right.width && left.height === right.height;
    }

    private normalizeTargetResolution(
        width: number,
        height: number,
    ): VideoFrameTargetResolution {
        const safeWidth = Math.max(1, Math.round(width));
        const safeHeight = Math.max(1, Math.round(height));
        const longEdge = Math.max(safeWidth, safeHeight);
        const scale = longEdge > MAX_CACHE_RESOLUTION
            ? MAX_CACHE_RESOLUTION / longEdge
            : 1;
        const scaledWidth = Math.max(1, Math.round(safeWidth * scale));
        const scaledHeight = Math.max(1, Math.round(safeHeight * scale));
        return {
            width: Math.max(1, Math.round(scaledWidth / PREVIEW_RESOLUTION_BUCKET) * PREVIEW_RESOLUTION_BUCKET),
            height: Math.max(1, Math.round(scaledHeight / PREVIEW_RESOLUTION_BUCKET) * PREVIEW_RESOLUTION_BUCKET),
        };
    }

    private getSessionKey(request: VideoFrameRequest): string {
        return this.getPreviewSessionKey(request.sourceId, request.sourceFingerprint);
    }

    private getPreviewSessionKey(sourceId: string, sourceFingerprint: string): string {
        return JSON.stringify(['preview-session', sourceId, sourceFingerprint]);
    }

    private getPreviewCacheKey(sourceId: string, sourceFingerprint: string): string {
        return JSON.stringify(['preview-cache', sourceId, sourceFingerprint]);
    }

    private activateSourceIdentity(sourceId: string, sourceFingerprint: string): void {
        const previousFingerprint = this.sourceFingerprints.get(sourceId);
        if (previousFingerprint === sourceFingerprint) return;

        if (previousFingerprint !== undefined) {
            // A project may replace a File while retaining its logical source ID. Abort the old
            // generation before any lookup so neither cached nor late decoded pixels can cross the
            // immutable V3 fingerprint boundary. Leased bitmaps close when their owner releases.
            this.cancelInFlightSource(sourceId, previousFingerprint);
            void this.disposeSession(this.getPreviewSessionKey(sourceId, previousFingerprint));
            this.cache.clear(this.getPreviewCacheKey(sourceId, previousFingerprint));
            this.cancelResolutionDownshift(this.resolutionStates.get(sourceId));
            this.resolutionStates.delete(sourceId);
        }
        this.sourceFingerprints.set(sourceId, sourceFingerprint);
    }

    private isCurrentSourceResolution(
        sourceId: string,
        sourceFingerprint: string,
        resolutionGeneration: number,
    ): boolean {
        return this.sourceFingerprints.get(sourceId) === sourceFingerprint
            && this.resolutionStates.get(sourceId)?.generation === resolutionGeneration;
    }

    private cancelInFlightSource(
        sourceId: string,
        sourceFingerprint: string,
        resolutionGeneration?: number,
    ): void {
        // Replacement, explicit clear, and infrequent viewport growth are cold paths. Scanning the
        // small in-flight set here avoids any session-wide scan in the per-frame hot path.
        for (const work of Array.from(this.inFlightFrames.values())) {
            if (work.sourceId !== sourceId || work.sourceFingerprint !== sourceFingerprint) continue;
            if (resolutionGeneration !== undefined
                && work.resolutionGeneration !== resolutionGeneration) continue;
            work.controller.abort();
        }
    }
}

export const videoCache = new VideoCache();
