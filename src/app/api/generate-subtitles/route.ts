import { NextResponse } from 'next/server';
import { restRoute } from '@/lib/utils/api-route-wrapper';
import { GenerateSubtitlesAction } from '@/lib/actions/generate-subtitles.action';
import { parseOpenAICompatibleTranscriptionSettings } from '@/lib/ai/openai-compatible-transcription';

export const POST = restRoute(async (request, { actionContext }) => {
  const formData = await request.formData();
  const audioFile = formData.get('audio') as File;
  const model = (formData.get('model') as string) || 'whisper-1';
  const customOpenAITranscription = parseOpenAICompatibleTranscriptionSettings(
    formData.get('customOpenAITranscription')
  );

  const result = await GenerateSubtitlesAction.run({ audioFile, model, customOpenAITranscription }, actionContext);

  return NextResponse.json(result);
});
