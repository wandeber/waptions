import { BaseAction, ActionContext } from "./base.action";
import { getAiProvider } from "@/lib/ai/ai-providers";
import { Subtitle } from "@/types/timeline";
import { ValidationError } from "@/lib/utils/errors";

interface GenerateSubtitlesInput {
    audioFile: File;
    model: string;
}

interface WhisperWord {
    word: string;
    start: number;
    end: number;
}

interface WhisperResponse {
    text: string;
    words: WhisperWord[];
}

interface DeepgramWord {
    word: string;
    start: number;
    end: number;
    punctuated_word?: string;
}

interface DeepgramResponse {
    results?: {
        channels?: Array<{
            alternatives?: Array<{
                words?: DeepgramWord[];
            }>;
        }>;
    };
}

export class GenerateSubtitlesAction extends BaseAction<GenerateSubtitlesInput, unknown> {
    protected async execute(input: GenerateSubtitlesInput, ctx: ActionContext): Promise<unknown> {
        // Avoid unused var lint
        void ctx;
        const { audioFile, model } = input;

        if (!audioFile) {
            throw new ValidationError("No audio file provided");
        }

        const whisperProvider = getAiProvider('openai');
        const gpt4oProvider = getAiProvider('openai');
        const o4miniProvider = getAiProvider('openai');

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

                // STEP 3: o3-mini for grouping and correction
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

                return premiumResult;
            }

            case 'deepgram-nova-2': {
                const deepgramProvider = getAiProvider('deepgram');
                const transcription = await deepgramProvider.transcribe('deepgram-nova-2', audioFile, {
                    language: 'es',
                    smart_format: true,
                    diarize: true
                }) as DeepgramResponse;

                const words = transcription.results?.channels?.[0]?.alternatives?.[0]?.words || [];

                if (words.length === 0) {
                    return { subtitles: [] };
                }

                const subtitles = words.map((word: DeepgramWord) => ({
                    id: crypto.randomUUID(),
                    startTime: word.start,
                    endTime: word.end,
                    text: word.punctuated_word || word.word
                }));

                return { subtitles };
            }

            case 'whisper-1': {
                const transcription = await whisperProvider.transcribe('whisper-1', audioFile, {
                    response_format: "verbose_json",
                    timestamp_granularities: ["word"],
                    prompt: `Usa puntuación correcta.`,
                    temperature: 0
                }) as WhisperResponse;

                if (!transcription.words) {
                    return { subtitles: [] };
                }

                const subtitles = transcription.words.map(word => ({
                    id: crypto.randomUUID(),
                    startTime: word.start,
                    endTime: word.end,
                    text: word.word.trim()
                }));

                return { subtitles };
            }

            default:
                throw new ValidationError(`Model ${model} not supported`);
        }
    }
}
