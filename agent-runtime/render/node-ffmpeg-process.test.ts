import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    NodeBackendProcessTracker,
    NodeBoundedFfmpegProcessRunner,
} from './node-ffmpeg-process';

afterEach(() => {
    vi.useRealTimers();
});

describe('bounded Node FFmpeg process lifecycle', () => {
    it('always spawns with shell disabled and explicit stdio', async () => {
        const child = createFakeChild({ closeOnTerm: true });
        const spawnProcess = vi.fn().mockReturnValue(child);
        const runner = new NodeBoundedFfmpegProcessRunner(spawnProcess as never);
        const session = runner.start({
            executable: 'ffmpeg',
            args: ['-version'],
            stdio: ['ignore', 'pipe', 'pipe'],
            limits: processLimits(),
            tracker: createTracker(),
            maximumStdoutBytes: 1024,
        });
        child.emit('close', 0, null);
        await expect(session.wait()).resolves.toMatchObject({ exitCode: 0 });

        expect(spawnProcess).toHaveBeenCalledWith(
            'ffmpeg',
            ['-version'],
            expect.objectContaining({
                shell: false,
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
        );
    });

    it('cancels with SIGTERM and escalates to SIGKILL after the deadline', async () => {
        vi.useFakeTimers();
        const child = createFakeChild({ closeOnTerm: false });
        const runner = createRunner(child);
        const controller = new AbortController();
        const session = runner.start({
            executable: 'ffmpeg',
            args: ['-version'],
            stdio: ['ignore', 'pipe', 'pipe'],
            limits: processLimits({ killGraceMs: 10 }),
            tracker: createTracker(),
            signal: controller.signal,
            maximumStdoutBytes: 1024,
        });
        const waiting = expect(session.wait()).rejects.toMatchObject({
            code: 'CANCELLED',
        });

        controller.abort();
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        await vi.advanceTimersByTimeAsync(10);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
        await waiting;
    });

    it('fails closed when stderr or progress exceeds its configured bound', async () => {
        const stderrChild = createFakeChild({ closeOnTerm: true });
        const stderrSession = createRunner(stderrChild).start({
            executable: 'ffmpeg',
            args: ['-version'],
            stdio: ['ignore', 'pipe', 'pipe'],
            limits: processLimits({ maximumStderrBytes: 4 }),
            tracker: createTracker(),
            maximumStdoutBytes: 1024,
        });
        stderrChild.stderr.write('12345');

        await expect(stderrSession.wait()).rejects.toMatchObject({
            code: 'RESOURCE_LIMIT',
        });
        expect(stderrChild.kill).toHaveBeenCalledWith('SIGTERM');

        const progressChild = createFakeChild({ closeOnTerm: true, progressPipe: 5 });
        const progressSession = createRunner(progressChild).start({
            executable: 'ffmpeg',
            args: ['-version'],
            stdio: ['ignore', 'ignore', 'pipe', 'ignore', 'ignore', 'pipe'],
            limits: processLimits({ maximumProgressBytes: 4 }),
            tracker: createTracker(),
            progressPipeIndex: 5,
        });
        progressChild.progress?.write('12345');

        await expect(progressSession.wait()).rejects.toMatchObject({
            code: 'RESOURCE_LIMIT',
        });
        expect(progressChild.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('enforces combined resident-memory accounting', async () => {
        const child = createFakeChild({ closeOnTerm: true });
        const tracker = new NodeBackendProcessTracker(
            1,
            64,
            vi.fn().mockResolvedValue(65),
            60_000,
        );
        const session = createRunner(child).start({
            executable: 'ffmpeg',
            args: ['-version'],
            stdio: ['ignore', 'pipe', 'pipe'],
            limits: processLimits({ maximumResidentBytes: 64 }),
            tracker,
            maximumStdoutBytes: 1024,
        });

        await expect(session.wait()).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
        expect(tracker.snapshot()).toMatchObject({
            peakBackendProcesses: 1,
            peakBackendResidentBytes: 65,
        });
    });

    it('fails closed when resident-memory accounting is unavailable', async () => {
        const child = createFakeChild({ closeOnTerm: true });
        const tracker = new NodeBackendProcessTracker(
            1,
            64,
            vi.fn().mockRejectedValue(new Error('sampler unavailable')),
            1,
        );
        const session = createRunner(child).start({
            executable: 'ffmpeg',
            args: ['-version'],
            stdio: ['ignore', 'pipe', 'pipe'],
            limits: processLimits({ maximumResidentBytes: 64 }),
            tracker,
            maximumStdoutBytes: 1024,
        });

        await expect(session.wait()).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });
});

function createRunner(child: ReturnType<typeof createFakeChild>) {
    return new NodeBoundedFfmpegProcessRunner(
        vi.fn().mockReturnValue(child) as never,
    );
}

function createTracker() {
    return new NodeBackendProcessTracker(
        2,
        1024,
        vi.fn().mockResolvedValue(0),
        60_000,
    );
}

function processLimits(overrides: Partial<{
    maximumProcesses: number;
    maximumResidentBytes: number;
    maximumStderrBytes: number;
    maximumProgressBytes: number;
    timeoutMs: number;
    killGraceMs: number;
}> = {}) {
    return {
        maximumProcesses: 2,
        maximumResidentBytes: 1024,
        maximumStderrBytes: 1024,
        maximumProgressBytes: 1024,
        timeoutMs: 60_000,
        killGraceMs: 100,
        ...overrides,
    };
}

function createFakeChild(options: {
    closeOnTerm: boolean;
    progressPipe?: number;
}) {
    const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        stdio: Array<PassThrough | null>;
        progress: PassThrough | null;
        kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 42_424;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdio = [child.stdin, child.stdout, child.stderr];
    child.progress = null;
    if (options.progressPipe !== undefined) {
        while (child.stdio.length <= options.progressPipe) child.stdio.push(null);
        child.progress = new PassThrough();
        child.stdio[options.progressPipe] = child.progress;
    }
    child.kill = vi.fn((signal: NodeJS.Signals) => {
        if (signal === 'SIGKILL' || options.closeOnTerm) {
            queueMicrotask(() => child.emit('close', null, signal));
        }
        return true;
    });
    return child;
}
