import { describe, expect, it, vi } from 'vitest';
import type { WrappedCanvas } from 'mediabunny';
import {
    VideoFrameSession,
    type VideoFrameSessionBackend,
    type VideoFrameSessionInput,
    type VideoFrameSessionTrack,
} from './video-frame-session';

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
});
