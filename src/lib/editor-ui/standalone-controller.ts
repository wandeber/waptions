import { frameRateToNumber } from '@/lib/render-profile';
import { usePlaybackStore } from '@/stores/playback-store';
import { useProjectStore } from '@/stores/project-store';
import { useTimelineStore } from '@/stores/timeline-store';
import type { TimelineStore } from '@/stores/timeline-store-types';
import type { AudioClip, AudioSourceAsset } from '@/types/video';
import type { AnimationStyle } from '@/types/timeline';
import {
  OUTPUT_AUDIO_SAMPLE_RATE,
  mapEditorUiCommand,
} from './core-operation-mapper';
import {
  DEFAULT_EDITOR_UI_CAPABILITIES,
  DEFAULT_EDITOR_UI_VIEW_STATE,
  type EditorUiClip,
  type EditorUiCommandRequest,
  type EditorUiCommandResult,
  type EditorUiEvent,
  type EditorUiSnapshot,
  type EditorUiTransport,
  type EditorUiViewStateStorage,
} from './contracts';
import { ExternalEditorUiController } from './controller';

const STANDALONE_VIEW_STORAGE_PREFIX = 'waptions.editor-ui.view.v1';

const targetId = (target: TimelineStore['dependentLinks'][number]['target']): string => {
  if (target.kind === 'video-clip') return target.clipId;
  if (target.kind === 'audio-clip') return target.clipId;
  return target.subtitleId;
};

const linkedTargets = (state: TimelineStore, blockId: string): string[] => (
  state.dependentLinks
    .filter((link) => link.anchorBlockId === blockId)
    .map((link) => targetId(link.target))
);

const linkedBlocks = (state: TimelineStore, entityId: string): string[] => (
  state.dependentLinks
    .filter((link) => targetId(link.target) === entityId)
    .map((link) => link.anchorBlockId)
);

const getAudioDuration = (
  clip: AudioClip,
  sourceById: Map<string, AudioSourceAsset>,
): number => {
  if ('sourceStart' in clip) return clip.sourceEnd - clip.sourceStart;
  const source = sourceById.get(clip.source.audioSourceId);
  if (!source) return 0;
  return clip.timelineDurationSamples !== undefined
    ? clip.timelineDurationSamples / 48_000
    : (clip.sourceEndSample - clip.sourceStartSample) / source.nativeSampleRate;
};

const selectedIdsFromState = (state: TimelineStore): string[] => {
  const selection = state.transientSelection;
  if (selection.kind === 'video-clip') return [selection.clipId];
  if (selection.kind === 'audio-clip') return [selection.clipId];
  if (selection.kind === 'subtitles') return selection.subtitleIds;
  if (selection.kind === 'narrative') return [selection.blockId];
  return [];
};

interface StandaloneProjectionClock {
  sessionEpoch: string;
  sessionRevision: number;
  eventSequence: number;
}

const buildStandaloneSnapshot = (
  viewId: string,
  clock: StandaloneProjectionClock,
): EditorUiSnapshot => {
  const timeline = useTimelineStore.getState();
  const playback = usePlaybackStore.getState();
  const project = useProjectStore.getState();
  const fps = frameRateToNumber(timeline.renderProfile.fps);
  const sourceById = new Map(timeline.audioSources.map((source) => [source.id, source]));
  const videoSourceById = new Map(timeline.videoSources.map((source) => [source.id, source]));
  const videoClipsByTrack = new Map<string, EditorUiClip[]>();
  for (const clip of timeline.videoClips) {
    const trackId = clip.trackId ?? timeline.videoTracks[0]?.id ?? 'video-track';
    const source = videoSourceById.get(clip.sourceId);
    const projected: EditorUiClip = {
      id: clip.id,
      trackId,
      sourceId: clip.sourceId,
      kind: 'video',
      label: source?.originalName ?? 'Video clip',
      startSeconds: (clip.timelineStartFrame ?? 0) / fps,
      durationSeconds: clip.sourceEnd - clip.sourceStart,
      sourceOffsetSeconds: clip.sourceStart,
      sourceDurationSeconds: source?.duration,
      hasLinkedAudio: clip.audio?.linkState === 'linked',
      linkedTargetIds: linkedBlocks(timeline, clip.id),
      muted: clip.audio?.muted,
      gainDb: clip.audio?.gainDb,
      fadeInSeconds: clip.audio ? clip.audio.fadeInFrames / fps : undefined,
      fadeOutSeconds: clip.audio ? clip.audio.fadeOutFrames / fps : undefined,
    };
    videoClipsByTrack.set(trackId, [...(videoClipsByTrack.get(trackId) ?? []), projected]);
  }

  const audioTracks = timeline.audioTracks.map((track) => ({
    id: track.id,
    kind: 'audio' as const,
    name: track.name,
    locked: track.locked,
    muted: track.muted,
    solo: track.solo,
    height: 84,
    clips: track.clips.map((clip): EditorUiClip => ({
      id: clip.id,
      trackId: track.id,
      sourceId: clip.source.kind === 'audio-source'
        ? clip.source.audioSourceId
        : clip.source.videoSourceId,
      kind: 'audio',
      label: clip.source.kind === 'audio-source'
        ? sourceById.get(clip.source.audioSourceId)?.originalName ?? 'Audio clip'
        : videoSourceById.get(clip.source.videoSourceId)?.originalName ?? 'Detached audio',
      startSeconds: clip.timelineStartFrame / fps,
      durationSeconds: getAudioDuration(clip, sourceById),
      sourceOffsetSeconds: 'sourceStartSample' in clip
        ? clip.sourceStartSample / (sourceById.get(clip.source.audioSourceId)?.nativeSampleRate ?? 1)
        : clip.sourceStart,
      sourceDurationSeconds: clip.source.kind === 'audio-source'
        ? sourceById.get(clip.source.audioSourceId)?.duration
        : videoSourceById.get(clip.source.videoSourceId)?.duration,
      audioSourceRange: 'sourceStartSample' in clip
        ? {
            domain: 'audio-source-native-samples',
            audioSourceId: clip.source.audioSourceId,
            nativeSampleRateHz: sourceById.get(clip.source.audioSourceId)?.nativeSampleRate ?? 1,
            startNativeSample: clip.sourceStartSample,
            endNativeSample: clip.sourceEndSample,
          }
        : {
            domain: 'video-source-seconds',
            videoSourceId: clip.source.videoSourceId,
            startSeconds: clip.sourceStart,
            endSeconds: clip.sourceEnd,
          },
      linkedTargetIds: linkedBlocks(timeline, clip.id),
      muted: clip.muted,
      gainDb: clip.gainDb,
      fadeInSeconds: 'fadeInSamples' in clip
        ? clip.fadeInSamples / (sourceById.get(clip.source.audioSourceId)?.nativeSampleRate ?? 1)
        : clip.fadeInFrames / fps,
      fadeOutSeconds: 'fadeOutSamples' in clip
        ? clip.fadeOutSamples / (sourceById.get(clip.source.audioSourceId)?.nativeSampleRate ?? 1)
        : clip.fadeOutFrames / fps,
    })),
  }));

  const subtitleTracks = timeline.tracks.map((track) => ({
    id: track.id,
    kind: 'subtitle' as const,
    name: track.name,
    locked: track.isLocked,
    visible: track.isVisible,
    height: 72,
    clips: track.subtitles.map((subtitle): EditorUiClip => ({
      id: subtitle.id,
      trackId: track.id,
      kind: 'subtitle',
      label: subtitle.text || 'Untitled subtitle',
      startSeconds: subtitle.startTime,
      durationSeconds: subtitle.endTime - subtitle.startTime,
      sourceOffsetSeconds: 0,
      linkedTargetIds: linkedBlocks(timeline, subtitle.id),
      text: subtitle.text,
    })),
  }));

  const history = timeline.history.map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    timestamp: entry.timestamp,
    isCurrent: index === timeline.history.length - 1,
    isRedo: false,
  })).reverse().concat(timeline.redoStack.map((entry) => ({
    id: entry.id,
    label: entry.label,
    timestamp: entry.timestamp,
    isCurrent: false,
    isRedo: true,
  })));

  return {
    stateToken: {
      sessionId: project.activeProject?.id ?? 'standalone',
      projectId: project.activeProject?.id ?? 'standalone',
      sessionEpoch: clock.sessionEpoch,
      sessionRevision: clock.sessionRevision,
      documentRevision: timeline.revision,
      audioGraphRevision: timeline.audioGraphRevision,
      narrativeRevision: timeline.narrative?.revision,
      eventCursor: `standalone:${clock.eventSequence}`,
    },
    connection: 'connected',
    capabilities: {
      ...DEFAULT_EDITOR_UI_CAPABILITIES,
      canEdit: true,
      canImportMedia: true,
      canTranscribe: true,
      canExport: true,
      canPresentFullscreen: true,
      canPresentPictureInPicture: typeof document !== 'undefined'
        && 'pictureInPictureEnabled' in document,
      canSubscribeToEvents: true,
    },
    project: {
      id: project.activeProject?.id ?? 'standalone',
      name: project.activeProject?.name ?? 'Untitled project',
      durationSeconds: playback.contentDuration,
      fps,
      tracks: [
        ...timeline.videoTracks.map((track) => ({
          id: track.id,
          kind: 'video' as const,
          name: track.name,
          locked: track.locked ?? false,
          visible: track.visible ?? true,
          height: 96,
          clips: videoClipsByTrack.get(track.id) ?? [],
        })),
        ...audioTracks,
        ...subtitleTracks,
      ],
      narrativeBlocks: (timeline.narrative?.blockIds ?? []).flatMap((blockId) => {
        const block = timeline.narrative?.blocks[blockId];
        const clip = block ? timeline.videoClips.find((candidate) => candidate.id === block.clipId) : null;
        if (!block || !clip) return [];
        return [{
          id: block.id,
          clipId: block.clipId,
          kind: block.kind,
          text: block.kind === 'silence' ? 'Silence' : 'Transcript segment',
          sourceStartSample16k: block.coreStartSample,
          sourceEndSample16k: block.coreEndSample,
          startSeconds: block.timelineStartFrame / fps,
          durationSeconds: clip.sourceEnd - clip.sourceStart,
          linkedTargetIds: linkedTargets(timeline, block.id),
          preMarginSamples16k: block.materialization.preBoundary.kind === 'margin'
            ? block.materialization.preBoundary.requestedSamples ?? timeline.narrative?.settings.globalPreMarginSamples
            : 0,
          postMarginSamples16k: block.materialization.postBoundary.kind === 'margin'
            ? block.materialization.postBoundary.requestedSamples ?? timeline.narrative?.settings.globalPostMarginSamples
            : 0,
        }];
      }),
      history,
      canUndo: timeline.history.length > 0,
      canRedo: timeline.redoStack.length > 0,
      editingMode: timeline.globalEditingMode,
      narrativeSettings: {
        globalPreMarginSamples16k: timeline.narrative?.settings.globalPreMarginSamples ?? 0,
        globalPostMarginSamples16k: timeline.narrative?.settings.globalPostMarginSamples ?? 0,
        showSpeakers: timeline.narrative?.settings.showSpeakers ?? true,
      },
    },
    view: {
      ...DEFAULT_EDITOR_UI_VIEW_STATE,
      zoom: timeline.zoomLevel,
      scrollLeft: timeline.scrollLeft,
      playheadSeconds: playback.currentTime,
      selectedIds: selectedIdsFromState(timeline),
      focusedTrackId: timeline.activeTrackId,
      presentation: 'fullscreen',
    },
    playback: {
      revision: 0,
      isPlaying: playback.isPlaying,
      volume: playback.volume,
      muted: playback.muted,
      playbackRate: playback.speed,
      presenterViewId: viewId,
      followingPresenter: false,
    },
    jobs: [],
    presence: [{
      viewId,
      label: 'This editor',
      color: '#38bdf8',
      selectedIds: selectedIdsFromState(timeline),
      playheadSeconds: playback.currentTime,
      isPresenter: true,
      isFollowing: false,
    }],
    pendingCommandIds: [],
    conflict: null,
    recentSemanticAction: null,
    errorMessage: project.persistenceError ? 'Project persistence needs attention.' : null,
  };
};

const executeStandaloneCommand = async (
  request: EditorUiCommandRequest,
): Promise<void> => {
  const timeline = useTimelineStore.getState();
  const playback = usePlaybackStore.getState();
  const project = useProjectStore.getState();
  const fps = frameRateToNumber(timeline.renderProfile.fps);
  const command = request.command;
  switch (command.type) {
    case 'project.set-name':
      await project.updateProjectName(command.name);
      return;
    case 'track.add':
      if (command.kind === 'video') timeline.addVideoTrack();
      else if (command.kind === 'audio') timeline.addAudioTrack();
      else timeline.addTrack();
      return;
    case 'track.rename':
      if (timeline.videoTracks.some((track) => track.id === command.trackId)) {
        // V4 exposes rename through the ordinary document adapter only in managed mode for now.
        return;
      }
      if (timeline.audioTracks.some((track) => track.id === command.trackId)) {
        timeline.renameAudioTrack(command.trackId, command.name);
      } else {
        timeline.updateTrackName(command.trackId, command.name);
      }
      return;
    case 'track.delete':
      if (timeline.videoTracks.some((track) => track.id === command.trackId)) {
        timeline.removeVideoTrack(command.trackId);
      } else if (timeline.audioTracks.some((track) => track.id === command.trackId)) {
        timeline.removeAudioTrack(command.trackId);
      } else {
        timeline.removeTrack(command.trackId);
      }
      return;
    case 'track.set-state':
      if (timeline.audioTracks.some((track) => track.id === command.trackId)) {
        if (command.locked !== undefined) {
          timeline.setAudioTrackLocked(command.trackId, command.locked);
        }
        timeline.updateAudioTrackMix(command.trackId, {
          ...(command.muted === undefined ? {} : { muted: command.muted }),
          ...(command.solo === undefined ? {} : { solo: command.solo }),
        });
      }
      return;
    case 'audio-track.set-gain':
      timeline.updateAudioTrackMix(command.trackId, { gainDb: command.gainDb });
      return;
    case 'view.select': {
      const clipId = command.ids[0] ?? null;
      const audioTrack = timeline.audioTracks.find((track) => (
        track.clips.some((clip) => clip.id === clipId)
      ));
      if (audioTrack && clipId) timeline.selectAudioClip(audioTrack.id, clipId);
      else timeline.selectClip(clipId);
      return;
    }
    case 'view.set-track-height':
      return;
    case 'video-clip.move':
      timeline.moveVideoClip(command.clipId, command.trackId, command.timelineFrame);
      return;
    case 'audio-clip.move':
      timeline.moveAudioClip(
        command.clipId,
        command.trackId,
        command.timelineFrame,
      );
      return;
    case 'video-clip.trim': {
      timeline.trimVideoClip(
        command.clipId,
        command.sourceStartSeconds,
        command.sourceEndSeconds,
      );
      return;
    }
    case 'audio-clip.trim':
      {
        const clip = timeline.audioTracks.flatMap((track) => track.clips)
          .find((candidate) => candidate.id === command.clipId);
        if (!clip) return;
        if ('sourceStartSample' in clip
          && command.sourceRange.domain !== 'audio-source-native-samples') return;
        if ('sourceStart' in clip
          && command.sourceRange.domain !== 'video-source-seconds') return;
        const currentStartSeconds = 'sourceStartSample' in clip
          ? clip.sourceStartSample / (
              command.sourceRange.domain === 'audio-source-native-samples'
                ? command.sourceRange.nativeSampleRateHz
                : 1
            )
          : clip.sourceStart;
        const nextStartSeconds = command.sourceRange.domain === 'audio-source-native-samples'
          ? command.sourceRange.startNativeSample / command.sourceRange.nativeSampleRateHz
          : command.sourceRange.startSeconds;
        const nextEndSeconds = command.sourceRange.domain === 'audio-source-native-samples'
          ? command.sourceRange.endNativeSample / command.sourceRange.nativeSampleRateHz
          : command.sourceRange.endSeconds;
        const timelineStartSeconds = clip.timelineStartFrame / fps;
        const edge = nextStartSeconds !== currentStartSeconds ? 'left' : 'right';
        const timelineSeconds = edge === 'left'
          ? timelineStartSeconds + nextStartSeconds - currentStartSeconds
          : timelineStartSeconds + nextEndSeconds - currentStartSeconds;
        timeline.trimAudioClip(
          command.clipId,
          edge,
          Math.round(timelineSeconds * fps),
        );
      }
      return;
    case 'video-clip.split':
      timeline.splitVideoClip(command.clipId, command.timelineFrame / fps, crypto.randomUUID());
      return;
    case 'audio-clip.split':
      timeline.splitAudioClip(
        command.clipId,
        Math.round(command.timelineOutputSample / OUTPUT_AUDIO_SAMPLE_RATE * fps),
        crypto.randomUUID(),
      );
      return;
    case 'video-clip.delete':
      timeline.deleteVideoClip(command.clipId);
      return;
    case 'audio-clip.delete':
      timeline.deleteAudioClip(command.clipId);
      return;
    case 'video-clip.detach-audio':
      timeline.detachVideoClipAudio(command.clipId);
      return;
    case 'video-clip.set-audio':
      timeline.updateVideoClipAudio(command.clipId, {
        ...(command.muted === undefined ? {} : { muted: command.muted }),
        ...(command.gainDb === undefined ? {} : { gainDb: command.gainDb }),
        ...(command.fadeInOutputSamples48k === undefined
          ? {}
          : {
              fadeInFrames: Math.round(
                command.fadeInOutputSamples48k / OUTPUT_AUDIO_SAMPLE_RATE * fps,
              ),
            }),
        ...(command.fadeOutOutputSamples48k === undefined
          ? {}
          : {
              fadeOutFrames: Math.round(
                command.fadeOutOutputSamples48k / OUTPUT_AUDIO_SAMPLE_RATE * fps,
              ),
            }),
      });
      return;
    case 'audio-clip.set-gain':
      timeline.updateAudioClipMix(command.clipId, { gainDb: command.gainDb });
      return;
    case 'audio-clip.set-fades': {
      const located = timeline.audioTracks.flatMap((track) => track.clips)
        .find((clip) => clip.id === command.clipId);
      if (!located) return;
      if ('sourceStartSample' in located) {
        const source = timeline.audioSources.find((candidate) => (
          candidate.id === located.source.audioSourceId
        ));
        if (!source) return;
        timeline.updateAudioClipMix(command.clipId, {
          fadeInSamples: Math.round(
            command.fadeInOutputSamples48k / OUTPUT_AUDIO_SAMPLE_RATE * source.nativeSampleRate,
          ),
          fadeOutSamples: Math.round(
            command.fadeOutOutputSamples48k / OUTPUT_AUDIO_SAMPLE_RATE * source.nativeSampleRate,
          ),
        });
      } else {
        timeline.updateAudioClipMix(command.clipId, {
          fadeInFrames: Math.round(command.fadeInOutputSamples48k / OUTPUT_AUDIO_SAMPLE_RATE * fps),
          fadeOutFrames: Math.round(command.fadeOutOutputSamples48k / OUTPUT_AUDIO_SAMPLE_RATE * fps),
        });
      }
      return;
    }
    case 'subtitle.insert':
      timeline.addSubtitleToTrack(command.trackId, {
        startTime: command.startOutputSample / OUTPUT_AUDIO_SAMPLE_RATE,
        endTime: command.endOutputSample / OUTPUT_AUDIO_SAMPLE_RATE,
        text: command.text,
      });
      return;
    case 'subtitle.update':
      timeline.updateSubtitleInTrack(command.trackId, command.subtitleId, {
        text: command.text,
      });
      return;
    case 'subtitle.move': {
      const subtitle = timeline.tracks.find((track) => track.id === command.trackId)?.subtitles
        .find((candidate) => candidate.id === command.subtitleId);
      if (!subtitle) return;
      const startTime = command.startOutputSample / OUTPUT_AUDIO_SAMPLE_RATE;
      timeline.updateSubtitleInTrack(command.trackId, command.subtitleId, {
        startTime,
        endTime: startTime + subtitle.endTime - subtitle.startTime,
      });
      if (command.targetTrackId && command.targetTrackId !== command.trackId) {
        timeline.moveSubtitleToTrack(command.subtitleId, command.trackId, command.targetTrackId);
      }
      return;
    }
    case 'subtitle.trim':
      timeline.updateSubtitleInTrack(command.trackId, command.subtitleId, {
        startTime: command.startOutputSample / OUTPUT_AUDIO_SAMPLE_RATE,
        endTime: command.endOutputSample / OUTPUT_AUDIO_SAMPLE_RATE,
      });
      return;
    case 'subtitle.delete':
      timeline.removeSubtitleFromTrack(command.trackId, command.subtitleId);
      return;
    case 'subtitle.set-track-style':
      timeline.updateTrackStyle(command.trackId, command.style as Partial<AnimationStyle>);
      return;
    case 'history.undo':
      await timeline.undo();
      return;
    case 'history.redo':
      await timeline.redo();
      return;
    case 'history.jump':
      await timeline.jumpToHistoryEntry(command.entryId);
      return;
    case 'playback.play':
      playback.play();
      return;
    case 'playback.pause':
      playback.pause();
      return;
    case 'playback.seek':
      playback.seek(command.timelineFrame / fps);
      return;
    case 'playback.set-volume':
      playback.setVolume(command.volume);
      return;
    case 'playback.set-muted':
      if (command.muted) playback.mute();
      else playback.unmute();
      return;
    case 'playback.set-rate':
      playback.setSpeed(command.rate);
      return;
    case 'narrative.delete-all-silences':
      await timeline.executeNarrativeCommand({ type: 'delete-all-silences' });
      return;
    default:
      mapEditorUiCommand(command, {
        operationId: `${request.commandId}:0`,
        projectFps: fps,
      });
      throw new Error(`${command.type} is handled by the native standalone editor surface.`);
  }
};

const createStandaloneViewStorage = (): EditorUiViewStateStorage | undefined => {
  if (typeof window === 'undefined') return undefined;
  return {
    load(viewId) {
      try {
        const raw = window.localStorage.getItem(`${STANDALONE_VIEW_STORAGE_PREFIX}:${viewId}`);
        return raw ? JSON.parse(raw) as Partial<EditorUiSnapshot['view']> : null;
      } catch {
        return null;
      }
    },
    save(viewId, viewState) {
      try {
        window.localStorage.setItem(
          `${STANDALONE_VIEW_STORAGE_PREFIX}:${viewId}`,
          JSON.stringify(viewState),
        );
      } catch {
        // View preferences remain best-effort in restricted browser storage modes.
      }
    },
  };
};

export function createStandaloneEditorUiController(
  viewId = 'standalone-primary',
): ExternalEditorUiController {
  const clock: StandaloneProjectionClock = {
    sessionEpoch: crypto.randomUUID(),
    sessionRevision: 0,
    eventSequence: 0,
  };
  let unsubscribe: (() => void) | null = null;
  const transport: EditorUiTransport = {
    async readSnapshot() {
      return buildStandaloneSnapshot(viewId, clock);
    },
    async execute(request): Promise<EditorUiCommandResult> {
      try {
        await executeStandaloneCommand(request);
        clock.sessionRevision += 1;
        clock.eventSequence += 1;
        return {
          ok: true,
          commandId: request.commandId,
          stateToken: buildStandaloneSnapshot(viewId, clock).stateToken,
          snapshot: buildStandaloneSnapshot(viewId, clock),
        };
      } catch (error) {
        return {
          ok: false,
          commandId: request.commandId,
          code: 'failed',
          message: error instanceof Error ? error.message : 'The standalone command failed.',
        };
      }
    },
    subscribe({ signal }, onEvent) {
      const publish = (kind: EditorUiEvent['kind']) => {
        const previousCursor = `standalone:${clock.eventSequence}`;
        clock.eventSequence += 1;
        if (kind !== 'playback') clock.sessionRevision += 1;
        const snapshot = buildStandaloneSnapshot(viewId, clock);
        onEvent({
          eventId: `standalone-event:${clock.eventSequence}`,
          previousCursor,
          cursor: snapshot.stateToken.eventCursor,
          stateToken: snapshot.stateToken,
          kind,
          snapshot,
        });
      };
      const unsubscribers = [
        useTimelineStore.subscribe(() => publish('project')),
        useProjectStore.subscribe(() => publish('project')),
        usePlaybackStore.subscribe(() => publish('playback')),
      ];
      unsubscribe = () => {
        for (const remove of unsubscribers) remove();
      };
      signal.addEventListener('abort', unsubscribe, { once: true });
    },
    close() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
  const initialSnapshot = buildStandaloneSnapshot(viewId, clock);
  return new ExternalEditorUiController({
    viewId,
    initialSnapshot,
    transport,
    viewStateStorage: createStandaloneViewStorage(),
  });
}
