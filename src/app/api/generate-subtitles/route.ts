import { NextResponse } from 'next/server';
import { restRoute } from '@/lib/utils/api-route-wrapper';
import { GenerateSubtitlesAction } from '@/lib/actions/generate-subtitles.action';

export const POST = restRoute(async (request, { actionContext }) => {
  const formData = await request.formData();
  const audioFile = formData.get('audio') as File;
  const model = (formData.get('model') as string) || 'whisper-1';

  const result = await GenerateSubtitlesAction.run({ audioFile, model }, actionContext);

  return NextResponse.json(result);
});