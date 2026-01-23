

import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

    console.log('Iniciando transcripción...', {
      model,
      audioFileSize: audioFile.size,
      audioFileType: audioFile.type
    });

    let transcription: WhisperResponse;

    switch (model) {
      case 'whisper-1':
        transcription = await openai.audio.transcriptions.create({
          file: audioFile,
          model: "whisper-1",
          response_format: "verbose_json",
          timestamp_granularities: ["word"], // Only words needed now
          prompt: `Usa puntuación correcta.`, // Simplified prompt
          temperature: 0
        }) as unknown as WhisperResponse;
        break;

      case 'deepgram-nova-2':
        transcription = await openai.audio.transcriptions.create({
          file: audioFile,
          model: "whisper-1",
          response_format: "verbose_json",
          timestamp_granularities: ["word"],
          prompt: `Usa puntuación correcta.`,
          temperature: 0
        }) as unknown as WhisperResponse;
        break;

      default:
        return NextResponse.json({ error: `Model ${model} not supported` }, { status: 400 });
    }

    console.log('Transcripción completada', {
      model,
      wordCount: transcription.words?.length || 0
    });

    if (!transcription.words) {
      return NextResponse.json({ subtitles: [] });
    }

    // Convert words directly to subtitles (1 word = 1 subtitle)
    const subtitles = transcription.words.map(word => ({
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      startTime: word.start,
      endTime: word.end,
      text: word.word.trim()
    }));

    return NextResponse.json({ subtitles });
  } catch (error) {
    console.error('Error detallado al generar subtítulos:', {
      error,
      message: error instanceof Error ? error.message : 'Error desconocido',
      stack: error instanceof Error ? error.stack : undefined
    });

    // Si es un error de OpenAI, devolver un mensaje más específico
    if (error instanceof Error && error.message.includes('OpenAI')) {
      return NextResponse.json(
        { error: 'Error al comunicarse con OpenAI. Por favor, verifica tu API key.' },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: 'Error al generar subtítulos. Por favor, intenta de nuevo.' },
      { status: 500 }
    );
  }
}