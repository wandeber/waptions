'use client';

import { History, SlidersHorizontal } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { usePlaybackStore } from '@/stores/playback-store';
import { useTimelineStore } from '@/stores/timeline-store';
import type { useEditorLayout } from '@/hooks/use-editor-layout';
import { MediaInspector } from './MediaInspector';
import { HistoryPanel } from './HistoryPanel';
import { SubtitleEditor } from './subtitle-editor';
import type { SubtitleAnimationStyle } from './subtitle-editor/types';
import { Timeline } from './Timeline';
import { VideoViewport } from './VideoViewport';
import { EditorTransportBar } from './EditorTransportBar';
import type { Subtitle } from '@/types/timeline';
import {
  MINIMUM_INSPECTOR_WIDTH,
  MINIMUM_TIMELINE_HEIGHT,
} from '@/lib/editor-layout';

interface EditorWorkspaceProps {
  layout: ReturnType<typeof useEditorLayout>;
  subtitles: Subtitle[];
  projectFps: number;
  animationStyle?: SubtitleAnimationStyle;
  isGeneratingSubtitles: boolean;
  onSubtitleClick: (subtitle: Subtitle | null) => void;
  onDelete: (subtitleId: string) => void;
  onSubtitlesChange: (subtitles: Subtitle[]) => void;
  onSubtitleUpdate: (
    id: string,
    updates: Partial<Subtitle>,
    options?: { skipHistory?: boolean },
  ) => void;
  onAddSubtitle: (subtitle: Omit<Subtitle, 'id'>) => string;
  onGenerateSubtitles: () => void;
  onAnimationStyleChange: (style: SubtitleAnimationStyle) => void;
  onUndo: () => Promise<void>;
  onRedo: () => Promise<void>;
}

export function EditorWorkspace(props: EditorWorkspaceProps) {
  const { layout } = props;
  const [inspectorTab, setInspectorTab] = useState<'properties' | 'history'>('properties');
  const propertiesTabRef = useRef<HTMLButtonElement>(null);
  const historyTabRef = useRef<HTMLButtonElement>(null);
  const isMediaSelection = useTimelineStore((state) => (
    state.transientSelection.kind === 'video-clip'
    || state.transientSelection.kind === 'audio-clip'
  ));
  const selectAdjacentInspectorTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.key === 'Home'
      ? 'properties'
      : event.key === 'End'
        ? 'history'
        : inspectorTab === 'properties' ? 'history' : 'properties';
    setInspectorTab(target);
    (target === 'properties' ? propertiesTabRef : historyTabRef).current?.focus();
  };

  return (
    <main
      className="editor-shell relative min-h-0 flex-1 overflow-hidden bg-slate-950 text-slate-100"
      data-testid="editor-workspace"
    >
      <div ref={layout.workspaceRef} className="flex h-full min-w-0 overflow-hidden">
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          data-testid="editor-primary-workspace"
        >
          <VideoViewport
            showThirdsGuide={layout.showThirdsGuide}
            showDevinGuide={layout.showDevinGuide}
            showMetaInfo={layout.showMetaInfo}
            isInspectorVisible={layout.isInspectorVisible}
            onInspectorToggle={layout.toggleInspector}
          />
          <EditorTransportBar />
          <div
            role="separator"
            aria-label="Resize timeline"
            aria-orientation="horizontal"
            aria-valuemin={MINIMUM_TIMELINE_HEIGHT}
            aria-valuemax={Math.round(layout.maximumTimelineHeight)}
            aria-valuenow={Math.round(layout.timelineHeight)}
            tabIndex={0}
            className="group relative z-40 h-px touch-none flex-none cursor-row-resize bg-slate-700 transition-colors hover:bg-sky-400 focus-visible:bg-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            onPointerDown={layout.handleTimelineResizeStart}
            onKeyDown={layout.handleTimelineResizeKeyDown}
            onDoubleClick={layout.resetTimelineHeight}
            title="Drag to resize the timeline"
          >
            <div className="absolute -bottom-1.5 -top-1.5 inset-x-0" aria-hidden="true" />
          </div>
          <div className="flex-none min-h-0" style={{ height: layout.timelineHeight }}>
            <Timeline
              onSubtitleClick={props.onSubtitleClick}
              showThirdsGuide={layout.showThirdsGuide}
              onThirdsGuideToggle={layout.toggleThirdsGuide}
              showDevinGuide={layout.showDevinGuide}
              onDevinGuideToggle={layout.toggleDevinGuide}
              showMetaInfo={layout.showMetaInfo}
              onMetaInfoToggle={layout.toggleMetaInfo}
            />
          </div>
        </div>

        {layout.isInspectorVisible && (
          <div
            role="separator"
            aria-label="Resize inspector"
            aria-orientation="vertical"
            aria-valuemin={MINIMUM_INSPECTOR_WIDTH}
            aria-valuemax={Math.round(layout.maximumInspectorWidth)}
            aria-valuenow={Math.round(layout.inspectorWidth)}
            tabIndex={0}
            className="group relative z-40 w-px touch-none flex-none cursor-col-resize bg-slate-700 transition-colors hover:bg-sky-400 focus-visible:bg-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            onPointerDown={layout.handleInspectorResizeStart}
            onKeyDown={layout.handleInspectorResizeKeyDown}
            onDoubleClick={layout.resetInspectorWidth}
            title="Drag to resize the inspector"
          >
            <div className="absolute -left-1.5 -right-1.5 inset-y-0" aria-hidden="true" />
          </div>
        )}
        <div
          id="editor-inspector-panel"
          data-testid="editor-inspector"
          className={`flex min-h-0 flex-none flex-col overflow-hidden bg-slate-900 ${layout.isResizingInspector
            ? 'transition-none'
            : 'transition-[width,opacity] duration-200'
          } ${layout.isInspectorVisible
            ? 'opacity-100'
            : 'pointer-events-none w-0 opacity-0'
          }`}
          style={layout.isInspectorVisible ? { width: layout.inspectorWidth } : undefined}
          aria-hidden={!layout.isInspectorVisible}
          inert={!layout.isInspectorVisible}
        >
          <div className="flex h-10 flex-none items-center border-b border-slate-700 bg-slate-900 px-2">
            <div role="tablist" aria-label="Inspector views" className="flex min-w-0 flex-1 items-center gap-2">
              <button
                ref={propertiesTabRef}
                id="inspector-properties-tab"
                type="button"
                role="tab"
                aria-selected={inspectorTab === 'properties'}
                aria-controls="inspector-properties-panel"
                tabIndex={inspectorTab === 'properties' ? 0 : -1}
                onClick={() => setInspectorTab('properties')}
                onKeyDown={selectAdjacentInspectorTab}
                className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium transition-colors ${inspectorTab === 'properties'
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Properties
              </button>
              <button
                ref={historyTabRef}
                id="inspector-history-tab"
                type="button"
                role="tab"
                aria-selected={inspectorTab === 'history'}
                aria-controls="inspector-history-panel"
                tabIndex={inspectorTab === 'history' ? 0 : -1}
                onClick={() => setInspectorTab('history')}
                onKeyDown={selectAdjacentInspectorTab}
                className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium transition-colors ${inspectorTab === 'history'
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}
              >
                <History className="h-3.5 w-3.5" />
                History
              </button>
            </div>
          </div>
          <div
            id={inspectorTab === 'history' ? 'inspector-history-panel' : 'inspector-properties-panel'}
            role="tabpanel"
            aria-labelledby={inspectorTab === 'history' ? 'inspector-history-tab' : 'inspector-properties-tab'}
            className="flex min-h-0 flex-1 flex-col"
          >
            {inspectorTab === 'history'
              ? <HistoryPanel />
              : isMediaSelection
                ? <MediaInspector />
                : <PlaybackAwareSubtitleEditor {...props} />}
          </div>
        </div>
      </div>
    </main>
  );
}

/** The subtitle inspector needs the clock, but the workspace and timeline rows do not. */
function PlaybackAwareSubtitleEditor(props: EditorWorkspaceProps) {
  const currentTime = usePlaybackStore((state) => state.currentTime);
  return (
    <SubtitleEditor
      subtitles={props.subtitles}
      onSubtitleClick={props.onSubtitleClick}
      onDelete={props.onDelete}
      onSubtitlesChange={props.onSubtitlesChange}
      onSubtitleUpdate={props.onSubtitleUpdate}
      onAddSubtitle={props.onAddSubtitle}
      currentTime={currentTime}
      fps={props.projectFps}
      onGenerateSubtitles={props.onGenerateSubtitles}
      isGeneratingSubtitles={props.isGeneratingSubtitles}
      animationStyle={props.animationStyle}
      onAnimationStyleChange={props.onAnimationStyleChange}
      onUndo={props.onUndo}
      onRedo={props.onRedo}
    />
  );
}
