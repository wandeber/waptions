import { transcribeWithOpenAICompatibleEndpoint } from "@/lib/ai/openai-compatible-transcription";
import type { Subtitle } from "@/types/timeline";
import type { OpenAICompatibleTranscriptionSettings } from "@/types/transcription";
import type { TrackTranscriptionState } from "@/types/video";

const DEFAULT_DIARIZATION_MODEL = "faster-whisper";
const AAC_FRAME_SAMPLE_COUNT = 1_024;
const DIARIZATION_AUDIO_SAMPLE_RATE = 48_000;
const MAX_DIARIZATION_SEGMENTS = 100_000;
const MAX_DIARIZATION_SPEAKERS = 128;
const MAX_DIARIZATION_SEGMENT_TEXT_CHARACTERS = 4_096;
const MAX_DIARIZATION_SPEAKER_LABEL_CHARACTERS = 256;

export interface OpenAICompatibleDiarizationRequest {
    settings: OpenAICompatibleTranscriptionSettings;
    audioFile: File | Blob;
    fallbackModel?: string;
    fetchImpl?: typeof fetch;
    signal: AbortSignal;
}

export interface NormalizedDiarizedSpeaker {
    sourceSpeakerLabel: string;
    subtitles: Subtitle[];
    transcription: TrackTranscriptionState;
}

interface OrderedSpeakerSegment {
    sourceIndex: number;
    sourceSpeakerLabel: string;
    startTime: number;
    endTime: number;
    text: string;
}

/**
 * Sends the one request shape supported by Waptions diarization. Both browser
 * mode and the server action call this wrapper, keeping multipart construction
 * centralized in the existing OpenAI-compatible transcription helper.
 */
export function transcribeDiarizedAudioWithOpenAICompatibleEndpoint({
    settings,
    audioFile,
    fallbackModel = DEFAULT_DIARIZATION_MODEL,
    fetchImpl,
    signal,
}: OpenAICompatibleDiarizationRequest): Promise<unknown> {
    return transcribeWithOpenAICompatibleEndpoint({
        settings,
        audioFile,
        fallbackModel,
        options: {
            response_format: "verbose_json",
            diarize: true,
            stream: false,
        },
        fetchImpl,
        signal,
    });
}

/**
 * Validates the lazy-whisper diarization extension without consulting its raw
 * turns, words, or top-level speaker list. The returned objects are detached
 * store inputs: this module deliberately has no timeline-store dependency.
 */
export function normalizeOpenAICompatibleDiarization(
    value: unknown,
    renderedDurationSeconds: number,
    projectFps: number,
): NormalizedDiarizedSpeaker[] {
    assertNormalizationBounds(renderedDurationSeconds, projectFps);

    if (!isRecord(value) || !isRecord(value.diarization) || !Array.isArray(value.diarization.speaker_segments)) {
        throw new Error("The transcriber returned an unsupported diarization response.");
    }

    const sourceSegments = value.diarization.speaker_segments;
    if (sourceSegments.length === 0) {
        return [];
    }
    if (sourceSegments.length > MAX_DIARIZATION_SEGMENTS) {
        throw new Error("The transcriber returned too many diarization segments.");
    }

    const timestampTolerance = Math.max(
        1 / projectFps,
        AAC_FRAME_SAMPLE_COUNT / DIARIZATION_AUDIO_SAMPLE_RATE,
    );
    const orderedSegments = sourceSegments.map((segment, sourceIndex) => normalizeSpeakerSegment(
        segment,
        sourceIndex,
        renderedDurationSeconds,
        timestampTolerance,
    ));

    // The explicit source index makes the ordering stable independently of the
    // JavaScript engine and preserves provider order for exact timing ties.
    orderedSegments.sort((left, right) => (
        left.startTime - right.startTime
        || left.endTime - right.endTime
        || left.sourceIndex - right.sourceIndex
    ));

    const speakersByLabel = new Map<string, NormalizedDiarizedSpeaker>();
    orderedSegments.forEach((segment) => {
        let speaker = speakersByLabel.get(segment.sourceSpeakerLabel);
        if (!speaker) {
            if (speakersByLabel.size >= MAX_DIARIZATION_SPEAKERS) {
                throw new Error("The transcriber returned too many speakers.");
            }
            speaker = {
                sourceSpeakerLabel: segment.sourceSpeakerLabel,
                subtitles: [],
                transcription: {
                    raw: [],
                    groups: {},
                    containerIds: [],
                },
            };
            speakersByLabel.set(segment.sourceSpeakerLabel, speaker);
        }

        const rawSubtitle: Subtitle = {
            id: crypto.randomUUID(),
            startTime: segment.startTime,
            endTime: segment.endTime,
            text: segment.text,
        };
        const containerId = crypto.randomUUID();
        const timelineSubtitle: Subtitle = {
            id: crypto.randomUUID(),
            startTime: segment.startTime,
            endTime: segment.endTime,
            text: segment.text,
        };

        speaker.transcription.raw.push(rawSubtitle);
        speaker.transcription.groups[containerId] = [rawSubtitle];
        speaker.transcription.containerIds.push(containerId);
        speaker.subtitles.push(timelineSubtitle);
    });

    return Array.from(speakersByLabel.values());
}

function normalizeSpeakerSegment(
    value: unknown,
    sourceIndex: number,
    renderedDurationSeconds: number,
    timestampTolerance: number,
): OrderedSpeakerSegment {
    if (!isRecord(value)) {
        throw invalidSegmentError(sourceIndex);
    }

    const sourceSpeakerLabel = typeof value.speaker === "string" ? value.speaker.trim() : "";
    const text = typeof value.text === "string" ? value.text.trim() : "";
    const start = getFiniteNumber(value.start);
    const end = getFiniteNumber(value.end);

    if (!sourceSpeakerLabel
        || sourceSpeakerLabel.length > MAX_DIARIZATION_SPEAKER_LABEL_CHARACTERS
        || !text
        || text.length > MAX_DIARIZATION_SEGMENT_TEXT_CHARACTERS
        || start === undefined
        || end === undefined
        || end <= start) {
        throw invalidSegmentError(sourceIndex);
    }

    if (
        start < -timestampTolerance
        || start > renderedDurationSeconds + timestampTolerance
        || end < -timestampTolerance
        || end > renderedDurationSeconds + timestampTolerance
    ) {
        throw new Error(`Diarization segment ${sourceIndex + 1} is outside the rendered audio duration.`);
    }

    const startTime = clamp(start, 0, renderedDurationSeconds);
    const endTime = clamp(end, 0, renderedDurationSeconds);
    if (endTime <= startTime) {
        throw invalidSegmentError(sourceIndex);
    }

    return {
        sourceIndex,
        sourceSpeakerLabel,
        startTime,
        endTime,
        text,
    };
}

function assertNormalizationBounds(renderedDurationSeconds: number, projectFps: number) {
    if (!Number.isFinite(renderedDurationSeconds) || renderedDurationSeconds < 0) {
        throw new Error("Rendered audio duration must be finite and non-negative.");
    }
    if (!Number.isFinite(projectFps) || projectFps <= 0) {
        throw new Error("Project FPS must be positive and finite.");
    }
}

function invalidSegmentError(sourceIndex: number): Error {
    return new Error(`Diarization segment ${sourceIndex + 1} is malformed.`);
}

function getFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
