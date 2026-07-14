'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { SpinnerIcon } from '../icons/SpinnerIcon';
import { LoadVideoIcon } from '../icons/LoadVideoIcon';
import { Button } from '../design-system/Button';
import { ThirdsGuideOverlay } from './overlays/ThirdsGuideOverlay';
import { DevinGuideOverlay } from './overlays/DevinGuideOverlay';
import {
  ViewportRenderScheduler,
  type ViewportRenderPublication,
} from './viewport-render-scheduler';
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
import { drawContainedVideoFrame } from '@/lib/video-compositor';
import { setPreviewTargetResolution } from '@/lib/preview-target-resolution';

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

interface DisplayRectangle {
  width: number;
  height: number;
  left: number;
  top: number;
}

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const unit = 1024;
  const labels = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(labels.length - 1, Math.floor(Math.log(bytes) / Math.log(unit)));
  return `${(bytes / Math.pow(unit, index)).toFixed(2)} ${labels[index]}`;
};

const areDisplayRectanglesEqual = (
  left: DisplayRectangle | null,
  right: DisplayRectangle | null,
): boolean => left === right || Boolean(
  left
  && right
  && Math.abs(left.width - right.width) < 0.5
  && Math.abs(left.height - right.height) < 0.5
  && Math.abs(left.left - right.left) < 0.5
  && Math.abs(left.top - right.top) < 0.5,
);

export function VideoViewport({
  canvasRef: externalCanvasRef,
  showThirdsGuide = false,
  showDevinGuide = false,
  showMetaInfo = true,
  showSubtitles = true,
}: VideoViewportProps) {
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const {
    tracks,
    videoSources,
    videoClips,
    renderProfile,
    appendMixedMediaCandidate,
  } = useTimelineStore(useShallow((state) => ({
    tracks: state.tracks,
    videoSources: state.videoSources,
    videoClips: state.videoClips,
    renderProfile: state.renderProfile,
    appendMixedMediaCandidate: state.appendMixedMediaCandidate,
  })));

  const [isLoading, setIsLoading] = useState(false);
  const [projectSize, setProjectSize] = useState(0);
  const [cacheMemoryBytes, setCacheMemoryBytes] = useState(0);
  const [jsMemory, setJsMemory] = useState<{ used: number; total: number } | null>(null);
  const [displayRect, setDisplayRect] = useState<DisplayRectangle | null>(null);
  const [displayedSourceId, setDisplayedSourceId] = useState<string | null>(null);

  const videoContainerRef = useRef<HTMLDivElement>(null);
  const internalCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const persistentVideoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastVideoLayerKeyRef = useRef<string | null>(null);
  const lastCompositeKeyRef = useRef<string | null>(null);
  const visualRevisionRef = useRef(0);
  const renderSchedulerRef = useRef<ViewportRenderScheduler | null>(null);
  const activeFrameReleasesRef = useRef(new Set<() => void>());
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
  const displayedSource = displayedSourceId ? sourcesById.get(displayedSourceId) ?? null : null;

  const invalidateRender = useCallback(() => {
    renderSchedulerRef.current?.invalidate();
  }, []);

  const invalidateStaleRender = useCallback(() => {
    // Structural changes and explicit seeks invalidate the meaning of an in-flight frame. Normal
    // playback ticks use the soft path above so a slow decode can still advance visible pixels,
    // followed by one coalesced render for the newest clock position.
    renderSchedulerRef.current?.invalidate({ discardInFlight: true });
  }, []);

  const measureDisplayRectangle = useCallback((): DisplayRectangle | null => {
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

  const handleFiles = useCallback(async (files: readonly File[]) => {
    if (files.length === 0 || isLoading) return;
    const projectAtImportStart = useProjectStore.getState();
    if (!projectAtImportStart.activeProject || !projectAtImportStart.persistenceGeneration) return;
    const importContext = {
      projectId: projectAtImportStart.activeProject.id,
      generation: projectAtImportStart.persistenceGeneration,
    };

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
        const project = useProjectStore.getState();
        if (project.activeProject?.id !== importContext.projectId
          || project.persistenceGeneration !== importContext.generation) {
          // Inspection can decode metadata for several seconds. Never append those assets to a
          // project that became active after the picker operation started.
          return;
        }
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
        if (project.activeProject && !project.activeProject.thumbnail && batch.firstValidVideo) {
          void generateThumbnail(batch.firstValidVideo.file, 0)
            .then((thumbnail) => project.updateThumbnail(importContext, thumbnail))
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

  useEffect(() => {
    lastVideoLayerKeyRef.current = null;
    lastCompositeKeyRef.current = null;
    persistentVideoCanvasRef.current?.removeAttribute('data-has-frame');
    invalidateStaleRender();
  }, [invalidateStaleRender, videoClips, videoSources]);

  useEffect(() => {
    visualRevisionRef.current += 1;
    lastCompositeKeyRef.current = null;
    invalidateStaleRender();
  }, [invalidateStaleRender, showSubtitles, tracks]);

  useEffect(() => {
    const container = videoContainerRef.current;
    if (!container) return;
    const updateRectangle = () => {
      const next = measureDisplayRectangle();
      setDisplayRect((current) => areDisplayRectanglesEqual(current, next) ? current : next);
      setPreviewTargetResolution(next && next.width >= 1 && next.height >= 1
        ? { width: next.width, height: next.height }
        : null);
      invalidateStaleRender();
    };

    updateRectangle();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateRectangle);
      return () => {
        setPreviewTargetResolution(null);
        window.removeEventListener('resize', updateRectangle);
      };
    }
    const observer = new ResizeObserver(updateRectangle);
    observer.observe(container);
    return () => {
      setPreviewTargetResolution(null);
      observer.disconnect();
    };
  }, [invalidateStaleRender, measureDisplayRectangle]);

  const renderFrame = useCallback(async (publication: ViewportRenderPublication) => {
    const canvas = canvasRef.current;
    const rect = measureDisplayRectangle();
    if (!canvas || !projectCanvasSize || !rect) return;

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

    const displayWidth = Math.max(1, Math.round(rect.width));
    const displayHeight = Math.max(1, Math.round(rect.height));
    const layoutKey = `${displayWidth}x${displayHeight}:${Math.round(rect.left)}:${Math.round(rect.top)}`;
    const mediaKey = source && sourceFrame ? `${source.id}:${sourceFrame.index}` : 'black-tail';
    const canonicalProjectFrame = secondsToFrames(projectTime, renderProfile.fps, 'nearest');
    const compositeKey = `${mediaKey}:${canonicalProjectFrame}:${layoutKey}:${showSubtitles ? visualRevisionRef.current : 'no-subtitles'}`;
    if (lastCompositeKeyRef.current === compositeKey && canvas.getAttribute('data-has-content') === 'true') return;

    const videoLayerKey = `${mediaKey}:${layoutKey}`;
    if (source && sourceFrame && lastVideoLayerKeyRef.current !== videoLayerKey) {
      const frame = await videoCache.requestFrame({
        scope: 'preview',
        sourceId: source.id,
        sourceFingerprint: source.fingerprint,
        file: source.file,
        sourceTime: sourceFrame.time,
        sourceFps: source.fps,
        targetResolution: { width: displayWidth, height: displayHeight },
      });
      if (!frame) return;

      activeFrameReleasesRef.current.add(frame.release);
      try {
        // createImageBitmap and source decoding cannot be cancelled. Hard invalidations revoke
        // publication; soft playback ticks let this decoded frame advance pixels before the
        // scheduler renders the single newest pending clock position.
        if (!publication.isCurrent()) return;
        if (!persistentVideoCanvasRef.current) {
          persistentVideoCanvasRef.current = document.createElement('canvas');
        }
        const videoLayer = persistentVideoCanvasRef.current;
        videoLayer.width = displayWidth;
        videoLayer.height = displayHeight;
        const context = videoLayer.getContext('2d');
        if (!context) return;
        context.fillStyle = '#000';
        context.fillRect(0, 0, displayWidth, displayHeight);
        // The cache preserves source aspect ratio. Containment belongs here (and in export), once,
        // so preview does not letterbox an already-letterboxed intermediate canvas a second time.
        drawContainedVideoFrame(
          context,
          frame.canvas,
          source.width,
          source.height,
          displayWidth,
          displayHeight,
        );
        videoLayer.setAttribute('data-has-frame', 'true');
        lastVideoLayerKeyRef.current = videoLayerKey;
      } finally {
        activeFrameReleasesRef.current.delete(frame.release);
        frame.release();
      }
    }

    if (!publication.isCurrent()) return;
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

    if (!publication.isCurrent() || !canvasRef.current) return;
    canvas.width = displayWidth;
    canvas.height = displayHeight;
    canvas.style.left = `${rect.left}px`;
    canvas.style.top = `${rect.top}px`;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.getContext('2d')?.drawImage(offscreen, 0, 0);
    canvas.setAttribute('data-has-content', 'true');
    lastCompositeKeyRef.current = compositeKey;
    setDisplayedSourceId((current) => current === source?.id ? current : source?.id ?? null);
  }, [
    canvasRef,
    measureDisplayRectangle,
    placements,
    projectCanvasSize,
    renderProfile.fps,
    showSubtitles,
    sourcesById,
    tracks,
  ]);

  useEffect(() => {
    const scheduler = new ViewportRenderScheduler(renderFrame);
    renderSchedulerRef.current = scheduler;
    scheduler.setPlaying(isPlaying);
    scheduler.invalidate({ discardInFlight: true });
    return () => {
      scheduler.dispose();
      if (renderSchedulerRef.current === scheduler) renderSchedulerRef.current = null;
    };
  }, [isPlaying, renderFrame]);

  useEffect(() => usePlaybackStore.subscribe((state, previous) => {
    if (state.previewTime !== previous.previewTime) {
      invalidateStaleRender();
      return;
    }
    if (state.currentTime !== previous.currentTime) {
      if (state.isPlaying && previous.isPlaying) invalidateRender();
      else invalidateStaleRender();
    }
  }), [invalidateRender, invalidateStaleRender]);

  useEffect(() => {
    // A seek while playing otherwise looks like a normal clock tick to the store subscription.
    // The explicit transport event restores the hard latest-wins boundary for that user action.
    const handleSeek = () => invalidateStaleRender();
    window.addEventListener('playback-seek', handleSeek);
    return () => window.removeEventListener('playback-seek', handleSeek);
  }, [invalidateStaleRender]);

  useEffect(() => () => {
    Array.from(activeFrameReleasesRef.current).forEach((release) => release());
    activeFrameReleasesRef.current.clear();
  }, []);

  useEffect(() => {
    if (!showMetaInfo) return;
    let isActive = true;

    const updateStats = async () => {
      const nextCacheMemoryBytes = videoCache.getStats().estimatedMemoryBytes;
      if (isActive) {
        setCacheMemoryBytes((current) => (
          current === nextCacheMemoryBytes ? current : nextCacheMemoryBytes
        ));
      }
      const activeProject = useProjectStore.getState().activeProject;
      if (!usePlaybackStore.getState().isPlaying && activeProject) {
        const { storageService } = await import('@/lib/storage/storage-service');
        const nextProjectSize = await storageService.getProjectStorageSize(activeProject.id);
        // IndexedDB work can outlive a metadata-panel toggle. A late result must not revive state
        // updates in a hidden or unmounted viewport.
        if (!isActive) return;
        setProjectSize((current) => current === nextProjectSize ? current : nextProjectSize);
      }
      if (isActive && 'memory' in performance) {
        const memory = (performance as unknown as { memory: MemoryInfo }).memory;
        const nextMemory = { used: memory.usedJSHeapSize, total: memory.jsHeapSizeLimit };
        setJsMemory((current) => (
          current?.used === nextMemory.used && current.total === nextMemory.total
            ? current
            : nextMemory
        ));
      }
    };
    void updateStats();
    // Diagnostics are informational and never need timeline-rate freshness. A relaxed cadence
    // keeps storage reads and heap sampling outside the editor's latency-sensitive path.
    const interval = window.setInterval(() => void updateStats(), 15_000);
    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [showMetaInfo]);

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
            <canvas
              ref={canvasRef}
              className="absolute pointer-events-none z-10"
              data-testid="video-preview-canvas"
              aria-label="Video preview"
            />

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

            {showMetaInfo && displayedSource && (
              <div className="absolute top-2 left-2 bg-black/70 p-2 rounded-md text-[10px] text-white z-20 font-mono border border-white/10">
                <div className="flex flex-col gap-1 min-w-[176px]">
                  <div className="flex justify-between gap-4 border-b border-white/10 pb-1">
                    <span className="text-gray-400">Source</span>
                    <span className="max-w-28 truncate">{displayedSource.originalName}</span>
                  </div>
                  <div className="flex justify-between gap-4"><span className="text-gray-400">Resolution</span><span>{displayedSource.width}×{displayedSource.height}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-gray-400">Frame rate</span><span>{displayedSource.fps.toFixed(2)} fps</span></div>
                  <div className="flex justify-between gap-4"><span className="text-gray-400">Project size</span><span>{formatBytes(projectSize)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-gray-400">Video cache</span><span>{formatBytes(cacheMemoryBytes)}</span></div>
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
