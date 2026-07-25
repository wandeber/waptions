import type {
  EditorUiCommandResult,
  EditorUiEvent,
  EditorUiSnapshot,
  EditorUiStateToken,
} from './contracts';

/**
 * Required P5A projection consumed by both the managed surface and the MCP App.
 *
 * This lives on the UI side intentionally: it is a compile-time integration seam, not a second
 * MCP server schema. P5A must expose the same closed fields under its authoritative
 * `{ ok, data, state, warnings }` envelope before the App resource is registered.
 */
export interface EditorUiSnapshotProjectionRequest {
  apiVersion: '2026-07-25';
  sessionId: string;
  viewId: string;
  projection: 'editor-ui';
}

export interface EditorUiSnapshotProjectionData {
  editorUiSnapshot: EditorUiSnapshot;
}

export interface EditorUiCommandProjectionData {
  editorUiCommandResult: Omit<
    Extract<EditorUiCommandResult, { ok: true }>,
    'stateToken' | 'snapshot'
  >;
  editorUiSnapshot?: EditorUiSnapshot;
  replayed?: boolean;
}

export interface EditorUiEventsProjectionData {
  editorUiEvents: {
    events: Array<{
      eventId: string;
      previousCursor: string;
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
      state: EditorUiStateToken;
      editorUiSnapshot?: EditorUiSnapshot;
    }>;
    cursorExpired?: boolean;
  };
}

export interface EditorUiAuthoritativeProjectionEnvelope<Data> {
  ok: true;
  data: Data;
  state: EditorUiStateToken;
  warnings: Array<{ code: string; message: string }>;
}

export type EditorUiNormalizedProjection = {
  snapshot: EditorUiSnapshot;
  commandResult: EditorUiCommandResult;
  events: EditorUiEvent[];
};
