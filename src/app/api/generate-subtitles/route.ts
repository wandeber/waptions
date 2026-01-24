import { NextRequest, NextResponse } from 'next/server';
import { getAiProvider } from '@/lib/ai/ai-providers';
import { Subtitle } from '@/types/timeline';

const whisperProvider = getAiProvider('openai');
const gpt4oProvider = getAiProvider('openai');
const o4miniProvider = getAiProvider('openai');

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

interface WhisperResponse {
  text: string;
  words: WhisperWord[];
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const audioFile = formData.get('audio') as File;
    const model = formData.get('model') as string || 'whisper-1';

    if (!audioFile) {
      console.error('No se proporcionó archivo de audio');
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    console.log('Iniciando proceso de transcripción...', {
      model,
      audioFileSize: audioFile.size
    });

    switch (model) {
      case 'premium-whisper-gpt4o': {
        // STEP 1: Whisper for word-by-word timestamps
        const whisperRes = await whisperProvider.transcribe('whisper-1', audioFile, {
          response_format: "verbose_json",
          timestamp_granularities: ["word"],
          prompt: `Usa puntuación adecuada.`,
          temperature: 0
        }) as { words?: WhisperWord[] };

        const whisperWords = whisperRes.words || [];

        // STEP 2: GPT-4o for diarization
        const gpt4oRes = await gpt4oProvider.transcribe('gpt-4o-transcribe-diarize', audioFile, {
          response_format: "diarized_json",
          chunking_strategy: "auto"
        });

        // STEP 3: o4-mini for grouping and correction
        const groupingPrompt = `
          You are an expert subtitle editor. I will provide you with two transcriptions of the same audio:
          1. WHISPER: Word-by-word transcription with start/end timestamps.
          2. GPT-4O: Phrase-by-phrase transcription with speaker identification (A, B, etc.).

          Rules:
          - GPT-4O is more reliable for text content. Correct WHISPER text/omissions using GPT-4O context.
          - Use WHISPER for precise timing. Match GPT-4O words to WHISPER timestamps.
          - GROUP words into subtitles based on these criteria:
            - Never mix different speakers (A and B) in the same subtitle.
            - Max 20 characters per subtitle.
            - Optimal length is 3 words, absolute maximum is 4 words.
            - Break at natural linguistic points (end of sentences, clauses).
            - If there is a silence > 1s, start a new subtitle.
          
          Output Format: 
          Return a JSON object with:
          - "raw": The original whisper words as Subtitle objects.
          - "groups": An object where keys are group IDs and values are arrays of Subtitle objects (the words in each group).
          - "containerIds": An array of group IDs in chronological order.

          Input:
          WHISPER_WORDS: ${JSON.stringify(whisperWords)}
          GPT4O_DIARIZATION: ${JSON.stringify(gpt4oRes)}
        `;

        const { data: premiumResult } = await o4miniProvider.generate<{
          raw: Subtitle[],
          groups: Array<{ id: string; words: Subtitle[] }>
        }>('gpt-5.2', {
          messages: [{ role: 'user', content: groupingPrompt }],
          responseSchema: {
            type: "object",
            properties: {
              raw: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    startTime: { type: "number" },
                    endTime: { type: "number" },
                    text: { type: "string" }
                  },
                  required: ["id", "startTime", "endTime", "text"],
                  additionalProperties: false
                }
              },
              groups: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    words: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          startTime: { type: "number" },
                          endTime: { type: "number" },
                          text: { type: "string" }
                        },
                        required: ["id", "startTime", "endTime", "text"],
                        additionalProperties: false
                      }
                    }
                  },
                  required: ["id", "words"],
                  additionalProperties: false
                }
              }
            },
            required: ["raw", "groups"],
            additionalProperties: false
          }
        });

        return NextResponse.json(premiumResult);
      }

      case 'whisper-1':
      case 'deepgram-nova-2': { // Fallback to whisper for now as deepgram is not yet integrated in the new provider
        const transcription = await whisperProvider.transcribe('whisper-1', audioFile, {
          response_format: "verbose_json",
          timestamp_granularities: ["word"],
          prompt: `Usa puntuación correcta.`,
          temperature: 0
        }) as WhisperResponse;

        if (!transcription.words) {
          return NextResponse.json({ subtitles: [] });
        }

        const subtitles = transcription.words.map(word => ({
          id: crypto.randomUUID(),
          startTime: word.start,
          endTime: word.end,
          text: word.word.trim()
        }));

        return NextResponse.json({ subtitles });
      }

      default:
        return NextResponse.json({ error: `Model ${model} not supported` }, { status: 400 });
    }
  } catch (error) {
    console.error('Error detallado al generar subtítulos:', {
      error,
      message: error instanceof Error ? error.message : 'Error desconocido'
    });

    return NextResponse.json(
      { error: 'Error al generar subtítulos. Por favor, intenta de nuevo.' },
      { status: 500 }
    );
  }
}