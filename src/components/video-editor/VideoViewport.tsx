'use client';

import { useRef, useState, useEffect, useCallback } from 'react';

interface VideoViewportProps {
  onVideoLoad?: (duration: number) => void;
  onTimeUpdate?: (currentTime: number) => void;
  currentTime?: number;
  videoRef?: React.RefObject<HTMLVideoElement>;
  isPlaying?: boolean;
  onPlayPause?: () => void;
}

export function VideoViewport({ 
  onVideoLoad, 
  onTimeUpdate, 
  currentTime,
  videoRef: externalVideoRef,
  isPlaying,
  onPlayPause
}: VideoViewportProps) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = externalVideoRef || internalVideoRef;
  const lastUpdateRef = useRef<number>(0);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setVideoUrl(url);
    }
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file?.type.startsWith('video/')) {
      const url = URL.createObjectURL(file);
      setVideoUrl(url);
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
  };

  const handleVideoLoad = () => {
    if (videoRef.current && onVideoLoad) {
      onVideoLoad(videoRef.current.duration);
    }
  };

  // Optimizar las actualizaciones de tiempo
  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current || !onTimeUpdate) return;

    const now = performance.now();
    if (now - lastUpdateRef.current > 32) { // Limitar a ~30fps
      onTimeUpdate(videoRef.current.currentTime);
      lastUpdateRef.current = now;
    }
  }, [onTimeUpdate]);

  // Actualizar el tiempo del video cuando cambia externamente
  useEffect(() => {
    if (!videoRef.current || currentTime === undefined) return;

    const diff = Math.abs(videoRef.current.currentTime - currentTime);
    if (diff > 0.1) { // Solo actualizar si la diferencia es significativa
      videoRef.current.currentTime = currentTime;
    }
  }, [currentTime]);

  // Manejar el estado de reproducción
  useEffect(() => {
    if (!videoRef.current) return;

    const playPromise = isPlaying ? videoRef.current.play() : Promise.resolve();
    playPromise.then(() => {
      if (!isPlaying) {
        videoRef.current?.pause();
      }
    }).catch(error => {
      console.error('Error al reproducir el video:', error);
    });
  }, [isPlaying]);

  // Limpiar URL al desmontar
  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

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
        <div className="w-full h-full flex items-center justify-center">
          <video
            ref={videoRef}
            src={videoUrl}
            className="max-h-full max-w-full object-contain"
            onLoadedMetadata={handleVideoLoad}
            onTimeUpdate={handleTimeUpdate}
          />
        </div>
      ) : (
        <div className="text-gray-500 cursor-pointer p-8 text-center">
          Arrastra y suelta un video o haz clic para seleccionar
        </div>
      )}
    </div>
  );
} 