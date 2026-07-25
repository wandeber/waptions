'use client';

import {
  AlignLeft,
  Download,
  Film,
  History,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  RotateCw,
  Sparkles,
  Upload,
  Workflow,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { isTextEditingKeyboardTarget } from '@/lib/keyboard-target';
import { ManagedInspector, ManagedJobs } from './ManagedInspector';
import { ManagedPreview, ManagedTransport } from './ManagedPreview';
import { ManagedTextWorkspace } from './ManagedTextWorkspace';
import { ManagedTimeline } from './ManagedTimeline';
import { useEditorSurfaceHost, useEditorUiSnapshot } from './EditorSurfaceProvider';
import {
  buildEditorialTranscriptionCommand,
  buildManagedExportCommand,
  buildManagedMediaImportCommand,
} from '@/lib/editor-ui/command-builders';
import type {
  EditorUiController,
  EditorUiDurableCommand,
  EditorUiSnapshot,
} from '@/lib/editor-ui/contracts';

const MIN_TIMELINE_HEIGHT = 180;
const MAX_TIMELINE_HEIGHT = 620;
const MIN_INSPECTOR_WIDTH = 260;
const MAX_INSPECTOR_WIDTH = 520;

export function EditorSurface({ nativeContent }: { nativeContent?: ReactNode }) {
  const snapshot = useEditorUiSnapshot();
  const { controller, services } = useEditorSurfaceHost();
  const rootRef = useRef<HTMLDivElement>(null);
  const isPictureInPicture = snapshot.view.presentation === 'picture-in-picture';
  const isFullscreen = snapshot.view.presentation === 'fullscreen';

  useEffect(() => {
    if (!snapshot.conflict) return;
    rootRef.current?.querySelector<HTMLElement>('[data-editor-conflict]')?.focus();
  }, [snapshot.conflict]);

  if (nativeContent) {
    return (
      <div
        className="contents"
        data-editor-surface=""
        data-editor-host="standalone"
        data-editor-presentation={snapshot.view.presentation}
        data-editor-connection={snapshot.connection}
        data-editor-revision={snapshot.stateToken.documentRevision}
      >
        {nativeContent}
      </div>
    );
  }

  const handleShortcut = (event: KeyboardEvent<HTMLDivElement>) => {
    const modified = event.metaKey || event.ctrlKey;
    if (modified && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      void controller.dispatch({ type: event.shiftKey ? 'history.redo' : 'history.undo' });
      return;
    }
    if (modified && event.key.toLowerCase() === 's') {
      event.preventDefault();
      services.notify('Managed editor changes are persisted automatically.', 'neutral');
      return;
    }
    if (isTextEditingKeyboardTarget(event.target)) return;
    if (event.key === ' ') {
      event.preventDefault();
      void controller.dispatch({
        type: snapshot.playback.isPlaying ? 'playback.pause' : 'playback.play',
      });
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace')
      && snapshot.view.selectedIds.length > 0) {
      event.preventDefault();
      void deleteSelected(controller, snapshot);
    }
  };

  const resizeTimeline = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = snapshot.view.timelineHeight;
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      controller.updateView({
        timelineHeight: Math.min(
          MAX_TIMELINE_HEIGHT,
          Math.max(MIN_TIMELINE_HEIGHT, startHeight + startY - moveEvent.clientY),
        ),
      });
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', commitResize);
      window.removeEventListener('pointercancel', cancelResize);
      if (!commit) controller.updateView({ timelineHeight: startHeight });
    };
    const commitResize = () => finish(true);
    const cancelResize = () => finish(false);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', commitResize, { once: true });
    window.addEventListener('pointercancel', cancelResize, { once: true });
  };
  const resizeInspector = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = snapshot.view.inspectorWidth;
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      controller.updateView({
        inspectorWidth: Math.min(
          MAX_INSPECTOR_WIDTH,
          Math.max(MIN_INSPECTOR_WIDTH, startWidth + startX - moveEvent.clientX),
        ),
      });
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', commitResize);
      window.removeEventListener('pointercancel', cancelResize);
      if (!commit) controller.updateView({ inspectorWidth: startWidth });
    };
    const commitResize = () => finish(true);
    const cancelResize = () => finish(false);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', commitResize, { once: true });
    window.addEventListener('pointercancel', cancelResize, { once: true });
  };

  return (
    <div
      ref={rootRef}
      className="editor-surface @container relative flex h-full min-h-[360px] w-full min-w-0 select-none flex-col overflow-hidden bg-slate-950 text-slate-100"
      data-editor-surface=""
      data-editor-presentation={snapshot.view.presentation}
      data-editor-connection={snapshot.connection}
      data-editor-revision={snapshot.stateToken.documentRevision}
      onKeyDown={handleShortcut}
    >
      <ManagedEditorHeader />
      <EditorStatusBanners />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ManagedPreview />
          <ManagedTransport />
          <div
            className={isPictureInPicture ? 'hidden' : 'relative h-px flex-none'}
            aria-hidden={isPictureInPicture}
          >
            <div
              role="separator"
              aria-label="Resize timeline"
              aria-orientation="horizontal"
              aria-valuemin={MIN_TIMELINE_HEIGHT}
              aria-valuemax={MAX_TIMELINE_HEIGHT}
              aria-valuenow={Math.round(snapshot.view.timelineHeight)}
              tabIndex={0}
              className="absolute inset-x-0 top-0 z-40 h-px cursor-row-resize bg-slate-700 hover:bg-sky-400 focus-visible:bg-sky-400 focus-visible:outline-none"
              onPointerDown={resizeTimeline}
              onKeyDown={(event) => {
                const next = event.key === 'Home'
                  ? MIN_TIMELINE_HEIGHT
                  : event.key === 'End'
                    ? MAX_TIMELINE_HEIGHT
                    : event.key === 'ArrowUp'
                      ? Math.min(MAX_TIMELINE_HEIGHT, snapshot.view.timelineHeight + 12)
                      : event.key === 'ArrowDown'
                        ? Math.max(MIN_TIMELINE_HEIGHT, snapshot.view.timelineHeight - 12)
                        : null;
                if (next === null) return;
                event.preventDefault();
                controller.updateView({ timelineHeight: next });
              }}
            />
          </div>
          <div
            className={isPictureInPicture ? 'hidden' : 'flex min-h-0 flex-none flex-col'}
            style={{ height: snapshot.view.timelineHeight }}
            aria-hidden={isPictureInPicture}
            inert={isPictureInPicture}
          >
            <LowerPaneSelector split={isFullscreen} />
            <div className={isFullscreen ? 'flex min-h-0 flex-1' : 'contents'}>
              <div
                id="managed-timeline-panel"
                role="tabpanel"
                aria-labelledby="managed-timeline-tab"
                className={isFullscreen || snapshot.view.activePane === 'timeline'
                  ? `flex min-h-0 ${isFullscreen ? 'w-3/5 flex-none border-r border-slate-800' : 'flex-1'}`
                  : 'hidden'}
                aria-hidden={!isFullscreen && snapshot.view.activePane !== 'timeline'}
                inert={!isFullscreen && snapshot.view.activePane !== 'timeline'}
              >
                <ManagedTimeline />
              </div>
              <div
                id="managed-text-panel"
                role="tabpanel"
                aria-labelledby="managed-text-tab"
                className={isFullscreen || snapshot.view.activePane === 'text'
                  ? 'flex min-h-0 flex-1'
                  : 'hidden'}
                aria-hidden={!isFullscreen && snapshot.view.activePane !== 'text'}
                inert={!isFullscreen && snapshot.view.activePane !== 'text'}
              >
                <ManagedTextWorkspace />
              </div>
            </div>
          </div>
          <div
            className={isPictureInPicture ? 'max-h-28 flex-none overflow-auto border-t border-slate-800 p-2' : 'hidden'}
            aria-hidden={!isPictureInPicture}
            inert={!isPictureInPicture}
          >
            <ManagedJobs compact />
          </div>
        </div>

        {snapshot.view.inspectorVisible && !isPictureInPicture && (
          <div
            className="absolute inset-y-12 right-0 z-50 max-w-[88vw] flex-none shadow-2xl @2xl:relative @2xl:inset-auto @2xl:z-auto @2xl:min-w-[260px] @2xl:max-w-none @2xl:shadow-none"
            style={{ width: snapshot.view.inspectorWidth }}
          >
            <div
              role="separator"
              aria-label="Resize inspector"
              aria-orientation="vertical"
              aria-valuemin={MIN_INSPECTOR_WIDTH}
              aria-valuemax={MAX_INSPECTOR_WIDTH}
              aria-valuenow={Math.round(snapshot.view.inspectorWidth)}
              tabIndex={0}
              className="absolute inset-y-0 left-0 z-10 w-px cursor-col-resize bg-slate-800 hover:bg-sky-400 focus-visible:bg-sky-400 focus-visible:outline-none"
              onPointerDown={resizeInspector}
              onKeyDown={(event) => {
                const next = event.key === 'Home'
                  ? MIN_INSPECTOR_WIDTH
                  : event.key === 'End'
                    ? MAX_INSPECTOR_WIDTH
                    : event.key === 'ArrowLeft'
                      ? Math.min(MAX_INSPECTOR_WIDTH, snapshot.view.inspectorWidth + 12)
                      : event.key === 'ArrowRight'
                        ? Math.max(MIN_INSPECTOR_WIDTH, snapshot.view.inspectorWidth - 12)
                        : null;
                if (next === null) return;
                event.preventDefault();
                controller.updateView({ inspectorWidth: next });
              }}
            />
            <ManagedInspector />
          </div>
        )}
      </div>
    </div>
  );
}

function ManagedEditorHeader() {
  const snapshot = useEditorUiSnapshot();
  const { controller, services } = useEditorSurfaceHost();
  const importMedia = async () => {
    const grantId = await services.requestText({
      title: 'Import media',
      label: 'Path grant ID',
    });
    if (!grantId) return;
    const path = await services.requestText({
      title: 'Import media',
      label: 'Authorized absolute media path',
    });
    const command = path ? buildManagedMediaImportCommand(grantId, path) : null;
    if (!command) {
      if (path) {
        services.notify(
          'Import requires a verified media handle supplied by the editor host.',
          'warning',
        );
      }
      return;
    }
    await controller.dispatch(command);
  };
  const transcribe = async () => {
    const providerId = await services.requestText({
      title: 'Prepare text editor',
      label: 'Managed local transcription provider ID',
      initialValue: 'lazy-whisper-api',
    });
    const command = providerId
      ? buildEditorialTranscriptionCommand(snapshot, providerId)
      : null;
    if (!command) {
      if (providerId) services.notify('No video track is available to transcribe.', 'warning');
      return;
    }
    await controller.dispatch(command);
  };
  const exportProject = async () => {
    const grantId = await services.requestText({
      title: 'Export project',
      label: 'Destination path grant ID',
    });
    if (!grantId) return;
    const path = await services.requestText({
      title: 'Export project',
      label: 'Authorized absolute destination path',
      initialValue: `${snapshot.project.name || 'waptions-export'}.mp4`,
    });
    const command = path ? buildManagedExportCommand(grantId, path) : null;
    if (!command) {
      if (path) {
        services.notify(
          'Export requires a verified staged destination supplied by the editor host.',
          'warning',
        );
      }
      return;
    }
    await controller.dispatch(command);
  };
  return (
    <header className="flex h-12 flex-none items-center gap-1.5 border-b border-slate-800 bg-slate-950 px-2">
      <Film className="h-4 w-4 flex-none text-sky-400" />
      <ManagedProjectName />
      <span
        className={`hidden rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide sm:inline ${snapshot.connection === 'connected'
          ? 'bg-emerald-500/10 text-emerald-400'
          : 'bg-amber-500/10 text-amber-300'}`}
      >
        {snapshot.connection}
      </span>
      <HeaderIcon
        label="Undo"
        shortcut="⌘Z / Ctrl+Z"
        icon={RotateCcw}
        disabled={!snapshot.project.canUndo}
        onClick={() => void controller.dispatch({ type: 'history.undo' })}
      />
      <HeaderIcon
        label="Redo"
        shortcut="⇧⌘Z / Ctrl+Shift+Z"
        icon={RotateCw}
        disabled={!snapshot.project.canRedo}
        onClick={() => void controller.dispatch({ type: 'history.redo' })}
      />
      <div className="ml-auto flex min-w-0 items-center gap-1">
        <HeaderIcon
          label="Import media"
          icon={Upload}
          disabled={!snapshot.capabilities.canImportMedia}
          onClick={() => void importMedia()}
        />
        <HeaderIcon
          label="Transcribe selected tracks"
          icon={Sparkles}
          disabled={!snapshot.capabilities.canTranscribe}
          onClick={() => void transcribe()}
        />
        <HeaderIcon
          label="Export project"
          icon={Download}
          disabled={!snapshot.capabilities.canExport}
          onClick={() => void exportProject()}
        />
        <HeaderIcon
          label={snapshot.view.inspectorVisible ? 'Hide inspector' : 'Show inspector'}
          icon={snapshot.view.inspectorVisible ? PanelRightClose : PanelRightOpen}
          onClick={() => controller.updateView({
            inspectorVisible: !snapshot.view.inspectorVisible,
            openDrawer: snapshot.view.inspectorVisible ? null : 'properties',
          })}
        />
      </div>
    </header>
  );
}

function ManagedProjectName() {
  const snapshot = useEditorUiSnapshot();
  const { controller } = useEditorSurfaceHost();
  const [draft, setDraft] = useState(snapshot.project.name);
  useEffect(() => setDraft(snapshot.project.name), [snapshot.project.name]);
  const commit = () => {
    const name = draft.trim();
    if (name && name !== snapshot.project.name) {
      void controller.dispatch({ type: 'project.set-name', name });
    } else {
      setDraft(snapshot.project.name);
    }
  };
  return (
    <input
      className="min-w-0 max-w-48 select-text rounded bg-transparent px-1 py-1 text-sm font-semibold text-slate-100 outline-none focus:bg-slate-900 focus:ring-1 focus:ring-sky-400"
      aria-label="Project name"
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(snapshot.project.name);
          event.currentTarget.blur();
        }
      }}
      readOnly={!snapshot.capabilities.canEdit}
    />
  );
}

function EditorStatusBanners() {
  const snapshot = useEditorUiSnapshot();
  const { controller } = useEditorSurfaceHost();
  return (
    <>
      {snapshot.conflict && (
        <div
          data-editor-conflict=""
          role="alert"
          tabIndex={-1}
          className="flex flex-none items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100 outline-none"
        >
          <span className="min-w-0 flex-1">
            {snapshot.conflict.message} The latest project state has been restored.
          </span>
          <button
            type="button"
            className="rounded bg-amber-400/15 px-2 py-1 font-medium hover:bg-amber-400/25"
            onClick={() => controller.clearConflict()}
          >
            Dismiss
          </button>
        </div>
      )}
      {snapshot.errorMessage && !snapshot.conflict && (
        <div role="alert" className="flex flex-none items-center gap-2 border-b border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
          <span className="min-w-0 flex-1">{snapshot.errorMessage}</span>
          <button
            type="button"
            className="rounded bg-rose-400/15 px-2 py-1 font-medium hover:bg-rose-400/25"
            onClick={() => void controller.reconnect()}
          >
            Reconnect
          </button>
        </div>
      )}
      {!snapshot.errorMessage && snapshot.connection !== 'connected' && (
        <div role="status" className="flex flex-none items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-200">
          <span className="min-w-0 flex-1">
            {snapshot.connection === 'reconnecting'
              ? 'Reconnecting to the editor session…'
              : 'Editor session is degraded. Durable changes are paused until reconnection.'}
          </span>
          <button
            type="button"
            className="rounded px-2 py-1 font-medium hover:bg-amber-500/10"
            onClick={() => void controller.reconnect()}
          >
            Reconnect
          </button>
        </div>
      )}
    </>
  );
}

function LowerPaneSelector({ split }: { split: boolean }) {
  const snapshot = useEditorUiSnapshot();
  const { controller } = useEditorSurfaceHost();
  const selectPane = (activePane: 'timeline' | 'text') => {
    controller.updateView({ activePane });
    void controller.dispatch({ type: 'view.update', patch: { activePane } });
  };
  return (
    <div className="flex h-9 flex-none items-center border-b border-slate-800 bg-slate-950 px-2">
      <div
        role="tablist"
        aria-label="Editor workspace"
        className="flex rounded border border-slate-800 bg-slate-900 p-0.5"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const pane = event.key === 'ArrowLeft' || event.key === 'Home'
            ? 'timeline'
            : 'text';
          selectPane(pane);
          requestAnimationFrame(() => {
            document.getElementById(`managed-${pane}-tab`)?.focus();
          });
        }}
      >
        <PaneTab
          id="managed-timeline-tab"
          controls="managed-timeline-panel"
          active={snapshot.view.activePane === 'timeline'}
          label="Timeline"
          icon={Workflow}
          onClick={() => selectPane('timeline')}
        />
        <PaneTab
          id="managed-text-tab"
          controls="managed-text-panel"
          active={snapshot.view.activePane === 'text'}
          label="Text"
          icon={AlignLeft}
          onClick={() => selectPane('text')}
        />
      </div>
      {split && (
        <span className="ml-2 text-[9px] uppercase tracking-wide text-slate-600">
          Fullscreen split view
        </span>
      )}
      <button
        type="button"
        className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-[10px] text-slate-500 hover:bg-slate-900 hover:text-white"
        onClick={() => controller.updateView({
          inspectorVisible: true,
          openDrawer: 'history',
        })}
      >
        <History className="h-3.5 w-3.5" /> History
      </button>
      <select
        value={snapshot.project.editingMode}
        onChange={(event) => void controller.dispatch({
          type: 'narrative.set-editing-mode',
          mode: event.currentTarget.value as 'ripple' | 'absolute',
        })}
        className="ml-1 h-7 rounded border border-slate-800 bg-slate-900 px-1.5 text-[10px] text-slate-400"
        aria-label="Timeline editing mode"
      >
        <option value="ripple">Ripple</option>
        <option value="absolute">Absolute</option>
      </select>
    </div>
  );
}

async function deleteSelected(
  controller: EditorUiController,
  snapshot: EditorUiSnapshot,
): Promise<void> {
  const selected = new Set(snapshot.view.selectedIds);
  const commands: EditorUiDurableCommand[] = [];
  const blocks = snapshot.project.narrativeBlocks
    .filter((block) => selected.has(block.id))
    .sort((left, right) => left.startSeconds - right.startSeconds);
  if (blocks.length > 0) {
    const first = blocks[0];
    const last = blocks[blocks.length - 1];
    commands.push({
      type: 'narrative.delete-range',
      start: { blockId: first.id, sample16k: first.sourceStartSample16k },
      end: { blockId: last.id, sample16k: last.sourceEndSample16k },
      currentPlayheadFrame: Math.round(snapshot.view.playheadSeconds * snapshot.project.fps),
    });
  }
  for (const track of snapshot.project.tracks) {
    for (const clip of track.clips) {
      if (!selected.has(clip.id)) continue;
      if (clip.kind === 'video') {
        commands.push({ type: 'video-clip.delete', clipId: clip.id });
      } else if (clip.kind === 'audio') {
        commands.push({ type: 'audio-clip.delete', clipId: clip.id });
      } else if (clip.kind === 'subtitle') {
        commands.push({
          type: 'subtitle.delete',
          trackId: track.id,
          subtitleId: clip.id,
        });
      }
    }
  }
  if (commands.length > 0) {
    await controller.dispatch({
      type: 'edit.batch',
      commands,
      history: {
        label: commands.length === 1 ? 'Delete selection' : `Delete ${commands.length} items`,
        category: 'selection.delete',
      },
    });
  }
}

function PaneTab({
  id,
  controls,
  active,
  label,
  icon: Icon,
  onClick,
}: {
  id: string;
  controls: string;
  active: boolean;
  label: string;
  icon: typeof Workflow;
  onClick: () => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      tabIndex={active ? 0 : -1}
      className={`flex h-6 items-center gap-1.5 rounded px-2 text-[11px] ${active
        ? 'bg-sky-500/15 text-sky-100'
        : 'text-slate-500 hover:text-white'}`}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function HeaderIcon({
  label,
  shortcut,
  icon: Icon,
  onClick,
  disabled = false,
}: {
  label: string;
  shortcut?: string;
  icon: typeof Workflow;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="flex h-8 w-8 flex-none items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
