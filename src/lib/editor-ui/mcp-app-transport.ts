import type {
  EditorUiCommandRequest,
  EditorUiCommandResult,
  EditorUiModelContext,
  EditorUiPresentationMode,
  EditorUiSnapshot,
  EditorUiTransport,
} from './contracts';
import {
  EDITOR_UI_API_VERSION,
  mapEditorUiCommand,
  type EditorUiCommandRoute,
} from './core-operation-mapper';
import {
  normalizeMcpEvent,
  normalizeMcpFailure,
  normalizeMcpSnapshot,
  type McpEditorCommandData,
  type McpEditorEventsData,
  type McpEditorSnapshotData,
  type McpToolEnvelope,
} from './mcp-envelope';
import { createWindowRpcBridge, type EditorUiRpcBridge } from './rpc-bridge';

interface McpToolResult {
  structuredContent?: unknown;
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

export interface McpAppToolMapping {
  snapshot: string;
  edit: string;
  history: string;
  playback: string;
  transcription: string;
  export: string;
  events: string;
  view: string;
  mediaImport: string;
  jobCancel: string;
}

export const DEFAULT_MCP_APP_TOOL_MAPPING: McpAppToolMapping = {
  // Rendering attaches an App and must never be used as the App's data refresh path.
  snapshot: 'waptions_project_get',
  edit: 'waptions_edit_apply',
  history: 'waptions_history_apply',
  playback: 'waptions_playback_control',
  transcription: 'waptions_transcription_start',
  export: 'waptions_export_start',
  events: 'waptions_events_read',
  view: 'waptions_view_update',
  mediaImport: 'waptions_media_import',
  jobCancel: 'waptions_job_cancel',
};

const commandTool = (route: EditorUiCommandRoute, mapping: McpAppToolMapping): string => {
  switch (route.tool) {
    case 'edit':
      return mapping.edit;
    case 'history':
      return mapping.history;
    case 'playback':
      return mapping.playback;
    case 'view':
      return mapping.view;
    case 'media-import':
      return mapping.mediaImport;
    case 'transcription':
      return mapping.transcription;
    case 'job-cancel':
      return mapping.jobCancel;
    case 'export':
      return mapping.export;
  }
};

const toolErrorMessage = (result: McpToolResult): string => (
  result.content?.find((item) => item.type === 'text')?.text
  ?? 'The Waptions tool returned an error.'
);

const requiredEnvelope = <Data>(
  result: McpToolResult,
): McpToolEnvelope<Data> => {
  if (typeof result.structuredContent !== 'object' || result.structuredContent === null) {
    throw new Error(result.isError
      ? toolErrorMessage(result)
      : 'The Waptions tool response did not include an authoritative envelope.');
  }
  const envelope = result.structuredContent as Partial<McpToolEnvelope<Data>>;
  if (typeof envelope.ok !== 'boolean') {
    throw new Error('The Waptions tool response envelope was invalid.');
  }
  return envelope as McpToolEnvelope<Data>;
};

export interface CreateMcpAppTransportOptions {
  bridge?: EditorUiRpcBridge;
  toolMapping?: Partial<McpAppToolMapping>;
  sessionId: string;
  viewId: string;
  initialSnapshot?: EditorUiSnapshot;
  availableDisplayModes?: readonly McpUiDisplayMode[];
}

export type McpUiDisplayMode = 'inline' | 'fullscreen' | 'pip';

const toMcpDisplayMode = (mode: EditorUiPresentationMode): McpUiDisplayMode => (
  mode === 'picture-in-picture' ? 'pip' : mode
);

export const fromMcpDisplayMode = (mode: McpUiDisplayMode): EditorUiPresentationMode => (
  mode === 'pip' ? 'picture-in-picture' : mode
);

/**
 * MCP Apps transport. It speaks only standard bridge methods and semantic Waptions tools; it has
 * no direct coordinator/network authority and never reads media capability URLs into model context.
 */
export function createMcpAppTransport(
  options: CreateMcpAppTransportOptions,
): EditorUiTransport {
  const bridge = options.bridge ?? createWindowRpcBridge({
    targetWindow: window.parent,
    requestIdPrefix: 'waptions-mcp-app',
  });
  const ownsBridge = options.bridge === undefined;
  const mapping = { ...DEFAULT_MCP_APP_TOOL_MAPPING, ...options.toolMapping };
  const availableDisplayModes = new Set<McpUiDisplayMode>(
    options.availableDisplayModes ?? ['inline'],
  );
  let bootstrapSnapshot = options.initialSnapshot;
  let latestSnapshot = options.initialSnapshot;
  const callTool = (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult> => bridge.request('tools/call', {
    name,
    arguments: args,
  }, signal);
  const mutationEnvelope = (request: EditorUiCommandRequest) => ({
    apiVersion: EDITOR_UI_API_VERSION,
    sessionId: options.sessionId,
    sessionEpoch: request.expected.sessionEpoch,
    expected: {
      sessionRevision: request.expected.sessionRevision,
      documentRevision: request.expected.documentRevision,
      audioGraphRevision: request.expected.audioGraphRevision,
      ...(request.expected.narrativeRevision === undefined
        ? {}
        : { narrativeRevision: request.expected.narrativeRevision }),
    },
    idempotencyKey: request.commandId,
  });
  const routeArguments = (
    request: EditorUiCommandRequest,
    route: EditorUiCommandRoute,
  ): Record<string, unknown> => {
    const common = mutationEnvelope(request);
    switch (route.tool) {
      case 'edit':
        return { ...common, operations: route.operations };
      case 'history':
        return {
          ...common,
          action: route.action,
          ...(route.action === 'jump' ? { historyEntryId: route.entryId ?? null } : {}),
        };
      case 'playback':
        return {
          ...common,
          viewId: options.viewId,
          expectedPlaybackRevision: latestSnapshot?.playback.revision ?? 0,
          action: route.action,
          ...(route.frame === undefined ? {} : { frame: route.frame }),
          ...(route.volume === undefined ? {} : { volume: route.volume }),
          ...(route.muted === undefined ? {} : { muted: route.muted }),
          ...(route.rate === undefined ? {} : { rate: route.rate }),
          ...(route.presenterViewId === undefined
            ? {}
            : { presenterViewId: route.presenterViewId }),
        };
      case 'view':
        return {
          ...common,
          viewId: options.viewId,
          expectedViewRevision: latestSnapshot?.view.revision ?? 0,
          patch: route.patch,
        };
      case 'media-import':
        return { ...common, ...route.request };
      case 'transcription':
        return { ...common, ...route.request };
      case 'job-cancel':
        return { ...common, jobId: route.jobId };
      case 'export':
        return { ...common, ...route.request };
    }
  };

  return {
    async readSnapshot(signal?: AbortSignal): Promise<EditorUiSnapshot> {
      if (bootstrapSnapshot) {
        const snapshot = bootstrapSnapshot;
        bootstrapSnapshot = undefined;
        latestSnapshot = snapshot;
        return snapshot;
      }
      const result = await callTool(mapping.snapshot, {
        apiVersion: EDITOR_UI_API_VERSION,
        sessionId: options.sessionId,
        viewId: options.viewId,
        projection: 'editor-ui',
      }, signal);
      const envelope = requiredEnvelope<McpEditorSnapshotData>(result);
      if (!envelope.ok) throw new Error(envelope.error.message);
      latestSnapshot = normalizeMcpSnapshot(envelope.data.editorUiSnapshot, envelope.state);
      return latestSnapshot;
    },
    async execute(
      request: EditorUiCommandRequest,
      signal?: AbortSignal,
    ): Promise<EditorUiCommandResult> {
      const route = mapEditorUiCommand(request.command, {
        operationId: `${request.commandId}:0`,
        projectFps: latestSnapshot?.project.fps,
      });
      const result = await callTool(
        commandTool(route, mapping),
        routeArguments(request, route),
        signal,
      );
      const envelope = requiredEnvelope<McpEditorCommandData>(result);
      if (!envelope.ok) return normalizeMcpFailure(envelope, request.commandId);
      if (envelope.data.editorUiSnapshot) {
        latestSnapshot = normalizeMcpSnapshot(
          envelope.data.editorUiSnapshot,
          envelope.state,
        );
      } else if (latestSnapshot) {
        latestSnapshot = {
          ...latestSnapshot,
          stateToken: envelope.state,
          view: route.tool === 'view'
            ? { ...latestSnapshot.view, revision: latestSnapshot.view.revision + 1 }
            : latestSnapshot.view,
          playback: route.tool === 'playback'
            ? { ...latestSnapshot.playback, revision: latestSnapshot.playback.revision + 1 }
            : latestSnapshot.playback,
        };
      }
      return {
        ...envelope.data.editorUiCommandResult,
        ok: true,
        commandId: request.commandId,
        stateToken: envelope.state,
        ...(latestSnapshot && envelope.data.editorUiSnapshot
          ? { snapshot: latestSnapshot }
          : {}),
      };
    },
    async readEvents({ cursor, limit, signal }) {
      const result = await callTool(mapping.events, {
        apiVersion: EDITOR_UI_API_VERSION,
        sessionId: options.sessionId,
        viewId: options.viewId,
        afterCursor: cursor,
        limit,
      }, signal);
      const envelope = requiredEnvelope<McpEditorEventsData>(result);
      if (!envelope.ok) {
        if (envelope.error.code === 'EVENT_CURSOR_EXPIRED') {
          return { events: [], cursorExpired: true };
        }
        throw new Error(envelope.error.message);
      }
      for (const event of envelope.data.editorUiEvents.events) {
        if (event.editorUiSnapshot) {
          latestSnapshot = normalizeMcpSnapshot(event.editorUiSnapshot, event.state);
        }
      }
      return {
        events: envelope.data.editorUiEvents.events.map(normalizeMcpEvent),
        cursorExpired: envelope.data.editorUiEvents.cursorExpired,
      };
    },
    async requestPresentation(
      mode: EditorUiPresentationMode,
    ): Promise<EditorUiPresentationMode> {
      const requestedMode = toMcpDisplayMode(mode);
      if (!availableDisplayModes.has(requestedMode)) return 'inline';
      try {
        const result = await bridge.request<{ mode?: McpUiDisplayMode }>(
          'ui/request-display-mode',
          { mode: requestedMode },
        );
        return result?.mode ? fromMcpDisplayMode(result.mode) : mode;
      } catch {
        // Older hosts may not implement presentation requests. Inline remains fully editable.
        return mode === 'inline' ? 'inline' : 'inline';
      }
    },
    updateModelContext(context: EditorUiModelContext): Promise<void> {
      return bridge.request('ui/update-model-context', { structuredContent: context });
    },
    close(): void {
      if (ownsBridge) bridge.close();
    },
  };
}
