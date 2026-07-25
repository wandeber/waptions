import { describe, expect, it, vi } from 'vitest';
import { BoundedConcurrency } from './concurrency';
import { parseFfprobeMetadata } from './ffprobe-port';
import { ManagedProcessError, NodeManagedProcessPort } from './node-process-port';

describe('managed media runtime foundations', () => {
    it('normalizes ffprobe metadata including explicit missing audio', () => {
        const metadata = parseFfprobeMetadata(JSON.stringify({
            streams: [{
                index: 0,
                codec_type: 'video',
                codec_name: 'h264',
                width: 1920,
                height: 1080,
                avg_frame_rate: '30000/1001',
            }],
            format: {
                format_name: 'mov,mp4',
                duration: '12.5',
                bit_rate: '5000000',
            },
        }));
        expect(metadata.video?.frameRate).toBeCloseTo(29.97, 2);
        expect(metadata.audio).toBeNull();
        expect(metadata.durationSeconds).toBe(12.5);
    });

    it('enforces process output limits and cancellation', async () => {
        const processes = new NodeManagedProcessPort();
        await expect(processes.run({
            executable: process.execPath,
            args: ['-e', 'process.stdout.write("x".repeat(4096))'],
            stdoutLimitBytes: 128,
            stderrLimitBytes: 128,
            timeoutMs: 5_000,
        })).rejects.toBeInstanceOf(ManagedProcessError);

        const controller = new AbortController();
        const pending = processes.run({
            executable: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            stdoutLimitBytes: 128,
            stderrLimitBytes: 128,
            timeoutMs: 5_000,
            signal: controller.signal,
        });
        controller.abort(new DOMException('Cancelled.', 'AbortError'));
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('limits concurrent jobs, applies FIFO backpressure, and cancels queued jobs', async () => {
        const concurrency = new BoundedConcurrency(2);
        const releases: Array<() => void> = [];
        const entered: number[] = [];
        const operation = (index: number, signal?: AbortSignal) => concurrency.run(async () => {
            entered.push(index);
            await new Promise<void>((resolve) => releases.push(resolve));
            return index;
        }, signal);
        const first = operation(1);
        const second = operation(2);
        const thirdController = new AbortController();
        const third = operation(3, thirdController.signal);
        await vi.waitFor(() => expect(entered).toEqual([1, 2]));
        thirdController.abort();
        await expect(third).rejects.toMatchObject({ name: 'AbortError' });
        releases.splice(0).forEach((release) => release());
        await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
        expect(concurrency.snapshot()).toMatchObject({
            active: 0,
            peakActive: 2,
            queued: 0,
            cancellations: 1,
        });
    });
});
