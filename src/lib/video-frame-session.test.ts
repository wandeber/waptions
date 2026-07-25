import { describe, expect, it, vi } from 'vitest';
import type { WrappedCanvas } from 'mediabunny';
import {
    VideoFrameSession,
    type VideoFrameSessionBackend,
    type VideoFrameSessionInput,
    type VideoFrameSessionTrack,
} from './video-frame-session';
import { MediaBudgetManager } from './media-byte-source/budget-manager';

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
    return { promise, resolve };
};

const file = new File(['video'], 'clip.mp4', { type: 'video/mp4' });

function frame(timestamp: number): WrappedCanvas {
    return {
        canvas: { width: 1920, height: 1080 } as OffscreenCanvas,
        timestamp,
        duration: 1 / 30,
    };
}

describe('VideoFrameSession', () => {
    it('disposes an input exactly once when initialization is aborted', async () => {
        const trackGate = deferred<VideoFrameSessionTrack | null>();
        const input: VideoFrameSessionInput = {
            getPrimaryVideoTrack: () => trackGate.promise,
            dispose: vi.fn(),
        };
        const backend: VideoFrameSessionBackend = {
            createInput: () => input,
            createSink: vi.fn(),
        };
        const controller = new AbortController();

        const opening = VideoFrameSession.open({ file, generation: 1, signal: controller.signal, backend });
        controller.abort();
        trackGate.resolve(null);

        await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
        expect(input.dispose).toHaveBeenCalledTimes(1);
        expect(backend.createSink).not.toHaveBeenCalled();
    });

    it('serializes decoding and disposes iterator and input idempotently', async () => {
        const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }));
        const iterator = {
            next: vi.fn(async () => ({ done: false, value: frame(0) })),
            return: iteratorReturn,
            throw: vi.fn(),
            [Symbol.asyncIterator]() { return this; },
        } as unknown as AsyncGenerator<WrappedCanvas, void, unknown>;
        const track: VideoFrameSessionTrack = {
            canDecode: vi.fn(async () => true),
            computePacketStats: vi.fn(async () => ({ averagePacketRate: 30 })),
        };
        const input: VideoFrameSessionInput = {
            getPrimaryVideoTrack: vi.fn(async () => track),
            dispose: vi.fn(),
        };
        const backend: VideoFrameSessionBackend = {
            createInput: () => input,
            createSink: () => ({ canvases: () => iterator }),
        };
        const session = await VideoFrameSession.open({
            file,
            generation: 7,
            signal: new AbortController().signal,
            backend,
        });

        expect(session.isIdle).toBe(true);
        await expect(session.request('preview', 0)).resolves.toMatchObject({ timestamp: 0 });
        await session.whenIdle();
        expect(session.isIdle).toBe(true);
        await Promise.all([session.dispose(), session.dispose()]);

        expect(session.generation).toBe(7);
        expect(input.dispose).toHaveBeenCalledTimes(1);
        expect(iteratorReturn).toHaveBeenCalledTimes(1);
        await expect(session.request('preview', 1)).resolves.toBeNull();
    });

    it('reserves the complete source-resolution pool before creating the sink', async () => {
        const bytesPerFrame = 100 * 50 * 4;
        const budget = new MediaBudgetManager('pixels', bytesPerFrame * 3);
        const track: VideoFrameSessionTrack = {
            displayWidth: 100,
            displayHeight: 50,
            canDecode: vi.fn(async () => true),
            computePacketStats: vi.fn(async () => ({ averagePacketRate: 30 })),
        };
        const input: VideoFrameSessionInput = {
            getPrimaryVideoTrack: vi.fn(async () => track),
            dispose: vi.fn(),
        };
        const createSink = vi.fn((_track, options?: { poolSize: number }) => {
            expect(options?.poolSize).toBe(3);
            expect(budget.snapshot()).toMatchObject({
                leasedBytes: bytesPerFrame * 3,
                currentBytes: bytesPerFrame * 3,
            });
            return { canvases: vi.fn() };
        });
        const session = await VideoFrameSession.open({
            file,
            generation: 1,
            signal: new AbortController().signal,
            backend: { createInput: () => input, createSink },
            decodedPixelBudget: budget,
        });

        await session.dispose();
        expect(input.dispose).toHaveBeenCalledTimes(1);
        budget.assertDrained();
    });

    it('releases all pool reservations through fifty open/close cycles', async () => {
        const budget = new MediaBudgetManager('pixels', 1024);
        for (let index = 0; index < 50; index++) {
            const track: VideoFrameSessionTrack = {
                displayWidth: 4,
                displayHeight: 4,
                canDecode: async () => true,
                computePacketStats: async () => ({ averagePacketRate: 30 }),
            };
            const input: VideoFrameSessionInput = {
                getPrimaryVideoTrack: async () => track,
                dispose: vi.fn(),
            };
            const session = await VideoFrameSession.open({
                file,
                generation: index,
                signal: new AbortController().signal,
                backend: {
                    createInput: () => input,
                    createSink: () => ({ canvases: vi.fn() }),
                },
                decodedPixelBudget: budget,
            });
            await session.dispose();
        }
        expect(budget.snapshot()).toMatchObject({
            reservations: 50,
            releases: 50,
            currentBytes: 0,
        });
        budget.assertDrained();
    });
});
