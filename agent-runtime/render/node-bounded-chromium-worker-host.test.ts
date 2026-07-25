import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    AcquiredNodeStagedOutputHandle,
    NodeStagedOutputHandleResolverPort,
} from '../export/node-staged-output-handle';
import type {
    BoundedChromiumWorkerLaunch,
} from './bounded-chromium-worker';
import type { HeadlessStagedOutputCapability } from './contracts';
import {
    NodeBoundedChromiumWorkerHostPort,
} from './node-bounded-chromium-worker-host';
import { NodeBoundedFfmpegProcessRunner } from './node-ffmpeg-process';

const FFMPEG_AVAILABLE = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const OUTPUT_CAPABILITY: HeadlessStagedOutputCapability = {
    version: 1,
    kind: 'create-only-staged-output',
    capabilityId: 'capability:chromium-raw-host',
    grantId: 'grant:chromium-raw-host',
    stagingId: 'staging:chromium-raw-host',
};

afterEach(() => {
    vi.useRealTimers();
});

describe('Node bounded Chromium worker host', () => {
    it('probes the packaged deterministic raw-descriptor encoder without a Chromium dependency', async () => {
        const spawnProcess = vi.fn((_executable: string, args: readonly string[]) => {
            const child = createFakeChild({ closeOnTerm: true });
            queueMicrotask(() => {
                child.stdout.write(args.includes('-encoders')
                    ? ' V.... libx264\n A.... aac\n'
                    : ' E mp4 MP4 (MPEG-4 Part 14)\n');
                child.stdout.end();
                child.emit('close', 0, null);
            });
            return child;
        });
        const host = new NodeBoundedChromiumWorkerHostPort(createOutputResolver(), {
            processes: new NodeBoundedFfmpegProcessRunner(spawnProcess as never),
        });

        await expect(host.probe()).resolves.toEqual(expect.objectContaining({
            chromiumAvailable: false,
            webCodecs: false,
            h264Encoder: true,
            aacEncoder: true,
            mp4Muxer: true,
            implementation: 'deterministic-ffmpeg-raw-descriptor',
        }));
        expect(spawnProcess).toHaveBeenCalledTimes(2);
        expect(spawnProcess).toHaveBeenCalledWith(
            'ffmpeg',
            expect.arrayContaining(['-hide_banner', '-encoders']),
            expect.objectContaining({ shell: false }),
        );
    });

    it('accepts only fixed raw inputs and descriptor output, with no paths or network protocol', async () => {
        let outputBytes = 0;
        const child = createFakeChild({ closeOnTerm: true, closeWhenInputsEnd: true });
        child.once('close', () => { outputBytes = 1_024; });
        const spawnProcess = vi.fn().mockReturnValue(child);
        const resolver = createOutputResolver({ size: () => outputBytes });
        const host = new NodeBoundedChromiumWorkerHostPort(resolver, {
            processes: new NodeBoundedFfmpegProcessRunner(spawnProcess as never),
        });
        const request = createRequest();
        const session = await host.launch(request);

        await session.writeVideoFrame(0, new Uint8Array(request.width * request.height * 4));
        await session.writeAudioChunk(0, new Float32Array(960 * 2));
        await expect(session.finalize()).resolves.toEqual({
            warnings: ['Chromium composition used deterministic FFmpeg raw-descriptor encoding.'],
        });
        await session.terminate();

        const [, args, options] = spawnProcess.mock.calls[0];
        expect(options).toMatchObject({
            shell: false,
            stdio: ['pipe', 'ignore', 'pipe', 'pipe', 7],
        });
        expect(args).toEqual(expect.arrayContaining([
            '-f', 'rawvideo',
            '-pix_fmt', 'rgba',
            '-f', 'f32le',
            '-c:v', 'libx264',
            '-c:a', 'aac',
            '-protocol_whitelist', 'pipe',
            'pipe:0',
            'pipe:3',
            'pipe:4',
        ]));
        expect(args).not.toContainEqual(expect.stringMatching(/^(?:https?|file):/i));
        expect(args).not.toContainEqual(expect.stringMatching(/(?:^|\/)\.\.?\//));
        expect(args).not.toContain('Visible subtitle text');
        expect(resolver.acquire).toHaveBeenCalledWith(OUTPUT_CAPABILITY, 'read-write', undefined);
        expect(resolver.close).toHaveBeenCalledOnce();
    });

    it('fails closed for unbounded launches and raw input ordering violations', async () => {
        const child = createFakeChild({ closeOnTerm: true });
        const spawnProcess = vi.fn().mockReturnValue(child);
        const resolver = createOutputResolver();
        const host = new NodeBoundedChromiumWorkerHostPort(resolver, {
            processes: new NodeBoundedFfmpegProcessRunner(spawnProcess as never),
        });

        await expect(host.launch({
            ...createRequest(),
            maximumCanvasFrames: 3,
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
        await expect(host.launch({
            ...createRequest(),
            manifest: { subtitleText: 'must not cross the boundary' },
        } as unknown as BoundedChromiumWorkerLaunch)).rejects.toMatchObject({
            code: 'RESOURCE_LIMIT',
        });
        expect(resolver.acquire).not.toHaveBeenCalled();

        const session = await host.launch(createRequest());
        await expect(session.writeVideoFrame(1, new Uint8Array(64 * 36 * 4)))
            .rejects.toMatchObject({ code: 'RENDER_FAILED' });
        await expect(session.writeAudioChunk(0, new Float32Array(65_537)))
            .rejects.toMatchObject({ code: 'RENDER_FAILED' });
        await session.forceTerminate();
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
        expect(resolver.close).toHaveBeenCalledOnce();
    });

    it('cancels with TERM followed by KILL when the raw encoder does not exit', async () => {
        vi.useFakeTimers();
        const child = createFakeChild({ closeOnTerm: false });
        const resolver = createOutputResolver();
        const host = new NodeBoundedChromiumWorkerHostPort(resolver, {
            processes: new NodeBoundedFfmpegProcessRunner(vi.fn().mockReturnValue(child) as never),
            processKillGraceMs: 10,
        });
        const session = await host.launch(createRequest());

        const cancelled = session.cancel('abort-signal');
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        await vi.advanceTimersByTimeAsync(10);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
        await cancelled;
        expect(resolver.close).toHaveBeenCalledOnce();
    });
});

describe.skipIf(!FFMPEG_AVAILABLE)('Node bounded Chromium worker host integration', () => {
    let directory: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'waptions-chromium-raw-host-'));
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    it('writes reproducible H.264/AAC MP4 bytes from pre-composed subtitle pixels', async () => {
        const firstPath = join(directory, 'first.mp4');
        const secondPath = join(directory, 'second.mp4');
        const first = await renderSubtitleRaster(firstPath);
        const second = await renderSubtitleRaster(secondPath);

        expect(first).toEqual(second);
        const decoded = runToolBuffer('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'error',
            '-i', firstPath,
            '-map', '0:v:0',
            '-pix_fmt', 'rgba',
            '-frames:v', '1',
            '-f', 'rawvideo',
            'pipe:1',
        ]);
        const subtitlePixel = decoded.subarray(((30 * 64) + 10) * 4, ((30 * 64) + 10) * 4 + 3);
        expect(subtitlePixel[0]).toBeGreaterThan(180);
        expect(subtitlePixel[1]).toBeGreaterThan(180);
        expect(subtitlePixel[2]).toBeGreaterThan(180);
        const inspection = JSON.parse(runToolBuffer('ffprobe', [
            '-hide_banner',
            '-v', 'error',
            '-count_frames',
            '-show_entries', 'format=format_name:stream=codec_type,codec_name,pix_fmt,sample_rate,channels,nb_read_frames',
            '-of', 'json',
            firstPath,
        ]).toString('utf8')) as {
            format: { format_name: string };
            streams: Array<{
                codec_type: string;
                codec_name: string;
                pix_fmt?: string;
                sample_rate?: string;
                channels?: number;
                nb_read_frames?: string;
            }>;
        };
        const video = inspection.streams.find((stream) => stream.codec_type === 'video');
        const audio = inspection.streams.find((stream) => stream.codec_type === 'audio');
        expect(inspection.format.format_name.split(',')).toContain('mov');
        expect(video).toMatchObject({
            codec_name: 'h264',
            pix_fmt: 'yuv420p',
            nb_read_frames: '2',
        });
        expect(audio).toMatchObject({
            codec_name: 'aac',
            sample_rate: '48000',
            channels: 2,
        });
    }, 60_000);

    async function renderSubtitleRaster(outputPath: string): Promise<Buffer> {
        await writeFile(outputPath, Buffer.alloc(0), { mode: 0o600 });
        const host = new NodeBoundedChromiumWorkerHostPort(
            new FileOutputResolver(outputPath),
        );
        await expect(host.probe()).resolves.toMatchObject({
            chromiumAvailable: false,
            implementation: 'deterministic-ffmpeg-raw-descriptor',
        });
        const session = await host.launch(createRequest());
        const subtitleRaster = createSubtitleRaster();
        await session.writeVideoFrame(0, subtitleRaster);
        await session.writeVideoFrame(1, subtitleRaster);
        await session.writeAudioChunk(0, new Float32Array(3_200 * 2));
        await session.finalize();
        await session.terminate();
        return readFile(outputPath);
    }
});

function createRequest(
    overrides: Partial<BoundedChromiumWorkerLaunch> = {},
): BoundedChromiumWorkerLaunch {
    return {
        jobId: 'chromium_raw_host',
        outputCapability: OUTPUT_CAPABILITY,
        resourceReservation: {
            authority: 'process-wide-decoded-memory-v1',
            reservationId: 'reservation:chromium-raw-host',
            granted: {
                'audio-mix-bytes': 256 * 1024,
                'backend-processes': 1,
                'canvas-frames': 1,
                'decoded-pixel-bytes': 64 * 36 * 4,
                'export-jobs': 1,
                'video-decoder-sessions': 1,
            },
        },
        width: 64,
        height: 36,
        fpsNumerator: 30,
        fpsDenominator: 1,
        videoCodec: 'h264',
        audioCodec: 'aac',
        container: 'mp4',
        maximumCanvasFrames: 1,
        maximumDecoderSessions: 1,
        maximumDecodedPixelBytes: 64 * 36 * 4,
        maximumAudioMixBytes: 256 * 1024,
        maximumReadChunkBytes: 64 * 1024,
        networkPolicy: 'media-byte-source-only',
        ...overrides,
    };
}

function createOutputResolver(options: {
    size?: () => number;
} = {}) {
    const close = vi.fn().mockResolvedValue(undefined);
    const handle: AcquiredNodeStagedOutputHandle = {
        outputCapability: OUTPUT_CAPABILITY,
        fileDescriptor: 7,
        access: 'read-write',
        size: vi.fn().mockImplementation(async () => options.size?.() ?? 0),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        close,
    };
    return {
        acquire: vi.fn().mockResolvedValue(handle),
        close,
    } as NodeStagedOutputHandleResolverPort & {
        acquire: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    };
}

class FileOutputResolver implements NodeStagedOutputHandleResolverPort {
    constructor(private readonly outputPath: string) {}

    async acquire(
        capability: HeadlessStagedOutputCapability,
        access: 'read-only' | 'read-write',
    ): Promise<AcquiredNodeStagedOutputHandle> {
        const file = await open(this.outputPath, access === 'read-write' ? 'r+' : 'r');
        return fileHandle(capability, access, file);
    }
}

function fileHandle(
    capability: HeadlessStagedOutputCapability,
    access: 'read-only' | 'read-write',
    file: FileHandle,
): AcquiredNodeStagedOutputHandle {
    let closed = false;
    const assertOpen = () => {
        if (closed) throw new Error('Output handle is closed.');
    };
    return {
        outputCapability: capability,
        fileDescriptor: file.fd,
        access,
        size: async () => {
            assertOpen();
            return Number((await file.stat({ bigint: true })).size);
        },
        assertCurrent: async () => {
            assertOpen();
        },
        sync: async () => {
            assertOpen();
            await file.sync();
        },
        close: async () => {
            if (closed) return;
            closed = true;
            await file.close();
        },
    };
}

function createSubtitleRaster(): Uint8Array {
    const frame = new Uint8Array(64 * 36 * 4);
    for (let pixel = 0; pixel < 64 * 36; pixel += 1) {
        frame[pixel * 4] = 18;
        frame[pixel * 4 + 1] = 34;
        frame[pixel * 4 + 2] = 52;
        frame[pixel * 4 + 3] = 255;
    }
    // This is the already-rasterized subtitle band produced by the canonical compositor. The host
    // proves it transports pixels exactly; it deliberately never receives subtitle text or fonts.
    for (let y = 26; y < 34; y += 1) {
        for (let x = 8; x < 56; x += 1) {
            const offset = (y * 64 + x) * 4;
            frame[offset] = 255;
            frame[offset + 1] = 255;
            frame[offset + 2] = 255;
        }
    }
    return frame;
}

function toolAvailable(command: string): boolean {
    const result = spawnSync(command, ['-version'], {
        stdio: 'ignore',
        timeout: 5_000,
    });
    return result.status === 0;
}

function runToolBuffer(command: string, args: readonly string[]): Buffer {
    const result = spawnSync(command, args, {
        encoding: null,
        maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new Error(`${command} failed: ${result.stderr?.toString('utf8') ?? 'unknown error'}`);
    }
    return Buffer.from(result.stdout);
}

function createFakeChild(options: {
    closeOnTerm: boolean;
    closeWhenInputsEnd?: boolean;
}) {
    const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        stdio: Array<PassThrough | null>;
        kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 42_424;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const audio = new PassThrough();
    child.stdio = [child.stdin, child.stdout, child.stderr, audio];
    if (options.closeWhenInputsEnd) {
        let videoEnded = false;
        let audioEnded = false;
        const closeWhenReady = () => {
            if (videoEnded && audioEnded) queueMicrotask(() => child.emit('close', 0, null));
        };
        child.stdin.once('finish', () => {
            videoEnded = true;
            closeWhenReady();
        });
        audio.once('finish', () => {
            audioEnded = true;
            closeWhenReady();
        });
    }
    child.kill = vi.fn((signal: NodeJS.Signals) => {
        if (signal === 'SIGKILL' || options.closeOnTerm) {
            queueMicrotask(() => child.emit('close', null, signal));
        }
        return true;
    });
    return child;
}
