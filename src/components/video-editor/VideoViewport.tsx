'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { SpinnerIcon } from '../icons/SpinnerIcon';
import { LoadVideoIcon } from '../icons/LoadVideoIcon';
import { Button } from '../design-system/Button';
import { ThirdsGuideOverlay } from './overlays/ThirdsGuideOverlay';
import { DevinGuideOverlay } from './overlays/DevinGuideOverlay';
import { usePlaybackStore } from '@/stores/playback-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { useProjectStore } from '@/stores/project-store';
import { videoCache } from '@/lib/video-cache';
import { generateThumbnail } from '@/lib/mediabunny-utils';
import { classifyMediaImportCandidate, inspectMediaBatch } from '@/lib/media-import';
import { secondsToFrames } from '@/lib/render-profile';
import {
  buildClipPlacements,
  getSourceFrameAtOrBefore,
  projectTimeToSourceTime,
  resolveClipAtProjectTime,
} from '@/lib/video-timeline';
import { renderSubtitles } from '@/lib/subtitle-renderer';

interface VideoViewportProps {
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  showThirdsGuide?: boolean;
  showDevinGuide?: boolean;
  showMetaInfo?: boolean;
  showSubtitles?: boolean;
}

interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const unit = 1024;
  const labels = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(labels.length - 1, Math.floor(Math.log(bytes) / Math.log(unit)));
  return `${(bytes / Math.pow(unit, index)).toFixed(2)} ${labels[index]}`;
};

export function VideoViewport({
  canvasRef: externalCanvasRef,
  showThirdsGuide = false,
  showDevinGuide = false,
  showMetaInfo = true,
  showSubtitles = true,
}: VideoViewportProps) {
  const { currentTime, previewTime } = usePlaybackStore();
  const {
    tracks,
    videoSources,
    videoClips,
    renderProfile,
    appendMixedMediaCandidate,
  } = useTimelineStore();

  const [isLoading, setIsLoading] = useState(false);
  const [projectSize, setProjectSize] = useState(0);
  const [cacheStats, setCacheStats] = useState(videoCache.getStats());
  const [jsMemory, setJsMemory] = useState<{ used: number; total: number } | null>(null);

  const videoContainerRef = useRef<HTMLDivElement>(null);
  const internalCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renderRequestId = useRef<number | null>(null);
  const isRendering = useRef(false);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const persistentVideoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastVideoLayerKeyRef = useRef<string | null>(null);
  const lastCompositeKeyRef = useRef<string | null>(null);
  const timelineRevisionRef = useRef(0);
  const canvasRef = externalCanvasRef || internalCanvasRef;

  // Clip boundaries must use the same rational frame grid as timeline edits and export. Using
  // raw source seconds here can otherwise show the next clip one fractional frame too early.
  const placements = useMemo(
    () => buildClipPlacements(videoClips, renderProfile.fps),
    [renderProfile.fps, videoClips],
  );
  const sourcesById = useMemo(
    () => new Map(videoSources.map((source) => [source.id, source])),
    [videoSources],
  );
  const projectCanvasSize = useMemo(() => (
    renderProfile.isCanvasSizeLocked
      ? { width: renderProfile.width, height: renderProfile.height }
      : null
  ), [renderProfile.height, renderProfile.isCanvasSizeLocked, renderProfile.width]);
  const displayProjectTime = previewTime ?? currentTime;
  const activePlacement = resolveClipAtProjectTime(placements, displayProjectTime);
  const activeSource = activePlacement
    ? sourcesById.get(activePlacement.clip.sourceId) ?? null
    : null;

  const handleFiles = useCallback(async (files: readonly File[]) => {
    if (files.length === 0 || isLoading) return;

    setIsLoading(true);
    try {
      // Candidate metadata only controls inspection order. Track inspection remains authoritative,
      // but probing likely videos first lets the first valid one establish the project render
      // profile before an audio file from the same picker batch is committed.
      const rank = { video: 0, audio: 1, unknown: 2 } as const;
      const orderedFiles = files
        .map((file, index) => ({ file, index, rank: rank[classifyMediaImportCandidate(file)] }))
        .sort((left, right) => left.rank - right.rank || left.index - right.index)
        .map(({ file }) => file);
      const batch = await inspectMediaBatch(orderedFiles);
      batch.items.forEach((item) => {
        if (item.kind !== 'failed' && item.diagnostics.length > 0) {
          console.warn(`Media import diagnostics for ${item.file.name}:`, item.diagnostics);
        }
      });

      if (batch.videoSources.length > 0 || batch.audioSources.length > 0) {
        const timeline = useTimelineStore.getState();
        const insertionFrame = secondsToFrames(
          usePlaybackStore.getState().currentTime,
          timeline.renderProfile.fps,
          'nearest',
        );
        appendMixedMediaCandidate({
          videoSources: batch.videoSources,
          audioSources: batch.audioSources,
          insertionFrame,
        });
        const project = useProjectStore.getState();

        if (!project.activeProject?.thumbnail && batch.firstValidVideo) {
          void generateThumbnail(batch.firstValidVideo.file, 0)
            .then((thumbnail) => project.updateThumbnail(thumbnail))
            .catch((error) => console.error('Failed to generate project thumbnail:', error));
        }
      }

      const rejectedNames = batch.items.flatMap((item) => (
        item.kind === 'failed' || item.kind === 'unsupported' ? [item.file.name] : []
      ));
      if (rejectedNames.length > 0) {
        alert(`These files could not be imported: ${rejectedNames.join(', ')}`);
      }
    } catch (error) {
      console.error('Failed to import media:', error);
      alert(error instanceof Error ? error.message : 'The selected media could not be imported.');
    } finally {
      setIsLoading(false);
    }
  }, [appendMixedMediaCandidate, isLoading]);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    await handleFiles(files);
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    await handleFiles(Array.from(event.dataTransfer.files));
  };

  const getVideoDisplayRect = useCallback(() => {
    if (!projectCanvasSize || !videoContainerRef.current) return null;
    const containerRect = videoContainerRef.current.getBoundingClientRect();
    const videoRatio = projectCanvasSize.width / projectCanvasSize.height;
    const containerRatio = containerRect.width / Math.max(1, containerRect.height);

    if (containerRatio > videoRatio) {
      const height = containerRect.height;
      const width = height * videoRatio;
      return { width, height, left: (containerRect.width - width) / 2, top: 0 };
    }

    const width = containerRect.width;
    const height = width / videoRatio;
    return { width, height, left: 0, top: (containerRect.height - height) / 2 };
  }, [projectCanvasSize]);

  useEffect(() => {
    lastVideoLayerKeyRef.current = null;
    lastCompositeKeyRef.current = null;
    persistentVideoCanvasRef.current?.removeAttribute('data-has-frame');
  }, [videoClips, videoSources]);

  useEffect(() => {
    timelineRevisionRef.current += 1;
    lastCompositeKeyRef.current = null;
  }, [tracks, showSubtitles]);

  const renderFrame = useCallback(async () => {
    if (!canvasRef.current || !videoContainerRef.current || !projectCanvasSize || isRendering.current) return;

    const playback = usePlaybackStore.getState();
    const projectTime = playback.previewTime ?? playback.currentTime;
    const placement = resolveClipAtProjectTime(placements, projectTime);
    const source = placement ? sourcesById.get(placement.clip.sourceId) ?? null : null;
    const sourceFrame = source && placement
      ? getSourceFrameAtOrBefore(
        projectTimeToSourceTime(placement, projectTime),
        source.fps,
        source.duration,
      )
      : null;
    const rect = getVideoDisplayRect();
    if (!rect) return;

    const displayWidth = Math.max(1, Math.round(rect.width));
    const displayHeight = Math.max(1, Math.round(rect.height));
    const layoutKey = `${displayWidth}x${displayHeight}:${Math.round(rect.left)}:${Math.round(rect.top)}`;
    const mediaKey = source && sourceFrame ? `${source.id}:${sourceFrame.index}` : 'black-tail';
    const canonicalProjectFrame = secondsToFrames(projectTime, renderProfile.fps, 'nearest');
    const compositeKey = `${mediaKey}:${canonicalProjectFrame}:${layoutKey}:${showSubtitles ? timelineRevisionRef.current : 'no-subtitles'}`;
    if (lastCompositeKeyRef.current === compositeKey && canvasRef.current.getAttribute('data-has-content') === 'true') return;

    isRendering.current = true;
    try {
      const videoLayerKey = `${mediaKey}:${layoutKey}`;
      if (source && sourceFrame && lastVideoLayerKeyRef.current !== videoLayerKey) {
        const mediaId = `preview:${source.id}`;
        videoCache.setTargetResolution(displayWidth, displayHeight, mediaId);
        const frame = await videoCache.getFrameAt(mediaId, source.file, sourceFrame.time, {
          mode: 'visible',
          fps: source.fps,
        });

        // Ignore a decode that completed after the playhead crossed to another source/frame.
        const latestPlayback = usePlaybackStore.getState();
        const latestTime = latestPlayback.previewTime ?? latestPlayback.currentTime;
        const latestPlacement = resolveClipAtProjectTime(placements, latestTime);
        const latestSource = latestPlacement ? sourcesById.get(latestPlacement.clip.sourceId) ?? null : null;
        const latestFrame = latestSource && latestPlacement
          ? getSourceFrameAtOrBefore(
            projectTimeToSourceTime(latestPlacement, latestTime),
            latestSource.fps,
            latestSource.duration,
          )
          : null;
        if (!frame || latestSource?.id !== source.id || latestFrame?.index !== sourceFrame.index) return;

        if (!persistentVideoCanvasRef.current) persistentVideoCanvasRef.current = document.createElement('canvas');
        const videoLayer = persistentVideoCanvasRef.current;
        videoLayer.width = displayWidth;
        videoLayer.height = displayHeight;
        const context = videoLayer.getContext('2d');
        if (context) {
          context.fillStyle = '#000';
          context.fillRect(0, 0, displayWidth, displayHeight);
          // The preview canvas always represents the locked render profile. Individual sources
          // are fitted inside it so mixed resolutions and aspect ratios match export exactly.
          const sourceRatio = source.width / source.height;
          const canvasRatio = displayWidth / displayHeight;
          const drawWidth = canvasRatio > sourceRatio ? displayHeight * sourceRatio : displayWidth;
          const drawHeight = canvasRatio > sourceRatio ? displayHeight : displayWidth / sourceRatio;
          context.drawImage(
            frame.canvas,
            (displayWidth - drawWidth) / 2,
            (displayHeight - drawHeight) / 2,
            drawWidth,
            drawHeight,
          );
          videoLayer.setAttribute('data-has-frame', 'true');
          lastVideoLayerKeyRef.current = videoLayerKey;
        }
      }

      if (!offscreenCanvasRef.current) offscreenCanvasRef.current = document.createElement('canvas');
      const offscreen = offscreenCanvasRef.current;
      offscreen.width = displayWidth;
      offscreen.height = displayHeight;
      const offscreenContext = offscreen.getContext('2d');
      if (!offscreenContext) return;

      offscreenContext.fillStyle = '#000';
      offscreenContext.fillRect(0, 0, displayWidth, displayHeight);
      if (source && persistentVideoCanvasRef.current?.getAttribute('data-has-frame') === 'true') {
        offscreenContext.drawImage(persistentVideoCanvasRef.current, 0, 0);
      }
      if (showSubtitles) {
        tracks.forEach((track) => {
          if (track.isVisible) {
            renderSubtitles(
              offscreenContext,
              track.subtitles,
              track.style,
              projectTime,
              displayWidth,
              displayHeight,
            );
          }
        });
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = displayWidth;
      canvas.height = displayHeight;
      canvas.style.left = `${rect.left}px`;
      canvas.style.top = `${rect.top}px`;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      canvas.getContext('2d')?.drawImage(offscreen, 0, 0);
      canvas.setAttribute('data-has-content', 'true');
      lastCompositeKeyRef.current = compositeKey;
    } finally {
      isRendering.current = false;
    }
  }, [canvasRef, getVideoDisplayRect, placements, projectCanvasSize, renderProfile.fps, showSubtitles, sourcesById, tracks]);

  useEffect(() => {
    let active = true;
    const loop = () => {
      if (!active) return;
      void renderFrame();
      renderRequestId.current = requestAnimationFrame(loop);
    };
    renderRequestId.current = requestAnimationFrame(loop);
    return () => {
      active = false;
      if (renderRequestId.current) cancelAnimationFrame(renderRequestId.current);
    };
  }, [renderFrame]);

  useEffect(() => {
    void renderFrame();
  }, [currentTime, previewTime, renderFrame]);

  useEffect(() => {
    const updateStats = async () => {
      setCacheStats(videoCache.getStats());
      const activeProject = useProjectStore.getState().activeProject;
      if (!usePlaybackStore.getState().isPlaying && activeProject) {
        const { storageService } = await import('@/lib/storage/storage-service');
        setProjectSize(await storageService.getProjectStorageSize(activeProject.id));
      }
      if ('memory' in performance) {
        const memory = (performance as unknown as { memory: MemoryInfo }).memory;
        setJsMemory({ used: memory.usedJSHeapSize, total: memory.jsHeapSizeLimit });
      }
    };
    void updateStats();
    const interval = window.setInterval(() => void updateStats(), 5000);
    return () => window.clearInterval(interval);
  }, []);

  const displayRect = getVideoDisplayRect();

  return (
    <div
      className="flex-1 flex flex-col bg-gray-950 overflow-hidden select-none min-h-0 rounded-lg border border-gray-800"
      onDrop={handleDrop}
      onDragOver={(event) => event.preventDefault()}
    >
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="video/*,audio/*"
        multiple
        onChange={handleFileSelect}
      />

      <div className="flex-1 bg-black relative flex items-center justify-center min-h-0" ref={videoContainerRef}>
        {projectCanvasSize ? (
          <>
            <canvas ref={canvasRef} className="absolute pointer-events-none z-10" />

            <Button
              variant="secondary"
              size="sm"
              className="absolute top-2 right-2 z-30 h-8 px-2.5 bg-gray-900/80 border border-white/10 backdrop-blur"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading}
              title="Import video or audio media"
            >
              {isLoading ? <SpinnerIcon className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              <span className="text-xs">Add media</span>
            </Button>

            {showMetaInfo && activeSource && (
              <div className="absolute top-2 left-2 bg-black/70 p-2 rounded-md text-[10px] text-white z-20 font-mono border border-white/10">
                <div className="flex flex-col gap-1 min-w-[176px]">
                  <div className="flex justify-between gap-4 border-b border-white/10 pb-1">
                    <span className="text-gray-400">Source</span>
                    <span className="max-w-28 truncate">{activeSource.originalName}</span>
                  </div>
                  <div className="flex justify-between gap-4"><span className="text-gray-400">Resolution</span><span>{activeSource.width}×{activeSource.height}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-gray-400">Frame rate</span><span>{activeSource.fps.toFixed(2)} fps</span></div>
                  <div className="flex justify-between gap-4"><span className="text-gray-400">Project size</span><span>{formatBytes(projectSize)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-gray-400">Video cache</span><span>{formatBytes(cacheStats.estimatedMemoryBytes)}</span></div>
                  {jsMemory && <div className="flex justify-between gap-4"><span className="text-gray-400">JS memory</span><span>{formatBytes(jsMemory.used)}</span></div>}
                </div>
              </div>
            )}

            {showThirdsGuide && displayRect && <ThirdsGuideOverlay rect={displayRect} />}
            {showDevinGuide && displayRect && <DevinGuideOverlay rect={displayRect} />}
            {videoClips.length === 0 && (
              <div className="absolute z-20 rounded border border-white/10 bg-black/60 px-3 py-2 text-xs text-gray-300">
                No video clips. Audio and subtitles remain editable and playable.
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center gap-4 text-gray-500 p-8 text-center">
            <Button onClick={() => fileInputRef.current?.click()} disabled={isLoading} variant="primary" size="lg">
              {isLoading ? <SpinnerIcon className="h-6 w-6" /> : <LoadVideoIcon />}
              <span>{isLoading ? 'Importing…' : 'Import media'}</span>
            </Button>
            <p className="text-sm">Start with at least one video; audio files in the same batch are also imported.</p>
          </div>
        )}
      </div>
    </div>
  );
}
