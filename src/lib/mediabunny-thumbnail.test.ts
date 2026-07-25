import { describe, expect, it, vi } from 'vitest';
import { MediaBudgetManager } from './media-byte-source/budget-manager';
import type { MediaByteSource } from './media-byte-source/types';
import {
    generateThumbnail,
    type ThumbnailDependencies,
} from './mediabunny-utils';

function createHarness(options: {
    noTrack?: boolean;
    unsupported?: boolean;
    noFrame?: boolean;
    noContext?: boolean;
    drawError?: Error;
    dataUrlError?: Error;
    sampleGate?: Promise<FakeSample | null>;
} = {}) {
    const budget = new MediaBudgetManager('thumbnail', 16 * 1024 * 1024);
    const sample = new FakeSample(options.drawError);
    const dispose = vi.fn();
    const toDataURL = vi.fn(() => {
        if (options.dataUrlError) throw options.dataUrlError;
        return 'data:image/jpeg;base64,test';
    });
    const canvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => (
            options.noContext ? null : ({} as CanvasRenderingContext2D)
        )),
        toDataURL,
    } as unknown as HTMLCanvasElement;
    const track = {
        displayWidth: 1920,
        displayHeight: 1080,
        canDecode: vi.fn(async () => !options.unsupported),
    };
    const dependencies: ThumbnailDependencies = {
        createInput: () => ({
            getPrimaryVideoTrack: async () => (options.noTrack ? null : track),
            dispose,
        }),
        createSink: () => ({
            getSample: async () => (
                options.sampleGate
                    ? options.sampleGate
                    : (options.noFrame ? null : sample)
            ),
        }),
        createCanvas: () => canvas,
        decodedPixelBudget: budget,
    };
    return { budget, canvas, dependencies, dispose, sample, toDataURL };
}

class FakeSample {
    readonly draw = vi.fn(() => {
        if (this.drawError) throw this.drawError;
    });

    readonly close = vi.fn();

    constructor(private readonly drawError?: Error) {}
}

describe('generateThumbnail', () => {
    it('owns and releases the input, sample, canvas, and pixel budgets on success', async () => {
        const harness = createHarness();
        await expect(generateThumbnail({} as File, 1, {
            dependencies: harness.dependencies,
        })).resolves.toBe('data:image/jpeg;base64,test');

        expect(harness.dispose).toHaveBeenCalledTimes(1);
        expect(harness.sample.draw).toHaveBeenCalledTimes(1);
        expect(harness.sample.close).toHaveBeenCalledTimes(1);
        expect(harness.toDataURL).toHaveBeenCalledTimes(1);
        expect(harness.budget.snapshot().peakBytes).toBeGreaterThan(1920 * 1080 * 4);
        harness.budget.assertDrained();
    });

    it('does not repeat whole-source verification for ordinary thumbnail reads', async () => {
        const harness = createHarness();
        const verify = vi.fn(async () => ({ fingerprint: 'v1', sizeBytes: 1 }));
        const source: MediaByteSource = {
            sourceId: 'clip',
            identity: { fingerprint: 'v1', sizeBytes: 1 },
            size: async () => 1,
            read: async () => new Uint8Array([1]),
            stream: () => new ReadableStream<Uint8Array>(),
            verify,
            close: async () => undefined,
        };
        await generateThumbnail(source, 1, { dependencies: harness.dependencies });
        expect(verify).not.toHaveBeenCalled();
        harness.budget.assertDrained();
    });

    it.each([
        ['missing track', { noTrack: true }, 'No video track'],
        ['unsupported codec', { unsupported: true }, 'not supported'],
        ['missing frame', { noFrame: true }, 'Could not get frame'],
        ['missing context', { noContext: true }, 'canvas context'],
        ['draw failure', { drawError: new Error('draw failed') }, 'draw failed'],
        ['serialization failure', { dataUrlError: new Error('serialize failed') }, 'serialize failed'],
    ] as const)('cleans up after %s', async (_label, options, message) => {
        const harness = createHarness(options);
        await expect(generateThumbnail({} as File, 1, {
            dependencies: harness.dependencies,
        })).rejects.toThrow(message);

        expect(harness.dispose).toHaveBeenCalledTimes(1);
        if (!('noTrack' in options) && !('unsupported' in options) && !('noFrame' in options)) {
            expect(harness.sample.close).toHaveBeenCalledTimes(1);
        }
        harness.budget.assertDrained();
    });

    it('closes a decoded sample that arrives after cancellation', async () => {
        let resolve!: (sample: FakeSample | null) => void;
        const sampleGate = new Promise<FakeSample | null>((nextResolve) => {
            resolve = nextResolve;
        });
        const harness = createHarness({ sampleGate });
        const controller = new AbortController();
        const pending = generateThumbnail({} as File, 1, {
            signal: controller.signal,
            dependencies: harness.dependencies,
        });
        await vi.waitFor(() => expect(harness.budget.snapshot().leasedBytes).toBeGreaterThan(0));
        controller.abort();
        resolve(harness.sample);

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(harness.sample.close).toHaveBeenCalledTimes(1);
        expect(harness.dispose).toHaveBeenCalledTimes(1);
        harness.budget.assertDrained();
    });
});
