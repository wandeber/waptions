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

const withState = (
  result: ReturnType<typeof success>,
  nextState: EditorUiStateToken,
): ReturnType<typeof success> => ({
  structuredContent: {
    ...result.structuredContent,
    state: nextState,
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
      availableDisplayModes: ['inline', 'fullscreen'],
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
      capabilities: {
        canImportMedia: false,
        canExport: false,
        canPresentFullscreen: true,
        canPresentPictureInPicture: false,
      },
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

  it('retries an inconsistent canonical snapshot as one bounded unit', async () => {
    const bridge = new MockBridge();
    const inconsistentResponses = canonicalSnapshotResponses();
    inconsistentResponses[3] = withState(inconsistentResponses[3]!, {
      ...state,
      documentRevision: state.documentRevision + 1,
    });
    bridge.responses.push(...inconsistentResponses, ...canonicalSnapshotResponses());
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
    });

    await expect(transport.readSnapshot()).resolves.toMatchObject({
      stateToken: state,
      connection: 'connected',
    });
    expect(bridge.requests).toHaveLength(20);

    const boundedBridge = new MockBridge();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const attemptResponses = canonicalSnapshotResponses();
      attemptResponses[3] = withState(attemptResponses[3]!, {
        ...state,
        documentRevision: state.documentRevision + 1,
      });
      boundedBridge.responses.push(...attemptResponses);
    }
    const boundedTransport = createMcpAppTransport({
      bridge: boundedBridge,
      sessionId: 'session',
      viewId: 'view',
    });
    await expect(boundedTransport.readSnapshot()).rejects.toThrow(
      'The project changed while the editor snapshot was being composed.',
    );
    expect(boundedBridge.requests).toHaveLength(30);
  });

  it('does not start a snapshot attempt after its signal is aborted', async () => {
    const bridge = new MockBridge();
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
    });
    const abort = new AbortController();
    abort.abort();

    await expect(transport.readSnapshot(abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(bridge.requests).toEqual([]);
  });

  it('rejects repeated page cursors and output data outside the closed projection', async () => {
    const bridge = new MockBridge();
    const responses = canonicalSnapshotResponses();
    const projectData = responses[0]!.structuredContent.data;
    responses[0] = success({
      ...projectData,
      page: { hasMore: true, nextCursor: 'repeated-cursor' },
    });
    bridge.responses.push(
      ...responses,
      success({
        ...projectData,
        page: { hasMore: true, nextCursor: 'repeated-cursor' },
      }),
    );
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
    });

    await expect(transport.readSnapshot()).rejects.toThrow(
      'waptions_project_get returned a repeated pagination cursor.',
    );

    const invalidBridge = new MockBridge();
    const invalidResponses = canonicalSnapshotResponses();
    invalidResponses[0] = success({
      ...invalidResponses[0]!.structuredContent.data,
      page: undefined,
    });
    invalidBridge.responses.push(...invalidResponses);
    const invalidTransport = createMcpAppTransport({
      bridge: invalidBridge,
      sessionId: 'session',
      viewId: 'view',
    });
    await expect(invalidTransport.readSnapshot()).rejects.toThrow(
      'waptions_project_get returned an invalid authoritative envelope.',
    );
  });

  it('bounds paginated snapshots by page, row, and aggregate byte counts', async () => {
    const pageBridge = new MockBridge();
    const pageResponses = canonicalSnapshotResponses();
    const projectData = pageResponses[0]!.structuredContent.data;
    pageResponses[0] = success({
      ...projectData,
      page: { hasMore: true, nextCursor: 'page-1' },
    });
    pageBridge.responses.push(...pageResponses);
    for (let page = 1; page < 32; page += 1) {
      pageBridge.responses.push(success({
        ...projectData,
        page: { hasMore: true, nextCursor: `page-${page + 1}` },
      }));
    }
    const pageTransport = createMcpAppTransport({
      bridge: pageBridge,
      sessionId: 'session',
      viewId: 'view',
    });
    await expect(pageTransport.readSnapshot()).rejects.toThrow(
      'waptions_project_get exceeded the 32-page snapshot limit.',
    );

    const rowBridge = new MockBridge();
    const rowResponses = canonicalSnapshotResponses();
    const clipData = rowResponses[3]!.structuredContent.data;
    const fullPage = Array.from({ length: 500 }, (_, index) => ({
      id: `clip-${index}`,
      kind: 'video-clip',
    }));
    rowResponses[3] = success({
      ...clipData,
      items: fullPage,
      page: { hasMore: true, nextCursor: 'clips-1' },
    });
    rowBridge.responses.push(...rowResponses);
    for (let page = 1; page <= 20; page += 1) {
      rowBridge.responses.push(success({
        ...clipData,
        items: page === 20 ? [{ id: 'overflow-clip', kind: 'video-clip' }] : fullPage,
        page: page === 20
          ? { hasMore: false }
          : { hasMore: true, nextCursor: `clips-${page + 1}` },
      }));
    }
    const rowTransport = createMcpAppTransport({
      bridge: rowBridge,
      sessionId: 'session',
      viewId: 'view',
    });
    await expect(rowTransport.readSnapshot()).rejects.toThrow(
      'waptions_timeline_query exceeded the 10000-row snapshot limit.',
    );

    const byteBridge = new MockBridge();
    const byteResponses = canonicalSnapshotResponses();
    const historyData = byteResponses[6]!.structuredContent.data;
    const operationIds = Array.from({ length: 256 }, (_, index) => (
      `operation${index.toString().padStart(3, '0')}${'x'.repeat(115)}`
    ));
    const historyEntries = Array.from({ length: 16 }, (_, index) => ({
      entryId: `entry-${index}`,
      label: `Entry ${index}`,
      category: 'test',
      occurredAt: '2026-07-25T12:00:00.000Z',
      operationIds,
      fromRevision: index,
      toRevision: index + 1,
    }));
    byteResponses[6] = success({
      ...historyData,
      currentIndex: 0,
      past: historyEntries,
      page: { hasMore: true, nextCursor: 'history-1' },
    });
    byteBridge.responses.push(...byteResponses);
    for (let page = 1; page <= 20; page += 1) {
      byteBridge.responses.push(success({
        ...historyData,
        currentIndex: 0,
        past: historyEntries,
        page: { hasMore: true, nextCursor: `history-${page + 1}` },
      }));
    }
    const byteTransport = createMcpAppTransport({
      bridge: byteBridge,
      sessionId: 'session',
      viewId: 'view',
    });
    await expect(byteTransport.readSnapshot()).rejects.toThrow(
      'waptions_history_get exceeded the paginated snapshot byte limit.',
    );
  });

  it('rejects snapshot data correlated to another project', async () => {
    const bridge = new MockBridge();
    const responses = canonicalSnapshotResponses();
    responses[1] = success({
      ...responses[1]!.structuredContent.data,
      projectId: 'another-project',
    });
    bridge.responses.push(...responses);
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
    });

    await expect(transport.readSnapshot()).rejects.toThrow(
      'waptions_project_get returned data for another project.',
    );
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

  it('uses current state rather than replay receipt state after a mutation', async () => {
    const bridge = new MockBridge();
    const currentState = {
      ...state,
      sessionRevision: state.sessionRevision + 1,
      documentRevision: state.documentRevision + 1,
      eventCursor: 'cursor-5',
    };
    bridge.responses.push({
      structuredContent: {
        ok: true,
        data: {},
        state: currentState,
        committedState: state,
        warnings: [],
        replayed: true,
      },
    });
    const initialSnapshot = createEmptyEditorUiSnapshot({
      sessionId: 'session',
      projectId: 'project',
    });
    initialSnapshot.stateToken = state;
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
      initialSnapshot,
    });

    await expect(transport.execute({
      commandId: 'replayed-edit',
      command: { type: 'video-clip.delete', clipId: 'clip' },
      expected,
    })).resolves.toMatchObject({
      ok: true,
      stateToken: currentState,
    });
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

  it('learns the playback revision from a typed conflict and retries once', async () => {
    const bridge = new MockBridge();
    const snapshot = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    snapshot.stateToken = state;
    bridge.responses.push(
      {
        structuredContent: {
          ok: false,
          error: {
            code: 'REVISION_CONFLICT',
            message: 'Playback changed.',
            retryable: true,
            details: {
              domain: 'playback',
              expectedRevision: 0,
              actualRevision: 7,
            },
          },
          state,
        },
      },
      success({
        playbackRevision: 8,
        playing: true,
        playheadFrame: 0,
        rate: 1,
        masterVolume: 1,
        masterMuted: false,
        followingPresenter: false,
      }),
    );
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
      initialSnapshot: snapshot,
    });

    await expect(transport.execute({
      commandId: 'play-after-attach',
      command: { type: 'playback.play' },
      expected,
    })).resolves.toMatchObject({
      ok: true,
      stateToken: state,
    });
    expect(bridge.requests.map((request) => (
      request.params as { arguments: Record<string, unknown> }
    ).arguments.expectedPlaybackRevision)).toEqual([0, 7]);
    expectCanonicalToolInputs(bridge.requests);
  });

  it('maps canonical failures and event pages', async () => {
    const bridge = new MockBridge();
    const snapshot = createEmptyEditorUiSnapshot({
      sessionId: 'session',
      projectId: 'project',
    });
    snapshot.stateToken = state;
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
