'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { SpinnerIcon } from '../icons/SpinnerIcon';
import { LoadVideoIcon } from '../icons/LoadVideoIcon';
import { Button } from '../design-system/Button';
import type { SubtitleAnimationStyle } from './subtitle-editor/types';
import { defaultAnimationStyle } from './subtitle-editor/types';
import { ThirdsGuideOverlay } from './overlays/ThirdsGuideOverlay';
import { DevinGuideOverlay } from './overlays/DevinGuideOverlay';
import { usePlaybackStore } from '@/stores/playback-store';
import { useVideoStore } from '@/stores/video-store';
import { videoCache } from '@/lib/video-cache';
import { getVideoInfo } from '@/lib/mediabunny-utils';

interface VideoViewportProps {
  onVideoLoad?: (duration: number, fps: number | null, file?: File) => void;
  onTimeUpdate?: (currentTime: number) => void;
  currentTime?: number;
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
  subtitles = [],
  canvasRef: externalCanvasRef,
  showThirdsGuide = false,
  showDevinGuide = false,
  showMetaInfo = true,
  animationStyle = defaultAnimationStyle,
  showSubtitles = true,
  onAudioExtracted,
}: VideoViewportProps) {
  // Stores
  const { currentTime, isPlaying, volume, muted } = usePlaybackStore();
  const { videoFile, width: originalWidth, height: originalHeight, fps, loadVideo } = useVideoStore();

  // Local state
  const [isLoading, setIsLoading] = useState(false);
  const [audioUrl, setAudioUrlState] = useState<string | null>(null);

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
      console.log('Iniciando carga de video con mediabunny:', file.name);

      const info = await getVideoInfo(file);
      console.log('Metadata detectada:', info);

      loadVideo(file, info);
      onVideoLoad?.(info.duration, info.fps, file);

      // Setup audio
      const url = URL.createObjectURL(file);
      setAudioUrlState(url);
      onAudioExtracted?.(url);

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

    const { currentTime } = usePlaybackStore.getState();
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

      const frame = await videoCache.getFrameAt('preview', videoFile, currentTime);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (frame) {
        ctx.drawImage(frame.canvas, 0, 0, canvas.width, canvas.height);
      } else {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      // Render Subtitles
      if (!showSubtitles || subtitles.length === 0) return;

      // ... (rest of subtitle rendering logic unchanged)

      // Find active subtitles at this time
      const activeSubtitles = subtitles.filter((subtitle) => {
        const isActive = currentTime >= subtitle.startTime && currentTime < subtitle.endTime;
        const isExiting = currentTime >= subtitle.endTime - animationStyle.fadeOutDuration
          && currentTime < subtitle.endTime;
        return isActive || isExiting;
      });

      if (activeSubtitles.length === 0) return;

      // Process text helper
      const processText = (text: string): string => {
        let result = text;
        if (animationStyle.textCase === 'uppercase') {
          result = result.toUpperCase();
        } else if (animationStyle.textCase === 'lowercase') {
          result = result.toLowerCase();
        }
        if (animationStyle.hidePunctuation) {
          const regex = new RegExp(
            `[${animationStyle.punctuationChars.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}]`,
            'g'
          );
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

      // Easing functions
      const easeOutBack = (x: number): number => {
        if (!animationStyle.useElasticEffect) return x;
        const c1 = animationStyle.bounceStrength;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
      };

      const easeOutExpo = (x: number): number => {
        return x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
      };

      // Sort and get the timing bounds from active subtitles
      const sortedActive = [...activeSubtitles].sort((a, b) => a.startTime - b.startTime);
      const firstSubtitle = sortedActive[0];
      const lastSubtitle = sortedActive[sortedActive.length - 1];

      // Calculate opacity and scale based on animation timing
      let opacity = 1;
      let scale = 1;

      // Fade in with scale
      if (currentTime >= firstSubtitle.startTime
        && currentTime < firstSubtitle.startTime + animationStyle.fadeInDuration) {
        const progress = (currentTime - firstSubtitle.startTime) / animationStyle.fadeInDuration;
        opacity = easeOutExpo(progress);
        const scaleProgress = easeOutBack(progress);
        scale = 1 + ((animationStyle.initialScale - 1) * (1 - scaleProgress));
      }

      // Fade out
      if (currentTime >= lastSubtitle.endTime - animationStyle.fadeOutDuration
        && currentTime < lastSubtitle.endTime) {
        const progress = (lastSubtitle.endTime - currentTime) / animationStyle.fadeOutDuration;
        opacity = progress;
      }

      opacity = Math.max(0, Math.min(1, opacity));

      // Configure canvas context
      ctx.save();
      const x = (canvas.width * animationStyle.position.x) / 100;
      const y = (canvas.height * animationStyle.position.y) / 100;
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.translate(-x, -y);

      const fontSize = animationStyle.fontSize * (canvas.height / 1080);
      const fontWeight = animationStyle.fontWeight;
      ctx.font = `${fontWeight} ${fontSize}px ${animationStyle.fontFamily}`;
      ctx.textAlign = animationStyle.textAlign;
      ctx.textBaseline = 'middle';

      // Get all lines from all active subtitles
      interface ProcessedLine {
        text: string;
        metrics: TextMetrics;
      }

      let allLines: ProcessedLine[] = [];
      for (const subtitle of sortedActive) {
        const text = processText(subtitle.text);
        const lines = text
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => ({
            text: line,
            metrics: ctx.measureText(line),
          }));
        allLines.push(...lines);
      }

      // Limit to configured number of lines
      allLines = allLines.slice(0, animationStyle.numberOfLines);

      if (allLines.length === 0) {
        ctx.restore();
        return;
      }

      // Calculate dimensions
      const maxLineWidth = Math.max(...allLines.map((line) => line.metrics.width));
      const lineHeight = fontSize * 1.2;
      const totalTextHeight = lineHeight * allLines.length;

      const padding = {
        vertical: animationStyle.backgroundMarginVertical,
        horizontal: animationStyle.backgroundMarginHorizontal,
      };
      const bgWidth = maxLineWidth + padding.horizontal * 2;
      const bgHeight = totalTextHeight + padding.vertical * 2;

      // Calculate background position
      let bgX: number;
      switch (animationStyle.textAlign) {
        case 'left':
          bgX = x - bgWidth / 2 + maxLineWidth / 2 + animationStyle.backgroundOffsetX;
          break;
        case 'right':
          bgX = x - bgWidth / 2 - maxLineWidth / 2 + animationStyle.backgroundOffsetX;
          break;
        default:
          bgX = x - bgWidth / 2 + animationStyle.backgroundOffsetX;
      }
      const bgY = y - bgHeight / 2 + animationStyle.backgroundOffsetY;

      // Draw background
      if (animationStyle.backgroundOpacity > 0) {
        ctx.fillStyle = `${animationStyle.backgroundColor}${Math.round(
          opacity * animationStyle.backgroundOpacity * 255
        )
          .toString(16)
          .padStart(2, '0')}`;

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
            ctx.strokeStyle = `${animationStyle.backgroundBorderColor}${Math.round(opacity * 255)
              .toString(16)
              .padStart(2, '0')}`;
            ctx.lineWidth = animationStyle.backgroundBorderWidth;
            ctx.stroke();
          }
        } else {
          ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
          if (animationStyle.backgroundBorderWidth > 0) {
            ctx.strokeStyle = `${animationStyle.backgroundBorderColor}${Math.round(opacity * 255)
              .toString(16)
              .padStart(2, '0')}`;
            ctx.lineWidth = animationStyle.backgroundBorderWidth;
            ctx.strokeRect(bgX, bgY, bgWidth, bgHeight);
          }
        }
      }

      // Draw text
      ctx.strokeStyle = `${animationStyle.strokeColor}${Math.round(opacity * 255)
        .toString(16)
        .padStart(2, '0')}`;
      ctx.fillStyle = `${animationStyle.textColor}${Math.round(opacity * 255)
        .toString(16)
        .padStart(2, '0')}`;
      ctx.lineWidth = animationStyle.strokeWidth;

      let currentY = y - totalTextHeight / 2 + lineHeight / 2;
      allLines.forEach((line) => {
        ctx.strokeText(line.text, x, currentY);
        ctx.fillText(line.text, x, currentY);
        currentY += lineHeight;
      });

      ctx.restore();
    } finally {
      isRendering.current = false;
    }
  }, [videoFile, subtitles, animationStyle, showSubtitles, getVideoDisplayRect, canvasRef]);

  // Main loop
  useEffect(() => {
    const loop = () => {
      renderFrame();
      renderRequestId.current = requestAnimationFrame(loop);
    };

    renderRequestId.current = requestAnimationFrame(loop);
    return () => {
      if (renderRequestId.current) cancelAnimationFrame(renderRequestId.current);
    };
  }, [renderFrame, videoFile]);

  // Audio Sync
  const lastAudioOp = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!audioRef.current || !videoFile) return;
    const audio = audioRef.current;

    // Sync volume and muted
    audio.volume = volume;
    audio.muted = muted;

    const syncAudio = async () => {
      if (isPlaying) {
        // Sync time if drifting
        if (Math.abs(audio.currentTime - currentTime) > 0.15) {
          audio.currentTime = currentTime;
        }

        // Only call play if paused
        if (audio.paused) {
          try {
            lastAudioOp.current = audio.play();
            await lastAudioOp.current;
          } catch (error) {
            if ((error as Error).name !== 'AbortError') {
              console.error('Audio play error:', error);
            }
          }
        }
      } else {
        // Only call pause if playing
        if (!audio.paused) {
          if (lastAudioOp.current) {
            try {
              await lastAudioOp.current;
            } catch {
              // Ignore aborts
            }
          }
          audio.pause();
        }

        // Final sync when paused
        if (Math.abs(audio.currentTime - currentTime) > 0.05) {
          audio.currentTime = currentTime;
        }
      }
    };

    syncAudio();
  }, [isPlaying, currentTime, videoFile, volume, muted]);

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
              <div className="absolute top-2 left-2 bg-black/50 p-2 rounded text-xs text-white z-20">
                <div>FPS: {fps.toFixed(2)}</div>
                <div>Time: {currentTime.toFixed(2)}s</div>
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