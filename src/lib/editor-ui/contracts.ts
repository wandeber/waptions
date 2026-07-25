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

export type EditorUiCommand =
  | { type: 'project.set-name'; name: string }
  | {
      type: 'media.import';
      grantId: string;
      sources: Array<{ path: string; expectedSha256?: string }>;
      placement: 'register-only' | 'append-natural-order';
      videoTrackId?: string;
      audioTrackId?: string;
    }
  | { type: 'track.add'; kind: EditorUiTrackKind; beforeTrackId?: string }
  | { type: 'track.rename'; trackKind: EditorUiTrackKind; trackId: string; name: string }
  | {
      type: 'track.delete';
      trackKind: EditorUiTrackKind;
      trackId: string;
      policy: 'require-empty' | 'rehome';
      rehomeTrackId?: string;
    }
  | {
      type: 'track.reorder';
      trackKind: EditorUiTrackKind;
      trackId: string;
      beforeTrackId: string | null;
    }
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
  | { type: 'view.select'; ids: string[] }
  | { type: 'view.set-track-height'; trackId: string; height: number }
  | { type: 'video-clip.move'; clipId: string; trackId: string; timelineFrame: number }
  | {
      type: 'video-clip.trim';
      clipId: string;
      sourceStartSeconds: number;
      sourceEndSeconds: number;
      timelineStartFrame?: number;
    }
  | { type: 'video-clip.split'; clipId: string; timelineFrame: number }
  | { type: 'video-clip.delete'; clipId: string }
  | { type: 'video-clip.detach-audio'; clipId: string; audioTrackId: string }
  | {
      type: 'video-clip.relink-audio';
      videoClipId: string;
      audioTrackId: string;
      audioClipId: string;
    }
  | {
      type: 'video-clip.set-audio';
      clipId: string;
      muted: boolean;
      gainDb: number;
      fadeInOutputSamples48k: number;
      fadeOutOutputSamples48k: number;
    }
  | { type: 'audio-clip.move'; clipId: string; trackId: string; timelineFrame: number }
  | { type: 'audio-clip.trim'; clipId: string; sourceRange: EditorUiAudioSourceRange }
  | { type: 'audio-clip.split'; clipId: string; timelineOutputSample: number }
  | { type: 'audio-clip.delete'; clipId: string }
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
  | { type: 'subtitle.split'; trackId: string; subtitleId: string; outputSample: number }
  | { type: 'subtitle.delete'; trackId: string; subtitleId: string }
  | { type: 'subtitle.set-order'; trackId: string; subtitleId: string; beforeSubtitleId: string | null }
  | { type: 'subtitle.set-track-style'; trackId: string; style: Record<string, string | number | boolean> }
  | {
      type: 'narrative.activate';
      selectedTrackIds: string[];
      recordIdBySourceId: Record<string, string>;
      splitOnSpeakerChange?: boolean;
    }
  | { type: 'narrative.release-tracks'; trackIds: string[] }
  | { type: 'narrative.set-editing-mode'; mode: 'ripple' | 'absolute' }
  | { type: 'narrative.reorder-blocks'; blockIds: string[]; targetIndex: number }
  | { type: 'narrative.split-block'; blockId: string; splitSample16k: number }
  | { type: 'narrative.merge-blocks'; leftBlockId: string; rightBlockId: string }
  | {
      type: 'narrative.delete-range';
      start: { blockId: string; sample16k: number };
      end: { blockId: string; sample16k: number };
    }
  | { type: 'narrative.delete-all-silences'; trackId?: string }
  | { type: 'narrative.change-block-margin'; blockId: string; side: 'start' | 'end'; marginSamples16k: number }
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
  | { type: 'link.create-overlap'; anchorBlockId: string; target: EditorUiDependentTarget; followPolicy: 'none' | 'follow' }
  | { type: 'link.unlink-target'; target: EditorUiDependentTarget }
  | { type: 'link.reanchor'; target: EditorUiDependentTarget; anchorBlockId: string }
  | { type: 'link.set-follow-policy'; target: EditorUiDependentTarget; followPolicy: 'none' | 'follow' }
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
      mode: 'subtitle' | 'editorial';
      trackIds: string[];
      ranges: Array<{ startSample: number; endSample: number; sampleRate: 16_000 | 48_000 }>;
      language: string;
      speakerMode: 'none' | 'detect' | 'known-speakers';
      providerPolicy: 'browser-local' | 'managed-local-endpoint' | 'custom-openai-compatible';
      providerId?: string;
    }
  | { type: 'job.cancel'; jobId: string }
  | {
      type: 'export.start';
      format: 'mp4-h264-aac' | 'webm' | 'portable-bundle' | 'reference-snapshot' | 'proof';
      grantId: string;
      destinationPath: string;
      overwriteGrantId?: string;
      confirmation?: { acknowledged: boolean; phrase?: string };
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
