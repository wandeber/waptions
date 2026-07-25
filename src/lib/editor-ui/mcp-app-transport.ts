import {
  createEmptyEditorUiSnapshot,
  type EditorUiCommandRequest,
  type EditorUiCommandResult,
  type EditorUiModelContext,
  type EditorUiPresentationMode,
  type EditorUiSnapshot,
  type EditorUiStateToken,
  type EditorUiTransport,
} from './contracts';
import {
  EDITOR_UI_API_VERSION,
  mapEditorUiCommand,
  type EditorUiCommandRoute,
} from './core-operation-mapper';
import {
  normalizeMcpEvents,
  normalizeMcpFailure,
  type McpToolEnvelope,
} from './mcp-envelope';
import {
  mcpArtifactListDataSchema,
  mcpEventsReadDataSchema,
  mcpHistoryGetDataSchema,
  mcpJobListDataSchema,
  mcpProjectSummaryDataSchema,
  mcpTimelineQueryDataSchema,
  mcpUnknownDataSchema,
  mcpViewDataSchema,
  parseMcpToolEnvelope,
} from './mcp-output-validation';
import type {
  McpArtifactListData,
  McpEventsReadData,
  McpHistoryGetData,
  McpJobListData,
  McpPage,
  McpPlaybackData,
  McpProjectSummaryData,
  McpTimelineQueryData,
  McpViewData,
} from './mcp-projection-contract';
import { composeMcpEditorUiSnapshot } from './mcp-snapshot-composer';
import { createWindowRpcBridge, type EditorUiRpcBridge } from './rpc-bridge';
import type { z } from 'zod';

interface McpToolResult {
  structuredContent?: unknown;
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

export interface McpAppToolMapping {
  project: string;
  timeline: string;
  historyGet: string;
  viewGet: string;
  jobList: string;
  artifactList: string;
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
  // Rendering attaches the App; closed semantic reads are its only data refresh path.
  project: 'waptions_project_get',
  timeline: 'waptions_timeline_query',
  historyGet: 'waptions_history_get',
  viewGet: 'waptions_view_get',
  jobList: 'waptions_job_list',
  artifactList: 'waptions_artifact_list',
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

const commandTool = (
  route: Exclude<EditorUiCommandRoute, { tool: 'local-view' }>,
  mapping: McpAppToolMapping,
): string => {
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

const MAX_STRUCTURED_OUTPUT_BYTES = 1024 * 1024;
const MAX_PAGINATED_PAGES = 32;
const MAX_PAGINATED_ROWS = 10_000;
const MAX_PAGINATED_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_ATTEMPTS = 3;

const jsonByteLength = (value: unknown): number => {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') throw new Error();
    return new TextEncoder().encode(serialized).byteLength;
  } catch {
    throw new Error('The Waptions tool response was not finite JSON.');
  }
};

const requiredEnvelope = <Data>(
  result: McpToolResult,
  toolName: string,
  dataSchema: z.ZodType<Data>,
): McpToolEnvelope<Data> => {
  if (typeof result.structuredContent !== 'object' || result.structuredContent === null) {
    throw new Error(result.isError
      ? toolErrorMessage(result)
      : 'The Waptions tool response did not include an authoritative envelope.');
  }
  if (jsonByteLength(result.structuredContent) > MAX_STRUCTURED_OUTPUT_BYTES) {
    throw new Error(`${toolName} returned an oversized authoritative envelope.`);
  }
  return parseMcpToolEnvelope(result.structuredContent, dataSchema, toolName);
};

const sameState = (left: EditorUiStateToken, right: EditorUiStateToken): boolean => (
  left.sessionId === right.sessionId
  && left.projectId === right.projectId
  && left.sessionEpoch === right.sessionEpoch
  && left.sessionRevision === right.sessionRevision
  && left.documentRevision === right.documentRevision
  && left.audioGraphRevision === right.audioGraphRevision
  && left.narrativeRevision === right.narrativeRevision
  && left.eventCursor === right.eventCursor
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

class SnapshotConsistencyError extends Error {
  constructor() {
    super('The project changed while the editor snapshot was being composed.');
    this.name = 'SnapshotConsistencyError';
  }
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
};

const isPlaybackData = (value: unknown): value is McpPlaybackData => (
  isRecord(value)
  && typeof value.playbackRevision === 'number'
  && typeof value.playing === 'boolean'
  && typeof value.playheadFrame === 'number'
  && typeof value.rate === 'number'
  && typeof value.masterVolume === 'number'
  && typeof value.masterMuted === 'boolean'
  && typeof value.followingPresenter === 'boolean'
);

const playbackConflictRevision = (
  envelope: McpToolEnvelope<Record<string, unknown>>,
): number | null => {
  if (envelope.ok
    || envelope.error.code !== 'REVISION_CONFLICT'
    || envelope.error.details?.domain !== 'playback') return null;
  const revision = envelope.error.details.actualRevision;
  return typeof revision === 'number'
    && Number.isSafeInteger(revision)
    && revision >= 0
    ? revision
    : null;
};

const coreOperationId = (commandId: string): string => {
  const encoded = Array.from(commandId, (character) => (
    /^[A-Za-z0-9_-]$/.test(character)
      ? character
      : `_${character.codePointAt(0)?.toString(16) ?? '0'}_`
  )).join('');
  return `ui-${encoded}`.slice(0, 128);
};

const selectionKind = (
  snapshot: EditorUiSnapshot,
  ids: readonly string[],
): 'tracks' | 'clips' | 'subtitles' | 'narrative' => {
  if (ids.every((id) => snapshot.project.tracks.some((track) => track.id === id))) {
    return 'tracks';
  }
  if (ids.every((id) => snapshot.project.narrativeBlocks.some((block) => block.id === id))) {
    return 'narrative';
  }
  if (ids.every((id) => snapshot.project.tracks.some((track) => (
    track.kind === 'subtitle' && track.clips.some((clip) => clip.id === id)
  )))) {
    return 'subtitles';
  }
  return 'clips';
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
  let latestSnapshot = options.initialSnapshot ?? createEmptyEditorUiSnapshot({
    sessionId: options.sessionId,
  });
  const callTool = (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult> => bridge.request('tools/call', {
    name,
    arguments: args,
  }, signal);
  const readTool = async <Data>(
    name: string,
    args: Record<string, unknown>,
    dataSchema: z.ZodType<Data>,
    states: EditorUiStateToken[],
    signal?: AbortSignal,
  ): Promise<{ data: Data; state: EditorUiStateToken }> => {
    throwIfAborted(signal);
    const envelope = requiredEnvelope<Data>(
      await callTool(name, args, signal),
      name,
      dataSchema,
    );
    if (!envelope.ok) throw new Error(envelope.error.message);
    if (envelope.state.sessionId !== options.sessionId) {
      throw new Error(`${name} returned state for another editor session.`);
    }
    states.push(envelope.state);
    return { data: envelope.data, state: envelope.state };
  };
  const readPaged = async <Data extends { page: McpPage }>(
    name: string,
    args: Record<string, unknown>,
    dataSchema: z.ZodType<Data>,
    rowCount: (data: Data) => number,
    states: EditorUiStateToken[],
    signal?: AbortSignal,
  ): Promise<Data[]> => {
    const pages: Data[] = [];
    const seenCursors = new Set<string>();
    let totalRows = 0;
    let totalBytes = 0;
    let cursor: string | undefined;
    do {
      throwIfAborted(signal);
      if (pages.length >= MAX_PAGINATED_PAGES) {
        throw new Error(`${name} exceeded the ${MAX_PAGINATED_PAGES}-page snapshot limit.`);
      }
      const result = await readTool<Data>(
        name,
        { ...args, ...(cursor ? { cursor } : {}), limit: 500 },
        dataSchema,
        states,
        signal,
      );
      pages.push(result.data);
      totalRows += rowCount(result.data);
      totalBytes += jsonByteLength(result.data);
      if (totalRows > MAX_PAGINATED_ROWS) {
        throw new Error(`${name} exceeded the ${MAX_PAGINATED_ROWS}-row snapshot limit.`);
      }
      if (totalBytes > MAX_PAGINATED_BYTES) {
        throw new Error(`${name} exceeded the paginated snapshot byte limit.`);
      }
      const nextCursor = result.data.page.hasMore
        ? result.data.page.nextCursor
        : undefined;
      if (result.data.page.hasMore && !nextCursor) {
        throw new Error(`${name} returned an incomplete pagination cursor.`);
      }
      if (nextCursor && seenCursors.has(nextCursor)) {
        throw new Error(`${name} returned a repeated pagination cursor.`);
      }
      if (nextCursor) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return pages;
  };
  const readProjectSection = async (
    section: 'summary' | 'sources',
    states: EditorUiStateToken[],
    signal?: AbortSignal,
  ): Promise<McpProjectSummaryData> => {
    const pages = await readPaged<McpProjectSummaryData>(
      mapping.project,
      {
        apiVersion: EDITOR_UI_API_VERSION,
        sessionId: options.sessionId,
        section,
      },
      mcpProjectSummaryDataSchema,
      (data) => data.references.length,
      states,
      signal,
    );
    const first = pages[0];
    if (!first) throw new Error('waptions_project_get returned no project page.');
    return {
      ...first,
      references: pages.flatMap((page) => page.references),
      page: { hasMore: false },
    };
  };
  const readTimeline = async (
    entityKind: 'tracks' | 'clips' | 'subtitles' | 'narrative-blocks',
    states: EditorUiStateToken[],
    signal?: AbortSignal,
  ): Promise<McpTimelineQueryData> => {
    const pages = await readPaged<McpTimelineQueryData>(
      mapping.timeline,
      {
        apiVersion: EDITOR_UI_API_VERSION,
        sessionId: options.sessionId,
        entityKind,
      },
      mcpTimelineQueryDataSchema,
      (data) => data.items.length,
      states,
      signal,
    );
    if (pages.some((page) => page.entityKind !== entityKind)) {
      throw new Error(`${mapping.timeline} returned another timeline entity kind.`);
    }
    return {
      entityKind,
      items: pages.flatMap((page) => page.items),
      page: { hasMore: false },
    };
  };
  const readHistory = async (
    states: EditorUiStateToken[],
    signal?: AbortSignal,
  ): Promise<McpHistoryGetData> => {
    const pages = await readPaged<McpHistoryGetData>(
      mapping.historyGet,
      {
        apiVersion: EDITOR_UI_API_VERSION,
        sessionId: options.sessionId,
        direction: 'both',
      },
      mcpHistoryGetDataSchema,
      (data) => data.past.length + data.future.length,
      states,
      signal,
    );
    const last = pages.at(-1);
    if (!last) throw new Error('waptions_history_get returned no history page.');
    return {
      currentIndex: last.currentIndex,
      past: pages.flatMap((page) => page.past),
      future: pages.flatMap((page) => page.future),
      page: { hasMore: false },
    };
  };
  const readJobs = async (
    states: EditorUiStateToken[],
    signal?: AbortSignal,
  ): Promise<McpJobListData> => {
    const pages = await readPaged<McpJobListData>(
      mapping.jobList,
      { apiVersion: EDITOR_UI_API_VERSION, sessionId: options.sessionId },
      mcpJobListDataSchema,
      (data) => data.items.length,
      states,
      signal,
    );
    return { items: pages.flatMap((page) => page.items), page: { hasMore: false } };
  };
  const readArtifacts = async (
    states: EditorUiStateToken[],
    signal?: AbortSignal,
  ): Promise<McpArtifactListData> => {
    const pages = await readPaged<McpArtifactListData>(
      mapping.artifactList,
      { apiVersion: EDITOR_UI_API_VERSION, sessionId: options.sessionId },
      mcpArtifactListDataSchema,
      (data) => data.items.length,
      states,
      signal,
    );
    return { items: pages.flatMap((page) => page.items), page: { hasMore: false } };
  };
  const readCanonicalSnapshotAttempt = async (
    signal?: AbortSignal,
  ): Promise<EditorUiSnapshot> => {
    throwIfAborted(signal);
    const states: EditorUiStateToken[] = [];
    const [
      project,
      sources,
      tracks,
      clips,
      subtitles,
      narrativeBlocks,
      history,
      viewResult,
      jobs,
      artifacts,
    ] = await Promise.all([
      readProjectSection('summary', states, signal),
      readProjectSection('sources', states, signal),
      readTimeline('tracks', states, signal),
      readTimeline('clips', states, signal),
      readTimeline('subtitles', states, signal),
      readTimeline('narrative-blocks', states, signal),
      readHistory(states, signal),
      readTool<McpViewData>(
        mapping.viewGet,
        {
          apiVersion: EDITOR_UI_API_VERSION,
          sessionId: options.sessionId,
          viewId: options.viewId,
        },
        mcpViewDataSchema,
        states,
        signal,
      ),
      readJobs(states, signal),
      readArtifacts(states, signal),
    ]);
    const state = states[0];
    if (!state || states.some((candidate) => !sameState(candidate, state))) {
      throw new SnapshotConsistencyError();
    }
    if (project.projectId !== state.projectId || sources.projectId !== state.projectId) {
      throw new Error(`${mapping.project} returned data for another project.`);
    }
    if (viewResult.data.view.viewId !== options.viewId) {
      throw new Error(`${mapping.viewGet} returned another editor view.`);
    }
    if (jobs.items.some((job) => (
      job.projectId !== state.projectId
      || job.capturedState.sessionId !== options.sessionId
      || job.capturedState.projectId !== state.projectId
    ))) {
      throw new Error(`${mapping.jobList} returned a job for another editor scope.`);
    }
    if (artifacts.items.some((artifact) => artifact.projectId !== state.projectId)) {
      throw new Error(`${mapping.artifactList} returned an artifact for another project.`);
    }
    const snapshot = composeMcpEditorUiSnapshot({
      state,
      project,
      sourceReferences: sources.references,
      tracks,
      clips,
      subtitles,
      narrativeBlocks,
      history,
      view: viewResult.data,
      jobs,
      artifacts,
    }, latestSnapshot);
    return {
      ...snapshot,
      capabilities: {
        ...snapshot.capabilities,
        canImportMedia: false,
        canExport: false,
        canPresentFullscreen: availableDisplayModes.has('fullscreen'),
        canPresentPictureInPicture: availableDisplayModes.has('pip'),
      },
    };
  };
  const readCanonicalSnapshot = async (signal?: AbortSignal): Promise<EditorUiSnapshot> => {
    for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      try {
        return await readCanonicalSnapshotAttempt(signal);
      } catch (error) {
        if (!(error instanceof SnapshotConsistencyError) || attempt === MAX_SNAPSHOT_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw new SnapshotConsistencyError();
  };
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
    route: Exclude<EditorUiCommandRoute, { tool: 'local-view' }>,
  ): Record<string, unknown> => {
    const common = mutationEnvelope(request);
    switch (route.tool) {
      case 'edit':
        return {
          ...common,
          operations: route.operations,
          history: route.history ?? {
            label: request.command.type,
            category: 'editor-ui',
          },
        };
      case 'history':
        return { ...common, action: route.action };
      case 'playback':
        return {
          ...common,
          viewId: options.viewId,
          expectedPlaybackRevision: latestSnapshot.playback.revision,
          action: route.action,
        };
      case 'view':
        return {
          ...common,
          viewId: options.viewId,
          expectedViewRevision: latestSnapshot.view.revision,
          patch: route.patch,
        };
      case 'media-import':
      case 'transcription':
      case 'export':
        return { ...common, ...route.request };
      case 'job-cancel':
        return { ...common, jobId: route.jobId };
    }
  };

  return {
    async readSnapshot(signal?: AbortSignal): Promise<EditorUiSnapshot> {
      latestSnapshot = await readCanonicalSnapshot(signal);
      return latestSnapshot;
    },
    async execute(
      request: EditorUiCommandRequest,
      signal?: AbortSignal,
    ): Promise<EditorUiCommandResult> {
      const selectedIds = request.command.type === 'view.select'
        ? request.command.ids
        : request.command.type === 'view.update'
          ? request.command.patch.selectedIds
          : undefined;
      const route = mapEditorUiCommand(request.command, {
        operationId: coreOperationId(request.commandId),
        projectFps: latestSnapshot.project.fps,
        ...(selectedIds && selectedIds.length > 0
          ? { selectionKind: selectionKind(latestSnapshot, selectedIds) }
          : {}),
      });
      if (route.tool === 'local-view') {
        return {
          ok: true,
          commandId: request.commandId,
          stateToken: latestSnapshot.stateToken,
        };
      }
      const toolName = commandTool(route, mapping);
      let result = await callTool(
        toolName,
        routeArguments(request, route),
        signal,
      );
      let envelope = requiredEnvelope<Record<string, unknown>>(
        result,
        toolName,
        mcpUnknownDataSchema,
      );
      const actualPlaybackRevision = route.tool === 'playback'
        ? playbackConflictRevision(envelope)
        : null;
      if (route.tool === 'playback' && actualPlaybackRevision !== null) {
        // Playback has no read tool in the frozen protocol. A freshly attached App learns the
        // current independent revision from the typed conflict and retries the same semantic
        // command once; failed guards have not created a durable receipt.
        latestSnapshot = {
          ...latestSnapshot,
          playback: {
            ...latestSnapshot.playback,
            revision: actualPlaybackRevision,
          },
        };
        result = await callTool(
          toolName,
          routeArguments(request, route),
          signal,
        );
        envelope = requiredEnvelope<Record<string, unknown>>(
          result,
          toolName,
          mcpUnknownDataSchema,
        );
      }
      const responseState = envelope.state;
      if (responseState && (
        responseState.sessionId !== options.sessionId
        || responseState.projectId !== latestSnapshot.stateToken.projectId
      )) {
        throw new Error(`${toolName} returned state for another editor scope.`);
      }
      if (!envelope.ok) return normalizeMcpFailure(envelope, request.commandId);
      const stateToken = envelope.state;
      const viewData = route.tool === 'view' && isRecord(envelope.data.view)
        ? envelope.data as unknown as McpViewData
        : null;
      const playbackData = route.tool === 'playback' && isPlaybackData(envelope.data)
        ? envelope.data
        : null;
      latestSnapshot = {
        ...latestSnapshot,
        stateToken,
        view: viewData
          ? {
              ...latestSnapshot.view,
              revision: viewData.view.viewRevision,
              presentation: viewData.view.presentation,
              zoom: viewData.view.zoom,
              scrollLeft: viewData.view.scrollLeft,
              playheadSeconds: viewData.view.playheadFrame / latestSnapshot.project.fps,
              selectedIds: viewData.view.selection.kind === 'none'
                ? []
                : viewData.view.selection.ids,
              focusedTrackId: viewData.view.focusedPanel ?? null,
            }
          : playbackData
            ? {
                ...latestSnapshot.view,
                playheadSeconds: playbackData.playheadFrame / latestSnapshot.project.fps,
              }
            : latestSnapshot.view,
        playback: playbackData
          ? {
              revision: playbackData.playbackRevision,
              isPlaying: playbackData.playing,
              volume: playbackData.masterVolume,
              muted: playbackData.masterMuted,
              playbackRate: playbackData.rate,
              presenterViewId: playbackData.presenterViewId ?? null,
              followingPresenter: playbackData.followingPresenter,
            }
          : latestSnapshot.playback,
      };
      return {
        ok: true,
        commandId: request.commandId,
        stateToken,
      };
    },
    async readEvents({ cursor, limit, signal }) {
      const result = await callTool(mapping.events, {
        apiVersion: EDITOR_UI_API_VERSION,
        sessionId: options.sessionId,
        afterCursor: cursor,
        limit,
      }, signal);
      const envelope = requiredEnvelope<McpEventsReadData>(
        result,
        mapping.events,
        mcpEventsReadDataSchema,
      );
      if (!envelope.ok) {
        if (envelope.error.code === 'EVENT_CURSOR_EXPIRED') {
          return { events: [], cursorExpired: true };
        }
        throw new Error(envelope.error.message);
      }
      const projectId = latestSnapshot.stateToken.projectId;
      if (envelope.state.sessionId !== options.sessionId
        || envelope.state.projectId !== projectId) {
        throw new Error(`${mapping.events} returned state for another editor scope.`);
      }
      const seenEventCursors = new Set<string>();
      let previousSequence = -1;
      for (const event of envelope.data.events) {
        if (event.state.sessionId !== options.sessionId
          || event.state.projectId !== projectId
          || event.state.eventCursor !== event.cursor) {
          throw new Error(`${mapping.events} returned an event for another editor scope.`);
        }
        if (seenEventCursors.has(event.cursor) || event.sequence <= previousSequence) {
          throw new Error(`${mapping.events} returned unordered or duplicate events.`);
        }
        seenEventCursors.add(event.cursor);
        previousSequence = event.sequence;
      }
      const lastCursor = envelope.data.events.at(-1)?.cursor ?? cursor;
      if (envelope.data.nextCursor !== lastCursor
        || (envelope.data.hasMore && envelope.data.events.length === 0)) {
        throw new Error(`${mapping.events} returned an inconsistent event cursor.`);
      }
      return {
        events: normalizeMcpEvents(envelope.data, cursor),
        cursorExpired: false,
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
        return 'inline';
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
