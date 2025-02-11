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

const MAX_CHARS_PER_LINE = 15; // Reducido a 15 caracteres para mejor legibilidad
const MIN_SEGMENT_DURATION = 0.2; // Duración mínima de cada segmento en segundos
const GAP_BETWEEN_SEGMENTS = 0.05; // Pequeño gap entre segmentos

// Función para ajustar los tiempos y evitar superposiciones
function adjustTimings(segments: WhisperSegment[]): WhisperSegment[] {
  return segments.map((segment, index) => {
    const duration = segment.end - segment.start;
    
    // Asegurar duración mínima
    if (duration < MIN_SEGMENT_DURATION) {
      segment.end = segment.start + MIN_SEGMENT_DURATION;
    }

    // Ajustar superposición con el siguiente segmento
    if (index < segments.length - 1) {
      const nextSegment = segments[index + 1];
      if (segment.end + GAP_BETWEEN_SEGMENTS > nextSegment.start) {
        nextSegment.start = segment.end + GAP_BETWEEN_SEGMENTS;
        // Mantener la duración del siguiente segmento
        const nextDuration = nextSegment.end - nextSegment.start;
        if (nextDuration < MIN_SEGMENT_DURATION) {
          nextSegment.end = nextSegment.start + MIN_SEGMENT_DURATION;
        }
      }
    }

    return segment;
  });
}

// Función para dividir un segmento en partes más pequeñas
function splitSegment(segment: WhisperSegment): WhisperSegment[] {
  const words = segment.text.trim().split(/\s+/);
  
  // Si el segmento es corto, lo devolvemos tal cual
  if (segment.text.length <= MAX_CHARS_PER_LINE) {
    return [segment];
  }

  const segments: WhisperSegment[] = [];
  const totalDuration = segment.end - segment.start;
  let currentPosition = 0;
  let currentWords: string[] = [];
  let currentLength = 0;
  const fullText = segment.text.trim();

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const wordWithSpace = (currentWords.length > 0 ? ' ' : '') + word;
    const newLength = currentLength + wordWithSpace.length;

    // Decidir si crear un nuevo segmento basado en:
    // 1. La palabra es muy larga (más de la mitad del máximo permitido)
    // 2. Añadir la palabra excedería el máximo de caracteres
    // 3. Es la última palabra
    const isLongWord = word.length > MAX_CHARS_PER_LINE / 2;
    const wouldExceedLimit = newLength > MAX_CHARS_PER_LINE;
    const isLastWord = i === words.length - 1;

    if (isLongWord && currentWords.length > 0) {
      // Guardar las palabras acumuladas antes de la palabra larga
      const phrase = currentWords.join(' ');
      const wordStart = fullText.indexOf(phrase, currentPosition);
      const wordEnd = wordStart + phrase.length;
      segments.push({
        start: segment.start + (wordStart / fullText.length * totalDuration),
        end: segment.start + (wordEnd / fullText.length * totalDuration),
        text: phrase
      });
      currentPosition = wordEnd;
      currentWords = [];
      currentLength = 0;

      // Crear segmento para la palabra larga
      const longWordStart = fullText.indexOf(word, currentPosition);
      const longWordEnd = longWordStart + word.length;
      segments.push({
        start: segment.start + (longWordStart / fullText.length * totalDuration),
        end: segment.start + (longWordEnd / fullText.length * totalDuration),
        text: word
      });
      currentPosition = longWordEnd;
    } else if (wouldExceedLimit || isLastWord) {
      if (!isLastWord || wouldExceedLimit) {
        // Si no es la última palabra o excedería el límite, crear segmento con las palabras actuales
        if (currentWords.length > 0) {
          const phrase = currentWords.join(' ');
          const wordStart = fullText.indexOf(phrase, currentPosition);
          const wordEnd = wordStart + phrase.length;
          segments.push({
            start: segment.start + (wordStart / fullText.length * totalDuration),
            end: segment.start + (wordEnd / fullText.length * totalDuration),
            text: phrase
          });
          currentPosition = wordEnd;
          currentWords = [word];
          currentLength = word.length;
        }
      }
      
      if (isLastWord) {
        // Añadir la última palabra o frase
        currentWords.push(word);
        const phrase = currentWords.join(' ');
        const wordStart = fullText.indexOf(phrase, currentPosition);
        const wordEnd = wordStart + phrase.length;
        segments.push({
          start: segment.start + (wordStart / fullText.length * totalDuration),
          end: segment.end,
          text: phrase
        });
      }
    } else {
      currentWords.push(word);
      currentLength = newLength;
    }
  }

  return adjustTimings(segments);
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const audioFile = formData.get('audio') as File;
    
    if (!audioFile) {
      console.error('No se proporcionó archivo de audio');
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    console.log('Iniciando transcripción con Whisper...', {
      audioFileSize: audioFile.size,
      audioFileType: audioFile.type
    });

    // Transcribir con Whisper con configuración más precisa
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment", "word"],
      prompt: `Divide el texto en segmentos cortos y naturales, preferiblemente 2 o 3 palabras dependiendo de la longitud. Usa signos de puntuación. Puntos suspensivos, interrogación, comas, etc. No omitas palabras al inicio.`,
      temperature: 0 // Máxima precisión
    }) as unknown as WhisperResponse;

    console.log('Transcripción completada', {
      segmentCount: transcription.segments.length
    });

    // Dividir los segmentos en partes más pequeñas y convertir a formato de subtítulos
    const subtitles = transcription.segments
      .flatMap(segment => splitSegment(segment))
      .map(subSegment => ({
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        startTime: subSegment.start,
        endTime: subSegment.end,
        text: subSegment.text.trim()
      }));

    console.log('Subtítulos generados', {
      subtitleCount: subtitles.length
    });

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