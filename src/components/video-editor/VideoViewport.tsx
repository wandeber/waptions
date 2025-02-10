'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';

interface VideoViewportProps {
  onVideoLoad?: (duration: number, fps: number) => void;
  onTimeUpdate?: (currentTime: number) => void;
  currentTime?: number;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  isPlaying?: boolean;
  fps?: number | null;
  onFpsChange?: (fps: number) => void;
  subtitles?: Array<{
    id: string;
    startTime: number;
    endTime: number;
    text: string;
  }>;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  onEnded?: () => void;
  showThirdsGuide?: boolean;
  showMetaInfo?: boolean;
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

export function VideoViewport({ 
  onVideoLoad, 
  onTimeUpdate, 
  currentTime = 0,
  videoRef: externalVideoRef,
  isPlaying,
  fps,
  onFpsChange,
  subtitles = [],
  canvasRef: externalCanvasRef,
  onEnded,
  showThirdsGuide = false,
  showMetaInfo = false,
  animationStyle = {
    fadeInDuration: 0.15,
    fadeOutDuration: 0.15,
    initialScale: 1.5,
    bounceStrength: 1.70158,
    useElasticEffect: true,
    fontSize: 48,
    textColor: '#ffffff',
    strokeWidth: 4,
    strokeColor: '#000000',
    fontWeight: 700,
    textCase: 'normal',
    hidePunctuation: false,
    punctuationChars: '',
    removeAccents: false
  }
}: VideoViewportProps) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [ffmpeg, setFFmpeg] = useState<FFmpeg | null>(null);
  const [isFFmpegLoaded, setIsFFmpegLoaded] = useState(false);
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const internalCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = externalVideoRef || internalVideoRef;
  const canvasRef = externalCanvasRef || internalCanvasRef;
  const timelineRef = useRef<number | undefined>(undefined);
  const [detectedFps, setDetectedFps] = useState<number | null>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);

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
        setIsFFmpegLoaded(true);
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

  const detectVideoMetadata = async (file: File): Promise<{ fps: number; width: number; height: number }> => {
    if (!isFFmpegLoaded || !ffmpeg) {
      console.warn('FFmpeg no está cargado, usando valores por defecto');
      return { fps: 30, width: 1920, height: 1080 };
    }

    try {
      const buffer = await file.arrayBuffer();
      await ffmpeg.writeFile('input.mp4', new Uint8Array(buffer));
      
      const result = await ffmpeg.exec(['-i', 'input.mp4']);
      const stderr = result.toString();
      console.log('FFmpeg stderr completo:', stderr);
      
      // Buscar FPS
      const fpsMatch = stderr.match(/(\d+(?:\.\d+)?) fps/);
      const fps = fpsMatch ? Math.round(parseFloat(fpsMatch[1])) : 30;
      
      // Buscar dimensiones con una expresión regular más específica
      // Buscamos patrones como: "1920x1080" o "Stream #0:0: Video: h264, yuv420p, 1080x1920"
      const dimensionsMatch = stderr.match(/Video:.*?(\d+)x(\d+)/);
      console.log('Match de dimensiones:', dimensionsMatch);
      
      const width = dimensionsMatch ? parseInt(dimensionsMatch[1]) : 1920;
      const height = dimensionsMatch ? parseInt(dimensionsMatch[2]) : 1080;
      
      await ffmpeg.deleteFile('input.mp4');
      
      return { fps, width, height };
    } catch (error) {
      console.error('Error al detectar metadatos del video:', error);
      return { fps: 30, width: 1920, height: 1080 };
    }
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || isLoading) return;

    try {
      setIsLoading(true);
      console.log('Iniciando carga de video:', file.name);
      
      // Primero detectar metadata con FFmpeg
      const { fps: detectedFps, width, height } = await detectVideoMetadata(file);
      console.log('Metadata detectada:', { fps: detectedFps, width, height });
      
      // Luego crear la URL del video
      const url = URL.createObjectURL(file);
      setVideoUrl(url);
      setDetectedFps(detectedFps);
      setVideoDimensions({ width, height });
      
      // Esperar a que el video se cargue
      if (videoRef.current) {
        videoRef.current.load();
        await new Promise((resolve) => {
          if (!videoRef.current) return;
          videoRef.current.onloadedmetadata = () => {
            console.log('Video cargado:', {
              duration: videoRef.current?.duration,
              width: videoRef.current?.videoWidth,
              height: videoRef.current?.videoHeight
            });
            
            if (videoRef.current) {
              setVideoDimensions({
                width: videoRef.current.videoWidth,
                height: videoRef.current.videoHeight
              });
              onVideoLoad?.(videoRef.current.duration, detectedFps || 30);
            }
            resolve(null);
          };
        });
      }
    } catch (error) {
      console.error('Error al cargar el video:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file?.type.startsWith('video/') && !isLoading) {
      const input = document.createElement('input');
      input.type = 'file';
      input.files = event.dataTransfer.files;
      
      const fakeEvent = {
        target: input
      } as React.ChangeEvent<HTMLInputElement>;
      
      await handleFileSelect(fakeEvent);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const handleFpsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newFps = parseInt(e.target.value);
    if (!isNaN(newFps) && newFps > 0) {
      onFpsChange?.(newFps);
    }
  };

  // Función para actualizar el tiempo usando requestAnimationFrame
  /* eslint-disable react-hooks/exhaustive-deps */
  const updateTime = useCallback(() => {
    if (videoRef.current && onTimeUpdate) {
      const video = videoRef.current;
      onTimeUpdate(video.currentTime);
      
      // Si llegamos al final del video, asegurarnos de que se detenga
      if (video.currentTime >= video.duration) {
        video.pause();
        onTimeUpdate(video.duration);
        onEnded?.();
        return;
      }
    }
    if (isPlaying) {
      timelineRef.current = requestAnimationFrame(updateTime);
    }
  }, [isPlaying, onTimeUpdate, onEnded]);

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
        // Solo actualizamos el tiempo si no estamos al final del video
        if (currentTime <= seekableEnd && currentTime < video.duration) {
          video.currentTime = currentTime;
        } else if (currentTime >= video.duration) {
          video.currentTime = video.duration;
          video.pause();
          onTimeUpdate?.(video.duration);
          onEnded?.();
        } else {
          console.log(`No se puede buscar más allá de ${seekableEnd}s`);
        }
      } else {
        console.log('El video no es buscable todavía');
      }
    }
  }, [currentTime, onTimeUpdate, onEnded]);

  // Manejar el estado de reproducción
  useEffect(() => {
    if (!videoRef.current) return;

    if (isPlaying) {
      const video = videoRef.current;
      // Si el video está al final, reiniciarlo
      if (video.currentTime >= video.duration) {
        video.currentTime = 0;
        onTimeUpdate?.(0);
      }
      const playPromise = video.play();
      if (playPromise) {
        playPromise.catch(error => {
          console.error('Error al reproducir el video:', error);
        });
      }
    } else {
      videoRef.current.pause();
    }
  }, [isPlaying, onTimeUpdate]);

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
    subtitle => {
      const maxFadeTime = Math.max(animationStyle.fadeInDuration, animationStyle.fadeOutDuration);
      return currentTime >= subtitle.startTime - maxFadeTime && 
             currentTime <= subtitle.endTime + maxFadeTime;
    }
  );

  // Función para calcular las dimensiones del video en pantalla
  const calculateVideoDimensions = useCallback(() => {
    const video = videoRef.current;
    if (!video || !videoDimensions) return;

    console.log('Ajustando dimensiones al contenedor:', {
      originalWidth: videoDimensions.width,
      originalHeight: videoDimensions.height,
      containerWidth: video.offsetWidth,
      containerHeight: video.offsetHeight
    });

    const videoRatio = videoDimensions.width / videoDimensions.height;
    const containerWidth = video.offsetWidth;
    const containerHeight = video.offsetHeight;
    const containerRatio = containerWidth / containerHeight;

    let width: number;
    let height: number;

    if (containerRatio > videoRatio) {
      height = containerHeight;
      width = height * videoRatio;
    } else {
      width = containerWidth;
      height = width / videoRatio;
    }

    setVideoDimensions({ width, height });
  }, [videoDimensions]);

  // Actualizar dimensiones cuando cambie el tamaño de la ventana
  useEffect(() => {
    if (!videoRef.current || !videoDimensions) return;

    const updateDimensions = () => {
      calculateVideoDimensions();
    };

    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, [calculateVideoDimensions, videoDimensions]);

  const getVideoDisplayRect = useCallback(() => {
    if (!videoRef.current || !videoContainerRef.current) return null;
    
    const video = videoRef.current;
    const container = videoContainerRef.current;
    const videoRatio = video.videoWidth / video.videoHeight;
    const containerRect = container.getBoundingClientRect();
    const containerRatio = containerRect.width / containerRect.height;
    
    let width: number;
    let height: number;
    let left: number;
    let top: number;
    
    if (containerRatio > videoRatio) {
      height = containerRect.height;
      width = height * videoRatio;
      top = 0;
      left = (containerRect.width - width) / 2;
    } else {
      width = containerRect.width;
      height = width / videoRatio;
      left = 0;
      top = (containerRect.height - height) / 2;
    }
    
    return { width, height, left, top };
  }, []);

  // Función para renderizar subtítulos en el canvas
  const renderSubtitles = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || !videoDimensions) return;

    const rect = getVideoDisplayRect();
    if (!rect) return;

    // Ajustar el canvas al tamaño y posición exacta del video
    canvas.width = rect.width;
    canvas.height = rect.height;
    canvas.style.left = `${rect.left}px`;
    canvas.style.top = `${rect.top}px`;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Limpiar el canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Encontrar subtítulos activos
    const activeSubtitles = subtitles.filter(
      subtitle => {
        const maxFadeTime = Math.max(animationStyle.fadeInDuration, animationStyle.fadeOutDuration);
        return currentTime >= subtitle.startTime - maxFadeTime && 
               currentTime <= subtitle.endTime + maxFadeTime;
      }
    );

    // Funciones de easing
    const easeOutBack = (x: number): number => {
      if (!animationStyle.useElasticEffect) return x;
      const c1 = animationStyle.bounceStrength;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    };

    const easeOutExpo = (x: number): number => {
      return x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
    };

    // Renderizar cada subtítulo
    activeSubtitles.forEach(subtitle => {
      let opacity = 1;
      let scale = 1;
      
      // Fade in con escala
      if (currentTime < subtitle.startTime) {
        const progress = (animationStyle.fadeInDuration - (subtitle.startTime - currentTime)) / animationStyle.fadeInDuration;
        opacity = easeOutExpo(progress);
        const scaleProgress = easeOutBack(progress);
        scale = 1 + ((animationStyle.initialScale - 1) * (1 - scaleProgress));
      }
      // Fade out
      else if (currentTime > subtitle.endTime) {
        const progress = (animationStyle.fadeOutDuration - (currentTime - subtitle.endTime)) / animationStyle.fadeOutDuration;
        opacity = Math.pow(progress, 2);
      }
      
      // Asegurar que la opacidad esté entre 0 y 1
      opacity = Math.max(0, Math.min(1, opacity));

      // Configurar estilo del texto
      const fontSize = animationStyle.fontSize * (rect.height / 1080);
      ctx.font = `${animationStyle.fontWeight} ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = `${animationStyle.textColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
      ctx.strokeStyle = `${animationStyle.strokeColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
      ctx.lineWidth = fontSize * (animationStyle.strokeWidth / 48);

      // Aplicar la transformación de escala
      ctx.save();
      const x = rect.width / 2;
      const y = rect.height * 0.9;
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.translate(-x, -y);

      // Dibujar el texto
      const processedText = (text: string) => {
        let result = text;
        if (animationStyle.textCase === 'uppercase') {
          result = result.toUpperCase();
        } else if (animationStyle.textCase === 'lowercase') {
          result = result.toLowerCase();
        }
        if (animationStyle.hidePunctuation) {
          const regex = new RegExp(`[${animationStyle.punctuationChars.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}]`, 'g');
          result = result.replace(regex, '');
        }
        if (animationStyle.removeAccents) {
          // Reemplazar solo vocales con tilde manteniendo la ñ
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
  }, [currentTime, subtitles, getVideoDisplayRect, videoDimensions, animationStyle]);

  // Efecto para renderizar subtítulos cuando cambie el tiempo o las dimensiones
  useEffect(() => {
    renderSubtitles();
  }, [renderSubtitles, currentTime, videoDimensions]);

  // Efecto para ajustar el canvas cuando cambie el tamaño de la ventana
  useEffect(() => {
    const handleResize = () => renderSubtitles();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [renderSubtitles]);

  return (
    <div className="flex-1 flex flex-col bg-gray-800 rounded-t-lg overflow-hidden select-none">
      {/* Contenedor principal del video */}
      <div
        className="flex-1 bg-black relative flex items-center justify-center min-h-0"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
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
            {/* Panel de información del video */}
            {showMetaInfo && (
              <div className="absolute top-2 left-2 bg-black/50 p-2 rounded text-xs text-white z-20">
                <div>Dimensiones originales: {videoDimensions ? `${videoDimensions.width}x${videoDimensions.height}` : 'No disponible'}</div>
                <div>FPS: {detectedFps || 'No detectado'}</div>
                <div>Duración: {videoRef.current?.duration.toFixed(2)}s</div>
                <div>Dimensiones en viewport: {videoRef.current?.videoWidth}x{videoRef.current?.videoHeight}</div>
              </div>
            )}

            <div className="w-full h-full flex items-center justify-center">
              <div 
                ref={videoContainerRef}
                className="w-full h-full relative"
              >
                <video
                  ref={videoRef}
                  src={videoUrl}
                  className="w-full h-full object-contain"
                  onTimeUpdate={updateTime}
                  onLoadedMetadata={() => {
                    if (videoRef.current) {
                      console.log('Video metadata loaded:', {
                        duration: videoRef.current?.duration,
                        width: videoRef.current?.videoWidth,
                        height: videoRef.current?.videoHeight
                      });
                      if (videoRef.current) {
                        setVideoDimensions({
                          width: videoRef.current.videoWidth,
                          height: videoRef.current.videoHeight
                        });
                      }
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
                  }}
                  onProgress={() => {
                    if (videoRef.current) {
                      const buffered = videoRef.current.buffered;
                      if (buffered.length > 0) {
                        console.log('Buffered until:', buffered.end(buffered.length - 1));
                      }
                    }
                  }}
                  onEnded={() => {
                    if (videoRef.current) {
                      videoRef.current.pause();
                      onTimeUpdate?.(videoRef.current.duration);
                      onEnded?.();
                    }
                  }}
                  preload="auto"
                  playsInline
                />

                {/* Canvas para subtítulos */}
                <canvas
                  ref={canvasRef}
                  className="absolute pointer-events-none"
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0
                  }}
                />

                {/* Guías de los tercios */}
                {showThirdsGuide && videoRef.current && (() => {
                  const rect = getVideoDisplayRect();
                  if (!rect) return null;
                  
                  return (
                    <div 
                      className="absolute pointer-events-none"
                      style={{
                        left: `${rect.left}px`,
                        top: `${rect.top}px`,
                        width: `${rect.width}px`,
                        height: `${rect.height}px`
                      }}
                    >
                      {/* Líneas verticales */}
                      <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/30" />
                      <div className="absolute right-1/3 top-0 bottom-0 w-px bg-white/30" />
                      {/* Líneas horizontales */}
                      <div className="absolute top-1/3 left-0 right-0 h-px bg-white/30" />
                      <div className="absolute bottom-1/3 left-0 right-0 h-px bg-white/30" />
                    </div>
                  );
                })()}
              </div>
            </div>

            {detectedFps && (
              <div className="absolute bottom-2 right-2 flex items-center gap-2 bg-black/50 p-2 rounded">
                <span className="text-xs text-gray-300">FPS:</span>
                <input
                  type="number"
                  min="1"
                  value={fps || detectedFps}
                  onChange={handleFpsChange}
                  className="w-16 px-1 py-0.5 bg-gray-800 border border-gray-600 rounded text-xs text-white select-text"
                />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-4 text-gray-500 p-8 text-center">
            <button
              onClick={() => !isLoading && fileInputRef.current?.click()}
              disabled={isLoading}
              className={`px-6 py-3 bg-blue-600 text-white rounded-lg transition-colors flex items-center gap-2 select-none
                ${isLoading ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-700'}`}
            >
              {isLoading ? (
                <>
                  <svg className="animate-spin h-6 w-6" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span>Cargando...</span>
                </>
              ) : (
                <>
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  Cargar Video
                </>
              )}
            </button>
            <p className="text-sm select-none">
              {isLoading ? 'Por favor espera...' : 'o arrastra y suelta un archivo de video aquí'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
} 