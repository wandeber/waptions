'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { SpinnerIcon } from '../icons/SpinnerIcon';
import { LoadVideoIcon } from '../icons/LoadVideoIcon';
import { Button } from '../design-system/Button';

import { ThirdsGuideOverlay } from './overlays/ThirdsGuideOverlay';
import { DevinGuideOverlay } from './overlays/DevinGuideOverlay';
import { usePlaybackStore } from '@/stores/playback-store';
import { useVideoStore } from '@/stores/video-store';
import { videoCache } from '@/lib/video-cache';
import { getVideoInfo } from '@/lib/mediabunny-utils';
import { useTimelineStore } from '@/stores/timeline-store';
import { useProjectStore } from '@/stores/project-store';
import { storageService } from '@/lib/storage/storage-service';
import { renderSubtitles } from '@/lib/subtitle-renderer';

interface VideoViewportProps {
  onVideoLoad?: (duration: number, fps: number | null, file?: File) => void;
  onTimeUpdate?: (currentTime: number) => void;
  currentTime?: number;
  isPlaying?: boolean;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  onEnded?: () => void;
  showThirdsGuide?: boolean;
  showDevinGuide?: boolean;
  showMetaInfo?: boolean;
  onAudioExtracted?: (audioUrl: string) => void;
  showSubtitles?: boolean;
}

export function VideoViewport({
  onVideoLoad,
  canvasRef: externalCanvasRef,
  showThirdsGuide = false,
  showDevinGuide = false,
  showMetaInfo = true,
  showSubtitles = true,
  onAudioExtracted,
}: VideoViewportProps) {
  // Stores
  const { currentTime, isPlaying, volume, muted, previewTime } = usePlaybackStore();
  const { videoFile, width: originalWidth, height: originalHeight, fps, duration, bitrate, loadVideo } = useVideoStore();

  // Sync video metadata to parent (needed when loading project)
  useEffect(() => {
    if (videoFile && duration > 0) {
      onVideoLoad?.(duration, fps, videoFile);
    } else if (!videoFile) {
      onVideoLoad?.(0, 0, undefined);
    }
  }, [videoFile, duration, fps, onVideoLoad]);

  // Local state
  const [isLoading, setIsLoading] = useState(false);
  const [audioUrl, setAudioUrlState] = useState<string | null>(null);

  // Audio URL management
  useEffect(() => {
    if (!videoFile) {
      setAudioUrlState(null);
      return;
    }

    const url = URL.createObjectURL(videoFile);
    setAudioUrlState(url);
    onAudioExtracted?.(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [videoFile, onAudioExtracted]);

  // Refs
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const internalCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const renderRequestId = useRef<number | null>(null);

  const canvasRef = externalCanvasRef || internalCanvasRef;

  // Handle files
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || isLoading) return;

    try {
      setIsLoading(true);

      // Push history state before loading new video
      useTimelineStore.getState().pushHistory();

      console.log('Iniciando carga de video con mediabunny:', file.name);

      const info = await getVideoInfo(file);
      console.log('Metadata detectada:', info);

      loadVideo(file, info);
      onVideoLoad?.(info.duration, info.fps, file);

      // Save project metadata
      const projectStore = useProjectStore.getState();
      projectStore.updateProjectDuration(info.duration);

      // Generate thumbnail
      const { generateThumbnail } = await import('@/lib/mediabunny-utils');
      generateThumbnail(file, 0).then(thumb => {
        projectStore.updateThumbnail(thumb);
      }).catch(err => console.error('Failed to generate thumbnail:', err));

      // Save video to storage if project is active
      const activeProject = projectStore.activeProject;
      if (activeProject) {
        storageService.saveVideo(activeProject.id, file).catch(console.error);
      }

      console.log(`Video cargado: ${info.duration.toFixed(2)}s @ ${info.fps.toFixed(2)}fps`);

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
      const fakeEvent = { target: input } as React.ChangeEvent<HTMLInputElement>;
      await handleFileSelect(fakeEvent);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  // Rendering logic
  const getVideoDisplayRect = useCallback(() => {
    if (!videoFile || !videoContainerRef.current) return null;
    if (!originalWidth || !originalHeight) {
      return null;
    }

    const container = videoContainerRef.current;
    const videoRatio = originalWidth / originalHeight;
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
  }, [videoFile, originalWidth, originalHeight]);

  const isRendering = useRef(false);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const persistentVideoCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const renderFrame = useCallback(async () => {
    if (!videoFile || !canvasRef.current || !videoContainerRef.current || isRendering.current) return;

    const { currentTime, previewTime } = usePlaybackStore.getState();
    const renderTime = previewTime !== null ? previewTime : currentTime;
    const rect = getVideoDisplayRect();
    if (!rect) return;

    // Update target resolution for cache to match visor size (for optimization)
    videoCache.setTargetResolution(rect.width, rect.height);

    isRendering.current = true;
    try {
      const frame = await videoCache.getFrameAt('preview', videoFile, renderTime);

      // Triple Buffering: Update persistent video layer if a new frame arrived
      if (frame) {
        if (!persistentVideoCanvasRef.current) {
          persistentVideoCanvasRef.current = document.createElement('canvas');
        }
        const pCanvas = persistentVideoCanvasRef.current;
        if (pCanvas.width !== rect.width || pCanvas.height !== rect.height) {
          pCanvas.width = rect.width;
          pCanvas.height = rect.height;
        }
        const pCtx = pCanvas.getContext('2d');
        if (pCtx) {
          pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);
          pCtx.drawImage(frame.canvas, 0, 0, pCanvas.width, pCanvas.height);
          pCanvas.setAttribute('data-has-frame', 'true');
        }
      }

      // Preparation Layer: Compose video background + subtitles offscreen
      if (!offscreenCanvasRef.current) {
        offscreenCanvasRef.current = document.createElement('canvas');
      }

      const offscreen = offscreenCanvasRef.current;
      if (offscreen.width !== rect.width || offscreen.height !== rect.height) {
        offscreen.width = rect.width;
        offscreen.height = rect.height;
      }

      const offCtx = offscreen.getContext('2d');
      if (!offCtx) return;

      offCtx.clearRect(0, 0, offscreen.width, offscreen.height);

      // Draw background (Persistent Frame or Black)
      const pCanvas = persistentVideoCanvasRef.current;
      if (pCanvas && pCanvas.getAttribute('data-has-frame') === 'true') {
        offCtx.drawImage(pCanvas, 0, 0);
      } else {
        offCtx.fillStyle = '#000';
        offCtx.fillRect(0, 0, offscreen.width, offscreen.height);
      }

      // Render Subtitles from Timeline Store
      if (!showSubtitles) return;

      const { tracks } = useTimelineStore.getState();

      tracks.forEach(track => {
        if (!track.isVisible) return;
        renderSubtitles(offCtx, track.subtitles, track.style, currentTime, offscreen.width, offscreen.height);
      });

      // FINAL BLIT to visible canvas
      const canvas = canvasRef.current;
      if (!canvas) return;

      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
        canvas.style.left = `${rect.left}px`;
        canvas.style.top = `${rect.top}px`;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(offscreen, 0, 0);
        canvas.setAttribute('data-has-content', 'true');
      }
    } finally {
      isRendering.current = false;
    }
  }, [videoFile, showSubtitles, getVideoDisplayRect, canvasRef]);

  // Main loop
  useEffect(() => {
    let active = true;
    const loop = () => {
      if (!active) return;
      renderFrame();
      renderRequestId.current = requestAnimationFrame(loop);
    };

    renderRequestId.current = requestAnimationFrame(loop);
    return () => {
      active = false;
      if (renderRequestId.current) cancelAnimationFrame(renderRequestId.current);
    };
  }, [renderFrame, videoFile]);

  // Force render on time change (for scrubbing)
  useEffect(() => {
    renderFrame();
  }, [currentTime, previewTime, renderFrame]);

  // Audio Sync & Playback State
  useEffect(() => {
    if (!audioRef.current || !videoFile) return;
    const audio = audioRef.current;

    const handleSeek = (e: CustomEvent) => {
      audio.currentTime = e.detail.time;
    };

    const handleUpdate = (e: CustomEvent) => {
      const targetTime = e.detail.time;
      // Looser drift threshold for smoother audio (0.5s)
      if (Math.abs(audio.currentTime - targetTime) > 0.5) {
        audio.currentTime = targetTime;
      }
    };

    const handleSpeed = (e: CustomEvent) => {
      audio.playbackRate = e.detail.speed;
    };

    window.addEventListener('playback-seek', handleSeek as EventListener);
    window.addEventListener('playback-update', handleUpdate as EventListener);
    window.addEventListener('playback-speed', handleSpeed as EventListener);

    return () => {
      window.removeEventListener('playback-seek', handleSeek as EventListener);
      window.removeEventListener('playback-update', handleUpdate as EventListener);
      window.removeEventListener('playback-speed', handleSpeed as EventListener);
    };
  }, [videoFile]);

  // Handle Play/Pause and reactive volume/muted
  useEffect(() => {
    if (!audioRef.current || !videoFile) return;
    const audio = audioRef.current;

    audio.volume = volume;
    audio.muted = muted;

    if (isPlaying) {
      if (audio.paused) {
        audio.play().catch(err => {
          if (err.name !== 'AbortError') console.error('Audio play error:', err);
        });
      }
    } else {
      if (!audio.paused) {
        audio.pause();
      }
      // Precise sync on pause
      if (Math.abs(audio.currentTime - currentTime) > 0.05) {
        audio.currentTime = currentTime;
      }
    }
  }, [isPlaying, volume, muted, videoFile, currentTime]);

  interface MemoryInfo {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  }

  // Stats state
  const [projectSize, setProjectSize] = useState<number>(0);
  const [cacheStats, setCacheStats] = useState(videoCache.getStats());
  const [jsMemory, setJsMemory] = useState<{ used: number; total: number } | null>(null);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  useEffect(() => {
    const updateStats = async () => {
      // 1. Update Video Cache Stats (Very light)
      const stats = videoCache.getStats();
      setCacheStats(stats);

      // 2. Update Storage Stats (Heavier - skip if playing)
      const isPlayingNow = usePlaybackStore.getState().isPlaying;
      const activeProject = useProjectStore.getState().activeProject;

      if (!isPlayingNow && activeProject) {
        const size = await storageService.getProjectStorageSize(activeProject.id);
        setProjectSize(size);
      }

      // 3. Update Memory Stats (Proprietary Chrome API)
      if ('memory' in performance) {
        const mem = (performance as unknown as { memory: MemoryInfo }).memory;
        setJsMemory({
          used: mem.usedJSHeapSize,
          total: mem.jsHeapSizeLimit
        });
      }
    };

    updateStats();
    const interval = setInterval(updateStats, 5000); // Update every 5 seconds
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex-1 flex flex-col bg-gray-800 overflow-hidden select-none" onDrop={handleDrop} onDragOver={handleDragOver}>
      <input type="file" ref={fileInputRef} className="hidden" accept="video/*" onChange={handleFileSelect} />

      <div className="flex-1 bg-black relative flex items-center justify-center min-h-0" ref={videoContainerRef}>
        {videoFile ? (
          <>
            <canvas ref={canvasRef} className="absolute pointer-events-none z-10" />
            <audio
              ref={audioRef}
              src={audioUrl || undefined}
              className="fixed left-[-9999px]"
              playsInline
              onCanPlay={(e) => {
                console.log('Audio listo para reproducir');
                e.currentTarget.muted = false;
              }}
              onError={(e) => console.error('Error en elemento audio:', e)}
            />

            {showMetaInfo && (
              <div className="absolute top-2 left-2 bg-black/60 p-2.5 rounded-lg text-[10px] text-white z-20 font-mono tracking-tight backdrop-blur-md border border-white/10 shadow-xl">
                <div className="flex flex-col gap-1.5 min-w-[180px]">
                  <div className="flex justify-between items-baseline gap-4 border-b border-white/5 pb-1 mb-0.5">
                    <span className="opacity-60">Resolution</span>
                    <span className="font-bold text-gray-200">{originalWidth}x{originalHeight}</span>
                  </div>

                  <div className="flex justify-between items-baseline gap-4 opacity-80">
                    <span className="opacity-60">Performance</span>
                    <span className="text-gray-200">{fps.toFixed(1)} FPS / {((bitrate || 0) / 1000000).toFixed(1)} Mb</span>
                  </div>

                  <div className="flex justify-between items-baseline gap-4 opacity-80">
                    <span className="opacity-60 text-blue-300/70">Project Size</span>
                    <span className="text-blue-200">{formatBytes(projectSize)}</span>
                  </div>

                  <div className="flex flex-col gap-0.5 mt-0.5 pt-1 border-t border-white/5">
                    <div className="flex justify-between items-baseline gap-4 opacity-80">
                      <span className="opacity-60 text-green-300/70">Video Cache</span>
                      <span className="text-green-200">{formatBytes(cacheStats.estimatedMemoryBytes)}</span>
                    </div>
                    <div className="flex justify-between items-baseline gap-4 text-[8px] opacity-40 italic">
                      <span>sinks/frames</span>
                      <span>{cacheStats.totalSinks} / {cacheStats.cachedFrames}</span>
                    </div>
                  </div>

                  {jsMemory && (
                    <div className="flex justify-between items-baseline gap-4 opacity-80 pt-1 border-t border-white/5">
                      <span className="opacity-60 text-purple-300/70">JS Memory</span>
                      <span className="text-purple-200">{formatBytes(jsMemory.used)}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {showThirdsGuide && getVideoDisplayRect() && <ThirdsGuideOverlay rect={getVideoDisplayRect()!} />}
            {showDevinGuide && getVideoDisplayRect() && <DevinGuideOverlay rect={getVideoDisplayRect()!} />}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center gap-4 text-gray-500">
            <Button onClick={() => fileInputRef.current?.click()} disabled={isLoading} variant="primary" size="lg">
              {isLoading ? <SpinnerIcon className="h-6 w-6" /> : <LoadVideoIcon />}
              <span>{isLoading ? 'Cargando...' : 'Cargar Video'}</span>
            </Button>
            <p className="text-sm">o arrastra y suelta un archivo de video aquí</p>
          </div>
        )}
      </div>
    </div>
  );
}