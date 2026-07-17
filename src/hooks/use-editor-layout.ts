import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_INSPECTOR_WIDTH,
  DEFAULT_TIMELINE_HEIGHT,
  EDITOR_LAYOUT_STORAGE_KEY,
  clampInspectorWidth,
  clampTimelineHeight,
  getInspectorWidthForKey,
  getMaximumInspectorWidth,
  getMaximumTimelineHeight,
  getTimelineHeightForKey,
  parseEditorLayoutPreferences,
  serializeEditorLayoutPreferences,
} from '@/lib/editor-layout';

export function useEditorLayout() {
  const [showThirdsGuide, setShowThirdsGuide] = useState(false);
  const [showDevinGuide, setShowDevinGuide] = useState(false);
  const [showMetaInfo, setShowMetaInfo] = useState(true);
  const [isInspectorVisible, setIsInspectorVisible] = useState(true);
  const [timelineHeight, setTimelineHeight] = useState(DEFAULT_TIMELINE_HEIGHT);
  const [inspectorWidth, setInspectorWidth] = useState(DEFAULT_INSPECTOR_WIDTH);
  const [maximumTimelineHeight, setMaximumTimelineHeight] = useState(DEFAULT_TIMELINE_HEIGHT);
  const [maximumInspectorWidth, setMaximumInspectorWidth] = useState(DEFAULT_INSPECTOR_WIDTH);
  const [hasHydratedPreferences, setHasHydratedPreferences] = useState(false);
  const [activeResizeKind, setActiveResizeKind] = useState<'timeline' | 'inspector' | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const activeResizeCleanupRef = useRef<(() => void) | null>(null);
  const activeResizeKindRef = useRef<'timeline' | 'inspector' | null>(null);
  const hasHydratedPreferencesRef = useRef(false);
  const layoutPreferencesRef = useRef({
    timelineHeight: DEFAULT_TIMELINE_HEIGHT,
    inspectorWidth: DEFAULT_INSPECTOR_WIDTH,
    isInspectorVisible: true,
  });
  layoutPreferencesRef.current = { timelineHeight, inspectorWidth, isInspectorVisible };

  const persistLayoutPreferences = useCallback(() => {
    if (!hasHydratedPreferencesRef.current) return;
    // Layout preferences are intentionally local UI state; they must never enter project history
    // or invalidate the persisted media document.
    try {
      window.localStorage.setItem(
        EDITOR_LAYOUT_STORAGE_KEY,
        serializeEditorLayoutPreferences(layoutPreferencesRef.current),
      );
    } catch {
      // Persistence is an enhancement; storage failures must not interrupt timeline interaction.
    }
  }, []);

  useEffect(() => {
    let preferences: ReturnType<typeof parseEditorLayoutPreferences> = null;
    try {
      preferences = parseEditorLayoutPreferences(window.localStorage.getItem(EDITOR_LAYOUT_STORAGE_KEY));
    } catch {
      // Private browsing and strict storage policies can disable localStorage. The editor remains
      // fully usable with its defaults, so preference persistence is deliberately best-effort.
    }
    if (preferences) {
      const nextTimelineHeight = clampTimelineHeight(
        preferences.timelineHeight,
        workspaceRef.current?.clientHeight ?? window.innerHeight,
      );
      const nextInspectorWidth = clampInspectorWidth(
        preferences.inspectorWidth,
        workspaceRef.current?.clientWidth ?? window.innerWidth,
      );
      layoutPreferencesRef.current = {
        timelineHeight: nextTimelineHeight,
        inspectorWidth: nextInspectorWidth,
        isInspectorVisible: preferences.isInspectorVisible,
      };
      setTimelineHeight(nextTimelineHeight);
      setInspectorWidth(nextInspectorWidth);
      setIsInspectorVisible(preferences.isInspectorVisible);
    }
    hasHydratedPreferencesRef.current = true;
    setHasHydratedPreferences(true);
  }, []);

  useEffect(() => {
    // Pointer moves may arrive dozens of times per second. Deferring persistence while a pointer
    // gesture is active keeps that hot path free of synchronous localStorage writes; clearing the
    // gesture below triggers one write with the final dimensions. Keyboard and visibility changes
    // continue to persist after their normal React update.
    if (!hasHydratedPreferences || activeResizeKind !== null) return;
    persistLayoutPreferences();
  }, [
    activeResizeKind,
    hasHydratedPreferences,
    inspectorWidth,
    isInspectorVisible,
    persistLayoutPreferences,
    timelineHeight,
  ]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const reclampLayout = (workspaceWidth: number, workspaceHeight: number) => {
      const nextMaximumTimelineHeight = getMaximumTimelineHeight(workspaceHeight);
      const nextMaximumInspectorWidth = getMaximumInspectorWidth(workspaceWidth);
      setMaximumTimelineHeight((currentMaximum) => (
        currentMaximum === nextMaximumTimelineHeight ? currentMaximum : nextMaximumTimelineHeight
      ));
      setMaximumInspectorWidth((currentMaximum) => (
        currentMaximum === nextMaximumInspectorWidth ? currentMaximum : nextMaximumInspectorWidth
      ));
      setTimelineHeight((currentHeight) => {
        const nextHeight = clampTimelineHeight(currentHeight, workspaceHeight);
        // Preserve the state identity when only ResizeObserver noise changed the measurement.
        return nextHeight === currentHeight ? currentHeight : nextHeight;
      });
      setInspectorWidth((currentWidth) => {
        const nextWidth = clampInspectorWidth(currentWidth, workspaceWidth);
        return nextWidth === currentWidth ? currentWidth : nextWidth;
      });
    };

    reclampLayout(workspace.clientWidth, workspace.clientHeight);
    if (typeof ResizeObserver === 'undefined') {
      const handleWindowResize = () => reclampLayout(workspace.clientWidth, workspace.clientHeight);
      window.addEventListener('resize', handleWindowResize);
      return () => window.removeEventListener('resize', handleWindowResize);
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === workspace);
      reclampLayout(
        entry?.contentRect.width ?? workspace.clientWidth,
        entry?.contentRect.height ?? workspace.clientHeight,
      );
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  const beginPointerResize = useCallback((
    event: React.PointerEvent<HTMLDivElement>,
    resizeKind: 'timeline' | 'inspector',
    onMove: (moveEvent: PointerEvent) => void,
  ) => {
    // Only the primary left-button gesture may own pointer capture and mutate persisted layout.
    // Secondary clicks must retain their native behavior, and extra touch points must be ignored.
    if (event.button !== 0 || !event.isPrimary) return;
    const handle = event.currentTarget;
    event.preventDefault();
    event.stopPropagation();
    // Preventing the native pointer default also suppresses focus. Restore it explicitly so the
    // separator remains the keyboard continuation point after a mouse or pen resize.
    handle.focus({ preventScroll: true });
    activeResizeCleanupRef.current?.();
    activeResizeKindRef.current = resizeKind;
    setActiveResizeKind(resizeKind);

    const pointerId = event.pointerId;
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerTerminal);
      window.removeEventListener('pointercancel', handlePointerTerminal);
      handle.removeEventListener('lostpointercapture', handleLostPointerCapture);
      if (activeResizeCleanupRef.current === cleanup) activeResizeCleanupRef.current = null;
      if (activeResizeKindRef.current === resizeKind) {
        activeResizeKindRef.current = null;
        setActiveResizeKind(null);
      }
      try {
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      } catch {
        // The browser may already have released capture while cancelling or removing the handle.
      }
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      moveEvent.stopPropagation();
      onMove(moveEvent);
    };
    const handlePointerTerminal = (terminalEvent: PointerEvent) => {
      if (terminalEvent.pointerId !== pointerId) return;
      terminalEvent.preventDefault();
      terminalEvent.stopPropagation();
      cleanup();
    };
    const handleLostPointerCapture = (lostEvent: PointerEvent) => {
      if (lostEvent.pointerId === pointerId) cleanup();
    };

    // Pointer capture keeps a resize alive outside the narrow divider. The window listeners are
    // retained as a fallback for browsers that reject capture, and every terminal path shares the
    // same cleanup so cancelled gestures and route changes cannot leave global listeners behind.
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerTerminal, { passive: false });
    window.addEventListener('pointercancel', handlePointerTerminal, { passive: false });
    handle.addEventListener('lostpointercapture', handleLostPointerCapture);
    activeResizeCleanupRef.current = cleanup;
    try {
      handle.setPointerCapture?.(pointerId);
    } catch {
      // The global listeners above still provide mouse resizing when capture is unavailable.
    }
  }, []);

  useEffect(() => () => {
    const shouldPersistFinalPointerSize = activeResizeKindRef.current !== null;
    activeResizeCleanupRef.current?.();
    // Route changes can unmount the editor before React renders the terminal state. Persisting the
    // latest ref here preserves the completed pointer work while still releasing every listener.
    if (shouldPersistFinalPointerSize) persistLayoutPreferences();
  }, [persistLayoutPreferences]);

  const handleTimelineResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const startY = event.clientY;
    const startHeight = timelineHeight;
    beginPointerResize(event, 'timeline', (moveEvent) => {
      const workspaceHeight = workspaceRef.current?.clientHeight ?? window.innerHeight;
      const nextHeight = clampTimelineHeight(
        startHeight + startY - moveEvent.clientY,
        workspaceHeight,
      );
      layoutPreferencesRef.current.timelineHeight = nextHeight;
      setTimelineHeight(nextHeight);
    });
  }, [beginPointerResize, timelineHeight]);

  const handleTimelineResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const nextHeight = getTimelineHeightForKey(
      timelineHeight,
      event.key,
      workspaceRef.current?.clientHeight ?? window.innerHeight,
    );
    if (nextHeight === null) return;
    event.preventDefault();
    event.stopPropagation();
    setTimelineHeight(nextHeight);
  }, [timelineHeight]);

  const handleInspectorResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const startWidth = inspectorWidth;
    beginPointerResize(event, 'inspector', (moveEvent) => {
      const nextWidth = clampInspectorWidth(
        startWidth + startX - moveEvent.clientX,
        workspaceRef.current?.clientWidth ?? window.innerWidth,
      );
      layoutPreferencesRef.current.inspectorWidth = nextWidth;
      setInspectorWidth(nextWidth);
    });
  }, [beginPointerResize, inspectorWidth]);

  const handleInspectorResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const nextWidth = getInspectorWidthForKey(
      inspectorWidth,
      event.key,
      workspaceRef.current?.clientWidth ?? window.innerWidth,
    );
    if (nextWidth === null) return;
    event.preventDefault();
    event.stopPropagation();
    setInspectorWidth(nextWidth);
  }, [inspectorWidth]);

  const resetTimelineHeight = useCallback(() => {
    setTimelineHeight(clampTimelineHeight(
      DEFAULT_TIMELINE_HEIGHT,
      workspaceRef.current?.clientHeight ?? window.innerHeight,
    ));
  }, []);

  const resetInspectorWidth = useCallback(() => {
    setInspectorWidth(clampInspectorWidth(
      DEFAULT_INSPECTOR_WIDTH,
      workspaceRef.current?.clientWidth ?? window.innerWidth,
    ));
  }, []);

  return {
    workspaceRef,
    showThirdsGuide,
    showDevinGuide,
    showMetaInfo,
    isInspectorVisible,
    isResizingInspector: activeResizeKind === 'inspector',
    timelineHeight,
    inspectorWidth,
    maximumTimelineHeight,
    maximumInspectorWidth,
    toggleThirdsGuide: useCallback(() => setShowThirdsGuide((visible) => !visible), []),
    toggleDevinGuide: useCallback(() => setShowDevinGuide((visible) => !visible), []),
    toggleMetaInfo: useCallback(() => setShowMetaInfo((visible) => !visible), []),
    toggleInspector: useCallback(() => setIsInspectorVisible((visible) => !visible), []),
    handleTimelineResizeStart,
    handleTimelineResizeKeyDown,
    handleInspectorResizeStart,
    handleInspectorResizeKeyDown,
    resetTimelineHeight,
    resetInspectorWidth,
  };
}
