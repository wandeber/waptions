import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

interface WhisperResponse {
  segments: WhisperSegment[];
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const audioFile = formData.get('audio') as File;
    
    if (!audioFile) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    // Transcribir con Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"]
    }) as unknown as WhisperResponse;

    // Convertir la transcripción a formato de subtítulos
    const subtitles = transcription.segments.map((segment: WhisperSegment) => ({
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      startTime: segment.start,
      endTime: segment.end,
      text: segment.text.trim()
    }));

    return NextResponse.json({ subtitles });
  } catch (error) {
    console.error('Error generating subtitles:', error);
    return NextResponse.json(
      { error: 'Error generating subtitles' },
      { status: 500 }
    );
  }
} 