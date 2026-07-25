import { describe, expect, it, vi } from 'vitest';
import type {
  EditorUiCommandRequest,
  EditorUiCommandResult,
  EditorUiEvent,
  EditorUiSnapshot,
  EditorUiTransport,
} from './contracts';
import { createEmptyEditorUiSnapshot } from './contracts';
import { ExternalEditorUiController } from './controller';

const snapshotAt = (
  revision: number,
  overrides: Partial<EditorUiSnapshot> = {},
): EditorUiSnapshot => ({
  ...createEmptyEditorUiSnapshot({
    sessionId: 'session',
    sessionEpoch: 'epoch-a',
    eventCursor: `cursor-${revision}`,
  }),
  connection: 'connected',
  capabilities: {
    canEdit: true,
    canImportMedia: true,
    canTranscribe: true,
    canExport: true,
    canPresentFullscreen: true,
    canPresentPictureInPicture: true,
    canSubscribeToEvents: true,
  },
  stateToken: {
    sessionId: 'session',
    projectId: 'project',
    sessionEpoch: 'epoch-a',
    sessionRevision: revision,
    documentRevision: revision,
    audioGraphRevision: revision,
    eventCursor: `cursor-${revision}`,
  },
  project: {
    id: 'project',
    name: `Project ${revision}`,
    durationSeconds: 20,
    fps: 30,
    tracks: [],
    narrativeBlocks: [],
    history: [],
    canUndo: revision > 0,
    canRedo: false,
    editingMode: 'ripple',
    narrativeSettings: {
      globalPreMarginSamples16k: 0,
      globalPostMarginSamples16k: 0,
      showSpeakers: true,
    },
  },
  ...overrides,
});

class MockTransport implements EditorUiTransport {
  snapshot = snapshotAt(1);
  readCount = 0;
  requests: EditorUiCommandRequest[] = [];
  executeResult: EditorUiCommandResult | null = null;
  presentation: 'inline' | 'fullscreen' | 'picture-in-picture' = 'inline';
  contexts: unknown[] = [];

  async readSnapshot(): Promise<EditorUiSnapshot> {
    this.readCount += 1;
    return this.snapshot;
  }

  async execute(request: EditorUiCommandRequest): Promise<EditorUiCommandResult> {
    this.requests.push(request);
    return this.executeResult ?? {
      ok: true,
      commandId: request.commandId,
      stateToken: this.snapshot.stateToken,
      snapshot: this.snapshot,
    };
  }

  async requestPresentation() {
    return this.presentation;
  }

  async updateModelContext(context: unknown) {
    this.contexts.push(context);
  }
}

describe('ExternalEditorUiController', () => {
  it('preserves view state while applying contiguous external project mutations', async () => {
    const transport = new MockTransport();
    const controller = new ExternalEditorUiController({
      viewId: 'view-a',
      initialSnapshot: snapshotAt(0),
      transport,
      createCommandId: () => 'command-1',
    });
    await controller.connect();
    controller.updateView({
      zoom: 2.5,
      scrollLeft: 440,
      playheadSeconds: 7.25,
      selectedIds: ['clip-a'],
      activePane: 'text',
      trackHeights: { 'track-a': 116 },
    });

    const incoming = snapshotAt(2, {
      project: { ...snapshotAt(2).project, name: 'External edit' },
      view: {
        ...snapshotAt(2).view,
        revision: 22,
        zoom: 0.5,
        scrollLeft: 0,
        playheadSeconds: 0,
        selectedIds: [],
      },
    });
    controller.acceptEvent({
      eventId: 'event-2',
      previousCursor: 'cursor-1',
      cursor: 'cursor-2',
      stateToken: incoming.stateToken,
      kind: 'project',
      snapshot: incoming,
    });

    expect(controller.getSnapshot().project.name).toBe('External edit');
    expect(controller.getSnapshot().view).toMatchObject({
      zoom: 2.5,
      scrollLeft: 440,
      playheadSeconds: 7.25,
      selectedIds: ['clip-a'],
      activePane: 'text',
      trackHeights: { 'track-a': 116 },
      revision: 22,
    });
    controller.close();
  });

  it('accepts presenter playback time without resetting the rest of the view', async () => {
    const transport = new MockTransport();
    const controller = new ExternalEditorUiController({
      viewId: 'view-a',
      initialSnapshot: snapshotAt(0),
      transport,
    });
    await controller.connect();
    controller.updateView({ zoom: 3, playheadSeconds: 4 });
    const incoming = snapshotAt(2, {
      view: { ...snapshotAt(2).view, zoom: 1, playheadSeconds: 9 },
    });
    controller.acceptEvent({
      eventId: 'playback-2',
      previousCursor: 'cursor-1',
      cursor: 'cursor-2',
      stateToken: incoming.stateToken,
      kind: 'playback',
      snapshot: incoming,
    });
    expect(controller.getSnapshot().view.zoom).toBe(3);
    expect(controller.getSnapshot().view.playheadSeconds).toBe(9);
    controller.close();
  });

  it.each([
    ['cursor gap', { previousCursor: 'cursor-missing' }],
    ['epoch change', { stateToken: { ...snapshotAt(2).stateToken, sessionEpoch: 'epoch-b' } }],
    ['inconsistent state cursor', {
      stateToken: { ...snapshotAt(2).stateToken, eventCursor: 'cursor-other' },
    }],
    ['backwards document revision', {
      stateToken: { ...snapshotAt(2).stateToken, documentRevision: 0 },
    }],
    ['missing bounded snapshot', { snapshot: undefined }],
  ])('refreshes after a %s', async (_label, eventPatch) => {
    const transport = new MockTransport();
    const controller = new ExternalEditorUiController({
      viewId: 'view-a',
      initialSnapshot: snapshotAt(0),
      transport,
    });
    await controller.connect();
    const event: EditorUiEvent = {
      eventId: 'event-2',
      previousCursor: 'cursor-1',
      cursor: 'cursor-2',
      stateToken: snapshotAt(2).stateToken,
      kind: 'project',
      snapshot: snapshotAt(2),
      ...eventPatch,
    };
    controller.acceptEvent(event);
    await vi.waitFor(() => expect(transport.readCount).toBeGreaterThan(1));
    controller.close();
  });

  it('rolls an optimistic trim back to the authoritative snapshot on conflict', async () => {
    const transport = new MockTransport();
    const authoritative = snapshotAt(2);
    transport.snapshot = authoritative;
    transport.executeResult = {
      ok: false,
      commandId: 'trim-1',
      code: 'conflict',
      message: 'Another view edited the clip.',
      actualStateToken: authoritative.stateToken,
      snapshot: authoritative,
    };
    const controller = new ExternalEditorUiController({
      viewId: 'view-a',
      initialSnapshot: snapshotAt(1),
      transport,
      createCommandId: () => 'trim-1',
    });
    controller.updateView({ zoom: 2, playheadSeconds: 3 });
    const result = await controller.dispatch(
      {
        type: 'video-clip.trim',
        clipId: 'clip-a',
        sourceStartSeconds: 0,
        sourceEndSeconds: 8,
      },
      {
        optimistic: (current) => ({
          ...current,
          project: { ...current.project, name: 'Optimistic preview' },
        }),
      },
    );

    expect(result.ok).toBe(false);
    expect(controller.getSnapshot().project.name).toBe('Project 2');
    expect(controller.getSnapshot().view).toMatchObject({ zoom: 2, playheadSeconds: 3 });
    expect(controller.getSnapshot().conflict).toMatchObject({
      commandId: 'trim-1',
      expectedRevision: 1,
      actualRevision: 2,
    });
    expect(controller.getSnapshot().pendingCommandIds).toEqual([]);
    controller.close();
  });

  it('uses the current revision guard and preserves controller identity across presentations', async () => {
    const transport = new MockTransport();
    transport.presentation = 'fullscreen';
    const controller = new ExternalEditorUiController({
      viewId: 'view-a',
      initialSnapshot: snapshotAt(1),
      transport,
      createCommandId: () => 'rename-1',
    });
    const identity = controller;
    await controller.dispatch({ type: 'project.set-name', name: 'Renamed' });
    await controller.requestPresentation('fullscreen');
    expect(transport.requests[0]?.expected).toEqual({
      sessionEpoch: 'epoch-a',
      sessionRevision: 1,
      documentRevision: 1,
      audioGraphRevision: 1,
      narrativeRevision: undefined,
    });
    expect(controller).toBe(identity);
    expect(controller.getSnapshot().view.presentation).toBe('fullscreen');
    controller.close();
  });

  it('does not let a stale command success overwrite a newer external event', async () => {
    const transport = new MockTransport();
    let resolveExecute: ((result: EditorUiCommandResult) => void) | undefined;
    transport.execute = async (request) => {
      transport.requests.push(request);
      return new Promise<EditorUiCommandResult>((resolve) => {
        resolveExecute = resolve;
      });
    };
    const controller = new ExternalEditorUiController({
      viewId: 'view-a',
      initialSnapshot: snapshotAt(0),
      transport,
      createCommandId: () => 'late-success',
    });
    await controller.connect();
    const dispatch = controller.dispatch({ type: 'project.set-name', name: 'Local edit' });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));

    const external = snapshotAt(2, {
      project: { ...snapshotAt(2).project, name: 'External edit wins' },
    });
    controller.acceptEvent({
      eventId: 'external-2',
      previousCursor: 'cursor-1',
      cursor: 'cursor-2',
      stateToken: external.stateToken,
      kind: 'project',
      snapshot: external,
    });
    resolveExecute?.({
      ok: true,
      commandId: 'late-success',
      stateToken: snapshotAt(1).stateToken,
      snapshot: snapshotAt(1, {
        project: { ...snapshotAt(1).project, name: 'Stale local result' },
      }),
    });
    await dispatch;

    expect(controller.getSnapshot().project.name).toBe('External edit wins');
    expect(controller.getSnapshot().stateToken.sessionRevision).toBe(2);
    expect(controller.getSnapshot().pendingCommandIds).toEqual([]);
    controller.close();
  });

  it('rolls back a failed optimistic command without restoring over a newer event', async () => {
    const transport = new MockTransport();
    let resolveExecute: ((result: EditorUiCommandResult) => void) | undefined;
    transport.execute = async (request) => {
      transport.requests.push(request);
      return new Promise<EditorUiCommandResult>((resolve) => {
        resolveExecute = resolve;
      });
    };
    const controller = new ExternalEditorUiController({
      viewId: 'view-a',
      initialSnapshot: snapshotAt(0),
      transport,
      createCommandId: () => 'late-failure',
    });
    await controller.connect();
    const dispatch = controller.dispatch(
      { type: 'project.set-name', name: 'Local edit' },
      {
        optimistic: (current) => ({
          ...current,
          project: { ...current.project, name: 'Optimistic local edit' },
        }),
      },
    );
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    const external = snapshotAt(2, {
      project: { ...snapshotAt(2).project, name: 'External edit survives' },
    });
    controller.acceptEvent({
      eventId: 'external-2',
      previousCursor: 'cursor-1',
      cursor: 'cursor-2',
      stateToken: external.stateToken,
      kind: 'project',
      snapshot: external,
    });
    resolveExecute?.({
      ok: false,
      commandId: 'late-failure',
      code: 'invalid',
      message: 'Rejected.',
    });
    await dispatch;

    expect(controller.getSnapshot().project.name).toBe('External edit survives');
    expect(controller.getSnapshot().pendingCommandIds).toEqual([]);
    expect(controller.getSnapshot().errorMessage).toBe('Rejected.');
    controller.close();
  });

  it('serializes durable commands and guards each one with the latest accepted revision', async () => {
    const transport = new MockTransport();
    const resolvers: Array<(result: EditorUiCommandResult) => void> = [];
    transport.execute = async (request) => {
      transport.requests.push(request);
      return new Promise<EditorUiCommandResult>((resolve) => {
        resolvers.push(resolve);
      });
    };
    let sequence = 0;
    const controller = new ExternalEditorUiController({
      viewId: 'view-a',
      initialSnapshot: snapshotAt(0),
      transport,
      createCommandId: () => `command-${++sequence}`,
    });
    await controller.connect();
    const first = controller.dispatch({ type: 'project.set-name', name: 'First' });
    const second = controller.dispatch({ type: 'project.set-name', name: 'Second' });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    resolvers[0]?.({
      ok: true,
      commandId: 'command-1',
      stateToken: snapshotAt(2).stateToken,
      snapshot: snapshotAt(2),
    });
    await first;
    await vi.waitFor(() => expect(transport.requests).toHaveLength(2));
    expect(transport.requests[1]?.expected.sessionRevision).toBe(2);
    resolvers[1]?.({
      ok: true,
      commandId: 'command-2',
      stateToken: snapshotAt(3).stateToken,
      snapshot: snapshotAt(3),
    });
    await second;
    expect(controller.getSnapshot().pendingCommandIds).toEqual([]);
    controller.close();
  });

  it('accepts view playhead changes only while following the presenter', async () => {
    const transport = new MockTransport();
    const controller = new ExternalEditorUiController({
      viewId: 'view-a',
      initialSnapshot: snapshotAt(0),
      transport,
    });
    await controller.connect();
    controller.updateView({ playheadSeconds: 3 });
    const unfollowed = snapshotAt(2, {
      view: { ...snapshotAt(2).view, playheadSeconds: 9 },
    });
    controller.acceptEvent({
      eventId: 'view-2',
      previousCursor: 'cursor-1',
      cursor: 'cursor-2',
      stateToken: unfollowed.stateToken,
      kind: 'view',
      snapshot: unfollowed,
    });
    expect(controller.getSnapshot().view.playheadSeconds).toBe(3);

    const followed = snapshotAt(3, {
      playback: { ...snapshotAt(3).playback, followingPresenter: true },
      view: { ...snapshotAt(3).view, playheadSeconds: 12 },
    });
    // Following is current view state, so publish the presenter authority before its next view event.
    controller.acceptEvent({
      eventId: 'playback-3',
      previousCursor: 'cursor-2',
      cursor: 'cursor-3',
      stateToken: followed.stateToken,
      kind: 'playback',
      snapshot: followed,
    });
    const presenterView = snapshotAt(4, {
      playback: followed.playback,
      view: { ...snapshotAt(4).view, playheadSeconds: 15 },
    });
    controller.acceptEvent({
      eventId: 'view-4',
      previousCursor: 'cursor-3',
      cursor: 'cursor-4',
      stateToken: presenterView.stateToken,
      kind: 'view',
      snapshot: presenterView,
    });
    expect(controller.getSnapshot().view.playheadSeconds).toBe(15);
    controller.close();
  });

  it('aborts the active mutation and rejects queued work after close', async () => {
    const transport = new MockTransport();
    const execute = vi.fn((
      _request: EditorUiCommandRequest,
      signal?: AbortSignal,
    ): Promise<EditorUiCommandResult> => new Promise((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    }));
    transport.execute = execute;
    const controller = new ExternalEditorUiController({
      viewId: 'view-a',
      initialSnapshot: snapshotAt(0),
      transport,
      createCommandId: (() => {
        let sequence = 0;
        return () => `close-${++sequence}`;
      })(),
    });
    await controller.connect();
    const first = controller.dispatch({ type: 'project.set-name', name: 'First' });
    const second = controller.dispatch({ type: 'project.set-name', name: 'Second' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    controller.close();
    await expect(first).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    await expect(second).resolves.toMatchObject({
      ok: false,
      code: 'unavailable',
      message: 'The editor controller is closed.',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
