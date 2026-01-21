'use client';

import { useRef, useEffect, useLayoutEffect } from 'react';
import { Subtitle } from './SubtitleTrack';
import { PlayIcon } from '../icons/PlayIcon';
import { PauseIcon } from '../icons/PauseIcon';
import { GridIcon } from '../icons/GridIcon';
import { InfoIcon } from '../icons/InfoIcon';
import { DevinIcon } from '../icons/DevinIcon';
import { Button } from '../design-system/Button';
import { PlusIcon } from '../icons/PlusIcon';
import { EyeIcon } from '../icons/EyeIcon';
import { useTimelineStore } from '@/stores/timeline-store';
import { TimelineRuler } from './TimelineRuler';
import { TimelineTrackHeader } from './TimelineTrackHeader';
import { TimelinePlayhead } from './TimelinePlayhead';
import { TimelineTrackOverlay } from './TimelineTrackOverlay';

interface TimelineProps {
  duration: number;
  currentTime?: number;
  onTimeUpdate?: (time: number) => void;
  onSubtitleClick?: (subtitle: Subtitle | null) => void;
  selectedSubtitleId?: string | null;
  isPlaying?: boolean;
  onPlayPause?: () => void;
  fps: number;
  showThirdsGuide?: boolean;
  onThirdsGuideToggle?: () => void;
  showDevinGuide?: boolean;
  onDevinGuideToggle?: () => void;
  showMetaInfo?: boolean;
  onMetaInfoToggle?: () => void;
  showSubtitles?: boolean;
  onSubtitlesVisibilityToggle?: () => void;
}

export function Timeline({
  duration,
  currentTime = 0,
  onTimeUpdate,
  onSubtitleClick,
  selectedSubtitleId,
  isPlaying = false,
  onPlayPause,
  fps,
  showThirdsGuide = false,
  onThirdsGuideToggle,
  showDevinGuide = false,
  onDevinGuideToggle,
  showMetaInfo = false,
  onMetaInfoToggle,
  showSubtitles = true,
  onSubtitlesVisibilityToggle
}: TimelineProps) {
  const { zoomLevel, setZoom, tracks, addTrack, pixelsPerSecond, activeTrackId, setActiveTrackId } = useTimelineStore();

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

        if (newZoom !== zoomLevel) {
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
        }
      }
    };

    el.addEventListener('wheel', handleWheelRaw, { passive: false });
    return () => el.removeEventListener('wheel', handleWheelRaw);
  }, [zoomLevel, setZoom]);

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

        // Prevenir scroll lateral del navegador con las flechas si fuera necesario
        e.preventDefault();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Navegación por Puntos Clave
        const keyPoints = new Set<number>([0, duration]);
        tracks.forEach(track => {
          track.subtitles.forEach(s => {
            keyPoints.add(Math.round(s.startTime * 1000) / 1000);
            keyPoints.add(Math.round(s.endTime * 1000) / 1000);
          });
        });

        const sortedPoints = Array.from(keyPoints).sort((a, b) => a - b);
        const current = Math.round(currentTimeRef.current * 1000) / 1000;

        if (e.key === 'ArrowDown') {
          // Siguiente punto clave
          const next = sortedPoints.find(p => p > current + 0.001);
          if (next !== undefined) onTimeUpdate?.(next);
        } else {
          // Anterior punto clave
          const prevIndex = sortedPoints.findLastIndex(p => p < current - 0.001);
          if (prevIndex !== -1) onTimeUpdate?.(sortedPoints[prevIndex]);
        }

        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fps, duration, onTimeUpdate, tracks, onPlayPause]);

  return (
    <div
      ref={containerRef}
      className="flex flex-col bg-gray-900 border-t border-gray-800 min-w-0 overflow-hidden"
    >
      {/* Toolbar */}
      <div className="flex items-center gap-4 p-2 bg-gray-800/50 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <Button
            variant={isPlaying ? 'primary' : 'secondary'}
            onClick={onPlayPause}
            className="w-10 h-10 p-0"
          >
            {isPlaying ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5" />}
          </Button>
        </div>

        <div className="flex items-center gap-4 text-xs font-mono text-gray-400">
          <div className="flex flex-col">
            <span className="text-blue-400">{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
          <div className="w-px h-8 bg-gray-700" />
          <div className="flex flex-col">
            <span>FPS: {fps.toFixed(2)}</span>
            <span>Zoom: {(zoomLevel * 100).toFixed(0)}%</span>
          </div>
        </div>

        <div className="flex gap-2 ml-auto">
          <Button variant="secondary" isActive={showThirdsGuide} onClick={onThirdsGuideToggle} title="Guía de tercios">
            <GridIcon className="w-[18px] h-[18px]" />
          </Button>
          <Button variant="secondary" isActive={showDevinGuide} onClick={onDevinGuideToggle} title="Guía Devin">
            <DevinIcon className="w-[18px] h-[18px]" />
          </Button>
          <Button variant="secondary" isActive={showMetaInfo} onClick={onMetaInfoToggle} title="Info">
            <InfoIcon className="w-[18px] h-[18px]" />
          </Button>
          <div className="w-px h-6 bg-gray-800 mx-1" />
          <Button
            variant="secondary"
            isActive={showSubtitles}
            onClick={onSubtitlesVisibilityToggle}
            title="Mostrar/Ocultar Subtítulos"
          >
            <EyeIcon className="w-[18px] h-[18px]" />
          </Button>
          <div className="w-px h-6 bg-gray-800 mx-1" />
          <Button variant="secondary" onClick={() => addTrack()} title="Nueva Capa">
            <PlusIcon className="w-[18px] h-[18px]" />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 relative">
        {/* Track Labels Sidebar */}
        <div className="w-48 flex-none border-r border-gray-800 bg-gray-900 z-20 flex flex-col">
          {/* Header spacer for ruler */}
          <div className="h-8 border-b border-gray-800 bg-gray-900 flex items-center px-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider">
            Capas
          </div>
          <div
            ref={sidebarContentRef}
            className="flex-1 overflow-hidden bg-gray-900/50"
          >
            {tracks.map(track => (
              <TimelineTrackHeader
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
              <TimelinePlayhead
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
            <TimelineRuler
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
                backgroundImage: 'linear-gradient(to bottom, #1f2937 1px, transparent 1px)',
                backgroundSize: '100% 64px'
              }}
            >
              {/* Tracks rendered as overlays */}
              {tracks.map(track => (
                <TimelineTrackOverlay
                  key={track.id}
                  duration={duration}
                  track={track}
                  zoomLevel={zoomLevel}
                  pixelsPerSecond={pixelsPerSecond}
                  fps={fps}
                  onTimeUpdate={onTimeUpdate}
                  onSubtitleClick={onSubtitleClick}
                  selectedSubtitleId={selectedSubtitleId}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}