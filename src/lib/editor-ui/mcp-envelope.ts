import type {
  EditorUiCommandResult,
  EditorUiEvent,
  EditorUiJob,
  EditorUiStateToken,
} from './contracts';
import type {
  McpEventRecord,
  McpEventsReadData,
  McpJobState,
} from './mcp-projection-contract';

export interface McpToolWarning {
  code: string;
  message: string;
}

export interface McpToolSuccess<Data> {
  ok: true;
  data: Data;
  state: EditorUiStateToken;
  warnings: McpToolWarning[];
  replayed: boolean;
  committedState?: EditorUiStateToken;
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

export type { McpJobState } from './mcp-projection-contract';

export const normalizeMcpJobState = (state: McpJobState): EditorUiJob['state'] => {
  switch (state) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'stale':
    case 'interrupted':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
};

const eventKind = (type: McpEventRecord['type']): EditorUiEvent['kind'] => {
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

export const normalizeMcpEvent = (
  event: McpEventRecord,
  previousCursor: string,
): EditorUiEvent => ({
  eventId: `${event.type}:${event.sequence}`,
  previousCursor,
  cursor: event.cursor,
  stateToken: event.state,
  kind: eventKind(event.type),
});

export const normalizeMcpEvents = (
  data: McpEventsReadData,
  afterCursor: string,
): EditorUiEvent[] => {
  let previousCursor = afterCursor;
  return data.events.map((event) => {
    const normalized = normalizeMcpEvent(event, previousCursor);
    previousCursor = event.cursor;
    return normalized;
  });
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
