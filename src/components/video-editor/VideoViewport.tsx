'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { SpinnerIcon } from '../icons/SpinnerIcon';
import { LoadVideoIcon } from '../icons/LoadVideoIcon';
import { Button } from '../design-system/Button';
import type { SubtitleAnimationStyle } from './subtitle-editor/types';
import { defaultAnimationStyle } from './subtitle-editor/types';
import { ThirdsGuideOverlay } from './overlays/ThirdsGuideOverlay';
import { DevinGuideOverlay } from './overlays/DevinGuideOverlay';

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
  showDevinGuide?: boolean;
  showMetaInfo?: boolean;
  animationStyle?: SubtitleAnimationStyle;
  onAudioExtracted?: (audioUrl: string) => void;
  showSubtitles?: boolean;
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
  showDevinGuide = false,
  showMetaInfo = false,
  animationStyle = defaultAnimationStyle,
  onAudioExtracted,
  showSubtitles = true
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
  const [videoBitrate, setVideoBitrate] = useState<number | null>(null);

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

  const detectVideoMetadata = async (file: File): Promise<{ fps: number | null; width: number; height: number; bitrate: number | null }> => {
    if (!isFFmpegLoaded || !ffmpeg) {
      console.warn('FFmpeg no está cargado, usando valores por defecto');
      return { fps: null, width: 1920, height: 1080, bitrate: null };
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
      
      // Buscar bitrate
      const bitrateMatch = stderr.match(/bitrate:\s*(\d+)\s*kb\/s/);
      console.log('Match de bitrate:', bitrateMatch);
      const bitrate = bitrateMatch ? parseInt(bitrateMatch[1]) : null;
      console.log('Bitrate detectado:', bitrate);
      
      if (!fps) {
        console.warn('No se pudieron detectar los FPS del video');
      }
      
      // Buscar dimensiones
      const dimensionsMatch = stderr.match(/Video:.*?(\d+)x(\d+)/);
      console.log('Dimensiones detectadas:', dimensionsMatch);
      
      const width = dimensionsMatch ? parseInt(dimensionsMatch[1]) : 1920;
      const height = dimensionsMatch ? parseInt(dimensionsMatch[2]) : 1080;
      
      await ffmpeg.deleteFile('input.mp4');
      
      return { fps, width, height, bitrate };
    } catch (error) {
      console.error('Error al detectar metadatos del video:', error);
      return { fps: null, width: 1920, height: 1080, bitrate: null };
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
      const { fps: detectedFps, width, height, bitrate } = await detectVideoMetadata(file);
      console.log('Metadata detectada:', { fps: detectedFps, width, height, bitrate });
      
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
      setVideoBitrate(bitrate);
      
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

  // Función para obtener el grupo de subtítulos a mostrar
  const getSubtitlesGroup = useCallback((currentTime: number) => {
    // Ordenar subtítulos por tiempo de inicio y filtrar subtítulos vacíos
    const sortedSubtitles = [...subtitles]
      .filter(subtitle => subtitle.text.trim() !== '')
      .sort((a, b) => a.startTime - b.startTime);

    // Función para contar líneas en un subtítulo, ignorando líneas vacías
    const countLines = (text: string) => text
      .split('\n')
      .filter(line => line.trim() !== '')
      .length;

    // Primero, encontrar todos los grupos posibles
    const groups: Array<Array<typeof sortedSubtitles[0]>> = [];
    let currentGroup: typeof sortedSubtitles = [];
    let currentLines = 0;

    for (let i = 0; i < sortedSubtitles.length; i++) {
      const subtitle = sortedSubtitles[i];
      const lines = countLines(subtitle.text);

      // Si no hay líneas válidas, ignorar este subtítulo
      if (lines === 0) continue;

      // Si este subtítulo tiene más líneas que el máximo, es un grupo por sí mismo
      if (lines > animationStyle.numberOfLines) {
        // Si hay un grupo en construcción, finalizarlo
        if (currentGroup.length > 0) {
          groups.push([...currentGroup]);
          currentGroup = [];
          currentLines = 0;
        }
        groups.push([subtitle]);
        continue;
      }

      // Si añadir este subtítulo excedería el límite, comenzar nuevo grupo
      if (currentLines + lines > animationStyle.numberOfLines) {
        if (currentGroup.length > 0) {
          groups.push([...currentGroup]);
          currentGroup = [];
          currentLines = 0;
        }
      }

      // Añadir el subtítulo al grupo actual
      currentGroup.push(subtitle);
      currentLines += lines;
    }

    // Añadir el último grupo si existe
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    // Encontrar el grupo activo basado en el tiempo actual
    const activeGroup = groups.find(group => {
      const groupStart = group[0].startTime;
      const groupEnd = group[group.length - 1].endTime;
      return currentTime >= groupStart && currentTime < groupEnd;
    });

    if (activeGroup) {
      return activeGroup;
    }

    // Si no hay grupo activo, buscar el próximo grupo
    const nextGroup = groups.find(group => currentTime < group[0].startTime);
    return nextGroup || [];
  }, [subtitles, animationStyle.numberOfLines]);

  // Función para renderizar subtítulos en el canvas
  const renderSubtitles = useCallback(() => {
    // Limpiar el canvas en cualquier caso
    if (!canvasRef.current || !videoRef.current) {
      return;
    }

    const rect = getVideoDisplayRect();
    if (!rect) return;

    // Ajustar el canvas al tamaño y posición exacta del video
    canvasRef.current.width = rect.width;
    canvasRef.current.height = rect.height;
    canvasRef.current.style.left = `${rect.left}px`;
    canvasRef.current.style.top = `${rect.top}px`;
    canvasRef.current.style.width = `${rect.width}px`;
    canvasRef.current.style.height = `${rect.height}px`;

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    // Limpiar el canvas
    ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);

    // Si los subtítulos están ocultos, no renderizar nada más
    if (!showSubtitles) {
      return;
    }

    // Encontrar subtítulos activos y en transición
    const subtitlesToRender = (() => {
      const group = getSubtitlesGroup(currentTime);
      if (group.length === 0) return [];

      const firstSubtitle = group[0];
      const lastSubtitle = group[group.length - 1];

      const isActive = currentTime >= firstSubtitle.startTime && currentTime < lastSubtitle.endTime;
      const isExiting = currentTime >= lastSubtitle.endTime - animationStyle.fadeOutDuration && 
                       currentTime < lastSubtitle.endTime;

      if (isActive || isExiting) return group;
      return [];
    })();

    // Función para procesar el texto
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
    if (subtitlesToRender.length > 0) {
      const firstSubtitle = subtitlesToRender[0];
      const lastSubtitle = subtitlesToRender[subtitlesToRender.length - 1];
      
      let opacity = 1;
      let scale = 1;
      
      // Fade in con escala
      if (currentTime >= firstSubtitle.startTime && 
          currentTime < firstSubtitle.startTime + animationStyle.fadeInDuration) {
        const progress = (currentTime - firstSubtitle.startTime) / animationStyle.fadeInDuration;
        opacity = easeOutExpo(progress);
        const scaleProgress = easeOutBack(progress);
        scale = 1 + ((animationStyle.initialScale - 1) * (1 - scaleProgress));
      }
      // Fade out
      if (currentTime >= lastSubtitle.endTime - animationStyle.fadeOutDuration && 
          currentTime < lastSubtitle.endTime) {
        const progress = (lastSubtitle.endTime - currentTime) / animationStyle.fadeOutDuration;
        opacity = progress;
      }
      
      opacity = Math.max(0, Math.min(1, opacity));

      // Configurar el contexto
      ctx.save();
      const x = (canvasRef.current.width * animationStyle.position.x) / 100;
      const y = (canvasRef.current.height * animationStyle.position.y) / 100;
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.translate(-x, -y);

      const fontSize = animationStyle.fontSize * (rect.height / 1080);
      const fontWeight = animationStyle.fontWeight;
      ctx.font = `${fontWeight} ${fontSize}px ${animationStyle.fontFamily}`;
      ctx.textAlign = animationStyle.textAlign;
      ctx.textBaseline = 'middle';

      // Procesar y medir los textos
      interface ProcessedLine {
        text: string;
        metrics: TextMetrics;
      }

      // Obtener todas las líneas de texto procesadas
      let allLines: ProcessedLine[] = [];
      for (const subtitle of subtitlesToRender) {
        const text = processedText(subtitle.text);
        const lines = text
          .split('\n')
          .filter(line => line.trim() !== '') // Ignorar líneas vacías
          .map(line => ({
            text: line,
            metrics: ctx.measureText(line)
          }));
        allLines.push(...lines);
      }

      // Limitar al número de líneas configurado
      allLines = allLines.slice(0, animationStyle.numberOfLines);

      // Si no hay líneas válidas, no renderizar nada
      if (allLines.length === 0) {
        ctx.restore();
        return;
      }

      // Calcular dimensiones
      const maxLineWidth = Math.max(...allLines.map(line => line.metrics.width));
      const lineHeight = fontSize * 1.2;
      const totalTextHeight = lineHeight * allLines.length;
      
      const padding = {
        vertical: animationStyle.backgroundMarginVertical,
        horizontal: animationStyle.backgroundMarginHorizontal
      };
      const bgWidth = maxLineWidth + (padding.horizontal * 2);
      const bgHeight = totalTextHeight + (padding.vertical * 2);

      // Calcular posición del fondo
      let bgX: number;
      switch (animationStyle.textAlign) {
        case 'left':
          bgX = x - (bgWidth / 2) + (maxLineWidth / 2) + animationStyle.backgroundOffsetX;
          break;
        case 'right':
          bgX = x - (bgWidth / 2) - (maxLineWidth / 2) + animationStyle.backgroundOffsetX;
          break;
        default: // center
          bgX = x - (bgWidth / 2) + animationStyle.backgroundOffsetX;
      }
      const bgY = y - (bgHeight / 2) + animationStyle.backgroundOffsetY;

      // Dibujar fondo
      if (animationStyle.backgroundOpacity > 0) {
        ctx.fillStyle = `${animationStyle.backgroundColor}${Math.round(opacity * animationStyle.backgroundOpacity * 255).toString(16).padStart(2, '0')}`;
        if (animationStyle.backgroundBorderRadius > 0) {
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
          ctx.quadraticCurveTo(bgX + radius, bgY, bgX + radius, bgY);
          ctx.closePath();
          ctx.fill();

          if (animationStyle.backgroundBorderWidth > 0) {
            ctx.strokeStyle = `${animationStyle.backgroundBorderColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
            ctx.lineWidth = animationStyle.backgroundBorderWidth;
            ctx.stroke();
          }
        } else {
          ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
          if (animationStyle.backgroundBorderWidth > 0) {
            ctx.strokeStyle = `${animationStyle.backgroundBorderColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
            ctx.lineWidth = animationStyle.backgroundBorderWidth;
            ctx.strokeRect(bgX, bgY, bgWidth, bgHeight);
          }
        }
      }

      // Dibujar texto
      ctx.strokeStyle = `${animationStyle.strokeColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
      ctx.fillStyle = `${animationStyle.textColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
      ctx.lineWidth = animationStyle.strokeWidth;

      let currentY = y - (totalTextHeight / 2) + (lineHeight / 2);
      allLines.forEach(line => {
        ctx.strokeText(line.text, x, currentY);
        ctx.fillText(line.text, x, currentY);
        currentY += lineHeight;
      });
      
      ctx.restore();
    }
  }, [canvasRef, videoRef, videoDimensions, getVideoDisplayRect, currentTime, animationStyle, getSubtitlesGroup, showSubtitles]);

  // Efecto para renderizar subtítulos cuando cambie el tiempo o las dimensiones
  useEffect(() => {
    renderSubtitles();
  }, [renderSubtitles, currentTime, videoDimensions, subtitles]);

  // Efecto para ajustar el canvas cuando cambie el tamaño de la ventana
  useEffect(() => {
    const handleResize = () => renderSubtitles();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [renderSubtitles]);

  return (
    <div 
      className="flex-1 flex flex-col bg-gray-800 overflow-hidden select-none"
      data-testid="video-viewport"
    >
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
                <div>Bitrate: {videoBitrate !== null ? `${videoBitrate} kb/s` : 'No detectado'}</div>
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
                  return <ThirdsGuideOverlay rect={rect} />;
                })()}

                {/* Guía de Devin */}
                {showDevinGuide && videoRef.current && (() => {
                  const rect = getVideoDisplayRect();
                  if (!rect) return null;
                  return (
                    <div className="absolute inset-0 z-10">
                      <DevinGuideOverlay rect={rect} />
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-4 text-gray-500 p-8 text-center"
               data-testid="upload-zone">
            <Button
              onClick={() => !isLoading && fileInputRef.current?.click()}
              disabled={isLoading}
              variant="primary"
              size="lg"
            >
              {isLoading ? (
                <>
                  <SpinnerIcon className="h-6 w-6" />
                  <span>Cargando...</span>
                </>
              ) : (
                <>
                  <LoadVideoIcon />
                  Cargar Video
                </>
              )}
            </Button>
            <p className="text-sm select-none">
              {isLoading ? 'Por favor espera...' : 'o arrastra y suelta un archivo de video aquí'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
} 