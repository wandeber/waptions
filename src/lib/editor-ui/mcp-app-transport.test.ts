import { describe, expect, it } from 'vitest';
import type { EditorUiRpcBridge } from './rpc-bridge';
import { createEmptyEditorUiSnapshot } from './contracts';
import { createMcpAppTransport } from './mcp-app-transport';

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

describe('createMcpAppTransport', () => {
  it('maps semantic commands to focused tools without attaching UI metadata to mutations', async () => {
    const bridge = new MockBridge();
    const snapshot = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    bridge.responses.push(
      {
        structuredContent: {
          ok: true,
          data: { editorUiSnapshot: snapshot },
          state: snapshot.stateToken,
          warnings: [],
        },
      },
      {
        structuredContent: {
          ok: true,
          data: {
            editorUiCommandResult: {
              ok: true,
              commandId: 'command-1',
            },
          },
          state: snapshot.stateToken,
          warnings: [],
        },
      },
      {
        structuredContent: {
          ok: true,
          data: {
            editorUiCommandResult: {
              ok: true,
              commandId: 'command-2',
            },
          },
          state: snapshot.stateToken,
          warnings: [],
        },
      },
    );
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
    });
    await transport.readSnapshot();
    await transport.execute({
      commandId: 'command-1',
      command: { type: 'video-clip.split', clipId: 'clip', timelineFrame: 60 },
      expected: {
        sessionEpoch: 'epoch',
        sessionRevision: 1,
        documentRevision: 1,
        audioGraphRevision: 1,
      },
    });
    await transport.execute({
      commandId: 'command-2',
      command: { type: 'history.undo' },
      expected: {
        sessionEpoch: 'epoch',
        sessionRevision: 2,
        documentRevision: 2,
        audioGraphRevision: 1,
      },
    });

    expect(bridge.requests.map((request) => [
      request.method,
      (request.params as { name?: string }).name,
    ])).toEqual([
      ['tools/call', 'waptions_project_get'],
      ['tools/call', 'waptions_edit_apply'],
      ['tools/call', 'waptions_history_apply'],
    ]);
    const editArguments = (
      bridge.requests[1]?.params as { arguments: Record<string, unknown> }
    ).arguments;
    expect(editArguments).toMatchObject({
      apiVersion: '2026-07-25',
      idempotencyKey: 'command-1',
      historyLabel: 'video-clip.split',
      semanticCategory: 'editor-ui',
      operations: [{
        operationId: 'command-1:0',
        type: 'video-clip.split',
        payload: {
          clipId: 'clip',
          atFrame: 60,
        },
      }],
    });
    expect(JSON.stringify(bridge.requests)).not.toContain('_meta');
    transport.close?.();
    expect(bridge.closed).toBe(false);
  });

  it('sends an atomic UI batch as one MCP edit with one semantic history entry', async () => {
    const bridge = new MockBridge();
    const snapshot = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    bridge.responses.push({
      structuredContent: {
        ok: true,
        data: { editorUiCommandResult: { ok: true, commandId: 'batch' } },
        state: snapshot.stateToken,
        warnings: [],
      },
    });
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
      initialSnapshot: snapshot,
    });
    await transport.readSnapshot();
    await transport.execute({
      commandId: 'batch',
      command: {
        type: 'edit.batch',
        commands: [
          { type: 'video-clip.delete', clipId: 'video' },
          { type: 'audio-clip.delete', clipId: 'audio' },
        ],
        history: { label: 'Delete selection', category: 'selection.delete' },
      },
      expected: {
        sessionEpoch: snapshot.stateToken.sessionEpoch,
        sessionRevision: snapshot.stateToken.sessionRevision,
        documentRevision: snapshot.stateToken.documentRevision,
        audioGraphRevision: snapshot.stateToken.audioGraphRevision,
      },
    });
    expect(bridge.requests).toMatchObject([{
      method: 'tools/call',
      params: {
        name: 'waptions_edit_apply',
        arguments: {
          historyLabel: 'Delete selection',
          semanticCategory: 'selection.delete',
          operations: [
            { operationId: 'batch:0:0', type: 'video-clip.delete' },
            { operationId: 'batch:0:1', type: 'audio-clip.delete' },
          ],
        },
      },
    }]);
  });

  it('maps authoritative failure envelopes and narrative revisions', async () => {
    const bridge = new MockBridge();
    const snapshot = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    bridge.responses.push({
      structuredContent: {
        ok: false,
        error: {
          code: 'NARRATIVE_REVISION_CONFLICT',
          message: 'Narrative changed.',
          retryable: true,
        },
        state: {
          ...snapshot.stateToken,
          narrativeRevision: 8,
        },
      },
      isError: true,
    });
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
    });
    const result = await transport.execute({
      commandId: 'command-conflict',
      command: {
        type: 'narrative.delete-all-silences',
      },
      expected: {
        sessionEpoch: 'epoch',
        sessionRevision: 7,
        documentRevision: 7,
        audioGraphRevision: 3,
        narrativeRevision: 7,
      },
    });
    expect(result).toMatchObject({
      ok: false,
      commandId: 'command-conflict',
      code: 'conflict',
      actualStateToken: { narrativeRevision: 8 },
    });
  });

  it('uses the exact MCP view, playback, history, import, transcription, and export wire shapes', async () => {
    const bridge = new MockBridge();
    const snapshot = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    snapshot.view.revision = 12;
    snapshot.playback.revision = 34;
    const success = (commandId: string) => ({
      structuredContent: {
        ok: true,
        data: {
          editorUiCommandResult: { ok: true, commandId },
        },
        state: snapshot.stateToken,
        warnings: [],
      },
    });
    bridge.responses.push(
      success('view'),
      success('playback'),
      success('history'),
      success('import'),
      success('transcription'),
      success('export'),
      success('view-2'),
    );
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
      initialSnapshot: snapshot,
    });
    await transport.readSnapshot();
    const expected = {
      sessionEpoch: snapshot.stateToken.sessionEpoch,
      sessionRevision: snapshot.stateToken.sessionRevision,
      documentRevision: snapshot.stateToken.documentRevision,
      audioGraphRevision: snapshot.stateToken.audioGraphRevision,
    };
    await transport.execute({
      commandId: 'view',
      command: { type: 'view.set-track-height', trackId: 'video', height: 144 },
      expected,
    });
    await transport.execute({
      commandId: 'playback',
      command: { type: 'playback.set-muted', muted: true },
      expected,
    });
    await transport.execute({
      commandId: 'history',
      command: { type: 'history.jump', entryId: 'history-7' },
      expected,
    });
    await transport.execute({
      commandId: 'import',
      command: {
        type: 'media.import',
        grantId: 'grant-media',
        sources: [{ path: '/media/source.mov' }],
        placement: 'append-natural-order',
      },
      expected,
    });
    await transport.execute({
      commandId: 'transcription',
      command: {
        type: 'transcription.start',
        mode: 'editorial',
        trackIds: ['video'],
        ranges: [{ startSample: 0, endSample: 16_000, sampleRate: 16_000 }],
        language: 'es',
        speakerMode: 'detect',
        providerPolicy: 'managed-local-endpoint',
        providerId: 'lazy-whisper-api',
      },
      expected,
    });
    await transport.execute({
      commandId: 'export',
      command: {
        type: 'export.start',
        format: 'mp4-h264-aac',
        grantId: 'grant-export',
        destinationPath: '/exports/project.mp4',
      },
      expected,
    });
    await transport.execute({
      commandId: 'view-2',
      command: { type: 'view.select', ids: ['clip-a'] },
      expected,
    });

    const requests = bridge.requests.map((request) => (
      request.params as { name: string; arguments: Record<string, unknown> }
    ));
    expect(requests).toMatchObject([
      {
        name: 'waptions_view_update',
        arguments: {
          viewId: 'view',
          expectedViewRevision: 12,
          patch: { rowHeights: { video: 144 } },
        },
      },
      {
        name: 'waptions_playback_control',
        arguments: {
          viewId: 'view',
          expectedPlaybackRevision: 34,
          action: 'set-master-mute',
          muted: true,
        },
      },
      {
        name: 'waptions_history_apply',
        arguments: { action: 'jump', historyEntryId: 'history-7' },
      },
      {
        name: 'waptions_media_import',
        arguments: {
          grantId: 'grant-media',
          sources: [{ path: '/media/source.mov' }],
          placement: 'append-natural-order',
        },
      },
      {
        name: 'waptions_transcription_start',
        arguments: {
          mode: 'editorial',
          trackIds: ['video'],
          ranges: [{ startSample: 0, endSample: 16_000, sampleRate: 16_000 }],
          language: 'es',
          speakerMode: 'detect',
          providerPolicy: 'managed-local-endpoint',
          providerId: 'lazy-whisper-api',
        },
      },
      {
        name: 'waptions_export_start',
        arguments: {
          format: 'mp4-h264-aac',
          grantId: 'grant-export',
          destinationPath: '/exports/project.mp4',
        },
      },
      {
        name: 'waptions_view_update',
        arguments: {
          viewId: 'view',
          expectedViewRevision: 13,
          patch: { selectionIds: ['clip-a'] },
        },
      },
    ]);
  });

  it('falls back to complete inline mode when optional presentation APIs are unavailable', async () => {
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

  it('uses the render result only as bootstrap and speaks MCP display/context vocabulary', async () => {
    const bridge = new MockBridge();
    const snapshot = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    bridge.responses.push(
      { mode: 'pip' },
      {},
      {
        structuredContent: {
          ok: true,
          data: { editorUiSnapshot: snapshot },
          state: snapshot.stateToken,
          warnings: [],
        },
      },
    );
    const transport = createMcpAppTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
      initialSnapshot: snapshot,
      availableDisplayModes: ['inline', 'fullscreen', 'pip'],
    });

    await expect(transport.readSnapshot()).resolves.toBe(snapshot);
    expect(bridge.requests).toEqual([]);
    await expect(
      transport.requestPresentation?.('picture-in-picture'),
    ).resolves.toBe('picture-in-picture');
    await transport.updateModelContext?.({
      project: { id: 'project', name: 'Project' },
      selection: [],
      timecodeSeconds: 0,
      revisions: { session: 0, document: 0, audioGraph: 0 },
      activeJobs: [],
      recentSemanticAction: null,
    });
    await transport.readSnapshot();

    expect(bridge.requests).toMatchObject([
      { method: 'ui/request-display-mode', params: { mode: 'pip' } },
      {
        method: 'ui/update-model-context',
        params: { structuredContent: { project: { id: 'project' } } },
      },
      {
        method: 'tools/call',
        params: {
          name: 'waptions_project_get',
          arguments: { projection: 'editor-ui' },
        },
      },
    ]);
  });
});
