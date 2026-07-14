import { describe, expect, it, vi } from 'vitest';
import type { PreviewWarmupFrame } from './video-runtime-types';
import { PreviewWarmupQueue } from './preview-warmup-queue';
import { VideoCache } from './video-cache';

const frame = (projectFrameIndex: number): PreviewWarmupFrame => ({
    projectFrameIndex,
    sourceId: 'source',
    sourceFrameIndex: projectFrameIndex,
    sourceTime: projectFrameIndex / 30,
});

const createScheduler = () => {
    const callbacks: Array<() => void> = [];
    return {
        callbacks,
        schedule: (callback: () => void) => callbacks.push(callback),
        flush: () => callbacks.shift()?.(),
    };
};

describe('PreviewWarmupQueue', () => {
    it('keeps a slow decode alive across playback ticks and publishes it into cache', async () => {
        const scheduler = createScheduler();
        const cached = new Set<number>();
        const releases: Array<() => void> = [];
        const requested: number[] = [];
        let activeSignal: AbortSignal | null = null;
        const queue = new PreviewWarmupQueue({
            schedule: scheduler.schedule,
            hasFrame: (candidate) => cached.has(candidate.sourceFrameIndex),
            request: async (candidate, signal) => {
                requested.push(candidate.sourceFrameIndex);
                activeSignal = signal;
                await new Promise<void>((resolve, reject) => {
                    releases.push(resolve);
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
                cached.add(candidate.sourceFrameIndex);
            },
        });

        queue.enqueue([frame(1), frame(2), frame(3)], 0);
        scheduler.flush();
        expect(requested).toEqual([1]);

        // Repeated ticks move the requested runway forward without aborting frame 1. Pending
        // frames behind the new clock are discarded and the newest lookahead is coalesced once.
        queue.enqueue([frame(2), frame(3), frame(4)], 1);
        queue.enqueue([frame(3), frame(4), frame(5)], 2);
        expect((activeSignal as AbortSignal | null)?.aborted).toBe(false);
        releases[0]();
        await Promise.resolve();
        await Promise.resolve();
        expect(cached.has(1)).toBe(true);

        scheduler.flush();
        expect(requested).toEqual([1, 3]);
        queue.dispose();
    });

    it('aborts the in-flight generation on an explicit reset', async () => {
        const scheduler = createScheduler();
        let observedSignal: AbortSignal | null = null;
        const queue = new PreviewWarmupQueue({
            schedule: scheduler.schedule,
            hasFrame: () => false,
            request: async (_candidate, signal) => {
                observedSignal = signal;
                await new Promise(() => undefined);
            },
            onError: vi.fn(),
        });

        queue.enqueue([frame(1)]);
        scheduler.flush();
        queue.reset();

        expect(observedSignal).not.toBeNull();
        expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);
        queue.dispose();
    });

    it('admits the newest lookahead plans while reusing one persistent cancellation signal', async () => {
        const scheduler = createScheduler();
        const requested: number[] = [];
        const observedSignals: AbortSignal[] = [];
        const observedPlanGenerations: number[] = [];
        const videoFile = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(async (_scope: 'preview' | 'warmup', sourceTime: number) => ({
                canvas: { width: 256, height: 256 } as OffscreenCanvas,
                timestamp: sourceTime,
                duration: 1 / 30,
            })),
            dispose: vi.fn(async () => undefined),
        };
        const videoCache = new VideoCache({
            // Exactly three bitmaps fit. Every later plan must therefore displace the prior runway
            // even though PreviewWarmupQueue intentionally keeps one AbortSignal across ticks.
            cacheMemoryMB: 0.75,
            createBitmap: vi.fn(async () => ({
                width: 256,
                height: 256,
                close: vi.fn(),
            }) as unknown as ImageBitmap),
            openSession: vi.fn(async () => session),
        });
        const queue = new PreviewWarmupQueue({
            schedule: scheduler.schedule,
            hasFrame: (candidate) => videoCache.hasCachedPreviewFrame(
                candidate.sourceId,
                'fingerprint',
                candidate.sourceFrameIndex,
            ),
            request: async (candidate, signal, plan) => {
                const result = await videoCache.requestFrame({
                    scope: 'warmup',
                    sourceId: candidate.sourceId,
                    sourceFingerprint: 'fingerprint',
                    file: videoFile,
                    sourceTime: candidate.sourceTime,
                    sourceFps: 30,
                    signal,
                    warmupPlan: plan,
                });
                result?.release();
                requested.push(candidate.sourceFrameIndex);
                observedSignals.push(signal);
                observedPlanGenerations.push(plan.generation);
            },
        });
        const drainTo = async (expectedRequests: number) => {
            while (requested.length < expectedRequests) {
                await vi.waitFor(() => expect(scheduler.callbacks.length).toBeGreaterThan(0));
                scheduler.flush();
                const previousCount = requested.length;
                await vi.waitFor(() => expect(requested.length).toBeGreaterThan(previousCount));
            }
            await Promise.resolve();
            await Promise.resolve();
        };

        queue.enqueue([frame(1), frame(2), frame(3)]);
        await drainTo(3);
        expect([1, 2, 3].map((index) => (
            videoCache.hasCachedPreviewFrame('source', 'fingerprint', index)
        ))).toEqual([true, true, true]);

        queue.enqueue([frame(4), frame(5), frame(6)]);
        await drainTo(6);
        expect([4, 5, 6].map((index) => (
            videoCache.hasCachedPreviewFrame('source', 'fingerprint', index)
        ))).toEqual([true, true, true]);
        expect([1, 2, 3].some((index) => (
            videoCache.hasCachedPreviewFrame('source', 'fingerprint', index)
        ))).toBe(false);

        queue.enqueue([frame(7), frame(8), frame(9)]);
        await drainTo(9);
        expect(new Set(observedSignals).size).toBe(1);
        expect(new Set(observedPlanGenerations.slice(0, 3)).size).toBe(1);
        expect(new Set(observedPlanGenerations.slice(3, 6)).size).toBe(1);
        expect(observedPlanGenerations[3]).toBeGreaterThan(observedPlanGenerations[0]);
        expect(observedPlanGenerations[6]).toBeGreaterThan(observedPlanGenerations[3]);
        expect([7, 8, 9].map((index) => (
            videoCache.hasCachedPreviewFrame('source', 'fingerprint', index)
        ))).toEqual([true, true, true]);
        queue.dispose();
        videoCache.clearAll();
    });

    it('promotes one slow active decode when the newest full-cache plan still requires it', async () => {
        const scheduler = createScheduler();
        const requested: number[] = [];
        const decoderStarts: number[] = [];
        const videoFile = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
        let releaseSlowFrame!: () => void;
        const slowFrame = new Promise<void>((resolve) => { releaseSlowFrame = resolve; });
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(async (_scope: 'preview' | 'warmup', sourceTime: number) => {
                const sourceFrameIndex = Math.round(sourceTime * 30);
                decoderStarts.push(sourceFrameIndex);
                if (sourceFrameIndex === 4) await slowFrame;
                return {
                    canvas: { width: 256, height: 256 } as OffscreenCanvas,
                    timestamp: sourceTime,
                    duration: 1 / 30,
                };
            }),
            dispose: vi.fn(async () => undefined),
        };
        const videoCache = new VideoCache({
            cacheMemoryMB: 0.75,
            createBitmap: vi.fn(async () => ({
                width: 256,
                height: 256,
                close: vi.fn(),
            }) as unknown as ImageBitmap),
            openSession: vi.fn(async () => session),
        });
        const activePlanRef: {
            current: { generation: number; order: number } | null;
        } = { current: null };
        let initialActiveGeneration = -1;
        const queue = new PreviewWarmupQueue({
            schedule: scheduler.schedule,
            hasFrame: (candidate) => videoCache.hasCachedPreviewFrame(
                candidate.sourceId,
                'fingerprint',
                candidate.sourceFrameIndex,
            ),
            request: async (candidate, signal, plan) => {
                if (candidate.sourceFrameIndex === 4 && !activePlanRef.current) {
                    activePlanRef.current = plan;
                    initialActiveGeneration = plan.generation;
                }
                const result = await videoCache.requestFrame({
                    scope: 'warmup',
                    sourceId: candidate.sourceId,
                    sourceFingerprint: 'fingerprint',
                    file: videoFile,
                    sourceTime: candidate.sourceTime,
                    sourceFps: 30,
                    signal,
                    warmupPlan: plan,
                });
                result?.release();
                requested.push(candidate.sourceFrameIndex);
            },
        });
        const drainTo = async (expectedRequests: number) => {
            while (requested.length < expectedRequests) {
                await vi.waitFor(() => expect(scheduler.callbacks.length).toBeGreaterThan(0));
                scheduler.flush();
                const previousCount = requested.length;
                await vi.waitFor(() => expect(requested.length).toBeGreaterThan(previousCount));
            }
            await Promise.resolve();
            await Promise.resolve();
        };

        queue.enqueue([frame(1), frame(2), frame(3)]);
        await drainTo(3);
        queue.enqueue([frame(4), frame(5), frame(6)]);
        scheduler.flush();
        await vi.waitFor(() => expect(decoderStarts).toContain(4));

        // Frame 4 is already decoding and the cache is full. The new plan drops pending 5/6,
        // includes frame 4 again, and adds enough later frames that stale priority would evict 4.
        queue.enqueue([frame(4), frame(7), frame(8), frame(9)], 6);
        const promotedActivePlan = activePlanRef.current;
        if (!promotedActivePlan) throw new Error('The slow warmup plan was not captured.');
        expect(promotedActivePlan.generation).toBeGreaterThan(initialActiveGeneration);
        releaseSlowFrame();
        await drainTo(7);

        expect(decoderStarts.filter((index) => index === 4)).toHaveLength(1);
        expect([4, 7, 8].map((index) => (
            videoCache.hasCachedPreviewFrame('source', 'fingerprint', index)
        ))).toEqual([true, true, true]);
        expect(videoCache.hasCachedPreviewFrame('source', 'fingerprint', 9)).toBe(false);
        queue.dispose();
        videoCache.clearAll();
    });
});
