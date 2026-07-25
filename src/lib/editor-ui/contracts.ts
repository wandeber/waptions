/**
 * UI-only projection shared by every editor host.
 *
 * This contract deliberately avoids engine document types. The coordinator, the standalone
 * Zustand adapter, and an MCP App may evolve their persistence independently while the visual
 * editor continues to consume one stable, bounded projection.
 */
export interface EditorUiStateToken {
  sessionId: string;
  projectId: string;
  sessionEpoch: string;
  sessionRevision: number;
  documentRevision: number;
  audioGraphRevision: number;
  narrativeRevision?: number;
  eventCursor: string;
}

export type EditorUiPresentationMode = 'inline' | 'fullscreen' | 'picture-in-picture';
export type EditorUiConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'degraded'
  | 'offline'
  | 'failed';
export type EditorUiPane = 'timeline' | 'text';
export type EditorUiDrawer = 'media' | 'properties' | 'history' | 'jobs' | null;
export type EditorUiTrackKind = 'video' | 'audio' | 'subtitle';
export type EditorUiClipKind = 'video' | 'audio' | 'subtitle' | 'silence' | 'text';

export type EditorUiAudioSourceRange =
  | {
      domain: 'audio-source-native-samples';
      audioSourceId: string;
      nativeSampleRateHz: number;
      startNativeSample: number;
      endNativeSample: number;
    }
  | {
      domain: 'video-source-seconds';
      videoSourceId: string;
      startSeconds: number;
      endSeconds: number;
    };

export interface EditorUiRenderProfile {
  fps: { numerator: number; denominator: number };
  width: number;
  height: number;
  audioSampleRate: 48_000;
  isFrameRateLocked: boolean;
  isCanvasSizeLocked: boolean;
}

export interface EditorUiLinkedAudio {
  muted: boolean;
  gainDb: number;
  fadeInOutputSamples48k: number;
  fadeOutOutputSamples48k: number;
}

export type EditorUiOrderAnchor =
  | { beforeId: string; afterId?: never }
  | { beforeId?: never; afterId: string }
  | { beforeId?: never; afterId?: never };

export interface EditorUiSubtitleCue {
  id: string;
  startOutputSample: number;
  endOutputSample: number;
  text: string;
}

export interface EditorUiSubtitleStyle {
  fadeInDuration: number;
  fadeOutDuration: number;
  initialScale: number;
  bounceStrength: number;
  useElasticEffect: boolean;
  fontSize: number;
  textColor: string;
  strokeWidth: number;
  strokeColor: string;
  fontWeight: number;
  textCase: 'normal' | 'uppercase' | 'lowercase';
  textAlign: 'left' | 'center' | 'right';
  hidePunctuation: boolean;
  punctuationChars: string;
  removeAccents: boolean;
  fontFamily: string;
  numberOfLines: number;
  position: { x: number; y: number };
  backgroundColor: string;
  backgroundOpacity: number;
  backgroundBorderColor: string;
  backgroundBorderWidth: number;
  backgroundMarginVertical: number;
  backgroundMarginHorizontal: number;
  backgroundBorderRadius: number;
  backgroundOffsetX: number;
  backgroundOffsetY: number;
}

export const DEFAULT_EDITOR_UI_SUBTITLE_STYLE: EditorUiSubtitleStyle = {
  fadeInDuration: 0.2,
  fadeOutDuration: 0.2,
  initialScale: 1.5,
  bounceStrength: 1.7,
  useElasticEffect: true,
  fontSize: 48,
  textColor: '#FFF50B',
  strokeWidth: 6,
  strokeColor: '#000000',
  fontWeight: 800,
  textCase: 'uppercase',
  textAlign: 'center',
  hidePunctuation: false,
  punctuationChars: '¿?:-,.;¡!',
  removeAccents: false,
  fontFamily: 'Arial',
  numberOfLines: 1,
  position: { x: 50, y: 80 },
  backgroundColor: '#000000',
  backgroundOpacity: 0.5,
  backgroundBorderColor: '#FFF50B',
  backgroundBorderWidth: 2,
  backgroundMarginVertical: 8,
  backgroundMarginHorizontal: 16,
  backgroundBorderRadius: 8,
  backgroundOffsetX: 0,
  backgroundOffsetY: 0,
};

export type EditorUiAudioInsertSource =
  | {
      domain: 'audio-source-native-samples';
      audioSourceId: string;
      nativeSampleRateHz: number;
      startNativeSample: number;
      endNativeSample: number;
      timelineDurationOutputSamples48k?: number;
    }
  | {
      domain: 'video-source-seconds';
      videoSourceId: string;
      startSeconds: number;
      endSeconds: number;
    };

export interface EditorUiHostCapabilities {
  canEdit: boolean;
  canImportMedia: boolean;
  canTranscribe: boolean;
  canExport: boolean;
  canPresentFullscreen: boolean;
  canPresentPictureInPicture: boolean;
  canSubscribeToEvents: boolean;
}

export interface EditorUiViewState {
  revision: number;
  presentation: EditorUiPresentationMode;
  activePane: EditorUiPane;
  openDrawer: EditorUiDrawer;
  inspectorVisible: boolean;
  timelineHeight: number;
  inspectorWidth: number;
  zoom: number;
  scrollLeft: number;
  playheadSeconds: number;
  selectedIds: string[];
  focusedTrackId: string | null;
  trackHeights: Record<string, number>;
}

export interface EditorUiClip {
  id: string;
  trackId: string;
  sourceId?: string;
  kind: EditorUiClipKind;
  label: string;
  startSeconds: number;
  durationSeconds: number;
  sourceOffsetSeconds: number;
  sourceDurationSeconds?: number;
  audioSourceRange?: EditorUiAudioSourceRange;
  hasLinkedAudio?: boolean;
  linkedTargetIds: string[];
  muted?: boolean;
  gainDb?: number;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
  text?: string;
  speaker?: string;
  color?: string;
}

export interface EditorUiTrack {
  id: string;
  kind: EditorUiTrackKind;
  name: string;
  clips: EditorUiClip[];
  locked: boolean;
  visible?: boolean;
  muted?: boolean;
  solo?: boolean;
  gainDb?: number;
  unlinkedVideoPolicy?: 'preserve-absolute' | 'ripple-with-video-edit' | 'remove-with-deleted-video-range';
  subtitleStyle?: EditorUiSubtitleStyle;
  height: number;
}

export interface EditorUiNarrativeBlock {
  id: string;
  clipId: string | null;
  kind: 'speech' | 'silence';
  text: string;
  sourceStartSample16k: number;
  sourceEndSample16k: number;
  startSeconds: number;
  durationSeconds: number;
  linkedTargetIds: string[];
  speaker?: string;
  preMarginSamples16k?: number;
  postMarginSamples16k?: number;
  recordId?: string;
  sourceId?: string;
  destinationTrackId?: string;
  words?: EditorUiNarrativeWord[];
}

export interface EditorUiNarrativeWord {
  id: string;
  text: string | null;
  speakerId: string | null;
  startSample16k: number;
  endSample16k: number;
}

export interface EditorUiHistoryEntry {
  id: string;
  label: string;
  timestamp: number;
  isCurrent: boolean;
  isRedo: boolean;
}

export interface EditorUiJob {
  id: string;
  kind: 'transcription' | 'export' | 'analysis' | 'import';
  label: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number | null;
  message?: string;
  artifactId?: string;
}

export interface EditorUiMediaSource {
  id: string;
  kind: 'video' | 'audio';
  label: string;
  durationSeconds: number;
  nativeSampleRateHz?: number;
  narrativeRecordId?: string;
}

export interface EditorUiArtifact {
  id: string;
  kind: 'export' | 'transcript' | 'proof' | 'bundle';
  label: string;
}

export interface EditorUiExportDestinationCapability {
  schemaVersion: 1;
  destinationId: string;
  grantId: string;
  stagingHandleId: string;
  mode: 'create-only' | 'overwrite-file';
  outputName: string;
  verifiedParentIdentity: string;
  overwriteConfirmationId?: string;
  expiresAt: string;
}

export interface EditorUiLink {
  id: string;
  kind: 'overlap' | 'binding';
  anchorBlockId: string;
  target: EditorUiDependentTarget;
  followPolicy: 'none' | 'follow';
  activeStartSample16k?: number;
  activeEndSample16k?: number;
}

export interface EditorUiPresence {
  viewId: string;
  label: string;
  color: string;
  selectedIds: string[];
  playheadSeconds?: number;
  isPresenter: boolean;
  isFollowing: boolean;
}

export interface EditorUiProject {
  id: string;
  name: string;
  durationSeconds: number;
  fps: number;
  renderProfile?: EditorUiRenderProfile;
  backgroundColor?: string;
  mediaSources?: EditorUiMediaSource[];
  artifacts?: EditorUiArtifact[];
  links?: EditorUiLink[];
  tracks: EditorUiTrack[];
  narrativeBlocks: EditorUiNarrativeBlock[];
  history: EditorUiHistoryEntry[];
  canUndo: boolean;
  canRedo: boolean;
  editingMode: 'ripple' | 'absolute';
  narrativeSettings: {
    globalPreMarginSamples16k: number;
    globalPostMarginSamples16k: number;
    showSpeakers: boolean;
  };
}

export interface EditorUiConflict {
  commandId: string;
  message: string;
  expectedRevision: number;
  actualRevision: number | null;
}

export interface EditorUiPlaybackState {
  revision: number;
  isPlaying: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
  presenterViewId: string | null;
  followingPresenter: boolean;
}

export interface EditorUiSnapshot {
  stateToken: EditorUiStateToken;
  connection: EditorUiConnectionState;
  capabilities: EditorUiHostCapabilities;
  project: EditorUiProject;
  view: EditorUiViewState;
  playback: EditorUiPlaybackState;
  jobs: EditorUiJob[];
  presence: EditorUiPresence[];
  pendingCommandIds: string[];
  conflict: EditorUiConflict | null;
  recentSemanticAction: string | null;
  errorMessage: string | null;
}

export type EditorUiDependentTarget =
  | { kind: 'video-clip'; clipId: string }
  | { kind: 'audio-clip'; trackId: string; clipId: string }
  | { kind: 'subtitle'; trackId: string; subtitleId: string };

export type EditorUiDurableCommand =
  | { type: 'project.set-name'; name: string }
  | { type: 'render.set-profile'; profile: EditorUiRenderProfile }
  | { type: 'render.set-background'; color: string }
  | { type: 'track.add'; kind: EditorUiTrackKind; trackId?: string; name?: string; beforeTrackId?: string }
  | { type: 'track.rename'; trackKind: EditorUiTrackKind; trackId: string; name: string }
  | {
      type: 'track.delete';
      trackKind: EditorUiTrackKind;
      trackId: string;
      policy: 'require-empty' | 'delete-contents' | 'rehome';
      rehomeTrackId?: string;
    }
  | {
      type: 'track.reorder';
      trackKind: EditorUiTrackKind;
      trackId: string;
      beforeTrackId?: string;
      afterTrackId?: string;
    }
  | ({ type: 'track.reorder-clips'; trackKind: 'audio' | 'subtitle'; trackId: string; clipId: string } & EditorUiOrderAnchor)
  | {
      type: 'track.set-state';
      trackKind: EditorUiTrackKind;
      trackId: string;
      visible?: boolean;
      muted?: boolean;
      solo?: boolean;
      locked?: boolean;
    }
  | { type: 'audio-track.set-gain'; trackId: string; gainDb: number }
  | { type: 'subtitle-track.set-unlinked-video-policy'; trackId: string; policy: 'preserve-absolute' | 'ripple-with-video-edit' | 'remove-with-deleted-video-range' }
  | {
      type: 'video-clip.insert';
      clipId?: string;
      sourceId: string;
      trackId: string;
      timelineFrame: number;
      sourceStartSeconds: number;
      sourceEndSeconds: number;
      audio: EditorUiLinkedAudio | null;
    }
  | { type: 'video-clip.move'; clipId: string; trackId: string; timelineFrame: number }
  | {
      type: 'video-clip.trim';
      clipId: string;
      sourceStartSeconds: number;
      sourceEndSeconds: number;
      timelineStartFrame?: number;
    }
  | { type: 'video-clip.split'; clipId: string; timelineFrame: number; rightClipId?: string }
  | { type: 'video-clip.delete'; clipId: string }
  | { type: 'video-clip.duplicate'; clipId: string; duplicateId?: string; targetTrackId?: string; timelineFrame?: number }
  | ({ type: 'video-clip.set-order'; clipId: string } & EditorUiOrderAnchor)
  | { type: 'video-clip.detach-audio'; clipId: string; audioTrackId: string; detachedClipId?: string }
  | {
      type: 'video-clip.relink-audio';
      videoClipId: string;
      audioTrackId: string;
      audioClipId: string;
    }
  | {
      type: 'video-clip.set-audio';
      clipId: string;
      audio: EditorUiLinkedAudio | null;
    }
  | {
      type: 'audio-clip.insert';
      trackId: string;
      clipId?: string;
      timelineFrame: number;
      source: EditorUiAudioInsertSource;
      muted: boolean;
      gainDb: number;
      fadeInOutputSamples48k: number;
      fadeOutOutputSamples48k: number;
    }
  | { type: 'audio-clip.move'; clipId: string; trackId: string; timelineFrame: number }
  | { type: 'audio-clip.trim'; clipId: string; sourceRange: EditorUiAudioSourceRange }
  | { type: 'audio-clip.split'; clipId: string; timelineOutputSample: number; rightClipId?: string }
  | { type: 'audio-clip.delete'; clipId: string }
  | { type: 'audio-clip.duplicate'; clipId: string; duplicateId?: string; targetTrackId?: string; timelineFrame?: number }
  | ({ type: 'audio-clip.set-order'; trackId: string; clipId: string } & EditorUiOrderAnchor)
  | { type: 'audio-clip.set-gain'; clipId: string; gainDb: number }
  | {
      type: 'audio-clip.set-fades';
      clipId: string;
      fadeInOutputSamples48k: number;
      fadeOutOutputSamples48k: number;
    }
  | {
      type: 'subtitle.insert';
      trackId: string;
      subtitleId: string;
      startOutputSample: number;
      endOutputSample: number;
      text: string;
    }
  | { type: 'subtitle.update'; trackId: string; subtitleId: string; text: string }
  | {
      type: 'subtitle.move';
      trackId: string;
      targetTrackId: string;
      subtitleId: string;
      startOutputSample: number;
      endOutputSample: number;
      text: string;
    }
  | {
      type: 'subtitle.trim';
      trackId: string;
      subtitleId: string;
      startOutputSample: number;
      endOutputSample: number;
    }
  | { type: 'subtitle.split'; trackId: string; subtitleId: string; outputSample: number; rightSubtitleId?: string }
  | { type: 'subtitle.delete'; trackId: string; subtitleId: string }
  | ({ type: 'subtitle.set-order'; trackId: string; subtitleId: string } & EditorUiOrderAnchor)
  | { type: 'subtitle.bulk-replace'; trackId: string; subtitles: EditorUiSubtitleCue[] }
  | { type: 'subtitle.set-track-style'; trackId: string; style: EditorUiSubtitleStyle }
  | {
      type: 'narrative.activate';
      selectedTrackIds: string[];
      recordIdBySourceId: Record<string, string>;
      splitOnSpeakerChange?: boolean;
    }
  | { type: 'narrative.release-tracks'; trackIds: string[] }
  | { type: 'narrative.set-editing-mode'; mode: 'ripple' | 'absolute' }
  | { type: 'narrative.reorder-blocks'; blockIds: string[]; targetIndex?: number; targetStartFrame?: number }
  | { type: 'narrative.split-block'; blockId: string; splitSample16k: number }
  | { type: 'narrative.merge-blocks'; leftBlockId: string; rightBlockId: string }
  | {
      type: 'narrative.delete-words';
      firstBlockId: string;
      firstWordId: string;
      lastBlockId: string;
      lastWordId: string;
      currentPlayheadFrame?: number;
    }
  | {
      type: 'narrative.delete-range';
      start: { blockId: string; sample16k: number };
      end: { blockId: string; sample16k: number };
      currentPlayheadFrame?: number;
    }
  | { type: 'narrative.trim-block'; blockId: string; side: 'start' | 'end'; sample16k: number }
  | {
      type: 'narrative.insert-source-range' | 'narrative.recover-source-range';
      recordId: string;
      sourceId: string;
      startSample16k: number;
      endSample16k: number;
      destinationTrackId: string;
      targetIndex?: number;
      timelineStartFrame?: number;
      clipAudio: EditorUiLinkedAudio | null;
    }
  | { type: 'narrative.extend-block'; blockId: string; newStartSample16k: number; newEndSample16k: number }
  | { type: 'narrative.set-word-text'; blockId: string; wordId: string; text: string | null }
  | { type: 'narrative.set-word-speaker'; blockId: string; wordId: string; speakerId: string | null }
  | { type: 'narrative.delete-all-silences'; trackId?: string; currentPlayheadFrame?: number }
  | {
      type: 'narrative.change-block-margin';
      blockId: string;
      side: 'start' | 'end';
      policy:
        | { mode: 'explicit'; marginSamples16k: number }
        | { mode: 'inherit-global' };
    }
  | { type: 'narrative.change-global-margins'; preMarginSamples16k: number; postMarginSamples16k: number }
  | {
      type: 'narrative.refine-boundary';
      blockId: string;
      side: 'start' | 'end';
      chosenSample16k: number;
      algorithmVersion: number;
      origin: 'manual' | 'quiet-assisted';
    }
  | { type: 'narrative.set-speaker-visibility'; visible: boolean }
  | { type: 'link.discover-overlaps' }
  | { type: 'link.create-overlap'; anchorBlockId: string; target: EditorUiDependentTarget; followPolicy?: 'none' | 'follow' }
  | {
      type: 'link.bind-target';
      anchorBlockId: string;
      target: EditorUiDependentTarget;
      activeStartSample16k: number;
      activeEndSample16k: number;
      followPolicy?: 'none' | 'follow';
    }
  | { type: 'link.unlink-target'; target: EditorUiDependentTarget }
  | { type: 'link.unbind-target'; target: EditorUiDependentTarget }
  | { type: 'link.reanchor'; target: EditorUiDependentTarget; anchorBlockId: string }
  | { type: 'link.set-follow-policy'; target: EditorUiDependentTarget; followPolicy: 'none' | 'follow' };

export type EditorUiCommand =
  | EditorUiDurableCommand
  | {
      type: 'edit.batch';
      commands: EditorUiDurableCommand[];
      history: { label: string; category: string };
    }
  | {
      type: 'media.import';
      mediaHandles: string[];
      placement:
        | { kind: 'register-only' }
        | {
            kind: 'place';
            ordering: 'natural';
            timelineStartFrame: number;
            videoTrackId?: string;
            audioTrackId?: string;
          };
    }
  | { type: 'view.select'; ids: string[] }
  | { type: 'view.set-track-height'; trackId: string; height: number }
  | {
      type: 'view.update';
      patch: Partial<Pick<
        EditorUiViewState,
        'selectedIds' | 'playheadSeconds' | 'zoom' | 'scrollLeft' | 'trackHeights'
        | 'activePane' | 'focusedTrackId' | 'presentation'
      >>;
    }
  | { type: 'history.undo' }
  | { type: 'history.redo' }
  | { type: 'history.jump'; entryId: string | null }
  | { type: 'playback.play' }
  | { type: 'playback.pause' }
  | { type: 'playback.seek'; timelineFrame: number }
  | { type: 'playback.set-volume'; volume: number }
  | { type: 'playback.set-muted'; muted: boolean }
  | { type: 'playback.set-rate'; rate: number }
  | { type: 'playback.presenter.claim' }
  | { type: 'playback.presenter.release' }
  | { type: 'playback.follow'; presenterViewId: string }
  | { type: 'playback.unfollow' }
  | {
      type: 'transcription.start';
      transcriptionKind: 'subtitle' | 'editorial';
      targetTrackIds: string[];
      ranges?: Array<{
        sourceId: string;
        startSample16k: number;
        endSample16k: number;
      }>;
      language: string | null;
      speakerMode: 'none' | 'diarized';
      providerPolicy: {
        kind: 'browser-local' | 'managed-local-endpoint' | 'openai-compatible';
        credentialCapabilityId?: string;
        endpointCapabilityId?: string;
        model?: string;
      };
    }
  | { type: 'job.cancel'; jobId: string }
  | {
      type: 'export.start';
      exportKind:
        | 'mp4-h264-aac'
        | 'webm'
        | 'portable-bundle'
        | 'reference-snapshot'
        | 'proof-record';
      destination: EditorUiExportDestinationCapability;
      overwriteConfirmation?: string;
    };

export interface EditorUiCommandRequest {
  commandId: string;
  command: EditorUiCommand;
  expected: Pick<
    EditorUiStateToken,
    'sessionEpoch' | 'sessionRevision' | 'documentRevision' | 'audioGraphRevision'
  > & Pick<EditorUiStateToken, 'narrativeRevision'>;
}

export type EditorUiCommandResult =
  | {
      ok: true;
      commandId: string;
      stateToken: EditorUiStateToken;
      snapshot?: EditorUiSnapshot;
    }
  | {
      ok: false;
      commandId: string;
      code: 'conflict' | 'forbidden' | 'invalid' | 'unavailable' | 'failed';
      message: string;
      actualStateToken?: EditorUiStateToken;
      snapshot?: EditorUiSnapshot;
    };

export interface EditorUiEvent {
  eventId: string;
  previousCursor: string;
  cursor: string;
  stateToken: EditorUiStateToken;
  kind: 'snapshot' | 'project' | 'history' | 'job' | 'presence' | 'playback' | 'view';
  snapshot?: EditorUiSnapshot;
}

export interface EditorUiMediaResolver {
  resolveSourceUrl(sourceId: string, signal?: AbortSignal): Promise<string>;
  resolveArtifactUrl(artifactId: string, signal?: AbortSignal): Promise<string>;
  releaseUrl(url: string): void;
}

export interface EditorUiServices {
  notify(message: string, tone?: 'neutral' | 'success' | 'warning' | 'error'): void;
  confirm(options: { title: string; message: string; confirmLabel: string }): Promise<boolean>;
  requestText(options: { title: string; label: string; initialValue?: string }): Promise<string | null>;
}

export interface EditorUiViewStateStorage {
  load(viewId: string): Partial<EditorUiViewState> | null;
  save(viewId: string, viewState: EditorUiViewState): void;
}

export interface EditorUiTransport {
  readSnapshot(signal?: AbortSignal): Promise<EditorUiSnapshot>;
  execute(request: EditorUiCommandRequest, signal?: AbortSignal): Promise<EditorUiCommandResult>;
  subscribe?(
    input: { cursor: string; signal: AbortSignal },
    onEvent: (event: EditorUiEvent) => void,
  ): Promise<void> | void;
  readEvents?(
    input: { cursor: string; limit: number; signal?: AbortSignal },
  ): Promise<{ events: EditorUiEvent[]; cursorExpired?: boolean }>;
  requestPresentation?(mode: EditorUiPresentationMode): Promise<EditorUiPresentationMode>;
  updateModelContext?(context: EditorUiModelContext): Promise<void>;
  close?(): void;
}

export interface EditorUiModelContext {
  project: { id: string; name: string };
  selection: Array<{ id: string; type: EditorUiClipKind | EditorUiTrackKind | 'narrative' }>;
  timecodeSeconds: number;
  revisions: {
    session: number;
    document: number;
    audioGraph: number;
    narrative?: number;
  };
  activeJobs: Array<Pick<EditorUiJob, 'id' | 'kind' | 'state' | 'progress'>>;
  recentSemanticAction: string | null;
}

export interface EditorUiController {
  readonly viewId: string;
  getSnapshot(): EditorUiSnapshot;
  getServerSnapshot(): EditorUiSnapshot;
  subscribe(listener: () => void): () => void;
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  dispatch(
    command: EditorUiCommand,
    options?: { optimistic?: (snapshot: EditorUiSnapshot) => EditorUiSnapshot },
  ): Promise<EditorUiCommandResult>;
  updateView(patch: Partial<EditorUiViewState>): void;
  requestPresentation(mode: EditorUiPresentationMode): Promise<EditorUiPresentationMode>;
  clearConflict(): void;
  close(): void;
}

export const DEFAULT_EDITOR_UI_CAPABILITIES: EditorUiHostCapabilities = {
  canEdit: false,
  canImportMedia: false,
  canTranscribe: false,
  canExport: false,
  canPresentFullscreen: false,
  canPresentPictureInPicture: false,
  canSubscribeToEvents: false,
};

export const DEFAULT_EDITOR_UI_VIEW_STATE: EditorUiViewState = {
  revision: 0,
  presentation: 'inline',
  activePane: 'timeline',
  openDrawer: null,
  inspectorVisible: true,
  timelineHeight: 320,
  inspectorWidth: 320,
  zoom: 1,
  scrollLeft: 0,
  playheadSeconds: 0,
  selectedIds: [],
  focusedTrackId: null,
  trackHeights: {},
};

export function createEmptyEditorUiSnapshot(input: {
  sessionId: string;
  projectId?: string;
  sessionEpoch?: string;
  eventCursor?: string;
  presentation?: EditorUiPresentationMode;
}): EditorUiSnapshot {
  const projectId = input.projectId ?? input.sessionId;
  return {
    stateToken: {
      sessionId: input.sessionId,
      projectId,
      sessionEpoch: input.sessionEpoch ?? 'connecting',
      sessionRevision: 0,
      documentRevision: 0,
      audioGraphRevision: 0,
      eventCursor: input.eventCursor ?? '0',
    },
    connection: 'connecting',
    capabilities: DEFAULT_EDITOR_UI_CAPABILITIES,
    project: {
      id: projectId,
      name: 'Connecting editor…',
      durationSeconds: 0,
      fps: 30,
      tracks: [],
      narrativeBlocks: [],
      history: [],
      canUndo: false,
      canRedo: false,
      editingMode: 'ripple',
      narrativeSettings: {
        globalPreMarginSamples16k: 0,
        globalPostMarginSamples16k: 0,
        showSpeakers: true,
      },
    },
    view: {
      ...DEFAULT_EDITOR_UI_VIEW_STATE,
      presentation: input.presentation ?? 'inline',
    },
    playback: {
      revision: 0,
      isPlaying: false,
      volume: 1,
      muted: false,
      playbackRate: 1,
      presenterViewId: null,
      followingPresenter: false,
    },
    jobs: [],
    presence: [],
    pendingCommandIds: [],
    conflict: null,
    recentSemanticAction: null,
    errorMessage: null,
  };
}
