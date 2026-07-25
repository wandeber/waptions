'use client';

import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Copy,
  Download,
  FolderOpen,
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
  EditorUiDurableCommand,
  EditorUiSnapshot,
} from '@/lib/editor-ui';
import {
  DEFAULT_EDITOR_UI_SUBTITLE_STYLE,
  secondsToNarrativeSample,
  secondsToOutputSample,
} from '@/lib/editor-ui';
import { useEditorSurfaceHost, useEditorUiSnapshot } from './EditorSurfaceProvider';

export function ManagedInspector() {
  const snapshot = useEditorUiSnapshot();
  const { controller } = useEditorSurfaceHost();
  const drawer = snapshot.view.openDrawer === 'history'
    || snapshot.view.openDrawer === 'jobs'
    || snapshot.view.openDrawer === 'media'
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
          const tabs = ['properties', 'media', 'history', 'jobs'] as const;
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
          id="managed-inspector-media-tab"
          active={drawer === 'media'}
          label="Media"
          icon={FolderOpen}
          onClick={() => controller.updateView({ openDrawer: 'media' })}
        />
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
            : drawer === 'media'
              ? <ManagedMedia />
            : <ManagedProperties />}
      </div>
    </aside>
  );
}

function ManagedMedia() {
  const snapshot = useEditorUiSnapshot();
  const { controller } = useEditorSurfaceHost();
  const sources = snapshot.project.mediaSources ?? [];
  const videoTrackId = snapshot.project.tracks.find((track) => track.kind === 'video')?.id;
  const audioTrackId = snapshot.project.tracks.find((track) => track.kind === 'audio')?.id;
  const timelineFrame = Math.round(snapshot.view.playheadSeconds * snapshot.project.fps);
  return (
    <div className="space-y-2 p-2">
      <p className="text-[10px] leading-4 text-slate-500">
        Registered media stays source-backed. Inserting it creates only a lightweight timeline
        occurrence, so unused source ranges never remain decoded in memory.
      </p>
      {sources.length === 0 && (
        <p className="rounded border border-dashed border-slate-800 p-3 text-xs text-slate-500">
          No registered media.
        </p>
      )}
      {sources.map((source) => {
        const destinationId = source.kind === 'video' ? videoTrackId : audioTrackId;
        return (
          <div key={source.id} className="rounded border border-slate-800 bg-slate-900/70 p-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300">
                {source.label}
              </span>
              <span className="font-mono text-[9px] text-slate-600">
                {source.durationSeconds.toFixed(1)}s
              </span>
            </div>
            <button
              type="button"
              disabled={!destinationId || (source.kind === 'audio' && !source.nativeSampleRateHz)}
              className="mt-2 w-full rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-30"
              onClick={() => {
                if (!destinationId) return;
                if (source.kind === 'video') {
                  void controller.dispatch({
                    type: 'video-clip.insert',
                    sourceId: source.id,
                    trackId: destinationId,
                    timelineFrame,
                    sourceStartSeconds: 0,
                    sourceEndSeconds: source.durationSeconds,
                    audio: null,
                  });
                  return;
                }
                const nativeSampleRateHz = source.nativeSampleRateHz;
                if (!nativeSampleRateHz) return;
                void controller.dispatch({
                  type: 'audio-clip.insert',
                  trackId: destinationId,
                  timelineFrame,
                  source: {
                    domain: 'audio-source-native-samples',
                    audioSourceId: source.id,
                    nativeSampleRateHz,
                    startNativeSample: 0,
                    endNativeSample: Math.round(source.durationSeconds * nativeSampleRateHz),
                    timelineDurationOutputSamples48k: secondsToOutputSample(source.durationSeconds),
                  },
                  muted: false,
                  gainDb: 0,
                  fadeInOutputSamples48k: 0,
                  fadeOutOutputSamples48k: 0,
                });
              }}
            >
              Insert at playhead
            </button>
            {source.kind === 'video' && source.narrativeRecordId && videoTrackId && (
              <button
                type="button"
                className="mt-1 w-full rounded border border-violet-500/30 px-2 py-1 text-[10px] text-violet-200 hover:bg-violet-500/10"
                onClick={() => void controller.dispatch({
                  type: 'narrative.insert-source-range',
                  recordId: source.narrativeRecordId!,
                  sourceId: source.id,
                  startSample16k: 0,
                  endSample16k: Math.round(source.durationSeconds * 16_000),
                  destinationTrackId: videoTrackId,
                  timelineStartFrame: timelineFrame,
                  clipAudio: null,
                })}
              >
                Insert transcript-backed range
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ManagedProperties() {
  const snapshot = useEditorUiSnapshot();
  const { controller, services } = useEditorSurfaceHost();
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
  const selectedSubtitleTrack = selectedSubtitle
    ? snapshot.project.tracks.find((track) => track.id === selectedSubtitle.trackId)
    : undefined;
  const subtitleStyle = selectedSubtitleTrack?.subtitleStyle
    ?? DEFAULT_EDITOR_UI_SUBTITLE_STYLE;
  const selectedNarrative = selectedBlocks[0];
  const focusedTrack = snapshot.project.tracks.find((track) => (
    track.id === snapshot.view.focusedTrackId
  ));
  const selectedVideo = selectedClips.find((clip) => clip.kind === 'video');
  const selectedAudio = selectedClips.find((clip) => clip.kind === 'audio');
  const selectedVideoTrack = selectedVideo
    ? snapshot.project.tracks.find((track) => track.id === selectedVideo.trackId)
    : undefined;
  const selectedAudioTrack = selectedAudio
    ? snapshot.project.tracks.find((track) => track.id === selectedAudio.trackId)
    : undefined;
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
    const commands: EditorUiDurableCommand[] = selectedClips.flatMap(
      (clip): EditorUiDurableCommand[] => {
      if (clip.kind === 'audio') {
        return [{ type: 'audio-clip.set-gain', clipId: clip.id, gainDb }];
      } else if (clip.kind === 'video' && clip.hasLinkedAudio) {
        return [{
          type: 'video-clip.set-audio',
          clipId: clip.id,
          audio: {
            muted: clip.muted ?? false,
            gainDb,
            fadeInOutputSamples48k: secondsToOutputSample(clip.fadeInSeconds ?? 0),
            fadeOutOutputSamples48k: secondsToOutputSample(clip.fadeOutSeconds ?? 0),
          },
        }];
      }
      return [];
      },
    );
    if (commands.length > 0) {
      void controller.dispatch({
        type: 'edit.batch',
        commands,
        history: { label: 'Adjust clip gain', category: 'audio.mix' },
      });
    }
  };
  const setFades = (nextFadeIn: number, nextFadeOut: number) => {
    const commands: EditorUiDurableCommand[] = selectedClips.flatMap(
      (clip): EditorUiDurableCommand[] => {
      if (clip.kind === 'audio') {
        return [{
          type: 'audio-clip.set-fades',
          clipId: clip.id,
          fadeInOutputSamples48k: secondsToOutputSample(nextFadeIn),
          fadeOutOutputSamples48k: secondsToOutputSample(nextFadeOut),
        }];
      } else if (clip.kind === 'video' && clip.hasLinkedAudio) {
        return [{
          type: 'video-clip.set-audio',
          clipId: clip.id,
          audio: {
            muted: clip.muted ?? false,
            gainDb: clip.gainDb ?? 0,
            fadeInOutputSamples48k: secondsToOutputSample(nextFadeIn),
            fadeOutOutputSamples48k: secondsToOutputSample(nextFadeOut),
          },
        }];
      }
      return [];
      },
    );
    if (commands.length > 0) {
      void controller.dispatch({
        type: 'edit.batch',
        commands,
        history: { label: 'Adjust clip fades', category: 'audio.fades' },
      });
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
      {snapshot.project.renderProfile && (
        <fieldset className="space-y-2 rounded border border-slate-800 p-2">
          <legend className="px-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
            Render
          </legend>
          <div className="grid grid-cols-2 gap-2">
            <NumericProperty
              label="Width"
              value={snapshot.project.renderProfile.width}
              suffix="px"
              onChange={(width) => void controller.dispatch({
                type: 'render.set-profile',
                profile: { ...snapshot.project.renderProfile!, width: Math.round(width) },
              })}
            />
            <NumericProperty
              label="Height"
              value={snapshot.project.renderProfile.height}
              suffix="px"
              onChange={(height) => void controller.dispatch({
                type: 'render.set-profile',
                profile: { ...snapshot.project.renderProfile!, height: Math.round(height) },
              })}
            />
          </div>
          <label className="flex items-center justify-between text-[11px] text-slate-400">
            Background
            <input
              type="color"
              value={snapshot.project.backgroundColor ?? '#000000'}
              onChange={(event) => void controller.dispatch({
                type: 'render.set-background',
                color: event.currentTarget.value,
              })}
              className="h-7 w-12 rounded border border-slate-700 bg-slate-900"
            />
          </label>
        </fieldset>
      )}
      {focusedTrack?.kind === 'audio' && (
        <NumericProperty
          label={`${focusedTrack.name} gain`}
          value={focusedTrack.gainDb ?? 0}
          suffix="dB"
          allowNegative
          onChange={(gainDb) => void controller.dispatch({
            type: 'audio-track.set-gain',
            trackId: focusedTrack.id,
            gainDb,
          })}
        />
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
        <div className="grid grid-cols-3 gap-1">
          <button
            type="button"
            className="flex items-center justify-center gap-1.5 rounded border border-slate-800 px-2 py-1.5 text-[11px] text-slate-300 hover:bg-slate-800"
            onClick={() => void controller.dispatch({
              type: 'video-clip.duplicate',
              clipId: selectedVideo.id,
              timelineFrame: Math.round(
                (selectedVideo.startSeconds + selectedVideo.durationSeconds) * snapshot.project.fps,
              ),
            })}
          >
            <Copy className="h-3.5 w-3.5" /> Duplicate
          </button>
          <button
            type="button"
            className="rounded border border-slate-800 px-2 py-1.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-30"
            disabled={!selectedVideoTrack?.clips[0]
              || selectedVideoTrack.clips[0].id === selectedVideo.id}
            onClick={() => {
              const beforeId = selectedVideoTrack?.clips[0]?.id;
              if (beforeId) {
                void controller.dispatch({
                  type: 'video-clip.set-order',
                  clipId: selectedVideo.id,
                  beforeId,
                });
              }
            }}
          >
            Bring front
          </button>
          <button
            type="button"
            className="flex items-center justify-center gap-1.5 rounded border border-slate-800 px-2 py-1.5 text-[11px] text-slate-300 hover:bg-slate-800"
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
            {selectedVideo.hasLinkedAudio ? 'Detach audio' : 'Relink audio'}
          </button>
        </div>
      )}
      {selectedAudio && (
        <div className="grid grid-cols-3 gap-1">
          <button
            type="button"
            className="flex items-center justify-center gap-1.5 rounded border border-slate-800 px-2 py-1.5 text-[11px] text-slate-300 hover:bg-slate-800"
            onClick={() => void controller.dispatch({
              type: 'audio-clip.duplicate',
              clipId: selectedAudio.id,
              targetTrackId: selectedAudio.trackId,
              timelineFrame: Math.round(
                (selectedAudio.startSeconds + selectedAudio.durationSeconds) * snapshot.project.fps,
              ),
            })}
          >
            <Copy className="h-3.5 w-3.5" /> Duplicate
          </button>
          <button
            type="button"
            className="rounded border border-slate-800 px-2 py-1.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-30"
            disabled={!selectedAudioTrack?.clips[0]
              || selectedAudioTrack.clips[0].id === selectedAudio.id}
            onClick={() => {
              const beforeId = selectedAudioTrack?.clips[0]?.id;
              if (beforeId) {
                void controller.dispatch({
                  type: 'audio-clip.set-order',
                  trackId: selectedAudio.trackId,
                  clipId: selectedAudio.id,
                  beforeId,
                });
              }
            }}
          >
            Move first
          </button>
          <button
            type="button"
            className="rounded border border-slate-800 px-2 py-1.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-30"
            disabled={!selectedAudioTrack?.clips[0]
              || selectedAudioTrack.clips[0].id === selectedAudio.id}
            onClick={() => {
              const beforeId = selectedAudioTrack?.clips[0]?.id;
              if (beforeId) {
                void controller.dispatch({
                  type: 'track.reorder-clips',
                  trackKind: 'audio',
                  trackId: selectedAudio.trackId,
                  clipId: selectedAudio.id,
                  beforeId,
                });
              }
            }}
          >
            Track first
          </button>
        </div>
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
            value={subtitleStyle.fontSize}
            suffix="px"
            onChange={(fontSize) => void controller.dispatch({
              type: 'subtitle.set-track-style',
              trackId: selectedSubtitle.trackId,
              style: { ...subtitleStyle, fontSize },
            })}
          />
          <label className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
            Text color
            <input
              type="color"
              value={subtitleStyle.textColor}
              onChange={(event) => void controller.dispatch({
                type: 'subtitle.set-track-style',
                trackId: selectedSubtitle.trackId,
                style: { ...subtitleStyle, textColor: event.currentTarget.value },
              })}
              className="h-7 w-12 rounded border border-slate-700 bg-slate-900"
            />
          </label>
          <button
            type="button"
            className="w-full rounded border border-slate-800 px-2 py-1.5 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white"
            onClick={() => {
              const firstId = snapshot.project.tracks
                .find((track) => track.id === selectedSubtitle.trackId)?.clips[0]?.id;
              if (firstId && firstId !== selectedSubtitle.id) {
                void controller.dispatch({
                  type: 'subtitle.set-order',
                  trackId: selectedSubtitle.trackId,
                  subtitleId: selectedSubtitle.id,
                  beforeId: firstId,
                });
              }
            }}
          >
            Move subtitle to front
          </button>
          <button
            type="button"
            className="w-full rounded border border-slate-800 px-2 py-1.5 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-30"
            disabled={snapshot.project.tracks
              .find((track) => track.id === selectedSubtitle.trackId)?.clips[0]?.id
              === selectedSubtitle.id}
            onClick={() => {
              const firstId = snapshot.project.tracks
                .find((track) => track.id === selectedSubtitle.trackId)?.clips[0]?.id;
              if (firstId && firstId !== selectedSubtitle.id) {
                void controller.dispatch({
                  type: 'track.reorder-clips',
                  trackKind: 'subtitle',
                  trackId: selectedSubtitle.trackId,
                  clipId: selectedSubtitle.id,
                  beforeId: firstId,
                });
              }
            }}
          >
            Move first in track order
          </button>
          <button
            type="button"
            className="w-full rounded border border-slate-800 px-2 py-1.5 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white"
            onClick={async () => {
              const track = snapshot.project.tracks.find((candidate) => (
                candidate.id === selectedSubtitle.trackId
              ));
              const raw = await services.requestText({
                title: 'Replace subtitle track',
                label: 'JSON array of { id, startOutputSample, endOutputSample, text }',
                initialValue: JSON.stringify(track?.clips.map((clip) => ({
                  id: clip.id,
                  startOutputSample: secondsToOutputSample(clip.startSeconds),
                  endOutputSample: secondsToOutputSample(
                    clip.startSeconds + clip.durationSeconds,
                  ),
                  text: clip.text ?? clip.label,
                })) ?? []),
              });
              if (!raw) return;
              try {
                const subtitles = JSON.parse(raw) as unknown;
                if (!Array.isArray(subtitles)) throw new Error('Expected an array.');
                void controller.dispatch({
                  type: 'subtitle.bulk-replace',
                  trackId: selectedSubtitle.trackId,
                  subtitles: subtitles.map((cue) => {
                    if (!cue || typeof cue !== 'object') throw new Error('Invalid cue.');
                    const candidate = cue as Record<string, unknown>;
                    if (typeof candidate.id !== 'string'
                      || typeof candidate.startOutputSample !== 'number'
                      || typeof candidate.endOutputSample !== 'number'
                      || typeof candidate.text !== 'string') {
                      throw new Error('Invalid cue fields.');
                    }
                    return {
                      id: candidate.id,
                      startOutputSample: candidate.startOutputSample,
                      endOutputSample: candidate.endOutputSample,
                      text: candidate.text,
                    };
                  }),
                });
              } catch {
                services.notify('The subtitle JSON is invalid.', 'warning');
              }
            }}
          >
            Bulk replace track…
          </button>
          <label className="block text-[10px] text-slate-500">
            Unlinked video edit policy
            <select
              value={selectedSubtitleTrack?.unlinkedVideoPolicy ?? 'preserve-absolute'}
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
            label="Source start"
            value={selectedNarrative.sourceStartSample16k / 16_000}
            suffix="s"
            onChange={(seconds) => void controller.dispatch({
              type: 'narrative.trim-block',
              blockId: selectedNarrative.id,
              side: 'start',
              sample16k: secondsToNarrativeSample(seconds),
            })}
          />
          <NumericProperty
            label="Source end"
            value={selectedNarrative.sourceEndSample16k / 16_000}
            suffix="s"
            onChange={(seconds) => void controller.dispatch({
              type: 'narrative.trim-block',
              blockId: selectedNarrative.id,
              side: 'end',
              sample16k: secondsToNarrativeSample(seconds),
            })}
          />
          <NumericProperty
            label="Pre-margin"
            value={(selectedNarrative.preMarginSamples16k ?? 0) / 16_000}
            suffix="s"
            onChange={(seconds) => void controller.dispatch({
              type: 'narrative.change-block-margin',
              blockId: selectedNarrative.id,
              side: 'start',
              policy: {
                mode: 'explicit',
                marginSamples16k: secondsToNarrativeSample(seconds),
              },
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
              policy: {
                mode: 'explicit',
                marginSamples16k: secondsToNarrativeSample(seconds),
              },
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
          <div className="grid grid-cols-2 gap-1">
            <button
              type="button"
              className="rounded border border-slate-800 px-2 py-1.5 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white"
              onClick={() => void controller.dispatch({
                type: 'narrative.extend-block',
                blockId: selectedNarrative.id,
                newStartSample16k: Math.max(
                  0,
                  selectedNarrative.sourceStartSample16k
                    - snapshot.project.narrativeSettings.globalPreMarginSamples16k,
                ),
                newEndSample16k: selectedNarrative.sourceEndSample16k
                  + snapshot.project.narrativeSettings.globalPostMarginSamples16k,
              })}
            >
              Extend by margins
            </button>
            <button
              type="button"
              disabled={!selectedNarrative.recordId
                || !selectedNarrative.sourceId
                || !selectedNarrative.destinationTrackId}
              className="rounded border border-slate-800 px-2 py-1.5 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-30"
              onClick={() => {
                if (!selectedNarrative.recordId
                  || !selectedNarrative.sourceId
                  || !selectedNarrative.destinationTrackId) return;
                void controller.dispatch({
                  type: 'narrative.recover-source-range',
                  recordId: selectedNarrative.recordId,
                  sourceId: selectedNarrative.sourceId,
                  startSample16k: selectedNarrative.sourceStartSample16k,
                  endSample16k: selectedNarrative.sourceEndSample16k,
                  destinationTrackId: selectedNarrative.destinationTrackId,
                  targetIndex: snapshot.project.narrativeBlocks.findIndex((block) => (
                    block.id === selectedNarrative.id
                  )),
                  clipAudio: null,
                });
              }}
            >
              Recover source
            </button>
          </div>
        </fieldset>
      )}
      <div className="rounded border border-slate-800">
        <div className="flex items-center gap-1.5 border-b border-slate-800 px-2 py-1.5 text-[11px] font-medium text-slate-300">
          <Link2 className="h-3.5 w-3.5 text-sky-400" />
          Editorial links
        </div>
        <div className="m-2 grid grid-cols-2 gap-1">
          <button
            type="button"
            className="flex items-center justify-center gap-1 rounded border border-slate-800 px-2 py-1 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white"
            onClick={() => void controller.dispatch({ type: 'link.discover-overlaps' })}
          >
            <Link2 className="h-3 w-3" /> Discover
          </button>
          <button
            type="button"
            disabled={!selectedNarrative || !selectedClips[0]}
            className="rounded border border-slate-800 px-2 py-1 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-30"
            onClick={() => {
              const target = selectedClips[0]
                ? targetForId(snapshot, selectedClips[0].id)
                : null;
              if (selectedNarrative && target) {
                void controller.dispatch({
                  type: 'link.create-overlap',
                  anchorBlockId: selectedNarrative.id,
                  target,
                  followPolicy: 'follow',
                });
              }
            }}
          >
            Link selection
          </button>
          <button
            type="button"
            disabled={!selectedNarrative || !selectedClips[0]}
            className="rounded border border-slate-800 px-2 py-1 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-30"
            onClick={() => {
              const target = selectedClips[0]
                ? targetForId(snapshot, selectedClips[0].id)
                : null;
              if (selectedNarrative && target) {
                void controller.dispatch({
                  type: 'link.bind-target',
                  anchorBlockId: selectedNarrative.id,
                  target,
                  activeStartSample16k: selectedNarrative.sourceStartSample16k,
                  activeEndSample16k: selectedNarrative.sourceEndSample16k,
                  followPolicy: 'follow',
                });
              }
            }}
          >
            Bind range
          </button>
          <button
            type="button"
            disabled={!selectedNarrative || !selectedClips[0]}
            className="rounded border border-slate-800 px-2 py-1 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-30"
            onClick={() => {
              const target = selectedClips[0]
                ? targetForId(snapshot, selectedClips[0].id)
                : null;
              if (selectedNarrative && target) {
                void controller.dispatch({
                  type: 'link.reanchor',
                  anchorBlockId: selectedNarrative.id,
                  target,
                });
              }
            }}
          >
            Reanchor
          </button>
        </div>
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
                      onClick={() => {
                        const target = targetForId(snapshot, targetId);
                        if (!target) return;
                        const link = snapshot.project.links?.find((candidate) => (
                          candidate.anchorBlockId === item.id
                          && targetIdForDependentTarget(candidate.target) === targetId
                        ));
                        void controller.dispatch({
                          type: link?.kind === 'binding'
                            ? 'link.unbind-target'
                            : 'link.unlink-target',
                          target,
                        });
                      }}
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

const targetIdForDependentTarget = (target: EditorUiDependentTarget): string => (
  target.kind === 'subtitle' ? target.subtitleId : target.clipId
);

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
  allowNegative = false,
}: {
  label: string;
  value: number;
  suffix: string;
  onChange: (value: number) => void;
  allowNegative?: boolean;
}) {
  const [draft, setDraft] = useState(() => formatNumericValue(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(formatNumericValue(value));
  }, [value]);
  const commit = () => {
    focused.current = false;
    const next = Number(draft);
    if (Number.isFinite(next) && (allowNegative || next >= 0)) {
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
          min={allowNegative ? undefined : 0}
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
  const { controller, mediaResolver, services } = useEditorSurfaceHost();
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
          {job.message && (
            <p className="mt-1 text-[9px] leading-4 text-slate-500">{job.message}</p>
          )}
          {job.kind === 'export' && job.state === 'completed' && (
            job.artifactId && mediaResolver
              ? (
                  <button
                    type="button"
                    className="mt-1 flex items-center gap-1 text-[9px] text-emerald-400 hover:text-emerald-200"
                    onClick={async () => {
                      try {
                        const url = await mediaResolver.resolveArtifactUrl(job.artifactId!);
                        window.open(url, '_blank', 'noopener,noreferrer');
                        window.setTimeout(() => mediaResolver.releaseUrl(url), 60_000);
                      } catch {
                        services.notify('The export artifact could not be opened.', 'error');
                      }
                    }}
                  >
                    <Download className="h-3 w-3" /> Open export
                  </button>
                )
              : (
                  <span className="mt-1 flex items-center gap-1 text-[9px] text-emerald-400">
                    <Download className="h-3 w-3" /> Export ready
                  </span>
                )
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
