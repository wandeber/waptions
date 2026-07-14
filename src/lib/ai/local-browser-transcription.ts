import type {
    LocalBrowserTranscriptionDevice,
    LocalBrowserTranscriptionEngine,
    LocalBrowserTranscriptionSettings,
} from "@/types/transcription";
export { normalizeLocalBrowserPipelineOutput } from "@/lib/ai/local-browser-transcription-output";

const TARGET_SAMPLE_RATE = 16000;
const WORKER_TIMEOUT_MS = 30 * 60 * 1000;

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

interface LocalBrowserTranscriptionRequest {
    audioBlob: Blob;
    settings: LocalBrowserTranscriptionSettings;
    signal?: AbortSignal;
    onProgress?: (progress: LocalBrowserTranscriptionProgress) => void;
}

interface LocalBrowserWorkerResponse {
    type: "progress" | "result" | "error";
    progress?: LocalBrowserTranscriptionProgress;
    result?: LocalBrowserTranscriptionResult;
    error?: string;
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
    const audioDecodeAvailable = typeof window !== "undefined"
        && (typeof AudioContext !== "undefined" || "webkitAudioContext" in window);

    return {
        browserSupported: typeof window !== "undefined" && typeof Worker !== "undefined" && audioDecodeAvailable,
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

export async function transcribeWithLocalBrowserModel({
    audioBlob,
    settings,
    signal,
    onProgress,
}: LocalBrowserTranscriptionRequest): Promise<LocalBrowserTranscriptionResult> {
    const manifest = getLocalBrowserModelManifest(settings.manifestId);
    const webgpuReady = await isLocalBrowserWebGpuReady();
    const device = resolveRequestedDevice(settings, manifest, webgpuReady);

    if (device === "webgpu" && !webgpuReady) {
        throw new Error("WebGPU is not available in this browser. Use Chromium/Edge or enable the slow WASM fallback.");
    }

    onProgress?.({ stage: "preparing", message: "Preparing local audio for the browser model..." });
    const preparedAudio = await decodeAudioToMono16k(audioBlob);

    return runLocalBrowserTranscriptionWorker({
        audio: preparedAudio.samples,
        durationSeconds: preparedAudio.durationSeconds,
        settings: {
            ...settings,
            device,
            engine: manifest.engine,
            manifestId: manifest.id,
        },
        manifest,
        signal,
        onProgress,
    });
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

async function decodeAudioToMono16k(audioBlob: Blob): Promise<{ samples: Float32Array; durationSeconds: number }> {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
        throw new Error("This browser cannot decode audio locally.");
    }

    const audioContext = new AudioContextCtor();
    try {
        const decoded = await audioContext.decodeAudioData(await audioBlob.arrayBuffer());
        const mono = mixAudioBufferToMono(decoded);

        if (decoded.sampleRate === TARGET_SAMPLE_RATE) {
            return {
                samples: mono,
                durationSeconds: mono.length / TARGET_SAMPLE_RATE,
            };
        }

        const resampled = await resampleMonoAudio(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
        return {
            samples: resampled,
            durationSeconds: resampled.length / TARGET_SAMPLE_RATE,
        };
    } finally {
        await audioContext.close().catch(() => undefined);
    }
}

function mixAudioBufferToMono(audioBuffer: AudioBuffer): Float32Array {
    const channelCount = audioBuffer.numberOfChannels;
    const mono = new Float32Array(audioBuffer.length);

    for (let channel = 0; channel < channelCount; channel++) {
        const data = audioBuffer.getChannelData(channel);
        for (let i = 0; i < data.length; i++) {
            mono[i] += data[i] / channelCount;
        }
    }

    return mono;
}

async function resampleMonoAudio(samples: Float32Array, sourceRate: number, targetRate: number): Promise<Float32Array> {
    // Transformers.js ASR pipelines expect mono 16 kHz PCM. OfflineAudioContext
    // gives us the browser's native resampler without shipping another DSP
    // dependency or doing low-quality manual interpolation.
    const targetLength = Math.ceil(samples.length * targetRate / sourceRate);
    const offlineContext = new OfflineAudioContext(1, targetLength, targetRate);
    const sourceBuffer = offlineContext.createBuffer(1, samples.length, sourceRate);

    sourceBuffer.copyToChannel(samples, 0);

    const source = offlineContext.createBufferSource();
    source.buffer = sourceBuffer;
    source.connect(offlineContext.destination);
    source.start(0);

    const rendered = await offlineContext.startRendering();
    return new Float32Array(rendered.getChannelData(0));
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

function runLocalBrowserTranscriptionWorker({
    audio,
    durationSeconds,
    settings,
    manifest,
    signal,
    onProgress,
}: {
    audio: Float32Array;
    durationSeconds: number;
    settings: LocalBrowserTranscriptionSettings;
    manifest: LocalBrowserModelManifest;
    signal?: AbortSignal;
    onProgress?: (progress: LocalBrowserTranscriptionProgress) => void;
}): Promise<LocalBrowserTranscriptionResult> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./local-browser-transcription.worker.ts", import.meta.url), { type: "module" });
        // Local inference can legitimately be slow on first model download, but
        // the UI must not keep a leaked worker forever if the runtime stalls.
        const timeout = window.setTimeout(() => {
            worker.terminate();
            reject(new Error("Local browser transcription timed out."));
        }, WORKER_TIMEOUT_MS);

        const abort = () => {
            window.clearTimeout(timeout);
            worker.terminate();
            reject(new Error("Local browser transcription was cancelled."));
        };

        if (signal?.aborted) {
            abort();
            return;
        }

        signal?.addEventListener("abort", abort, { once: true });

        worker.onmessage = (event: MessageEvent<LocalBrowserWorkerResponse>) => {
            const message = event.data;

            if (message.type === "progress" && message.progress) {
                onProgress?.(message.progress);
                return;
            }

            window.clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            worker.terminate();

            if (message.type === "result" && message.result) {
                resolve(message.result);
                return;
            }

            reject(new Error(message.error || "Local browser transcription failed."));
        };

        worker.onerror = (event) => {
            window.clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            worker.terminate();
            reject(new Error(event.message || "Local browser transcription worker crashed."));
        };

        worker.postMessage({
            type: "transcribe",
            audio,
            durationSeconds,
            settings,
            manifest,
        }, [audio.buffer]);
    });
}
