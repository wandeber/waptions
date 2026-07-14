import { describe, expect, it, vi } from 'vitest';
import type { WrappedCanvas } from 'mediabunny';
import { VideoCache } from './video-cache';
import type { VideoFrameRequestScope } from './video-runtime-types';
import { runtimeDiagnostics } from './runtime-diagnostics';

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
    return { promise, resolve };
};

const file = new File(['video'], 'clip.mp4', { type: 'video/mp4', lastModified: 7 });
const replacementFile = new File(['replacement'], 'replacement.mp4', {
    type: 'video/mp4',
    lastModified: 8,
});
const fingerprintA = 'fingerprint-a';
const fingerprintB = 'fingerprint-b';

function wrappedFrame(): WrappedCanvas {
    return {
        canvas: { width: 1920, height: 1080 } as OffscreenCanvas,
        timestamp: 0,
        duration: 1 / 30,
    };
}

function imageBitmap() {
    return { width: 640, height: 360, close: vi.fn() } as unknown as ImageBitmap;
}

describe('VideoCache', () => {
    it('closes a bitmap that completes after the session generation was cleared', async () => {
        const bitmapGate = deferred<ImageBitmap>();
        const bitmap = imageBitmap();
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(async () => wrappedFrame()),
            dispose: vi.fn(async () => undefined),
        };
        const videoCache = new VideoCache({
            cacheMemoryMB: 1,
            createBitmap: vi.fn(() => bitmapGate.promise),
            openSession: vi.fn(async () => session),
        });

        const pending = videoCache.requestFrame({
            scope: 'preview',
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
        });
        await vi.waitFor(() => expect(session.request).toHaveBeenCalled());
        videoCache.clearPreviewSource('source');
        bitmapGate.resolve(bitmap);

        await expect(pending).resolves.toBeNull();
        expect(bitmap.close).toHaveBeenCalledTimes(1);
        expect(videoCache.getStats().cachedFrames).toBe(0);
    });

    it('disposes a late initialization and never publishes it after clear', async () => {
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(async (
                scope: VideoFrameRequestScope,
                sourceTime: number,
            ): Promise<WrappedCanvas | null> => {
                void scope;
                void sourceTime;
                return wrappedFrame();
            }),
            dispose: vi.fn(async () => undefined),
        };
        const opening = deferred<typeof session>();
        const videoCache = new VideoCache({
            cacheMemoryMB: 1,
            createBitmap: vi.fn(async () => imageBitmap()),
            openSession: vi.fn(() => opening.promise),
        });
        const pending = videoCache.requestFrame({
            scope: 'preview',
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
        });

        videoCache.clearPreviewSource('source');
        opening.resolve(session);

        await expect(pending).resolves.toBeNull();
        expect(session.dispose).toHaveBeenCalledTimes(1);
        expect(session.request).not.toHaveBeenCalled();
    });

    it('downscales source aspect once when creating a preview bitmap', async () => {
        const bitmap = imageBitmap();
        const createBitmap = vi.fn(async (
            source: CanvasImageSource,
            options?: ImageBitmapOptions,
        ) => {
            void source;
            void options;
            return bitmap;
        });
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(async () => wrappedFrame()),
            dispose: vi.fn(async () => undefined),
        };
        const videoCache = new VideoCache({
            cacheMemoryMB: 10,
            createBitmap,
            openSession: vi.fn(async () => session),
        });

        const result = await videoCache.requestFrame({
            scope: 'preview',
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
        });

        expect(createBitmap).toHaveBeenCalledTimes(1);
        expect(createBitmap.mock.calls[0][1]).toMatchObject({
            resizeWidth: 1280,
            resizeHeight: 720,
            resizeQuality: 'high',
        });
        result?.release();
        videoCache.clearPreviewSource('source');
    });

    it('reuses a leased preview bitmap and releases it safely on clear', async () => {
        const bitmap = imageBitmap();
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(async () => wrappedFrame()),
            dispose: vi.fn(async () => undefined),
        };
        const videoCache = new VideoCache({
            cacheMemoryMB: 1,
            createBitmap: vi.fn(async () => bitmap),
            openSession: vi.fn(async () => session),
        });
        const request = {
            scope: 'preview' as const,
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
        };

        const first = await videoCache.requestFrame(request);
        const second = await videoCache.requestFrame(request);
        expect(session.request).toHaveBeenCalledTimes(1);
        expect(second?.canvas).toBe(bitmap);
        expect(videoCache.getCachedPreviewTimestamps('source', fingerprintA)).toEqual([0]);

        first?.release();
        videoCache.clearPreviewSource('source');
        expect(videoCache.getCachedPreviewTimestamps('source', fingerprintA)).toEqual([]);
        expect(bitmap.close).not.toHaveBeenCalled();
        second?.release();
        expect(bitmap.close).toHaveBeenCalledTimes(1);
    });

    it('replaces a cached same-ID source at the immutable fingerprint boundary', async () => {
        const oldBitmap = imageBitmap();
        const newBitmap = imageBitmap();
        const oldSession = {
            fps: 30,
            generation: 1,
            request: vi.fn(async () => wrappedFrame()),
            dispose: vi.fn(async () => undefined),
        };
        const newSession = {
            fps: 30,
            generation: 1,
            request: vi.fn(async () => wrappedFrame()),
            dispose: vi.fn(async () => undefined),
        };
        const videoCache = new VideoCache({
            cacheMemoryMB: 10,
            createBitmap: vi.fn()
                .mockResolvedValueOnce(oldBitmap)
                .mockResolvedValueOnce(newBitmap),
            openSession: vi.fn(async ({ file: openedFile }) => (
                openedFile === file ? oldSession : newSession
            )),
        });
        const first = await videoCache.requestFrame({
            scope: 'preview',
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
        });

        const replacement = await videoCache.requestFrame({
            scope: 'preview',
            sourceId: 'source',
            sourceFingerprint: fingerprintB,
            file: replacementFile,
            sourceTime: 0,
            sourceFps: 30,
        });

        expect(replacement?.canvas).toBe(newBitmap);
        expect(replacement?.canvas).not.toBe(oldBitmap);
        expect(oldSession.dispose).toHaveBeenCalledTimes(1);
        expect(videoCache.getCachedPreviewTimestamps('source', fingerprintA)).toEqual([]);
        expect(videoCache.getCachedPreviewTimestamps('source', fingerprintB)).toEqual([0]);
        expect(oldBitmap.close).not.toHaveBeenCalled();

        first?.release();
        first?.release();
        expect(oldBitmap.close).toHaveBeenCalledTimes(1);
        replacement?.release();
        videoCache.clearPreviewSource('source');
        videoCache.clearPreviewSource('source');
        expect(newBitmap.close).toHaveBeenCalledTimes(1);
        expect(newSession.dispose).toHaveBeenCalledTimes(1);
    });

    it('rejects an old decode that completes after same-ID replacement', async () => {
        const oldDecode = deferred<WrappedCanvas | null>();
        const newBitmap = imageBitmap();
        const oldSession = {
            fps: 30,
            generation: 1,
            request: vi.fn(() => oldDecode.promise),
            dispose: vi.fn(async () => undefined),
        };
        const newSession = {
            fps: 30,
            generation: 1,
            request: vi.fn(async () => wrappedFrame()),
            dispose: vi.fn(async () => undefined),
        };
        const createBitmap = vi.fn(async () => newBitmap);
        const videoCache = new VideoCache({
            cacheMemoryMB: 10,
            createBitmap,
            openSession: vi.fn(async ({ file: openedFile }) => (
                openedFile === file ? oldSession : newSession
            )),
        });
        const staleRequest = videoCache.requestFrame({
            scope: 'preview',
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
        });
        await vi.waitFor(() => expect(oldSession.request).toHaveBeenCalledTimes(1));

        const replacement = await videoCache.requestFrame({
            scope: 'preview',
            sourceId: 'source',
            sourceFingerprint: fingerprintB,
            file: replacementFile,
            sourceTime: 0,
            sourceFps: 30,
        });
        oldDecode.resolve(wrappedFrame());

        await expect(staleRequest).resolves.toBeNull();
        expect(replacement?.canvas).toBe(newBitmap);
        expect(createBitmap).toHaveBeenCalledTimes(1);
        expect(oldSession.dispose).toHaveBeenCalledTimes(1);
        replacement?.release();
        videoCache.clearPreviewSource('source');
    });

    it('closes an old bitmap that completes after same-ID replacement', async () => {
        const oldBitmapGate = deferred<ImageBitmap>();
        const oldBitmap = imageBitmap();
        const newBitmap = imageBitmap();
        const oldSession = {
            fps: 30,
            generation: 1,
            request: vi.fn(async () => wrappedFrame()),
            dispose: vi.fn(async () => undefined),
        };
        const newSession = {
            fps: 30,
            generation: 1,
            request: vi.fn(async () => wrappedFrame()),
            dispose: vi.fn(async () => undefined),
        };
        let bitmapRequest = 0;
        const videoCache = new VideoCache({
            cacheMemoryMB: 10,
            createBitmap: vi.fn(() => {
                bitmapRequest += 1;
                return bitmapRequest === 1 ? oldBitmapGate.promise : Promise.resolve(newBitmap);
            }),
            openSession: vi.fn(async ({ file: openedFile }) => (
                openedFile === file ? oldSession : newSession
            )),
        });
        const staleRequest = videoCache.requestFrame({
            scope: 'preview',
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
        });
        await vi.waitFor(() => expect(bitmapRequest).toBe(1));

        const replacement = await videoCache.requestFrame({
            scope: 'preview',
            sourceId: 'source',
            sourceFingerprint: fingerprintB,
            file: replacementFile,
            sourceTime: 0,
            sourceFps: 30,
        });
        oldBitmapGate.resolve(oldBitmap);

        await expect(staleRequest).resolves.toBeNull();
        expect(replacement?.canvas).toBe(newBitmap);
        expect(replacement?.canvas).not.toBe(oldBitmap);
        expect(oldBitmap.close).toHaveBeenCalledTimes(1);
        expect(oldSession.dispose).toHaveBeenCalledTimes(1);
        replacement?.release();
        videoCache.clearPreviewSource('source');
    });

    it('reuses a warmup frame for the first smaller visible target', async () => {
        const bitmap = imageBitmap();
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(async () => wrappedFrame()),
            dispose: vi.fn(async () => undefined),
        };
        const createBitmap = vi.fn(async () => bitmap);
        const videoCache = new VideoCache({
            cacheMemoryMB: 10,
            createBitmap,
            openSession: vi.fn(async () => session),
        });

        const warmed = await videoCache.requestFrame({
            scope: 'warmup',
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
        });
        warmed?.release();
        const visible = await videoCache.requestFrame({
            scope: 'preview',
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
            targetResolution: { width: 640, height: 360 },
        });

        expect(visible?.canvas).toBe(bitmap);
        expect(session.request).toHaveBeenCalledTimes(1);
        expect(createBitmap).toHaveBeenCalledTimes(1);
        visible?.release();
        videoCache.clearPreviewSource('source');
    });

    it('decodes useful warmup frames first and retains them when the LRU budget fills', async () => {
        const requestedSourceFrames: number[] = [];
        const bitmaps: ImageBitmap[] = [];
        const session = {
            fps: 4,
            generation: 1,
            request: vi.fn(async (
                _scope: VideoFrameRequestScope,
                sourceTime: number,
            ) => {
                requestedSourceFrames.push(Math.round(sourceTime * 4));
                return {
                    canvas: { width: 256, height: 256 } as OffscreenCanvas,
                    timestamp: sourceTime,
                    duration: 0.25,
                };
            }),
            dispose: vi.fn(async () => undefined),
        };
        const videoCache = new VideoCache({
            // Three stable RGBA bitmaps fit exactly. Later work still decodes in plan order, but
            // priority-aware admission must reject it without evicting frames 11, 12, and 13.
            cacheMemoryMB: 0.75,
            createBitmap: vi.fn(async () => {
                const bitmap = {
                    width: 256,
                    height: 256,
                    close: vi.fn(),
                } as unknown as ImageBitmap;
                bitmaps.push(bitmap);
                return bitmap;
            }),
            openSession: vi.fn(async () => session),
        });
        const controller = new AbortController();
        const requestedPlan = [11, 12, 13, 14, 15, 20, 8];

        for (let order = 0; order < requestedPlan.length; order += 1) {
            const sourceFrameIndex = requestedPlan[order];
            const result = await videoCache.requestFrame({
                scope: 'warmup',
                sourceId: 'source',
                sourceFingerprint: fingerprintA,
                file,
                sourceTime: sourceFrameIndex / 4,
                sourceFps: 4,
                signal: controller.signal,
                warmupPlan: { generation: 1, order },
            });
            result?.release();
        }

        expect(requestedSourceFrames).toEqual(requestedPlan);
        expect([11, 12, 13].map((index) => (
            videoCache.hasCachedPreviewFrame('source', fingerprintA, index)
        ))).toEqual([true, true, true]);
        expect([14, 15, 20, 8].map((index) => (
            videoCache.hasCachedPreviewFrame('source', fingerprintA, index)
        ))).toEqual([false, false, false, false]);
        expect(videoCache.getStats().cachedFrames).toBe(3);
        expect(bitmaps.slice(3).every((bitmap) => (
            vi.mocked(bitmap.close).mock.calls.length === 1
        ))).toBe(true);
        videoCache.clearPreviewSource('source');
    });

    it('closes an old-resolution bitmap that finishes after viewport growth', async () => {
        const oldBitmapGate = deferred<ImageBitmap>();
        const oldBitmap = imageBitmap();
        const newBitmap = imageBitmap();
        let bitmapRequest = 0;
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(async () => wrappedFrame()),
            dispose: vi.fn(async () => undefined),
        };
        const videoCache = new VideoCache({
            cacheMemoryMB: 10,
            createBitmap: vi.fn(() => {
                bitmapRequest += 1;
                return bitmapRequest === 1 ? oldBitmapGate.promise : Promise.resolve(newBitmap);
            }),
            openSession: vi.fn(async () => session),
        });
        const staleResolution = videoCache.requestFrame({
            scope: 'preview',
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
            targetResolution: { width: 320, height: 180 },
        });
        await vi.waitFor(() => expect(bitmapRequest).toBe(1));

        const currentResolution = await videoCache.requestFrame({
            scope: 'preview',
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
            targetResolution: { width: 960, height: 540 },
        });
        oldBitmapGate.resolve(oldBitmap);

        await expect(staleResolution).resolves.toBeNull();
        expect(currentResolution?.canvas).toBe(newBitmap);
        expect(oldBitmap.close).toHaveBeenCalledTimes(1);
        currentResolution?.release();
        videoCache.clearPreviewSource('source');
    });

    it('downshifts a fully cached runway on the timer without another frame request', async () => {
        vi.useFakeTimers();
        const staleBitmapGate = deferred<ImageBitmap>();
        const staleBitmap = imageBitmap();
        const createdBitmaps: ImageBitmap[] = [];
        const resizeWidths: number[] = [];
        let bitmapRequest = 0;
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(async (
                _scope: VideoFrameRequestScope,
                sourceTime: number,
            ) => ({
                canvas: { width: 1280, height: 720 } as OffscreenCanvas,
                timestamp: sourceTime,
                duration: 1 / 30,
            })),
            dispose: vi.fn(async () => undefined),
        };
        const videoCache = new VideoCache({
            cacheMemoryMB: 20,
            createBitmap: vi.fn(async (_source, options) => {
                bitmapRequest += 1;
                resizeWidths.push(options?.resizeWidth ?? 0);
                if (bitmapRequest === 4) return staleBitmapGate.promise;
                const bitmap = {
                    width: options?.resizeWidth ?? 1,
                    height: options?.resizeHeight ?? 1,
                    close: vi.fn(),
                } as unknown as ImageBitmap;
                createdBitmaps.push(bitmap);
                return bitmap;
            }),
            openSession: vi.fn(async () => session),
        });
        const request = (sourceTime: number, width: number, height: number) => (
            videoCache.requestFrame({
                scope: 'preview',
                sourceId: 'source',
                sourceFingerprint: fingerprintA,
                file,
                sourceTime,
                sourceFps: 30,
                targetResolution: { width, height },
            })
        );

        try {
            for (let frameIndex = 0; frameIndex < 3; frameIndex += 1) {
                const result = await request(frameIndex / 30, 1280, 720);
                result?.release();
            }
            const highResolutionBytes = videoCache.getStats().estimatedMemoryBytes;
            const staleHighResolution = request(3 / 30, 1280, 720);
            await vi.waitFor(() => expect(bitmapRequest).toBe(4));

            // Frame zero is already resident, so this shrink schedules the downshift without any
            // decode. No subsequent request is needed to commit the new resolution generation.
            const cachedShrink = await request(0, 320, 180);
            cachedShrink?.release();
            expect(videoCache.getStats().estimatedMemoryBytes).toBe(highResolutionBytes);
            vi.advanceTimersByTime(500);

            expect(videoCache.getStats()).toMatchObject({
                cachedFrames: 0,
                estimatedMemoryBytes: 0,
            });
            expect(createdBitmaps.every((bitmap) => (
                vi.mocked(bitmap.close).mock.calls.length === 1
            ))).toBe(true);

            // Playback after the quiet period decodes directly at 320; it does not pay a large
            // decode followed by a request-triggered clear.
            const resumed = await request(4 / 30, 320, 180);
            resumed?.release();
            const lowResolutionBytes = videoCache.getStats().estimatedMemoryBytes;
            staleBitmapGate.resolve(staleBitmap);

            await expect(staleHighResolution).resolves.toBeNull();
            expect(resizeWidths).toEqual([1280, 1280, 1280, 1280, 320]);
            expect(lowResolutionBytes).toBeLessThan(highResolutionBytes);
            expect(staleBitmap.close).toHaveBeenCalledTimes(1);
            videoCache.clearPreviewSource('source');
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the high resolution during brief viewport oscillation before downshifting once', async () => {
        vi.useFakeTimers();
        const resizeWidths: number[] = [];
        const bitmaps: ImageBitmap[] = [];
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(async (
                _scope: VideoFrameRequestScope,
                sourceTime: number,
            ) => ({
                canvas: { width: 1280, height: 720 } as OffscreenCanvas,
                timestamp: sourceTime,
                duration: 1 / 30,
            })),
            dispose: vi.fn(async () => undefined),
        };
        const videoCache = new VideoCache({
            cacheMemoryMB: 20,
            createBitmap: vi.fn(async (_source, options) => {
                resizeWidths.push(options?.resizeWidth ?? 0);
                const bitmap = {
                    width: options?.resizeWidth ?? 1,
                    height: options?.resizeHeight ?? 1,
                    close: vi.fn(),
                } as unknown as ImageBitmap;
                bitmaps.push(bitmap);
                return bitmap;
            }),
            openSession: vi.fn(async () => session),
        });
        const render = async (frameIndex: number, width: number, height: number) => {
            const result = await videoCache.requestFrame({
                scope: 'preview',
                sourceId: 'source',
                sourceFingerprint: fingerprintA,
                file,
                sourceTime: frameIndex / 30,
                sourceFps: 30,
                targetResolution: { width, height },
            });
            result?.release();
        };

        try {
            await render(0, 1280, 720);
            await render(1, 320, 180);
            vi.advanceTimersByTime(100);
            await render(2, 1280, 720);
            vi.advanceTimersByTime(500);

            expect(resizeWidths).toEqual([1280, 1280, 1280]);
            expect(bitmaps.every((bitmap) => vi.mocked(bitmap.close).mock.calls.length === 0)).toBe(true);

            await render(3, 320, 180);
            vi.advanceTimersByTime(499);
            expect(bitmaps.every((bitmap) => vi.mocked(bitmap.close).mock.calls.length === 0)).toBe(true);
            vi.advanceTimersByTime(1);
            expect(bitmaps.every((bitmap) => vi.mocked(bitmap.close).mock.calls.length === 1)).toBe(true);

            await render(4, 320, 180);
            expect(resizeWidths).toEqual([1280, 1280, 1280, 1280, 320]);
            videoCache.clearPreviewSource('source');
        } finally {
            vi.useRealTimers();
        }
    });

    it('deduplicates concurrent misses and gives each subscriber an independent lease', async () => {
        const decodeGate = deferred<WrappedCanvas | null>();
        const bitmap = imageBitmap();
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(() => decodeGate.promise),
            dispose: vi.fn(async () => undefined),
        };
        const createBitmap = vi.fn(async () => bitmap);
        const videoCache = new VideoCache({
            cacheMemoryMB: 10,
            createBitmap,
            openSession: vi.fn(async () => session),
        });
        const request = {
            scope: 'preview' as const,
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
            targetResolution: { width: 640, height: 360 },
        };
        const firstPending = videoCache.requestFrame(request);
        const secondPending = videoCache.requestFrame(request);
        await vi.waitFor(() => expect(session.request).toHaveBeenCalledTimes(1));
        decodeGate.resolve(wrappedFrame());

        const [first, second] = await Promise.all([firstPending, secondPending]);
        expect(first?.canvas).toBe(bitmap);
        expect(second?.canvas).toBe(bitmap);
        expect(createBitmap).toHaveBeenCalledTimes(1);
        first?.release();
        videoCache.clearPreviewSource('source');
        expect(bitmap.close).not.toHaveBeenCalled();
        second?.release();
        expect(bitmap.close).toHaveBeenCalledTimes(1);
    });

    it('cancels a superseded warmup subscriber without exposing pooled canvas state', async () => {
        const pooledCanvas = { width: 1920, height: 1080, marker: 'original' } as unknown as OffscreenCanvas;
        const frame = { canvas: pooledCanvas, timestamp: 0, duration: 1 / 30 };
        const receivedSignals: AbortSignal[] = [];
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(async (
                _scope: VideoFrameRequestScope,
                _sourceTime: number,
                signal?: AbortSignal,
            ) => {
                if (signal) receivedSignals.push(signal);
                return frame;
            }),
            dispose: vi.fn(async () => undefined),
        };
        const bitmapGate = deferred<ImageBitmap>();
        const videoCache = new VideoCache({
            cacheMemoryMB: 10,
            createBitmap: vi.fn(() => bitmapGate.promise),
            openSession: vi.fn(async () => session),
        });
        const controller = new AbortController();
        const pending = videoCache.requestFrame({
            scope: 'warmup',
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(receivedSignals).toHaveLength(1));
        controller.abort();
        const lateBitmap = imageBitmap();
        bitmapGate.resolve(lateBitmap);

        await expect(pending).resolves.toBeNull();
        expect(receivedSignals[0].aborted).toBe(true);
        expect(lateBitmap.close).toHaveBeenCalledTimes(1);
    });

    it('keeps a visible subscriber alive when the matching warmup plan is cancelled', async () => {
        const decodeGate = deferred<WrappedCanvas | null>();
        const bitmap = imageBitmap();
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(() => decodeGate.promise),
            dispose: vi.fn(async () => undefined),
        };
        const videoCache = new VideoCache({
            cacheMemoryMB: 10,
            createBitmap: vi.fn(async () => bitmap),
            openSession: vi.fn(async () => session),
        });
        const controller = new AbortController();
        const commonRequest = {
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
        };
        const warmup = videoCache.requestFrame({
            ...commonRequest,
            scope: 'warmup',
            signal: controller.signal,
        });
        const visible = videoCache.requestFrame({
            ...commonRequest,
            scope: 'preview',
            targetResolution: { width: 640, height: 360 },
        });
        await vi.waitFor(() => expect(session.request).toHaveBeenCalledTimes(1));

        controller.abort();
        decodeGate.resolve(wrappedFrame());

        await expect(warmup).resolves.toBeNull();
        const visibleFrame = await visible;
        expect(visibleFrame?.canvas).toBe(bitmap);
        expect(session.request).toHaveBeenCalledTimes(1);
        visibleFrame?.release();
        videoCache.clearPreviewSource('source');
    });

    it('returns no mutable pooled-canvas fallback when bitmap creation fails', async () => {
        const pooledCanvas = { width: 1920, height: 1080, marker: 'before' } as unknown as OffscreenCanvas;
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(async () => ({
                canvas: pooledCanvas,
                timestamp: 0,
                duration: 1 / 30,
            })),
            dispose: vi.fn(async () => undefined),
        };
        const videoCache = new VideoCache({
            cacheMemoryMB: 10,
            createBitmap: vi.fn(async () => { throw new Error('bitmap unavailable'); }),
            openSession: vi.fn(async () => session),
        });

        const result = await videoCache.requestFrame({
            scope: 'preview',
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
        });
        (pooledCanvas as unknown as { marker: string }).marker = 'mutated-by-next-decode';

        expect(result).toBeNull();
    });

    it('returns null and closes the owned bitmap when the strict cache cap rejects it', async () => {
        const bitmap = imageBitmap();
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(async () => wrappedFrame()),
            dispose: vi.fn(async () => undefined),
        };
        const videoCache = new VideoCache({
            // A zero-byte budget forces the stable ImageBitmap through the strict rejection path.
            // The decoder's pooled canvas must never become a mutable fallback result.
            cacheMemoryMB: 0,
            createBitmap: vi.fn(async () => bitmap),
            openSession: vi.fn(async () => session),
        });

        const result = await videoCache.requestFrame({
            scope: 'preview',
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
        });

        expect(result).toBeNull();
        expect(bitmap.close).toHaveBeenCalledTimes(1);
        expect(videoCache.getStats().cachedFrames).toBe(0);
    });

    it('bounds inactive decoder sessions by recency while protecting active work', async () => {
        const activeDecode = deferred<WrappedCanvas | null>();
        const sourceFiles = new Map([
            ['a', new File(['a'], 'a.mp4', { type: 'video/mp4' })],
            ['b', new File(['b'], 'b.mp4', { type: 'video/mp4' })],
            ['c', new File(['c'], 'c.mp4', { type: 'video/mp4' })],
            ['d', new File(['d'], 'd.mp4', { type: 'video/mp4' })],
        ]);
        const openedSessions: Array<{
            sourceId: string;
            generation: number;
            request: ReturnType<typeof vi.fn>;
            dispose: ReturnType<typeof vi.fn>;
        }> = [];
        const videoCache = new VideoCache({
            cacheMemoryMB: 10,
            maxInactiveSessions: 2,
            createBitmap: vi.fn(async () => imageBitmap()),
            openSession: vi.fn(async ({ file: openedFile, generation }) => {
                const sourceId = openedFile.name.slice(0, 1);
                const session = {
                    fps: 30,
                    generation,
                    request: vi.fn((
                        _scope: VideoFrameRequestScope,
                        sourceTime: number,
                    ) => {
                        if (sourceId === 'c' && generation === 1) return activeDecode.promise;
                        return Promise.resolve({
                            ...wrappedFrame(),
                            timestamp: sourceTime,
                        });
                    }),
                    dispose: vi.fn(async () => undefined),
                };
                openedSessions.push({ sourceId, ...session });
                return session;
            }),
        });
        const request = (sourceId: string, frameIndex = 0) => videoCache.requestFrame({
            scope: 'preview',
            sourceId,
            sourceFingerprint: `fingerprint-${sourceId}`,
            file: sourceFiles.get(sourceId)!,
            sourceTime: frameIndex / 30,
            sourceFps: 30,
        });
        const release = async (sourceId: string, frameIndex = 0) => {
            const result = await request(sourceId, frameIndex);
            result?.release();
        };

        await release('a');
        await release('b');
        // A cache hit is a real source access and must promote its decoder session in the LRU.
        await release('a');

        const pendingActiveC = request('c');
        await vi.waitFor(() => expect(
            openedSessions.find((session) => session.sourceId === 'c')?.request,
        ).toHaveBeenCalledTimes(1));
        await release('d');

        const firstB = openedSessions.find((session) => (
            session.sourceId === 'b' && session.generation === 1
        ));
        const activeC = openedSessions.find((session) => session.sourceId === 'c');
        expect(firstB?.dispose).toHaveBeenCalledTimes(1);
        expect(activeC?.dispose).not.toHaveBeenCalled();
        // The active decoder may temporarily take the open count over the inactive-session cap.
        expect(videoCache.getStats().totalSinks).toBe(3);

        activeDecode.resolve(wrappedFrame());
        const completedC = await pendingActiveC;
        completedC?.release();
        const firstA = openedSessions.find((session) => session.sourceId === 'a');
        expect(firstA?.dispose).toHaveBeenCalledTimes(1);
        expect(videoCache.getStats().totalSinks).toBe(2);

        // B's bitmap for frame zero remains cached, so a different frame proves that revisiting an
        // evicted source opens a fresh session generation instead of retaining hidden decoder state.
        await release('b', 1);
        const bSessions = openedSessions.filter((session) => session.sourceId === 'b');
        expect(bSessions.map((session) => session.generation)).toEqual([1, 2]);
        expect(videoCache.getStats()).toMatchObject({ totalSinks: 2, activeSinks: 2 });

        videoCache.clearAll();
        await vi.waitFor(() => {
            expect(openedSessions.every((session) => (
                session.dispose.mock.calls.length === 1
            ))).toBe(true);
        });
        expect(videoCache.getStats()).toMatchObject({ totalSinks: 0, activeSinks: 0 });
    });

    it('preserves pull-only diagnostic totals without allocating per-frame batches', async () => {
        runtimeDiagnostics.reset();
        const bitmap = imageBitmap();
        const session = {
            fps: 30,
            generation: 1,
            request: vi.fn(async () => wrappedFrame()),
            dispose: vi.fn(async () => undefined),
        };
        const videoCache = new VideoCache({
            cacheMemoryMB: 10,
            createBitmap: vi.fn(async () => bitmap),
            openSession: vi.fn(async () => session),
        });
        const request = {
            scope: 'preview' as const,
            sourceId: 'source',
            sourceFingerprint: fingerprintA,
            file,
            sourceTime: 0,
            sourceFps: 30,
        };

        const first = await videoCache.requestFrame(request);
        first?.release();
        const second = await videoCache.requestFrame(request);
        second?.release();
        const snapshot = runtimeDiagnostics.snapshot();

        expect(snapshot.counters.video).toMatchObject({
            visibleRequests: 2,
            cacheMisses: 1,
            cacheHits: 1,
            decodedFrames: 1,
        });
        videoCache.clearPreviewSource('source');
    });
});
