'use client';

import { useState, useEffect, useRef } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import type { Subtitle } from './SubtitleTrack';

interface ExportButtonProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  subtitles: Subtitle[];
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
}

export function ExportButton({ videoRef, subtitles, canvasRef }: ExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [timeElapsed, setTimeElapsed] = useState(0);
  const [currentStep, setCurrentStep] = useState<string>('');
  const [ffmpeg, setFFmpeg] = useState<FFmpeg | null>(null);
  const startTimeRef = useRef<number>(0);
  const frameCountRef = useRef(0);
  const totalFramesRef = useRef(0);

  // Inicializar FFmpeg solo en el cliente
  useEffect(() => {
    const loadFFmpeg = async () => {
      try {
        const ffmpegInstance = new FFmpeg();
        console.log('FFmpeg instancia creada');
        
        // Configurar el logger antes de cargar
        ffmpegInstance.on('log', ({ message }) => {
          console.log('FFmpeg Log:', message);
          // Extraer el progreso de la codificación
          const frameMatch = message.match(/frame=\s*(\d+)/);
          const timeMatch = message.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
          
          if (frameMatch && timeMatch) {
            const currentFrame = parseInt(frameMatch[1]);
            const hours = parseInt(timeMatch[1]);
            const minutes = parseInt(timeMatch[2]);
            const seconds = parseInt(timeMatch[3]);
            const centiseconds = parseInt(timeMatch[4]);
            
            const totalSeconds = hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
            if (videoRef.current) {
              const progress = (totalSeconds / videoRef.current.duration) * 100;
              setProgress(Math.min(progress, 100));
            }
          }
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
  }, [videoRef]);

  const handleExport = async () => {
    if (!videoRef.current || !ffmpeg || !canvasRef?.current) return;

    try {
      setIsExporting(true);
      setProgress(0);
      startTimeRef.current = Date.now();
      frameCountRef.current = 0;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      
      // Usar el FPS del video o 30 como fallback
      const fps = Math.round(video.videoWidth > 1920 ? 30 : 60); // Reducir FPS para videos 4K
      totalFramesRef.current = Math.ceil(video.duration * fps);

      setCurrentStep('Preparando video...');
      const videoUrl = video.src;
      const videoBlob = await fetch(videoUrl).then(r => r.blob());
      const videoArrayBuffer = await videoBlob.arrayBuffer();
      await ffmpeg.writeFile('input.mp4', new Uint8Array(videoArrayBuffer));

      // Extraer el audio primero
      setCurrentStep('Extrayendo audio...');
      await ffmpeg.exec([
        '-i', 'input.mp4',
        '-vn', '-acodec', 'copy',
        'audio.mp4'
      ]);

      // Capturar frames con subtítulos
      setCurrentStep('Capturando frames...');
      video.currentTime = 0;
      let frameCount = 0;

      const captureFrame = async () => {
        await new Promise<void>((resolve) => {
          const handler = () => {
            video.removeEventListener('seeked', handler);
            resolve();
          };
          video.addEventListener('seeked', handler);
        });

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Dibujar el frame del video
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Renderizar subtítulos activos
        const activeSubtitles = subtitles.filter(
          subtitle => video.currentTime >= subtitle.startTime && video.currentTime <= subtitle.endTime
        );

        activeSubtitles.forEach(subtitle => {
          const fontSize = Math.max(16, canvas.height * 0.05);
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillStyle = 'white';
          ctx.strokeStyle = 'black';
          ctx.lineWidth = fontSize * 0.1;

          const x = canvas.width / 2;
          const y = canvas.height * 0.9;
          ctx.strokeText(subtitle.text, x, y);
          ctx.fillText(subtitle.text, x, y);
        });

        const blob = await new Promise<Blob>((resolve) => 
          canvas.toBlob(blob => resolve(blob!), 'image/jpeg', 0.95)
        );
        const frameData = await blob.arrayBuffer();

        const paddedIndex = String(frameCount).padStart(6, '0');
        const frameName = `frame_${paddedIndex}.jpg`;
        await ffmpeg.writeFile(frameName, new Uint8Array(frameData));

        frameCountRef.current++;
        setProgress((frameCountRef.current / totalFramesRef.current) * 50); // Primera mitad del progreso
        
        const elapsedMs = Date.now() - startTimeRef.current;
        setTimeElapsed(elapsedMs / 1000);

        frameCount++;
      };

      while (video.currentTime < video.duration) {
        await captureFrame();
        video.currentTime += 1/fps;
      }

      setCurrentStep('Generando video final...');
      // Combinar frames en video intermedio
      await ffmpeg.exec([
        '-framerate', fps.toString(),
        '-i', 'frame_%06d.jpg',
        '-c:v', 'libx264',
        '-preset', 'veryfast', // Usar preset más rápido
        '-crf', '23', // Calidad ligeramente menor pero más rápido
        '-tune', 'zerolatency', // Optimizar para velocidad
        '-movflags', '+faststart',
        'temp.mp4'
      ]);

      // Combinar con el audio original
      setCurrentStep('Combinando audio...');
      await ffmpeg.exec([
        '-i', 'temp.mp4',
        '-i', 'audio.mp4',
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-shortest',
        'output.mp4'
      ]);

      setCurrentStep('Finalizando...');
      const data = await ffmpeg.readFile('output.mp4');
      
      const blob = new Blob([data], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'video_con_subtitulos.mp4';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Limpiar archivos temporales
      for (let i = 0; i < frameCount; i++) {
        const paddedIndex = String(i).padStart(6, '0');
        await ffmpeg.deleteFile(`frame_${paddedIndex}.jpg`);
      }
      await ffmpeg.deleteFile('temp.mp4');
      await ffmpeg.deleteFile('audio.mp4');
      await ffmpeg.deleteFile('input.mp4');
      await ffmpeg.deleteFile('output.mp4');

      console.log('Exportación completada con éxito');
    } catch (error) {
      console.error('Error durante la exportación:', error);
    } finally {
      setIsExporting(false);
      setProgress(0);
      setTimeElapsed(0);
      setCurrentStep('');
    }
  };

  return (
    <div className="flex items-center gap-2">
      {isExporting && (
        <div className="flex items-center gap-2">
          <div className="flex flex-col gap-1">
            <div className="w-32 h-2 bg-gray-700 rounded-full overflow-hidden">
              <div 
                className="h-full bg-green-500 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="text-xs text-gray-400">{currentStep}</div>
          </div>
          <span className="text-sm text-gray-300">
            {Math.round(progress)}% - {Math.round(timeElapsed)}s
          </span>
        </div>
      )}
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
    </div>
  );
} 