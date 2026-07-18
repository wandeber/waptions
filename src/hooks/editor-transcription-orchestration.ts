import {
    normalizeOpenAICompatibleDiarization,
    transcribeDiarizedAudioWithOpenAICompatibleEndpoint,
    type NormalizedDiarizedSpeaker,
} from '@/lib/ai/openai-compatible-diarization';
import {
    createDiarizationJobGuard,
    type DiarizationJobGuard,
} from '@/lib/diarization-provenance';
import { frameRateToNumber } from '@/lib/render-profile';
import {
    createTimelineDiarizationAudioSnapshot,
    encodeTimelineAudioForDiarization,
    type EncodedTimelineDiarizationAudio,
    type TimelineDiarizationAudioSnapshot,
    type TimelineDiarizationAudioOptions,
} from '@/lib/timeline-diarization-audio';
import type {
    DiarizedSpeakerTrackInput,
    DiarizedTranscriptionMetadata,
} from '@/stores/timeline-store-types';
import type {
    OpenAICompatibleTranscriptionSettings,
    TranscriptionModelId,
    TranscriptionSubmission,
} from '@/types/transcription';
import type { EditorDocumentV3 } from '@/types/video';

const DEFAULT_CUSTOM_MODEL = 'faster-whisper';

export type ResolvedEditorTranscriptionRoute =
    | {
        kind: 'diarized-custom';
        settings: OpenAICompatibleTranscriptionSettings;
    }
    | {
        kind: 'per-source-custom';
        settings: OpenAICompatibleTranscriptionSettings;
    }
    | {
        kind: 'per-source-local';
        settings: Extract<TranscriptionSubmission, {
            routeId: 'local-browser';
        }>['localBrowserTranscription'];
    }
    | {
        kind: 'per-source-built-in';
        modelId: Exclude<TranscriptionModelId, 'local-browser'>;
    };

export type ResolvedPerSourceTranscriptionRoute = Exclude<ResolvedEditorTranscriptionRoute, {
    kind: 'diarized-custom';
}>;

export type ResolvedPerSourceRequestRoute =
    | {
        kind: 'local-browser';
        settings: Extract<ResolvedPerSourceTranscriptionRoute, {
            kind: 'per-source-local';
        }>['settings'];
    }
    | {
        kind: 'custom-browser';
        settings: OpenAICompatibleTranscriptionSettings;
    }
    | {
        kind: 'server';
        transportModelId: Exclude<TranscriptionModelId, 'local-browser'>;
        customOpenAITranscription: OpenAICompatibleTranscriptionSettings | null;
    };

export type DiarizedEditorTranscriptionResult = 'applied' | 'no-speech' | 'stale';

export interface BrowserDiarizationRequestInput {
    settings: OpenAICompatibleTranscriptionSettings;
    audio: Blob;
    filename: string;
    signal: AbortSignal;
}

interface RunDiarizedEditorTranscriptionInput {
    document: EditorDocumentV3;
    targetTrackId: string;
    settings: OpenAICompatibleTranscriptionSettings;
    signal: AbortSignal;
    browserOrigin: string;
    onStatus: (status: string) => void;
    apply: (
        targetTrackId: string,
        speakers: readonly DiarizedSpeakerTrackInput[],
        metadata: DiarizedTranscriptionMetadata,
        guard: DiarizationJobGuard,
    ) => boolean;
}

export interface EditorDiarizationOrchestrationDependencies {
    captureSnapshot: (document: EditorDocumentV3) => TimelineDiarizationAudioSnapshot;
    createGuard: (document: EditorDocumentV3, targetTrackId: string) => DiarizationJobGuard | null;
    encodeAudio: (
        document: TimelineDiarizationAudioSnapshot,
        options: TimelineDiarizationAudioOptions,
    ) => Promise<EncodedTimelineDiarizationAudio>;
    requestFromBrowser: (input: BrowserDiarizationRequestInput) => Promise<unknown>;
    requestThroughServer: (input: {
        settings: OpenAICompatibleTranscriptionSettings;
        audio: Blob;
        filename: string;
        signal: AbortSignal;
    }) => Promise<unknown>;
    normalize: (
        response: unknown,
        durationSeconds: number,
        projectFps: number,
    ) => NormalizedDiarizedSpeaker[];
    now: () => Date;
}

const defaultDependencies: EditorDiarizationOrchestrationDependencies = {
    captureSnapshot: createTimelineDiarizationAudioSnapshot,
    createGuard: createDiarizationJobGuard,
    encodeAudio: encodeTimelineAudioForDiarization,
    requestFromBrowser: requestDiarizationFromBrowser,
    requestThroughServer: requestDiarizationThroughServer,
    normalize: normalizeOpenAICompatibleDiarization,
    now: () => new Date(),
};

/** Preserves the encoded container while leaving multipart construction in the generic helper. */
export function requestDiarizationFromBrowser(
    { settings, audio, filename, signal }: BrowserDiarizationRequestInput,
    fetchImpl?: typeof fetch,
): Promise<unknown> {
    return transcribeDiarizedAudioWithOpenAICompatibleEndpoint({
        settings,
        // A plain Blob would make the generic helper fall back to `audio.mp4`, even for Opus/WebM.
        audioFile: new File([audio], filename, { type: audio.type }),
        fetchImpl,
        signal,
    });
}

/**
 * Resolves the modal's discriminated submission before any media work begins.
 *
 * The exact custom route comparison is deliberate: the built-in `whisper-1`
 * route may use the same provider model name, but it must never inherit custom
 * endpoint settings or activate diarization.
 */
export function resolveEditorTranscriptionRoute(
    submission: TranscriptionSubmission,
): ResolvedEditorTranscriptionRoute {
    if (submission.routeId === 'custom-openai-compatible') {
        if (submission.diarizationEnabled) {
            return {
                kind: 'diarized-custom',
                settings: submission.customOpenAITranscription,
            };
        }

        // Keep custom identity explicit throughout orchestration. The generic server endpoint's
        // historical `whisper-1` transport value is introduced only by the request adapter below.
        return {
            kind: 'per-source-custom',
            settings: submission.customOpenAITranscription,
        };
    }

    if (submission.routeId === 'local-browser') {
        return {
            kind: 'per-source-local',
            settings: submission.localBrowserTranscription,
        };
    }

    return {
        kind: 'per-source-built-in',
        modelId: submission.routeId,
    };
}

/**
 * Resolves the request mechanism without collapsing custom endpoint identity into a built-in ID.
 * `whisper-1` below is only the legacy model field required by the generic server form contract.
 */
export function resolvePerSourceTranscriptionRequest(
    route: ResolvedPerSourceTranscriptionRoute,
): ResolvedPerSourceRequestRoute {
    if (route.kind === 'per-source-local') {
        return { kind: 'local-browser', settings: route.settings };
    }
    if (route.kind === 'per-source-custom') {
        if (route.settings.requestMode === 'browser') {
            return { kind: 'custom-browser', settings: route.settings };
        }
        return {
            kind: 'server',
            transportModelId: 'whisper-1',
            customOpenAITranscription: route.settings,
        };
    }
    return {
        kind: 'server',
        transportModelId: route.modelId,
        customOpenAITranscription: null,
    };
}

/**
 * Runs the single-request project-wide diarization pipeline.
 *
 * Snapshot and guard creation are synchronous and adjacent, so both describe
 * the same editor projection. Every asynchronous boundary is followed by an
 * abort check; the only durable operation is the final guarded `apply` call.
 */
export async function runDiarizedEditorTranscription(
    input: RunDiarizedEditorTranscriptionInput,
    dependencies: EditorDiarizationOrchestrationDependencies = defaultDependencies,
): Promise<DiarizedEditorTranscriptionResult> {
    input.onStatus('Preparing the project audio mix…');
    const snapshot = dependencies.captureSnapshot(input.document);
    const guard = dependencies.createGuard(snapshot, input.targetTrackId);
    if (!guard) return 'stale';
    throwIfAborted(input.signal);

    let currentEncodingStage = 'Rendering the project audio mix';
    const encoded = await dependencies.encodeAudio(snapshot, {
        signal: input.signal,
        onStage: (stage) => {
            currentEncodingStage = stage === 'rendering-project-mix'
                ? 'Rendering the project audio mix'
                : 'Encoding the project audio mix';
            input.onStatus(`${currentEncodingStage}…`);
        },
        onProgress: (progress) => {
            if (!Number.isFinite(progress)) return;
            const percentage = Math.round(Math.min(1, Math.max(0, progress)) * 100);
            input.onStatus(`${currentEncodingStage}… ${percentage}%`);
        },
    });
    throwIfAborted(input.signal);

    let response: unknown;
    if (input.settings.requestMode === 'browser') {
        input.onStatus('Sending the project mix to the transcriber from this browser…');
        try {
            response = await dependencies.requestFromBrowser({
                settings: input.settings,
                audio: encoded.blob,
                filename: encoded.filename,
                signal: input.signal,
            });
        } catch (error) {
            if (input.signal.aborted || isAbortLikeError(error)) throw error;
            const message = error instanceof Error
                ? redactConfiguredSecret(error.message, input.settings.apiKey)
                : 'The browser could not call the transcriber.';
            throw new Error(`${message} Check that the endpoint allows CORS from ${input.browserOrigin}.`);
        }
    } else {
        input.onStatus('Sending the project mix through the Waptions server…');
        response = await dependencies.requestThroughServer({
            settings: input.settings,
            audio: encoded.blob,
            filename: encoded.filename,
            signal: input.signal,
        });
    }
    throwIfAborted(input.signal);

    input.onStatus('Organizing speaker tracks…');
    const speakers = dependencies.normalize(
        response,
        encoded.durationSeconds,
        frameRateToNumber(snapshot.renderProfile.fps),
    );
    throwIfAborted(input.signal);

    // A valid response with no speech is not an instruction to erase a prior
    // transcription. It exits before history, persistence, or track mutation.
    if (speakers.length === 0) return 'no-speech';

    input.onStatus('Applying speaker tracks…');
    const applied = input.apply(input.targetTrackId, speakers, {
        provider: 'custom-openai-compatible',
        model: input.settings.model?.trim() || DEFAULT_CUSTOM_MODEL,
        generatedAt: dependencies.now().toISOString(),
    }, guard);
    return applied ? 'applied' : 'stale';
}

async function requestDiarizationThroughServer(input: {
    settings: OpenAICompatibleTranscriptionSettings;
    audio: Blob;
    filename: string;
    signal: AbortSignal;
}): Promise<unknown> {
    const formData = new FormData();
    formData.append('audio', input.audio, input.filename);
    formData.append('customOpenAITranscription', JSON.stringify(input.settings));

    const response = await fetch('/api/generate-subtitles/diarize', {
        method: 'POST',
        body: formData,
        signal: input.signal,
    });
    const responseBody = await response.json() as unknown;
    if (!response.ok) {
        const rawMessage = isRecord(responseBody) && typeof responseBody.error === 'string'
            ? responseBody.error
            : 'Speaker diarization failed.';
        throw new Error(redactConfiguredSecret(rawMessage, input.settings.apiKey));
    }
    return responseBody;
}

function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    if (typeof DOMException !== 'undefined') {
        throw new DOMException('Transcription cancelled.', 'AbortError');
    }
    const error = new Error('Transcription cancelled.');
    error.name = 'AbortError';
    throw error;
}

function isAbortLikeError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

/** The configured key is the only known secret a local service may echo in diagnostics. */
function redactConfiguredSecret(message: string, secret: string | undefined): string {
    const trimmedSecret = secret?.trim();
    return trimmedSecret ? message.split(trimmedSecret).join('[REDACTED]') : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
