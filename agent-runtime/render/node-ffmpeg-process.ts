import {
    execFile,
    spawn,
    type ChildProcess,
    type SpawnOptions,
} from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import {
    createAbortError,
    HeadlessRenderError,
    throwIfAborted,
} from './contracts';

export interface NodeBackendProcessLimits {
    maximumProcesses: number;
    maximumResidentBytes: number;
    maximumStderrBytes: number;
    maximumProgressBytes: number;
    timeoutMs: number;
    killGraceMs: number;
}

export interface NodeBackendProcessDiagnostics {
    peakBackendResidentBytes: number;
    peakBackendProcesses: number;
}

export type ResidentMemorySampler = (pid: number) => Promise<number>;

export interface NodeBoundedProcessRequest {
    executable: string;
    args: readonly string[];
    stdio: ReadonlyArray<'ignore' | 'pipe' | number>;
    limits: NodeBackendProcessLimits;
    tracker: NodeBackendProcessTracker;
    signal?: AbortSignal;
    maximumStdoutBytes?: number;
    progressPipeIndex?: number;
    onProgressChunk?: (chunk: Uint8Array) => void;
}

export interface NodeBoundedProcessResult {
    exitCode: 0;
    stderrTail: string;
    stdoutBytes: number;
    stderrBytes: number;
    progressBytes: number;
}

export interface NodeBoundedProcessSession {
    readonly pid: number;
    readonly stdin: Writable | null;
    readonly stdout: Readable | null;
    wait(): Promise<NodeBoundedProcessResult>;
    terminate(error?: HeadlessRenderError): Promise<void>;
    forceKill(): void;
}

type SpawnProcess = (
    executable: string,
    args: readonly string[],
    options: SpawnOptions,
) => ChildProcess;

/**
 * Tracks the combined process count and resident memory of one render attempt.
 *
 * The default sampler uses `/proc` on Linux and `/bin/ps` without a shell on macOS. Callers may
 * inject an OS-native sampler where spawning a short-lived `ps` helper is undesirable.
 */
export class NodeBackendProcessTracker {
    private readonly activeResidentBytes = new Map<number, number>();
    private peakResidentBytes = 0;
    private peakProcesses = 0;

    constructor(
        private readonly maximumProcesses: number,
        private readonly maximumResidentBytes: number,
        private readonly sampler: ResidentMemorySampler = sampleNodeProcessResidentBytes,
        private readonly sampleIntervalMs = 250,
    ) {
        assertPositiveSafeInteger(maximumProcesses, 'maximumProcesses');
        assertPositiveSafeInteger(maximumResidentBytes, 'maximumResidentBytes');
        assertPositiveSafeInteger(sampleIntervalMs, 'sampleIntervalMs');
    }

    register(
        pid: number,
        onLimit: (error: HeadlessRenderError) => void,
    ): () => void {
        if (!Number.isSafeInteger(pid) || pid <= 0 || this.activeResidentBytes.has(pid)) {
            throw new HeadlessRenderError('RENDER_FAILED', 'Backend returned an invalid process id.');
        }
        this.activeResidentBytes.set(pid, 0);
        this.peakProcesses = Math.max(this.peakProcesses, this.activeResidentBytes.size);
        if (this.activeResidentBytes.size > this.maximumProcesses) {
            queueMicrotask(() => onLimit(new HeadlessRenderError(
                'RESOURCE_LIMIT',
                'The FFmpeg backend exceeded its process-count limit.',
            )));
        }

        let sampling = false;
        let closed = false;
        const sample = async () => {
            if (closed || sampling) return;
            sampling = true;
            try {
                const bytes = await this.sampler(pid);
                if (closed) return;
                if (!Number.isSafeInteger(bytes) || bytes < 0) {
                    throw new Error('Resident-memory sampler returned an invalid byte count.');
                }
                this.activeResidentBytes.set(pid, bytes);
                const total = Array.from(this.activeResidentBytes.values())
                    .reduce((sum, value) => sum + value, 0);
                if (!Number.isSafeInteger(total)) {
                    throw new Error('Combined backend resident memory overflowed.');
                }
                this.peakResidentBytes = Math.max(this.peakResidentBytes, total);
                if (total > this.maximumResidentBytes) {
                    onLimit(new HeadlessRenderError(
                        'RESOURCE_LIMIT',
                        'The FFmpeg backend exceeded its resident-memory limit.',
                    ));
                }
            } catch {
                // A process can exit between the timer firing and the OS sample. The close event is
                // the authoritative process-lifecycle signal, so sampling races are ignored.
            } finally {
                sampling = false;
            }
        };
        const interval = setInterval(() => void sample(), this.sampleIntervalMs);
        interval.unref?.();
        void sample();
        return () => {
            if (closed) return;
            closed = true;
            clearInterval(interval);
            this.activeResidentBytes.delete(pid);
        };
    }

    snapshot(): NodeBackendProcessDiagnostics {
        return {
            peakBackendResidentBytes: this.peakResidentBytes,
            peakBackendProcesses: this.peakProcesses,
        };
    }
}

export class NodeBoundedFfmpegProcessRunner {
    constructor(private readonly spawnProcess: SpawnProcess = spawn) {}

    start(request: NodeBoundedProcessRequest): NodeBoundedProcessSession {
        validateProcessRequest(request);
        throwIfAborted(request.signal);
        const child = this.spawnProcess(
            request.executable,
            [...request.args],
            {
                shell: false,
                windowsHide: true,
                stdio: [...request.stdio],
            },
        );
        if (!Number.isSafeInteger(child.pid) || !child.pid) {
            child.kill('SIGKILL');
            throw new HeadlessRenderError(
                'BACKEND_UNAVAILABLE',
                'FFmpeg did not provide a process id.',
            );
        }

        let terminalError: HeadlessRenderError | null = null;
        let settled = false;
        let terminationStarted = false;
        let killTimer: ReturnType<typeof setTimeout> | null = null;
        let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
        let unregister: () => void = () => undefined;
        let stderrBytes = 0;
        let progressBytes = 0;
        let stdoutBytes = 0;
        let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        const maximumStdoutBytes = request.maximumStdoutBytes ?? Number.MAX_SAFE_INTEGER;
        const stdout = child.stdout
            ? new PassThrough({ highWaterMark: 64 * 1024 })
            : null;

        let resolveCompletion!: (result: NodeBoundedProcessResult) => void;
        let rejectCompletion!: (error: HeadlessRenderError) => void;
        const completion = new Promise<NodeBoundedProcessResult>((resolve, reject) => {
            resolveCompletion = resolve;
            rejectCompletion = reject;
        });

        const finish = (
            result: NodeBoundedProcessResult | null,
            error: HeadlessRenderError | null,
        ) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (killTimer) clearTimeout(killTimer);
            if (cleanupTimer) clearTimeout(cleanupTimer);
            request.signal?.removeEventListener('abort', abort);
            unregister();
            if (error) rejectCompletion(error);
            else resolveCompletion(result!);
        };

        const terminate = (error: HeadlessRenderError) => {
            terminalError ??= error;
            if (terminationStarted || settled) return;
            terminationStarted = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), request.limits.killGraceMs);
            cleanupTimer = setTimeout(() => finish(
                null,
                new HeadlessRenderError(
                    'CLEANUP_FAILED',
                    'FFmpeg did not confirm termination after SIGKILL.',
                    false,
                    { cause: terminalError ?? undefined },
                ),
            ), request.limits.killGraceMs * 2);
        };

        unregister = request.tracker.register(child.pid, terminate);
        child.stdin?.on('error', (error) => terminate(new HeadlessRenderError(
            'RENDER_FAILED',
            'FFmpeg stopped accepting raw RGBA input.',
            false,
            { cause: error },
        )));
        child.stderr?.on('data', (chunk: Buffer) => {
            stderrBytes += chunk.byteLength;
            stderrTail = appendTail(stderrTail, chunk, Math.min(
                request.limits.maximumStderrBytes,
                64 * 1024,
            ));
            if (stderrBytes > request.limits.maximumStderrBytes) {
                terminate(new HeadlessRenderError(
                    'RESOURCE_LIMIT',
                    'FFmpeg stderr exceeded its configured byte limit.',
                ));
            }
        });
        if (child.stdout && stdout) {
            child.stdout.on('data', (chunk: Buffer) => {
                stdoutBytes += chunk.byteLength;
                if (stdoutBytes > maximumStdoutBytes) {
                    terminate(new HeadlessRenderError(
                        'RESOURCE_LIMIT',
                        'FFmpeg stdout exceeded its configured byte limit.',
                    ));
                }
            });
            child.stdout.pipe(stdout);
        }
        if (request.progressPipeIndex !== undefined) {
            const progress = child.stdio[request.progressPipeIndex];
            if (!progress || typeof (progress as Readable).on !== 'function') {
                terminate(new HeadlessRenderError(
                    'RENDER_FAILED',
                    'FFmpeg did not expose the configured progress pipe.',
                ));
            } else {
                (progress as Readable).on('data', (chunk: Buffer) => {
                    progressBytes += chunk.byteLength;
                    if (progressBytes > request.limits.maximumProgressBytes) {
                        terminate(new HeadlessRenderError(
                            'RESOURCE_LIMIT',
                            'FFmpeg progress exceeded its configured byte limit.',
                        ));
                        return;
                    }
                    try {
                        request.onProgressChunk?.(chunk);
                    } catch (error) {
                        terminate(new HeadlessRenderError(
                            'RENDER_FAILED',
                            'FFmpeg emitted invalid bounded progress.',
                            false,
                            error instanceof Error ? { cause: error } : undefined,
                        ));
                    }
                });
                (progress as Readable).on('error', (error) => terminate(
                    new HeadlessRenderError(
                        'RENDER_FAILED',
                        'FFmpeg progress pipe failed.',
                        false,
                        { cause: error },
                    ),
                ));
            }
        }

        child.once('error', (error) => {
            terminate(new HeadlessRenderError(
                'BACKEND_UNAVAILABLE',
                'FFmpeg could not be started.',
                false,
                { cause: error },
            ));
        });
        child.once('close', (exitCode, signal) => {
            stdout?.end();
            if (terminalError) {
                finish(null, terminalError);
                return;
            }
            if (exitCode !== 0) {
                finish(null, new HeadlessRenderError(
                    'RENDER_FAILED',
                    `FFmpeg exited with ${exitCode ?? signal ?? 'an unknown status'}: ${stderrTail.toString('utf8')}`,
                ));
                return;
            }
            finish({
                exitCode: 0,
                stderrTail: stderrTail.toString('utf8'),
                stdoutBytes,
                stderrBytes,
                progressBytes,
            }, null);
        });
        const timeout = setTimeout(() => terminate(new HeadlessRenderError(
            'RESOURCE_LIMIT',
            `FFmpeg exceeded its ${request.limits.timeoutMs} ms process deadline.`,
        )), request.limits.timeoutMs);
        const abort = () => terminate(createAbortError());
        request.signal?.addEventListener('abort', abort, { once: true });
        if (request.signal?.aborted) abort();

        return {
            pid: child.pid,
            stdin: child.stdin,
            stdout,
            wait: () => completion,
            terminate: async (error = new HeadlessRenderError(
                'RENDER_FAILED',
                'FFmpeg was terminated by the render backend.',
            )) => {
                terminate(error);
                await completion.catch(() => undefined);
            },
            forceKill: () => child.kill('SIGKILL'),
        };
    }
}

export async function collectBoundedProcessOutput(
    output: Readable | null,
    maximumBytes: number,
    signal?: AbortSignal,
): Promise<Buffer> {
    assertPositiveSafeInteger(maximumBytes, 'maximumBytes');
    if (!output) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const value of output) {
        throwIfAborted(signal);
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        total += chunk.byteLength;
        if (!Number.isSafeInteger(total) || total > maximumBytes) {
            throw new HeadlessRenderError(
                'RESOURCE_LIMIT',
                'FFmpeg output exceeded its bounded collection limit.',
            );
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
}

export async function writeProcessInput(
    input: Writable | null,
    bytes: Uint8Array,
    signal?: AbortSignal,
): Promise<void> {
    throwIfAborted(signal);
    if (!input) throw new HeadlessRenderError('RENDER_FAILED', 'FFmpeg stdin is unavailable.');
    await new Promise<void>((resolve, reject) => {
        input.write(bytes, (error) => error ? reject(error) : resolve());
    });
    throwIfAborted(signal);
}

export async function endProcessInput(input: Writable | null): Promise<void> {
    if (!input || input.destroyed) return;
    await new Promise<void>((resolve, reject) => {
        input.end((error?: Error | null) => error ? reject(error) : resolve());
    });
}

export async function sampleNodeProcessResidentBytes(pid: number): Promise<number> {
    if (platform() === 'linux') {
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        return match ? Number(match[1]) * 1024 : 0;
    }
    if (platform() === 'darwin') {
        const stdout = await new Promise<string>((resolve, reject) => {
            execFile(
                '/bin/ps',
                ['-o', 'rss=', '-p', String(pid)],
                {
                    encoding: 'utf8',
                    maxBuffer: 1024,
                    timeout: 1_000,
                    windowsHide: true,
                },
                (error, output) => error ? reject(error) : resolve(output),
            );
        });
        const kibibytes = Number(stdout.trim());
        return Number.isFinite(kibibytes) && kibibytes >= 0
            ? Math.round(kibibytes * 1024)
            : 0;
    }
    throw new Error('Resident-memory sampling is unavailable on this platform.');
}

function validateProcessRequest(request: NodeBoundedProcessRequest): void {
    if (!request.executable || request.executable.includes('\0')
        || request.args.some((argument) => argument.includes('\0'))
        || request.stdio.length < 3
        || request.stdio.some((entry) => (
            typeof entry === 'number' && (!Number.isSafeInteger(entry) || entry < 0)
        ))) {
        throw new HeadlessRenderError('INVALID_SNAPSHOT', 'FFmpeg process arguments are invalid.');
    }
    const values = [
        request.limits.maximumProcesses,
        request.limits.maximumResidentBytes,
        request.limits.maximumStderrBytes,
        request.limits.maximumProgressBytes,
        request.limits.timeoutMs,
        request.limits.killGraceMs,
        request.maximumStdoutBytes ?? 1,
    ];
    values.forEach((value) => assertPositiveSafeInteger(value, 'process limit'));
    if (request.progressPipeIndex !== undefined
        && (!Number.isSafeInteger(request.progressPipeIndex)
            || request.progressPipeIndex < 3
            || request.progressPipeIndex >= request.stdio.length
            || request.stdio[request.progressPipeIndex] !== 'pipe')) {
        throw new HeadlessRenderError('INVALID_SNAPSHOT', 'FFmpeg progress pipe is invalid.');
    }
}

function appendTail(
    previous: Buffer<ArrayBufferLike>,
    chunk: Buffer<ArrayBufferLike>,
    maximumBytes: number,
): Buffer<ArrayBufferLike> {
    if (maximumBytes <= 0) return Buffer.alloc(0);
    const combined = previous.length === 0 ? chunk : Buffer.concat([previous, chunk]);
    return combined.length <= maximumBytes
        ? Buffer.from(combined)
        : Buffer.from(combined.subarray(combined.length - maximumBytes));
}

function assertPositiveSafeInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive safe integer.`);
    }
}
