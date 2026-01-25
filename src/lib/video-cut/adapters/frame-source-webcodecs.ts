import { Input, ALL_FORMATS, BlobSource, Output, Mp4OutputFormat, NullTarget, Conversion, VideoSample } from 'mediabunny';
import { FrameSource } from '../core/frame-source';
import { AnalysisFrame } from '../core/frame';

export interface WebCodecsFrameSourceOptions {
    analysisWidth?: number;
}

export class WebCodecsFrameSource implements FrameSource {
    private input: Input | null = null;
    private fps: number = 30;
    private duration: number = 0;
    private options: WebCodecsFrameSourceOptions;

    constructor(private blob: Blob, options: WebCodecsFrameSourceOptions = {}) {
        this.options = {
            analysisWidth: options.analysisWidth ?? 320
        };
    }

    async init(): Promise<void> {
        this.input = new Input({
            source: new BlobSource(this.blob),
            formats: ALL_FORMATS,
        });

        this.duration = await this.input.computeDuration();
        const videoTrack = await this.input.getPrimaryVideoTrack();

        if (videoTrack) {
            // Get an estimate of the average frame rate
            const stats = await videoTrack.computePacketStats(30);
            this.fps = stats.averagePacketRate || 30;
        }
    }

    getFps(): number {
        return this.fps;
    }

    getDurationSec(): number {
        return this.duration;
    }

    async *frames(): AsyncIterable<AnalysisFrame> {
        if (!this.input) throw new Error('FrameSource not initialized');

        const output = new Output({
            format: new Mp4OutputFormat(),
            target: new NullTarget(),
        });

        const samplesQueue: VideoSample[] = [];
        let resolveNext: ((value: void) => void) | null = null;
        let isDone = false;

        const conversion = await Conversion.init({
            input: this.input,
            output,
            video: {
                width: this.options.analysisWidth,
                process: (sample: VideoSample) => {
                    samplesQueue.push(sample.clone());
                    if (resolveNext) {
                        resolveNext();
                        resolveNext = null;
                    }
                    return null; // Signal to conversion to discard the frame from output
                }
            },
            audio: { discard: true },
            showWarnings: false
        });

        if (!conversion.isValid) {
            throw new Error('Conversion initialization failed');
        }

        const executionPromise = conversion.execute().catch(err => {
            console.error('[WebCodecsFrameSource] Conversion error:', err);
        }).finally(() => {
            isDone = true;
            if (resolveNext) {
                resolveNext();
                resolveNext = null;
            }
        });

        const width = this.options.analysisWidth!;
        const videoTrack = await this.input.getPrimaryVideoTrack();
        const displayWidth = videoTrack?.displayWidth || 1;
        const displayHeight = videoTrack?.displayHeight || 1;
        const height = Math.round((displayHeight / displayWidth) * width);

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Could not create offscreen canvas context');

        let frameIndex = 0;

        try {
            while (!isDone || samplesQueue.length > 0) {
                if (samplesQueue.length === 0 && !isDone) {
                    await new Promise<void>((r) => (resolveNext = r));
                }

                while (samplesQueue.length > 0) {
                    const sample = samplesQueue.shift()!;

                    sample.draw(ctx, 0, 0, width, height);
                    const imageData = ctx.getImageData(0, 0, width, height);

                    yield {
                        index: frameIndex++,
                        timeSec: sample.timestamp,
                        width,
                        height,
                        rgba: imageData.data
                    };

                    sample.close();
                }
            }
        } finally {
            await executionPromise;
        }
    }

    async close(): Promise<void> {
        if (this.input) {
            this.input.dispose();
            this.input = null;
        }
    }
}
