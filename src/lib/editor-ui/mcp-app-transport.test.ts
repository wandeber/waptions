import Ajv2020 from '../../../agent-runtime/node_modules/ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import commonSchema from '../../../agent-runtime/schemas/2026-07-25/common.schema.json';
import operationsSchema from '../../../agent-runtime/schemas/2026-07-25/operations.schema.json';
import sessionSchema from '../../../agent-runtime/schemas/2026-07-25/session.schema.json';
import toolRegistry from '../../../agent-runtime/schemas/2026-07-25/tool-registry.json';
import toolsSchema from '../../../agent-runtime/schemas/2026-07-25/tools.schema.json';
import { createEmptyEditorUiSnapshot, type EditorUiStateToken } from './contracts';
import { createMcpAppTransport } from './mcp-app-transport';
import type { EditorUiRpcBridge } from './rpc-bridge';

class MockBridge implements EditorUiRpcBridge {
  requests: Array<{ method: string; params: unknown }> = [];
  responses: unknown[] = [];
  closed = false;

  async request<Result>(method: string, params?: unknown): Promise<Result> {
    this.requests.push({ method, params });
    return this.responses.shift() as Result;
  }
  notify() {}
  subscribe() {
    return () => {};
  }
  handleRequest() {
    return () => {};
  }
  close() {
    this.closed = true;
  }
}

const schemaValidator = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
schemaValidator.addSchema({ ...commonSchema, $id: 'common.schema.json' });
schemaValidator.addSchema({ ...operationsSchema, $id: 'operations.schema.json' });
schemaValidator.addSchema({ ...sessionSchema, $id: 'session.schema.json' });
schemaValidator.addSchema({ ...toolsSchema, $id: 'tools.schema.json' });
const inputValidators = new Map(toolRegistry.tools.map((tool) => [
  tool.name,
  schemaValidator.compile({ $ref: tool.inputSchemaRef }),
]));

const expectCanonicalToolInputs = (
  requests: MockBridge['requests'],
): void => {
  for (const request of requests) {
    if (request.method !== 'tools/call') continue;
    const params = request.params as {
      name: string;
      arguments: Record<string, unknown>;
    };
    const validate = inputValidators.get(params.name);
    expect(validate, `${params.name} is not in the committed tool registry`).toBeDefined();
    expect(
      validate?.(params.arguments),
      `${params.name}: ${JSON.stringify(validate?.errors)}`,
    ).toBe(true);
  }
};

const state: EditorUiStateToken = {
  sessionId: 'session',
  projectId: 'project',
  sessionEpoch: 'epoch',
  sessionRevision: 4,
  documentRevision: 3,
  audioGraphRevision: 2,
  narrativeRevision: 1,
  eventCursor: 'cursor-4',
};

const success = (data: Record<string, unknown> = {}, nextState = state) => ({
  structuredContent: {
    ok: true,
    data,
    state: nextState,
    warnings: [],
    replayed: false,
  },
});

const canonicalSnapshotResponses = () => [
  success({
    projectId: 'project',
    name: 'Canonical project',
    renderProfile: {
      fps: { numerator: 30, denominator: 1 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48_000,
      isFrameRateLocked: true,
      isCanvasSizeLocked: true,
    },
    renderBackgroundColor: '#000000',
    counts: { tracks: 1, clips: 1, subtitles: 0, sources: 1, links: 0 },
    activeJobIds: [],
    references: [],
    page: { hasMore: false },
  }),
  success({
    projectId: 'project',
    name: 'Canonical project',
    renderProfile: {
      fps: { numerator: 30, denominator: 1 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48_000,
      isFrameRateLocked: true,
      isCanvasSizeLocked: true,
    },
    renderBackgroundColor: '#000000',
    counts: { tracks: 1, clips: 1, subtitles: 0, sources: 1, links: 0 },
    activeJobIds: [],
    references: [{ id: 'source', kind: 'video-source', label: 'Source' }],
    page: { hasMore: false },
  }),
  success({
    entityKind: 'tracks',
    items: [{ id: 'video-track', kind: 'video-track', label: 'Video' }],
    page: { hasMore: false },
  }),
  success({
    entityKind: 'clips',
    items: [{
      id: 'clip',
      kind: 'video-clip',
      trackId: 'video-track',
      startFrame: 0,
      endFrame: 300,
      label: 'Clip',
    }],
    page: { hasMore: false },
  }),
  success({ entityKind: 'subtitles', items: [], page: { hasMore: false } }),
  success({ entityKind: 'narrative-blocks', items: [], page: { hasMore: false } }),
  success({
    currentIndex: -1,
    past: [],
    future: [],
    page: { hasMore: false },
  }),
  success({
    view: {
      viewId: 'view',
      viewRevision: 12,
      selection: { kind: 'none' },
      playheadFrame: 0,
      zoom: 1,
      scrollLeft: 0,
      presentation: 'inline',
      participantIds: [],
    },
  }),
  success({ items: [], page: { hasMore: false } }),
  success({ items: [], page: { hasMore: false } }),
];

const expected = {
  sessionEpoch: state.sessionEpoch,
  sessionRevision: state.sessionRevision,
  documentRevision: state.documentRevision,
  audioGraphRevision: state.audioGraphRevision,
  narrativeRevision: state.narrativeRevision,
};

describe('createMcpAppTransport', () => {
  it('composes launch/refresh from canonical closed reads without requesting a projection', async () => {
    const bridge = new MockBridge();
    bridge.responses.push(...canonicalSnapshotResponses());
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
      initialSnapshot: createEmptyEditorUiSnapshot({ sessionId: 'session' }),
    });

    const snapshot = await transport.readSnapshot();

    expect(snapshot).toMatchObject({
      stateToken: state,
      project: {
        id: 'project',
        name: 'Canonical project',
        durationSeconds: 10,
        tracks: [{
          id: 'video-track',
          clips: [{ id: 'clip', startSeconds: 0, durationSeconds: 10 }],
        }],
      },
      view: { revision: 12 },
    });
    expect(bridge.requests.map((request) => (
      request.params as { name: string }
    ).name)).toEqual([
      'waptions_project_get',
      'waptions_project_get',
      'waptions_timeline_query',
      'waptions_timeline_query',
      'waptions_timeline_query',
      'waptions_timeline_query',
      'waptions_history_get',
      'waptions_view_get',
      'waptions_job_list',
      'waptions_artifact_list',
    ]);
    const projectArguments = bridge.requests.slice(0, 2).map((request) => (
      request.params as { arguments: Record<string, unknown> }
    ).arguments);
    expect(projectArguments).toEqual([
      {
        apiVersion: '2026-07-25',
        sessionId: 'session',
        section: 'summary',
        limit: 500,
      },
      {
        apiVersion: '2026-07-25',
        sessionId: 'session',
        section: 'sources',
        limit: 500,
      },
    ]);
    expect(JSON.stringify(projectArguments)).not.toContain('projection');
    expect(JSON.stringify(projectArguments)).not.toContain('viewId');
    expectCanonicalToolInputs(bridge.requests);
  });

  it('emits exact canonical edit, history, playback, view, import, transcription, and export inputs', async () => {
    const bridge = new MockBridge();
    const initialSnapshot = createEmptyEditorUiSnapshot({
      sessionId: 'session',
      projectId: 'project',
      sessionEpoch: 'epoch',
      eventCursor: 'cursor-4',
    });
    initialSnapshot.stateToken = state;
    initialSnapshot.project.fps = 30;
    initialSnapshot.view.revision = 12;
    initialSnapshot.playback.revision = 34;
    bridge.responses.push(
      success(),
      success(),
      success(),
      success(),
      success(),
      success(),
      success(),
    );
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
      initialSnapshot,
    });
    await transport.execute({
      commandId: 'edit',
      command: {
        type: 'edit.batch',
        commands: [{ type: 'video-clip.delete', clipId: 'clip' }],
        history: { label: 'Delete selection', category: 'selection.delete' },
      },
      expected,
    });
    await transport.execute({
      commandId: 'history',
      command: { type: 'history.jump', entryId: 'history-7' },
      expected,
    });
    await transport.execute({
      commandId: 'playback',
      command: { type: 'playback.set-muted', muted: true },
      expected,
    });
    await transport.execute({
      commandId: 'view',
      command: { type: 'view.select', ids: ['clip'] },
      expected,
    });
    await transport.execute({
      commandId: 'import',
      command: {
        type: 'media.import',
        mediaHandles: ['media-handle'],
        placement: {
          kind: 'place',
          ordering: 'natural',
          timelineStartFrame: 0,
        },
      },
      expected,
    });
    await transport.execute({
      commandId: 'transcription',
      command: {
        type: 'transcription.start',
        transcriptionKind: 'editorial',
        targetTrackIds: ['video-track'],
        ranges: [{
          sourceId: 'source',
          startSample16k: 0,
          endSample16k: 160_000,
        }],
        language: 'es',
        speakerMode: 'diarized',
        providerPolicy: {
          kind: 'managed-local-endpoint',
          endpointCapabilityId: 'transcriber-capability',
        },
      },
      expected,
    });
    const destination = {
      schemaVersion: 1 as const,
      destinationId: 'destination',
      grantId: 'grant',
      stagingHandleId: 'staging',
      mode: 'create-only' as const,
      outputName: 'project.mp4',
      verifiedParentIdentity: 'parent',
      expiresAt: '2026-07-25T12:00:00.000Z',
    };
    await transport.execute({
      commandId: 'export',
      command: {
        type: 'export.start',
        exportKind: 'mp4-h264-aac',
        destination,
      },
      expected,
    });
    const requests = bridge.requests.map((request) => (
      request.params as { name: string; arguments: Record<string, unknown> }
    ));
    expect(requests).toMatchObject([
      {
        name: 'waptions_edit_apply',
        arguments: {
          history: { label: 'Delete selection', category: 'selection.delete' },
          operations: [{ type: 'video-clip.delete' }],
        },
      },
      {
        name: 'waptions_history_apply',
        arguments: {
          action: { kind: 'jump', entryId: 'history-7', position: 'after' },
        },
      },
      {
        name: 'waptions_playback_control',
        arguments: {
          viewId: 'view',
          expectedPlaybackRevision: 34,
          action: { kind: 'set-master-mute', muted: true },
        },
      },
      {
        name: 'waptions_view_update',
        arguments: {
          viewId: 'view',
          expectedViewRevision: 12,
          patch: { selection: { kind: 'clips', ids: ['clip'] } },
        },
      },
      {
        name: 'waptions_media_import',
        arguments: {
          mediaHandles: ['media-handle'],
          placement: { kind: 'place', ordering: 'natural', timelineStartFrame: 0 },
        },
      },
      {
        name: 'waptions_transcription_start',
        arguments: {
          transcriptionKind: 'editorial',
          targetTrackIds: ['video-track'],
          ranges: [{
            sourceId: 'source',
            startSample16k: 0,
            endSample16k: 160_000,
          }],
          language: 'es',
          speakerMode: 'diarized',
          providerPolicy: {
            kind: 'managed-local-endpoint',
            endpointCapabilityId: 'transcriber-capability',
          },
        },
      },
      {
        name: 'waptions_export_start',
        arguments: {
          exportKind: 'mp4-h264-aac',
          destination,
        },
      },
    ]);
    expect(JSON.stringify(requests)).not.toContain('historyLabel');
    expect(JSON.stringify(requests)).not.toContain('semanticCategory');
    expectCanonicalToolInputs(bridge.requests);
  });

  it('keeps unsupported view-only fields local and does not emit an invalid view patch', async () => {
    const bridge = new MockBridge();
    const snapshot = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
      initialSnapshot: snapshot,
    });
    await expect(transport.execute({
      commandId: 'row-height',
      command: { type: 'view.set-track-height', trackId: 'video', height: 144 },
      expected: {
        sessionEpoch: snapshot.stateToken.sessionEpoch,
        sessionRevision: 0,
        documentRevision: 0,
        audioGraphRevision: 0,
      },
    })).resolves.toMatchObject({ ok: true });
    expect(bridge.requests).toEqual([]);
  });

  it('maps canonical failures and event pages', async () => {
    const bridge = new MockBridge();
    const snapshot = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    bridge.responses.push(
      {
        structuredContent: {
          ok: false,
          error: {
            code: 'NARRATIVE_REVISION_CONFLICT',
            message: 'Narrative changed.',
            retryable: true,
          },
          state,
        },
        isError: true,
      },
      success({
        events: [{
          schemaVersion: 1,
          cursor: 'cursor-5',
          type: 'project.mutated',
          occurredAt: '2026-07-25T12:00:00.000Z',
          state: { ...state, eventCursor: 'cursor-5' },
          sequence: 5,
          data: {
            commandId: 'another-command',
            operationIds: [],
            affectedIds: [],
          },
        }],
        nextCursor: 'cursor-5',
        hasMore: false,
      }),
    );
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
      initialSnapshot: snapshot,
    });
    await expect(transport.execute({
      commandId: 'conflict',
      command: { type: 'narrative.delete-all-silences' },
      expected,
    })).resolves.toMatchObject({
      ok: false,
      code: 'conflict',
      actualStateToken: state,
    });
    await expect(transport.readEvents?.({
      cursor: 'cursor-4',
      limit: 128,
    })).resolves.toMatchObject({
      cursorExpired: false,
      events: [{
        previousCursor: 'cursor-4',
        cursor: 'cursor-5',
        kind: 'project',
      }],
    });
    expectCanonicalToolInputs(bridge.requests);
  });

  it('falls back to inline mode when optional presentation APIs are unavailable', async () => {
    const bridge = new MockBridge();
    bridge.request = async () => {
      throw new Error('Method not found');
    };
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
    });
    await expect(transport.requestPresentation?.('fullscreen')).resolves.toBe('inline');
  });
});
