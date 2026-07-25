'use client';

import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Download,
  History,
  Link2,
  Link2Off,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  EditorUiClip,
  EditorUiDependentTarget,
  EditorUiSnapshot,
} from '@/lib/editor-ui';
import {
  secondsToNarrativeSample,
  secondsToOutputSample,
} from '@/lib/editor-ui';
import { useEditorSurfaceHost, useEditorUiSnapshot } from './EditorSurfaceProvider';

export function ManagedInspector() {
  const snapshot = useEditorUiSnapshot();
  const { controller } = useEditorSurfaceHost();
  const drawer = snapshot.view.openDrawer === 'history' || snapshot.view.openDrawer === 'jobs'
    ? snapshot.view.openDrawer
    : 'properties';
  return (
    <aside
      className="flex min-h-0 flex-col overflow-hidden border-l border-slate-800 bg-slate-950"
      aria-label="Editor inspector"
      data-testid="managed-editor-inspector"
    >
      <div
        role="tablist"
        aria-label="Inspector views"
        className="flex h-10 flex-none items-center gap-1 border-b border-slate-800 p-1"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const tabs = ['properties', 'history', 'jobs'] as const;
          const currentIndex = tabs.indexOf(drawer);
          const nextIndex = event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : event.key === 'ArrowLeft'
                ? (currentIndex + tabs.length - 1) % tabs.length
                : (currentIndex + 1) % tabs.length;
          const next = tabs[nextIndex];
          controller.updateView({ openDrawer: next });
          requestAnimationFrame(() => {
            document.getElementById(`managed-inspector-${next}-tab`)?.focus();
          });
        }}
      >
        <InspectorTab
          id="managed-inspector-properties-tab"
          active={drawer === 'properties'}
          label="Properties"
          icon={SlidersHorizontal}
          onClick={() => controller.updateView({ openDrawer: 'properties' })}
        />
        <InspectorTab
          id="managed-inspector-history-tab"
          active={drawer === 'history'}
          label="History"
          icon={History}
          onClick={() => controller.updateView({ openDrawer: 'history' })}
        />
        <InspectorTab
          id="managed-inspector-jobs-tab"
          active={drawer === 'jobs'}
          label="Jobs"
          icon={CircleDashed}
          onClick={() => controller.updateView({ openDrawer: 'jobs' })}
        />
        <button
          type="button"
          className="ml-auto rounded p-1.5 text-slate-500 hover:bg-slate-800 hover:text-white"
          onClick={() => controller.updateView({ inspectorVisible: false, openDrawer: null })}
          aria-label="Hide inspector"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div
        id="managed-inspector-panel"
        role="tabpanel"
        aria-labelledby={`managed-inspector-${drawer}-tab`}
        className="min-h-0 flex-1 overflow-auto"
      >
        {drawer === 'history'
          ? <ManagedHistory />
          : drawer === 'jobs'
            ? <ManagedJobs />
            : <ManagedProperties />}
      </div>
    </aside>
  );
}

function ManagedProperties() {
  const snapshot = useEditorUiSnapshot();
  const { controller } = useEditorSurfaceHost();
  const selectedClips = snapshot.project.tracks.flatMap((track) => (
    track.clips.filter((clip) => snapshot.view.selectedIds.includes(clip.id))
  ));
  const selectedBlocks = snapshot.project.narrativeBlocks.filter((block) => (
    snapshot.view.selectedIds.includes(block.id)
  ));
  const hasSelection = selectedClips.length > 0 || selectedBlocks.length > 0;
  const gainValue = selectedClips.find((clip) => clip.gainDb !== undefined)?.gainDb ?? 0;
  const fadeIn = selectedClips.find((clip) => clip.fadeInSeconds !== undefined)?.fadeInSeconds ?? 0;
  const fadeOut = selectedClips.find((clip) => clip.fadeOutSeconds !== undefined)?.fadeOutSeconds ?? 0;
  const selectedSubtitle = selectedClips.find((clip) => clip.kind === 'subtitle');
  const selectedNarrative = selectedBlocks[0];
  const selectedVideo = selectedClips.find((clip) => clip.kind === 'video');
  const audioTracks = snapshot.project.tracks.filter((track) => track.kind === 'audio');
  const detachAudioTrackId = audioTracks[0]?.id;
  const relinkCandidate = selectedVideo
    ? audioTracks.flatMap((track) => track.clips.map((clip) => ({ track, clip })))
      .filter(({ clip }) => clip.kind === 'audio' && clip.sourceId === selectedVideo.sourceId)
      .sort((left, right) => {
        const overlap = (clip: EditorUiClip) => Math.max(
          0,
          Math.min(
            selectedVideo.startSeconds + selectedVideo.durationSeconds,
            clip.startSeconds + clip.durationSeconds,
          ) - Math.max(selectedVideo.startSeconds, clip.startSeconds),
        );
        return overlap(right.clip) - overlap(left.clip);
      })[0]
    : undefined;
  const setGain = (gainDb: number) => {
    for (const clip of selectedClips) {
      if (clip.kind === 'audio') {
        void controller.dispatch({ type: 'audio-clip.set-gain', clipId: clip.id, gainDb });
      } else if (clip.kind === 'video' && clip.hasLinkedAudio) {
        void controller.dispatch({
          type: 'video-clip.set-audio',
          clipId: clip.id,
          muted: clip.muted ?? false,
          gainDb,
          fadeInOutputSamples48k: secondsToOutputSample(clip.fadeInSeconds ?? 0),
          fadeOutOutputSamples48k: secondsToOutputSample(clip.fadeOutSeconds ?? 0),
        });
      }
    }
  };
  const setFades = (nextFadeIn: number, nextFadeOut: number) => {
    for (const clip of selectedClips) {
      if (clip.kind === 'audio') {
        void controller.dispatch({
          type: 'audio-clip.set-fades',
          clipId: clip.id,
          fadeInOutputSamples48k: secondsToOutputSample(nextFadeIn),
          fadeOutOutputSamples48k: secondsToOutputSample(nextFadeOut),
        });
      } else if (clip.kind === 'video' && clip.hasLinkedAudio) {
        void controller.dispatch({
          type: 'video-clip.set-audio',
          clipId: clip.id,
          muted: clip.muted ?? false,
          gainDb: clip.gainDb ?? 0,
          fadeInOutputSamples48k: secondsToOutputSample(nextFadeIn),
          fadeOutOutputSamples48k: secondsToOutputSample(nextFadeOut),
        });
      }
    }
  };
  return (
    <div className="space-y-4 p-3">
      {hasSelection ? (
        <div>
          <h2 className="text-xs font-semibold text-slate-200">
            {selectedClips.length + selectedBlocks.length} selected
          </h2>
          <p className="mt-1 truncate text-[10px] text-slate-500">
            {[...selectedClips, ...selectedBlocks].map((item) => item.id).join(', ')}
          </p>
        </div>
      ) : (
        <p className="text-xs leading-5 text-slate-500">
          Select clips, subtitles, or transcript blocks to edit their properties and links.
        </p>
      )}
      {snapshot.project.narrativeBlocks.length > 0 && (
        <fieldset className="space-y-2 rounded border border-slate-800 p-2">
          <legend className="px-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
            Global narrative
          </legend>
          <NumericProperty
            label="Pre-margin"
            value={snapshot.project.narrativeSettings.globalPreMarginSamples16k / 16_000}
            suffix="s"
            onChange={(seconds) => void controller.dispatch({
              type: 'narrative.change-global-margins',
              preMarginSamples16k: secondsToNarrativeSample(seconds),
              postMarginSamples16k: snapshot.project.narrativeSettings.globalPostMarginSamples16k,
            })}
          />
          <NumericProperty
            label="Post-margin"
            value={snapshot.project.narrativeSettings.globalPostMarginSamples16k / 16_000}
            suffix="s"
            onChange={(seconds) => void controller.dispatch({
              type: 'narrative.change-global-margins',
              preMarginSamples16k: snapshot.project.narrativeSettings.globalPreMarginSamples16k,
              postMarginSamples16k: secondsToNarrativeSample(seconds),
            })}
          />
          <label className="flex items-center justify-between text-[11px] text-slate-400">
            Show speakers
            <input
              type="checkbox"
              checked={snapshot.project.narrativeSettings.showSpeakers}
              onChange={(event) => void controller.dispatch({
                type: 'narrative.set-speaker-visibility',
                visible: event.currentTarget.checked,
              })}
              className="accent-sky-400"
            />
          </label>
        </fieldset>
      )}
      {selectedClips.some((clip) => clip.kind === 'audio' || clip.hasLinkedAudio) && (
        <label className="block text-[11px] text-slate-400">
          <span className="mb-1 flex justify-between">
            <span>Gain</span>
            <span className="font-mono">{gainValue.toFixed(1)} dB</span>
          </span>
          <input
            type="range"
            min={-60}
            max={12}
            step={0.1}
            value={gainValue}
            onChange={(event) => setGain(Number(event.currentTarget.value))}
            className="w-full accent-sky-400"
          />
        </label>
      )}
      {selectedClips.some((clip) => clip.kind === 'audio' || clip.hasLinkedAudio) && (
        <fieldset className="space-y-2 rounded border border-slate-800 p-2">
          <legend className="px-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
            Fades
          </legend>
          <NumericProperty
            label="Fade in"
            value={fadeIn}
            suffix="s"
            onChange={(value) => setFades(value, fadeOut)}
          />
          <NumericProperty
            label="Fade out"
            value={fadeOut}
            suffix="s"
            onChange={(value) => setFades(fadeIn, value)}
          />
        </fieldset>
      )}
      {selectedVideo && (
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1.5 rounded border border-slate-800 px-2 py-1.5 text-[11px] text-slate-300 hover:bg-slate-800"
          disabled={selectedVideo.hasLinkedAudio ? !detachAudioTrackId : !relinkCandidate}
          onClick={() => {
            if (selectedVideo.hasLinkedAudio && detachAudioTrackId) {
              void controller.dispatch({
                type: 'video-clip.detach-audio',
                clipId: selectedVideo.id,
                audioTrackId: detachAudioTrackId,
              });
            } else if (relinkCandidate) {
              void controller.dispatch({
                type: 'video-clip.relink-audio',
                videoClipId: selectedVideo.id,
                audioTrackId: relinkCandidate.track.id,
                audioClipId: relinkCandidate.clip.id,
              });
            }
          }}
        >
          {selectedVideo.hasLinkedAudio
            ? <Link2Off className="h-3.5 w-3.5" />
            : <Link2 className="h-3.5 w-3.5" />}
          {selectedVideo.hasLinkedAudio ? 'Detach embedded audio' : 'Relink embedded audio'}
        </button>
      )}
      {selectedSubtitle && (
        <fieldset className="space-y-2 rounded border border-slate-800 p-2">
          <legend className="px-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
            Subtitle style and order
          </legend>
          <label className="block text-[10px] text-slate-500">
            Text
            <textarea
              key={`${selectedSubtitle.id}:${selectedSubtitle.text ?? selectedSubtitle.label}`}
              defaultValue={selectedSubtitle.text ?? selectedSubtitle.label}
              onBlur={(event) => {
                const text = event.currentTarget.value;
                if (text !== (selectedSubtitle.text ?? selectedSubtitle.label)) {
                  void controller.dispatch({
                    type: 'subtitle.update',
                    trackId: selectedSubtitle.trackId,
                    subtitleId: selectedSubtitle.id,
                    text,
                  });
                }
              }}
              className="mt-1 min-h-16 w-full select-text resize-y rounded border border-slate-700 bg-slate-900 p-2 text-xs text-slate-200 outline-none focus:border-sky-400"
            />
          </label>
          <NumericProperty
            label="Font size"
            value={48}
            suffix="px"
            onChange={(fontSize) => void controller.dispatch({
              type: 'subtitle.set-track-style',
              trackId: selectedSubtitle.trackId,
              style: { fontSize },
            })}
          />
          <label className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
            Text color
            <input
              type="color"
              defaultValue="#ffffff"
              onChange={(event) => void controller.dispatch({
                type: 'subtitle.set-track-style',
                trackId: selectedSubtitle.trackId,
                style: { textColor: event.currentTarget.value },
              })}
              className="h-7 w-12 rounded border border-slate-700 bg-slate-900"
            />
          </label>
          <button
            type="button"
            className="w-full rounded border border-slate-800 px-2 py-1.5 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white"
            onClick={() => void controller.dispatch({
              type: 'subtitle.set-order',
              trackId: selectedSubtitle.trackId,
              subtitleId: selectedSubtitle.id,
              beforeSubtitleId: snapshot.project.tracks
                .find((track) => track.id === selectedSubtitle.trackId)?.clips[0]?.id ?? null,
            })}
          >
            Move subtitle to front
          </button>
          <label className="block text-[10px] text-slate-500">
            Unlinked video edit policy
            <select
              defaultValue="preserve-absolute"
              onChange={(event) => void controller.dispatch({
                type: 'subtitle-track.set-unlinked-video-policy',
                trackId: selectedSubtitle.trackId,
                policy: event.currentTarget.value as
                  | 'preserve-absolute'
                  | 'ripple-with-video-edit'
                  | 'remove-with-deleted-video-range',
              })}
              className="mt-1 h-8 w-full rounded border border-slate-700 bg-slate-900 px-2 text-[10px] text-slate-300"
            >
              <option value="preserve-absolute">Preserve absolute</option>
              <option value="ripple-with-video-edit">Ripple with video</option>
              <option value="remove-with-deleted-video-range">Remove with deleted range</option>
            </select>
          </label>
        </fieldset>
      )}
      {selectedNarrative && (
        <fieldset className="space-y-2 rounded border border-slate-800 p-2">
          <legend className="px-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
            Narrative boundaries
          </legend>
          <NumericProperty
            label="Pre-margin"
            value={(selectedNarrative.preMarginSamples16k ?? 0) / 16_000}
            suffix="s"
            onChange={(seconds) => void controller.dispatch({
              type: 'narrative.change-block-margin',
              blockId: selectedNarrative.id,
              side: 'start',
              marginSamples16k: secondsToNarrativeSample(seconds),
            })}
          />
          <NumericProperty
            label="Post-margin"
            value={(selectedNarrative.postMarginSamples16k ?? 0) / 16_000}
            suffix="s"
            onChange={(seconds) => void controller.dispatch({
              type: 'narrative.change-block-margin',
              blockId: selectedNarrative.id,
              side: 'end',
              marginSamples16k: secondsToNarrativeSample(seconds),
            })}
          />
          <div className="grid grid-cols-2 gap-1">
            {(['start', 'end'] as const).map((side) => (
              <button
                key={side}
                type="button"
                className="rounded border border-slate-800 px-2 py-1.5 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white"
                onClick={() => void controller.dispatch({
                  type: 'narrative.refine-boundary',
                  blockId: selectedNarrative.id,
                  side,
                  chosenSample16k: side === 'start'
                    ? selectedNarrative.sourceStartSample16k
                    : selectedNarrative.sourceEndSample16k,
                  algorithmVersion: 1,
                  origin: 'quiet-assisted',
                })}
              >
                Refine {side}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <div className="rounded border border-slate-800">
        <div className="flex items-center gap-1.5 border-b border-slate-800 px-2 py-1.5 text-[11px] font-medium text-slate-300">
          <Link2 className="h-3.5 w-3.5 text-sky-400" />
          Editorial links
        </div>
        <button
          type="button"
          className="m-2 flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white"
          onClick={() => void controller.dispatch({ type: 'link.discover-overlaps' })}
        >
          <Link2 className="h-3 w-3" /> Discover overlaps
        </button>
        <ul className="divide-y divide-slate-800">
          {[...selectedClips, ...selectedBlocks].flatMap((item) => (
            item.linkedTargetIds.map((targetId) => (
              <li key={`${item.id}:${targetId}`} className="flex items-center gap-2 px-2 py-1.5 text-[10px]">
                <span className="min-w-0 flex-1 truncate text-slate-400">{targetId}</span>
                {'clipId' in item && item.clipId !== null && targetForId(snapshot, targetId) && (
                  <>
                    <button
                      type="button"
                      className="rounded px-1 py-0.5 text-[9px] text-slate-500 hover:bg-slate-800 hover:text-white"
                      onClick={() => void controller.dispatch({
                        type: 'link.set-follow-policy',
                        target: targetForId(snapshot, targetId)!,
                        followPolicy: 'follow',
                      })}
                    >
                      Follow
                    </button>
                    <button
                      type="button"
                      className="rounded p-1 text-slate-500 hover:bg-rose-500/15 hover:text-rose-300"
                      onClick={() => void controller.dispatch({
                        type: 'link.unlink-target',
                        target: targetForId(snapshot, targetId)!,
                      })}
                      aria-label={`Unlink ${targetId}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </>
                )}
              </li>
            ))
          ))}
        </ul>
      </div>
    </div>
  );
}

function targetForId(
  snapshot: EditorUiSnapshot,
  id: string,
): EditorUiDependentTarget | null {
  for (const track of snapshot.project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === id);
    if (!clip) continue;
    if (clip.kind === 'video') return { kind: 'video-clip', clipId: id };
    if (clip.kind === 'audio') return { kind: 'audio-clip', trackId: track.id, clipId: id };
    if (clip.kind === 'subtitle') {
      return { kind: 'subtitle', trackId: track.id, subtitleId: id };
    }
  }
  return null;
}

const formatNumericValue = (value: number): string => (
  Number.isFinite(value) ? String(value) : '0'
);

function NumericProperty({
  label,
  value,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(() => formatNumericValue(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(formatNumericValue(value));
  }, [value]);
  const commit = () => {
    focused.current = false;
    const next = Number(draft);
    if (Number.isFinite(next) && next >= 0) {
      setDraft(formatNumericValue(next));
      if (next !== value) onChange(next);
    } else {
      setDraft(formatNumericValue(value));
    }
  };
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
      {label}
      <span className="flex items-center rounded border border-slate-700 bg-slate-900">
        <input
          type="number"
          min={0}
          step="any"
          value={draft}
          onFocus={() => {
            focused.current = true;
          }}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              setDraft(formatNumericValue(value));
              event.currentTarget.blur();
            }
          }}
          className="h-7 w-16 select-text bg-transparent px-1.5 text-right font-mono text-[10px] text-slate-200 outline-none"
        />
        <span className="pr-1.5 text-[9px] text-slate-600">{suffix}</span>
      </span>
    </label>
  );
}

function ManagedHistory() {
  const snapshot = useEditorUiSnapshot();
  const { controller } = useEditorSurfaceHost();
  return (
    <div className="p-2">
      <div className="mb-2 flex items-center gap-1">
        <button
          type="button"
          className="flex flex-1 items-center justify-center gap-1 rounded border border-slate-800 px-2 py-1.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-30"
          disabled={!snapshot.project.canUndo}
          onClick={() => void controller.dispatch({ type: 'history.undo' })}
        >
          <RotateCcw className="h-3.5 w-3.5" /> Undo
        </button>
        <button
          type="button"
          className="flex flex-1 items-center justify-center gap-1 rounded border border-slate-800 px-2 py-1.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-30"
          disabled={!snapshot.project.canRedo}
          onClick={() => void controller.dispatch({ type: 'history.redo' })}
        >
          <RotateCw className="h-3.5 w-3.5" /> Redo
        </button>
      </div>
      <ol className="space-y-1">
        {[...snapshot.project.history]
          .sort((left, right) => right.timestamp - left.timestamp)
          .map((entry) => (
          <li key={`${entry.id}:${entry.isRedo}`}>
            <button
              type="button"
              className={`w-full rounded px-2 py-1.5 text-left text-[11px] ${entry.isCurrent
                ? 'bg-sky-500/15 text-sky-200'
                : entry.isRedo
                  ? 'text-slate-600 hover:bg-slate-900'
                  : 'text-slate-400 hover:bg-slate-900 hover:text-white'}`}
              onClick={() => void controller.dispatch({ type: 'history.jump', entryId: entry.id })}
            >
              <span className="block truncate">{entry.label}</span>
              <span className="font-mono text-[9px] opacity-60">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
            </button>
          </li>
          ))}
      </ol>
    </div>
  );
}

export function ManagedJobs({ compact = false }: { compact?: boolean }) {
  const snapshot = useEditorUiSnapshot();
  const { controller } = useEditorSurfaceHost();
  if (snapshot.jobs.length === 0) {
    return compact ? null : <p className="p-4 text-xs text-slate-500">No active or recent jobs.</p>;
  }
  return (
    <ul className={compact ? 'space-y-1' : 'space-y-2 p-2'}>
      {snapshot.jobs.map((job) => (
        <li key={job.id} className="rounded border border-slate-800 bg-slate-900/70 p-2">
          <div className="flex items-center gap-2 text-[11px]">
            {job.state === 'completed'
              ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              : job.state === 'failed'
                ? <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />
                : <CircleDashed className="h-3.5 w-3.5 animate-spin text-sky-400 motion-reduce:animate-none" />}
            <span className="min-w-0 flex-1 truncate text-slate-300">{job.label}</span>
            {(job.state === 'queued' || job.state === 'running') && (
              <button
                type="button"
                className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-white"
                onClick={() => void controller.dispatch({
                  type: 'job.cancel',
                  jobId: job.id,
                })}
                aria-label={`Cancel ${job.label}`}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          {job.progress !== null && (
            <div className="mt-2 h-1 overflow-hidden rounded bg-slate-800">
              <div
                className="h-full bg-sky-400 transition-[width] motion-reduce:transition-none"
                style={{ width: `${Math.max(0, Math.min(100, job.progress * 100))}%` }}
              />
            </div>
          )}
          {job.kind === 'export' && job.state === 'completed' && (
            <span className="mt-1 flex items-center gap-1 text-[9px] text-emerald-400">
              <Download className="h-3 w-3" /> Export ready
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function InspectorTab({
  id,
  active,
  label,
  icon: Icon,
  onClick,
}: {
  id: string;
  active: boolean;
  label: string;
  icon: typeof History;
  onClick: () => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls="managed-inspector-panel"
      tabIndex={active ? 0 : -1}
      className={`flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded px-1 text-[10px] ${active
        ? 'bg-slate-800 text-white'
        : 'text-slate-500 hover:bg-slate-900 hover:text-slate-300'}`}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="truncate">{label}</span>
    </button>
  );
}
