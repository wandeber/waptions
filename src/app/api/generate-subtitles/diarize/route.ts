import { NextResponse } from "next/server";
import { GenerateDiarizedSubtitlesAction } from "@/lib/actions/generate-diarized-subtitles.action";
import { parseOpenAICompatibleTranscriptionSettings } from "@/lib/ai/openai-compatible-transcription";
import { restRoute } from "@/lib/utils/api-route-wrapper";
import {
    getTranscriptionAdmissionKey,
    readBoundedMultipartFormData,
    sharedTranscriptionAdmissionGate,
    TRANSCRIPTION_REQUEST_MAX_BYTES,
    TranscriptionAdmissionError,
    TranscriptionPayloadTooLargeError,
} from "@/lib/ai/transcription-http-policy";
import { ValidationError } from "@/lib/utils/errors";

const ALLOWED_FIELDS = new Set(["audio", "customOpenAITranscription"]);
const route = restRoute(async (request, { actionContext }) => {
    let formData: FormData;
    try {
        formData = await readBoundedMultipartFormData(request);
    } catch (error) {
        if (error instanceof TranscriptionPayloadTooLargeError) {
            return NextResponse.json({ error: "Transcription upload is too large." }, { status: 413 });
        }
        throw new ValidationError("Invalid transcription multipart request.");
    }
    validateFields(formData);
    const audioEntry = formData.get("audio");
    const audioFile = audioEntry instanceof File ? audioEntry : null;
    if (!audioFile || audioFile.size === 0) {
        throw new ValidationError("A non-empty mixed audio file is required.");
    }
    if (audioFile.size > TRANSCRIPTION_REQUEST_MAX_BYTES) {
        throw new TranscriptionPayloadTooLargeError("request");
    }
    const settingsEntry = formData.get("customOpenAITranscription");
    if (typeof settingsEntry === "string" && settingsEntry.length > 32_768) {
        throw new ValidationError("Custom transcription settings are too large.");
    }
    const customOpenAITranscription = parseOpenAICompatibleTranscriptionSettings(
        settingsEntry,
    );

    // The request signal is intentionally forwarded through the action and the
    // outbound fetch so disconnecting the editor cancels Waptions' proxy work.
    const result = await GenerateDiarizedSubtitlesAction.run({
        audioFile,
        customOpenAITranscription,
        signal: request.signal,
    }, actionContext);

    return NextResponse.json(result);
});

export const POST = async (...args: Parameters<typeof route>): Promise<Response> => {
    const [request] = args;
    let release: (() => void) | null = null;
    try {
        release = sharedTranscriptionAdmissionGate.acquire(getTranscriptionAdmissionKey(request));
        return await route(...args);
    } catch (error) {
        if (error instanceof TranscriptionAdmissionError) {
            return NextResponse.json({ error: "Transcription is busy." }, {
                status: 429,
                headers: { "retry-after": "60" },
            });
        }
        if (error instanceof TranscriptionPayloadTooLargeError) {
            return NextResponse.json({ error: "Transcription upload is too large." }, { status: 413 });
        }
        throw error;
    } finally {
        release?.();
    }
};

function validateFields(formData: FormData): void {
    const counts = new Map<string, number>();
    formData.forEach((_value, key) => {
        if (!ALLOWED_FIELDS.has(key)) throw new ValidationError("Unsupported transcription field.");
        counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    if (Array.from(counts.values()).some(count => count !== 1)) {
        throw new ValidationError("Transcription fields must be unique.");
    }
}
