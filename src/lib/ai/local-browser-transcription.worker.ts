import type {
    LocalBrowserModelManifest,
    LocalBrowserTranscriptionProgress,
} from "@/lib/ai/local-browser-transcription";
import { normalizeLocalBrowserPipelineOutput } from "@/lib/ai/local-browser-transcription-output";
import type { LocalBrowserTranscriptionSettings } from "@/types/transcription";

interface TranscribeMessage {
    type: "transcribe";
    audio: Float32Array;
    durationSeconds: number;
    settings: LocalBrowserTranscriptionSettings;
    manifest: LocalBrowserModelManifest;
}

type WorkerMessage = TranscribeMessage;

let cachedModelKey: string | null = null;
let cachedPipeline: unknown = null;

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
    if (event.data.type !== "transcribe") {
        return;
    }

    try {
        const result = await transcribe(event.data);
        self.postMessage({ type: "result", result });
    } catch (error) {
        self.postMessage({
            type: "error",
            error: error instanceof Error ? error.message : "Local browser transcription failed.",
        });
    }
};

async function transcribe(message: TranscribeMessage) {
    emitProgress({
        stage: "loading-model",
        message: `Loading ${message.manifest.label} in this browser...`,
        progress: 0,
    });

    const transcriber = await getPipeline(message.settings, message.manifest);

    emitProgress({
        stage: "transcribing",
        message: "Running local transcription. This may take a while on the first pass...",
    });

    const output = await transcribeWithBestAvailableTimestamps(transcriber, message);

    emitProgress({
        stage: "normalizing",
        message: "Preparing local word timestamps for the timeline...",
    });

    const normalized = normalizeLocalBrowserPipelineOutput(output, message.durationSeconds);

    emitProgress({
        stage: "done",
        message: "Local transcription complete.",
        progress: 1,
    });

    return {
        ...normalized,
        diagnostics: {
            engine: message.settings.engine,
            device: message.settings.device || "webgpu",
            modelId: message.manifest.modelId,
            durationSeconds: message.durationSeconds,
        },
    };
}

async function transcribeWithBestAvailableTimestamps(transcriber: TranscriberPipeline, message: TranscribeMessage): Promise<unknown> {
    const options = {
        chunk_length_s: 30,
        stride_length_s: 5,
        language: message.settings.language && message.settings.language !== "auto" ? message.settings.language : undefined,
        task: "transcribe",
    };

    try {
        return await transcriber(message.audio, {
            ...options,
            return_timestamps: "word",
        });
    } catch (error) {
        if (!isMissingAttentionTimestampError(error)) {
            throw error;
        }

        emitProgress({
            stage: "transcribing",
            message: "This browser model cannot expose word attentions; using segment timestamps instead...",
        });

        return transcriber(message.audio, {
            ...options,
            return_timestamps: true,
        });
    }
}

function isMissingAttentionTimestampError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("cross attentions") || message.includes("output_attentions");
}

async function getPipeline(settings: LocalBrowserTranscriptionSettings, manifest: LocalBrowserModelManifest) {
    const modelKey = `${manifest.modelId}:${settings.device || "webgpu"}`;
    if (cachedModelKey === modelKey && cachedPipeline) {
        return cachedPipeline as TranscriberPipeline;
    }

    const { env, pipeline } = await import("@huggingface/transformers");

    env.allowLocalModels = false;
    env.useBrowserCache = true;

    const device = settings.device === "wasm" ? undefined : "webgpu";
    const dtype = getPipelineDtype(settings);
    const transcriber = await pipeline("automatic-speech-recognition", manifest.modelId, {
        device,
        dtype,
        progress_callback: (progress: unknown) => {
            emitProgress({
                stage: "loading-model",
                message: getProgressMessage(progress, manifest.label),
                progress: getProgressRatio(progress),
            });
        },
    } as Record<string, unknown>);

    cachedModelKey = modelKey;
    cachedPipeline = transcriber;
    return transcriber as TranscriberPipeline;
}

function getPipelineDtype(settings: LocalBrowserTranscriptionSettings): "fp32" | undefined {
    if (settings.device !== "wasm") {
        return undefined;
    }

    // Transformers.js defaults to quantized WASM weights to keep downloads small,
    // but the current Whisper base quantized decoder can fail session creation in
    // ONNX Runtime Web with a missing-scale MatMulNBits/QDQ error. The public
    // local transcription path must prioritize reliable startup over bandwidth,
    // so WASM explicitly uses fp32 model files.
    return "fp32";
}

function emitProgress(progress: LocalBrowserTranscriptionProgress) {
    self.postMessage({ type: "progress", progress });
}

function getProgressMessage(progress: unknown, label: string): string {
    if (!isRecord(progress)) {
        return `Loading ${label}...`;
    }

    const file = typeof progress.file === "string" ? progress.file : undefined;
    const status = typeof progress.status === "string" ? progress.status : "loading";
    return file ? `${status}: ${file}` : `Loading ${label}...`;
}

function getProgressRatio(progress: unknown): number | undefined {
    if (!isRecord(progress)) {
        return undefined;
    }

    const loaded = typeof progress.loaded === "number" ? progress.loaded : undefined;
    const total = typeof progress.total === "number" ? progress.total : undefined;
    const value = typeof progress.progress === "number" ? progress.progress : undefined;

    if (loaded !== undefined && total && total > 0) {
        return Math.max(0, Math.min(1, loaded / total));
    }

    if (value !== undefined) {
        return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
    }

    return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

type TranscriberPipeline = (
    audio: Float32Array,
    options: Record<string, unknown>,
) => Promise<unknown>;

export {};
