'use client';

import { History, PanelRightClose, PanelRightOpen, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { usePlaybackStore } from '@/stores/playback-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { useEditorLayout } from '@/hooks/use-editor-layout';
import { Button } from '@/components/design-system/Button';
import { MediaInspector } from './MediaInspector';
import { HistoryPanel } from './HistoryPanel';
import { SubtitleEditor } from './subtitle-editor';
import type { SubtitleAnimationStyle } from './subtitle-editor/types';
import { Timeline } from './Timeline';
import { VideoViewport } from './VideoViewport';
import type { Subtitle } from '@/types/timeline';

interface EditorWorkspaceProps {
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
  const layout = useEditorLayout();
  const [inspectorTab, setInspectorTab] = useState<'properties' | 'history'>('properties');
  const isMediaSelection = useTimelineStore((state) => (
    state.transientSelection.kind === 'video-clip'
    || state.transientSelection.kind === 'audio-clip'
  ));

  return (
    <main className="flex-1 p-2 min-h-0 relative">
      <Button
        variant="secondary"
        size="sm"
        className="absolute top-4 right-4 z-50 h-8 w-8 p-0 bg-gray-800/90 border border-gray-700"
        onClick={layout.toggleInspector}
        title={layout.isInspectorVisible ? 'Hide inspector' : 'Show inspector'}
      >
        {layout.isInspectorVisible
          ? <PanelRightClose className="h-4 w-4" />
          : <PanelRightOpen className="h-4 w-4" />}
      </Button>

      <div ref={layout.workspaceRef} className="h-full flex gap-2 min-w-0">
        <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <VideoViewport
            showThirdsGuide={layout.showThirdsGuide}
            showDevinGuide={layout.showDevinGuide}
            showMetaInfo={layout.showMetaInfo}
          />
          <div
            className="h-2 flex-none cursor-row-resize group flex items-center"
            onPointerDown={layout.handleTimelineResizeStart}
            onDoubleClick={layout.resetTimelineHeight}
            title="Drag to resize the timeline"
          >
            <div className="h-px w-full bg-gray-800 group-hover:bg-blue-500 transition-colors" />
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

        <div
          data-testid="editor-inspector"
          className={`flex-none flex flex-col min-h-0 overflow-hidden transition-[width,opacity] duration-200 ${layout.isInspectorVisible
            ? 'w-[360px] opacity-100 bg-gray-800 border border-gray-700 rounded-lg'
            : 'w-0 opacity-0 pointer-events-none'
          }`}
          aria-hidden={!layout.isInspectorVisible}
          inert={!layout.isInspectorVisible}
        >
          <div className="flex flex-none border-b border-gray-700 p-1">
            <button
              type="button"
              onClick={() => setInspectorTab('properties')}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs ${inspectorTab === 'properties'
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-white'}`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Properties
            </button>
            <button
              type="button"
              onClick={() => setInspectorTab('history')}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs ${inspectorTab === 'history'
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-white'}`}
            >
              <History className="h-3.5 w-3.5" />
              History
            </button>
          </div>
          {inspectorTab === 'history'
            ? <HistoryPanel />
            : isMediaSelection
              ? <MediaInspector />
              : <PlaybackAwareSubtitleEditor {...props} />}
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
