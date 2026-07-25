import type {
  EditorUiCommand,
  EditorUiDurableCommand,
  EditorUiLinkedAudio,
  EditorUiRenderProfile,
  EditorUiSubtitleCue,
  EditorUiSubtitleStyle,
  EditorUiTrackKind,
} from './contracts';

export const EDITOR_UI_API_VERSION = '2026-07-25' as const;
export const OUTPUT_AUDIO_SAMPLE_RATE = 48_000 as const;
export const NARRATIVE_SAMPLE_RATE = 16_000 as const;
export const EDITOR_UI_MAX_BATCH_BYTES = 512 * 1024;

type DurableEditorUiCommand = EditorUiDurableCommand;

type UiPayload<Type extends DurableEditorUiCommand['type']> = Omit<
  Extract<DurableEditorUiCommand, { type: Type }>,
  'type'
>;

type CoreSemanticPayloadByType = {
  'project.set-name': UiPayload<'project.set-name'>;
  'render.set-profile': { profile: EditorUiRenderProfile };
  'render.set-background': UiPayload<'render.set-background'>;
  'track.add': {
    trackKind: EditorUiTrackKind;
    trackId?: string;
    name: string;
    beforeTrackId?: string;
  };
  'track.rename': UiPayload<'track.rename'>;
  'track.delete': {
    trackKind: EditorUiTrackKind;
    trackId: string;
    policy: 'empty-only' | 'delete-contents' | 'rehome';
    rehomeTrackId?: string;
  };
  'track.reorder': {
    trackKind: EditorUiTrackKind;
    trackId: string;
    beforeId?: string;
    afterId?: string;
  };
  'track.reorder-clips': UiPayload<'track.reorder-clips'>;
  'track.set-state': UiPayload<'track.set-state'>;
  'audio-track.set-gain': UiPayload<'audio-track.set-gain'>;
  'subtitle-track.set-unlinked-video-policy':
    UiPayload<'subtitle-track.set-unlinked-video-policy'>;
  'video-clip.insert': {
    clipId?: string;
    sourceId: string;
    trackId: string;
    timelineStartFrame: number;
    sourceStartSeconds: number;
    sourceEndSeconds: number;
    audio: CoreVideoClipAudio | null;
  };
  'video-clip.move': {
    clipId: string;
    targetTrackId: string;
    timelineStartFrame: number;
  };
  'video-clip.trim': UiPayload<'video-clip.trim'>;
  'video-clip.split': { clipId: string; atFrame: number; rightClipId?: string };
  'video-clip.delete': UiPayload<'video-clip.delete'>;
  'video-clip.duplicate': {
    clipId: string;
    duplicateId?: string;
    targetTrackId?: string;
    timelineStartFrame?: number;
  };
  'video-clip.set-order': UiPayload<'video-clip.set-order'>;
  'video-clip.detach-audio': UiPayload<'video-clip.detach-audio'>;
  'video-clip.relink-audio': UiPayload<'video-clip.relink-audio'>;
  'video-clip.set-audio': {
    clipId: string;
    audio: CoreVideoClipAudio | null;
  };
  'audio-clip.insert': { trackId: string; clip: CoreAudioClip };
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
  'audio-clip.split': { clipId: string; atOutputSample: number; rightClipId?: string };
  'audio-clip.delete': UiPayload<'audio-clip.delete'>;
  'audio-clip.duplicate': {
    clipId: string;
    duplicateId?: string;
    targetTrackId?: string;
    timelineStartFrame?: number;
  };
  'audio-clip.set-order': UiPayload<'audio-clip.set-order'>;
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
    rightSubtitleId?: string;
  };
  'subtitle.delete': UiPayload<'subtitle.delete'>;
  'subtitle.set-order': {
    trackId: string;
    subtitleId: string;
    beforeId?: string;
    afterId?: string;
  };
  'subtitle.bulk-replace': { trackId: string; subtitles: EditorUiSubtitleCue[] };
  'subtitle.set-track-style': { trackId: string; style: EditorUiSubtitleStyle };
  'narrative.activate': UiPayload<'narrative.activate'>;
  'narrative.release-tracks': UiPayload<'narrative.release-tracks'>;
  'narrative.set-editing-mode': UiPayload<'narrative.set-editing-mode'>;
  'narrative.reorder-blocks': UiPayload<'narrative.reorder-blocks'>;
  'narrative.split-block': UiPayload<'narrative.split-block'>;
  'narrative.merge-blocks': UiPayload<'narrative.merge-blocks'>;
  'narrative.delete-words': UiPayload<'narrative.delete-words'>;
  'narrative.delete-range': UiPayload<'narrative.delete-range'>;
  'narrative.trim-block': UiPayload<'narrative.trim-block'>;
  'narrative.insert-source-range': CoreNarrativeSourceRangePayload;
  'narrative.recover-source-range': CoreNarrativeSourceRangePayload;
  'narrative.extend-block': UiPayload<'narrative.extend-block'>;
  'narrative.set-word-text': UiPayload<'narrative.set-word-text'>;
  'narrative.set-word-speaker': UiPayload<'narrative.set-word-speaker'>;
  'narrative.delete-all-silences': {
    scope?: { kind: 'document' } | { kind: 'track'; trackId: string };
    currentPlayheadFrame?: number;
  };
  'narrative.change-block-margin': {
    blockId: string;
    side: 'pre' | 'post';
    policy:
      | {
          kind: 'margin';
          mode: 'explicit';
          requestedSamples16k: number;
        }
      | {
          kind: 'margin';
          mode: 'inherit-global';
          requestedSamples16k: null;
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
  'link.bind-target': UiPayload<'link.bind-target'>;
  'link.unlink-target': UiPayload<'link.unlink-target'>;
  'link.unbind-target': UiPayload<'link.unbind-target'>;
  'link.reanchor': UiPayload<'link.reanchor'>;
  'link.set-follow-policy': UiPayload<'link.set-follow-policy'>;
};

export type CoreSemanticOperationType = keyof CoreSemanticPayloadByType;

// The closed record makes an added/removed Core operation a compile error at this UI boundary.
const CORE_SEMANTIC_OPERATION_COVERAGE: Record<CoreSemanticOperationType, true> = {
  'project.set-name': true,
  'render.set-profile': true,
  'render.set-background': true,
  'track.add': true,
  'track.rename': true,
  'track.delete': true,
  'track.reorder': true,
  'track.reorder-clips': true,
  'track.set-state': true,
  'audio-track.set-gain': true,
  'subtitle-track.set-unlinked-video-policy': true,
  'video-clip.insert': true,
  'video-clip.move': true,
  'video-clip.trim': true,
  'video-clip.split': true,
  'video-clip.delete': true,
  'video-clip.duplicate': true,
  'video-clip.set-order': true,
  'video-clip.detach-audio': true,
  'video-clip.relink-audio': true,
  'video-clip.set-audio': true,
  'audio-clip.insert': true,
  'audio-clip.move': true,
  'audio-clip.trim': true,
  'audio-clip.split': true,
  'audio-clip.delete': true,
  'audio-clip.duplicate': true,
  'audio-clip.set-order': true,
  'audio-clip.set-gain': true,
  'audio-clip.set-fades': true,
  'subtitle.insert': true,
  'subtitle.update': true,
  'subtitle.move': true,
  'subtitle.trim': true,
  'subtitle.split': true,
  'subtitle.delete': true,
  'subtitle.set-order': true,
  'subtitle.bulk-replace': true,
  'subtitle.set-track-style': true,
  'narrative.activate': true,
  'narrative.release-tracks': true,
  'narrative.set-editing-mode': true,
  'narrative.reorder-blocks': true,
  'narrative.split-block': true,
  'narrative.merge-blocks': true,
  'narrative.delete-words': true,
  'narrative.delete-range': true,
  'narrative.trim-block': true,
  'narrative.insert-source-range': true,
  'narrative.recover-source-range': true,
  'narrative.extend-block': true,
  'narrative.set-word-text': true,
  'narrative.set-word-speaker': true,
  'narrative.delete-all-silences': true,
  'narrative.change-block-margin': true,
  'narrative.change-global-margins': true,
  'narrative.refine-boundary': true,
  'narrative.set-speaker-visibility': true,
  'link.discover-overlaps': true,
  'link.create-overlap': true,
  'link.bind-target': true,
  'link.unlink-target': true,
  'link.unbind-target': true,
  'link.reanchor': true,
  'link.set-follow-policy': true,
};

export const CORE_SEMANTIC_OPERATION_TYPES = Object.freeze(
  Object.keys(CORE_SEMANTIC_OPERATION_COVERAGE) as CoreSemanticOperationType[],
);

interface CoreVideoClipAudio {
  linkState: 'linked';
  muted: boolean;
  gainDb: number;
  fadeInFrames: number;
  fadeOutFrames: number;
}

type CoreAudioClip =
  | {
      id: string;
      timelineStartFrame: number;
      muted: boolean;
      gainDb: number;
      source: { kind: 'audio-source'; audioSourceId: string };
      sourceStartSample: number;
      sourceEndSample: number;
      timelineDurationSamples?: number;
      fadeInSamples: number;
      fadeOutSamples: number;
    }
  | {
      id: string;
      timelineStartFrame: number;
      muted: boolean;
      gainDb: number;
      source: { kind: 'video-source-audio'; videoSourceId: string };
      sourceStart: number;
      sourceEnd: number;
      fadeInFrames: number;
      fadeOutFrames: number;
    };

interface CoreNarrativeSourceRangePayload {
  recordId: string;
  sourceId: string;
  sourceRange: { startSample16k: number; endSample16k: number };
  destinationTrackId: string;
  targetIndex?: number;
  timelineStartFrame?: number;
  clipAudio: CoreVideoClipAudio | null;
}

export type CoreSemanticOperation = {
  [Type in keyof CoreSemanticPayloadByType]: {
    operationId: string;
    type: Type;
    payload: CoreSemanticPayloadByType[Type];
  };
}[keyof CoreSemanticPayloadByType];

export type EditorUiCommandRoute =
  | {
      tool: 'edit';
      operations: readonly CoreSemanticOperation[];
      history?: { label: string; category: string };
    }
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
        | { rowHeights: Record<string, number> }
        | {
            selectionIds?: string[];
            playheadFrame?: number;
            zoom?: number;
            scrollX?: number;
            rowHeights?: Record<string, number>;
            layout?: 'timeline' | 'text' | 'split';
            focusedPanel?: string;
            presentation?: 'inline' | 'fullscreen' | 'pip';
          };
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

const requireProjectFps = (fps: number | undefined, operation: string): number => {
  if (!Number.isFinite(fps) || (fps ?? 0) <= 0) {
    throw new Error(`${operation} requires the explicit project frame rate.`);
  }
  return fps as number;
};

const mapLinkedAudio = (
  audio: EditorUiLinkedAudio,
  projectFps: number | undefined,
  operation: string,
): CoreVideoClipAudio => {
  assertInteger(audio.fadeInOutputSamples48k, `${operation}.fadeInOutputSamples48k`);
  assertInteger(audio.fadeOutOutputSamples48k, `${operation}.fadeOutOutputSamples48k`);
  const fps = requireProjectFps(projectFps, operation);
  return {
    linkState: 'linked',
    muted: audio.muted,
    gainDb: audio.gainDb,
    fadeInFrames: Math.round(audio.fadeInOutputSamples48k / OUTPUT_AUDIO_SAMPLE_RATE * fps),
    fadeOutFrames: Math.round(audio.fadeOutOutputSamples48k / OUTPUT_AUDIO_SAMPLE_RATE * fps),
  };
};

const validateOperationUnits = (operation: DurableEditorUiCommand): void => {
  switch (operation.type) {
    case 'render.set-profile':
      assertPositiveInteger(operation.profile.fps.numerator, 'render.set-profile.fps.numerator');
      assertPositiveInteger(operation.profile.fps.denominator, 'render.set-profile.fps.denominator');
      assertPositiveInteger(operation.profile.width, 'render.set-profile.width');
      assertPositiveInteger(operation.profile.height, 'render.set-profile.height');
      return;
    case 'render.set-background':
      if (!/^#[0-9A-Fa-f]{6}$/.test(operation.color)) {
        throw new Error('render.set-background.color must use #RRGGBB.');
      }
      return;
    case 'track.set-state':
      if (operation.visible === undefined
        && operation.muted === undefined
        && operation.solo === undefined
        && operation.locked === undefined) {
        throw new Error('track.set-state requires at least one state field.');
      }
      return;
    case 'track.delete':
      if (operation.policy === 'rehome' && !operation.rehomeTrackId) {
        throw new Error('track.delete rehome requires rehomeTrackId.');
      }
      return;
    case 'track.reorder':
      if (Boolean(operation.beforeTrackId) === Boolean(operation.afterTrackId)) {
        throw new Error('track.reorder requires exactly one order anchor.');
      }
      return;
    case 'track.reorder-clips':
    case 'video-clip.set-order':
    case 'audio-clip.set-order':
    case 'subtitle.set-order':
      if (Boolean(operation.beforeId) === Boolean(operation.afterId)) {
        throw new Error(`${operation.type} requires exactly one order anchor.`);
      }
      return;
    case 'video-clip.insert':
    case 'video-clip.move':
    case 'video-clip.split':
    case 'audio-clip.insert':
    case 'audio-clip.move':
      assertInteger(operation.timelineFrame, `${operation.type}.timelineFrame`);
      if (operation.type === 'video-clip.insert'
        && (operation.sourceStartSeconds < 0
          || operation.sourceEndSeconds <= operation.sourceStartSeconds)) {
        throw new Error('video-clip.insert source timing must be a positive range.');
      }
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
    case 'video-clip.duplicate':
    case 'audio-clip.duplicate':
      if (operation.timelineFrame !== undefined) {
        assertInteger(operation.timelineFrame, `${operation.type}.timelineFrame`);
      }
      return;
    case 'video-clip.set-audio':
      if (operation.audio) {
        assertInteger(
          operation.audio.fadeInOutputSamples48k,
          'video-clip.set-audio.audio.fadeInOutputSamples48k',
        );
        assertInteger(
          operation.audio.fadeOutOutputSamples48k,
          'video-clip.set-audio.audio.fadeOutOutputSamples48k',
        );
      }
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
    case 'narrative.insert-source-range':
    case 'narrative.recover-source-range':
      assertInteger(operation.startSample16k, `${operation.type}.startSample16k`);
      assertInteger(operation.endSample16k, `${operation.type}.endSample16k`);
      if (operation.endSample16k <= operation.startSample16k) {
        throw new Error(`${operation.type} source samples must be a positive range.`);
      }
      if (operation.targetIndex !== undefined) {
        assertInteger(operation.targetIndex, `${operation.type}.targetIndex`);
      }
      if (operation.timelineStartFrame !== undefined) {
        assertInteger(operation.timelineStartFrame, `${operation.type}.timelineStartFrame`);
      }
      if ((operation.targetIndex === undefined) === (operation.timelineStartFrame === undefined)) {
        throw new Error(`${operation.type} requires exactly one destination coordinate.`);
      }
      return;
    case 'narrative.extend-block':
      assertInteger(operation.newStartSample16k, 'narrative.extend-block.newStartSample16k');
      assertInteger(operation.newEndSample16k, 'narrative.extend-block.newEndSample16k');
      if (operation.newEndSample16k <= operation.newStartSample16k) {
        throw new Error('narrative.extend-block source samples must be a positive range.');
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
    case 'subtitle.bulk-replace':
      for (let index = 0; index < operation.subtitles.length; index += 1) {
        const subtitle = operation.subtitles[index];
        assertInteger(
          subtitle.startOutputSample,
          `subtitle.bulk-replace.subtitles[${index}].startOutputSample`,
        );
        assertInteger(
          subtitle.endOutputSample,
          `subtitle.bulk-replace.subtitles[${index}].endOutputSample`,
        );
        if (subtitle.endOutputSample <= subtitle.startOutputSample) {
          throw new Error('subtitle.bulk-replace cues must use positive half-open ranges.');
        }
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
      if (operation.policy.mode === 'explicit') {
        assertInteger(
          operation.policy.marginSamples16k,
          'narrative.change-block-margin.policy.marginSamples16k',
        );
      }
      return;
    case 'narrative.change-global-margins':
      assertInteger(operation.preMarginSamples16k, 'narrative.change-global-margins.preMarginSamples16k');
      assertInteger(operation.postMarginSamples16k, 'narrative.change-global-margins.postMarginSamples16k');
      return;
    case 'narrative.reorder-blocks':
      if ((operation.targetIndex === undefined) === (operation.targetStartFrame === undefined)) {
        throw new Error('narrative.reorder-blocks requires exactly one destination coordinate.');
      }
      if (operation.targetIndex !== undefined) {
        assertInteger(operation.targetIndex, 'narrative.reorder-blocks.targetIndex');
      }
      if (operation.targetStartFrame !== undefined) {
        assertInteger(operation.targetStartFrame, 'narrative.reorder-blocks.targetStartFrame');
      }
      return;
    case 'narrative.split-block':
      assertInteger(operation.splitSample16k, 'narrative.split-block.splitSample16k');
      return;
    case 'narrative.delete-range':
      assertInteger(operation.start.sample16k, 'narrative.delete-range.start.sample16k');
      assertInteger(operation.end.sample16k, 'narrative.delete-range.end.sample16k');
      if (operation.currentPlayheadFrame !== undefined) {
        assertInteger(operation.currentPlayheadFrame, 'narrative.delete-range.currentPlayheadFrame');
      }
      return;
    case 'narrative.activate':
      for (const recordId of Object.values(operation.recordIdBySourceId)) {
        if (!/^sha256:[0-9a-f]{64}$/.test(recordId)) {
          throw new Error('narrative.activate record IDs must be canonical sha256 digests.');
        }
      }
      return;
    case 'narrative.trim-block':
      assertInteger(operation.sample16k, 'narrative.trim-block.sample16k');
      return;
    case 'narrative.delete-words':
      if (operation.currentPlayheadFrame !== undefined) {
        assertInteger(operation.currentPlayheadFrame, 'narrative.delete-words.currentPlayheadFrame');
      }
      return;
    case 'narrative.delete-all-silences':
      if (operation.currentPlayheadFrame !== undefined) {
        assertInteger(
          operation.currentPlayheadFrame,
          'narrative.delete-all-silences.currentPlayheadFrame',
        );
      }
      return;
    case 'link.bind-target':
      assertInteger(operation.activeStartSample16k, 'link.bind-target.activeStartSample16k');
      assertInteger(operation.activeEndSample16k, 'link.bind-target.activeEndSample16k');
      if (operation.activeEndSample16k <= operation.activeStartSample16k) {
        throw new Error('link.bind-target active samples must be a positive range.');
      }
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
  if (command.type === 'edit.batch') {
    if (!context.operationId) {
      throw new Error('Durable editor command batches require a stable operationId.');
    }
    if (command.commands.length === 0 || command.commands.length > 256) {
      throw new Error('Editor command batches require between 1 and 256 operations.');
    }
    if (new TextEncoder().encode(JSON.stringify(command)).byteLength > EDITOR_UI_MAX_BATCH_BYTES) {
      throw new Error('Editor command batches cannot exceed 512 KiB.');
    }
    const operations = command.commands.flatMap((operation, index) => {
      const mapped = mapEditorUiCommand(operation, {
        ...context,
        operationId: `${context.operationId}:${index}`,
      });
      if (mapped.tool !== 'edit') {
        throw new Error('Editor command batches may contain durable operations only.');
      }
      return mapped.operations;
    });
    if (operations.length > 256) {
      throw new Error('Expanded editor command batches cannot exceed 256 Core operations.');
    }
    if (new TextEncoder().encode(JSON.stringify(operations)).byteLength > EDITOR_UI_MAX_BATCH_BYTES) {
      throw new Error('Expanded editor command batches cannot exceed 512 KiB.');
    }
    return { tool: 'edit', operations, history: command.history };
  }
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
    if (!Number.isFinite(command.volume) || command.volume < 0 || command.volume > 1) {
      throw new Error('playback.set-volume.volume must be between 0 and 1.');
    }
    return { tool: 'playback', action: 'set-master-volume', volume: command.volume };
  }
  if (command.type === 'playback.set-muted') {
    return { tool: 'playback', action: 'set-master-mute', muted: command.muted };
  }
  if (command.type === 'playback.set-rate') {
    if (!Number.isFinite(command.rate) || command.rate < 0.1 || command.rate > 16) {
      throw new Error('playback.set-rate.rate must be between 0.1 and 16.');
    }
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
  if (command.type === 'view.update') {
    const projectFps = context.projectFps;
    const patch: Extract<EditorUiCommandRoute, { tool: 'view' }>['patch'] = {
      ...(command.patch.selectedIds === undefined
        ? {}
        : { selectionIds: command.patch.selectedIds }),
      ...(command.patch.playheadSeconds === undefined
        ? {}
        : {
            playheadFrame: secondsToProjectFrame(
              command.patch.playheadSeconds,
              requireProjectFps(projectFps, 'view.update.playheadSeconds'),
            ),
          }),
      ...(command.patch.zoom === undefined ? {} : { zoom: command.patch.zoom }),
      ...(command.patch.scrollLeft === undefined
        ? {}
        : { scrollX: command.patch.scrollLeft }),
      ...(command.patch.trackHeights === undefined
        ? {}
        : { rowHeights: command.patch.trackHeights }),
      ...(command.patch.activePane === undefined
        ? {}
        : { layout: command.patch.activePane }),
      ...(command.patch.focusedTrackId === undefined
        ? {}
        : { focusedPanel: command.patch.focusedTrackId ?? undefined }),
      ...(command.patch.presentation === undefined
        ? {}
        : {
            presentation: command.patch.presentation === 'picture-in-picture'
              ? 'pip'
              : command.patch.presentation,
          }),
    };
    return { tool: 'view', patch };
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
    case 'render.set-profile':
      payload = { profile: durableCommand.profile };
      break;
    case 'track.add':
      payload = {
        trackKind: durableCommand.kind,
        ...(durableCommand.trackId ? { trackId: durableCommand.trackId } : {}),
        name: durableCommand.name
          ?? `${durableCommand.kind[0].toUpperCase()}${durableCommand.kind.slice(1)} track`,
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
        ...(durableCommand.afterTrackId
          ? { afterId: durableCommand.afterTrackId }
          : {}),
      };
      break;
    case 'track.reorder-clips':
    case 'video-clip.set-order':
    case 'audio-clip.set-order':
    case 'subtitle.set-order': {
      const { beforeId, afterId, ...identity } = durableCommand;
      payload = {
        ...identity,
        ...(beforeId ? { beforeId } : {}),
        ...(afterId ? { afterId } : {}),
      };
      delete payload.type;
      break;
    }
    case 'video-clip.insert':
      payload = {
        ...(durableCommand.clipId ? { clipId: durableCommand.clipId } : {}),
        sourceId: durableCommand.sourceId,
        trackId: durableCommand.trackId,
        timelineStartFrame: durableCommand.timelineFrame,
        sourceStartSeconds: durableCommand.sourceStartSeconds,
        sourceEndSeconds: durableCommand.sourceEndSeconds,
        audio: durableCommand.audio
          ? mapLinkedAudio(durableCommand.audio, context.projectFps, durableCommand.type)
          : null,
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
      payload = {
        clipId: durableCommand.clipId,
        atFrame: durableCommand.timelineFrame,
        ...(durableCommand.rightClipId ? { rightClipId: durableCommand.rightClipId } : {}),
      };
      break;
    case 'video-clip.duplicate':
      payload = {
        clipId: durableCommand.clipId,
        ...(durableCommand.duplicateId ? { duplicateId: durableCommand.duplicateId } : {}),
        ...(durableCommand.targetTrackId ? { targetTrackId: durableCommand.targetTrackId } : {}),
        ...(durableCommand.timelineFrame === undefined
          ? {}
          : { timelineStartFrame: durableCommand.timelineFrame }),
      };
      break;
    case 'video-clip.detach-audio':
      payload = {
        clipId: durableCommand.clipId,
        audioTrackId: durableCommand.audioTrackId,
        ...(durableCommand.detachedClipId
          ? { detachedClipId: durableCommand.detachedClipId }
          : {}),
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
      payload = {
        clipId: durableCommand.clipId,
        audio: durableCommand.audio
          ? mapLinkedAudio(durableCommand.audio, context.projectFps, durableCommand.type)
          : null,
      };
      break;
    }
    case 'audio-clip.insert': {
      const id = durableCommand.clipId ?? `${context.operationId}:clip`;
      const source = durableCommand.source;
      assertInteger(durableCommand.fadeInOutputSamples48k, 'audio-clip.insert.fadeInOutputSamples48k');
      assertInteger(durableCommand.fadeOutOutputSamples48k, 'audio-clip.insert.fadeOutOutputSamples48k');
      if (source.domain === 'audio-source-native-samples') {
        assertPositiveInteger(source.nativeSampleRateHz, 'audio-clip.insert.source.nativeSampleRateHz');
        assertInteger(source.startNativeSample, 'audio-clip.insert.source.startNativeSample');
        assertInteger(source.endNativeSample, 'audio-clip.insert.source.endNativeSample');
        if (source.timelineDurationOutputSamples48k !== undefined) {
          assertPositiveInteger(
            source.timelineDurationOutputSamples48k,
            'audio-clip.insert.source.timelineDurationOutputSamples48k',
          );
        }
        if (source.endNativeSample <= source.startNativeSample) {
          throw new Error('audio-clip.insert native source samples must be a positive range.');
        }
        payload = {
          trackId: durableCommand.trackId,
          clip: {
            id,
            timelineStartFrame: durableCommand.timelineFrame,
            muted: durableCommand.muted,
            gainDb: durableCommand.gainDb,
            source: { kind: 'audio-source', audioSourceId: source.audioSourceId },
            sourceStartSample: source.startNativeSample,
            sourceEndSample: source.endNativeSample,
            ...(source.timelineDurationOutputSamples48k === undefined
              ? {}
              : { timelineDurationSamples: source.timelineDurationOutputSamples48k }),
            fadeInSamples: Math.round(
              durableCommand.fadeInOutputSamples48k / OUTPUT_AUDIO_SAMPLE_RATE
              * source.nativeSampleRateHz,
            ),
            fadeOutSamples: Math.round(
              durableCommand.fadeOutOutputSamples48k / OUTPUT_AUDIO_SAMPLE_RATE
              * source.nativeSampleRateHz,
            ),
          },
        };
      } else {
        const fps = requireProjectFps(context.projectFps, durableCommand.type);
        if (source.startSeconds < 0 || source.endSeconds <= source.startSeconds) {
          throw new Error('audio-clip.insert video source seconds must be a positive range.');
        }
        payload = {
          trackId: durableCommand.trackId,
          clip: {
            id,
            timelineStartFrame: durableCommand.timelineFrame,
            muted: durableCommand.muted,
            gainDb: durableCommand.gainDb,
            source: { kind: 'video-source-audio', videoSourceId: source.videoSourceId },
            sourceStart: source.startSeconds,
            sourceEnd: source.endSeconds,
            fadeInFrames: Math.round(
              durableCommand.fadeInOutputSamples48k / OUTPUT_AUDIO_SAMPLE_RATE * fps,
            ),
            fadeOutFrames: Math.round(
              durableCommand.fadeOutOutputSamples48k / OUTPUT_AUDIO_SAMPLE_RATE * fps,
            ),
          },
        };
      }
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
        ...(durableCommand.rightClipId ? { rightClipId: durableCommand.rightClipId } : {}),
      };
      break;
    case 'audio-clip.duplicate':
      payload = {
        clipId: durableCommand.clipId,
        ...(durableCommand.duplicateId ? { duplicateId: durableCommand.duplicateId } : {}),
        ...(durableCommand.targetTrackId ? { targetTrackId: durableCommand.targetTrackId } : {}),
        ...(durableCommand.timelineFrame === undefined
          ? {}
          : { timelineStartFrame: durableCommand.timelineFrame }),
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
        ...(durableCommand.rightSubtitleId
          ? { rightSubtitleId: durableCommand.rightSubtitleId }
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
        policy: durableCommand.policy.mode === 'explicit'
          ? {
              kind: 'margin',
              mode: 'explicit',
              requestedSamples16k: durableCommand.policy.marginSamples16k,
            }
          : {
              kind: 'margin',
              mode: 'inherit-global',
              requestedSamples16k: null,
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
      payload = {
        ...(durableCommand.trackId
          ? { scope: { kind: 'track', trackId: durableCommand.trackId } }
          : { scope: { kind: 'document' } }),
        ...(durableCommand.currentPlayheadFrame === undefined
          ? {}
          : { currentPlayheadFrame: durableCommand.currentPlayheadFrame }),
      };
      break;
    case 'narrative.insert-source-range':
    case 'narrative.recover-source-range':
      payload = {
        recordId: durableCommand.recordId,
        sourceId: durableCommand.sourceId,
        sourceRange: {
          startSample16k: durableCommand.startSample16k,
          endSample16k: durableCommand.endSample16k,
        },
        destinationTrackId: durableCommand.destinationTrackId,
        ...(durableCommand.targetIndex === undefined
          ? {}
          : { targetIndex: durableCommand.targetIndex }),
        ...(durableCommand.timelineStartFrame === undefined
          ? {}
          : { timelineStartFrame: durableCommand.timelineStartFrame }),
        clipAudio: durableCommand.clipAudio
          ? mapLinkedAudio(durableCommand.clipAudio, context.projectFps, durableCommand.type)
          : null,
      };
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
