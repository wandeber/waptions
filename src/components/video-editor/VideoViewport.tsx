'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';

interface VideoViewportProps {
  onVideoLoad?: (duration: number, fps: number | null) => void;
  onTimeUpdate?: (currentTime: number) => void;
  currentTime?: number;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  isPlaying?: boolean;
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
    fontFamily: string;
    backgroundColor: string;
    backgroundOpacity: number;
    backgroundBorderColor: string;
    backgroundBorderWidth: number;
    backgroundMarginVertical: number;
    backgroundMarginHorizontal: number;
    backgroundBorderRadius: number;
    backgroundOffsetX: number;
    backgroundOffsetY: number;
  };
  onAudioExtracted?: (audioUrl: string) => void;
}

export function VideoViewport({ 
  onVideoLoad, 
  onTimeUpdate, 
  currentTime = 0,
  videoRef: externalVideoRef,
  isPlaying,
  subtitles = [],
  canvasRef: externalCanvasRef,
  onEnded,
  showThirdsGuide = false,
  showMetaInfo = false,
  animationStyle = {
    fadeInDuration: 0,
    fadeOutDuration: 0,
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
    removeAccents: false,
    fontFamily: 'Arial',
    backgroundColor: '#000000',
    backgroundOpacity: 0,
    backgroundBorderColor: '#ffffff',
    backgroundBorderWidth: 0,
    backgroundMarginVertical: 0,
    backgroundMarginHorizontal: 0,
    backgroundBorderRadius: 0,
    backgroundOffsetX: 0,
    backgroundOffsetY: 0,
  },
  onAudioExtracted
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

  const detectVideoMetadata = async (file: File): Promise<{ fps: number | null; width: number; height: number }> => {
    if (!isFFmpegLoaded || !ffmpeg) {
      console.warn('FFmpeg no está cargado, usando valores por defecto');
      return { fps: null, width: 1920, height: 1080 };
    }

    try {
      const buffer = await file.arrayBuffer();
      await ffmpeg.writeFile('input.mp4', new Uint8Array(buffer));
      
      // Configurar el logger para capturar stderr
      let stderr = '';
      ffmpeg.on('log', ({ message }) => {
        stderr += message + '\n';
      });
      
      await ffmpeg.exec(['-i', 'input.mp4']);
      
      // Log detallado de la metadata
      console.log('=== INICIO METADATA COMPLETA ===');
      console.log(stderr);
      console.log('=== FIN METADATA COMPLETA ===');
      
      // Buscar la línea que contiene la info del stream de video
      const videoStreamLine = stderr.split('\n').find(line => line.includes('Stream') && line.includes('Video'));
      console.log('Línea del stream de video:', videoStreamLine);
      
      // Buscar FPS en la información del stream de video (fps o tbr)
      const fpsMatch = stderr.match(/Video:.*?,\s*(\d+(?:\.\d+)?)\s*(?:fps|tbr)/);
      console.log('Match de FPS:', fpsMatch);
      const fps = fpsMatch ? parseFloat(fpsMatch[1]) : null;
      console.log('FPS detectados:', fps);
      
      if (!fps) {
        console.warn('No se pudieron detectar los FPS del video');
        return { fps: null, width: 1920, height: 1080 };
      }
      
      // Buscar dimensiones
      const dimensionsMatch = stderr.match(/Video:.*?(\d+)x(\d+)/);
      console.log('Dimensiones detectadas:', dimensionsMatch);
      
      const width = dimensionsMatch ? parseInt(dimensionsMatch[1]) : 1920;
      const height = dimensionsMatch ? parseInt(dimensionsMatch[2]) : 1080;
      
      await ffmpeg.deleteFile('input.mp4');
      
      return { fps, width, height };
    } catch (error) {
      console.error('Error al detectar metadatos del video:', error);
      return { fps: null, width: 1920, height: 1080 };
    }
  };

  const extractAudio = async (file: File) => {
    if (!isFFmpegLoaded || !ffmpeg) {
      console.warn('FFmpeg no está cargado, no se puede extraer el audio');
      return null;
    }

    try {
      console.log('Iniciando extracción de audio...', {
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type
      });

      const buffer = await file.arrayBuffer();
      console.log('Buffer de video creado:', {
        bufferSize: buffer.byteLength
      });

      await ffmpeg.writeFile('input.mp4', new Uint8Array(buffer));
      console.log('Archivo de video escrito en FFmpeg');
      
      // Extraer audio en formato WAV
      console.log('Ejecutando comando de extracción de audio...');
      await ffmpeg.exec([
        '-i', 'input.mp4',
        '-vn', // No video
        '-acodec', 'pcm_s16le', // Formato PCM 16-bit
        '-ar', '44100', // Sample rate
        '-ac', '2', // Stereo
        'output.wav'
      ]);
      console.log('Audio extraído exitosamente');
      
      // Leer el archivo de audio
      const audioData = await ffmpeg.readFile('output.wav');
      console.log('Archivo de audio leído:', {
        audioDataSize: audioData.length
      });

      const audioBlob = new Blob([audioData], { type: 'audio/wav' });
      const audioUrl = URL.createObjectURL(audioBlob);
      console.log('URL de audio creada');
      
      // Limpiar archivos
      await ffmpeg.deleteFile('input.mp4');
      await ffmpeg.deleteFile('output.wav');
      console.log('Archivos temporales eliminados');
      
      return audioUrl;
    } catch (error) {
      console.error('Error detallado al extraer el audio:', {
        error,
        message: error instanceof Error ? error.message : 'Error desconocido',
        stack: error instanceof Error ? error.stack : undefined
      });
      return null;
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
      
      // Extraer audio
      const audioUrl = await extractAudio(file);
      if (audioUrl) {
        onAudioExtracted?.(audioUrl);
      }
      
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
              height: videoRef.current?.videoHeight,
              detectedFps
            });
            
            if (videoRef.current) {
              setVideoDimensions({
                width: videoRef.current.videoWidth,
                height: videoRef.current.videoHeight
              });
              // Asegurarnos de usar los FPS detectados por FFmpeg
              onVideoLoad?.(videoRef.current.duration, detectedFps ?? 24);
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

    // Encontrar subtítulos activos y en transición
    const subtitlesToRender = subtitles.filter(subtitle => {
      const isActive = currentTime >= subtitle.startTime && currentTime < subtitle.endTime;
      const isExiting = currentTime >= subtitle.endTime - animationStyle.fadeOutDuration && 
                       currentTime < subtitle.endTime;
      return isActive || isExiting;
    });

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
    subtitlesToRender.forEach(subtitle => {
      let opacity = 1;
      let scale = 1;
      
      // Fade in con escala
      if (currentTime >= subtitle.startTime && currentTime < subtitle.startTime + animationStyle.fadeInDuration) {
        const progress = (currentTime - subtitle.startTime) / animationStyle.fadeInDuration;
        opacity = easeOutExpo(progress);
        const scaleProgress = easeOutBack(progress);
        scale = 1 + ((animationStyle.initialScale - 1) * (1 - scaleProgress));
      }
      // Fade out
      else if (currentTime >= subtitle.endTime - animationStyle.fadeOutDuration && currentTime < subtitle.endTime) {
        const progress = (subtitle.endTime - currentTime) / animationStyle.fadeOutDuration;
        opacity = progress;
      }
      
      // Asegurar que la opacidad esté entre 0 y 1
      opacity = Math.max(0, Math.min(1, opacity));

      // Configurar estilo del texto
      const fontSize = animationStyle.fontSize * (rect.height / 1080);
      ctx.font = `${animationStyle.fontWeight} ${fontSize}px ${animationStyle.fontFamily}, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';

      // Procesar el texto
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

      const text = processedText(subtitle.text);

      // Aplicar la transformación de escala
      ctx.save();
      const x = rect.width / 2;
      const y = rect.height * 0.9;
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.translate(-x, -y);

      // Medir el texto para el fondo
      const metrics = ctx.measureText(text);
      const textWidth = metrics.width;
      const textHeight = fontSize;
      const padding = {
        vertical: animationStyle.backgroundMarginVertical,
        horizontal: animationStyle.backgroundMarginHorizontal
      };
      const bgWidth = textWidth + (padding.horizontal * 2);
      const bgHeight = textHeight + (padding.vertical * 2);
      const bgX = x - (bgWidth / 2) + animationStyle.backgroundOffsetX;
      const bgY = y - textHeight - padding.vertical + animationStyle.backgroundOffsetY;

      // Dibujar el fondo
      if (animationStyle.backgroundOpacity > 0) {
        ctx.fillStyle = `${animationStyle.backgroundColor}${Math.round(opacity * animationStyle.backgroundOpacity * 255).toString(16).padStart(2, '0')}`;
        if (animationStyle.backgroundBorderRadius > 0) {
          // Dibujar fondo con esquinas redondeadas
          const radius = Math.min(animationStyle.backgroundBorderRadius, bgHeight / 2, bgWidth / 2);
          ctx.beginPath();
          ctx.moveTo(bgX + radius, bgY);
          ctx.lineTo(bgX + bgWidth - radius, bgY);
          ctx.quadraticCurveTo(bgX + bgWidth, bgY, bgX + bgWidth, bgY + radius);
          ctx.lineTo(bgX + bgWidth, bgY + bgHeight - radius);
          ctx.quadraticCurveTo(bgX + bgWidth, bgY + bgHeight, bgX + bgWidth - radius, bgY + bgHeight);
          ctx.lineTo(bgX + radius, bgY + bgHeight);
          ctx.quadraticCurveTo(bgX, bgY + bgHeight, bgX, bgY + bgHeight - radius);
          ctx.lineTo(bgX, bgY + radius);
          ctx.quadraticCurveTo(bgX, bgY, bgX + radius, bgY);
          ctx.closePath();
          ctx.fill();

          // Dibujar borde si es necesario
          if (animationStyle.backgroundBorderWidth > 0) {
            ctx.strokeStyle = `${animationStyle.backgroundBorderColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
            ctx.lineWidth = animationStyle.backgroundBorderWidth;
            ctx.stroke();
          }
        } else {
          // Dibujar fondo rectangular
          ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
          
          // Dibujar borde si es necesario
          if (animationStyle.backgroundBorderWidth > 0) {
            ctx.strokeStyle = `${animationStyle.backgroundBorderColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
            ctx.lineWidth = animationStyle.backgroundBorderWidth;
            ctx.strokeRect(bgX, bgY, bgWidth, bgHeight);
          }
        }
      }

      // Dibujar el texto
      ctx.strokeStyle = `${animationStyle.strokeColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
      ctx.fillStyle = `${animationStyle.textColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
      ctx.lineWidth = fontSize * (animationStyle.strokeWidth / 48);
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
      
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
    <div className="flex-1 flex flex-col bg-gray-800 overflow-hidden select-none">
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
                <div>Dimensiones originales: {videoRef.current ? `${videoRef.current.videoWidth}x${videoRef.current.videoHeight}` : 'No disponible'}</div>
                <div>FPS: {detectedFps !== null ? detectedFps.toFixed(3) : 'No detectado'}</div>
                <div>Duración: {videoRef.current?.duration.toFixed(2)}s</div>
                <div>Dimensiones en viewport: {(() => {
                  const rect = getVideoDisplayRect();
                  return rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : 'No disponible';
                })()}</div>
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
                        height: videoRef.current?.videoHeight,
                        detectedFps
                      });

                      // Intentar obtener FPS nativos del video
                      if ('getVideoPlaybackQuality' in videoRef.current) {
                        const video = videoRef.current as HTMLVideoElement & {
                          getVideoPlaybackQuality: () => {
                            totalVideoFrames: number;
                            droppedVideoFrames: number;
                            creationTime: number;
                            totalFrameDelay: number;
                          };
                        };
                        
                        const quality = video.getVideoPlaybackQuality();
                        console.log('Video playback quality:', quality);
                        
                        // Si tenemos frames totales y duración, podemos calcular FPS
                        if (quality.totalVideoFrames > 0 && video.duration > 0) {
                          const calculatedFps = quality.totalVideoFrames / video.duration;
                          console.log('FPS calculados desde metadata:', calculatedFps);
                          if (Math.abs(calculatedFps - 24) < 1) {
                            setDetectedFps(24);
                          }
                        }
                      }

                      if (videoRef.current) {
                        setVideoDimensions({
                          width: videoRef.current.videoWidth,
                          height: videoRef.current.videoHeight
                        });
                        // Usar los FPS detectados sin fallback a 24
                        onVideoLoad?.(videoRef.current.duration, detectedFps ?? 24);
                      }
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