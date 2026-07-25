import type {
    LocalBrowserTranscriptionDevice,
    LocalBrowserTranscriptionEngine,
    LocalBrowserTranscriptionSettings,
} from "@/types/transcription";
export { normalizeLocalBrowserPipelineOutput } from "@/lib/ai/local-browser-transcription-output";

const TARGET_SAMPLE_RATE = 16000;
const WORKER_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_LOCAL_BROWSER_WINDOW_SAMPLES = TARGET_SAMPLE_RATE * 30;

export interface LocalBrowserTranscriptionWord {
    word: string;
    start: number;
    end: number;
}

export interface LocalBrowserTranscriptionResult {
    text: string;
    words: LocalBrowserTranscriptionWord[];
    diagnostics: {
        engine: LocalBrowserTranscriptionEngine;
        device: LocalBrowserTranscriptionDevice;
        modelId: string;
        durationSeconds: number;
    };
}

export interface LocalBrowserTranscriptionProgress {
    stage: "preparing" | "loading-model" | "transcribing" | "normalizing" | "done" | "error";
    message: string;
    progress?: number;
}

interface LocalBrowserWorkerResponse {
    type: "progress" | "result" | "error";
    progress?: LocalBrowserTranscriptionProgress;
    result?: LocalBrowserTranscriptionResult;
    error?: string;
    requestId?: string;
}

interface LocalBrowserWorkerLike {
    onmessage: ((event: MessageEvent<LocalBrowserWorkerResponse>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    postMessage(message: unknown, transfer: Transferable[]): void;
    terminate(): void;
}

export interface LocalBrowserPcmWindow {
    startSample: number;
    samples: Float32Array;
}

export interface LocalBrowserPcmWindowResult {
    startSample: number;
    result: LocalBrowserTranscriptionResult;
}

export interface LocalBrowserTranscriptionSession {
    transcribeWindow(
        window: LocalBrowserPcmWindow,
        requestId: string,
    ): Promise<LocalBrowserPcmWindowResult>;
    dispose(): void;
}

export interface LocalBrowserModelManifest {
    id: string;
    engine: LocalBrowserTranscriptionEngine;
    label: string;
    description: string;
    modelId: string;
    alignerModelId?: string;
    estimatedDownloadMb: number;
    requiresWebGpu: boolean;
    experimental?: boolean;
}

export const LOCAL_BROWSER_MODEL_MANIFESTS: LocalBrowserModelManifest[] = [
    {
        id: "whisper-base-webgpu",
        engine: "whisper-webgpu",
        label: "Whisper local",
        description: "Stable local browser transcription with timeline-ready timestamps. Best first public option.",
        modelId: "onnx-community/whisper-base",
        estimatedDownloadMb: 290,
        requiresWebGpu: false,
    },
    {
        id: "qwen-mega-asr-browser",
        engine: "qwen3-asr-aligner",
        label: "Qwen/Mega-ASR experimental",
        description: "High-quality Qwen-derived ASR validation path. Very large download.",
        modelId: "Reza2kn/mega-asr-onnx",
        // Keep the forced-aligner candidate tied to the manifest while this
        // route stays hidden. The current worker validates ASR execution first;
        // browser-side forced alignment should only become public after its
        // Transformers.js pipeline shape and WASM/WebGPU performance are proven.
        alignerModelId: "valoomba/Qwen3-ForcedAligner-0.6B-ONNX",
        estimatedDownloadMb: 2600,
        requiresWebGpu: true,
        experimental: true,
    },
];

export const DEFAULT_LOCAL_BROWSER_TRANSCRIPTION_SETTINGS: LocalBrowserTranscriptionSettings = {
    enabled: true,
    engine: "whisper-webgpu",
    manifestId: "whisper-base-webgpu",
    device: "webgpu",
    language: "auto",
    allowWasmFallback: false,
};

export function getLocalBrowserModelManifest(manifestId: string | undefined): LocalBrowserModelManifest {
    return LOCAL_BROWSER_MODEL_MANIFESTS.find(manifest => manifest.id === manifestId)
        ?? LOCAL_BROWSER_MODEL_MANIFESTS[0];
}

export function getVisibleLocalBrowserModelManifests(): LocalBrowserModelManifest[] {
    if (process.env.NEXT_PUBLIC_ENABLE_EXPERIMENTAL_QWEN_BROWSER_ASR === "true") {
        return LOCAL_BROWSER_MODEL_MANIFESTS;
    }

    return LOCAL_BROWSER_MODEL_MANIFESTS.filter(manifest => !manifest.experimental);
}

export function getLocalBrowserTranscriptionCapabilities() {
    const webgpuAvailable = hasRequestableWebGpuAdapter();
    const isolated = typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : false;

    return {
        browserSupported: typeof window !== "undefined" && typeof Worker !== "undefined",
        webgpuAvailable,
        crossOriginIsolated: isolated,
        recommendedDevice: webgpuAvailable ? "webgpu" as const : "wasm" as const,
    };
}

export async function isLocalBrowserWebGpuReady(): Promise<boolean> {
    const gpu = getNavigatorGpu();
    if (!gpu?.requestAdapter) {
        return false;
    }

    try {
        return Boolean(await gpu.requestAdapter());
    } catch {
        return false;
    }
}

/**
 * Transcribes bounded canonical 16 kHz windows with one persistent model worker.
 *
 * The decoder/range coordinator owns window production; this path never creates a source-wide
 * AudioBuffer. Transfer ownership moves one <=30-second buffer into the worker at a time, and the
 * worker is terminated on every success, error, timeout, or abort.
 */
export async function transcribeLocalBrowserPcmWindows(input: {
    windows: readonly LocalBrowserPcmWindow[];
    settings: LocalBrowserTranscriptionSettings;
    signal?: AbortSignal;
    onProgress?: (progress: LocalBrowserTranscriptionProgress) => void;
    createWorker?: () => LocalBrowserWorkerLike;
}): Promise<LocalBrowserPcmWindowResult[]> {
    validateLocalBrowserPcmWindows(input.windows);
    const session = await createLocalBrowserTranscriptionSession(input);
    const results: LocalBrowserPcmWindowResult[] = [];
    try {
        for (let index = 0; index < input.windows.length; index += 1) {
            input.onProgress?.({
                stage: "preparing",
                message: `Preparing local transcription window ${index + 1} of ${input.windows.length}...`,
                progress: input.windows.length === 0 ? 1 : index / input.windows.length,
            });
            results.push(await session.transcribeWindow(input.windows[index], `window-${index}`));
        }
        return results;
    } finally {
        session.dispose();
    }
}

/** Creates one model-owning worker session so sequential decoder windows never reload the model. */
export async function createLocalBrowserTranscriptionSession(input: {
    settings: LocalBrowserTranscriptionSettings;
    signal?: AbortSignal;
    onProgress?: (progress: LocalBrowserTranscriptionProgress) => void;
    createWorker?: () => LocalBrowserWorkerLike;
}): Promise<LocalBrowserTranscriptionSession> {
    const manifest = getLocalBrowserModelManifest(input.settings.manifestId);
    const webgpuReady = await isLocalBrowserWebGpuReady();
    const device = resolveRequestedDevice(input.settings, manifest, webgpuReady);
    if (device === "webgpu" && !webgpuReady) {
        throw new Error("WebGPU is not available in this browser. Use Chromium/Edge or enable the slow WASM fallback.");
    }
    const worker = (input.createWorker ?? (() => (
        new Worker(new URL("./local-browser-transcription.worker.ts", import.meta.url), { type: "module" })
    )))();
    const settings = {
        ...input.settings,
        device,
        engine: manifest.engine,
        manifestId: manifest.id,
    };
    let disposed = false;
    return {
        transcribeWindow: async (window, requestId) => {
            if (disposed) throw new Error("Local browser transcription session is disposed.");
            if (input.signal?.aborted) throw createLocalAbortError();
            validateLocalBrowserPcmWindows([window]);
            const result = await requestLocalBrowserWorkerWindow({
                worker,
                requestId,
                audio: window.samples,
                durationSeconds: window.samples.length / TARGET_SAMPLE_RATE,
                settings,
                manifest,
                signal: input.signal,
                onProgress: input.onProgress,
            });
            return { startSample: window.startSample, result };
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            worker.terminate();
        },
    };
}

function hasRequestableWebGpuAdapter(): boolean {
    return Boolean(getNavigatorGpu()?.requestAdapter);
}

function getNavigatorGpu(): { requestAdapter?: () => Promise<unknown> } | undefined {
    if (typeof navigator === "undefined") {
        return undefined;
    }

    return (navigator as Navigator & { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
}

function resolveRequestedDevice(
    settings: LocalBrowserTranscriptionSettings,
    manifest: LocalBrowserModelManifest,
    webgpuAvailable: boolean,
): LocalBrowserTranscriptionDevice {
    if (settings.device === "wasm") {
        if (manifest.requiresWebGpu && !settings.allowWasmFallback) {
            return "webgpu";
        }

        return "wasm";
    }

    if (webgpuAvailable) {
        return "webgpu";
    }

    return settings.allowWasmFallback ? "wasm" : "webgpu";
}

function requestLocalBrowserWorkerWindow(input: {
    worker: LocalBrowserWorkerLike;
    requestId: string;
    audio: Float32Array;
    durationSeconds: number;
    settings: LocalBrowserTranscriptionSettings;
    manifest: LocalBrowserModelManifest;
    signal?: AbortSignal;
    onProgress?: (progress: LocalBrowserTranscriptionProgress) => void;
}): Promise<LocalBrowserTranscriptionResult> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            input.signal?.removeEventListener("abort", abort);
            input.worker.onmessage = null;
            input.worker.onerror = null;
            callback();
        };
        const timeout = setTimeout(() => {
            finish(() => reject(new Error("Local browser transcription window timed out.")));
        }, WORKER_TIMEOUT_MS);
        const abort = () => {
            finish(() => reject(createLocalAbortError()));
        };
        if (input.signal?.aborted) {
            abort();
            return;
        }
        input.signal?.addEventListener("abort", abort, { once: true });
        input.worker.onmessage = (event) => {
            const message = event.data;
            if (message.requestId !== input.requestId) return;
            if (message.type === "progress" && message.progress) {
                input.onProgress?.(message.progress);
                return;
            }
            finish(() => {
                if (message.type === "result" && message.result) resolve(message.result);
                else reject(new Error(message.error || "Local browser transcription window failed."));
            });
        };
        input.worker.onerror = (event) => {
            finish(() => reject(new Error(event.message || "Local browser transcription worker crashed.")));
        };
        input.worker.postMessage({
            type: "transcribe-window",
            requestId: input.requestId,
            audio: input.audio,
            durationSeconds: input.durationSeconds,
            settings: input.settings,
            manifest: input.manifest,
        }, [input.audio.buffer]);
    });
}

function validateLocalBrowserPcmWindows(windows: readonly LocalBrowserPcmWindow[]): void {
    let previousStart = -1;
    windows.forEach((window) => {
        if (!Number.isSafeInteger(window.startSample)
            || window.startSample < 0
            || window.startSample < previousStart
            || !(window.samples instanceof Float32Array)
            || window.samples.length === 0
            || window.samples.length > MAX_LOCAL_BROWSER_WINDOW_SAMPLES) {
            throw new Error("Local browser transcription window is invalid or exceeds 30 seconds.");
        }
        previousStart = window.startSample;
    });
}

function createLocalAbortError(): DOMException {
    return new DOMException("Local browser transcription was cancelled.", "AbortError");
}
