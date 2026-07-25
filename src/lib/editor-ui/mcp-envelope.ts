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
};

export const normalizeMcpSnapshot = (
  snapshot: McpEditorSnapshotData['editorUiSnapshot'],
  state: EditorUiStateToken,
): EditorUiSnapshot => ({
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
});

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

export const normalizeMcpEvent = (event: McpEditorEvent): EditorUiEvent => ({
  eventId: event.eventId,
  previousCursor: event.previousCursor,
  cursor: event.cursor,
  stateToken: event.state,
  kind: eventKind(event.type),
  ...(event.editorUiSnapshot
    ? { snapshot: normalizeMcpSnapshot(event.editorUiSnapshot, event.state) }
    : {}),
});

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
