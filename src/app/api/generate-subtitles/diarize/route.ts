import { NextResponse } from "next/server";
import { GenerateDiarizedSubtitlesAction } from "@/lib/actions/generate-diarized-subtitles.action";
import { parseOpenAICompatibleTranscriptionSettings } from "@/lib/ai/openai-compatible-transcription";
import { restRoute } from "@/lib/utils/api-route-wrapper";

export const POST = restRoute(async (request, { actionContext }) => {
    const formData = await request.formData();
    const audioEntry = formData.get("audio");
    const audioFile = audioEntry instanceof File ? audioEntry : null;
    const customOpenAITranscription = parseOpenAICompatibleTranscriptionSettings(
        formData.get("customOpenAITranscription"),
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
