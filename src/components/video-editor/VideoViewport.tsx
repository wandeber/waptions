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
  const [showThirdsGuide, setShowThirdsGuide] = useState(false);
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = externalVideoRef || internalVideoRef;
  const timelineRef = useRef<number>();
  const [detectedFps, setDetectedFps] = useState<number | null>(null);
  const [isVideoLoaded, setIsVideoLoaded] = useState(false);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const [isExporting, setIsExporting] = useState(false);

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
      
      const { stderr } = await ffmpeg.exec(['-i', 'input.mp4']);
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
      
      console.log('Video metadata detectada:', { fps, width, height });
      return { fps, width, height };
    } catch (error) {
      console.error('Error al detectar metadata con FFmpeg:', error);
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

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file?.type.startsWith('video/') && !isLoading) {
      await handleFileSelect({ target: { files: [file] } } as any);
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
      // El video está limitado por la altura
      height = containerRect.height;
      width = height * videoRatio;
      top = 0;
      left = (containerRect.width - width) / 2;
    } else {
      // El video está limitado por el ancho
      width = containerRect.width;
      height = width / videoRatio;
      left = 0;
      top = (containerRect.height - height) / 2;
    }
    
    return { width, height, left, top };
  }, []);

  const handleExport = async () => {
    console.log('Estado actual:', {
      videoRef: !!videoRef.current,
      ffmpeg: !!ffmpeg,
      isFFmpegLoaded,
      videoUrl: !!videoUrl,
      subtitlesLength: subtitles.length,
      ffmpegInstance: ffmpeg
    });

    if (!videoRef.current) {
      console.error('No hay referencia al video');
      return;
    }
    if (!ffmpeg) {
      console.error('FFmpeg no está inicializado');
      return;
    }
    if (!isFFmpegLoaded) {
      console.error('FFmpeg no está cargado');
      return;
    }
    if (!videoUrl) {
      console.error('No hay URL del video');
      return;
    }
    if (!subtitles.length) {
      console.error('No hay subtítulos');
      return;
    }

    try {
      setIsExporting(true);
      console.log('Iniciando exportación...');

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
      await ffmpeg.writeFile('input.mp4', new Uint8Array(videoBuffer));
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
      const { stderr } = await ffmpeg.exec(command);
      console.log('Salida de FFmpeg:', stderr);

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
      console.error('Error al exportar el video:', error);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-gray-800 rounded-lg overflow-hidden">
      {/* Barra de herramientas del viewport */}
      <div className="flex-none flex items-center gap-2 p-2 bg-gray-700">
        <button
          onClick={() => setShowThirdsGuide(prev => !prev)}
          className={`px-3 py-1 rounded text-sm transition-colors ${
            showThirdsGuide 
              ? 'bg-blue-600 text-white hover:bg-blue-700' 
              : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
          }`}
          title="Mostrar/ocultar guías de los tercios"
        >
          Guías de tercios
        </button>

        <button
          onClick={handleExport}
          disabled={!videoUrl || subtitles.length === 0 || isExporting}
          className={`px-3 py-1 rounded text-sm transition-colors ml-auto flex items-center gap-2
            ${videoUrl && subtitles.length > 0 && !isExporting
              ? 'bg-green-600 text-white hover:bg-green-700'
              : 'bg-gray-500 text-gray-400 cursor-not-allowed'
            }`}
          title={!videoUrl 
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
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span>Exportando...</span>
            </>
          ) : (
            'Exportar'
          )}
        </button>
      </div>

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
            <div className="absolute top-2 left-2 bg-black/50 p-2 rounded text-xs text-white z-20">
              <div>Dimensiones originales: {videoDimensions ? `${videoDimensions.width}x${videoDimensions.height}` : 'No disponible'}</div>
              <div>FPS: {detectedFps || 'No detectado'}</div>
              <div>Duración: {videoRef.current?.duration.toFixed(2)}s</div>
              <div>Dimensiones en viewport: {videoRef.current?.videoWidth}x{videoRef.current?.videoHeight}</div>
            </div>

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
                      // Usar las dimensiones reales del video
                      if (videoRef.current) {
                        setVideoDimensions({
                          width: videoRef.current.videoWidth,
                          height: videoRef.current.videoHeight
                        });
                      }
                      onVideoLoad?.(videoRef.current.duration, detectedFps);
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

            {/* Overlay para los subtítulos */}
            <div className="absolute bottom-8 left-0 right-0 flex flex-col items-center">
              {activeSubtitles.map(subtitle => (
                <div
                  key={subtitle.id}
                  className="bg-black/75 text-white px-4 py-2 rounded-lg mb-2 text-center max-w-[80%] whitespace-pre-wrap"
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
          <div className="flex flex-col items-center justify-center gap-4 text-gray-500 p-8 text-center">
            <button
              onClick={() => !isLoading && fileInputRef.current?.click()}
              disabled={isLoading}
              className={`px-6 py-3 bg-blue-600 text-white rounded-lg transition-colors flex items-center gap-2
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
            <p className="text-sm">
              {isLoading ? 'Por favor espera...' : 'o arrastra y suelta un archivo de video aquí'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
} 