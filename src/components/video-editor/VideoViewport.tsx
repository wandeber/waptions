'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

interface VideoViewportProps {
  onVideoLoad?: (duration: number, fps: number) => void;
  onTimeUpdate?: (currentTime: number) => void;
  currentTime?: number;
  videoRef?: React.RefObject<HTMLVideoElement>;
  isPlaying?: boolean;
  onPlayPause?: () => void;
  fps?: number;
  onFpsChange?: (fps: number) => void;
  subtitles?: Array<{
    id: string;
    startTime: number;
    endTime: number;
    text: string;
  }>;
}

export function VideoViewport({ 
  onVideoLoad, 
  onTimeUpdate, 
  currentTime = 0,
  videoRef: externalVideoRef,
  isPlaying,
  onPlayPause,
  fps,
  onFpsChange,
  subtitles = []
}: VideoViewportProps) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [ffmpeg, setFFmpeg] = useState<FFmpeg | null>(null);
  const [isFFmpegLoaded, setIsFFmpegLoaded] = useState(false);
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = externalVideoRef || internalVideoRef;
  const timelineRef = useRef<number>();
  const [detectedFps, setDetectedFps] = useState<number | null>(null);
  const [isVideoLoaded, setIsVideoLoaded] = useState(false);

  // Inicializar FFmpeg solo en el cliente
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setFFmpeg(new FFmpeg());
    }
  }, []);

  // Cargar FFmpeg
  useEffect(() => {
    if (!ffmpeg) return;

    const loadFFmpeg = async () => {
      try {
        // Cargar FFmpeg con las rutas correctas
        await ffmpeg.load({
          coreURL: '/ffmpeg-core.js',
          wasmURL: '/ffmpeg-core.wasm',
        });
        setIsFFmpegLoaded(true);
      } catch (error) {
        console.error('Error al cargar FFmpeg:', error);
      }
    };
    loadFFmpeg();
  }, [ffmpeg]);

  const detectVideoFps = async (file: File): Promise<number> => {
    if (!isFFmpegLoaded || !ffmpeg) {
      console.warn('FFmpeg no está cargado, usando valor por defecto');
      return 30;
    }

    try {
      // Convertir el archivo a ArrayBuffer
      const buffer = await file.arrayBuffer();
      
      // Escribir el archivo al sistema de archivos virtual de FFmpeg
      await ffmpeg.writeFile('input.mp4', new Uint8Array(buffer));
      
      // Ejecutar FFprobe para obtener información del video
      const { stderr } = await ffmpeg.exec(['-i', 'input.mp4']);
      console.log('FFmpeg stderr:', stderr);
      
      // Buscar los FPS en la salida
      const fpsMatch = stderr.match(/(\d+(?:\.\d+)?) fps/);
      const detectedFps = fpsMatch ? Math.round(parseFloat(fpsMatch[1])) : 30;
      
      // Limpiar el archivo
      await ffmpeg.deleteFile('input.mp4');
      
      return detectedFps > 0 ? detectedFps : 30;
    } catch (error) {
      console.error('Error al detectar FPS con FFmpeg:', error);
      return 30;
    }
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setVideoUrl(url);
      
      // Detectar FPS usando FFmpeg
      const detectedFps = await detectVideoFps(file);
      setDetectedFps(detectedFps);
      
      if (videoRef.current) {
        videoRef.current.load(); // Forzar la recarga del video
        videoRef.current.onloadedmetadata = () => {
          console.log('Video metadata loaded. Duration:', videoRef.current?.duration);
          onVideoLoad?.(videoRef.current!.duration, detectedFps);
        };
      }
    }
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file?.type.startsWith('video/')) {
      const url = URL.createObjectURL(file);
      setVideoUrl(url);
      
      // Detectar FPS usando FFmpeg
      const detectedFps = await detectVideoFps(file);
      setDetectedFps(detectedFps);
      
      if (videoRef.current) {
        videoRef.current.onloadedmetadata = () => {
          onVideoLoad?.(videoRef.current!.duration, detectedFps);
        };
      }
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
  };

  const handleFpsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newFps = parseInt(e.target.value, 10);
    if (!isNaN(newFps) && newFps > 0) {
      onFpsChange?.(newFps);
    }
  };

  // Función para actualizar el tiempo usando requestAnimationFrame
  const updateTime = useCallback(() => {
    if (videoRef.current && onTimeUpdate) {
      onTimeUpdate(videoRef.current.currentTime);
    }
    if (isPlaying) {
      timelineRef.current = requestAnimationFrame(updateTime);
    }
  }, [isPlaying, onTimeUpdate]);

  // Efecto para manejar la actualización del tiempo
  useEffect(() => {
    if (isPlaying) {
      timelineRef.current = requestAnimationFrame(updateTime);
    } else if (timelineRef.current) {
      cancelAnimationFrame(timelineRef.current);
    }

    return () => {
      if (timelineRef.current) {
        cancelAnimationFrame(timelineRef.current);
      }
    };
  }, [isPlaying, updateTime]);

  // Efecto para sincronizar el tiempo del video
  useEffect(() => {
    if (!videoRef.current) return;

    const video = videoRef.current;
    if (Math.abs(video.currentTime - currentTime) > 0.01) {
      if (video.seekable.length > 0) {
        const seekableEnd = video.seekable.end(video.seekable.length - 1);
        if (currentTime <= seekableEnd) {
          video.currentTime = currentTime;
        } else {
          console.log(`No se puede buscar más allá de ${seekableEnd}s`);
        }
      } else {
        console.log('El video no es buscable todavía');
      }
    }
  }, [currentTime]);

  // Manejar el estado de reproducción
  useEffect(() => {
    if (!videoRef.current) return;

    if (isPlaying) {
      const playPromise = videoRef.current.play();
      if (playPromise) {
        playPromise.catch(error => {
          console.error('Error al reproducir el video:', error);
        });
      }
    } else {
      videoRef.current.pause();
    }
  }, [isPlaying]);

  // Limpiar URL al desmontar
  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

  useEffect(() => {
    if (!videoRef.current || !videoUrl) return;

    const video = videoRef.current;

    const handleProgress = () => {
      if (video.buffered.length > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        console.log('Video buffered until:', bufferedEnd);
      }
    };

    video.addEventListener('progress', handleProgress);
    return () => video.removeEventListener('progress', handleProgress);
  }, [videoUrl]);

  // Encontrar los subtítulos activos para el tiempo actual
  const activeSubtitles = subtitles.filter(
    subtitle => currentTime >= subtitle.startTime && currentTime <= subtitle.endTime
  );

  return (
    <div
      className="flex-1 bg-black rounded-lg flex items-center justify-center relative min-h-0"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onClick={() => !videoUrl && fileInputRef.current?.click()}
    >
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="video/*"
        onChange={handleFileSelect}
      />
      
      {videoUrl ? (
        <div className="w-full h-full relative">
          <div className="w-full h-full flex items-center justify-center">
            <video
              ref={videoRef}
              src={videoUrl}
              className="w-full h-full object-contain"
              onTimeUpdate={updateTime}
              onLoadedMetadata={() => {
                if (videoRef.current) {
                  console.log('Metadata loaded. Duration:', videoRef.current.duration);
                  console.log('Seekable ranges:', Array.from({length: videoRef.current.seekable.length}, (_, i) => ({
                    start: videoRef.current!.seekable.start(i),
                    end: videoRef.current!.seekable.end(i)
                  })));
                  onVideoLoad?.(videoRef.current.duration, detectedFps || 30);
                }
              }}
              onCanPlayThrough={() => {
                if (videoRef.current) {
                  console.log('Video can play through completely. Duration:', videoRef.current.duration);
                  console.log('Seekable ranges:', Array.from({length: videoRef.current.seekable.length}, (_, i) => ({
                    start: videoRef.current!.seekable.start(i),
                    end: videoRef.current!.seekable.end(i)
                  })));
                }
                setIsVideoLoaded(true);
              }}
              onProgress={() => {
                if (videoRef.current) {
                  const buffered = videoRef.current.buffered;
                  if (buffered.length > 0) {
                    console.log('Buffered until:', buffered.end(buffered.length - 1));
                  }
                }
              }}
              preload="auto"
              playsInline
            />
          </div>

          {/* Overlay para los subtítulos */}
          <div className="absolute bottom-8 left-0 right-0 flex flex-col items-center">
            {activeSubtitles.map(subtitle => (
              <div
                key={subtitle.id}
                className="bg-black/75 text-white px-4 py-2 rounded-lg mb-2 text-center max-w-[80%]"
              >
                {subtitle.text}
              </div>
            ))}
          </div>

          {detectedFps && (
            <div className="absolute bottom-2 right-2 flex items-center gap-2 bg-black/50 p-2 rounded">
              <span className="text-xs text-gray-300">FPS:</span>
              <input
                type="number"
                min="1"
                value={fps || detectedFps}
                onChange={handleFpsChange}
                className="w-16 px-1 py-0.5 bg-gray-800 border border-gray-600 rounded text-xs text-white"
              />
            </div>
          )}
        </div>
      ) : (
        <div className="text-gray-500 cursor-pointer p-8 text-center">
          Arrastra y suelta un video o haz clic para seleccionar
        </div>
      )}
    </div>
  );
} 