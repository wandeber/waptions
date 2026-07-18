import { BaseAction, type ActionContext } from "@/lib/actions/base.action";
import { transcribeDiarizedAudioWithOpenAICompatibleEndpoint } from "@/lib/ai/openai-compatible-diarization";
import { assertServerTranscriptionEndpointAllowed } from "@/lib/ai/openai-compatible-transcription-server";
import { ValidationError } from "@/lib/utils/errors";
import type { OpenAICompatibleTranscriptionSettings } from "@/types/transcription";

interface GenerateDiarizedSubtitlesInput {
    audioFile: File | null;
    customOpenAITranscription: OpenAICompatibleTranscriptionSettings | null;
    signal: AbortSignal;
}

export class GenerateDiarizedSubtitlesAction extends BaseAction<GenerateDiarizedSubtitlesInput, unknown> {
    protected async execute(input: GenerateDiarizedSubtitlesInput, ctx: ActionContext): Promise<unknown> {
        void ctx;

        if (!input.audioFile) {
            throw new ValidationError("No mixed audio file provided.");
        }

        const settings = input.customOpenAITranscription;
        if (!settings?.enabled) {
            throw new ValidationError("Configure a custom OpenAI-compatible transcriber.");
        }
        if (settings.requestMode === "browser") {
            throw new ValidationError("Browser-mode diarization must be sent directly from the browser.");
        }

        // This validation must precede the only outbound request. It preserves
        // the existing server-mode SSRF boundary for the new dedicated proxy.
        assertServerTranscriptionEndpointAllowed(settings.endpoint);

        return transcribeDiarizedAudioWithOpenAICompatibleEndpoint({
            settings,
            audioFile: input.audioFile,
            signal: input.signal,
        });
    }
}
