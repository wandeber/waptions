'use client';

import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, memo } from 'react';
import { Subtitle } from '@/types/timeline';
import { Play, Pause, Plus, ZoomIn, ZoomOut, RotateCcw, Magnet } from 'lucide-react';
import { Button } from '../design-system/Button';
import { useTimelineStore } from '@/stores/timeline-store';
import { TimelineRuler } from './TimelineRuler';
import { TimelineTrackHeader } from './TimelineTrackHeader';
import { TimelinePlayhead } from './TimelinePlayhead';
import { TimelineTrackOverlay } from './TimelineTrackOverlay';

// Componentes memoizados para evitar re-renders innecesarios en cada frame de reproducción
const MemoizedTimelineRuler = memo(TimelineRuler);
const MemoizedTimelinePlayhead = memo(TimelinePlayhead);
const MemoizedTimelineTrackOverlay = memo(TimelineTrackOverlay);
const MemoizedTimelineTrackHeader = memo(TimelineTrackHeader);
import { useWaveform } from '@/hooks/use-waveform';
import { TimelineWaveform } from './TimelineWaveform';
import { OverlayMenu } from './OverlayMenu';
import { TimelineVideoTrack } from './TimelineVideoTrack';
import { VideoCutPopover } from './VideoCutPopover';
import { useVideoStore } from '@/stores/video-store';

interface TimelineProps {
  duration: number;
  contentDuration: number;
  currentTime?: number;
  onTimeUpdate?: (time: number) => void;
  onSubtitleClick?: (subtitle: Subtitle | null) => void;
  isPlaying?: boolean;
  onPlayPause?: () => void;
  fps: number;
  showThirdsGuide?: boolean;
  onThirdsGuideToggle?: () => void;
  showDevinGuide?: boolean;
  onDevinGuideToggle?: () => void;
  showMetaInfo?: boolean;
  onMetaInfoToggle?: () => void;
}

export function Timeline({
  duration,
  contentDuration,
  currentTime = 0,
  onTimeUpdate,
  onSubtitleClick,
  isPlaying = false,
  onPlayPause,
  fps,
  showThirdsGuide = false,
  onThirdsGuideToggle,
  showDevinGuide = false,
  onDevinGuideToggle,
  showMetaInfo = false,
  onMetaInfoToggle,
}: TimelineProps) {
  const {
    zoomLevel, setZoom, tracks, addTrack, pixelsPerSecond,
    activeTrackId, setActiveTrackId, snapEnabled, setSnapEnabled,
    activeSnapTime, cuts, isDragging
  } = useTimelineStore();
  const { videoFile } = useVideoStore();
  const { audioBuffer } = useWaveform(videoFile);

  const tracksContentRef = useRef<HTMLDivElement>(null);
  const rulerContentRef = useRef<HTMLDivElement>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const isSyncingRef = useRef(false);
  const virtualScrollLeftRef = useRef(0);
  const pendingScrollRef = useRef<number | null>(null);



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
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  const timelineWidth = duration * pixelsPerSecond * zoomLevel;

  // Sync refs for wheel handler to avoid effect re-runs
  const currentTimeRef = useRef(currentTime);
  const ppsRef = useRef(pixelsPerSecond);
  useEffect(() => {
    currentTimeRef.current = currentTime;
    ppsRef.current = pixelsPerSecond;
  }, [currentTime, pixelsPerSecond]);

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
    const rawVideoDuration = useVideoStore.getState().duration;
    const frameDuration = fps > 0 ? 1 / fps : 1 / 30;
    const snappedVideoDuration = Math.round(rawVideoDuration / frameDuration) * frameDuration;

    const keyPoints = new Set<number>([0, snappedVideoDuration, duration]);
    tracks.forEach(track => {
      track.subtitles.forEach(s => {
        // Guardamos con precisión de ms
        keyPoints.add(Math.round(s.startTime * 1000) / 1000);
        keyPoints.add(Math.round(s.endTime * 1000) / 1000);
      });
    });
    return Array.from(keyPoints).sort((a, b) => a - b);
  }, [tracks, duration, fps]);

  // Keyboard navigation (Frame-by-Frame)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // No interferir si el usuario está escribiendo en un input o textarea
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      if (e.key === ' ') {
        e.preventDefault();
        onPlayPause?.();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const frameDuration = fps > 0 ? 1 / fps : 1 / 30;
        const multiplier = e.shiftKey ? 5 : 1;
        const delta = e.key === 'ArrowRight' ? frameDuration * multiplier : -frameDuration * multiplier;

        const newTime = Math.max(0, Math.min(duration, currentTimeRef.current + delta));

        // Cuantizar el tiempo al frame más cercano para evitar derivas
        const snappedTime = Math.round(newTime / frameDuration) * frameDuration;

        onTimeUpdate?.(snappedTime);
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
            onTimeUpdate?.(snappedNext);
            scrollToTime(snappedNext);
          }
        } else {
          // Anterior punto clave: buscamos el último que sea menor que el actual - epsilon
          const prevIndex = sortedPoints.findLastIndex(p => p < current - EPSILON);
          if (prevIndex !== -1) {
            const prev = sortedPoints[prevIndex];
            const snappedPrev = Math.round(prev / frameDuration) * frameDuration;
            onTimeUpdate?.(snappedPrev);
            scrollToTime(snappedPrev);
          }
        }

        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fps, duration, onTimeUpdate, tracks, onPlayPause, memoizedKeyPoints, scrollToTime]);

  return (
    <div
      ref={containerRef}
      className="flex flex-col bg-gray-900 border-t border-gray-800 min-w-0 overflow-hidden"
    >
      {/* Toolbar */}
      <div className="flex items-center gap-4 p-2 bg-gray-800/50 border-b border-gray-800 relative z-30">
        <div className="flex items-center gap-2">
          <Button
            variant={isPlaying ? 'primary' : 'secondary'}
            onClick={onPlayPause}
          >
            {isPlaying ? <Pause className="w-[18px] h-[18px]" /> : <Play className="w-[18px] h-[18px]" />}
          </Button>
        </div>

        <div className="flex items-center gap-4 text-xs font-mono text-gray-400">
          <div>
            <span className="text-blue-400">{formatTime(currentTime)}</span>
            <span className="mx-1 text-gray-600">/</span>
            <span>{formatTime(contentDuration)}</span>
          </div>

        </div>

        <div className="flex gap-2 ml-auto">
          <div className="flex items-center gap-1">
            <span className="text-xs font-mono text-gray-400 mr-2 w-10 text-right">{(zoomLevel * 100).toFixed(0)}%</span>
            <Button variant="secondary" onClick={handleZoomOut} title="Alejar">
              <ZoomOut className="w-[18px] h-[18px]" />
            </Button>
            <Button variant="secondary" onClick={handleZoomIn} title="Acercar">
              <ZoomIn className="w-[18px] h-[18px]" />
            </Button>
            <Button variant="secondary" onClick={handleResetZoom} title="Ajustar a la vista">
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
          <Button variant="secondary" isActive={snapEnabled} onClick={() => setSnapEnabled(!snapEnabled)} title="Snap">
            <Magnet className="w-[18px] h-[18px]" />
          </Button>
          <div className="w-px h-6 bg-gray-800 mx-1" />
          <Button variant="secondary" onClick={() => addTrack()} title="Nueva Capa">
            <Plus className="w-[18px] h-[18px]" />
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
          >
            {tracks.map(track => (
              <MemoizedTimelineTrackHeader
                key={track.id}
                track={track}
                isActive={track.id === activeTrackId}
                onClick={() => setActiveTrackId(track.id)}
                onToggleVisibility={(id) => {
                  const { tracks, setTracks } = useTimelineStore.getState();
                  setTracks(tracks.map(t => t.id === id ? { ...t, isVisible: !t.isVisible } : t));
                }}
              />
            ))}

            {/* Video Track Label */}
            <div className="h-[48px] border-b border-gray-800 bg-gray-900 flex items-center px-4 text-[10px] font-bold text-blue-300/60 uppercase tracking-wider">
              Video
            </div>

            {/* Audio Track Label */}
            <div className="h-12 border-b border-gray-800 bg-gray-900 flex items-center px-4 text-[10px] font-bold text-blue-400 uppercase tracking-wider mt-auto">
              Audio
            </div>
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
                currentTime={currentTime}
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
                backgroundImage: tracks.length > 1
                  ? 'linear-gradient(to bottom, transparent 63px, #1f2937 1px)'
                  : 'none',
                backgroundSize: '100% 64px'
              }}
            >
              {/* Snapping Indicator (inside relative container to scroll) */}
              {activeSnapTime !== null && (
                <div
                  className="absolute top-0 bottom-0 w-px bg-cyan-400/50 z-30 pointer-events-none"
                  style={{
                    left: `${Math.round(activeSnapTime * pixelsPerSecond * zoomLevel)}px`,
                    boxShadow: '0 0 10px 2px rgba(34, 211, 238, 0.3)'
                  }}
                />
              )}
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

              {/* Tracks rendered as overlays */}
              {tracks.map(track => (
                <MemoizedTimelineTrackOverlay
                  key={track.id}
                  duration={duration}
                  track={track}
                  zoomLevel={zoomLevel}
                  pixelsPerSecond={pixelsPerSecond}
                  fps={fps}
                  onTimeUpdate={onTimeUpdate}
                  onSubtitleClick={onSubtitleClick}
                />
              ))}

              {/* Video track indicator */}
              <div className="relative h-[48px] border-b border-gray-800/50">
                <TimelineVideoTrack duration={useVideoStore.getState().duration} />
              </div>

              {/* Audio Waveform Area */}
              <div
                className="sticky bottom-0 h-12 bg-gray-900/80 z-0 flex items-center overflow-hidden relative"
                style={{ width: timelineWidth }}
              >
                <TimelineWaveform
                  audioBuffer={audioBuffer}
                  duration={duration}
                  pps={pixelsPerSecond * zoomLevel}
                  height={48}
                  containerRef={tracksContentRef}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}