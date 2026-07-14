import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { WaveformPeaks } from './video-waveform';
import type { WaveformWorkerResponse } from './video-waveform-worker-protocol';

interface ExecutableWorkerScope {
    onmessage: ((event: MessageEvent<{ type: string; file?: File; duration?: number }>) => Promise<void>) | null;
    postMessage: ReturnType<typeof vi.fn>;
}

const compileWorkerEntrypoint = async () => ts.transpileModule(
    await readFile(new URL('./video-waveform.worker.ts', import.meta.url), 'utf8'),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
        fileName: 'video-waveform.worker.ts',
    },
).outputText;

/** Executes the checked-in worker entrypoint instead of a second hand-written worker model. */
async function loadWorkerArtifact(
    extract: (...args: unknown[]) => Promise<WaveformPeaks | null>,
): Promise<ExecutableWorkerScope> {
    const workerScope: ExecutableWorkerScope = { onmessage: null, postMessage: vi.fn() };
    const moduleRecord = { exports: {} };
    const context = vm.createContext({
        module: moduleRecord,
        exports: moduleRecord.exports,
        self: workerScope,
        Float32Array,
        Error,
        require: (specifier: string) => {
            if (specifier === './video-waveform') {
                return { extractAudioFileWaveformPeaks: extract };
            }
            throw new Error(`Unexpected worker dependency: ${specifier}`);
        },
    });
    vm.runInContext(await compileWorkerEntrypoint(), context, {
        filename: 'video-waveform.worker.js',
    });
    return workerScope;
}

const peaks = (amplitude: number): WaveformPeaks => ({
    duration: 2,
    sampleRate: 48_000,
    bucketCount: 2,
    min: Float32Array.from([-amplitude, -amplitude / 2]),
    max: Float32Array.from([amplitude, amplitude / 2]),
});

describe('shipped waveform worker entrypoint', () => {
    it('publishes progressive and final snapshots with their exact transferable buffers', async () => {
        const partial = peaks(0.25);
        const complete = peaks(0.5);
        const extract = vi.fn(async (...args: unknown[]) => {
            const options = args[4] as { onProgress: (value: WaveformPeaks) => void };
            options.onProgress(partial);
            return complete;
        });
        const worker = await loadWorkerArtifact(extract);

        await worker.onmessage?.({
            data: { type: 'extract', file: new File(['audio'], 'tone.wav'), duration: 2 },
        } as MessageEvent<{ type: string; file: File; duration: number }>);

        expect(extract).toHaveBeenCalledTimes(1);
        expect(worker.postMessage).toHaveBeenNthCalledWith(
            1,
            { type: 'progress', peaks: partial } satisfies WaveformWorkerResponse,
            [partial.min.buffer, partial.max.buffer],
        );
        expect(worker.postMessage).toHaveBeenNthCalledWith(
            2,
            { type: 'result', peaks: complete } satisfies WaveformWorkerResponse,
            [complete.min.buffer, complete.max.buffer],
        );
    });

    it('ignores unrelated messages and converts terminal extraction failures to protocol errors', async () => {
        const extract = vi.fn(async () => { throw new Error('decoder failed'); });
        const worker = await loadWorkerArtifact(extract);

        await worker.onmessage?.({ data: { type: 'cancel' } } as MessageEvent<{ type: string }>);
        expect(extract).not.toHaveBeenCalled();
        expect(worker.postMessage).not.toHaveBeenCalled();

        await worker.onmessage?.({
            data: { type: 'extract', file: new File(['audio'], 'tone.wav'), duration: 2 },
        } as MessageEvent<{ type: string; file: File; duration: number }>);
        expect(worker.postMessage).toHaveBeenCalledWith({ type: 'error', error: 'decoder failed' });
    });
});
