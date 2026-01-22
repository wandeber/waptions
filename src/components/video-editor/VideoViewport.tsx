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
import { AnimationStyle, Subtitle } from '@/types/timeline';

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

  const renderFrame = useCallback(async () => {
    if (!videoFile || !canvasRef.current || !videoContainerRef.current || isRendering.current) return;

    const { currentTime, previewTime } = usePlaybackStore.getState();
    const renderTime = previewTime !== null ? previewTime : currentTime;
    const rect = getVideoDisplayRect();
    if (!rect) return;

    isRendering.current = true;
    try {
      const canvas = canvasRef.current;
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
        canvas.style.left = `${rect.left}px`;
        canvas.style.top = `${rect.top}px`;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const frame = await videoCache.getFrameAt('preview', videoFile, renderTime);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (frame) {
        ctx.drawImage(frame.canvas, 0, 0, canvas.width, canvas.height);
      } else {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      // Render Subtitles from Timeline Store
      if (!showSubtitles) return;

      const { tracks } = useTimelineStore.getState();

      const renderTrackSubtitles = (
        ctx: CanvasRenderingContext2D,
        trackSubtitles: Subtitle[],
        style: AnimationStyle,
        currentTime: number,
        width: number,
        height: number
      ) => {
        // Find active subtitles for this track
        const EPSILON = 0.0005; // 0.5ms epsilon for robust boundary comparison
        const activeSubtitles = trackSubtitles.filter((subtitle) => {
          // Standard [start, end) check with epsilon:
          // Subtitle is active at EXACT start, but inactive at EXACT end.
          const isActive = currentTime >= subtitle.startTime - EPSILON && currentTime < subtitle.endTime - EPSILON;
          const isExiting = currentTime >= subtitle.endTime - style.fadeOutDuration - EPSILON
            && currentTime < subtitle.endTime - EPSILON;
          return isActive || isExiting;
        });

        if (activeSubtitles.length === 0) return;

        // Process text helper
        const processText = (text: string, style: AnimationStyle): string => {
          let result = text;
          if (style.textCase === 'uppercase') {
            result = result.toUpperCase();
          } else if (style.textCase === 'lowercase') {
            result = result.toLowerCase();
          }
          if (style.hidePunctuation) {
            const regex = new RegExp(
              `[${style.punctuationChars.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}]`,
              'g'
            );
            result = result.replace(regex, '');
          }
          if (style.removeAccents) {
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

        // Easing functions
        const easeOutBack = (x: number, style: AnimationStyle): number => {
          if (!style.useElasticEffect) return x;
          const c1 = style.bounceStrength;
          const c3 = c1 + 1;
          return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
        };

        const easeOutExpo = (x: number): number => {
          return x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
        };

        // Sort and get the timing bounds
        const sortedActive = [...activeSubtitles].sort((a, b) => a.startTime - b.startTime);
        const firstSubtitle = sortedActive[0];
        const lastSubtitle = sortedActive[sortedActive.length - 1];

        // Calculate opacity and scale based on animation timing
        let opacity = 1;
        let scale = 1;

        // Fade in with scale
        if (currentTime >= firstSubtitle.startTime
          && currentTime < firstSubtitle.startTime + style.fadeInDuration) {
          const progress = (currentTime - firstSubtitle.startTime) / style.fadeInDuration;
          opacity = easeOutExpo(progress);
          const scaleProgress = easeOutBack(progress, style);
          scale = 1 + ((style.initialScale - 1) * (1 - scaleProgress));
        }
        // Fade out
        else if (currentTime >= lastSubtitle.endTime - style.fadeOutDuration
          && currentTime < lastSubtitle.endTime) {
          const progress = (lastSubtitle.endTime - currentTime) / style.fadeOutDuration;
          opacity = Math.max(0, Math.min(1, easeOutExpo(progress)));
        }

        opacity = Math.max(0, Math.min(1, opacity));

        // Configure canvas context
        ctx.save();
        const xPos = (width * style.position.x) / 100;
        const yPos = (height * style.position.y) / 100;
        ctx.translate(xPos, yPos);
        ctx.scale(scale, scale);
        ctx.translate(-xPos, -yPos);

        const fontSize = style.fontSize * (height / 1080);
        ctx.font = `${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
        ctx.textAlign = style.textAlign;
        ctx.textBaseline = 'middle';

        let allLines: { text: string; metrics: TextMetrics }[] = [];
        for (const subtitle of sortedActive) {
          const lines = processText(subtitle.text, style)
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => ({
              text: line,
              metrics: ctx.measureText(line),
            }));
          allLines.push(...lines);
        }

        allLines = allLines.slice(0, style.numberOfLines);
        if (allLines.length === 0) {
          ctx.restore();
          return;
        }

        const maxLineWidth = Math.max(...allLines.map((line) => line.metrics.width));
        const lineHeight = fontSize * 1.2;
        const totalTextHeight = lineHeight * allLines.length;

        const padding = {
          vertical: style.backgroundMarginVertical,
          horizontal: style.backgroundMarginHorizontal,
        };
        const bgWidth = maxLineWidth + padding.horizontal * 2;
        const bgHeight = totalTextHeight + padding.vertical * 2;

        let bgX: number;
        switch (style.textAlign) {
          case 'left':
            bgX = xPos - bgWidth / 2 + maxLineWidth / 2 + style.backgroundOffsetX;
            break;
          case 'right':
            bgX = xPos - bgWidth / 2 - maxLineWidth / 2 + style.backgroundOffsetX;
            break;
          default:
            bgX = xPos - bgWidth / 2 + style.backgroundOffsetX;
        }
        const bgY = yPos - bgHeight / 2 + style.backgroundOffsetY;

        if (style.backgroundOpacity > 0) {
          ctx.fillStyle = `${style.backgroundColor}${Math.round(
            opacity * style.backgroundOpacity * 255
          ).toString(16).padStart(2, '0')}`;

          const radius = Math.min(style.backgroundBorderRadius, bgHeight / 2, bgWidth / 2);
          ctx.beginPath();
          ctx.beginPath();
          ctx.roundRect(bgX, bgY, bgWidth, bgHeight, radius);
          ctx.fill();

          if (style.backgroundBorderWidth > 0) {
            ctx.strokeStyle = `${style.backgroundBorderColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
            ctx.lineWidth = style.backgroundBorderWidth;
            ctx.stroke();
          }
        }

        ctx.strokeStyle = `${style.strokeColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
        ctx.fillStyle = `${style.textColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
        ctx.lineWidth = style.strokeWidth;

        let currentY = yPos - totalTextHeight / 2 + lineHeight / 2;
        allLines.forEach((line) => {
          if (style.strokeWidth > 0) ctx.strokeText(line.text, xPos, currentY);
          ctx.fillText(line.text, xPos, currentY);
          currentY += lineHeight;
        });

        ctx.restore();
      };

      tracks.forEach(track => {
        if (!track.isVisible) return;
        renderTrackSubtitles(ctx, track.subtitles, track.style, currentTime, canvas.width, canvas.height);
      });
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