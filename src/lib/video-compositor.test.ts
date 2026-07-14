import { describe, expect, it, vi } from 'vitest';
import { drawContainedVideoFrame, getContainRectangle } from './video-compositor';

describe('video compositor', () => {
    it('centres landscape media without changing its aspect ratio', () => {
        expect(getContainRectangle(1920, 1080, 1000, 1000)).toEqual({
            x: 0,
            y: 218.75,
            width: 1000,
            height: 562.5,
        });
    });

    it('performs one contain draw with the shared rectangle', () => {
        const drawImage = vi.fn();
        const context = { drawImage } as unknown as CanvasRenderingContext2D;
        const frame = {} as CanvasImageSource;

        const rectangle = drawContainedVideoFrame(context, frame, 1080, 1920, 1000, 500);

        expect(rectangle).toEqual({ x: 359.375, y: 0, width: 281.25, height: 500 });
        expect(drawImage).toHaveBeenCalledWith(frame, 359.375, 0, 281.25, 500);
    });
});
