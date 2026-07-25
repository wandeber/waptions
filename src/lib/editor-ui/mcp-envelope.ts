import type {
  EditorUiCommandResult,
  EditorUiEvent,
  EditorUiJob,
  EditorUiSnapshot,
  EditorUiStateToken,
} from './contracts';

export interface McpToolWarning {
  code: string;
  message: string;
}

export interface McpToolSuccess<Data> {
  ok: true;
  data: Data;
  state: EditorUiStateToken;
  warnings: McpToolWarning[];
}

export interface McpToolFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  state?: EditorUiStateToken;
}

export type McpToolEnvelope<Data> = McpToolSuccess<Data> | McpToolFailure;

export type McpJobState =
  | 'pending'
  | 'queued'
  | 'active'
  | 'running'
  | 'recovering'
  | 'paused'
  | 'succeeded'
  | 'completed'
  | 'error'
  | 'failed'
  | 'cancelled'
  | 'canceled'
  | 'stale'
  | 'interrupted';

export interface McpEditorJob extends Omit<EditorUiJob, 'state'> {
  state: McpJobState;
}

export type McpEditorEventType =
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

const MCP_EDITOR_EVENT_TYPES = new Set<McpEditorEventType>([
  'session.recovered',
  'project.snapshot',
  'project.mutated',
  'history.changed',
  'job.changed',
  'artifact.created',
  'diagnostics.changed',
  'presence.changed',
  'view.changed',
  'source.invalidated',
]);

export interface McpEditorEvent {
  eventId: string;
  previousCursor: string;
  cursor: string;
  type: McpEditorEventType;
  state: EditorUiStateToken;
  editorUiSnapshot?: EditorUiSnapshot;
}

export interface McpEditorSnapshotData {
  editorUiSnapshot: EditorUiSnapshot & { jobs: McpEditorJob[] };
}

export interface McpEditorCommandData {
  editorUiCommandResult: Omit<Extract<EditorUiCommandResult, { ok: true }>, 'stateToken'>;
  editorUiSnapshot?: EditorUiSnapshot & { jobs: McpEditorJob[] };
}

export interface McpEditorEventsData {
  editorUiEvents: {
    events: McpEditorEvent[];
    cursorExpired?: boolean;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const isEditorUiSnapshotProjection = (value: unknown): value is EditorUiSnapshot => {
  if (!isRecord(value)
    || !isRecord(value.stateToken)
    || !isRecord(value.project)
    || !isRecord(value.view)
    || !isRecord(value.playback)
    || !Array.isArray(value.jobs)
    || !Array.isArray(value.presence)
    || !Array.isArray(value.pendingCommandIds)) {
    return false;
  }
  return typeof value.stateToken.sessionId === 'string'
    && typeof value.stateToken.projectId === 'string'
    && typeof value.stateToken.sessionEpoch === 'string'
    && typeof value.stateToken.sessionRevision === 'number'
    && typeof value.stateToken.documentRevision === 'number'
    && typeof value.stateToken.audioGraphRevision === 'number'
    && (value.stateToken.narrativeRevision === undefined
      || typeof value.stateToken.narrativeRevision === 'number')
    && typeof value.stateToken.eventCursor === 'string'
    && typeof value.project.id === 'string'
    && typeof value.project.fps === 'number'
    && Array.isArray(value.project.tracks)
    && Array.isArray(value.project.narrativeBlocks)
    && typeof value.view.revision === 'number'
    && typeof value.playback.revision === 'number';
};

export const normalizeMcpJobState = (state: McpJobState): EditorUiJob['state'] => {
  switch (state) {
    case 'pending':
    case 'queued':
      return 'queued';
    case 'running':
    case 'active':
    case 'recovering':
    case 'paused':
      return 'running';
    case 'succeeded':
    case 'completed':
      return 'completed';
    case 'error':
    case 'failed':
    case 'stale':
    case 'interrupted':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
  }
  throw new Error(`Unsupported MCP job state: ${String(state)}`);
};

export const normalizeMcpSnapshot = (
  snapshot: McpEditorSnapshotData['editorUiSnapshot'],
  state: EditorUiStateToken,
): EditorUiSnapshot => {
  if (!isEditorUiSnapshotProjection(snapshot)) {
    throw new Error('The MCP editor snapshot projection was invalid.');
  }
  return {
    ...snapshot,
    stateToken: {
      ...snapshot.stateToken,
      ...state,
      ...(state.narrativeRevision === undefined
        ? {}
        : { narrativeRevision: state.narrativeRevision }),
    },
    jobs: snapshot.jobs.map((job) => ({
      ...job,
      state: normalizeMcpJobState(job.state),
    })),
  };
};

const eventKind = (type: McpEditorEventType): EditorUiEvent['kind'] => {
  switch (type) {
    case 'session.recovered':
    case 'project.snapshot':
      return 'snapshot';
    case 'project.mutated':
    case 'source.invalidated':
      return 'project';
    case 'history.changed':
      return 'history';
    case 'job.changed':
    case 'artifact.created':
    case 'diagnostics.changed':
      return 'job';
    case 'presence.changed':
      return 'presence';
    case 'view.changed':
      return 'view';
  }
};

export const normalizeMcpEvent = (value: McpEditorEvent | unknown): EditorUiEvent => {
  if (!value || typeof value !== 'object') {
    throw new Error('The MCP editor event projection was invalid.');
  }
  const event = value as Partial<McpEditorEvent>;
  if (typeof event.eventId !== 'string'
    || typeof event.previousCursor !== 'string'
    || typeof event.cursor !== 'string'
    || typeof event.type !== 'string'
    || !MCP_EDITOR_EVENT_TYPES.has(event.type as McpEditorEventType)
    || !event.state) {
    // Unknown vocabulary must trigger the controller's bounded refresh, never a partial apply.
    throw new Error('The MCP editor event vocabulary is unsupported.');
  }
  return {
    eventId: event.eventId,
    previousCursor: event.previousCursor,
    cursor: event.cursor,
    stateToken: event.state,
    kind: eventKind(event.type as McpEditorEventType),
    ...(event.editorUiSnapshot
      ? { snapshot: normalizeMcpSnapshot(event.editorUiSnapshot, event.state) }
      : {}),
  };
};

const conflictCodes = new Set([
  'SESSION_EPOCH_MISMATCH',
  'SESSION_REVISION_CONFLICT',
  'REVISION_CONFLICT',
  'NARRATIVE_REVISION_CONFLICT',
  'AUDIO_REVISION_CONFLICT',
  'PLAN_EXPIRED',
  'PLAN_INPUT_CHANGED',
]);

export const normalizeMcpFailure = (
  envelope: McpToolFailure,
  commandId: string,
): EditorUiCommandResult => ({
  ok: false,
  commandId,
  code: conflictCodes.has(envelope.error.code)
    ? 'conflict'
    : envelope.error.code === 'COORDINATOR_UNAVAILABLE'
      ? 'unavailable'
      : envelope.error.code === 'INVALID_REQUEST'
        || envelope.error.code === 'INVALID_OPERATION'
        ? 'invalid'
        : envelope.error.code === 'PATH_NOT_GRANTED'
          || envelope.error.code === 'LOCKED_TARGET'
          ? 'forbidden'
          : 'failed',
  message: envelope.error.message,
  actualStateToken: envelope.state,
});
