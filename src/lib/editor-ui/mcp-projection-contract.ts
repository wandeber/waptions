import type { EditorUiStateToken } from './contracts';

export interface McpPage {
  hasMore: boolean;
  nextCursor?: string;
}

export interface McpGraphReference {
  id: string;
  kind: string;
  trackId?: string;
  startFrame?: number;
  endFrame?: number;
  label?: string;
}

export interface McpProjectSummaryData {
  projectId: string;
  name: string;
  renderProfile: {
    fps: { numerator: number; denominator: number };
    width: number;
    height: number;
    audioSampleRate: 48_000;
    isFrameRateLocked: boolean;
    isCanvasSizeLocked: boolean;
  };
  renderBackgroundColor: string;
  counts: {
    tracks: number;
    clips: number;
    subtitles: number;
    sources: number;
    links: number;
  };
  activeJobIds: string[];
  references: McpGraphReference[];
  page: McpPage;
}

export interface McpTimelineQueryData {
  entityKind: string;
  items: McpGraphReference[];
  page: McpPage;
}

export interface McpHistorySummary {
  entryId: string;
  label: string;
  category: string;
  occurredAt: string;
  operationIds: string[];
  fromRevision: number;
  toRevision: number;
}

export interface McpHistoryGetData {
  currentIndex: number;
  past: McpHistorySummary[];
  future: McpHistorySummary[];
  page: McpPage;
}

export type McpViewSelection =
  | { kind: 'none' }
  | {
      kind: 'tracks' | 'clips' | 'subtitles' | 'narrative';
      ids: string[];
    };

export interface McpViewData {
  view: {
    viewId: string;
    viewRevision: number;
    selection: McpViewSelection;
    playheadFrame: number;
    zoom: number;
    scrollLeft: number;
    focusedPanel?: string;
    presentation: 'inline' | 'fullscreen' | 'picture-in-picture';
    participantIds: string[];
  };
}

export interface McpPlaybackData {
  playbackRevision: number;
  playing: boolean;
  playheadFrame: number;
  rate: number;
  masterVolume: number;
  masterMuted: boolean;
  presenterViewId?: string;
  followingPresenter: boolean;
}

export type McpJobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'interrupted';

export interface McpJobRecord {
  schemaVersion: 1;
  jobId: string;
  projectId: string;
  kind: string;
  inputDigest: string;
  capturedState: EditorUiStateToken;
  jobSequence: number;
  state: McpJobState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  stage: string;
  fraction?: number;
  message?: string;
  cancellationRequested: boolean;
  cancellationRequestedAt?: string;
  checkpointRef?: string;
  resultArtifactIds: string[];
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

export interface McpJobListData {
  items: McpJobRecord[];
  page: McpPage;
}

export interface McpArtifactRecord {
  schemaVersion: 1;
  artifactId: string;
  projectId: string;
  jobId?: string;
  kind: string;
  contentDigest: string;
  byteLength: number;
  createdAt: string;
  expiresAt?: string;
  storageRef: string;
}

export interface McpArtifactListData {
  items: McpArtifactRecord[];
  page: McpPage;
}

export interface McpEventRecord {
  schemaVersion: 1;
  cursor: string;
  type:
    | 'session.recovered'
    | 'project.snapshot'
    | 'project.mutated'
    | 'history.changed'
    | 'job.changed'
    | 'artifact.created'
    | 'diagnostics.changed'
    | 'presence.changed'
    | 'view.changed'
    | 'source.invalidated';
  occurredAt: string;
  state: EditorUiStateToken;
  sequence: number;
  data: Record<string, unknown>;
}

export interface McpEventsReadData {
  events: McpEventRecord[];
  nextCursor: string;
  hasMore: boolean;
}
