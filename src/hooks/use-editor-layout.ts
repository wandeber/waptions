import { useCallback, useEffect, useRef, useState } from 'react';
import { clampTimelineHeight } from '@/lib/editor-layout';

const DEFAULT_TIMELINE_HEIGHT = 260;

export function useEditorLayout() {
  const [showThirdsGuide, setShowThirdsGuide] = useState(false);
  const [showDevinGuide, setShowDevinGuide] = useState(false);
  const [showMetaInfo, setShowMetaInfo] = useState(true);
  const [isInspectorVisible, setIsInspectorVisible] = useState(true);
  const [timelineHeight, setTimelineHeight] = useState(DEFAULT_TIMELINE_HEIGHT);
  const workspaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const reclampTimeline = (workspaceHeight: number) => {
      setTimelineHeight((currentHeight) => {
        const nextHeight = clampTimelineHeight(currentHeight, workspaceHeight);
        // Preserve the state identity when only ResizeObserver noise changed the measurement.
        return nextHeight === currentHeight ? currentHeight : nextHeight;
      });
    };

    reclampTimeline(workspace.clientHeight);
    if (typeof ResizeObserver === 'undefined') {
      const handleWindowResize = () => reclampTimeline(workspace.clientHeight);
      window.addEventListener('resize', handleWindowResize);
      return () => window.removeEventListener('resize', handleWindowResize);
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === workspace);
      reclampTimeline(entry?.contentRect.height ?? workspace.clientHeight);
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  const handleTimelineResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = timelineHeight;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const workspaceHeight = workspaceRef.current?.clientHeight ?? window.innerHeight;
      setTimelineHeight(clampTimelineHeight(
        startHeight + startY - moveEvent.clientY,
        workspaceHeight,
      ));
    };
    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }, [timelineHeight]);

  const resetTimelineHeight = useCallback(() => {
    setTimelineHeight(clampTimelineHeight(
      DEFAULT_TIMELINE_HEIGHT,
      workspaceRef.current?.clientHeight ?? window.innerHeight,
    ));
  }, []);

  return {
    workspaceRef,
    showThirdsGuide,
    showDevinGuide,
    showMetaInfo,
    isInspectorVisible,
    timelineHeight,
    toggleThirdsGuide: useCallback(() => setShowThirdsGuide((visible) => !visible), []),
    toggleDevinGuide: useCallback(() => setShowDevinGuide((visible) => !visible), []),
    toggleMetaInfo: useCallback(() => setShowMetaInfo((visible) => !visible), []),
    toggleInspector: useCallback(() => setIsInspectorVisible((visible) => !visible), []),
    handleTimelineResizeStart,
    resetTimelineHeight,
  };
}
