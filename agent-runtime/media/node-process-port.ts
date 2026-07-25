import { spawn, type ChildProcess } from 'node:child_process';
import type {
    ManagedProcessPort,
    ManagedProcessResult,
    ManagedProcessSpec,
} from './contracts';
import { throwIfAborted } from '../../src/lib/media-byte-source/types';

const VERIFIED_INPUT_PLACEHOLDER = '{{VERIFIED_INPUT}}';

export class ManagedProcessError extends Error {
    constructor(
        message: string,
        readonly code:
            | 'PROCESS_FAILED'
            | 'PROCESS_OUTPUT_LIMIT'
            | 'PROCESS_TIMEOUT'
            | 'PROCESS_ABORTED',
    ) {
        super(message);
        this.name = 'ManagedProcessError';
    }
}

export class NodeManagedProcessPort implements ManagedProcessPort {
    async run(spec: ManagedProcessSpec): Promise<ManagedProcessResult> {
        throwIfAborted(spec.signal);
        if (spec.inputHandle && process.platform === 'win32') {
            throw new Error('Verified descriptor process input is not implemented on Windows.');
        }
        const args = spec.args.map((argument) => {
            if (argument !== VERIFIED_INPUT_PLACEHOLDER) return argument;
            if (!spec.inputHandle) throw new Error('The process command requires a verified input handle.');
            return '/dev/fd/3';
        });
        const stdio: Array<'ignore' | 'pipe' | number> = spec.inputHandle
            ? ['ignore', 'pipe', 'pipe', spec.inputHandle.fd]
            : ['ignore', 'pipe', 'pipe'];
        const child = spawn(spec.executable, args, {
            stdio,
            windowsHide: true,
        });
        return collectManagedProcess(child, spec);
    }
}

function collectManagedProcess(
    child: ChildProcess,
    spec: ManagedProcessSpec,
): Promise<ManagedProcessResult> {
    return new Promise<ManagedProcessResult>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let terminalError: unknown = null;
        let settled = false;
        let killTimer: ReturnType<typeof setTimeout> | null = null;

        const terminate = (error: unknown) => {
            terminalError ??= error;
            child.kill('SIGTERM');
            killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1_000);
        };
        const append = (
            chunk: Buffer,
            stream: 'stdout' | 'stderr',
            maximum: number,
        ) => {
            const nextBytes = stream === 'stdout'
                ? stdoutBytes + chunk.byteLength
                : stderrBytes + chunk.byteLength;
            if (nextBytes > maximum) {
                terminate(new ManagedProcessError(
                    `${stream} exceeded its ${maximum}-byte limit.`,
                    'PROCESS_OUTPUT_LIMIT',
                ));
                return;
            }
            if (stream === 'stdout') {
                stdoutBytes = nextBytes;
                stdout += chunk.toString('utf8');
            } else {
                stderrBytes = nextBytes;
                stderr += chunk.toString('utf8');
            }
        };
        child.stdout?.on('data', (chunk: Buffer) => append(chunk, 'stdout', spec.stdoutLimitBytes));
        child.stderr?.on('data', (chunk: Buffer) => append(chunk, 'stderr', spec.stderrLimitBytes));
        child.once('error', (error) => {
            terminalError ??= error;
        });

        const timeout = setTimeout(() => terminate(new ManagedProcessError(
            `Process exceeded its ${spec.timeoutMs} ms timeout.`,
            'PROCESS_TIMEOUT',
        )), spec.timeoutMs);
        const abort = () => terminate(
            spec.signal?.reason
                ?? new ManagedProcessError('Process was aborted.', 'PROCESS_ABORTED'),
        );
        spec.signal?.addEventListener('abort', abort, { once: true });
        // The signal may abort after the pre-spawn check but before this listener is installed.
        if (spec.signal?.aborted) abort();

        child.once('close', (exitCode) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (killTimer) clearTimeout(killTimer);
            spec.signal?.removeEventListener('abort', abort);
            if (terminalError) {
                reject(terminalError);
                return;
            }
            if (exitCode !== 0) {
                reject(new ManagedProcessError(
                    `Process exited with code ${exitCode ?? 'unknown'}: ${stderr.slice(-2_000)}`,
                    'PROCESS_FAILED',
                ));
                return;
            }
            resolve(Object.freeze({
                exitCode: 0,
                stdout,
                stderr,
            }));
        });
    });
}

export { VERIFIED_INPUT_PLACEHOLDER };
