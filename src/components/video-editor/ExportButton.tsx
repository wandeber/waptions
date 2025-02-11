'use client';

import { useState, useEffect, useRef } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import type { Subtitle } from './SubtitleTrack';

interface ExportButtonProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  subtitles: Subtitle[];
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  animationStyle?: {
    fadeInDuration: number;
    fadeOutDuration: number;
    initialScale: number;
    bounceStrength: number;
    useElasticEffect: boolean;
    fontSize: number;
    textColor: string;
    strokeWidth: number;
    strokeColor: string;
    fontWeight: number;
    textCase: 'normal' | 'uppercase' | 'lowercase';
    hidePunctuation: boolean;
    punctuationChars: string;
    removeAccents: boolean;
  };
}

export function ExportButton({ videoRef, subtitles, canvasRef, animationStyle }: ExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [timeElapsed, setTimeElapsed] = useState(0);
  const [currentStep, setCurrentStep] = useState<string>('');
  const [ffmpeg, setFFmpeg] = useState<FFmpeg | null>(null);
  const startTimeRef = useRef<number>(0);
  const frameCountRef = useRef(0);
  const totalFramesRef = useRef(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Efecto para manejar el contador de tiempo
  useEffect(() => {
    if (isExporting) {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        const elapsedMs = Date.now() - startTimeRef.current;
        setTimeElapsed(elapsedMs / 1000);
      }, 100);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setTimeElapsed(0);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isExporting]);

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
      
      // Usar los FPS detectados del video
      const fps = Math.round(video.videoWidth > 1920 ? video.videoWidth > 3840 ? 24 : 30 : 60);
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

        // Renderizar subtítulos activos con animaciones
        const subtitlesToRender = subtitles.filter(subtitle => {
          const isActive = video.currentTime >= subtitle.startTime && video.currentTime < subtitle.endTime;
          const isExiting = video.currentTime >= subtitle.endTime - (animationStyle?.fadeOutDuration || 0.15) && 
                           video.currentTime < subtitle.endTime;
          return isActive || isExiting;
        });

        // Funciones de easing
        const easeOutBack = (x: number): number => {
          if (!animationStyle?.useElasticEffect) return x;
          const c1 = animationStyle?.bounceStrength || 1.70158;
          const c3 = c1 + 1;
          return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
        };

        const easeOutExpo = (x: number): number => {
          return x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
        };

        // Renderizar cada subtítulo
        subtitlesToRender.forEach(subtitle => {
          let opacity = 1;
          let scale = 1;
          
          // Fade in con escala
          if (video.currentTime >= subtitle.startTime && 
              video.currentTime < subtitle.startTime + (animationStyle?.fadeInDuration || 0.15)) {
            const progress = (video.currentTime - subtitle.startTime) / (animationStyle?.fadeInDuration || 0.15);
            opacity = easeOutExpo(progress);
            const scaleProgress = easeOutBack(progress);
            scale = 1 + (((animationStyle?.initialScale || 1.5) - 1) * (1 - scaleProgress));
          }
          // Fade out
          else if (video.currentTime >= subtitle.endTime - (animationStyle?.fadeOutDuration || 0.15) && 
                   video.currentTime < subtitle.endTime) {
            const progress = (subtitle.endTime - video.currentTime) / (animationStyle?.fadeOutDuration || 0.15);
            opacity = progress;
          }
          
          // Asegurar que la opacidad esté entre 0 y 1
          opacity = Math.max(0, Math.min(1, opacity));

          // Configurar estilo del texto
          const fontSize = (animationStyle?.fontSize || 48) * (canvas.height / 1080);
          ctx.font = `${animationStyle?.fontWeight || 700} ${fontSize}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillStyle = `${animationStyle?.textColor || '#ffffff'}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
          ctx.strokeStyle = `${animationStyle?.strokeColor || '#000000'}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
          ctx.lineWidth = fontSize * ((animationStyle?.strokeWidth || 4) / 48);

          // Aplicar la transformación de escala
          ctx.save();
          const x = canvas.width / 2;
          const y = canvas.height * 0.9;
          ctx.translate(x, y);
          ctx.scale(scale, scale);
          ctx.translate(-x, -y);

          // Procesar el texto según los estilos
          const processedText = (text: string) => {
            let result = text;
            if (animationStyle?.textCase === 'uppercase') {
              result = result.toUpperCase();
            } else if (animationStyle?.textCase === 'lowercase') {
              result = result.toLowerCase();
            }
            if (animationStyle?.hidePunctuation) {
              const regex = new RegExp(`[${(animationStyle?.punctuationChars || '').replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}]`, 'g');
              result = result.replace(regex, '');
            }
            if (animationStyle?.removeAccents) {
              result = result
                .replace(/[áàäâã]/g, 'a')
                .replace(/[éèëê]/g, 'e')
                .replace(/[íìïî]/g, 'i')
                .replace(/[óòöôõ]/g, 'o')
                .replace(/[úùüû]/g, 'u')
                .replace(/[ÁÀÄÂÃ]/g, 'A')
                .replace(/[ÉÈËÊ]/g, 'E')
                .replace(/[ÍÌÏÎ]/g, 'I')
                .replace(/[ÓÒÖÔÕ]/g, 'O')
                .replace(/[ÚÙÜÛ]/g, 'U');
            }
            return result;
          };

          ctx.strokeText(
            processedText(subtitle.text),
            x,
            y
          );
          ctx.fillText(
            processedText(subtitle.text),
            x,
            y
          );
          
          // Restaurar el contexto
          ctx.restore();
        });

        const blob = await new Promise<Blob>((resolve) => 
          canvas.toBlob(blob => resolve(blob!), 'image/jpeg', 0.8) // Reducido de 0.95 a 0.8
        );
        const frameData = await blob.arrayBuffer();

        const paddedIndex = String(frameCount).padStart(6, '0');
        const frameName = `frame_${paddedIndex}.jpg`;
        await ffmpeg.writeFile(frameName, new Uint8Array(frameData));

        frameCountRef.current++;
        setProgress((frameCountRef.current / totalFramesRef.current) * 50); // Primera mitad del progreso
        
        frameCount++;
      };

      while (video.currentTime < video.duration) {
        await captureFrame();
        video.currentTime += 1/fps;
      }

      setCurrentStep('Generando video final...');
      // Combinar frames en video intermedio con calidad reducida
      await ffmpeg.exec([
        '-framerate', fps.toString(),
        '-i', 'frame_%06d.jpg',
        '-c:v', 'libx264',
        '-preset', 'ultrafast', // Cambiado de veryfast a ultrafast
        '-crf', '28', // Aumentado de 23 a 28 (menor calidad)
        '-tune', 'zerolatency',
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