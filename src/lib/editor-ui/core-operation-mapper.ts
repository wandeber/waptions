import type { EditorUiCommand, EditorUiTrackKind } from './contracts';

export const EDITOR_UI_API_VERSION = '2026-07-25' as const;
export const OUTPUT_AUDIO_SAMPLE_RATE = 48_000 as const;
export const NARRATIVE_SAMPLE_RATE = 16_000 as const;

type DurableEditorUiCommand = Extract<
  EditorUiCommand,
  {
    type:
      | 'project.set-name'
      | 'track.add'
      | 'track.rename'
      | 'track.delete'
      | 'track.reorder'
      | 'track.set-state'
      | 'audio-track.set-gain'
      | 'subtitle-track.set-unlinked-video-policy'
      | 'video-clip.move'
      | 'video-clip.trim'
      | 'video-clip.split'
      | 'video-clip.delete'
      | 'video-clip.detach-audio'
      | 'video-clip.relink-audio'
      | 'video-clip.set-audio'
      | 'audio-clip.move'
      | 'audio-clip.trim'
      | 'audio-clip.split'
      | 'audio-clip.delete'
      | 'audio-clip.set-gain'
      | 'audio-clip.set-fades'
      | 'subtitle.insert'
      | 'subtitle.update'
      | 'subtitle.move'
      | 'subtitle.trim'
      | 'subtitle.split'
      | 'subtitle.delete'
      | 'subtitle.set-order'
      | 'subtitle.set-track-style'
      | 'narrative.activate'
      | 'narrative.release-tracks'
      | 'narrative.set-editing-mode'
      | 'narrative.reorder-blocks'
      | 'narrative.split-block'
      | 'narrative.merge-blocks'
      | 'narrative.delete-range'
      | 'narrative.delete-all-silences'
      | 'narrative.change-block-margin'
      | 'narrative.change-global-margins'
      | 'narrative.refine-boundary'
      | 'narrative.set-speaker-visibility'
      | 'link.discover-overlaps'
      | 'link.create-overlap'
      | 'link.unlink-target'
      | 'link.reanchor'
      | 'link.set-follow-policy';
  }
>;

type UiPayload<Type extends DurableEditorUiCommand['type']> = Omit<
  Extract<DurableEditorUiCommand, { type: Type }>,
  'type'
>;

type CoreSemanticPayloadByType = {
  'project.set-name': UiPayload<'project.set-name'>;
  'track.add': {
    trackKind: EditorUiTrackKind;
    name: string;
    beforeTrackId?: string;
  };
  'track.rename': UiPayload<'track.rename'>;
  'track.delete': {
    trackKind: EditorUiTrackKind;
    trackId: string;
    policy: 'empty-only' | 'rehome';
    rehomeTrackId?: string;
  };
  'track.reorder': {
    trackKind: EditorUiTrackKind;
    trackId: string;
    beforeId?: string;
  };
  'track.set-state': UiPayload<'track.set-state'>;
  'audio-track.set-gain': UiPayload<'audio-track.set-gain'>;
  'subtitle-track.set-unlinked-video-policy':
    UiPayload<'subtitle-track.set-unlinked-video-policy'>;
  'video-clip.move': {
    clipId: string;
    targetTrackId: string;
    timelineStartFrame: number;
  };
  'video-clip.trim': UiPayload<'video-clip.trim'>;
  'video-clip.split': { clipId: string; atFrame: number };
  'video-clip.delete': UiPayload<'video-clip.delete'>;
  'video-clip.detach-audio': UiPayload<'video-clip.detach-audio'>;
  'video-clip.relink-audio': UiPayload<'video-clip.relink-audio'>;
  'video-clip.set-audio': {
    clipId: string;
    audio: {
      linkState: 'linked';
      muted: boolean;
      gainDb: number;
      fadeInFrames: number;
      fadeOutFrames: number;
    };
  };
  'audio-clip.move': {
    clipId: string;
    targetTrackId: string;
    timelineStartFrame: number;
  };
  'audio-clip.trim': {
    clipId: string;
    sourceRange:
      | {
          domain: 'native-samples';
          audioSourceId: string;
          nativeSampleRateHz: number;
          startNativeSample: number;
          endNativeSample: number;
        }
      | {
          domain: 'seconds';
          videoSourceId: string;
          startSeconds: number;
          endSeconds: number;
        };
  };
  'audio-clip.split': { clipId: string; atOutputSample: number };
  'audio-clip.delete': UiPayload<'audio-clip.delete'>;
  'audio-clip.set-gain': UiPayload<'audio-clip.set-gain'>;
  'audio-clip.set-fades': UiPayload<'audio-clip.set-fades'>;
  'subtitle.insert': {
    trackId: string;
    subtitle: {
      id: string;
      startOutputSample: number;
      endOutputSample: number;
      text: string;
    };
  };
  'subtitle.update': UiPayload<'subtitle.update'>;
  'subtitle.move': {
    trackId: string;
    subtitleId: string;
    startOutputSample: number;
  };
  'subtitle.trim': UiPayload<'subtitle.trim'>;
  'subtitle.split': {
    trackId: string;
    subtitleId: string;
    atOutputSample: number;
  };
  'subtitle.delete': UiPayload<'subtitle.delete'>;
  'subtitle.set-order': {
    trackId: string;
    subtitleId: string;
    beforeId?: string;
  };
  'subtitle.set-track-style': UiPayload<'subtitle.set-track-style'>;
  'narrative.activate': UiPayload<'narrative.activate'>;
  'narrative.release-tracks': UiPayload<'narrative.release-tracks'>;
  'narrative.set-editing-mode': UiPayload<'narrative.set-editing-mode'>;
  'narrative.reorder-blocks': UiPayload<'narrative.reorder-blocks'>;
  'narrative.split-block': UiPayload<'narrative.split-block'>;
  'narrative.merge-blocks': UiPayload<'narrative.merge-blocks'>;
  'narrative.delete-range': UiPayload<'narrative.delete-range'>;
  'narrative.delete-all-silences': {
    scope?: { kind: 'document' } | { kind: 'track'; trackId: string };
  };
  'narrative.change-block-margin': {
    blockId: string;
    side: 'pre' | 'post';
    policy: {
      kind: 'margin';
      mode: 'explicit';
      requestedSamples16k: number;
    };
  };
  'narrative.change-global-margins': {
    preSamples16k: number;
    postSamples16k: number;
  };
  'narrative.refine-boundary': UiPayload<'narrative.refine-boundary'>;
  'narrative.set-speaker-visibility': { showSpeakers: boolean };
  'link.discover-overlaps': Record<string, never>;
  'link.create-overlap': UiPayload<'link.create-overlap'>;
  'link.unlink-target': UiPayload<'link.unlink-target'>;
  'link.reanchor': UiPayload<'link.reanchor'>;
  'link.set-follow-policy': UiPayload<'link.set-follow-policy'>;
};

export type CoreSemanticOperation = {
  [Type in keyof CoreSemanticPayloadByType]: {
    operationId: string;
    type: Type;
    payload: CoreSemanticPayloadByType[Type];
  };
}[keyof CoreSemanticPayloadByType];

export type EditorUiCommandRoute =
  | { tool: 'edit'; operations: readonly CoreSemanticOperation[] }
  | { tool: 'history'; action: 'undo' | 'redo' | 'jump'; entryId?: string | null }
  | {
      tool: 'playback';
      action:
        | 'play'
        | 'pause'
        | 'seek'
        | 'set-master-volume'
        | 'set-master-mute'
        | 'set-rate'
        | 'claim-presenter'
        | 'release-presenter'
        | 'follow'
        | 'unfollow';
      frame?: number;
      volume?: number;
      muted?: boolean;
      rate?: number;
      presenterViewId?: string;
    }
  | {
      tool: 'view';
      patch:
        | { selectionIds: string[] }
        | { rowHeights: Record<string, number> };
    }
  | {
      tool: 'media-import';
      request: Omit<Extract<EditorUiCommand, { type: 'media.import' }>, 'type'>;
    }
  | {
      tool: 'transcription';
      action: 'start';
      request: Omit<Extract<EditorUiCommand, { type: 'transcription.start' }>, 'type'>;
    }
  | { tool: 'job-cancel'; jobId: string }
  | {
      tool: 'export';
      action: 'start';
      request: Omit<Extract<EditorUiCommand, { type: 'export.start' }>, 'type'>;
    };

const assertInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
};

const assertPositiveInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
};

const validateOperationUnits = (operation: DurableEditorUiCommand): void => {
  switch (operation.type) {
    case 'video-clip.move':
    case 'video-clip.split':
    case 'audio-clip.move':
      assertInteger(operation.timelineFrame, `${operation.type}.timelineFrame`);
      return;
    case 'video-clip.trim':
      if (!Number.isFinite(operation.sourceStartSeconds)
        || !Number.isFinite(operation.sourceEndSeconds)
        || operation.sourceStartSeconds < 0
        || operation.sourceEndSeconds <= operation.sourceStartSeconds) {
        throw new Error('video-clip.trim source timing must be a positive finite range.');
      }
      if (operation.timelineStartFrame !== undefined) {
        assertInteger(operation.timelineStartFrame, 'video-clip.trim.timelineStartFrame');
      }
      return;
    case 'video-clip.set-audio':
      assertInteger(
        operation.fadeInOutputSamples48k,
        'video-clip.set-audio.fadeInOutputSamples48k',
      );
      assertInteger(
        operation.fadeOutOutputSamples48k,
        'video-clip.set-audio.fadeOutOutputSamples48k',
      );
      return;
    case 'audio-clip.trim':
      if (operation.sourceRange.domain === 'audio-source-native-samples') {
        assertPositiveInteger(
          operation.sourceRange.nativeSampleRateHz,
          'audio-clip.trim.sourceRange.nativeSampleRateHz',
        );
        assertInteger(
          operation.sourceRange.startNativeSample,
          'audio-clip.trim.sourceRange.startNativeSample',
        );
        assertInteger(
          operation.sourceRange.endNativeSample,
          'audio-clip.trim.sourceRange.endNativeSample',
        );
        if (operation.sourceRange.endNativeSample <= operation.sourceRange.startNativeSample) {
          throw new Error('audio-clip.trim.sourceRange samples must be a positive range.');
        }
      } else if (!Number.isFinite(operation.sourceRange.startSeconds)
        || !Number.isFinite(operation.sourceRange.endSeconds)
        || operation.sourceRange.startSeconds < 0
        || operation.sourceRange.endSeconds <= operation.sourceRange.startSeconds) {
        throw new Error('audio-clip.trim.sourceRange seconds must be a positive finite range.');
      }
      return;
    case 'audio-clip.split':
      assertInteger(operation.timelineOutputSample, `${operation.type}.timelineOutputSample`);
      return;
    case 'audio-clip.set-fades':
      assertInteger(
        operation.fadeInOutputSamples48k,
        'audio-clip.set-fades.fadeInOutputSamples48k',
      );
      assertInteger(
        operation.fadeOutOutputSamples48k,
        'audio-clip.set-fades.fadeOutOutputSamples48k',
      );
      return;
    case 'subtitle.insert':
      assertInteger(operation.startOutputSample, 'subtitle.insert.startOutputSample');
      assertInteger(operation.endOutputSample, 'subtitle.insert.endOutputSample');
      if (operation.endOutputSample <= operation.startOutputSample) {
        throw new Error('subtitle.insert timing must be a positive half-open range.');
      }
      return;
    case 'subtitle.move':
      assertInteger(operation.startOutputSample, 'subtitle.move.startOutputSample');
      assertInteger(operation.endOutputSample, 'subtitle.move.endOutputSample');
      if (operation.endOutputSample <= operation.startOutputSample) {
        throw new Error('subtitle.move timing must be a positive half-open range.');
      }
      return;
    case 'subtitle.trim':
      assertInteger(operation.startOutputSample, 'subtitle.trim.startOutputSample');
      assertInteger(operation.endOutputSample, 'subtitle.trim.endOutputSample');
      if (operation.endOutputSample <= operation.startOutputSample) {
        throw new Error('subtitle.trim timing must be a positive half-open range.');
      }
      return;
    case 'subtitle.split':
      assertInteger(operation.outputSample, `${operation.type}.outputSample`);
      return;
    case 'narrative.change-block-margin':
      assertInteger(operation.marginSamples16k, 'narrative.change-block-margin.marginSamples16k');
      return;
    case 'narrative.change-global-margins':
      assertInteger(operation.preMarginSamples16k, 'narrative.change-global-margins.preMarginSamples16k');
      assertInteger(operation.postMarginSamples16k, 'narrative.change-global-margins.postMarginSamples16k');
      return;
    case 'narrative.reorder-blocks':
      assertInteger(operation.targetIndex, 'narrative.reorder-blocks.targetIndex');
      return;
    case 'narrative.split-block':
      assertInteger(operation.splitSample16k, 'narrative.split-block.splitSample16k');
      return;
    case 'narrative.delete-range':
      assertInteger(operation.start.sample16k, 'narrative.delete-range.start.sample16k');
      assertInteger(operation.end.sample16k, 'narrative.delete-range.end.sample16k');
      return;
    case 'narrative.refine-boundary':
      assertInteger(operation.chosenSample16k, 'narrative.refine-boundary.chosenSample16k');
      assertPositiveInteger(
        operation.algorithmVersion,
        'narrative.refine-boundary.algorithmVersion',
      );
      return;
    default:
      return;
  }
};

/**
 * The sole UI-to-Core vocabulary boundary.
 *
 * Every durable route returns exact section 6.3 operation names. Video placement uses integer
 * project frames, audio/subtitle timing uses fixed 48 kHz output samples, and narrative semantic
 * boundaries/margins use canonical 16 kHz samples. The only seconds-based source range is
 * explicitly discriminated as video-source media; native audio sources use native sample indices.
 */
export function mapEditorUiCommand(
  command: EditorUiCommand,
  context: { operationId?: string; projectFps?: number } = {},
): EditorUiCommandRoute {
  if (command.type === 'history.undo') return { tool: 'history', action: 'undo' };
  if (command.type === 'history.redo') return { tool: 'history', action: 'redo' };
  if (command.type === 'history.jump') {
    return { tool: 'history', action: 'jump', entryId: command.entryId };
  }
  if (command.type === 'playback.play') return { tool: 'playback', action: 'play' };
  if (command.type === 'playback.pause') return { tool: 'playback', action: 'pause' };
  if (command.type === 'playback.seek') {
    assertInteger(command.timelineFrame, 'playback.seek.timelineFrame');
    return { tool: 'playback', action: 'seek', frame: command.timelineFrame };
  }
  if (command.type === 'playback.set-volume') {
    return { tool: 'playback', action: 'set-master-volume', volume: command.volume };
  }
  if (command.type === 'playback.set-muted') {
    return { tool: 'playback', action: 'set-master-mute', muted: command.muted };
  }
  if (command.type === 'playback.set-rate') {
    return { tool: 'playback', action: 'set-rate', rate: command.rate };
  }
  if (command.type === 'playback.presenter.claim') {
    return { tool: 'playback', action: 'claim-presenter' };
  }
  if (command.type === 'playback.presenter.release') {
    return { tool: 'playback', action: 'release-presenter' };
  }
  if (command.type === 'playback.follow') {
    return { tool: 'playback', action: 'follow', presenterViewId: command.presenterViewId };
  }
  if (command.type === 'playback.unfollow') return { tool: 'playback', action: 'unfollow' };
  if (command.type === 'view.select') {
    return { tool: 'view', patch: { selectionIds: command.ids } };
  }
  if (command.type === 'view.set-track-height') {
    return {
      tool: 'view',
      patch: { rowHeights: { [command.trackId]: command.height } },
    };
  }
  if (command.type === 'media.import') {
    return {
      tool: 'media-import',
      request: {
        grantId: command.grantId,
        sources: command.sources,
        placement: command.placement,
        ...(command.videoTrackId ? { videoTrackId: command.videoTrackId } : {}),
        ...(command.audioTrackId ? { audioTrackId: command.audioTrackId } : {}),
      },
    };
  }
  if (command.type === 'transcription.start') {
    return {
      tool: 'transcription',
      action: 'start',
      request: {
        mode: command.mode,
        trackIds: command.trackIds,
        ranges: command.ranges,
        language: command.language,
        speakerMode: command.speakerMode,
        providerPolicy: command.providerPolicy,
        ...(command.providerId ? { providerId: command.providerId } : {}),
      },
    };
  }
  if (command.type === 'job.cancel') return { tool: 'job-cancel', jobId: command.jobId };
  if (command.type === 'export.start') {
    return {
      tool: 'export',
      action: 'start',
      request: {
        format: command.format,
        grantId: command.grantId,
        destinationPath: command.destinationPath,
        ...(command.overwriteGrantId
          ? { overwriteGrantId: command.overwriteGrantId }
          : {}),
        ...(command.confirmation ? { confirmation: command.confirmation } : {}),
      },
    };
  }

  const durableCommand: DurableEditorUiCommand = command;
  validateOperationUnits(durableCommand);
  if (!context.operationId) {
    throw new Error('Durable editor commands require a stable operationId.');
  }
  if (durableCommand.type === 'subtitle.move'
    && durableCommand.targetTrackId !== durableCommand.trackId) {
    return {
      tool: 'edit',
      operations: [{
        operationId: `${context.operationId}:delete`,
        type: 'subtitle.delete',
        payload: {
          trackId: durableCommand.trackId,
          subtitleId: durableCommand.subtitleId,
        },
      }, {
        operationId: `${context.operationId}:insert`,
        type: 'subtitle.insert',
        payload: {
          trackId: durableCommand.targetTrackId,
          subtitle: {
            id: durableCommand.subtitleId,
            startOutputSample: durableCommand.startOutputSample,
            endOutputSample: durableCommand.endOutputSample,
            text: durableCommand.text,
          },
        },
      }],
    };
  }
  const { type, ...uiPayload } = durableCommand;
  let payload: Record<string, unknown> = uiPayload;
  switch (durableCommand.type) {
    case 'track.add':
      payload = {
        trackKind: durableCommand.kind,
        name: `${durableCommand.kind[0].toUpperCase()}${durableCommand.kind.slice(1)} track`,
        ...(durableCommand.beforeTrackId ? { beforeTrackId: durableCommand.beforeTrackId } : {}),
      };
      break;
    case 'track.rename':
    case 'track.set-state': {
      const { trackKind, trackId, ...state } = durableCommand;
      payload = { trackKind, trackId, ...state };
      break;
    }
    case 'track.delete':
      payload = {
        trackKind: durableCommand.trackKind,
        trackId: durableCommand.trackId,
        policy: durableCommand.policy === 'require-empty'
          ? 'empty-only'
          : durableCommand.policy,
        ...(durableCommand.rehomeTrackId
          ? { rehomeTrackId: durableCommand.rehomeTrackId }
          : {}),
      };
      break;
    case 'track.reorder':
      payload = {
        trackKind: durableCommand.trackKind,
        trackId: durableCommand.trackId,
        ...(durableCommand.beforeTrackId
          ? { beforeId: durableCommand.beforeTrackId }
          : {}),
      };
      break;
    case 'video-clip.move':
      payload = {
        clipId: durableCommand.clipId,
        targetTrackId: durableCommand.trackId,
        timelineStartFrame: durableCommand.timelineFrame,
      };
      break;
    case 'video-clip.trim':
      payload = {
        clipId: durableCommand.clipId,
        sourceStartSeconds: durableCommand.sourceStartSeconds,
        sourceEndSeconds: durableCommand.sourceEndSeconds,
        ...(durableCommand.timelineStartFrame === undefined
          ? {}
          : { timelineStartFrame: durableCommand.timelineStartFrame }),
      };
      break;
    case 'video-clip.split':
      payload = { clipId: durableCommand.clipId, atFrame: durableCommand.timelineFrame };
      break;
    case 'video-clip.detach-audio':
      payload = {
        clipId: durableCommand.clipId,
        audioTrackId: durableCommand.audioTrackId,
      };
      break;
    case 'video-clip.relink-audio':
      payload = {
        videoClipId: durableCommand.videoClipId,
        audioTrackId: durableCommand.audioTrackId,
        audioClipId: durableCommand.audioClipId,
      };
      break;
    case 'video-clip.set-audio': {
      if (!Number.isFinite(context.projectFps) || (context.projectFps ?? 0) <= 0) {
        throw new Error('video-clip.set-audio requires the explicit project frame rate.');
      }
      const projectFps = context.projectFps as number;
      payload = {
        clipId: durableCommand.clipId,
        audio: {
          linkState: 'linked',
          muted: durableCommand.muted,
          gainDb: durableCommand.gainDb,
          fadeInFrames: Math.round(
            durableCommand.fadeInOutputSamples48k / OUTPUT_AUDIO_SAMPLE_RATE * projectFps,
          ),
          fadeOutFrames: Math.round(
            durableCommand.fadeOutOutputSamples48k / OUTPUT_AUDIO_SAMPLE_RATE * projectFps,
          ),
        },
      };
      break;
    }
    case 'audio-clip.move':
      payload = {
        clipId: durableCommand.clipId,
        targetTrackId: durableCommand.trackId,
        timelineStartFrame: durableCommand.timelineFrame,
      };
      break;
    case 'audio-clip.trim': {
      const { clipId, sourceRange } = durableCommand;
      payload = {
        clipId,
        sourceRange: sourceRange.domain === 'audio-source-native-samples'
          ? {
              domain: 'native-samples',
              audioSourceId: sourceRange.audioSourceId,
              nativeSampleRateHz: sourceRange.nativeSampleRateHz,
              startNativeSample: sourceRange.startNativeSample,
              endNativeSample: sourceRange.endNativeSample,
            }
          : {
              domain: 'seconds',
              videoSourceId: sourceRange.videoSourceId,
              startSeconds: sourceRange.startSeconds,
              endSeconds: sourceRange.endSeconds,
            },
      };
      break;
    }
    case 'audio-clip.split':
      payload = {
        clipId: durableCommand.clipId,
        atOutputSample: durableCommand.timelineOutputSample,
      };
      break;
    case 'subtitle.insert':
      payload = {
        trackId: durableCommand.trackId,
        subtitle: {
          id: durableCommand.subtitleId,
          startOutputSample: durableCommand.startOutputSample,
          endOutputSample: durableCommand.endOutputSample,
          text: durableCommand.text,
        },
      };
      break;
    case 'subtitle.move':
      payload = {
        trackId: durableCommand.trackId,
        subtitleId: durableCommand.subtitleId,
        startOutputSample: durableCommand.startOutputSample,
      };
      break;
    case 'subtitle.trim':
      payload = {
        trackId: durableCommand.trackId,
        subtitleId: durableCommand.subtitleId,
        startOutputSample: durableCommand.startOutputSample,
        endOutputSample: durableCommand.endOutputSample,
      };
      break;
    case 'subtitle.split':
      payload = {
        trackId: durableCommand.trackId,
        subtitleId: durableCommand.subtitleId,
        atOutputSample: durableCommand.outputSample,
      };
      break;
    case 'subtitle.set-order':
      payload = {
        trackId: durableCommand.trackId,
        subtitleId: durableCommand.subtitleId,
        ...(durableCommand.beforeSubtitleId
          ? { beforeId: durableCommand.beforeSubtitleId }
          : {}),
      };
      break;
    case 'narrative.set-speaker-visibility':
      payload = { showSpeakers: durableCommand.visible };
      break;
    case 'narrative.change-block-margin':
      payload = {
        blockId: durableCommand.blockId,
        side: durableCommand.side === 'start' ? 'pre' : 'post',
        policy: {
          kind: 'margin',
          mode: 'explicit',
          requestedSamples16k: durableCommand.marginSamples16k,
        },
      };
      break;
    case 'narrative.change-global-margins':
      payload = {
        preSamples16k: durableCommand.preMarginSamples16k,
        postSamples16k: durableCommand.postMarginSamples16k,
      };
      break;
    case 'narrative.delete-all-silences':
      payload = durableCommand.trackId
        ? { scope: { kind: 'track', trackId: durableCommand.trackId } }
        : { scope: { kind: 'document' } };
      break;
    default:
      break;
  }
  return {
    tool: 'edit',
    operations: [{
      operationId: context.operationId,
      type,
      payload,
    } as CoreSemanticOperation],
  };
}

export const secondsToProjectFrame = (seconds: number, fps: number): number => (
  Number.isFinite(seconds) && Number.isFinite(fps) && fps > 0
    ? Math.max(0, Math.round(seconds * fps))
    : 0
);

export const secondsToOutputSample = (seconds: number): number => (
  Number.isFinite(seconds)
    ? Math.max(0, Math.round(seconds * OUTPUT_AUDIO_SAMPLE_RATE))
    : 0
);

export const secondsToNarrativeSample = (seconds: number): number => (
  Number.isFinite(seconds)
    ? Math.max(0, Math.round(seconds * NARRATIVE_SAMPLE_RATE))
    : 0
);
