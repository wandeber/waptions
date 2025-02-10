'use client';

import { useState, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import type { Subtitle } from './SubtitleTrack';

interface ExportButtonProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  subtitles: Subtitle[];
}

export function ExportButton({ videoRef, subtitles }: ExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [ffmpeg, setFFmpeg] = useState<FFmpeg | null>(null);

  // Inicializar FFmpeg solo en el cliente
  useEffect(() => {
    const loadFFmpeg = async () => {
      try {
        const ffmpegInstance = new FFmpeg();
        console.log('FFmpeg instancia creada');
        
        // Configurar el logger antes de cargar
        ffmpegInstance.on('log', ({ message }) => {
          console.log('FFmpeg Log:', message);
        });
        
        console.log('Iniciando carga de FFmpeg...');
        await ffmpegInstance.load({
          coreURL: '/ffmpeg-core.js',
          wasmURL: '/ffmpeg-core.wasm',
          workerURL: '/ffmpeg-core.worker.js'
        });
        
        console.log('FFmpeg cargado exitosamente');
        setFFmpeg(ffmpegInstance);
      } catch (error) {
        console.error('Error al cargar FFmpeg:', error);
        if (error instanceof Error) {
          console.error('Detalles del error:', {
            message: error.message,
            stack: error.stack,
            name: error.name
          });
        }
      }
    };

    if (typeof window !== 'undefined') {
      loadFFmpeg();
    }
  }, []);

  const handleExport = async () => {
    if (!videoRef.current || !ffmpeg) return;

    try {
      setIsExporting(true);
      const videoUrl = videoRef.current.src;
      const videoBlob = await fetch(videoUrl).then(r => r.blob());
      const videoArrayBuffer = await videoBlob.arrayBuffer();
      await ffmpeg.writeFile('input.mp4', new Uint8Array(videoArrayBuffer));

      const result1 = await ffmpeg.exec(['-i', 'input.mp4']);
      const output1 = result1.toString();
      console.log('FFmpeg output inicial:', output1);

      // Crear archivo de subtítulos SRT
      let srtContent = '';
      subtitles.forEach((subtitle, index) => {
        const startTime = new Date(subtitle.startTime * 1000).toISOString().substr(11, 12).replace('.', ',');
        const endTime = new Date(subtitle.endTime * 1000).toISOString().substr(11, 12).replace('.', ',');
        srtContent += `${index + 1}\n${startTime} --> ${endTime}\n${subtitle.text}\n\n`;
      });
      console.log('Contenido SRT generado:', srtContent);

      // Obtener el video original como ArrayBuffer
      console.log('Obteniendo video original...');
      const videoResponse = await fetch(videoUrl);
      const videoBuffer = await videoResponse.arrayBuffer();
      console.log('Video obtenido, tamaño:', videoBuffer.byteLength);

      // Escribir archivos en FFmpeg
      console.log('Escribiendo archivos en FFmpeg...');
      await ffmpeg.writeFile('subtitles.srt', srtContent);

      // Configurar el comando FFmpeg para mantener la calidad original
      const command = [
        '-i', 'input.mp4',
        '-i', 'subtitles.srt',
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-c:s', 'mov_text',
        '-metadata:s:s:0', 'language=spa',
        '-movflags', '+faststart',
        'output.mp4'
      ];

      console.log('Ejecutando FFmpeg con comando:', command.join(' '));
      const result2 = await ffmpeg.exec(command);
      const output2 = result2.toString();
      console.log('FFmpeg output final:', output2);

      // Leer el archivo resultante
      console.log('Leyendo archivo resultante...');
      const data = await ffmpeg.readFile('output.mp4');
      console.log('Archivo leído, tamaño:', data.length);
      
      // Crear y descargar el archivo
      console.log('Creando blob y descargando...');
      const blob = new Blob([data], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'video_con_subtitulos.mp4';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Limpiar archivos
      console.log('Limpiando archivos temporales...');
      await ffmpeg.deleteFile('input.mp4');
      await ffmpeg.deleteFile('subtitles.srt');
      await ffmpeg.deleteFile('output.mp4');

      console.log('Exportación completada con éxito');
    } catch (error) {
      console.error('Error durante la exportación:', error);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <button
      onClick={handleExport}
      disabled={!videoRef.current?.src || subtitles.length === 0 || isExporting}
      className={`px-3 py-1 rounded flex items-center gap-1 select-none
        ${videoRef.current?.src && subtitles.length > 0 && !isExporting
          ? 'bg-green-600 text-white hover:bg-green-700'
          : 'bg-gray-500 text-gray-400 cursor-not-allowed'
        }`}
      title={!videoRef.current?.src 
        ? "Necesitas cargar un video primero"
        : subtitles.length === 0 
          ? "Necesitas añadir subtítulos primero"
          : isExporting
            ? "Exportando..."
            : "Exportar video con subtítulos"
      }
    >
      {isExporting ? (
        <>
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span>Exportando...</span>
        </>
      ) : (
        <>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          <span>Exportar</span>
        </>
      )}
    </button>
  );
} 