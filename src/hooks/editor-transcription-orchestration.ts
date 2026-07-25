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
    createTimelineDiarizationCoveragePlan,
    encodeTimelineAudioForDiarization,
    type EncodedTimelineDiarizationAudio,
    type TimelineDiarizationAudioSnapshot,
    type TimelineDiarizationAudioOptions,
    type TimelineDiarizationCoverageWindow,
} from '@/lib/timeline-diarization-audio';
import { buildAudioMixPlan } from '@/lib/audio-mix-plan';
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
import { readBoundedJsonResponse } from '@/lib/ai/transcription-http-policy';

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
    planWindows?: (
        document: TimelineDiarizationAudioSnapshot,
    ) => readonly TimelineDiarizationCoverageWindow[];
    encodeWindow?: (
        document: TimelineDiarizationAudioSnapshot,
        window: TimelineDiarizationCoverageWindow,
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
    planWindows: document => createTimelineDiarizationCoveragePlan(
        buildAudioMixPlan(document),
    ).windows,
    encodeWindow: (document, window, options) => encodeTimelineAudioForDiarization(
        document,
        { ...options, window },
    ),
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

    const windows = dependencies.planWindows && dependencies.encodeWindow
        ? dependencies.planWindows(snapshot)
        : null;
    const windowInputs: Array<TimelineDiarizationCoverageWindow | null> = windows
        ? [...windows]
        : [null];
    const collectedSpeakers = new Map<string, NormalizedDiarizedSpeaker>();
    for (let windowIndex = 0; windowIndex < windowInputs.length; windowIndex += 1) {
        const window = windowInputs[windowIndex];
        let currentEncodingStage = 'Rendering the project audio mix';
        const encodingOptions: TimelineDiarizationAudioOptions = {
            signal: input.signal,
            onStage: (stage) => {
                currentEncodingStage = stage === 'rendering-project-mix'
                    ? 'Rendering the project audio mix'
                    : 'Encoding the project audio mix';
                input.onStatus(`${currentEncodingStage} (${windowIndex + 1}/${windowInputs.length})…`);
            },
            onProgress: (progress) => {
                if (!Number.isFinite(progress)) return;
                const percentage = Math.round(Math.min(1, Math.max(0, progress)) * 100);
                input.onStatus(
                    `${currentEncodingStage} (${windowIndex + 1}/${windowInputs.length})… ${percentage}%`,
                );
            },
        };
        const encoded = window && dependencies.encodeWindow
            ? await dependencies.encodeWindow(snapshot, window, encodingOptions)
            : await dependencies.encodeAudio(snapshot, encodingOptions);
        throwIfAborted(input.signal);

        let response: unknown;
        if (input.settings.requestMode === 'browser') {
            input.onStatus(`Sending audio window ${windowIndex + 1}/${windowInputs.length} from this browser…`);
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
            input.onStatus(`Sending audio window ${windowIndex + 1}/${windowInputs.length} through the Waptions server…`);
            response = await dependencies.requestThroughServer({
                settings: input.settings,
                audio: encoded.blob,
                filename: encoded.filename,
                signal: input.signal,
            });
        }
        throwIfAborted(input.signal);
        input.onStatus('Organizing speaker tracks…');
        const normalized = dependencies.normalize(
            response,
            encoded.durationSeconds,
            frameRateToNumber(snapshot.renderProfile.fps),
        );
        collectWindowSpeakers({
            target: collectedSpeakers,
            speakers: normalized,
            window,
            outputStartSample: encoded.outputStartSample ?? 0,
        });
    }
    const speakers = Array.from(collectedSpeakers.values());
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

function collectWindowSpeakers(input: {
    target: Map<string, NormalizedDiarizedSpeaker>;
    speakers: readonly NormalizedDiarizedSpeaker[];
    window: TimelineDiarizationCoverageWindow | null;
    outputStartSample: number;
}): void {
    const offsetSeconds = input.outputStartSample / 48_000;
    const assignedKeys = new Set<string>();
    const owns = (subtitle: { startTime: number; endTime: number }): boolean => {
        if (!input.window) return true;
        const midpointSample = input.outputStartSample
            + Math.round((subtitle.startTime + subtitle.endTime) / 2 * 48_000);
        return midpointSample >= input.window.core.startSample
            && midpointSample < input.window.core.endSample;
    };
    const project = (subtitle: { id: string; startTime: number; endTime: number; text: string }) => ({
        ...subtitle,
        startTime: subtitle.startTime + offsetSeconds,
        endTime: subtitle.endTime + offsetSeconds,
    });
    input.speakers.forEach((speaker) => {
        const projectedEvidence = speaker.transcription.raw.map(project);
        const candidates = new Set<string>();
        if (input.window) {
            input.target.forEach((existing, key) => {
                if (projectedEvidence.some(current => (
                    existing.transcription.raw.some(previous => sameOverlapWord(previous, current))
                ))) {
                    candidates.add(key);
                }
            });
        }
        if (candidates.size > 1) {
            throw new Error('Diarization overlap has irreconcilable speaker evidence.');
        }
        const speakerKey = candidates.values().next().value as string | undefined
            ?? (input.window
                ? `${input.window.decoded.startSample}:${speaker.sourceSpeakerLabel}`
                : speaker.sourceSpeakerLabel);
        if (assignedKeys.has(speakerKey)) {
            throw new Error('Diarization overlap maps multiple local speakers to one identity.');
        }
        assignedKeys.add(speakerKey);
        const retainedSubtitles = speaker.subtitles.filter(owns).map(project);
        const retainedRaw = speaker.transcription.raw.filter(owns).map(project);
        if (retainedSubtitles.length === 0 && retainedRaw.length === 0) return;
        const existing = input.target.get(speakerKey) ?? {
            sourceSpeakerLabel: input.window
                ? `${speaker.sourceSpeakerLabel}@${input.window.decoded.startSample}`
                : speaker.sourceSpeakerLabel,
            subtitles: [],
            transcription: { raw: [], groups: {}, containerIds: [] },
        };
        existing.subtitles.push(...retainedSubtitles);
        existing.transcription.raw.push(...retainedRaw);
        speaker.transcription.containerIds.forEach((containerId) => {
            const words = (speaker.transcription.groups[containerId] ?? [])
                .filter(owns)
                .map(project);
            if (words.length === 0) return;
            const projectedId = input.window
                ? `${input.window.decoded.startSample}:${containerId}`
                : containerId;
            existing.transcription.groups[projectedId] = words;
            existing.transcription.containerIds.push(projectedId);
        });
        input.target.set(speakerKey, existing);
    });
}

function sameOverlapWord(
    left: { startTime: number; endTime: number; text: string },
    right: { startTime: number; endTime: number; text: string },
): boolean {
    if (left.text.normalize('NFKC').trim().toLocaleLowerCase('und')
        !== right.text.normalize('NFKC').trim().toLocaleLowerCase('und')) {
        return false;
    }
    const overlap = Math.min(left.endTime, right.endTime) - Math.max(left.startTime, right.startTime);
    const shorter = Math.min(left.endTime - left.startTime, right.endTime - right.startTime);
    return overlap > 0 && overlap * 2 >= shorter;
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
    const responseBody = await readBoundedJsonResponse(response, { signal: input.signal });
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
