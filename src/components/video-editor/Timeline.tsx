'use client';

import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, memo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Subtitle, SubtitleTrack } from '@/types/timeline';
import type { AudioTrack } from '@/types/video';
import { ChevronLeft, ChevronRight, Headphones, Pause, Play, Plus, RotateCcw, Scissors, Trash2, ZoomIn, ZoomOut, Magnet } from 'lucide-react';
import { Button } from '../design-system/Button';
import { useTimelineStore } from '@/stores/timeline-store';
import { useProjectStore } from '@/stores/project-store';
import { usePlaybackStore } from '@/stores/playback-store';
import { TimelineRuler } from './TimelineRuler';
import { TimelineTrackHeader } from './TimelineTrackHeader';
import { TimelinePlayhead } from './TimelinePlayhead';
import { TimelineTrackOverlay } from './TimelineTrackOverlay';

// Componentes memoizados para evitar re-renders innecesarios en cada frame de reproducción
const MemoizedTimelineRuler = memo(TimelineRuler);
const MemoizedTimelinePlayhead = memo(TimelinePlayhead);
const MemoizedTimelineTrackOverlay = memo(TimelineTrackOverlay);
const MemoizedTimelineTrackHeader = memo(TimelineTrackHeader);
import { useAudioWaveforms } from '@/hooks/use-waveform';
import { OverlayMenu } from './OverlayMenu';
import { TimelineVideoTrack } from './TimelineVideoTrack';
import { TimelineAudioTrack, getAudioClipVisualData } from './TimelineAudioTrack';
import { TimelineAudioTrackHeader } from './TimelineAudioTrackHeader';
import { TimelineRowResizeHandle } from './TimelineRowResizeHandle';
import { VideoCutPopover } from './VideoCutPopover';
import { buildClipPlacements, getTimelineDurations } from '@/lib/video-timeline';
import { getVisibleVideoAudioReferences } from '@/lib/video-waveform';
import { getAudioMediaCacheKey, type AudioMediaReference } from '@/lib/media-asset-ref';
import { framesToSeconds, secondsToFrames } from '@/lib/render-profile';
import {
  DEFAULT_TIMELINE_ROW_HEIGHT,
  clampTimelineRowHeight,
} from '@/lib/editor-layout';
import {
  selectTimelinePlaybackStatus,
  selectTimelinePlaybackStructure,
} from './playback-selectors';

interface TimelineProps {
  onSubtitleClick?: (subtitle: Subtitle | null) => void;
  showThirdsGuide?: boolean;
  onThirdsGuideToggle?: () => void;
  showDevinGuide?: boolean;
  onDevinGuideToggle?: () => void;
  showMetaInfo?: boolean;
  onMetaInfoToggle?: () => void;
}

type TimelineRowKey = `subtitle:${string}` | 'video' | `audio:${string}`;

type TimelineRowDescriptor =
  | { key: `subtitle:${string}`; kind: 'subtitle'; label: string; track: SubtitleTrack }
  | { key: 'video'; kind: 'video'; label: 'video' }
  | { key: `audio:${string}`; kind: 'audio'; label: string; track: AudioTrack };

interface TimelineRowHeightState {
  projectId: string | null;
  overrides: Partial<Record<TimelineRowKey, number>>;
}

export function Timeline({
  onSubtitleClick,
  showThirdsGuide = false,
  onThirdsGuideToggle,
  showDevinGuide = false,
  onDevinGuideToggle,
  showMetaInfo = false,
  onMetaInfoToggle,
}: TimelineProps) {
  const projectId = useProjectStore((state) => state.activeProject?.id ?? null);
  const { duration, fps, onTimeUpdate, onPlayPause } = usePlaybackStore(
    useShallow(selectTimelinePlaybackStructure),
  );
  const {
    zoomLevel, setZoom, tracks, addTrack, pixelsPerSecond,
    activeTrackId, setActiveTrackId, snapEnabled, setSnapEnabled,
    cuts, isDragging, videoSources, videoClips, selectedClipId,
    audioSources, audioTracks, renderProfile, transientSelection,
    splitSelectedMediaAtFrame, deleteSelectedMedia, reorderVideoClips, addAudioTrack,
  } = useTimelineStore(useShallow((state) => ({
    zoomLevel: state.zoomLevel,
    setZoom: state.setZoom,
    tracks: state.tracks,
    addTrack: state.addTrack,
    pixelsPerSecond: state.pixelsPerSecond,
    activeTrackId: state.activeTrackId,
    setActiveTrackId: state.setActiveTrackId,
    snapEnabled: state.snapEnabled,
    setSnapEnabled: state.setSnapEnabled,
    cuts: state.cuts,
    isDragging: state.isDragging,
    videoSources: state.videoSources,
    videoClips: state.videoClips,
    selectedClipId: state.selectedClipId,
    audioSources: state.audioSources,
    audioTracks: state.audioTracks,
    renderProfile: state.renderProfile,
    transientSelection: state.transientSelection,
    splitSelectedMediaAtFrame: state.splitSelectedMediaAtFrame,
    deleteSelectedMedia: state.deleteSelectedMedia,
    reorderVideoClips: state.reorderVideoClips,
    addAudioTrack: state.addAudioTrack,
  })));
  const clipPlacements = useMemo(
    () => buildClipPlacements(videoClips, renderProfile.fps),
    [renderProfile.fps, videoClips],
  );
  const selectedClipIndex = selectedClipId
    ? videoClips.findIndex((clip) => clip.id === selectedClipId)
    : -1;
  const hasSelectedMedia = transientSelection.kind === 'video-clip' || transientSelection.kind === 'audio-clip';

  const tracksContentRef = useRef<HTMLDivElement>(null);
  const rulerContentRef = useRef<HTMLDivElement>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const isSyncingRef = useRef(false);
  const virtualScrollLeftRef = useRef(0);
  const pendingScrollRef = useRef<number | null>(null);
  const effectivePixelsPerSecond = pixelsPerSecond * zoomLevel;
  const [requestedWaveformReferences, setRequestedWaveformReferences] = useState<AudioMediaReference[]>([]);
  const [horizontalScrollbarHeight, setHorizontalScrollbarHeight] = useState(0);
  const [rowHeightState, setRowHeightState] = useState<TimelineRowHeightState>({
    projectId,
    overrides: {},
  });
  const rowHeightOverrides = useMemo(() => (
    rowHeightState.projectId === projectId ? rowHeightState.overrides : {}
  ), [projectId, rowHeightState]);
  const timelineRows = useMemo<TimelineRowDescriptor[]>(() => [
    ...tracks.map((track) => ({
      key: `subtitle:${track.id}` as const,
      kind: 'subtitle' as const,
      label: track.name,
      track,
    })),
    { key: 'video', kind: 'video', label: 'video' },
    ...audioTracks.map((track) => ({
      key: `audio:${track.id}` as const,
      kind: 'audio' as const,
      label: track.name,
      track,
    })),
  ], [audioTracks, tracks]);
  const getRowHeight = useCallback((rowKey: TimelineRowKey) => (
    rowHeightOverrides[rowKey] ?? DEFAULT_TIMELINE_ROW_HEIGHT
  ), [rowHeightOverrides]);
  const setRowHeight = useCallback((rowKey: TimelineRowKey, requestedHeight: number) => {
    const nextHeight = clampTimelineRowHeight(requestedHeight);
    setRowHeightState((current) => {
      const currentOverrides = current.projectId === projectId ? current.overrides : {};
      if ((currentOverrides[rowKey] ?? DEFAULT_TIMELINE_ROW_HEIGHT) === nextHeight) return current;
      return {
        projectId,
        // Missing rows deliberately remain in this sparse map so undo can restore their visual
        // height during the same editor session without polluting the durable project document.
        overrides: { ...currentOverrides, [rowKey]: nextHeight },
      };
    });
  }, [projectId]);

  useLayoutEffect(() => {
    // Ignore stale overrides during render, then atomically replace them before paint when the
    // active project changes. The project ID also keys every live resize handle below.
    setRowHeightState((current) => current.projectId === projectId
      ? current
      : { projectId, overrides: {} });
  }, [projectId]);

  const updateVisibleWaveformRange = useCallback(() => {
    const tracksElement = tracksContentRef.current;
    if (!tracksElement || effectivePixelsPerSecond <= 0) return;
    const visibleStart = tracksElement.scrollLeft / effectivePixelsPerSecond;
    const visibleEnd = (tracksElement.scrollLeft + tracksElement.clientWidth) / effectivePixelsPerSecond;
    const nextReferences = getVisibleVideoAudioReferences(
      videoClips,
      renderProfile.fps,
      visibleStart,
      visibleEnd,
    );
    audioTracks.forEach((track) => track.clips.forEach((clip) => {
      const visual = getAudioClipVisualData(clip, renderProfile.fps, videoSources, audioSources);
      if (!visual) return;
      const clipStart = framesToSeconds(clip.timelineStartFrame, renderProfile.fps);
      const clipEnd = framesToSeconds(clip.timelineStartFrame + visual.durationFrames, renderProfile.fps);
      if (clipEnd <= visibleStart || clipStart >= visibleEnd) return;
      nextReferences.push(clip.source);
    }));

    const uniqueReferences = nextReferences.filter((reference, index, references) => {
      const key = getAudioMediaCacheKey(reference);
      return references.findIndex((candidate) => getAudioMediaCacheKey(candidate) === key) === index;
    });
    // Scrolling within the same clips must not restart an in-flight waveform decode.
    setRequestedWaveformReferences((currentReferences) => {
      const currentKeys = currentReferences.map(getAudioMediaCacheKey);
      const nextKeys = uniqueReferences.map(getAudioMediaCacheKey);
      return currentKeys.length === nextKeys.length
        && currentKeys.every((key, index) => key === nextKeys[index])
        ? currentReferences
        : uniqueReferences;
    });
  }, [audioSources, audioTracks, effectivePixelsPerSecond, renderProfile.fps, videoClips, videoSources]);

  useEffect(() => {
    const tracksElement = tracksContentRef.current;
    if (!tracksElement) return;

    // Measure once after mount so the initial viewport is requested before the user scrolls.
    updateVisibleWaveformRange();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateVisibleWaveformRange);
      return () => window.removeEventListener('resize', updateVisibleWaveformRange);
    }

    const observer = new ResizeObserver(updateVisibleWaveformRange);
    observer.observe(tracksElement);
    return () => observer.disconnect();
  }, [duration, updateVisibleWaveformRange]);

  const { peaksByMediaKey } = useAudioWaveforms(videoSources, audioSources, requestedWaveformReferences);

  useEffect(() => {
    const tracksElement = tracksContentRef.current;
    if (!tracksElement) return;
    const measureHorizontalScrollbar = () => {
      const measuredHeight = Math.max(0, tracksElement.offsetHeight - tracksElement.clientHeight);
      setHorizontalScrollbarHeight((current) => current === measuredHeight ? current : measuredHeight);
    };
    measureHorizontalScrollbar();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measureHorizontalScrollbar);
      return () => window.removeEventListener('resize', measureHorizontalScrollbar);
    }
    const observer = new ResizeObserver(measureHorizontalScrollbar);
    observer.observe(tracksElement);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const tracksElement = tracksContentRef.current;
    const sidebarElement = sidebarContentRef.current;
    if (!tracksElement || !sidebarElement) return;
    // The sidebar receives bottom padding equal to the real horizontal scrollbar gutter. Clamp
    // against the content scroller after every geometry change, then publish the exact same
    // vertical offset so both independently rendered columns remain aligned at their lower edge.
    const maximumScrollTop = Math.max(0, tracksElement.scrollHeight - tracksElement.clientHeight);
    const nextScrollTop = Math.min(tracksElement.scrollTop, maximumScrollTop);
    tracksElement.scrollTop = nextScrollTop;
    sidebarElement.scrollTop = nextScrollTop;
  }, [horizontalScrollbarHeight, rowHeightState, timelineRows]);



  // Scroll synchronization
  const handleScroll = (source: 'ruler' | 'tracks') => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;

    const tracksEl = tracksContentRef.current;
    const rulerEl = rulerContentRef.current;
    const sidebarEl = sidebarContentRef.current;
    const playheadSyncEl = document.getElementById('timeline-playhead-sync')?.parentElement; // El contenedor overflow-hidden

    if (source === 'tracks' && tracksEl && rulerEl) {
      rulerEl.scrollLeft = tracksEl.scrollLeft;
      virtualScrollLeftRef.current = tracksEl.scrollLeft;
      if (playheadSyncEl) playheadSyncEl.scrollLeft = tracksEl.scrollLeft;
    } else if (source === 'ruler' && rulerEl && tracksEl) {
      tracksEl.scrollLeft = rulerEl.scrollLeft;
      virtualScrollLeftRef.current = rulerEl.scrollLeft;
      if (playheadSyncEl) playheadSyncEl.scrollLeft = rulerEl.scrollLeft;
    }

    if (tracksEl && sidebarEl) {
      sidebarEl.scrollTop = tracksEl.scrollTop;
    }

    isSyncingRef.current = false;
    updateVisibleWaveformRange();
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  const timelineWidth = Math.max(1, duration * pixelsPerSecond * zoomLevel);

  // Sync refs for wheel handler to avoid effect re-runs
  const currentTimeRef = useRef(usePlaybackStore.getState().currentTime);
  const ppsRef = useRef(pixelsPerSecond);
  useEffect(() => {
    ppsRef.current = pixelsPerSecond;
  }, [pixelsPerSecond]);
  useEffect(() => usePlaybackStore.subscribe((state, previous) => {
    if (state.currentTime !== previous.currentTime) currentTimeRef.current = state.currentTime;
  }), []);

  // Apply pending scroll after zoom render
  useLayoutEffect(() => {
    if (pendingScrollRef.current !== null && tracksContentRef.current) {
      tracksContentRef.current.scrollLeft = pendingScrollRef.current;
      if (rulerContentRef.current) {
        rulerContentRef.current.scrollLeft = pendingScrollRef.current;
      }
      virtualScrollLeftRef.current = pendingScrollRef.current;
      pendingScrollRef.current = null;
    }
  }, [zoomLevel]);

  const applySmartZoom = useCallback((newZoom: number) => {
    if (newZoom === zoomLevel) return;

    // Smart Zoom Logic: anchor to playhead position
    const oldPPS = ppsRef.current * zoomLevel;
    const newPPS = ppsRef.current * newZoom;

    // Usamos el scroll virtual para evitar saltos si el DOM aún no se ha actualizado
    const currentScrollLeft = virtualScrollLeftRef.current;

    // Posición del cabezal relativa al viewport antes del zoom
    const playheadScreenPosition = (currentTimeRef.current * oldPPS) - currentScrollLeft;

    // Calculamos el nuevo scroll necesario para mantener esa posición de pantalla
    const newScrollLeft = Math.round((currentTimeRef.current * newPPS) - playheadScreenPosition);

    pendingScrollRef.current = newScrollLeft;
    setZoom(newZoom);
  }, [zoomLevel, setZoom]);

  // Zoom handling with non-passive listener to ensure preventDefault works
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleWheelRaw = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();

        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.max(0.1, Math.min(10, zoomLevel * delta));
        applySmartZoom(newZoom);
      }
    };

    el.addEventListener('wheel', handleWheelRaw, { passive: false });
    return () => el.removeEventListener('wheel', handleWheelRaw);
  }, [zoomLevel, applySmartZoom]);

  // Auto-scroll while dragging logic
  useEffect(() => {
    if (!isDragging) return;

    let rafId: number;
    let lastTime = performance.now();
    const SCROLL_THRESHOLD = 80; // Pixels from edge
    const MAX_SPEED = 1500; // Pixels per second at max speed
    let mouseX = 0;

    const handleMouseMove = (e: MouseEvent) => {
      mouseX = e.clientX;
    };

    const updateScroll = (now: number) => {
      const tracksEl = tracksContentRef.current;
      if (!tracksEl) return;

      const rect = tracksEl.getBoundingClientRect();
      const delta = (now - lastTime) / 1000;
      lastTime = now;

      const distLeft = mouseX - rect.left;
      const distRight = rect.right - mouseX;

      let speed = 0;
      if (distLeft < SCROLL_THRESHOLD && distLeft > -50) {
        // Scroll left
        const intensity = Math.pow(1 - Math.max(0, distLeft) / SCROLL_THRESHOLD, 2);
        speed = -MAX_SPEED * intensity;
      } else if (distRight < SCROLL_THRESHOLD && distRight > -50) {
        // Scroll right
        const intensity = Math.pow(1 - Math.max(0, distRight) / SCROLL_THRESHOLD, 2);
        speed = MAX_SPEED * intensity;
      }

      if (speed !== 0) {
        const newScrollLeft = tracksEl.scrollLeft + speed * delta;
        const maxScroll = tracksEl.scrollWidth - tracksEl.clientWidth;
        const finalScroll = Math.max(0, Math.min(newScrollLeft, maxScroll));

        tracksEl.scrollLeft = finalScroll;

        // Sync other elements
        if (rulerContentRef.current) {
          rulerContentRef.current.scrollLeft = finalScroll;
        }
        const playheadSyncEl = document.getElementById('timeline-playhead-sync')?.parentElement;
        if (playheadSyncEl) {
          playheadSyncEl.scrollLeft = finalScroll;
        }
        virtualScrollLeftRef.current = finalScroll;

        // Force re-calculation in components if speed is significant
        // Dispatching a fake mousemove event to trigger their listeners
        window.dispatchEvent(new MouseEvent('mousemove', {
          clientX: mouseX,
          clientY: 0 // Y doesn't affect X time calculation
        }));
      }

      rafId = requestAnimationFrame(updateScroll);
    };

    window.addEventListener('mousemove', handleMouseMove);
    rafId = requestAnimationFrame(updateScroll);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      cancelAnimationFrame(rafId);
    };
  }, [isDragging]);

  const handleZoomIn = () => {
    const newZoom = Math.min(10, zoomLevel * 1.2);
    applySmartZoom(newZoom);
  };

  const handleZoomOut = () => {
    const newZoom = Math.max(0.1, zoomLevel / 1.2);
    applySmartZoom(newZoom);
  };

  const handleResetZoom = () => {
    if (tracksContentRef.current && duration > 0) {
      const availableWidth = tracksContentRef.current.clientWidth;
      // Subtract buffer
      const newZoom = (availableWidth - 50) / (duration * pixelsPerSecond);
      setZoom(Math.max(0.1, newZoom));
    }
  };

  const scrollToTime = useCallback((time: number) => {
    const tracksEl = tracksContentRef.current;
    if (!tracksEl) return;

    const pps = pixelsPerSecond * zoomLevel;
    const playheadX = time * pps;
    const viewportWidth = tracksEl.clientWidth;
    const scrollLeft = tracksEl.scrollLeft;

    // Solo hacemos scroll si el cabezal está FUERA del área visible
    // Usamos un margen de 2px para considerar "fuera"
    const isVisible = playheadX >= scrollLeft + 2 && playheadX <= scrollLeft + viewportWidth - 2;

    if (!isVisible) {
      // El objetivo es que playheadX quede a viewportWidth / 2 de distancia del borde izquierdo
      const targetScrollLeft = Math.round(playheadX - viewportWidth / 2);

      const maxScroll = Math.max(0, tracksEl.scrollWidth - viewportWidth);
      const FinalScrollLeft = Math.max(0, Math.min(maxScroll, targetScrollLeft));

      // Usamos scroll instantáneo para evitar que múltiples eventos de teclado colisionen con la animación
      tracksEl.scrollLeft = FinalScrollLeft;

      // Sincronizamos manualmente para garantizar respuesta inmediata en todos los elementos dependientes
      if (rulerContentRef.current) {
        rulerContentRef.current.scrollLeft = FinalScrollLeft;
      }
      const playheadSyncEl = document.getElementById('timeline-playhead-sync')?.parentElement;
      if (playheadSyncEl) {
        playheadSyncEl.scrollLeft = FinalScrollLeft;
      }
      virtualScrollLeftRef.current = FinalScrollLeft;
    }
  }, [pixelsPerSecond, zoomLevel]);

  const memoizedKeyPoints = useMemo(() => {
    const mediaDuration = getTimelineDurations(videoClips, tracks).mediaDuration;

    const keyPoints = new Set<number>([0, mediaDuration, duration]);
    clipPlacements.forEach((placement) => {
      keyPoints.add(placement.projectStart);
      keyPoints.add(placement.projectEnd);
    });
    audioTracks.forEach((track) => track.clips.forEach((clip) => {
      const visual = getAudioClipVisualData(clip, renderProfile.fps, videoSources, audioSources);
      if (!visual) return;
      keyPoints.add(framesToSeconds(clip.timelineStartFrame, renderProfile.fps));
      keyPoints.add(framesToSeconds(clip.timelineStartFrame + visual.durationFrames, renderProfile.fps));
    }));
    tracks.forEach(track => {
      track.subtitles.forEach(s => {
        // Guardamos con precisión de ms
        keyPoints.add(Math.round(s.startTime * 1000) / 1000);
        keyPoints.add(Math.round(s.endTime * 1000) / 1000);
      });
    });
    return Array.from(keyPoints).sort((a, b) => a - b);
  }, [audioSources, audioTracks, clipPlacements, duration, renderProfile.fps, tracks, videoClips, videoSources]);

  // Keyboard navigation (Frame-by-Frame)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // No interferir si el usuario está escribiendo en un input o textarea
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      if (e.key === ' ') {
        e.preventDefault();
        onPlayPause();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const frameDuration = fps > 0 ? 1 / fps : 1 / 30;
        const multiplier = e.shiftKey ? 5 : 1;
        const delta = e.key === 'ArrowRight' ? frameDuration * multiplier : -frameDuration * multiplier;

        const newTime = Math.max(0, Math.min(duration, currentTimeRef.current + delta));

        // Cuantizar el tiempo al frame más cercano para evitar derivas
        const snappedTime = Math.round(newTime / frameDuration) * frameDuration;

        onTimeUpdate(snappedTime);
        scrollToTime(snappedTime);

        // Prevenir scroll lateral del navegador con las flechas si fuera necesario
        e.preventDefault();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Navegación por Puntos Clave
        // Pre-calculado con useMemo para evitar lag en cada tecla
        const sortedPoints = memoizedKeyPoints;
        const current = currentTimeRef.current;
        const EPSILON = 0.0005;

        const frameDuration = fps > 0 ? 1 / fps : 1 / 30;

        if (e.key === 'ArrowDown') {
          // Siguiente punto clave: buscamos el primero que sea mayor que el actual + epsilon
          const next = sortedPoints.find(p => p > current + EPSILON);
          if (next !== undefined) {
            const snappedNext = Math.round(next / frameDuration) * frameDuration;
            onTimeUpdate(snappedNext);
            scrollToTime(snappedNext);
          }
        } else {
          // Anterior punto clave: buscamos el último que sea menor que el actual - epsilon
          const prevIndex = sortedPoints.findLastIndex(p => p < current - EPSILON);
          if (prevIndex !== -1) {
            const prev = sortedPoints[prevIndex];
            const snappedPrev = Math.round(prev / frameDuration) * frameDuration;
            onTimeUpdate(snappedPrev);
            scrollToTime(snappedPrev);
          }
        }

        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fps, duration, onTimeUpdate, onPlayPause, memoizedKeyPoints, scrollToTime]);

  return (
    <div
      ref={containerRef}
      className="h-full flex flex-col bg-gray-900 border border-gray-800 rounded-lg min-w-0 overflow-hidden"
    >
      {/* Toolbar */}
      <div className="h-11 flex-none flex items-center gap-2 px-2 bg-gray-800/50 border-b border-gray-800 relative z-30 overflow-x-auto">
        <TimelinePlaybackStatus formatTime={formatTime} />

        <div className="flex gap-1 ml-auto">
          <div className="flex items-center gap-1">
            <span className="text-xs font-mono text-gray-400 mr-2 w-10 text-right">{(zoomLevel * 100).toFixed(0)}%</span>
            <Button variant="secondary" onClick={handleZoomOut} title="Zoom out">
              <ZoomOut className="w-[18px] h-[18px]" />
            </Button>
            <Button variant="secondary" onClick={handleZoomIn} title="Zoom in">
              <ZoomIn className="w-[18px] h-[18px]" />
            </Button>
            <Button variant="secondary" onClick={handleResetZoom} title="Fit timeline to view">
              <RotateCcw className="w-[18px] h-[18px]" />
            </Button>
          </div>
          <div className="w-px h-6 bg-gray-800 mx-1" />

          <OverlayMenu
            showThirdsGuide={showThirdsGuide}
            onThirdsGuideToggle={() => onThirdsGuideToggle?.()}
            showDevinGuide={showDevinGuide}
            onDevinGuideToggle={() => onDevinGuideToggle?.()}
            showMetaInfo={showMetaInfo}
            onMetaInfoToggle={() => onMetaInfoToggle?.()}
          />
          <VideoCutPopover />
          <Button
            variant="secondary"
            data-testid="split-selected-media"
            onClick={() => splitSelectedMediaAtFrame(secondsToFrames(
              usePlaybackStore.getState().currentTime,
              renderProfile.fps,
              'nearest',
            ))}
            disabled={!hasSelectedMedia}
            title="Split selected media at playhead"
          >
            <Scissors className="w-[18px] h-[18px]" />
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              if (selectedClipIndex <= 0) return;
              const ids = videoClips.map((clip) => clip.id);
              [ids[selectedClipIndex - 1], ids[selectedClipIndex]] = [ids[selectedClipIndex], ids[selectedClipIndex - 1]];
              reorderVideoClips(ids);
            }}
            disabled={selectedClipIndex <= 0}
            title="Move selected clip left"
          >
            <ChevronLeft className="w-[18px] h-[18px]" />
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              if (selectedClipIndex < 0 || selectedClipIndex >= videoClips.length - 1) return;
              const ids = videoClips.map((clip) => clip.id);
              [ids[selectedClipIndex], ids[selectedClipIndex + 1]] = [ids[selectedClipIndex + 1], ids[selectedClipIndex]];
              reorderVideoClips(ids);
            }}
            disabled={selectedClipIndex < 0 || selectedClipIndex >= videoClips.length - 1}
            title="Move selected clip right"
          >
            <ChevronRight className="w-[18px] h-[18px]" />
          </Button>
          <Button
            variant="danger"
            data-testid="delete-selected-media"
            onClick={deleteSelectedMedia}
            disabled={!hasSelectedMedia}
            title="Delete selected media"
          >
            <Trash2 className="w-[18px] h-[18px]" />
          </Button>
          <Button variant="secondary" isActive={snapEnabled} onClick={() => setSnapEnabled(!snapEnabled)} title="Snap">
            <Magnet className="w-[18px] h-[18px]" />
          </Button>
          <div className="w-px h-6 bg-gray-800 mx-1" />
          <Button variant="secondary" onClick={() => addTrack()} title="Add subtitle track">
            <Plus className="w-[18px] h-[18px]" />
          </Button>
          <Button variant="secondary" onClick={() => addAudioTrack()} title="Add audio track">
            <Headphones className="w-[18px] h-[18px]" />
            <Plus className="w-3 h-3" />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 relative">
        {/* Track Labels Sidebar */}
        <div className="w-48 flex-none border-r border-gray-800 bg-gray-900 z-20 flex flex-col">
          {/* Header spacer for ruler */}
          <div className="h-8 border-b border-gray-800 bg-gray-900 flex items-center px-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider">

          </div>
          <div
            ref={sidebarContentRef}
            className="flex-1 overflow-hidden bg-gray-900/50"
            data-testid="timeline-sidebar-scroll"
            style={{ paddingBottom: horizontalScrollbarHeight }}
          >
            {timelineRows.map((row) => {
              const rowHeight = getRowHeight(row.key);
              return (
                <div
                  key={row.key}
                  className="relative flex-none"
                  style={{ height: rowHeight }}
                  data-testid="timeline-row-header"
                  data-row-key={row.key}
                  data-row-kind={row.kind}
                >
                  {row.kind === 'subtitle' && (
                    <MemoizedTimelineTrackHeader
                      track={row.track}
                      isActive={row.track.id === activeTrackId}
                      onClick={() => setActiveTrackId(row.track.id)}
                      onToggleVisibility={(id) => {
                        const { tracks, setTracks } = useTimelineStore.getState();
                        setTracks(tracks.map((track) => track.id === id
                          ? { ...track, isVisible: !track.isVisible }
                          : track));
                      }}
                    />
                  )}
                  {row.kind === 'video' && (
                    <div className="flex h-full items-center border-b border-gray-800 bg-gray-900 px-4 text-[10px] font-bold uppercase tracking-wider text-blue-300">
                      Video
                    </div>
                  )}
                  {row.kind === 'audio' && <TimelineAudioTrackHeader track={row.track} />}
                  <TimelineRowResizeHandle
                    key={`${projectId ?? 'no-project'}:${row.key}`}
                    rowKey={row.key}
                    rowKind={row.kind}
                    label={row.label}
                    height={rowHeight}
                    projectId={projectId}
                    onHeightChange={(nextHeight) => setRowHeight(row.key, nextHeight)}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Timeline Content Area */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
          {/* Global Playhead Overlay (covers ruler and tracks) */}
          <div
            className="absolute inset-0 pointer-events-none z-50 overflow-hidden"
            style={{ left: 0 }}
          >
            <div
              id="timeline-playhead-sync"
              className="relative h-full"
              style={{ width: timelineWidth }}
            >
              <MemoizedTimelinePlayhead
                duration={duration}
                fps={fps}
                zoomLevel={zoomLevel}
                pixelsPerSecond={pixelsPerSecond}
                onTimeUpdate={onTimeUpdate}
              />
            </div>
          </div>

          {/* Ruler */}
          <div
            ref={rulerContentRef}
            className="h-8 border-b border-gray-800 overflow-hidden bg-gray-900 relative z-0"
            onScroll={() => handleScroll('ruler')}
          >
            <MemoizedTimelineRuler
              duration={duration}
              fps={fps}
              zoomLevel={zoomLevel}
              pixelsPerSecond={pixelsPerSecond}
              onTimeUpdate={onTimeUpdate}
            />
          </div>

          {/* Tracks Area */}
          <div
            ref={tracksContentRef}
            className="flex-1 overflow-x-scroll overflow-y-scroll relative scrollbar-thin scrollbar-thumb-gray-700 z-10"
            data-testid="timeline-tracks-scroll"
            style={{
              scrollbarGutter: 'stable'
            }}
            onScroll={() => handleScroll('tracks')}
          >
            <div
              className="relative"
              style={{
                width: timelineWidth,
                minHeight: '100%',
              }}
            >
              {/* Snapping Indicator (inside relative container to scroll) */}
              <TimelineSnapIndicator pixelsPerSecond={pixelsPerSecond * zoomLevel} />
              {/* Visual Cuts */}
              <div className="absolute inset-0 pointer-events-none z-0">
                {cuts.map((cut, idx) => (
                  <div
                    key={`cut-${idx}`}
                    className="absolute top-0 bottom-0 w-px bg-white/10"
                    style={{ left: `${cut.timeSec * pixelsPerSecond * zoomLevel}px` }}
                  />
                ))}
              </div>

              {timelineRows.map((row) => (
                <div
                  key={row.key}
                  className={`relative flex-none ${row.kind === 'video' ? 'border-b border-gray-800/50' : ''}`}
                  style={{ height: getRowHeight(row.key) }}
                  data-testid="timeline-row-content"
                  data-row-key={row.key}
                  data-row-kind={row.kind}
                  data-subtitle-track-id={row.kind === 'subtitle' ? row.track.id : undefined}
                >
                  {row.kind === 'subtitle' && (
                    <MemoizedTimelineTrackOverlay
                      duration={duration}
                      track={row.track}
                      zoomLevel={zoomLevel}
                      pixelsPerSecond={pixelsPerSecond}
                      fps={fps}
                      onTimeUpdate={onTimeUpdate}
                      onSubtitleClick={onSubtitleClick}
                    />
                  )}
                  {row.kind === 'video' && (
                    <TimelineVideoTrack peaksByMediaKey={peaksByMediaKey} />
                  )}
                  {row.kind === 'audio' && (
                    <TimelineAudioTrack
                      track={row.track}
                      allTracks={audioTracks}
                      videoSources={videoSources}
                      audioSources={audioSources}
                      frameRate={renderProfile.fps}
                      pixelsPerSecond={pixelsPerSecond * zoomLevel}
                      peaksByMediaKey={peaksByMediaKey}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Keeps frame-clock updates inside the small toolbar fragment instead of repainting all rows. */
function TimelinePlaybackStatus({ formatTime }: { formatTime: (seconds: number) => string }) {
  const { currentTime, contentDuration, isPlaying, toggle } = usePlaybackStore(
    useShallow(selectTimelinePlaybackStatus),
  );

  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          variant={isPlaying ? 'primary' : 'secondary'}
          onClick={toggle}
          aria-label={isPlaying ? 'Pause timeline' : 'Play timeline'}
          data-testid="timeline-playback-toggle"
        >
          {isPlaying ? <Pause className="w-[18px] h-[18px]" /> : <Play className="w-[18px] h-[18px]" />}
        </Button>
      </div>
      <div className="flex items-center gap-4 text-xs font-mono text-gray-400">
        <div>
          <span
            className="text-blue-400"
            data-testid="timeline-current-time"
            data-time-seconds={currentTime.toFixed(6)}
          >
            {formatTime(currentTime)}
          </span>
          <span className="mx-1 text-gray-600">/</span>
          <span>{formatTime(contentDuration)}</span>
        </div>
      </div>
    </>
  );
}

/** Drag-time snap updates stay local instead of rebuilding every timeline row. */
function TimelineSnapIndicator({ pixelsPerSecond }: { pixelsPerSecond: number }) {
  const activeSnapTime = useTimelineStore((state) => state.activeSnapTime);
  if (activeSnapTime === null) return null;
  return (
    <div
      className="absolute top-0 bottom-0 w-px bg-cyan-400/50 z-30 pointer-events-none"
      style={{
        left: `${Math.round(activeSnapTime * pixelsPerSecond)}px`,
        boxShadow: '0 0 10px 2px rgba(34, 211, 238, 0.3)',
      }}
    />
  );
}
