'use client';

import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, memo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Subtitle, SubtitleTrack } from '@/types/timeline';
import type { AudioTrack, VideoTrack } from '@/types/video';
import { Captions, ChevronLeft, ChevronRight, Clapperboard, Headphones, Plus, RotateCcw, Scissors, Trash2, ZoomIn, ZoomOut, Magnet } from 'lucide-react';
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
import { TimelineVideoTrack, type VideoTrackDragPreview } from './TimelineVideoTrack';
import { TimelineAudioTrack, getAudioClipVisualData } from './TimelineAudioTrack';
import { TimelineAudioTrackHeader } from './TimelineAudioTrackHeader';
import { TimelineRowResizeHandle } from './TimelineRowResizeHandle';
import { VideoCutDialog } from './VideoCutDialog';
import { buildClipPlacements } from '@/lib/video-timeline';
import { getVisibleVideoAudioReferences } from '@/lib/video-waveform';
import { getAudioMediaCacheKey, type AudioMediaReference } from '@/lib/media-asset-ref';
import { isTextEditingKeyboardTarget } from '@/lib/keyboard-target';
import { framesToSeconds, secondsToFrames } from '@/lib/render-profile';
import {
  DEFAULT_TIMELINE_ROW_HEIGHT,
  clampTimelineRowHeight,
} from '@/lib/editor-layout';
import { selectTimelinePlaybackStructure } from './playback-selectors';
import { TimelineVideoTrackHeader } from './TimelineVideoTrackHeader';
import { formatShortcutTitle, getShortcutAriaKeys } from '@/config/shortcuts';
import {
  buildAudioClipSnapPoints,
  buildVideoClipSnapPoints,
  type TimelineSnapPoint,
} from '@/lib/timeline-snap';
import type { VideoCutDetectionRequest } from '@/lib/video-cut/targets';

interface TimelineProps {
  onSubtitleClick?: (subtitle: Subtitle | null) => void;
  showThirdsGuide?: boolean;
  onThirdsGuideToggle?: () => void;
  showDevinGuide?: boolean;
  onDevinGuideToggle?: () => void;
  showMetaInfo?: boolean;
  onMetaInfoToggle?: () => void;
}

type TimelineRowKey = `subtitle:${string}` | `video:${string}` | `audio:${string}`;

type TimelineRowDescriptor =
  | { key: `subtitle:${string}`; kind: 'subtitle'; label: string; track: SubtitleTrack }
  | { key: `video:${string}`; kind: 'video'; label: string; track: VideoTrack; videoTrackIndex: number }
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
  const { duration, fps, onTimeUpdate } = usePlaybackStore(
    useShallow(selectTimelinePlaybackStructure),
  );
  const {
    zoomLevel, setZoom, tracks, addTrack, pixelsPerSecond,
    activeTrackId, setActiveTrackId, snapEnabled, setSnapEnabled,
    cuts, isDragging, videoSources, videoClips, videoTracks, selectedClipId,
    audioSources, audioTracks, renderProfile, transientSelection,
    splitSelectedMediaAtFrame, deleteSelectedMedia, reorderVideoClips, addAudioTrack,
    addVideoTrack, removeVideoTrack, selectClip,
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
    videoTracks: state.videoTracks,
    selectedClipId: state.selectedClipId,
    audioSources: state.audioSources,
    audioTracks: state.audioTracks,
    renderProfile: state.renderProfile,
    transientSelection: state.transientSelection,
    splitSelectedMediaAtFrame: state.splitSelectedMediaAtFrame,
    deleteSelectedMedia: state.deleteSelectedMedia,
    reorderVideoClips: state.reorderVideoClips,
    addAudioTrack: state.addAudioTrack,
    addVideoTrack: state.addVideoTrack,
    removeVideoTrack: state.removeVideoTrack,
    selectClip: state.selectClip,
  })));
  const clipPlacements = useMemo(
    () => buildClipPlacements(videoClips, renderProfile.fps),
    [renderProfile.fps, videoClips],
  );
  const selectedClipIndex = selectedClipId
    ? videoClips.findIndex((clip) => clip.id === selectedClipId)
    : -1;
  const hasSelectedMedia = transientSelection.kind === 'video-clip' || transientSelection.kind === 'audio-clip';
  const mediaSnapPoints = useMemo<TimelineSnapPoint[]>(() => {
    const points: TimelineSnapPoint[] = [{ frame: 0, ownerKey: 'timeline:start' }];
    points.push(...buildVideoClipSnapPoints(videoClips, renderProfile.fps));
    tracks.forEach((track) => track.subtitles.forEach((subtitle) => {
      points.push(
        {
          frame: secondsToFrames(subtitle.startTime, renderProfile.fps, 'nearest'),
          ownerKey: `subtitle:${subtitle.id}`,
        },
        {
          frame: secondsToFrames(subtitle.endTime, renderProfile.fps, 'nearest'),
          ownerKey: `subtitle:${subtitle.id}`,
        },
      );
    }));
    points.push(...buildAudioClipSnapPoints(
      audioTracks,
      renderProfile.fps,
      videoSources,
      audioSources,
    ));
    return points;
  }, [audioSources, audioTracks, renderProfile.fps, tracks, videoClips, videoSources]);

  const tracksContentRef = useRef<HTMLDivElement>(null);
  const rulerContentRef = useRef<HTMLDivElement>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const isSyncingRef = useRef(false);
  const virtualScrollLeftRef = useRef(0);
  const pendingScrollRef = useRef<number | null>(null);
  const effectivePixelsPerSecond = pixelsPerSecond * zoomLevel;
  const [requestedWaveformReferences, setRequestedWaveformReferences] = useState<AudioMediaReference[]>([]);
  const [horizontalScrollbarHeight, setHorizontalScrollbarHeight] = useState(0);
  const [videoTrackDragPreview, setVideoTrackDragPreview] = useState<VideoTrackDragPreview | null>(null);
  const [selectedVideoClipIds, setSelectedVideoClipIds] = useState<string[]>(
    selectedClipId ? [selectedClipId] : [],
  );
  const [cutDetectionRequest, setCutDetectionRequest] = useState<VideoCutDetectionRequest | null>(null);
  const [rowHeightState, setRowHeightState] = useState<TimelineRowHeightState>({
    projectId,
    overrides: {},
  });
  const rowHeightOverrides = useMemo(() => (
    rowHeightState.projectId === projectId ? rowHeightState.overrides : {}
  ), [projectId, rowHeightState]);
  useEffect(() => {
    const existing = new Set(videoClips.map((clip) => clip.id));
    setSelectedVideoClipIds((current) => {
      if (!selectedClipId) return [];
      const valid = current.filter((clipId) => existing.has(clipId));
      return valid.includes(selectedClipId) ? valid : [selectedClipId];
    });
  }, [selectedClipId, videoClips]);
  const changeVideoClipSelection = useCallback((clipId: string, additive: boolean) => {
    if (!videoClips.some((clip) => clip.id === clipId)) return;
    const next = additive
      ? selectedVideoClipIds.includes(clipId)
        ? selectedVideoClipIds.filter((selectedId) => selectedId !== clipId)
        : [...selectedVideoClipIds, clipId]
      : [clipId];
    setSelectedVideoClipIds(next);
    selectClip(next.includes(clipId) ? clipId : next.at(-1) ?? null);
  }, [selectClip, selectedVideoClipIds, videoClips]);
  const clearVideoClipSelection = useCallback(() => {
    setSelectedVideoClipIds([]);
    selectClip(null);
  }, [selectClip]);
  const timelineRows = useMemo<TimelineRowDescriptor[]>(() => [
    ...tracks.map((track) => ({
      key: `subtitle:${track.id}` as const,
      kind: 'subtitle' as const,
      label: track.name,
      track,
    })),
    ...videoTracks.map((track, videoTrackIndex) => ({
      key: `video:${track.id}` as const,
      kind: 'video' as const,
      label: track.name,
      track,
      videoTrackIndex,
    })),
    ...audioTracks.map((track) => ({
      key: `audio:${track.id}` as const,
      kind: 'audio' as const,
      label: track.name,
      track,
    })),
  ], [audioTracks, tracks, videoTracks]);
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
    const mediaDuration = clipPlacements[clipPlacements.length - 1]?.projectEnd ?? 0;

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
  }, [audioSources, audioTracks, clipPlacements, duration, renderProfile.fps, tracks, videoSources]);

  // Keyboard navigation (Frame-by-Frame)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Native and custom editing surfaces keep their own selection and navigation keystrokes.
      if (isTextEditingKeyboardTarget(e.target)) return;

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
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
  }, [fps, duration, onTimeUpdate, memoizedKeyPoints, scrollToTime]);

  return (
    <div
      ref={containerRef}
      className="flex h-full min-w-0 flex-col overflow-hidden bg-slate-950"
    >
      <div className="relative z-30 flex h-10 flex-none items-center gap-2 overflow-x-auto border-b border-slate-800 bg-slate-900/95 px-2">
        <div className="flex items-center gap-1" role="group" aria-label="Timeline edit tools">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 bg-transparent text-slate-300 hover:bg-slate-800 hover:text-white"
            data-testid="split-selected-media"
            onClick={() => splitSelectedMediaAtFrame(secondsToFrames(
              usePlaybackStore.getState().currentTime,
              renderProfile.fps,
              'nearest',
            ))}
            disabled={!hasSelectedMedia}
            title="Split selected media at playhead"
            aria-label="Split selected media at playhead"
          >
            <Scissors className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 bg-transparent text-slate-300 hover:bg-slate-800 hover:text-white"
            onClick={() => {
              if (selectedClipIndex <= 0) return;
              const ids = videoClips.map((clip) => clip.id);
              [ids[selectedClipIndex - 1], ids[selectedClipIndex]] = [ids[selectedClipIndex], ids[selectedClipIndex - 1]];
              reorderVideoClips(ids);
            }}
            disabled={selectedClipIndex <= 0}
            title="Move selected video clip left"
            aria-label="Move selected video clip left"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 bg-transparent text-slate-300 hover:bg-slate-800 hover:text-white"
            onClick={() => {
              if (selectedClipIndex < 0 || selectedClipIndex >= videoClips.length - 1) return;
              const ids = videoClips.map((clip) => clip.id);
              [ids[selectedClipIndex], ids[selectedClipIndex + 1]] = [ids[selectedClipIndex + 1], ids[selectedClipIndex]];
              reorderVideoClips(ids);
            }}
            disabled={selectedClipIndex < 0 || selectedClipIndex >= videoClips.length - 1}
            title="Move selected video clip right"
            aria-label="Move selected video clip right"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 bg-transparent text-red-300 hover:bg-red-500/15 hover:text-red-200"
            data-testid="delete-selected-media"
            onClick={deleteSelectedMedia}
            disabled={!hasSelectedMedia}
            title={formatShortcutTitle('Delete selected media', 'DELETE')}
            aria-label="Delete selected media"
            aria-keyshortcuts={getShortcutAriaKeys('DELETE')}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 w-7 ${snapEnabled
              ? 'bg-sky-500/20 text-sky-100 hover:bg-sky-500/30 hover:text-white'
              : 'bg-transparent text-slate-300 hover:bg-slate-800 hover:text-white'}`}
            onClick={() => setSnapEnabled(!snapEnabled)}
            title={snapEnabled ? 'Disable snapping' : 'Enable snapping'}
            aria-label={snapEnabled ? 'Disable snapping' : 'Enable snapping'}
            aria-pressed={snapEnabled}
          >
            <Magnet className="h-4 w-4" />
          </Button>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <OverlayMenu
            showThirdsGuide={showThirdsGuide}
            onThirdsGuideToggle={() => onThirdsGuideToggle?.()}
            showDevinGuide={showDevinGuide}
            onDevinGuideToggle={() => onDevinGuideToggle?.()}
            showMetaInfo={showMetaInfo}
            onMetaInfoToggle={() => onMetaInfoToggle?.()}
          />
          <div className="mx-1 h-5 w-px bg-slate-700" />
          <div className="flex items-center gap-1" role="group" aria-label="Timeline zoom controls">
            <span className="w-11 text-right font-mono text-[11px] tabular-nums text-slate-500">{(zoomLevel * 100).toFixed(0)}%</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 bg-transparent text-slate-300 hover:bg-slate-800 hover:text-white"
              onClick={handleZoomOut}
              title="Zoom out"
              aria-label="Zoom out"
            >
              <ZoomOut className="w-[18px] h-[18px]" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 bg-transparent text-slate-300 hover:bg-slate-800 hover:text-white"
              onClick={handleZoomIn}
              title="Zoom in"
              aria-label="Zoom in"
            >
              <ZoomIn className="w-[18px] h-[18px]" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 bg-transparent text-slate-300 hover:bg-slate-800 hover:text-white"
              onClick={handleResetZoom}
              title="Fit timeline to view"
              aria-label="Fit timeline to view"
            >
              <RotateCcw className="w-[18px] h-[18px]" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 relative">
        {/* Track Labels Sidebar */}
        <div className="z-20 flex w-44 flex-none flex-col border-r border-slate-800 bg-slate-950">
          {/* Header spacer for ruler */}
          <div
            className="flex h-8 items-center justify-between gap-2 border-b border-slate-800 bg-slate-950 px-2 text-[11px] font-medium text-slate-500"
            data-testid="timeline-track-controls-header"
          >
            <span>Tracks</span>
            <div
              role="group"
              className="flex items-center gap-1"
              aria-label="Track controls"
            >
              <Button
                variant="ghost"
                size="sm"
                className="relative h-6 w-6 bg-transparent p-0 text-slate-400 hover:bg-sky-500/15 hover:text-sky-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-sky-400"
                onClick={() => addVideoTrack()}
                title="Add video track"
                aria-label="Add video track"
              >
                <Clapperboard className="h-3.5 w-3.5" />
                <Plus className="absolute right-0.5 top-0.5 h-2.5 w-2.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="relative h-6 w-6 bg-transparent p-0 text-slate-400 hover:bg-teal-500/15 hover:text-teal-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-sky-400"
                onClick={() => addAudioTrack()}
                title="Add audio track"
                aria-label="Add audio track"
              >
                <Headphones className="h-3.5 w-3.5" />
                <Plus className="absolute right-0.5 top-0.5 h-2.5 w-2.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="relative h-6 w-6 bg-transparent p-0 text-slate-400 hover:bg-violet-500/15 hover:text-violet-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-sky-400"
                onClick={() => addTrack()}
                title="Add subtitle track"
                aria-label="Add subtitle track"
              >
                <Captions className="h-3.5 w-3.5" />
                <Plus className="absolute right-0.5 top-0.5 h-2.5 w-2.5" />
              </Button>
            </div>
          </div>
          <div
            ref={sidebarContentRef}
            className="flex-1 overflow-hidden bg-slate-950"
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
                    <TimelineVideoTrackHeader
                      track={row.track}
                      index={row.videoTrackIndex}
                      canRemove={videoTracks.length > 1 && row.track.clipIds.length === 0}
                      onRemove={() => removeVideoTrack(row.track.id)}
                      selectedClipIds={selectedVideoClipIds}
                      onOpenCutDetection={setCutDetectionRequest}
                    />
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
            className="relative z-0 h-8 overflow-hidden border-b border-slate-800 bg-slate-950"
            data-testid="timeline-ruler-scroll"
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
            className="relative z-10 flex-1 overflow-x-scroll overflow-y-scroll bg-slate-950 scrollbar-thin scrollbar-thumb-slate-700"
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
                  className={`relative flex-none ${row.kind === 'video'
                    && videoTrackDragPreview?.target?.kind === 'track'
                    && videoTrackDragPreview.target.trackId === row.track.id
                    ? 'bg-sky-500/15 ring-1 ring-inset ring-sky-400/70'
                    : ''}`}
                  style={{ height: getRowHeight(row.key) }}
                  data-testid="timeline-row-content"
                  data-row-key={row.key}
                  data-row-kind={row.kind}
                  data-subtitle-track-id={row.kind === 'subtitle' ? row.track.id : undefined}
                  data-video-track-id={row.kind === 'video' ? row.track.id : undefined}
                >
                  {row.kind === 'video' && videoTrackDragPreview && (
                    <div
                      className={`absolute -top-2 inset-x-0 z-40 h-4 ${videoTrackDragPreview.target?.kind === 'insertion'
                        && videoTrackDragPreview.target.insertionIndex === row.videoTrackIndex
                        ? 'bg-sky-400/15'
                        : ''}`}
                      data-video-track-insertion-index={row.videoTrackIndex}
                      aria-hidden="true"
                    >
                      <div className={`absolute inset-x-0 top-1/2 h-px -translate-y-1/2 ${videoTrackDragPreview.target?.kind === 'insertion'
                        && videoTrackDragPreview.target.insertionIndex === row.videoTrackIndex
                        ? 'bg-sky-300'
                        : 'bg-transparent'}`} />
                    </div>
                  )}
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
                    <TimelineVideoTrack
                      track={row.track}
                      peaksByMediaKey={peaksByMediaKey}
                      selectedClipIds={selectedVideoClipIds}
                      onClipSelectionChange={changeVideoClipSelection}
                      onClearClipSelection={clearVideoClipSelection}
                      onOpenCutDetection={setCutDetectionRequest}
                      onDragPreviewChange={setVideoTrackDragPreview}
                    />
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
                      snapPoints={mediaSnapPoints}
                    />
                  )}
                  {row.kind === 'video'
                    && videoTrackDragPreview
                    && row.videoTrackIndex === videoTracks.length - 1 && (
                    <div
                      className={`absolute -bottom-2 inset-x-0 z-40 h-4 ${videoTrackDragPreview.target?.kind === 'insertion'
                        && videoTrackDragPreview.target.insertionIndex === videoTracks.length
                        ? 'bg-sky-400/15'
                        : ''}`}
                      data-video-track-insertion-index={videoTracks.length}
                      aria-hidden="true"
                    >
                      <div className={`absolute inset-x-0 top-1/2 h-px -translate-y-1/2 ${videoTrackDragPreview.target?.kind === 'insertion'
                        && videoTrackDragPreview.target.insertionIndex === videoTracks.length
                        ? 'bg-sky-300'
                        : 'bg-transparent'}`} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <VideoCutDialog
        request={cutDetectionRequest}
        onClose={() => setCutDetectionRequest(null)}
      />
    </div>
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
